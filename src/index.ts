#!/usr/bin/env node

/**
 * Figma Console MCP Server
 * Entry point for the MCP server that enables AI assistants to access
 * Figma plugin console logs and screenshots.
 *
 * This implementation uses Cloudflare's McpAgent pattern for deployment
 * on Cloudflare Workers with Browser Rendering API support.
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BrowserManager, type Env } from "./browser-manager.js";
import { ConsoleMonitor } from "./console-monitor.js";
import { getConfig } from "./config.js";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "mcp-server" });

/**
 * Figma Console MCP Agent
 * Extends McpAgent to provide Figma-specific debugging tools
 */
export class FigmaConsoleMCP extends McpAgent {
	server = new McpServer({
		name: "Figma Console MCP",
		version: "0.1.0",
	});

	private browserManager: BrowserManager | null = null;
	private consoleMonitor: ConsoleMonitor | null = null;
	private config = getConfig();

	/**
	 * Initialize browser and console monitoring
	 */
	private async ensureInitialized(): Promise<void> {
		if (!this.browserManager) {
			logger.info("Initializing BrowserManager");
			// @ts-ignore - this.env is available in Durable Object context
			this.browserManager = new BrowserManager(this.env, this.config.browser);
		}

		if (!this.consoleMonitor) {
			logger.info("Initializing ConsoleMonitor");
			this.consoleMonitor = new ConsoleMonitor(this.config.console);

			// Start browser and begin monitoring
			const page = await this.browserManager.getPage();
			await this.consoleMonitor.startMonitoring(page);
		}
	}

