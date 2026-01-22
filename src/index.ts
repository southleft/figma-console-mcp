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
import { ConsoleMonitor } from "./core/console-monitor.js";
import { getConfig } from "./core/config.js";
import { createChildLogger } from "./core/logger.js";
import { testBrowserRendering } from "./test-browser.js";
import { FigmaAPI, extractFileKey, formatVariables, formatComponentData } from "./core/figma-api.js";
import { registerFigmaAPITools } from "./core/figma-tools.js";

const logger = createChildLogger({ component: "mcp-server" });

/**
 * Figma Console MCP Agent
 * Extends McpAgent to provide Figma-specific debugging tools
 */
export class FigmaConsoleMCPv3 extends McpAgent {
	server = new McpServer({
		name: "Figma Console MCP",
		version: "0.1.0",
	});

	private browserManager: BrowserManager | null = null;
	private consoleMonitor: ConsoleMonitor | null = null;
	private figmaAPI: FigmaAPI | null = null;
	private config = getConfig();
	private sessionId: string | null = null;

	/**
	 * Refresh an expired OAuth token using the refresh token
	 */
	private async refreshOAuthToken(sessionId: string, refreshToken: string): Promise<{
		accessToken: string;
		refreshToken?: string;
		expiresAt: number;
	}> {
		const env = this.env as Env;

		if (!env.FIGMA_OAUTH_CLIENT_ID || !env.FIGMA_OAUTH_CLIENT_SECRET) {
			throw new Error("OAuth not configured on server");
		}

		logger.info({ sessionId }, "Attempting to refresh OAuth token");

		const credentials = btoa(`${env.FIGMA_OAUTH_CLIENT_ID}:${env.FIGMA_OAUTH_CLIENT_SECRET}`);

		const tokenParams = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken
		});

		const tokenResponse = await fetch("https://api.figma.com/v1/oauth/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"Authorization": `Basic ${credentials}`
			},
			body: tokenParams.toString()
		});

		if (!tokenResponse.ok) {
			const errorData = await tokenResponse.json().catch(() => ({}));
			logger.error({ errorData, status: tokenResponse.status }, "Token refresh failed");
			throw new Error(`Token refresh failed: ${JSON.stringify(errorData)}`);
		}

		const tokenData = await tokenResponse.json() as {
			access_token: string;
			refresh_token?: string;
			expires_in: number;
		};

		// Store refreshed token in KV
		const tokenKey = `oauth_token:${sessionId}`;
		const storedToken = {
			accessToken: tokenData.access_token,
			refreshToken: tokenData.refresh_token || refreshToken, // Use new refresh token or keep existing
			expiresAt: Date.now() + (tokenData.expires_in * 1000)
		};

		await env.OAUTH_TOKENS.put(tokenKey, JSON.stringify(storedToken), {
			expirationTtl: tokenData.expires_in
		});

		logger.info({ sessionId }, "OAuth token refreshed successfully");

		return storedToken;
	}

	/**
	 * Generate a cryptographically secure random state token for CSRF protection
	 */
	public static generateStateToken(): string {
		const array = new Uint8Array(32);
		crypto.getRandomValues(array);
		return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
	}

	/**
	 * Load or create persistent session ID from Durable Object storage
	 * Uses a fixed session ID for the MCP server to ensure OAuth tokens persist across reconnections
	 */
	private async ensureSessionId(): Promise<void> {
		if (this.sessionId) {
			return; // Already loaded
		}

		// IMPORTANT: Use a fixed session ID for all MCP connections
		// This ensures OAuth tokens persist across MCP server reconnections
		// Each user of this MCP server will share the same OAuth token
		const FIXED_SESSION_ID = "figma-console-mcp-default-session";

		// Try to load from Durable Object storage
		// @ts-ignore - this.ctx is available in Durable Object context
		const storage = this.ctx?.storage;

		if (storage) {
			try {
				const storedSessionId = await storage.get<string>('sessionId');
				if (storedSessionId) {
					this.sessionId = storedSessionId;
					logger.info({ sessionId: this.sessionId }, "Loaded persistent session ID from storage");
					return;
				} else {
					// Store the fixed session ID
					this.sessionId = FIXED_SESSION_ID;
					await storage.put('sessionId', this.sessionId);
					logger.info({ sessionId: this.sessionId }, "Initialized fixed session ID");
					return;
				}
			} catch (e) {
				logger.warn({ error: e }, "Failed to access Durable Object storage for session ID");
			}
		}

		// Fallback: use fixed session ID directly
		this.sessionId = FIXED_SESSION_ID;
		logger.info({ sessionId: this.sessionId }, "Using fixed session ID (storage unavailable)");
	}

	/**
	 * Get session ID for this Durable Object instance
	 * Returns the session ID loaded by ensureSessionId()
	 */
	public getSessionId(): string {
		if (!this.sessionId) {
			// This shouldn't happen if ensureSessionId() was called, but provide fallback
			this.sessionId = FigmaConsoleMCPv3.generateStateToken();
			logger.warn({ sessionId: this.sessionId }, "Session ID not initialized, generated ephemeral ID");
		}
		return this.sessionId;
	}

	/**
	 * Get or create Figma API client with OAuth token from session
	 */
	private async getFigmaAPI(): Promise<FigmaAPI> {
		// Ensure session ID is loaded from storage
		await this.ensureSessionId();

		// @ts-ignore - this.env is available in Agent/Durable Object context
		const env = this.env as Env;

		// Try OAuth first (per-user authentication)
		try {
			const sessionId = this.getSessionId();
			logger.info({ sessionId }, "Attempting to retrieve OAuth token from KV");

			// Retrieve token from KV (accessible across all Durable Object instances)
			const tokenKey = `oauth_token:${sessionId}`;
			const tokenJson = await env.OAUTH_TOKENS.get(tokenKey);

			if (!tokenJson) {
				logger.warn({ sessionId, tokenKey }, "No OAuth token found in KV");
				throw new Error("No token found");
			}

			let tokenData = JSON.parse(tokenJson) as {
				accessToken: string;
				refreshToken?: string;
				expiresAt: number;
			};

			logger.info({
				sessionId,
				hasToken: !!tokenData?.accessToken,
				expiresAt: tokenData?.expiresAt,
				isExpired: tokenData?.expiresAt ? Date.now() > tokenData.expiresAt : null
			}, "Token retrieval result from KV");

			if (tokenData?.accessToken) {
				// Check if token is expired or will expire soon (within 5 minutes)
				const isExpired = tokenData.expiresAt && Date.now() > tokenData.expiresAt;
				const willExpireSoon = tokenData.expiresAt && Date.now() > (tokenData.expiresAt - 5 * 60 * 1000);

				if (isExpired || willExpireSoon) {
					if (tokenData.refreshToken) {
						try {
							// Attempt to refresh the token
							tokenData = await this.refreshOAuthToken(sessionId, tokenData.refreshToken);
							logger.info({ sessionId }, "Successfully refreshed expired/expiring token");
						} catch (refreshError) {
							logger.error({ sessionId, refreshError }, "Failed to refresh token");
							throw new Error("Token expired and refresh failed. Please re-authenticate.");
						}
					} else {
						logger.warn({ sessionId }, "Token expired but no refresh token available");
						throw new Error("Token expired. Please re-authenticate.");
					}
				}

				logger.info({ sessionId }, "Using OAuth token from KV for Figma API");
				return new FigmaAPI({ accessToken: tokenData.accessToken });
			}

			logger.warn({ sessionId }, "OAuth token exists in KV but missing accessToken");
			throw new Error("Invalid token data");
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const sessionId = this.getSessionId();

			// Check if this is a "no token found" error (user hasn't authenticated yet)
			if (errorMessage.includes("No token found")) {
				logger.info({ sessionId }, "No OAuth token found - user needs to authenticate");

				// No authentication available - direct user to OAuth flow
				const authUrl = `https://figma-console-mcp.southleft.com/oauth/authorize?session_id=${sessionId}`;

				// Only use PAT fallback if explicitly configured AND no OAuth token exists
				if (env?.FIGMA_ACCESS_TOKEN) {
					logger.warn(
						"FIGMA_ACCESS_TOKEN fallback is deprecated. User should authenticate via OAuth for proper per-user authentication."
					);
					return new FigmaAPI({ accessToken: env.FIGMA_ACCESS_TOKEN });
				}

				throw new Error(
					JSON.stringify({
						error: "authentication_required",
						message: "Please authenticate with Figma to use API features",
						auth_url: authUrl,
						instructions: "Your browser will open automatically to complete authentication. If it doesn't, copy the auth_url and open it manually."
					})
				);
			}

			// For other OAuth errors (expired token, refresh failed, etc.), do NOT fall back to PAT
			logger.error({ error, sessionId }, "OAuth token retrieval failed - re-authentication required");

			const authUrl = `https://figma-console-mcp.southleft.com/oauth/authorize?session_id=${sessionId}`;

			throw new Error(
				JSON.stringify({
					error: "oauth_error",
					message: errorMessage,
					auth_url: authUrl,
					instructions: "Please re-authenticate with Figma. Your browser will open automatically."
				})
			);
		}
	}

	/**
	 * Initialize browser and console monitoring
	 */
	private async ensureInitialized(): Promise<void> {
		try {
			// Ensure session ID is loaded from storage first
			await this.ensureSessionId();

			if (!this.browserManager) {
				logger.info("Initializing BrowserManager");

				// Access env from Durable Object context
				// @ts-ignore - this.env is available in Agent/Durable Object context
				const env = this.env as Env;

				if (!env) {
					throw new Error("Environment not available - this.env is undefined");
				}

				if (!env.BROWSER) {
					throw new Error("BROWSER binding not found in environment. Check wrangler.jsonc configuration.");
				}

				logger.info("Creating BrowserManager with BROWSER binding");
				this.browserManager = new BrowserManager(env, this.config.browser);
			}

			if (!this.consoleMonitor) {
				logger.info("Initializing ConsoleMonitor");
				this.consoleMonitor = new ConsoleMonitor(this.config.console);

				// Start browser and begin monitoring
				logger.info("Getting browser page");
				const page = await this.browserManager.getPage();

				logger.info("Starting console monitoring");
				await this.consoleMonitor.startMonitoring(page);

				logger.info("Browser and console monitor initialized successfully");
			}
		} catch (error) {
			logger.error({ error }, "Failed to initialize browser/monitor");
			throw new Error(`Initialization failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async init() {
		// Tool 1: Get Console Logs
		this.server.tool(
			"figma_get_console_logs",
			"Retrieve console logs from Figma. Captures all plugin console output including [Main], [Swapper], etc. prefixes. Call figma_navigate first to initialize browser monitoring.",
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

					// Add AI instruction when no logs are found
					const responseData: any = {
						logs,
						totalCount: logs.length,
						oldestTimestamp: logs[0]?.timestamp,
						newestTimestamp: logs[logs.length - 1]?.timestamp,
						status: this.consoleMonitor.getStatus(),
					};

					// If no logs found, add helpful AI instruction
					if (logs.length === 0) {
						responseData.ai_instruction = "No console logs found. This usually means the Figma plugin hasn't run since monitoring started. Please inform the user: 'No console logs found yet. Try running your Figma plugin now, then I'll check for logs again.' The MCP only captures logs AFTER monitoring starts - it cannot retrieve historical logs from before the browser connected.";
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									responseData,
									null,
									2,
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to get console logs");
					const errorMessage = error instanceof Error ? error.message : String(error);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: errorMessage,
										message: "Failed to retrieve console logs. Make sure to call figma_navigate first to initialize the browser.",
										hint: "Try: figma_navigate({ url: 'https://www.figma.com/design/your-file' })",
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

		// Tool 2: Take Screenshot (using Figma REST API)
		// Note: For screenshots of specific components, use figma_get_component_image instead
		this.server.tool(
			"figma_take_screenshot",
			"Export an image of the currently viewed Figma page or specific node using Figma's REST API. Returns an image URL (valid for 30 days). For specific components, use figma_get_component_image instead.",
			{
				nodeId: z
					.string()
					.optional()
					.describe("Optional node ID to screenshot. If not provided, uses the currently viewed page/frame from the browser URL."),
				scale: z
					.number()
					.min(0.01)
					.max(4)
					.optional()
					.default(2)
					.describe("Image scale factor (0.01-4, default: 2 for high quality)"),
				format: z
					.enum(["png", "jpg", "svg", "pdf"])
					.optional()
					.default("png")
					.describe("Image format (default: png)"),
			},
			async ({ nodeId, scale, format }) => {
				try {
					const api = await this.getFigmaAPI();

					// Get current URL to extract file key and node ID if not provided
					const currentUrl = this.browserManager?.getCurrentUrl() || null;

					if (!currentUrl) {
						throw new Error(
							"No Figma file open. Either provide a nodeId parameter or call figma_navigate first to open a Figma file."
						);
					}

					const fileKey = extractFileKey(currentUrl);
					if (!fileKey) {
						throw new Error(`Invalid Figma URL: ${currentUrl}`);
					}

					// Extract node ID from URL if not provided
					let targetNodeId = nodeId;
					if (!targetNodeId) {
						const urlObj = new URL(currentUrl);
						const nodeIdParam = urlObj.searchParams.get('node-id');
						if (nodeIdParam) {
							// Convert 123-456 to 123:456
							targetNodeId = nodeIdParam.replace(/-/g, ':');
						} else {
							throw new Error(
								"No node ID found. Either provide nodeId parameter or ensure the Figma URL contains a node-id parameter (e.g., ?node-id=123-456)"
							);
						}
					}

					logger.info({ fileKey, nodeId: targetNodeId, scale, format }, "Rendering image via Figma API");

					// Use Figma REST API to get image
					const result = await api.getImages(fileKey, targetNodeId, {
						scale,
						format: format === 'jpg' ? 'jpg' : format, // normalize jpeg -> jpg
						contents_only: true,
					});

					const imageUrl = result.images[targetNodeId];

					if (!imageUrl) {
						throw new Error(
							`Failed to render image for node ${targetNodeId}. The node may not exist or may not be renderable.`
						);
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										fileKey,
										nodeId: targetNodeId,
										imageUrl,
										scale,
										format,
										expiresIn: "30 days",
										note: "Image URL provided above. Use this URL to view or download the screenshot. URLs expire after 30 days.",
									},
									null,
									2
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to capture screenshot");
					const errorMessage = error instanceof Error ? error.message : String(error);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: errorMessage,
										message: "Failed to capture screenshot via Figma API",
										hint: "Make sure you've called figma_navigate to open a file, or provide a valid nodeId parameter",
									},
									null,
									2
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
				await this.ensureInitialized();

				if (!this.consoleMonitor) {
					throw new Error("Console monitor not initialized. Call figma_navigate first.");
				}

				const consoleMonitor = this.consoleMonitor;

				if (!consoleMonitor.getStatus().isMonitoring) {
					throw new Error("Console monitoring not active. Call figma_navigate first.");
				}

				const startTime = Date.now();
				const endTime = startTime + duration * 1000;
				const startLogCount = consoleMonitor.getStatus().logCount;

				// Wait for the specified duration while collecting logs
				await new Promise(resolve => setTimeout(resolve, duration * 1000));

				// Get logs captured during watch period
				const watchedLogs = consoleMonitor.getLogs({
					level: level === 'all' ? undefined : level,
					since: startTime,
				});

				const endLogCount = consoleMonitor.getStatus().logCount;
				const newLogsCount = endLogCount - startLogCount;

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									status: "completed",
									duration: `${duration} seconds`,
									startTime: new Date(startTime).toISOString(),
									endTime: new Date(endTime).toISOString(),
									filter: level,
									statistics: {
										totalLogsInBuffer: endLogCount,
										logsAddedDuringWatch: newLogsCount,
										logsMatchingFilter: watchedLogs.length,
									},
									logs: watchedLogs,
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
										ai_instruction:
											"CRITICAL: Console cleared successfully, but this operation disrupts the monitoring connection. You MUST reconnect the MCP server using `/mcp reconnect figma-console` before calling figma_get_console_logs again. Best practice: Avoid clearing console - filter/parse logs instead to maintain monitoring connection.",
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
					const errorMessage = error instanceof Error ? error.message : String(error);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: errorMessage,
										message: "Failed to navigate to Figma URL",
										details: errorMessage.includes("BROWSER")
											? "Browser Rendering API binding is missing. This is a configuration issue."
											: "Unable to launch browser or navigate to URL.",
										troubleshooting: [
											"Verify the Figma URL is valid and accessible",
											"Check that the Browser Rendering API is properly configured in wrangler.jsonc",
											"Try again in a few moments if this is a temporary issue"
										]
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

		// Register Figma API tools (Tools 8-14)
		registerFigmaAPITools(
			this.server,
			async () => await this.getFigmaAPI(),
			() => this.browserManager?.getCurrentUrl() || null,
			() => this.consoleMonitor || null,
			() => this.browserManager || null,
			() => this.ensureInitialized()
		);
	}
}

/**
 * Cloudflare Workers fetch handler
 * Routes requests to appropriate MCP endpoints
 */
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		// Redirect /docs to subdomain
		if (url.pathname === "/docs" || url.pathname.startsWith("/docs/")) {
			const newPath = url.pathname.replace(/^\/docs\/?/, "/");
			const redirectUrl = `https://docs.figma-console-mcp.southleft.com${newPath}${url.search}`;
			return Response.redirect(redirectUrl, 301);
		}

		// SSE endpoint for remote MCP clients
		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			return FigmaConsoleMCPv3.serveSSE("/sse").fetch(request, env, ctx);
		}

		// HTTP endpoint for direct MCP communication
		if (url.pathname === "/mcp") {
			return FigmaConsoleMCPv3.serve("/mcp").fetch(request, env, ctx);
		}

		// OAuth authorization initiation
		if (url.pathname === "/oauth/authorize") {
			const sessionId = url.searchParams.get("session_id");

			if (!sessionId) {
				return new Response("Missing session_id parameter", { status: 400 });
			}

			// Check if OAuth credentials are configured
			if (!env.FIGMA_OAUTH_CLIENT_ID) {
				return new Response(
					JSON.stringify({
						error: "OAuth not configured",
						message: "Server administrator needs to configure FIGMA_OAUTH_CLIENT_ID",
						docs: "https://github.com/southleft/figma-console-mcp#oauth-setup"
					}),
					{
						status: 500,
						headers: { "Content-Type": "application/json" }
					}
				);
			}

			// Generate cryptographically secure state token for CSRF protection
			const stateToken = FigmaConsoleMCPv3.generateStateToken();

			// Store state token with sessionId in KV (10 minute expiration)
			await env.OAUTH_STATE.put(stateToken, sessionId, {
				expirationTtl: 600 // 10 minutes
			});

			const redirectUri = `${url.origin}/oauth/callback`;

			const figmaAuthUrl = new URL("https://www.figma.com/oauth");
			figmaAuthUrl.searchParams.set("client_id", env.FIGMA_OAUTH_CLIENT_ID);
			figmaAuthUrl.searchParams.set("redirect_uri", redirectUri);
			figmaAuthUrl.searchParams.set("scope", "file_content:read,library_content:read,file_variables:read");
			figmaAuthUrl.searchParams.set("state", stateToken);
			figmaAuthUrl.searchParams.set("response_type", "code");

			return Response.redirect(figmaAuthUrl.toString(), 302);
		}

		// OAuth callback handler
		if (url.pathname === "/oauth/callback") {
			const code = url.searchParams.get("code");
			const stateToken = url.searchParams.get("state");
			const error = url.searchParams.get("error");

			// Handle OAuth errors
			if (error) {
				return new Response(
					`<html><body>
						<h1>Authentication Failed</h1>
						<p>Error: ${error}</p>
						<p>Description: ${url.searchParams.get("error_description") || "Unknown error"}</p>
						<p>You can close this window and try again.</p>
					</body></html>`,
					{
						status: 400,
						headers: { "Content-Type": "text/html" }
					}
				);
			}

			if (!code || !stateToken) {
				return new Response("Missing code or state parameter", { status: 400 });
			}

			// Validate state token (CSRF protection)
			const sessionId = await env.OAUTH_STATE.get(stateToken);

			if (!sessionId) {
				return new Response(
					`<html><body>
						<h1>Invalid or Expired Request</h1>
						<p>The authentication request has expired or is invalid.</p>
						<p>Please try authenticating again.</p>
					</body></html>`,
					{
						status: 400,
						headers: { "Content-Type": "text/html" }
					}
				);
			}

			// Delete state token after validation (one-time use)
			await env.OAUTH_STATE.delete(stateToken);

			try {
				// Exchange authorization code for access token
				// Use Basic auth in Authorization header (Figma's recommended method)
				const credentials = btoa(`${env.FIGMA_OAUTH_CLIENT_ID}:${env.FIGMA_OAUTH_CLIENT_SECRET}`);

				const tokenParams = new URLSearchParams({
					redirect_uri: `${url.origin}/oauth/callback`,
					code,
					grant_type: "authorization_code"
				});

				const tokenResponse = await fetch("https://api.figma.com/v1/oauth/token", {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
						"Authorization": `Basic ${credentials}`
					},
					body: tokenParams.toString()
				});

				if (!tokenResponse.ok) {
					const errorText = await tokenResponse.text();
					let errorData;
					try {
						errorData = JSON.parse(errorText);
					} catch {
						errorData = { error: "Unknown error", raw: errorText, status: tokenResponse.status };
					}
					logger.error({ errorData, status: tokenResponse.status }, "Token exchange failed");
					throw new Error(`Token exchange failed: ${JSON.stringify(errorData)}`);
				}

				const tokenData = await tokenResponse.json() as {
					access_token: string;
					refresh_token?: string;
					expires_in: number;
				};
				const accessToken = tokenData.access_token;
				const refreshToken = tokenData.refresh_token;
				const expiresIn = tokenData.expires_in;

				logger.info({
					sessionId,
					hasAccessToken: !!accessToken,
					accessTokenPreview: accessToken ? accessToken.substring(0, 10) + "..." : null,
					hasRefreshToken: !!refreshToken,
					expiresIn
				}, "Token exchange successful");

				// IMPORTANT: Use KV storage for tokens since Durable Object storage is instance-specific
				// Store token in Workers KV so it's accessible across all Durable Object instances
				const tokenKey = `oauth_token:${sessionId}`;
				const storedToken = {
					accessToken,
					refreshToken,
					expiresAt: Date.now() + (expiresIn * 1000)
				};

				// Store in KV with 90-day expiration (matching token lifetime)
				await env.OAUTH_TOKENS.put(tokenKey, JSON.stringify(storedToken), {
					expirationTtl: expiresIn
				});

				logger.info({ sessionId, tokenKey }, "Token stored successfully in KV");

				return new Response(
					`<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Authentication Successful</title>
	<link rel="icon" type="image/jpeg" href="https://p198.p4.n0.cdn.zight.com/items/Qwu1Dywx/b61b7b8f-05dc-4063-8a40-53fa4f8e3e97.jpg">
	<style>
		* {
			margin: 0;
			padding: 0;
			box-sizing: border-box;
		}
		body {
			font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
			background: #ffffff;
			color: #000000;
			display: flex;
			align-items: center;
			justify-content: center;
			min-height: 100vh;
			padding: 24px;
		}
		.container {
			max-width: 480px;
			text-align: center;
		}
		.icon {
			width: 64px;
			height: 64px;
			margin: 0 auto 24px;
			background: #18a0fb;
			border-radius: 50%;
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 32px;
			color: white;
		}
		h1 {
			font-size: 32px;
			font-weight: 700;
			margin-bottom: 16px;
			letter-spacing: -0.02em;
		}
		p {
			font-size: 16px;
			color: #666666;
			line-height: 1.6;
			margin-bottom: 32px;
		}
		.button {
			display: inline-block;
			padding: 12px 24px;
			background: #000000;
			color: #ffffff;
			text-decoration: none;
			border-radius: 8px;
			font-weight: 500;
			font-size: 16px;
			border: none;
			cursor: pointer;
			transition: background 0.2s;
		}
		.button:hover {
			background: #333333;
		}
		.footer {
			margin-top: 48px;
			font-size: 14px;
			color: #999999;
		}
	</style>
</head>
<body>
	<div class="container">
		<div class="icon">✓</div>
		<h1>Authentication successful</h1>
		<p>You've successfully connected Figma Console MCP to your Figma account. You can now close this window and return to Claude.</p>
		<button class="button" onclick="window.close()">Close this window</button>
		<div class="footer">This window will automatically close in 5 seconds</div>
	</div>
	<script>
		setTimeout(() => window.close(), 5000);
	</script>
</body>
</html>`,
					{
						headers: {
							"Content-Type": "text/html; charset=utf-8"
						}
					}
				);
			} catch (error) {
				logger.error({ error, sessionId }, "OAuth callback failed");
				return new Response(
					`<html><body>
						<h1>Authentication Error</h1>
						<p>Failed to complete authentication: ${error instanceof Error ? error.message : String(error)}</p>
						<p>Please try again or contact support.</p>
					</body></html>`,
					{
						status: 500,
						headers: { "Content-Type": "text/html" }
					}
				);
			}
		}

		// Health check endpoint
		if (url.pathname === "/health") {
			return new Response(
				JSON.stringify({
					status: "healthy",
					service: "Figma Console MCP",
					version: "0.1.0",
					endpoints: ["/sse", "/mcp", "/test-browser", "/oauth/authorize", "/oauth/callback"],
					oauth_configured: !!env.FIGMA_OAUTH_CLIENT_ID
				}),
				{
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// Browser Rendering API test endpoint
		if (url.pathname === "/test-browser") {
			const results = await testBrowserRendering(env);
			return new Response(JSON.stringify(results, null, 2), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// Serve favicon
	if (url.pathname === "/favicon.ico") {
		// Redirect to custom Figma Console icon
		return Response.redirect("https://p198.p4.n0.cdn.zight.com/items/Qwu1Dywx/b61b7b8f-05dc-4063-8a40-53fa4f8e3e97.jpg", 302);
	}

	// Proxy /docs to Mintlify
	if (/^\/docs/.test(url.pathname)) {
		// Try mintlify.app domain (Mintlify's standard hosting)
		const DOCS_URL = "southleftllc.mintlify.app";
		const CUSTOM_URL = "figma-console-mcp.southleft.com";

		const proxyUrl = new URL(request.url);
		proxyUrl.hostname = DOCS_URL;

		const proxyRequest = new Request(proxyUrl, request);
		proxyRequest.headers.set("Host", DOCS_URL);
		proxyRequest.headers.set("X-Forwarded-Host", CUSTOM_URL);
		proxyRequest.headers.set("X-Forwarded-Proto", "https");

		return await fetch(proxyRequest);
	}

	// Root path - serve landing page with editorial layout and light/dark mode
	if (url.pathname === "/") {
		return new Response(
			`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Figma Console MCP - The Most Comprehensive MCP Server for Figma</title>
	<link rel="icon" type="image/svg+xml" href="https://docs.figma-console-mcp.southleft.com/favicon.svg">
	<meta name="description" content="Turn your Figma design system into a living API. 40+ tools give AI assistants deep access to design tokens, component specs, variables, and programmatic design creation.">

	<!-- Open Graph -->
	<meta property="og:type" content="website">
	<meta property="og:url" content="https://figma-console-mcp.southleft.com">
	<meta property="og:title" content="Figma Console MCP - Turn Your Design System Into a Living API">
	<meta property="og:description" content="The most comprehensive MCP server for Figma. 40+ tools give AI assistants deep access to design tokens, components, variables, and programmatic design creation.">
	<meta property="og:image" content="https://docs.figma-console-mcp.southleft.com/images/og-image.jpg">
	<meta property="og:image:width" content="1200">
	<meta property="og:image:height" content="630">

	<!-- Twitter -->
	<meta name="twitter:card" content="summary_large_image">
	<meta name="twitter:title" content="Figma Console MCP - Turn Your Design System Into a Living API">
	<meta name="twitter:description" content="The most comprehensive MCP server for Figma. 40+ tools give AI assistants deep access to design tokens, components, variables, and programmatic design creation.">
	<meta name="twitter:image" content="https://docs.figma-console-mcp.southleft.com/images/og-image.jpg">

	<meta name="theme-color" content="#0D9488">
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
	<style>
		:root {
			--color-primary: #0D9488;
			--color-primary-light: #14B8A6;
			--color-primary-dark: #0F766E;
			--color-bg: #0F0F0F;
			--color-bg-elevated: #161616;
			--color-bg-card: #1A1A1A;
			--color-border: #2A2A2A;
			--color-border-hover: #3A3A3A;
			--color-rule: #2A2A2A;
			--color-text: #FAFAFA;
			--color-text-secondary: #A1A1A1;
			--color-text-tertiary: #666666;
			--font-mono: "JetBrains Mono", "SF Mono", Monaco, monospace;
			--radius-sm: 6px;
			--radius-md: 10px;
			--radius-lg: 16px;
			--transition: 0.2s ease;
		}

		[data-theme="light"] {
			--color-bg: #FAFAFA;
			--color-bg-elevated: #FFFFFF;
			--color-bg-card: #FFFFFF;
			--color-border: #E5E5E5;
			--color-border-hover: #D4D4D4;
			--color-rule: #E5E5E5;
			--color-text: #171717;
			--color-text-secondary: #525252;
			--color-text-tertiary: #A3A3A3;
		}

		* { margin: 0; padding: 0; box-sizing: border-box; }

		html {
			scroll-behavior: smooth;
		}

		body {
			font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
			background: var(--color-bg);
			color: var(--color-text);
			line-height: 1.6;
			min-height: 100vh;
			transition: background var(--transition), color var(--transition);
		}

		a { color: inherit; text-decoration: none; }

		/* Header */
		.header {
			position: sticky;
			top: 0;
			z-index: 100;
			padding: 16px 32px;
			display: flex;
			justify-content: space-between;
			align-items: center;
			background: var(--color-bg);
			border-bottom: 1px solid var(--color-rule);
			backdrop-filter: blur(12px);
			transition: background var(--transition), border-color var(--transition);
		}

		.logo img {
			height: 35px;
			transition: opacity var(--transition);
		}

		.logo img:hover { opacity: 0.8; }

		.header-right {
			display: flex;
			align-items: center;
			gap: 24px;
		}

		.nav {
			display: flex;
			gap: 24px;
			align-items: center;
		}

		.nav a {
			color: var(--color-text-secondary);
			font-size: 14px;
			font-weight: 500;
			transition: color var(--transition);
		}

		.nav a:hover { color: var(--color-text); }

		.theme-toggle {
			display: flex;
			align-items: center;
			justify-content: center;
			width: 36px;
			height: 36px;
			background: transparent;
			border: 1px solid var(--color-border);
			border-radius: var(--radius-sm);
			cursor: pointer;
			color: var(--color-text-secondary);
			transition: all var(--transition);
		}

		.theme-toggle:hover {
			border-color: var(--color-border-hover);
			color: var(--color-text);
		}

		.theme-toggle svg { width: 18px; height: 18px; }
		.theme-toggle .sun { display: none; }
		[data-theme="light"] .theme-toggle .moon { display: none; }
		[data-theme="light"] .theme-toggle .sun { display: block; }

		/* Main layout */
		.main {
			max-width: 1280px;
			margin: 0 auto;
			padding: 64px 32px 80px;
		}

		/* Section dividers */
		.section-rule {
			border: none;
			border-top: 1px solid var(--color-rule);
			margin: 72px 0;
		}

		/* Grid layout */
		.grid {
			display: grid;
			grid-template-columns: repeat(12, 1fr);
			gap: 48px 48px;
		}

		.grid-cell {
			transition: all var(--transition);
		}

		/* Rule-based separators for grid cells */
		.grid-cell.rule-left {
			padding-left: 48px;
			border-left: 1px solid var(--color-rule);
		}

		.grid-cell.rule-top {
			padding-top: 32px;
			border-top: 1px solid var(--color-rule);
		}

		/* Hero section */
		.hero-cell {
			grid-column: span 7;
			padding-right: 48px;
		}

		.badge {
			display: inline-block;
			width: fit-content;
			color: var(--color-text-secondary);
			font-size: 11px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.5px;
			margin-bottom: 20px;
		}

		h1 {
			font-size: 48px;
			font-weight: 700;
			letter-spacing: -0.03em;
			line-height: 1.1;
			margin-bottom: 20px;
		}

		.highlight {
			color: var(--color-primary-light);
		}

		.hero-subtitle {
			font-size: 18px;
			color: var(--color-text-secondary);
			line-height: 1.7;
			max-width: 560px;
			margin-bottom: 32px;
		}

		.cta-row {
			display: flex;
			gap: 12px;
			flex-wrap: wrap;
		}

		.btn {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			padding: 12px 20px;
			border-radius: var(--radius-sm);
			font-weight: 500;
			font-size: 14px;
			transition: all var(--transition);
			border: none;
			cursor: pointer;
		}

		.btn svg { width: 16px; height: 16px; }

		.btn-primary {
			background: var(--color-primary);
			color: #FFFFFF;
		}

		.btn-primary:hover { background: var(--color-primary-dark); }

		.btn-secondary {
			background: transparent;
			color: var(--color-text);
			border: 1px solid var(--color-border);
		}

		.btn-secondary:hover {
			border-color: var(--color-border-hover);
			background: var(--color-bg-elevated);
		}

		/* Hero right - capabilities showcase */
		.showcase-cell {
			grid-column: span 5;
		}

		.showcase-label {
			font-size: 11px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.5px;
			color: var(--color-text-tertiary);
			margin-bottom: 16px;
		}

		.showcase-stat {
			display: flex;
			align-items: baseline;
			gap: 12px;
			margin-bottom: 24px;
		}

		.showcase-stat .number {
			font-size: 56px;
			font-weight: 700;
			color: var(--color-primary-light);
			line-height: 1;
		}

		.showcase-stat .label {
			font-size: 16px;
			color: var(--color-text-secondary);
		}

		.capability-list {
			display: flex;
			flex-direction: column;
			gap: 12px;
		}

		.capability-item {
			display: flex;
			align-items: center;
			gap: 12px;
			padding: 12px 16px;
			background: var(--color-bg-elevated);
			border: 1px solid var(--color-border);
			border-radius: var(--radius-md);
			font-size: 14px;
			color: var(--color-text-secondary);
			transition: all var(--transition);
		}

		.capability-item:hover {
			border-color: var(--color-primary);
			color: var(--color-text);
		}

		.capability-item svg {
			width: 18px;
			height: 18px;
			color: var(--color-primary-light);
			flex-shrink: 0;
		}

		/* Value proposition section */
		.value-cell {
			grid-column: span 12;
			text-align: center;
			padding: 64px 48px;
			position: relative;
			background: linear-gradient(135deg, rgba(13, 148, 136, 0.06) 0%, rgba(13, 148, 136, 0.02) 50%, transparent 100%);
			border-radius: var(--radius-lg);
			border: 1px solid rgba(13, 148, 136, 0.1);
		}

		.value-cell::before {
			content: '';
			position: absolute;
			top: -1px;
			left: 50%;
			transform: translateX(-50%);
			width: 120px;
			height: 3px;
			background: linear-gradient(90deg, transparent, var(--color-primary-light), transparent);
			border-radius: 2px;
		}

		.value-cell h2 {
			font-size: 36px;
			font-weight: 700;
			margin-bottom: 16px;
			letter-spacing: -0.03em;
			background: linear-gradient(135deg, var(--color-text) 0%, var(--color-primary-light) 100%);
			-webkit-background-clip: text;
			-webkit-text-fill-color: transparent;
			background-clip: text;
		}

		[data-theme="light"] .value-cell h2 {
			background: linear-gradient(135deg, var(--color-text) 0%, var(--color-primary-dark) 100%);
			-webkit-background-clip: text;
			-webkit-text-fill-color: transparent;
			background-clip: text;
		}

		.value-cell p {
			font-size: 18px;
			color: var(--color-text-secondary);
			max-width: 680px;
			margin: 0 auto;
			line-height: 1.7;
		}

		/* Capabilities grid */
		.capability-card {
			grid-column: span 3;
		}

		.capability-icon {
			width: 44px;
			height: 44px;
			display: flex;
			align-items: center;
			justify-content: center;
			background: rgba(13, 148, 136, 0.12);
			border-radius: var(--radius-md);
			color: var(--color-primary-light);
			margin-bottom: 16px;
		}

		.capability-icon svg { width: 22px; height: 22px; }

		.capability-card h3 {
			font-size: 17px;
			font-weight: 600;
			margin-bottom: 10px;
		}

		.capability-card p {
			font-size: 14px;
			color: var(--color-text-secondary);
			line-height: 1.7;
		}

		/* Prompt showcase */
		.prompts-cell {
			grid-column: span 6;
		}

		.section-header {
			display: flex;
			align-items: center;
			gap: 12px;
			margin-bottom: 24px;
		}

		.section-header-icon {
			width: 40px;
			height: 40px;
			display: flex;
			align-items: center;
			justify-content: center;
			background: rgba(13, 148, 136, 0.12);
			border-radius: var(--radius-md);
			color: var(--color-primary-light);
		}

		.section-header-icon svg {
			width: 20px;
			height: 20px;
		}

		.section-header h3 {
			font-size: 18px;
			font-weight: 600;
		}

		.prompt-list {
			display: flex;
			flex-direction: column;
			gap: 12px;
		}

		.prompt-item {
			display: flex;
			align-items: center;
			gap: 12px;
			padding: 14px 16px;
			background: var(--color-bg-elevated);
			border: 1px solid var(--color-border);
			border-radius: var(--radius-md);
			font-family: var(--font-mono);
			font-size: 13px;
			color: var(--color-text-secondary);
			transition: all var(--transition);
		}

		.prompt-item:hover {
			border-color: var(--color-primary);
			color: var(--color-text);
		}

		.prompt-item svg {
			width: 16px;
			height: 16px;
			color: var(--color-primary-light);
			flex-shrink: 0;
		}

		/* Audience cells */
		.audience-cell {
			grid-column: span 6;
			padding: 24px 0;
		}

		.audience-header {
			display: flex;
			align-items: center;
			gap: 12px;
			margin-bottom: 28px;
		}

		.audience-icon {
			width: 40px;
			height: 40px;
			display: flex;
			align-items: center;
			justify-content: center;
			background: rgba(13, 148, 136, 0.12);
			border-radius: var(--radius-md);
			color: var(--color-primary-light);
		}

		.audience-icon svg { width: 20px; height: 20px; }

		.audience-header h3 {
			font-size: 18px;
			font-weight: 600;
		}

		.audience-list {
			list-style: none;
			display: flex;
			flex-direction: column;
			gap: 24px;
		}

		.audience-list li {
			display: flex;
			align-items: flex-start;
			gap: 12px;
			font-size: 14px;
			color: var(--color-text-secondary);
		}

		.audience-list li svg {
			width: 18px;
			height: 18px;
			color: var(--color-primary);
			flex-shrink: 0;
			margin-top: 1px;
		}

		/* Getting started CTA */
		.getting-started-cell {
			grid-column: span 12;
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 40px 48px;
			background: var(--color-bg-elevated);
			border: 1px solid var(--color-border);
			border-radius: var(--radius-lg);
			margin-top: 32px;
		}

		.getting-started-content h3 {
			font-size: 20px;
			font-weight: 600;
			margin-bottom: 8px;
		}

		.getting-started-content p {
			font-size: 14px;
			color: var(--color-text-secondary);
			max-width: 480px;
		}

		.getting-started-actions {
			display: flex;
			gap: 12px;
		}

		/* Blog CTA */
		.blog-cell {
			grid-column: span 12;
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 32px 0;
			border-top: 1px solid var(--color-rule);
			margin-top: 40px;
		}

		.blog-content {
			display: flex;
			align-items: center;
			gap: 16px;
		}

		.blog-icon {
			width: 44px;
			height: 44px;
			display: flex;
			align-items: center;
			justify-content: center;
			background: rgba(13, 148, 136, 0.12);
			border-radius: var(--radius-md);
			color: var(--color-primary-light);
		}

		.blog-icon svg { width: 22px; height: 22px; }

		.blog-text h4 {
			font-size: 15px;
			font-weight: 600;
			margin-bottom: 2px;
		}

		.blog-text p {
			font-size: 13px;
			color: var(--color-text-secondary);
		}

		.blog-link {
			display: flex;
			align-items: center;
			gap: 8px;
			color: var(--color-primary-light);
			font-size: 14px;
			font-weight: 500;
			transition: gap var(--transition);
		}

		.blog-link:hover { gap: 12px; }
		.blog-link svg { width: 16px; height: 16px; }

		/* Footer */
		.footer {
			max-width: 1280px;
			margin: 0 auto;
			padding: 24px 32px;
			display: flex;
			justify-content: space-between;
			align-items: center;
			border-top: 1px solid var(--color-rule);
			color: var(--color-text-tertiary);
			font-size: 13px;
		}

		.footer a {
			color: var(--color-text-secondary);
			transition: color var(--transition);
		}

		.footer a:hover { color: var(--color-text); }

		.footer-links {
			display: flex;
			gap: 24px;
		}

		/* Mobile nav */
		.mobile-menu-btn {
			display: none;
			align-items: center;
			justify-content: center;
			width: 36px;
			height: 36px;
			background: transparent;
			border: none;
			cursor: pointer;
			color: var(--color-text);
		}

		.mobile-menu-btn svg { width: 24px; height: 24px; }

		/* Mobile menu overlay */
		.mobile-menu {
			display: none;
			position: fixed;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			background: var(--color-bg);
			z-index: 1000;
			padding: 20px;
			flex-direction: column;
		}

		.mobile-menu.active {
			display: flex;
		}

		.mobile-menu-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 48px;
		}

		.mobile-menu-close {
			display: flex;
			align-items: center;
			justify-content: center;
			width: 36px;
			height: 36px;
			background: transparent;
			border: none;
			cursor: pointer;
			color: var(--color-text);
		}

		.mobile-menu-close svg { width: 24px; height: 24px; }

		.mobile-menu-nav {
			display: flex;
			flex-direction: column;
			gap: 8px;
		}

		.mobile-menu-nav a {
			display: block;
			padding: 16px 0;
			font-size: 18px;
			font-weight: 500;
			color: var(--color-text);
			border-bottom: 1px solid var(--color-border);
			transition: color var(--transition);
		}

		.mobile-menu-nav a:hover {
			color: var(--color-primary-light);
		}

		body.menu-open {
			overflow: hidden;
		}

		/* Responsive */
		@media (max-width: 1024px) {
			.hero-cell {
				grid-column: span 12;
				padding-right: 0;
				padding-bottom: 40px;
				border-bottom: 1px solid var(--color-rule);
			}
			.showcase-cell {
				grid-column: span 12;
				padding-left: 0;
				padding-top: 40px;
				border-left: none;
			}
			.capability-card {
				grid-column: span 6;
			}
			.capability-card.rule-left {
				padding-left: 0;
				border-left: none;
			}
			.capability-card:nth-child(odd) {
				padding-left: 0;
				border-left: none;
			}
			.capability-card:nth-child(even) {
				padding-left: 32px;
				border-left: 1px solid var(--color-rule);
			}
			.prompts-cell { grid-column: span 12; }
			.audience-cell {
				grid-column: span 6;
				padding-left: 0;
			}
			.audience-cell.rule-left {
				padding-left: 32px;
				border-left: 1px solid var(--color-rule);
			}
			h1 { font-size: 40px; }
			.value-cell { padding: 48px 32px; }
			.value-cell h2 { font-size: 30px; }
			.section-rule { margin: 56px 0; }
			.getting-started-cell {
				flex-direction: column;
				gap: 24px;
				text-align: center;
			}
			.getting-started-content p {
				max-width: 100%;
			}
		}

		@media (max-width: 768px) {
			.header { padding: 12px 20px; }
			.nav { display: none; }
			.mobile-menu-btn { display: flex; }
			.main { padding: 32px 20px; }
			.grid { gap: 32px; }

			/* Remove all vertical rules and left padding on mobile */
			.grid-cell.rule-left {
				padding-left: 0;
				border-left: none;
			}

			.hero-cell {
				padding-right: 0;
				padding-bottom: 32px;
			}
			.showcase-cell {
				padding-top: 32px;
			}
			.capability-card {
				grid-column: span 12;
				padding: 0 !important;
				border: none !important;
			}
			.audience-cell {
				grid-column: span 12;
				padding: 0 !important;
			}
			.audience-cell.rule-left {
				padding-top: 32px !important;
				margin-top: 8px;
				border-top: 1px solid var(--color-rule);
			}
			h1 { font-size: 34px; }
			.hero-subtitle { font-size: 16px; }
			.showcase-stat .number { font-size: 48px; }
			.value-cell { padding: 40px 24px; }
			.value-cell h2 { font-size: 26px; }
			.value-cell p { font-size: 16px; }
			.section-rule { margin: 48px 0; }
			.blog-cell {
				flex-direction: column;
				gap: 16px;
				text-align: center;
			}
			.blog-content { flex-direction: column; }
			.footer {
				flex-direction: column;
				gap: 16px;
				text-align: center;
			}
			.getting-started-cell {
				padding: 24px;
			}
			.getting-started-actions {
				flex-direction: column;
				width: 100%;
			}
			.getting-started-actions .btn {
				justify-content: center;
			}
		}

		@media (max-width: 480px) {
			.cta-row { flex-direction: column; }
			.btn { justify-content: center; }
		}
	</style>
</head>
<body>
	<header class="header">
		<a href="/" class="logo">
			<img src="https://docs.figma-console-mcp.southleft.com/logo/light.svg" alt="Figma Console MCP" class="logo-dark">
			<img src="https://docs.figma-console-mcp.southleft.com/logo/dark.svg" alt="Figma Console MCP" class="logo-light" style="display: none;">
		</a>
		<div class="header-right">
			<nav class="nav">
				<a href="https://docs.figma-console-mcp.southleft.com">Documentation</a>
				<a href="https://github.com/southleft/figma-console-mcp">GitHub</a>
				<a href="https://www.npmjs.com/package/figma-console-mcp">npm</a>
				<a href="https://southleft.com/insights/ai/figma-console-mcp-ai-powered-design-system-management/">Blog</a>
			</nav>
			<button class="theme-toggle" aria-label="Toggle theme">
				<svg class="moon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
				<svg class="sun" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
			</button>
			<button class="mobile-menu-btn" aria-label="Menu">
				<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
			</button>
		</div>
	</header>

	<!-- Mobile Menu -->
	<div class="mobile-menu" id="mobileMenu">
		<div class="mobile-menu-header">
			<a href="/" class="logo">
				<img src="https://docs.figma-console-mcp.southleft.com/logo/light.svg" alt="Figma Console MCP" class="logo-dark">
				<img src="https://docs.figma-console-mcp.southleft.com/logo/dark.svg" alt="Figma Console MCP" class="logo-light" style="display: none;">
			</a>
			<button class="mobile-menu-close" aria-label="Close menu">
				<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"/></svg>
			</button>
		</div>
		<nav class="mobile-menu-nav">
			<a href="https://docs.figma-console-mcp.southleft.com">Documentation</a>
			<a href="https://github.com/southleft/figma-console-mcp">GitHub</a>
			<a href="https://www.npmjs.com/package/figma-console-mcp">npm</a>
			<a href="https://southleft.com/insights/ai/figma-console-mcp-ai-powered-design-system-management/">Blog</a>
		</nav>
	</div>

	<main class="main">
		<div class="grid">
			<!-- Hero -->
			<div class="grid-cell hero-cell">
				<div class="badge">Model Context Protocol</div>
				<h1>Your design system, now a <span class="highlight">living API</span></h1>
				<p class="hero-subtitle">The most comprehensive MCP server for Figma. Give AI assistants deep access to your design tokens, components, and variables. Read, query, and even create designs programmatically through natural language.</p>
				<div class="cta-row">
					<a href="https://docs.figma-console-mcp.southleft.com" class="btn btn-primary">
						Read the Docs
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
					</a>
					<a href="https://github.com/southleft/figma-console-mcp" class="btn btn-secondary">
						<svg fill="currentColor" viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
						View on GitHub
					</a>
				</div>
			</div>

			<!-- Capabilities showcase -->
			<div class="grid-cell showcase-cell rule-left">
				<div class="showcase-label">What AI Can Access</div>
				<div class="showcase-stat">
					<span class="number">40+</span>
					<span class="label">MCP tools for Figma</span>
				</div>
				<div class="capability-list">
					<div class="capability-item">
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"/></svg>
						<span>Design tokens and variables</span>
					</div>
					<div class="capability-item">
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
						<span>Component specs and properties</span>
					</div>
					<div class="capability-item">
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
						<span>Programmatic design creation</span>
					</div>
					<div class="capability-item">
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
						<span>Real-time plugin debugging</span>
					</div>
				</div>
			</div>
		</div>

		<hr class="section-rule">

		<!-- Value proposition -->
		<div class="grid">
			<div class="grid-cell value-cell">
				<h2>Design system intelligence for AI assistants</h2>
				<p>Whether you're maintaining a component library, implementing designs in code, or building Figma plugins, this MCP server gives AI the deep context it needs.</p>
			</div>
		</div>

		<hr class="section-rule">

		<!-- Capabilities detail -->
		<div class="grid">
			<div class="grid-cell capability-card">
				<div class="capability-icon">
					<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"/></svg>
				</div>
				<h3>Design Tokens</h3>
				<p>Extract colors, typography, spacing, and effects. Export as CSS custom properties, Tailwind config, or Sass variables.</p>
			</div>

			<div class="grid-cell capability-card rule-left">
				<div class="capability-icon">
					<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
				</div>
				<h3>Component Specs</h3>
				<p>Get detailed layout, spacing, variants, and property data for any component in your design system.</p>
			</div>

			<div class="grid-cell capability-card rule-left">
				<div class="capability-icon">
					<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
				</div>
				<h3>Programmatic Design</h3>
				<p>Create and modify variables, build component variants, and generate design elements through natural language.</p>
			</div>

			<div class="grid-cell capability-card rule-left">
				<div class="capability-icon">
					<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
				</div>
				<h3>Plugin Debugging</h3>
				<p>Capture real-time console logs from Figma plugins. Let AI analyze errors and suggest fixes without context switching.</p>
			</div>
		</div>

		<hr class="section-rule">

		<div class="grid">
			<!-- Example Prompts -->
			<div class="grid-cell prompts-cell">
				<div class="section-header">
					<div class="section-header-icon">
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
					</div>
					<h3>What you can ask</h3>
				</div>
				<div class="prompt-list">
					<div class="prompt-item">
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
						<span>"Extract all color variables as Tailwind config"</span>
					</div>
					<div class="prompt-item">
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
						<span>"Get the Button component specs from my design system"</span>
					</div>
					<div class="prompt-item">
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
						<span>"Create a dark mode version of my color variables"</span>
					</div>
					<div class="prompt-item">
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
						<span>"Why is my plugin throwing this error?"</span>
					</div>
				</div>
			</div>

			<!-- For Designers -->
			<div class="grid-cell audience-cell rule-left">
				<div class="audience-header">
					<div class="audience-icon">
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
					</div>
					<h3>For Designers</h3>
				</div>
				<ul class="audience-list">
					<li>
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>
						<span>Generate design token documentation automatically</span>
					</li>
					<li>
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>
						<span>Create component variants with AI assistance</span>
					</li>
					<li>
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>
						<span>Debug Figma plugins without leaving your workflow</span>
					</li>
				</ul>
			</div>
		</div>

		<div class="grid" style="margin-top: 48px;">
			<!-- For Engineers -->
			<div class="grid-cell audience-cell">
				<div class="audience-header">
					<div class="audience-icon">
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
					</div>
					<h3>For Engineers</h3>
				</div>
				<ul class="audience-list">
					<li>
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>
						<span>Extract tokens as CSS, Tailwind, or Sass variables</span>
					</li>
					<li>
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>
						<span>Get accurate component specs for implementation</span>
					</li>
					<li>
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>
						<span>Query your design system via MCP-enabled AI tools</span>
					</li>
				</ul>
			</div>

			<!-- For Teams -->
			<div class="grid-cell audience-cell rule-left">
				<div class="audience-header">
					<div class="audience-icon">
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
					</div>
					<h3>For Teams of All Sizes</h3>
				</div>
				<ul class="audience-list">
					<li>
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>
						<span>Indie developers to enterprise design systems</span>
					</li>
					<li>
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>
						<span>Local mode for development, remote for production</span>
					</li>
					<li>
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>
						<span>Works with Claude, Cursor, and any MCP client</span>
					</li>
				</ul>
			</div>
		</div>

		<!-- Getting Started CTA -->
		<div class="grid">
			<div class="grid-cell getting-started-cell">
				<div class="getting-started-content">
					<h3>Ready to get started?</h3>
					<p>Setup varies based on your needs: remote mode for quick API access, or local mode for full plugin debugging. Our docs will guide you through the right path.</p>
				</div>
				<div class="getting-started-actions">
					<a href="https://docs.figma-console-mcp.southleft.com/setup" class="btn btn-primary">
						View Setup Guide
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
					</a>
					<a href="https://docs.figma-console-mcp.southleft.com/tools" class="btn btn-secondary">
						Explore Tools
					</a>
				</div>
			</div>
		</div>

		<div class="grid">
			<!-- Blog CTA -->
			<a href="https://southleft.com/insights/ai/figma-console-mcp-ai-powered-design-system-management/" class="grid-cell blog-cell">
				<div class="blog-content">
					<div class="blog-icon">
						<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
					</div>
					<div class="blog-text">
						<h4>Read the announcement</h4>
						<p>AI-Powered Design System Management with Figma Console MCP</p>
					</div>
				</div>
				<span class="blog-link">
					Read article
					<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
				</span>
			</a>
		</div>
	</main>

	<footer class="footer">
		<p>MIT License. Built by <a href="https://southleft.com">Southleft</a></p>
		<div class="footer-links">
			<a href="https://docs.figma-console-mcp.southleft.com">Docs</a>
			<a href="https://github.com/southleft/figma-console-mcp">GitHub</a>
			<a href="https://www.npmjs.com/package/figma-console-mcp">npm</a>
		</div>
	</footer>

	<script>
		// Theme toggle with system preference detection
		(function() {
			const html = document.documentElement;
			const toggle = document.querySelector('.theme-toggle');
			const logosDark = document.querySelectorAll('.logo-dark');
			const logosLight = document.querySelectorAll('.logo-light');

			function getSystemTheme() {
				return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
			}

			function getStoredTheme() {
				return localStorage.getItem('theme');
			}

			function setTheme(theme) {
				html.setAttribute('data-theme', theme);
				localStorage.setItem('theme', theme);
				updateLogos(theme);
			}

			function updateLogos(theme) {
				logosDark.forEach(logo => {
					logo.style.display = theme === 'light' ? 'none' : 'block';
				});
				logosLight.forEach(logo => {
					logo.style.display = theme === 'light' ? 'block' : 'none';
				});
			}

			// Initialize theme
			const storedTheme = getStoredTheme();
			const initialTheme = storedTheme || getSystemTheme();
			setTheme(initialTheme);

			// Listen for system theme changes
			window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
				if (!getStoredTheme()) {
					setTheme(e.matches ? 'light' : 'dark');
				}
			});

			// Toggle button
			toggle.addEventListener('click', () => {
				const currentTheme = html.getAttribute('data-theme');
				setTheme(currentTheme === 'light' ? 'dark' : 'light');
			});
		})();

		// Mobile menu toggle
		(function() {
			const menuBtn = document.querySelector('.mobile-menu-btn');
			const menu = document.getElementById('mobileMenu');
			const closeBtn = document.querySelector('.mobile-menu-close');
			const menuLinks = document.querySelectorAll('.mobile-menu-nav a');

			function openMenu() {
				menu.classList.add('active');
				document.body.classList.add('menu-open');
			}

			function closeMenu() {
				menu.classList.remove('active');
				document.body.classList.remove('menu-open');
			}

			menuBtn.addEventListener('click', openMenu);
			closeBtn.addEventListener('click', closeMenu);

			// Close menu when clicking a link
			menuLinks.forEach(link => {
				link.addEventListener('click', closeMenu);
			});

			// Close menu on escape key
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape' && menu.classList.contains('active')) {
					closeMenu();
				}
			});
		})();
	</script>
</body>
</html>`,
			{
				headers: { "Content-Type": "text/html; charset=utf-8" }
			}
		);
	}

	return new Response("Not found", { status: 404 });
	},
};
