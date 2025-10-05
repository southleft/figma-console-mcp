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

/**
 * Figma Console MCP Agent
 * Extends McpAgent to provide Figma-specific debugging tools
 */
export class FigmaConsoleMCP extends McpAgent {
	server = new McpServer({
		name: "Figma Console MCP",
		version: "0.1.0",
	});

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
				// TODO: Phase 1, Week 4 - Implement console log capture using Browser Rendering API
				// Will use Puppeteer to connect to Figma and capture console events via CDP
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									status: "placeholder",
									message: `Would retrieve ${count} logs of level '${level}'${since ? ` since ${new Date(since).toISOString()}` : ""}`,
									plannedFor: "Phase 1, Week 4",
									implementation: "Browser Rendering API + Puppeteer + CDP",
								},
								null,
								2,
							),
						},
					],
				};
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
				// TODO: Phase 2 - Implement screenshot capture
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									status: "placeholder",
									message: `Would capture ${format} screenshot of ${target} at quality ${quality}`,
									plannedFor: "Phase 2",
									implementation: "Puppeteer screenshot API",
								},
								null,
								2,
							),
						},
					],
				};
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
			async ({ clearConsole }) => {
				// TODO: Phase 1, Week 4 - Implement plugin reload
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									status: "placeholder",
									message: `Would reload plugin${clearConsole ? " and clear console" : ""}`,
									plannedFor: "Phase 1, Week 4",
									implementation: "Puppeteer page reload + context detection",
								},
								null,
								2,
							),
						},
					],
				};
			},
		);

		// Tool 5: Clear Console
		this.server.tool(
			"figma_clear_console",
			{},
			async () => {
				// TODO: Phase 1, Week 4 - Implement console buffer clearing
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									status: "placeholder",
									message: "Would clear console log buffer",
									plannedFor: "Phase 1, Week 4",
									implementation: "In-memory buffer management",
								},
								null,
								2,
							),
						},
					],
				};
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