	async init() {
		// Tool 1: Get Console Logs
		this.server.tool(
			"figma_get_console_logs",
			{
				count: z.number().optional().default(100).describe("Number of recent logs to retrieve"),
				level: z
					.enum(["log", "info", "warn", "error", "debug", "all"])
					.optional()
					.default("all")
					.describe("Filter by log level"),
				since: z
					.number()
					.optional()
					.describe("Only logs after this timestamp (Unix ms)"),
			},
			async ({ count, level, since }) => {
				try {
					await this.ensureInitialized();

					if (!this.consoleMonitor) {
						throw new Error("Console monitor not initialized");
					}

					const logs = this.consoleMonitor.getLogs({
						count,
						level,
						since,
					});

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										logs,
										totalCount: logs.length,
										oldestTimestamp: logs[0]?.timestamp,
										newestTimestamp: logs[logs.length - 1]?.timestamp,
										status: this.consoleMonitor.getStatus(),
									},
									null,
									2,
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to get console logs");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: String(error),
										message: "Failed to retrieve console logs",
									},
									null,
									2,
								),
							},
						],
						isError: true,
					};
				}
			},
		);

		// Tool 2: Take Screenshot
		this.server.tool(
			"figma_take_screenshot",
			{
				target: z
					.enum(["plugin", "full-page", "viewport"])
					.optional()
					.default("plugin")
					.describe("What to screenshot"),
				format: z
					.enum(["png", "jpeg"])
					.optional()
					.default("png")
					.describe("Image format"),
				quality: z
					.number()
					.min(0)
					.max(100)
					.optional()
					.default(90)
					.describe("JPEG quality (0-100)"),
			},
			async ({ target, format, quality }) => {
				try {
					await this.ensureInitialized();

					if (!this.browserManager) {
						throw new Error("Browser manager not initialized");
					}

					const screenshot = await this.browserManager.screenshot({
						fullPage: target === "full-page",
						type: format,
						quality: format === "jpeg" ? quality : undefined,
					});

					// Convert buffer to base64
					const base64 = screenshot.toString("base64");

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										id: crypto.randomUUID(),
										timestamp: Date.now(),
										format,
										target,
										quality,
										base64Data: base64,
										size: screenshot.length,
									},
									null,
									2,
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to capture screenshot");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: String(error),
										message: "Failed to capture screenshot",
									},
									null,
									2,
								),
							},
						],
						isError: true,
					};
				}
			},
		);

		// Tool 3: Watch Console (Real-time streaming)
		this.server.tool(
			"figma_watch_console",
			{
				duration: z
					.number()
					.optional()
					.default(30)
					.describe("How long to watch in seconds"),
				level: z
					.enum(["log", "info", "warn", "error", "debug", "all"])
					.optional()
					.default("all")
					.describe("Filter by log level"),
			},
			async ({ duration, level }) => {
				// TODO: Phase 3 - Implement real-time console streaming
				const endsAt = Date.now() + duration * 1000;
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									status: "placeholder",
									message: `Would watch console logs for ${duration} seconds (level: ${level})`,
									endsAt: new Date(endsAt).toISOString(),
									plannedFor: "Phase 3",
									implementation: "SSE notifications via McpAgent",
								},
								null,
								2,
							),
						},
					],
				};
			},
		);

		// Tool 4: Reload Plugin
		this.server.tool(
			"figma_reload_plugin",
			{
				clearConsole: z
					.boolean()
					.optional()
					.default(true)
					.describe("Clear console logs before reload"),
			},
			async ({ clearConsole: clearConsoleBefore }) => {
				try {
					await this.ensureInitialized();

					if (!this.browserManager) {
						throw new Error("Browser manager not initialized");
					}

					// Clear console buffer if requested
					let clearedCount = 0;
					if (clearConsoleBefore && this.consoleMonitor) {
						clearedCount = this.consoleMonitor.clear();
					}

					// Reload the page
					await this.browserManager.reload();

					const currentUrl = this.browserManager.getCurrentUrl();

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										status: "reloaded",
										timestamp: Date.now(),
										url: currentUrl,
										consoleCleared: clearConsoleBefore,
										clearedCount: clearConsoleBefore ? clearedCount : 0,
									},
									null,
									2,
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to reload plugin");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: String(error),
										message: "Failed to reload plugin",
									},
									null,
									2,
								),
							},
						],
						isError: true,
					};
				}
			},
		);

		// Tool 5: Clear Console
		this.server.tool(
			"figma_clear_console",
			{},
			async () => {
				try {
					await this.ensureInitialized();

					if (!this.consoleMonitor) {
						throw new Error("Console monitor not initialized");
					}

					const clearedCount = this.consoleMonitor.clear();

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										status: "cleared",
										clearedCount,
										timestamp: Date.now(),
									},
									null,
									2,
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to clear console");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: String(error),
										message: "Failed to clear console buffer",
									},
									null,
									2,
								),
							},
						],
						isError: true,
					};
				}
			},
		);

		// Tool 6: Navigate to Figma
		this.server.tool(
			"figma_navigate",
			{
				url: z
					.string()
					.url()
					.describe(
						"Figma URL to navigate to (e.g., https://www.figma.com/design/abc123)",
					),
			},
			async ({ url }) => {
				try {
					await this.ensureInitialized();

					if (!this.browserManager) {
						throw new Error("Browser manager not initialized");
					}

					// Navigate to the URL
					await this.browserManager.navigateToFigma(url);

					// Give page time to load and start capturing logs
					await new Promise((resolve) => setTimeout(resolve, 2000));

					const currentUrl = this.browserManager.getCurrentUrl();

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										status: "navigated",
										url: currentUrl,
										timestamp: Date.now(),
										message: "Browser navigated to Figma. Console monitoring is active.",
									},
									null,
									2,
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to navigate to Figma");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: String(error),
										message: "Failed to navigate to Figma URL",
									},
									null,
									2,
								),
							},
						],
						isError: true,
					};
				}
			},
		);

		// Tool 7: Get Status
		this.server.tool(
			"figma_get_status",
			{},
			async () => {
				try {
					const browserRunning = this.browserManager?.isRunning() ?? false;
					const monitorStatus = this.consoleMonitor?.getStatus() ?? null;
					const currentUrl = this.browserManager?.getCurrentUrl() ?? null;

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										browser: {
											running: browserRunning,
											currentUrl,
										},
										consoleMonitor: monitorStatus,
										initialized: this.browserManager !== null && this.consoleMonitor !== null,
										timestamp: Date.now(),
									},
									null,
									2,
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to get status");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: String(error),
										message: "Failed to retrieve status",
									},
									null,
									2,
								),
							},
						],
						isError: true,
					};
				}
			},
		);
	}
}

/**
 * Cloudflare Workers fetch handler
 * Routes requests to appropriate MCP endpoints
 */
export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		// SSE endpoint for remote MCP clients
		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			return FigmaConsoleMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		// HTTP endpoint for direct MCP communication
		if (url.pathname === "/mcp") {
			return FigmaConsoleMCP.serve("/mcp").fetch(request, env, ctx);
		}

		// Health check endpoint
		if (url.pathname === "/health") {
			return new Response(
				JSON.stringify({
					status: "healthy",
					service: "Figma Console MCP",
					version: "0.1.0",
					endpoints: ["/sse", "/mcp"],
				}),
				{
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		return new Response("Not found", { status: 404 });
	},
};
