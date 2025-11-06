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

	/**
	 * Get or create Figma API client with OAuth token from session
	 */
	private async getFigmaAPI(): Promise<FigmaAPI> {
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

			const tokenData = JSON.parse(tokenJson) as {
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
				// Check if token is expired
				if (tokenData.expiresAt && Date.now() > tokenData.expiresAt) {
					// TODO: Implement token refresh
					logger.warn({ sessionId }, "Token expired, re-authentication required");
					throw new Error("Token expired. Please re-authenticate.");
				}

				logger.info({ sessionId }, "Using OAuth token from KV for Figma API");
				return new FigmaAPI({ accessToken: tokenData.accessToken });
			}

			logger.warn({ sessionId }, "OAuth token exists in KV but missing accessToken");
			throw new Error("Invalid token data");
		} catch (error) {
			logger.warn({ error }, "Failed to retrieve OAuth token from KV");
		}

		// Fallback to server-wide token (deprecated)
		if (env?.FIGMA_ACCESS_TOKEN) {
			logger.info("Using deprecated FIGMA_ACCESS_TOKEN. Consider migrating to OAuth.");
			return new FigmaAPI({ accessToken: env.FIGMA_ACCESS_TOKEN });
		}

		// No authentication available
		const sessionId = this.getSessionId();
		const authUrl = `https://figma-console-mcp.southleft.com/oauth/authorize?session_id=${sessionId}`;

		throw new Error(
			JSON.stringify({
				error: "authentication_required",
				message: "Please authenticate with Figma to use API features",
				auth_url: authUrl,
				instructions: "Your browser will open automatically to complete authentication. If it doesn't, copy the auth_url and open it manually."
			})
		);
	}

	/**
	 * Handle internal token storage requests from OAuth callback
	 */
	async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Handle internal token storage
		if (url.pathname === "/internal/store-token" && request.method === "POST") {
			try {
				const body = await request.json() as {
					sessionId: string;
					accessToken: string;
					refreshToken?: string;
					expiresAt: number;
				};

				logger.info({
					sessionId: body.sessionId,
					hasAccessToken: !!body.accessToken,
					accessTokenPreview: body.accessToken ? body.accessToken.substring(0, 10) + "..." : null,
					hasRefreshToken: !!body.refreshToken,
					expiresAt: body.expiresAt
				}, "Storing OAuth token");

				// Store token in Durable Object storage
				await this.ctx.storage.put(`oauth_token:${body.sessionId}`, {
					accessToken: body.accessToken,
					refreshToken: body.refreshToken,
					expiresAt: body.expiresAt
				});

				// Verify storage worked
				const verification = await this.ctx.storage.get(`oauth_token:${body.sessionId}`);
				logger.info({
					sessionId: body.sessionId,
					verified: !!verification
				}, "OAuth token stored and verified");

				return new Response(JSON.stringify({ success: true }), {
					headers: { "Content-Type": "application/json" }
				});
			} catch (error) {
				logger.error({ error }, "Failed to store OAuth token");
				return new Response(
					JSON.stringify({ error: "Failed to store token" }),
					{
						status: 500,
						headers: { "Content-Type": "application/json" }
					}
				);
			}
		}

		// Default response for other requests
		return new Response("Method not allowed", { status: 405 });
	}

	/**
	 * Initialize browser and console monitoring
	 */
	private async ensureInitialized(): Promise<void> {
		try {
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
											"⚠️ CRITICAL: Console cleared successfully, but this operation disrupts the monitoring connection. You MUST reconnect the MCP server using `/mcp reconnect figma-console` before calling figma_get_console_logs again. Best practice: Avoid clearing console - filter/parse logs instead to maintain monitoring connection.",
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

			const redirectUri = `${url.origin}/oauth/callback`;

			const figmaAuthUrl = new URL("https://www.figma.com/oauth");
			figmaAuthUrl.searchParams.set("client_id", env.FIGMA_OAUTH_CLIENT_ID);
			figmaAuthUrl.searchParams.set("redirect_uri", redirectUri);
			figmaAuthUrl.searchParams.set("scope", "file_content:read,library_content:read");
			figmaAuthUrl.searchParams.set("state", sessionId);
			figmaAuthUrl.searchParams.set("response_type", "code");

			return Response.redirect(figmaAuthUrl.toString(), 302);
		}

		// OAuth callback handler
		if (url.pathname === "/oauth/callback") {
			const code = url.searchParams.get("code");
			const sessionId = url.searchParams.get("state");
			const error = url.searchParams.get("error");

			// Handle OAuth errors
			if (error) {
				return new Response(
					`<html><body>
						<h1>❌ Authentication Failed</h1>
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

			if (!code || !sessionId) {
				return new Response("Missing code or state parameter", { status: 400 });
			}

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
	<style>
								body {
									font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
									display: flex;
									justify-content: center;
									align-items: center;
									height: 100vh;
									margin: 0;
									background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
								}
								.container {
									background: white;
									padding: 3rem;
									border-radius: 12px;
									box-shadow: 0 10px 40px rgba(0,0,0,0.2);
									text-align: center;
									max-width: 400px;
								}
								h1 { color: #667eea; margin-top: 0; }
								.checkmark {
									font-size: 4rem;
									animation: scaleIn 0.5s ease-out;
								}
								@keyframes scaleIn {
									from { transform: scale(0); }
									to { transform: scale(1); }
								}
								p { color: #666; line-height: 1.6; }
								.close-btn {
									margin-top: 1.5rem;
									padding: 0.75rem 2rem;
									background: #667eea;
									color: white;
									border: none;
									border-radius: 6px;
									font-size: 1rem;
									cursor: pointer;
								}
								.close-btn:hover { background: #5568d3; }
							</style>
						</head>
						<body>
							<div class="container">
								<div class="checkmark">✅</div>
								<h1>Authentication Successful!</h1>
								<p>You've successfully connected to Figma. You can now close this window and return to Claude.</p>
								<button class="close-btn" onclick="window.close()">Close Window</button>
							</div>
							<script>
								// Auto-close after 5 seconds
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
						<h1>❌ Authentication Error</h1>
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

		return new Response("Not found", { status: 404 });
	},
};
