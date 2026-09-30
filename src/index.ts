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
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { BrowserManager, type Env } from "./browser-manager.js";
import { ConsoleMonitor } from "./core/console-monitor.js";
import { getConfig } from "./core/config.js";
import { createChildLogger } from "./core/logger.js";
import { FigmaAPI, extractFileKey, formatVariables, formatComponentData } from "./core/figma-api.js";
import { registerFigmaAPITools } from "./core/figma-tools.js";
import { registerDesignCodeTools } from "./core/design-code-tools.js";
import { registerCommentTools } from "./core/comment-tools.js";
import { registerVersionTools } from "./core/version-tools.js";
import { registerAnnotationTools } from "./core/annotation-tools.js";
import { registerDeepComponentTools } from "./core/deep-component-tools.js";
import { registerDesignSystemTools } from "./core/design-system-tools.js";
import { registerLibraryTools, registerLibraryVariableTools } from "./core/library-tools.js";
import { registerDiagnoseTool } from "./core/diagnose-tool.js";
import { wrapServerForIdentity } from "./core/identity.js";
import { PluginRelayDO, generatePairingCode } from "./core/cloud-websocket-relay.js";
import { CloudWebSocketConnector } from "./core/cloud-websocket-connector.js";
import { registerWriteTools } from "./core/write-tools.js";
import { registerTokensTools } from "./core/tokens-tools.js";
import { registerFigJamTools } from "./core/figjam-tools.js";
import { registerSlidesTools } from "./core/slides-tools.js";
import { registerSlotTools } from "./core/slot-tools.js";

// Re-export PluginRelayDO so Cloudflare Workers can bind it as a Durable Object
export { PluginRelayDO } from "./core/cloud-websocket-relay.js";
// Note: MCP Apps (Token Browser, Dashboard) are only available in local mode
// They require Node.js file system APIs for serving HTML that don't work in Cloudflare Workers

const logger = createChildLogger({ component: "mcp-server" });

/**
 * Validate a Figma Personal Access Token (PAT) by calling the Figma API.
 * PATs start with 'figd_' and require the X-Figma-Token header (not Bearer).
 * Returns the user info if valid, null if invalid/expired.
 */
async function validateFigmaPAT(token: string): Promise<{ id: string; handle: string; email: string } | null> {
	try {
		const response = await fetch("https://api.figma.com/v1/me", {
			headers: { "X-Figma-Token": token },
		});
		if (!response.ok) return null;
		const data = await response.json() as { id: string; handle: string; email: string };
		return data?.id ? data : null;
	} catch {
		return null;
	}
}

/**
 * Check if a token is a Figma Personal Access Token.
 * PATs start with 'figd_' — OAuth tokens start with 'figu_'.
 */
function isFigmaPAT(token: string): boolean {
	return token.startsWith("figd_");
}

/**
 * Figma Console MCP Agent
 * Extends McpAgent to provide Figma-specific debugging tools
 */
// Server version reported by figma_diagnose in both cloud endpoints.
// scripts/release.sh keeps this current (it rewrites every `version: "x.y.z"` here).
const cloudBuild = { version: "1.40.8" };

export class FigmaConsoleMCPv3 extends McpAgent {
	server = (() => {
		const s = new McpServer({
			name: "Figma Console MCP",
			version: "1.40.8",
		});
		// Identity wrap — every tool's response and thrown error gets stamped
		// with our MCP name so cross-MCP attribution is unambiguous.
		wrapServerForIdentity(s);
		return s;
	})();

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
		const env = this.env as unknown as Env;

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

		// Store reverse lookup for Bearer token validation on SSE endpoint
		const bearerKey = `bearer_token:${tokenData.access_token}`;
		await env.OAUTH_TOKENS.put(bearerKey, JSON.stringify({
			sessionId,
			expiresAt: storedToken.expiresAt
		}), {
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
			"Retrieve console logs from a Cloudflare Browser Rendering session opened with figma_navigate. Captures plugin console output ([Main], [Swapper], etc. prefixes) and page-level logs. NOTE: cloud mode does NOT currently capture logs from a paired Desktop Bridge plugin — for plugin sandbox logs, use Local mode. Call figma_navigate first to open the file and start browser monitoring.",
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
					.describe("Optional node ID to screenshot (e.g., '123:456'). If omitted, uses the node-id query param from the Cloudflare Browser Rendering page's current URL."),
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

					// Navigate to the URL (may switch to existing tab in local mode)
					const result = await this.browserManager.navigateToFigma(url);

					if (result.action === 'switched_to_existing') {
						// Switch console monitor to the page
						if (this.consoleMonitor) {
							this.consoleMonitor.stopMonitoring();
							await this.consoleMonitor.startMonitoring(result.page);
						}

						const currentUrl = this.browserManager.getCurrentUrl();

						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											status: "switched_to_existing",
											url: currentUrl,
											timestamp: Date.now(),
											message: "Switched to existing tab for this Figma file. Console monitoring is active.",
										},
										null,
										2,
									),
								},
							],
						};
					}

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

		// ================================================================
		// Cloud Write Relay — Pairing Tool
		// ================================================================
		this.server.tool(
			"figma_pair_plugin",
			"Pair the Figma Desktop Bridge plugin to this cloud session for write access. Returns a 6-character code the user enters in the plugin's Cloud Mode section.",
			{},
			async () => {
				try {
					const env = this.env as unknown as Env;
					const code = generatePairingCode();

					// Create a unique DO ID for this relay session
					const relayDoId = env.PLUGIN_RELAY.newUniqueId().toString();

					// Store pairing code → relay DO ID in KV (5-min TTL, one-time use)
					await env.OAUTH_TOKENS.put(`pairing:${code}`, relayDoId, {
						expirationTtl: 300,
					});

					// Store relay DO ID in this MCP DO's storage for session persistence
					await this.ctx.storage.put('relayDoId', relayDoId);

					return {
						content: [{
							type: "text" as const,
							text: JSON.stringify({
								pairingCode: code,
								expiresIn: "5 minutes",
								instructions: [
									"1. Open the Desktop Bridge plugin in Figma Desktop",
									"2. Click the 'Cloud Mode' toggle in the plugin UI",
									`3. Enter pairing code: ${code}`,
									"4. Click 'Connect' — the plugin will connect to the cloud relay",
									"5. Once paired, write tools (variables, components, nodes) work through the cloud"
								],
							}, null, 2),
						}],
					};
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ error: errorMessage }) }],
						isError: true,
					};
				}
			},
		);

		// ================================================================
		// Cloud Desktop Connector factory
		// ================================================================
		const getCloudDesktopConnector = async (): Promise<any> => {
			const env = this.env as unknown as Env;
			const relayDoId = await this.ctx.storage.get<string>('relayDoId');
			if (!relayDoId) {
				throw new Error('No cloud relay session. Call figma_pair_plugin first to pair the Desktop Bridge plugin.');
			}
			const doId = env.PLUGIN_RELAY.idFromString(relayDoId);
			const stub = env.PLUGIN_RELAY.get(doId);
			const connector = new CloudWebSocketConnector(stub);
			await connector.initialize();
			return connector;
		};

		// Register all write/manipulation tools via shared function
		registerWriteTools(this.server, getCloudDesktopConnector);

		// Register token sync tools — figma_export_tokens and figma_import_tokens.
		registerTokensTools(this.server, getCloudDesktopConnector, { isRemoteMode: true });

		// Register FigJam-specific tools (sticky notes, connectors, tables, etc.)
		registerFigJamTools(this.server, getCloudDesktopConnector);

		// Register Annotation tools (read/write design annotations via Desktop Bridge)
		registerAnnotationTools(this.server, getCloudDesktopConnector);

		// Register Deep Component tools (Plugin API tree extraction for code generation)
		registerDeepComponentTools(this.server, getCloudDesktopConnector);

		// Register Figma Slides tools (slide management, transitions, content)
		registerSlidesTools(this.server, getCloudDesktopConnector);

		registerSlotTools(this.server, getCloudDesktopConnector);

		// Register Figma API tools (Tools 8-14)
		// Pass isRemoteMode: true to suppress Desktop Bridge mentions in tool descriptions
		registerFigmaAPITools(
			this.server,
			async () => await this.getFigmaAPI(),
			() => this.browserManager?.getCurrentUrl() || null,
			undefined, // variablesCache
			{ isRemoteMode: true },
			getCloudDesktopConnector,
		);

		// Register Design-Code Parity & Documentation tools
		registerDesignCodeTools(
			this.server,
			async () => await this.getFigmaAPI(),
			() => this.browserManager?.getCurrentUrl() || null,
			undefined, // variablesCache
			{ isRemoteMode: true },
			getCloudDesktopConnector,
		);

		// Register Comment tools
		registerCommentTools(
			this.server,
			async () => await this.getFigmaAPI(),
			() => this.browserManager?.getCurrentUrl() || null,
			{ isRemoteMode: true },
		);

		// Register Version History tools
		registerVersionTools(
			this.server,
			async () => await this.getFigmaAPI(),
			() => this.browserManager?.getCurrentUrl() || null,
			{ isRemoteMode: true },
		);

		// Register Design System Kit tool
		registerDesignSystemTools(
			this.server,
			async () => await this.getFigmaAPI(),
			() => this.browserManager?.getCurrentUrl() || null,
			undefined, // variablesCache
			{ isRemoteMode: true },
			getCloudDesktopConnector, // bridge-first variable resolution (works on any plan)
		);

		// Register Library Tools (key-based component inspection across shared libraries)
		registerLibraryTools(this.server, async () => await this.getFigmaAPI());

		// Register Library Variable Tools (Plugin-API based — list + import variables
		// from subscribed team libraries; routes through the cloud Desktop Bridge)
		registerLibraryVariableTools(this.server, getCloudDesktopConnector);

		// figma_scan_code_accessibility (axe-core + JSDOM) is Local Mode only.
		// JSDOM cannot run in Workers: called here it failed on every input
		// ("JSDOM is not a constructor" on /sse, "MessagePort is not defined" on
		// /mcp), so listing it in Cloud Mode only advertised a broken tool.

		// Register figma_diagnose for cloud mode. Plugin state isn't directly
		// observable from here (the paired plugin's WS lives in the relay DO),
		// so we report mode and let the cross-MCP disclaimer do most of the work.
		registerDiagnoseTool(this.server, {
			mode: "cloud",
			getServerVersion: () => cloudBuild.version,
			getPluginState: () => null,
			// /sse only admits requests with a validated OAuth token or Figma PAT,
			// so a running session always has one. (Previously this said "no token"
			// on every call, which sent users chasing a problem they didn't have.)
			getTokenState: () => ({ hasToken: true }),
		});

		// Note: MCP Apps (Token Browser, Dashboard) are registered in local.ts only
		// They require Node.js file system APIs that don't work in Cloudflare Workers
	}
}

/**
 * Cloudflare Workers fetch handler
 * Routes requests to appropriate MCP endpoints
 */
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		// Use canonical origin for OAuth redirect URIs so they match the Figma OAuth app config
		// regardless of whether the request comes via workers.dev or custom domain
		const oauthOrigin = env.CANONICAL_ORIGIN || url.origin;

		// Redirect /docs to subdomain
		if (url.pathname === "/docs" || url.pathname.startsWith("/docs/")) {
			const newPath = url.pathname.replace(/^\/docs\/?/, "/");
			const redirectUrl = `https://docs.figma-console-mcp.southleft.com${newPath}${url.search}`;
			return Response.redirect(redirectUrl, 301);
		}

		// ================================================================
		// Cloud Write Relay — Plugin WebSocket pairing endpoint
		// ================================================================
		if (url.pathname === "/ws/pair") {
			const code = url.searchParams.get("code");
			if (!code) {
				return new Response(JSON.stringify({ error: "Missing pairing code" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}

			// Look up pairing code in KV
			const pairingKey = `pairing:${code.toUpperCase()}`;
			const relayDoId = await env.OAUTH_TOKENS.get(pairingKey);

			if (!relayDoId) {
				return new Response(JSON.stringify({ error: "Invalid or expired pairing code" }), {
					status: 404,
					headers: { "Content-Type": "application/json" },
				});
			}

			// Delete used code (one-time use)
			await env.OAUTH_TOKENS.delete(pairingKey);

			// Forward WebSocket upgrade to the relay DO
			const doId = env.PLUGIN_RELAY.idFromString(relayDoId);
			const stub = env.PLUGIN_RELAY.get(doId);

			// Rewrite URL to the relay DO's /ws/connect path
			const relayUrl = new URL(request.url);
			relayUrl.pathname = "/ws/connect";
			const relayRequest = new Request(relayUrl.toString(), request);

			return stub.fetch(relayRequest);
		}

		// SSE endpoint for remote MCP clients
		// Per MCP spec, we MUST validate Bearer tokens on every HTTP request
		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			// Validate Authorization header per MCP OAuth 2.1 spec
			const authHeader = request.headers.get("Authorization");

			if (!authHeader || !authHeader.startsWith("Bearer ")) {
				logger.warn({ pathname: url.pathname }, "SSE request missing Authorization header - returning 401 with resource_metadata");
				// MCP spec requires resource_metadata URL in WWW-Authenticate header (RFC9728)
				const resourceMetadataUrl = `${url.origin}/.well-known/oauth-protected-resource`;
				return new Response(JSON.stringify({
					error: "unauthorized",
					error_description: "Authorization header with Bearer token is required"
				}), {
					status: 401,
					headers: {
						"Content-Type": "application/json",
						"WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`
					}
				});
			}

			const bearerToken = authHeader.substring(7); // Remove "Bearer " prefix

			// PAT support: Figma Personal Access Tokens (figd_*) are passed as Bearer
			// tokens by MCP clients like Lovable, but they aren't stored in our OAuth KV.
			// Validate them directly against Figma's API instead.
			if (isFigmaPAT(bearerToken)) {
				logger.info({ pathname: url.pathname }, "SSE request with Figma PAT — validating against Figma API");
				const patUser = await validateFigmaPAT(bearerToken);
				if (!patUser) {
					logger.warn({ pathname: url.pathname }, "SSE request with invalid Figma PAT");
					const resourceMetadataUrl = `${url.origin}/.well-known/oauth-protected-resource`;
					return new Response(JSON.stringify({
						error: "invalid_token",
						error_description: "Figma Personal Access Token is invalid or expired"
					}), {
						status: 401,
						headers: {
							"Content-Type": "application/json",
							"WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}", error="invalid_token"`
						}
					});
				}

				// Store PAT in KV so the Durable Object's getFigmaAPI() can retrieve it
				const patSessionId = "figma-console-mcp-default-session";
				const patTokenKey = `oauth_token:${patSessionId}`;
				await env.OAUTH_TOKENS.put(patTokenKey, JSON.stringify({
					accessToken: bearerToken,
					expiresAt: Date.now() + 3600_000, // 1-hour TTL for PAT session
				}), { expirationTtl: 3600 });

				logger.info({ pathname: url.pathname, user: patUser.handle }, "SSE request authenticated via Figma PAT");

				// Proceed with SSE connection
				return FigmaConsoleMCPv3.serveSSE("/sse").fetch(request, env, ctx);
			}

			// OAuth token path: look up in KV store
			const bearerKey = `bearer_token:${bearerToken}`;

			try {
				const tokenDataJson = await env.OAUTH_TOKENS.get(bearerKey);

				if (!tokenDataJson) {
					logger.warn({ pathname: url.pathname }, "SSE request with invalid Bearer token");
					const resourceMetadataUrl = `${url.origin}/.well-known/oauth-protected-resource`;
					return new Response(JSON.stringify({
						error: "invalid_token",
						error_description: "Bearer token is invalid or expired"
					}), {
						status: 401,
						headers: {
							"Content-Type": "application/json",
							"WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}", error="invalid_token"`
						}
					});
				}

				const tokenData = JSON.parse(tokenDataJson) as { sessionId: string; expiresAt: number };

				// Check if token is expired
				if (tokenData.expiresAt < Date.now()) {
					logger.warn({ pathname: url.pathname, sessionId: tokenData.sessionId }, "SSE request with expired Bearer token");
					const resourceMetadataUrl = `${url.origin}/.well-known/oauth-protected-resource`;
					return new Response(JSON.stringify({
						error: "invalid_token",
						error_description: "Bearer token has expired"
					}), {
						status: 401,
						headers: {
							"Content-Type": "application/json",
							"WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}", error="invalid_token"`
						}
					});
				}

				logger.info({ pathname: url.pathname, sessionId: tokenData.sessionId }, "SSE request authenticated successfully");
			} catch (error) {
				logger.error({ error, pathname: url.pathname }, "Error validating Bearer token");
				return new Response(JSON.stringify({
					error: "server_error",
					error_description: "Failed to validate authorization"
				}), {
					status: 500,
					headers: { "Content-Type": "application/json" }
				});
			}

			// Token is valid, proceed with SSE connection
			return FigmaConsoleMCPv3.serveSSE("/sse").fetch(request, env, ctx);
		}

		// Streamable HTTP endpoint for MCP communication (current spec)
		// Supports POST (client→server) and optional GET (server→client SSE)
		if (url.pathname === "/mcp") {
			// Validate Authorization header per MCP OAuth 2.1 spec
			const authHeader = request.headers.get("Authorization");

			if (!authHeader || !authHeader.startsWith("Bearer ")) {
				logger.warn({ pathname: url.pathname }, "MCP request missing Authorization header - returning 401 with resource_metadata");
				const resourceMetadataUrl = `${url.origin}/.well-known/oauth-protected-resource`;
				return new Response(JSON.stringify({
					error: "unauthorized",
					error_description: "Authorization header with Bearer token is required"
				}), {
					status: 401,
					headers: {
						"Content-Type": "application/json",
						"WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`
					}
				});
			}

			const bearerToken = authHeader.substring(7);

			// PAT support: Figma Personal Access Tokens (figd_*) are passed as Bearer
			// tokens by MCP clients like Lovable, v0, and Replit. They bypass OAuth
			// and aren't stored in KV — validate directly against Figma's API.
			if (isFigmaPAT(bearerToken)) {
				logger.info({ pathname: url.pathname }, "MCP request with Figma PAT — validating against Figma API");
				const patUser = await validateFigmaPAT(bearerToken);
				if (!patUser) {
					logger.warn({ pathname: url.pathname }, "MCP request with invalid Figma PAT");
					const resourceMetadataUrl = `${url.origin}/.well-known/oauth-protected-resource`;
					return new Response(JSON.stringify({
						error: "invalid_token",
						error_description: "Figma Personal Access Token is invalid or expired. Ensure your PAT (figd_...) is valid and has not been revoked."
					}), {
						status: 401,
						headers: {
							"Content-Type": "application/json",
							"WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}", error="invalid_token"`
						}
					});
				}
				logger.info({ pathname: url.pathname, user: patUser.handle }, "MCP request authenticated via Figma PAT");
			} else {
				// OAuth token path: look up in KV store
				const bearerKey = `bearer_token:${bearerToken}`;

				try {
					const tokenDataJson = await env.OAUTH_TOKENS.get(bearerKey);

					if (!tokenDataJson) {
						logger.warn({ pathname: url.pathname }, "MCP request with invalid Bearer token");
						const resourceMetadataUrl = `${url.origin}/.well-known/oauth-protected-resource`;
						return new Response(JSON.stringify({
							error: "invalid_token",
							error_description: "Bearer token is invalid or expired"
						}), {
							status: 401,
							headers: {
								"Content-Type": "application/json",
								"WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}", error="invalid_token"`
							}
						});
					}

					const tokenData = JSON.parse(tokenDataJson) as { sessionId: string; expiresAt: number };

					if (tokenData.expiresAt < Date.now()) {
						logger.warn({ pathname: url.pathname, sessionId: tokenData.sessionId }, "MCP request with expired Bearer token");
						const resourceMetadataUrl = `${url.origin}/.well-known/oauth-protected-resource`;
						return new Response(JSON.stringify({
							error: "invalid_token",
							error_description: "Bearer token has expired"
						}), {
							status: 401,
							headers: {
								"Content-Type": "application/json",
								"WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}", error="invalid_token"`
							}
						});
					}

					logger.info({ pathname: url.pathname, sessionId: tokenData.sessionId }, "MCP request authenticated successfully");
				} catch (error) {
					logger.error({ error, pathname: url.pathname }, "Error validating Bearer token for MCP endpoint");
					return new Response(JSON.stringify({
						error: "server_error",
						error_description: "Failed to validate authorization"
					}), {
						status: 500,
						headers: { "Content-Type": "application/json" }
					});
				}
			}

			// Token is valid — use stateless transport (no Durable Objects)
			// The Bearer token IS the Figma access token, so we use it directly
			// FigmaAPI handles PAT vs OAuth header selection internally
			const figmaAccessToken = bearerToken;
			const statelessApi = new FigmaAPI({ accessToken: figmaAccessToken });

			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: undefined, // Stateless — no session persistence needed
			});

			const statelessServer = new McpServer({
				name: "Figma Console MCP",
				version: "1.40.8",
			});
			wrapServerForIdentity(statelessServer);

			// ================================================================
			// Cloud Write Relay — Pairing Tool (stateless /mcp path)
			// Uses KV keyed by bearer token instead of DO storage
			// ================================================================
			statelessServer.tool(
				"figma_pair_plugin",
				"Pair the Figma Desktop Bridge plugin to this cloud session for write access. Returns a 6-character code the user enters in the plugin's Cloud Mode section.",
				{},
				async () => {
					try {
						const code = generatePairingCode();
						const relayDoId = env.PLUGIN_RELAY.newUniqueId().toString();

						// Store pairing code → relay DO ID in KV (5-min TTL, one-time use)
						await env.OAUTH_TOKENS.put(`pairing:${code}`, relayDoId, {
							expirationTtl: 300,
						});

						// Store relay DO ID keyed by bearer token for session persistence
						await env.OAUTH_TOKENS.put(`relay:${bearerToken}`, relayDoId, {
							expirationTtl: 86400, // 24h — matches typical session length
						});

						return {
							content: [{
								type: "text" as const,
								text: JSON.stringify({
									pairingCode: code,
									expiresIn: "5 minutes",
									instructions: [
										"1. Open the MCP Bridge plugin in Figma Desktop",
										"2. Click the '▶ Cloud Mode' toggle in the plugin UI",
										`3. Enter pairing code: ${code}`,
										"4. Click 'Connect' — the plugin will connect to the cloud relay",
										"5. Once paired, write tools (variables, components, nodes) work through the cloud"
									],
								}, null, 2),
							}],
						};
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						return {
							content: [{ type: "text" as const, text: JSON.stringify({ error: errorMessage }) }],
							isError: true,
						};
					}
				},
			);

			// Cloud Desktop Connector factory (stateless /mcp path)
			const getCloudDesktopConnector = async (): Promise<any> => {
				const relayDoId = await env.OAUTH_TOKENS.get(`relay:${bearerToken}`);
				if (!relayDoId) {
					throw new Error('No cloud relay session. Call figma_pair_plugin first to pair the Desktop Bridge plugin.');
				}
				const doId = env.PLUGIN_RELAY.idFromString(relayDoId);
				const stub = env.PLUGIN_RELAY.get(doId);
				const connector = new CloudWebSocketConnector(stub);
				await connector.initialize();
				return connector;
			};

			// Build a getCurrentUrl that resolves from the relay DO's file info
			const getCloudFileUrl = (): string | null => {
				// This is synchronous — we cache the file URL after first relay status check
				return cloudFileUrlCache;
			};
			let cloudFileUrlCache: string | null = null;
			// Relay snapshot for figma_diagnose: null = never paired on this token.
			let relaySnapshot: { connected: boolean; fileName?: string; fileKey?: string | null; currentPage?: string } | null = null;

			// Pre-fetch file info from relay if paired
			try {
				const relayDoId = await env.OAUTH_TOKENS.get(`relay:${bearerToken}`);
				if (relayDoId) {
					const doId = env.PLUGIN_RELAY.idFromString(relayDoId);
					const stub = env.PLUGIN_RELAY.get(doId);
					const statusRes = await stub.fetch('https://relay/relay/status');
					const status = await statusRes.json() as { connected?: boolean; fileInfo?: { fileName?: string; fileKey?: string | null; currentPage?: string } | null };
					relaySnapshot = {
						connected: status.connected === true,
						fileName: status.fileInfo?.fileName,
						fileKey: status.fileInfo?.fileKey ?? null,
						currentPage: status.fileInfo?.currentPage,
					};
					if (status.connected && status.fileInfo?.fileKey) {
						cloudFileUrlCache = `https://www.figma.com/design/${status.fileInfo.fileKey}`;
					}
				}
			} catch {
				// No relay session or not paired — cloudFileUrlCache stays null
			}

			// Register all write/manipulation tools via shared function
			registerWriteTools(statelessServer, getCloudDesktopConnector);
			registerTokensTools(statelessServer, getCloudDesktopConnector, { isRemoteMode: true });

			// Register FigJam-specific tools
			registerFigJamTools(statelessServer, getCloudDesktopConnector);

			// Register Annotation tools
			registerAnnotationTools(statelessServer, getCloudDesktopConnector);

			// Register Deep Component tools
			registerDeepComponentTools(statelessServer, getCloudDesktopConnector);

			// Register Figma Slides tools
			registerSlidesTools(statelessServer, getCloudDesktopConnector);

			registerSlotTools(statelessServer, getCloudDesktopConnector);

			// Register REST API tools with the authenticated Figma API
			registerFigmaAPITools(
				statelessServer,
				async () => statelessApi,
				getCloudFileUrl,
				new Map(),  // Fresh variables cache per request
				{ isRemoteMode: true },
				getCloudDesktopConnector,
			);

			registerDesignCodeTools(
				statelessServer,
				async () => statelessApi,
				getCloudFileUrl,
				new Map(), // Fresh variables cache per request
				{ isRemoteMode: true },
				getCloudDesktopConnector,
			);

			registerCommentTools(
				statelessServer,
				async () => statelessApi,
				getCloudFileUrl,
			);

			registerVersionTools(
				statelessServer,
				async () => statelessApi,
				getCloudFileUrl,
			);

			registerDesignSystemTools(
				statelessServer,
				async () => statelessApi,
				getCloudFileUrl,
				new Map(), // Fresh variables cache per request
				{ isRemoteMode: true },
				getCloudDesktopConnector, // bridge-first variable resolution (works on any plan)
			);

			registerLibraryTools(statelessServer, async () => statelessApi);

			registerLibraryVariableTools(statelessServer, getCloudDesktopConnector);

			// Parity with /sse. (figma_scan_code_accessibility stays Local-only:
			// JSDOM does not run in Workers — see the note in FigmaConsoleMCPv3.)
			registerDiagnoseTool(statelessServer, {
				mode: "cloud",
				getServerVersion: () => cloudBuild.version,
				getPluginState: () => relaySnapshot,
				// This request already passed PAT / OAuth validation above.
				getTokenState: () => ({ hasToken: true, source: isFigmaPAT(bearerToken) ? "bearer" : "oauth" }),
			});

			await statelessServer.connect(transport);
			const response = await transport.handleRequest(request);

			if (response) {
				return response;
			}
			return new Response("No response from MCP transport", { status: 500 });
		}

		// ============================================================
		// MCP OAuth 2.1 Spec-Compliant Endpoints
		// These endpoints follow the MCP Authorization specification
		// for compatibility with mcp-remote and Claude Code
		// ============================================================

		// Protected Resource Metadata (RFC9728)
		// Required by MCP spec for OAuth discovery - tells clients where to find authorization server
		if (url.pathname === "/.well-known/oauth-protected-resource" ||
			url.pathname.startsWith("/.well-known/oauth-protected-resource/")) {
			const metadata = {
				resource: url.origin,
				authorization_servers: [`${url.origin}/`],
				scopes_supported: ["file_content:read", "file_versions:read", "file_variables:read", "file_comments:read", "file_comments:write", "library_content:read"],
				bearer_methods_supported: ["header"],
				resource_signing_alg_values_supported: ["RS256"]
			};
			return new Response(JSON.stringify(metadata, null, 2), {
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": "public, max-age=3600"
				}
			});
		}

		// OAuth 2.0 Authorization Server Metadata (RFC8414)
		// Required by MCP spec for client discovery
		if (url.pathname === "/.well-known/oauth-authorization-server") {
			const metadata = {
				issuer: url.origin,
				authorization_endpoint: `${url.origin}/authorize`,
				token_endpoint: `${url.origin}/token`,
				registration_endpoint: `${url.origin}/oauth/register`,
				scopes_supported: ["file_content:read", "file_versions:read", "file_variables:read", "file_comments:read", "file_comments:write", "library_content:read"],
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
				code_challenge_methods_supported: ["S256"],
				service_documentation: "https://docs.figma-console-mcp.southleft.com",
			};
			return new Response(JSON.stringify(metadata, null, 2), {
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": "public, max-age=3600"
				}
			});
		}

		// MCP-compliant /authorize endpoint
		// Handles authorization requests from MCP clients
		if (url.pathname === "/authorize") {
			const clientId = url.searchParams.get("client_id");
			const redirectUri = url.searchParams.get("redirect_uri");
			const state = url.searchParams.get("state");
			const codeChallenge = url.searchParams.get("code_challenge");
			const codeChallengeMethod = url.searchParams.get("code_challenge_method");
			const scope = url.searchParams.get("scope");

			// For MCP clients, use the client_id as the session identifier
			// This allows token retrieval after the OAuth flow completes
			const sessionId = clientId || FigmaConsoleMCPv3.generateStateToken();

			// Store the MCP client's redirect_uri and state for the callback
			if (redirectUri && state) {
				const mcpAuthData = {
					redirectUri,
					state,
					codeChallenge,
					codeChallengeMethod,
					scope,
					clientId,
					sessionId
				};
				// Store with 10 minute expiration
				const mcpStateKey = `mcp_auth:${sessionId}`;
				await env.OAUTH_STATE.put(mcpStateKey, JSON.stringify(mcpAuthData), {
					expirationTtl: 600
				});
			}

			// Check if OAuth credentials are configured
			if (!env.FIGMA_OAUTH_CLIENT_ID) {
				return new Response(
					JSON.stringify({
						error: "server_error",
						error_description: "OAuth not configured on server"
					}),
					{
						status: 500,
						headers: { "Content-Type": "application/json" }
					}
				);
			}

			// Generate CSRF protection token
			const stateToken = FigmaConsoleMCPv3.generateStateToken();

			// Store state token with sessionId (10 minute expiration)
			await env.OAUTH_STATE.put(stateToken, sessionId, {
				expirationTtl: 600
			});

			// Redirect to Figma OAuth
			const figmaAuthUrl = new URL("https://www.figma.com/oauth");
			figmaAuthUrl.searchParams.set("client_id", env.FIGMA_OAUTH_CLIENT_ID);
			figmaAuthUrl.searchParams.set("redirect_uri", `${oauthOrigin}/oauth/callback`);
			figmaAuthUrl.searchParams.set("scope", "file_content:read,file_versions:read,file_variables:read,file_comments:read,file_comments:write,library_content:read");
			figmaAuthUrl.searchParams.set("state", stateToken);
			figmaAuthUrl.searchParams.set("response_type", "code");

			return Response.redirect(figmaAuthUrl.toString(), 302);
		}

		// MCP-compliant /token endpoint
		// Handles token exchange and refresh requests
		if (url.pathname === "/token" && request.method === "POST") {
			const contentType = request.headers.get("content-type") || "";
			let params: URLSearchParams;

			if (contentType.includes("application/x-www-form-urlencoded")) {
				params = new URLSearchParams(await request.text());
			} else if (contentType.includes("application/json")) {
				const body = await request.json() as Record<string, string>;
				params = new URLSearchParams(body);
			} else {
				params = new URLSearchParams(await request.text());
			}

			const grantType = params.get("grant_type");
			const clientId = params.get("client_id");
			const code = params.get("code");
			const refreshToken = params.get("refresh_token");

			// For authorization_code grant, exchange the code for tokens
			if (grantType === "authorization_code" && code) {
				// The code here is actually our session-based token
				// Look up the stored token by session/client ID
				const sessionId = clientId || code;
				const tokenKey = `oauth_token:${sessionId}`;

				logger.info({ grantType, clientId, code, sessionId, tokenKey }, "Token exchange request");

				const tokenJson = await env.OAUTH_TOKENS.get(tokenKey);

				logger.info({ tokenKey, hasToken: !!tokenJson }, "Token lookup result");

				if (tokenJson) {
					const tokenData = JSON.parse(tokenJson) as {
						accessToken: string;
						refreshToken?: string;
						expiresAt: number;
					};

					// Return tokens in OAuth 2.0 format
					return new Response(JSON.stringify({
						access_token: tokenData.accessToken,
						token_type: "Bearer",
						expires_in: Math.max(0, Math.floor((tokenData.expiresAt - Date.now()) / 1000)),
						refresh_token: tokenData.refreshToken,
						scope: "file_content:read file_versions:read file_variables:read file_comments:read file_comments:write library_content:read"
					}), {
						headers: {
							"Content-Type": "application/json",
							"Cache-Control": "no-store"
						}
					});
				}

				logger.error({ tokenKey, sessionId, clientId, code }, "Token not found for exchange");
				return new Response(JSON.stringify({
					error: "invalid_grant",
					error_description: "Authorization code not found or expired. Please re-authenticate."
				}), {
					status: 400,
					headers: { "Content-Type": "application/json" }
				});
			}

			// For refresh_token grant
			if (grantType === "refresh_token" && refreshToken) {
				if (!env.FIGMA_OAUTH_CLIENT_ID || !env.FIGMA_OAUTH_CLIENT_SECRET) {
					return new Response(JSON.stringify({
						error: "server_error",
						error_description: "OAuth not configured"
					}), {
						status: 500,
						headers: { "Content-Type": "application/json" }
					});
				}

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
					return new Response(JSON.stringify({
						error: "invalid_grant",
						error_description: "Failed to refresh token"
					}), {
						status: 400,
						headers: { "Content-Type": "application/json" }
					});
				}

				const tokenData = await tokenResponse.json() as {
					access_token: string;
					refresh_token?: string;
					expires_in: number;
				};

				// Store the refreshed token
				if (clientId) {
					const tokenKey = `oauth_token:${clientId}`;
					const expiresAt = Date.now() + (tokenData.expires_in * 1000);
					const storedToken = {
						accessToken: tokenData.access_token,
						refreshToken: tokenData.refresh_token || refreshToken,
						expiresAt
					};
					await env.OAUTH_TOKENS.put(tokenKey, JSON.stringify(storedToken), {
						expirationTtl: tokenData.expires_in
					});

					// Store reverse lookup for Bearer token validation on SSE endpoint
					const bearerKey = `bearer_token:${tokenData.access_token}`;
					await env.OAUTH_TOKENS.put(bearerKey, JSON.stringify({
						sessionId: clientId,
						expiresAt
					}), {
						expirationTtl: tokenData.expires_in
					});
				}

				return new Response(JSON.stringify({
					access_token: tokenData.access_token,
					token_type: "Bearer",
					expires_in: tokenData.expires_in,
					refresh_token: tokenData.refresh_token || refreshToken,
					scope: "file_content:read file_versions:read file_variables:read file_comments:read file_comments:write library_content:read"
				}), {
					headers: {
						"Content-Type": "application/json",
						"Cache-Control": "no-store"
					}
				});
			}

			return new Response(JSON.stringify({
				error: "unsupported_grant_type",
				error_description: "Only authorization_code and refresh_token grants are supported"
			}), {
				status: 400,
				headers: { "Content-Type": "application/json" }
			});
		}

		// Dynamic Client Registration (RFC7591)
		// Required by MCP spec for clients to register
		if (url.pathname === "/oauth/register" && request.method === "POST") {
			const body = await request.json() as {
				client_name?: string;
				redirect_uris?: string[];
			};

			// Generate a client ID for this registration
			const clientId = `mcp_${FigmaConsoleMCPv3.generateStateToken().substring(0, 16)}`;

			// Store client registration (30 day expiration)
			await env.OAUTH_STATE.put(`client:${clientId}`, JSON.stringify({
				client_name: body.client_name || "MCP Client",
				redirect_uris: body.redirect_uris || [],
				created_at: Date.now()
			}), {
				expirationTtl: 30 * 24 * 60 * 60
			});

			return new Response(JSON.stringify({
				client_id: clientId,
				client_name: body.client_name || "MCP Client",
				redirect_uris: body.redirect_uris || [],
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"]
			}), {
				status: 201,
				headers: { "Content-Type": "application/json" }
			});
		}

		// ============================================================
		// Original Figma OAuth Endpoints (kept for backwards compatibility)
		// ============================================================

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

			const redirectUri = `${oauthOrigin}/oauth/callback`;

			const figmaAuthUrl = new URL("https://www.figma.com/oauth");
			figmaAuthUrl.searchParams.set("client_id", env.FIGMA_OAUTH_CLIENT_ID);
			figmaAuthUrl.searchParams.set("redirect_uri", redirectUri);
			figmaAuthUrl.searchParams.set("scope", "file_content:read,file_versions:read,file_variables:read,file_comments:read,file_comments:write,library_content:read");
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

			logger.info({ stateToken, sessionId, hasSessionId: !!sessionId }, "OAuth callback - state token lookup");

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
					redirect_uri: `${oauthOrigin}/oauth/callback`,
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
					hasTokens: !!accessToken && !!refreshToken,
					expiresIn
				}, "Token exchange successful");

				// IMPORTANT: Use KV storage for tokens since Durable Object storage is instance-specific
				// Store token in Workers KV so it's accessible across all Durable Object instances
				const tokenKey = `oauth_token:${sessionId}`;
				const tokenExpiresAt = Date.now() + (expiresIn * 1000);
				const storedToken = {
					accessToken,
					refreshToken,
					expiresAt: tokenExpiresAt
				};

				// Store in KV with 90-day expiration (matching token lifetime)
				await env.OAUTH_TOKENS.put(tokenKey, JSON.stringify(storedToken), {
					expirationTtl: expiresIn
				});

				// CRITICAL: Also store under the fixed session ID that Durable Objects use
				// This ensures getFigmaAPI() can retrieve the token regardless of which
				// session ID was used during OAuth (e.g., mcp-remote's client_id)
				const fixedTokenKey = `oauth_token:figma-console-mcp-default-session`;
				if (tokenKey !== fixedTokenKey) {
					await env.OAUTH_TOKENS.put(fixedTokenKey, JSON.stringify(storedToken), {
						expirationTtl: expiresIn
					});
					logger.info({ fixedTokenKey }, "Token also stored under fixed session ID for Durable Object access");
				}

				// Store reverse lookup for Bearer token validation on SSE endpoint
				// This allows us to validate Authorization: Bearer <token> headers
				const bearerKey = `bearer_token:${accessToken}`;
				await env.OAUTH_TOKENS.put(bearerKey, JSON.stringify({
					sessionId,
					expiresAt: tokenExpiresAt
				}), {
					expirationTtl: expiresIn
				});

				// Verify the token was stored
				const verifyToken = await env.OAUTH_TOKENS.get(tokenKey);
				logger.info({ sessionId, tokenKey, storedSuccessfully: !!verifyToken }, "Token stored in KV");

				// Check if this flow came from an MCP client (like mcp-remote)
				// If so, we need to redirect back to the client with an authorization code
				const mcpStateKey = `mcp_auth:${sessionId}`;
				const mcpAuthJson = await env.OAUTH_STATE.get(mcpStateKey);

				if (mcpAuthJson) {
					// MCP client flow - redirect back with authorization code
					const mcpAuthData = JSON.parse(mcpAuthJson) as {
						redirectUri: string;
						state: string;
						codeChallenge?: string;
						codeChallengeMethod?: string;
						scope?: string;
						clientId?: string;
						sessionId: string;
					};

					// Clean up the MCP auth state
					await env.OAUTH_STATE.delete(mcpStateKey);

					// Generate an authorization code for the MCP client
					// We use the sessionId as the code since we've already stored the token
					const authCode = sessionId;

					// Build the redirect URL back to the MCP client
					const redirectUrl = new URL(mcpAuthData.redirectUri);
					redirectUrl.searchParams.set("code", authCode);
					redirectUrl.searchParams.set("state", mcpAuthData.state);

					logger.info({
						sessionId,
						redirectUri: mcpAuthData.redirectUri,
						state: mcpAuthData.state
					}, "Redirecting back to MCP client");

					return Response.redirect(redirectUrl.toString(), 302);
				}

				// Direct browser flow - show success page
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
					version: "1.40.8",
					endpoints: {
						mcp: ["/sse", "/mcp"],
						oauth_mcp_spec: ["/.well-known/oauth-authorization-server", "/authorize", "/token", "/oauth/register"],
						oauth_legacy: ["/oauth/authorize", "/oauth/callback"],
						utility: ["/health"]
					},
					oauth_configured: !!env.FIGMA_OAUTH_CLIENT_ID
				}),
				{
					headers: { "Content-Type": "application/json" },
				},
			);
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

	// Root path - serve the landing page (editorial layout, light/dark themes).
	// `version` below is kept current by scripts/release.sh (it rewrites every
	// `version: "x.y.z"` in this file). Tool counts in the copy are tracked by
	// scripts/update-tool-counts.mjs (meta descriptions, the class="number"
	// Local count and the data-mode="cloud" Cloud count). Remote has no count:
	// it is the same hosted endpoint before pairing, so it is described, not counted.
	if (url.pathname === "/") {
		const landing = { version: "1.40.8" };
		return new Response(
			`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Figma Console MCP: a design-system MCP server for Figma and code</title>
	<link rel="icon" type="image/svg+xml" href="https://docs.figma-console-mcp.southleft.com/favicon.svg">
	<meta name="description" content="An open-source MCP server for design systems. 121+ tools give AI assistants what they need to manage a design system across Figma and code: health and accessibility audits, design-code parity checks, two-way sync, write access to Figma, and generated docs.">

	<!-- Open Graph -->
	<meta property="og:type" content="website">
	<meta property="og:url" content="https://figma-console-mcp.southleft.com">
	<meta property="og:title" content="Figma Console MCP: keep Figma and code on the same design system">
	<meta property="og:description" content="An open-source MCP server for design systems. 121+ tools give AI assistants what they need to manage a design system across Figma and code: health and accessibility audits, design-code parity checks, two-way sync, write access to Figma, and generated docs.">
	<meta property="og:image" content="https://docs.figma-console-mcp.southleft.com/images/og-image.jpg">
	<meta property="og:image:width" content="1200">
	<meta property="og:image:height" content="630">

	<!-- Twitter -->
	<meta name="twitter:card" content="summary_large_image">
	<meta name="twitter:title" content="Figma Console MCP: keep Figma and code on the same design system">
	<meta name="twitter:description" content="An open-source MCP server for design systems. 121+ tools give AI assistants what they need to manage a design system across Figma and code: health and accessibility audits, design-code parity checks, two-way sync, write access to Figma, and generated docs.">
	<meta name="twitter:image" content="https://docs.figma-console-mcp.southleft.com/images/og-image.jpg">

	<meta name="theme-color" content="#0F766E">
	<script>
		// Set the theme before first paint: stored choice, else the system setting.
		(function () {
			var stored = null;
			try { stored = localStorage.getItem('theme'); } catch (e) {}
			var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
			document.documentElement.setAttribute('data-theme', stored === 'light' || stored === 'dark' ? stored : (prefersDark ? 'dark' : 'light'));
		})();
	</script>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<!-- Same typefaces as the Mintlify docs site: Inter for text, Paper Mono (OFL) for code. -->
	<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400..700&display=swap" rel="stylesheet">
	<link rel="preload" href="https://cdn.jsdelivr.net/gh/paper-design/paper-mono@0.320/fonts/webfonts/PaperMono%5Bwght%5D.woff2" as="font" type="font/woff2" crossorigin>
	<style>
		@font-face {
			font-family: "Paper Mono";
			src: url("https://cdn.jsdelivr.net/gh/paper-design/paper-mono@0.320/fonts/webfonts/PaperMono%5Bwght%5D.woff2") format("woff2");
			font-weight: 100 800;
			font-display: swap;
		}

		:root {
			--paper: #F5F7F6;
			--surface: #FFFFFF;
			--surface-2: #EAF0EE;
			--ink: #10201D;
			--muted: #4A5C58;
			--rule: #D6DFDC;
			--rule-strong: #B7C6C2;
			--teal: #0F766E;
			--teal-ink: #FFFFFF;
			--teal-hover: #0B5F58;
			--mark: rgba(15, 118, 110, 0.16);
			--mark-edge: #0F766E;
			--sponsor: #B8327F;
			--focus: #0F766E;
			--code-key: #4A5C58;
			--code-str: #0F5E57;

			--font-display: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
			--font-body: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
			--font-mono: "Paper Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;

			--gutter: clamp(16px, 4vw, 40px);
			--measure: 1200px;
			--radius: 8px;
			color-scheme: light;
		}

		@media (prefers-color-scheme: dark) {
			:root:not([data-theme="light"]) {
				--paper: #0C1413;
				--surface: #121D1B;
				--surface-2: #182624;
				--ink: #E6EFEC;
				--muted: #9AB0AA;
				--rule: #243532;
				--rule-strong: #35504B;
				--teal: #2DD4BF;
				--teal-ink: #04211D;
				--teal-hover: #5EEAD4;
				--mark: rgba(45, 212, 191, 0.18);
				--mark-edge: #2DD4BF;
				--sponsor: #E27AB5;
				--focus: #5EEAD4;
				--code-key: #9AB0AA;
				--code-str: #7FE3D3;
				color-scheme: dark;
			}
		}

		:root[data-theme="dark"] {
			--paper: #0C1413;
			--surface: #121D1B;
			--surface-2: #182624;
			--ink: #E6EFEC;
			--muted: #9AB0AA;
			--rule: #243532;
			--rule-strong: #35504B;
			--teal: #2DD4BF;
			--teal-ink: #04211D;
			--teal-hover: #5EEAD4;
			--mark: rgba(45, 212, 191, 0.18);
			--mark-edge: #2DD4BF;
			--sponsor: #E27AB5;
			--focus: #5EEAD4;
			--code-key: #9AB0AA;
			--code-str: #7FE3D3;
			color-scheme: dark;
		}

		*, *::before, *::after { box-sizing: border-box; }
		* { margin: 0; padding: 0; }

		html { scroll-behavior: smooth; -webkit-text-size-adjust: 100%; }
		@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }

		body {
			font-family: var(--font-body);
			font-size: 17px;
			line-height: 1.6;
			background: var(--paper);
			color: var(--ink);
			min-height: 100vh;
			-webkit-font-smoothing: antialiased;
		}

		a { color: inherit; }
		img { max-width: 100%; }
		code { font-family: var(--font-mono); font-size: 0.88em; }

		:focus-visible {
			outline: 2px solid var(--focus);
			outline-offset: 3px;
			border-radius: 3px;
		}

		.skip-link {
			position: absolute;
			left: var(--gutter);
			top: -60px;
			z-index: 2000;
			padding: 10px 14px;
			background: var(--teal);
			color: var(--teal-ink);
			font-weight: 600;
			text-decoration: none;
			border-radius: var(--radius);
		}
		.skip-link:focus { top: 12px; }

		.wrap {
			max-width: var(--measure);
			margin: 0 auto;
			padding-inline: var(--gutter);
		}

		/* ---------- Header ---------- */
		.site-header {
			position: sticky;
			top: 0;
			z-index: 100;
			background: var(--paper);
			border-bottom: 1px solid var(--rule);
		}
		.site-header .wrap {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 16px;
			padding-block: 14px;
		}
		.logo { display: inline-flex; align-items: center; }
		.logo img { height: 32px; width: auto; display: block; }
		.logo .for-light { display: none; }
		[data-theme="light"] .logo .for-light { display: block; }
		[data-theme="light"] .logo .for-dark { display: none; }

		.header-right { display: flex; align-items: center; gap: 20px; }
		.nav { display: flex; align-items: center; gap: 22px; }
		.nav a, .footer-links a {
			font-size: 15px;
			font-weight: 500;
			color: var(--muted);
			text-decoration: none;
		}
		.nav a:hover, .footer-links a:hover { color: var(--ink); }
		.nav a.sponsor, .footer-links a.sponsor, .mobile-nav a.sponsor {
			color: var(--sponsor);
			display: inline-flex;
			align-items: center;
			gap: 6px;
		}
		.sponsor svg { width: 14px; height: 14px; fill: currentColor; }

		.icon-btn {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 40px;
			height: 40px;
			background: transparent;
			border: 1px solid var(--rule-strong);
			border-radius: var(--radius);
			color: var(--ink);
			cursor: pointer;
		}
		.icon-btn:hover { background: var(--surface-2); }
		.icon-btn svg { width: 18px; height: 18px; }
		.theme-toggle .sun { display: none; }
		[data-theme="dark"] .theme-toggle .sun { display: block; }
		[data-theme="dark"] .theme-toggle .moon { display: none; }
		.menu-btn { display: none; }

		/* ---------- Mobile menu ---------- */
		.mobile-menu {
			position: fixed;
			inset: 0;
			z-index: 1000;
			background: var(--paper);
			padding: 16px var(--gutter);
			display: flex;
			flex-direction: column;
		}
		.mobile-menu-head {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 32px;
		}
		.mobile-nav { display: flex; flex-direction: column; }
		.mobile-nav a {
			padding: 16px 0;
			font-size: 19px;
			font-weight: 500;
			text-decoration: none;
			border-bottom: 1px solid var(--rule);
		}
		.mobile-menu[hidden] { display: none; }
		body.menu-open { overflow: hidden; }

		/* ---------- Shared type ---------- */
		h1, h2, h3 { font-family: var(--font-display); font-weight: 600; letter-spacing: -0.025em; }
		h2 {
			font-size: clamp(30px, 4.2vw, 44px);
			line-height: 1.08;
			margin-bottom: 14px;
		}
		.section-intro { color: var(--muted); max-width: 60ch; }
		.section { padding-block: clamp(56px, 9vw, 104px); border-top: 1px solid var(--rule); }
		.section-head { margin-bottom: clamp(28px, 5vw, 48px); }

		/* ---------- Buttons ---------- */
		.btn-row { display: flex; flex-wrap: wrap; gap: 12px; }
		.btn {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 8px;
			min-height: 46px;
			padding: 11px 20px;
			border-radius: var(--radius);
			font-size: 16px;
			font-weight: 600;
			text-decoration: none;
			border: 1px solid transparent;
		}
		.btn svg { width: 17px; height: 17px; flex-shrink: 0; }
		.btn-primary { background: var(--teal); color: var(--teal-ink); }
		.btn-primary:hover { background: var(--teal-hover); }
		.btn-quiet { border-color: var(--rule-strong); color: var(--ink); background: transparent; }
		.btn-quiet:hover { background: var(--surface-2); }

		/* ---------- Hero ---------- */
		.hero { padding-block: clamp(40px, 6vw, 72px) clamp(48px, 7vw, 80px); }
		.hero h1 {
			font-size: clamp(40px, 6.6vw, 84px);
			line-height: 1.02;
			letter-spacing: -0.035em;
			max-width: 20ch;
			text-wrap: balance;
			margin-bottom: clamp(20px, 3vw, 28px);
		}
		.hero-lede {
			font-size: clamp(18px, 1.9vw, 21px);
			line-height: 1.55;
			color: var(--muted);
			max-width: 62ch;
			margin-bottom: 32px;
		}
		.hero-lede strong { color: var(--ink); font-weight: 600; }

		/* Round-trip specimen: the one loud element on the page */
		.roundtrip { margin-top: clamp(48px, 7vw, 72px); }
		.rt-grid {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(150px, auto) minmax(0, 1.25fr);
			align-items: center;
			gap: 0;
		}
		.rt-panel {
			background: var(--surface);
			border: 1px solid var(--rule-strong);
			border-radius: 12px;
			overflow: hidden;
			min-width: 0;
		}
		.rt-head {
			display: flex;
			justify-content: space-between;
			align-items: baseline;
			gap: 12px;
			padding: 12px 16px;
			border-bottom: 1px solid var(--rule);
			font-size: 14px;
			color: var(--muted);
		}
		.rt-head strong { color: var(--ink); font-weight: 600; }
		.rt-body { padding: 18px 16px 20px; }
		.rt-name {
			display: flex;
			align-items: center;
			gap: 12px;
			margin-bottom: 16px;
		}
		.rt-name code { font-size: 16px; font-weight: 500; color: var(--ink); word-break: break-all; }
		.swatch {
			width: 28px;
			height: 28px;
			border-radius: 6px;
			background: var(--sw);
			box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
			flex-shrink: 0;
		}
		.swatch.sm { width: 16px; height: 16px; border-radius: 4px; }
		.rt-modes { width: 100%; border-collapse: collapse; font-size: 15px; margin-bottom: 16px; }
		.rt-modes th, .rt-modes td { text-align: left; padding: 9px 0; border-top: 1px solid var(--rule); font-weight: 400; }
		.rt-modes th { color: var(--muted); width: 42%; }
		.rt-modes td { display: flex; align-items: center; gap: 10px; }
		.rt-modes td code { font-size: 14px; }
		.rt-id { font-size: 14px; color: var(--muted); }
		.id-mark {
			font-family: var(--font-mono);
			font-size: 13.5px;
			color: var(--ink);
			background: var(--mark);
			box-shadow: inset 0 -2px 0 var(--mark-edge);
			padding: 2px 4px;
			border-radius: 3px;
		}

		.rt-code pre {
			margin: 0;
			padding: 18px 16px 20px;
			font-family: var(--font-mono);
			font-size: 13.5px;
			line-height: 1.65;
			color: var(--ink);
			overflow-x: auto;
			tab-size: 2;
		}
		.rt-code pre .k { color: var(--code-key); }
		.rt-code pre .s { color: var(--code-str); }
		.rt-code pre .id-mark { font-size: inherit; color: var(--ink); }

		.rt-link {
			display: flex;
			flex-direction: column;
			justify-content: center;
			gap: 18px;
			padding: 16px 22px;
			list-style: none;
		}
		.rt-link li { display: flex; flex-direction: column; gap: 4px; }
		.rt-link code { font-size: 12.5px; color: var(--ink); }
		.rt-link .dir { font-size: 13px; color: var(--muted); }
		.rt-arrow { display: block; width: 100%; height: 14px; color: var(--teal); }
		.rt-arrow.back { transform: scaleX(-1); }
		.rt-glyph { display: none; }
		.roundtrip figcaption {
			margin-top: 16px;
			font-size: 15px;
			color: var(--muted);
			max-width: 70ch;
		}

		/* One orchestrated moment: the shared ID lights up in both panels once on load */
		@media (prefers-reduced-motion: no-preference) {
			.roundtrip .id-mark { animation: mark-in 700ms ease-out 500ms both; }
			.roundtrip .rt-arrow path { stroke-dasharray: 120; animation: draw 700ms ease-out 200ms both; }
			@keyframes mark-in {
				from { background: transparent; box-shadow: inset 0 0 0 var(--mark-edge); }
			}
			@keyframes draw { from { stroke-dashoffset: 120; } to { stroke-dashoffset: 0; } }
		}

		/* ---------- Pillars ---------- */
		.pillars { list-style: none; border-bottom: 1px solid var(--rule); }
		.pillar {
			display: grid;
			grid-template-columns: minmax(0, 3.2fr) minmax(0, 4.6fr) minmax(0, 4.2fr);
			gap: clamp(20px, 3vw, 40px);
			padding-block: clamp(28px, 4vw, 40px);
			border-top: 1px solid var(--rule);
		}
		.pillar h3 {
			font-size: clamp(26px, 3vw, 34px);
			line-height: 1.1;
			margin-bottom: 8px;
		}
		.pillar .claim { font-size: 18px; color: var(--teal); font-weight: 500; line-height: 1.4; }
		[data-theme="light"] .pillar .claim { color: var(--teal); }
		.pillar-body p { color: var(--ink); max-width: 58ch; }
		.pillar-body p + p { margin-top: 12px; }
		.pillar-body .muted { color: var(--muted); }
		.facts { list-style: none; font-size: 15px; }
		.facts-label { font-size: 14px; color: var(--muted); margin-bottom: 8px; }
		.facts li { padding-block: 5px; border-top: 1px solid var(--rule); }
		.facts li:first-child { border-top: 0; padding-top: 0; }
		.facts code { font-size: 13.5px; overflow-wrap: anywhere; }
		.facts .group { display: block; font-size: 14px; color: var(--muted); }
		.formats { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; margin-top: 16px; }
		.formats li {
			font-size: 14px;
			padding: 3px 10px;
			border: 1px solid var(--rule-strong);
			border-radius: 999px;
			color: var(--ink);
		}

		/* ---------- Hero: eyebrow, trust line, example session ---------- */
		.eyebrow {
			display: inline-block;
			font-size: 15px;
			font-weight: 600;
			color: var(--teal);
			margin-bottom: 18px;
		}
		.trust {
			display: flex;
			flex-wrap: wrap;
			gap: 8px 22px;
			list-style: none;
			margin-top: 22px;
			font-size: 15px;
			color: var(--muted);
		}
		.trust li { display: inline-flex; align-items: center; gap: 8px; }
		.trust li::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--teal); }

		.session { margin-top: clamp(40px, 6vw, 64px); }
		.art-panel {
			background: var(--surface);
			border: 1px solid var(--rule-strong);
			border-radius: 12px;
			overflow: hidden;
			min-width: 0;
		}
		.session-ask {
			display: flex;
			gap: 14px;
			align-items: baseline;
			padding: 18px 20px;
			border-bottom: 1px solid var(--rule);
			font-size: clamp(17px, 1.8vw, 20px);
		}
		.who {
			flex-shrink: 0;
			font-size: 13px;
			font-weight: 600;
			color: var(--teal-ink);
			background: var(--teal);
			padding: 2px 8px;
			border-radius: 999px;
		}
		.session-runs { list-style: none; }
		.session-runs li {
			display: grid;
			grid-template-columns: 20px minmax(0, 20rem) minmax(0, 1fr);
			gap: 4px 16px;
			align-items: baseline;
			padding: 12px 20px;
			border-top: 1px solid var(--rule);
			font-size: 15px;
		}
		.session-runs li:first-child { border-top: 0; }
		.session-runs .tick { color: var(--teal); font-weight: 700; }
		.session-runs code { font-size: 14px; overflow-wrap: anywhere; }
		.session-runs .res { color: var(--muted); }
		.session-runs .res b { color: var(--ink); font-weight: 600; }
		.session figcaption {
			margin-top: 14px;
			font-size: 15px;
			color: var(--muted);
			max-width: 70ch;
		}

		/* ---------- Showcase ---------- */
		.showcase { border-bottom: 1px solid var(--rule); }
		.show {
			display: grid;
			grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
			gap: clamp(24px, 4vw, 56px);
			align-items: center;
			padding-block: clamp(36px, 5vw, 56px);
			border-top: 1px solid var(--rule);
		}
		.show:nth-child(even) .show-text { order: 2; }
		.show.wide { grid-template-columns: minmax(0, 1fr); }
		.show.wide .show-text { order: 0; max-width: 64ch; }
		.show h3 { font-size: clamp(24px, 2.8vw, 32px); line-height: 1.12; margin-bottom: 12px; }
		.show-kicker { font-size: 14px; font-weight: 600; color: var(--teal); margin-bottom: 8px; }
		.show-text p { max-width: 52ch; }
		.show-text p + p { margin-top: 12px; }
		.show-tool code { font-size: 14px; color: var(--muted); }
		.show figure { margin: 0; min-width: 0; }
		.show .roundtrip { margin-top: 0; }

		.score-body { padding: 20px; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 20px 28px; align-items: start; }
		.score-total { display: flex; align-items: baseline; gap: 2px; line-height: 1; }
		.score-total .big { font-size: 64px; font-weight: 600; letter-spacing: -0.04em; color: var(--teal); }
		.score-total .of { color: var(--muted); font-size: 16px; }
		.bars { list-style: none; font-size: 14px; }
		.bars li { display: grid; grid-template-columns: minmax(0, 11rem) minmax(0, 1fr) 2.2em; gap: 12px; align-items: center; padding-block: 5px; }
		.bar { height: 8px; border-radius: 999px; background: var(--surface-2); position: relative; overflow: hidden; }
		.bar::after { content: ""; position: absolute; inset: 0 auto 0 0; width: calc(var(--v) * 1%); background: var(--teal); border-radius: 999px; }
		.bar-num { text-align: right; font-variant-numeric: tabular-nums; }
		.score-fix { grid-column: 1 / -1; font-size: 14px; color: var(--muted); padding-top: 14px; border-top: 1px solid var(--rule); }
		.score-fix strong { color: var(--ink); }

		.parity-sum { padding: 14px 20px; font-size: 15px; color: var(--muted); border-bottom: 1px solid var(--rule); }
		.parity-sum b { color: var(--ink); font-weight: 600; }
		.table-scroll { overflow-x: auto; }
		.parity { width: 100%; border-collapse: collapse; font-size: 14px; }
		.parity th, .parity td { text-align: left; padding: 10px 20px 10px 0; border-top: 1px solid var(--rule); white-space: nowrap; }
		.parity th:first-child, .parity td:first-child { padding-left: 20px; }
		.parity thead th { border-top: 0; color: var(--muted); font-weight: 500; }
		.parity code { font-size: 13px; }
		.sev { display: inline-block; font-size: 12px; font-weight: 600; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--rule-strong); }
		.sev.major { color: var(--sponsor); border-color: currentColor; }

		.doc pre {
			margin: 0;
			padding: 18px 20px 20px;
			font-family: var(--font-mono);
			font-size: 13px;
			line-height: 1.7;
			color: var(--ink);
			overflow-x: auto;
		}
		.doc pre .h { color: var(--teal); font-weight: 600; }
		.doc pre .m { color: var(--muted); }

		/* ---------- Prompts ---------- */
		.prompts { list-style: none; border-bottom: 1px solid var(--rule); }
		.prompt {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 20rem);
			gap: 8px 32px;
			align-items: baseline;
			padding-block: 20px;
			border-top: 1px solid var(--rule);
		}
		.prompt q {
			font-size: clamp(19px, 2.1vw, 23px);
			line-height: 1.35;
		}
		.prompt .runs { font-size: 14px; color: var(--muted); }
		.prompt .runs code { font-size: 14px; color: var(--ink); word-break: break-word; }

		/* ---------- Modes ---------- */
		.modes {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			border-top: 1px solid var(--rule);
			border-bottom: 1px solid var(--rule);
		}
		.mode { padding: 28px 28px 32px 0; }
		.mode + .mode { padding-left: 28px; border-left: 1px solid var(--rule); }
		.mode h3 { font-size: 26px; margin-bottom: 4px; }
		.mode .count { display: flex; align-items: baseline; gap: 8px; margin-bottom: 14px; }
		.mode .count > span:first-child {
			font-family: var(--font-display);
			font-weight: 600;
			font-size: clamp(44px, 5.4vw, 64px);
			line-height: 1;
			color: var(--teal);
		}
		.mode .count .unit { color: var(--muted); font-size: 16px; }
		.mode p { color: var(--muted); font-size: 16px; max-width: 36ch; }
		.mode p strong { color: var(--ink); font-weight: 600; }

		/* ---------- Start + announcement ---------- */
		.start {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 24px 48px;
			align-items: end;
		}
		.start p { color: var(--muted); max-width: 56ch; }
		.announce {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 16px;
			margin-top: clamp(40px, 6vw, 64px);
			padding: 20px 22px;
			border: 1px solid var(--rule-strong);
			border-radius: 12px;
			background: var(--surface);
			text-decoration: none;
		}
		.announce:hover { border-color: var(--teal); }
		.announce-text { display: flex; align-items: center; gap: 16px; }
		.announce-icon {
			width: 44px;
			height: 44px;
			flex-shrink: 0;
			display: flex;
			align-items: center;
			justify-content: center;
			border-radius: 10px;
			background: var(--mark);
			color: var(--teal);
		}
		.announce-icon svg { width: 22px; height: 22px; }
		.announce h2 { font-family: var(--font-body); font-size: 17px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 2px; }
		.announce p { font-size: 15px; color: var(--muted); }
		.announce .go { font-size: 15px; font-weight: 600; color: var(--teal); white-space: nowrap; }

		/* ---------- Footer ---------- */
		.site-footer { border-top: 1px solid var(--rule); }
		.site-footer .wrap {
			display: flex;
			justify-content: space-between;
			align-items: center;
			flex-wrap: wrap;
			gap: 16px 32px;
			padding-block: 28px;
			font-size: 15px;
			color: var(--muted);
		}
		.site-footer p a { color: var(--ink); }
		.footer-links { display: flex; flex-wrap: wrap; gap: 20px; }

		/* ---------- Responsive ---------- */
		@media (max-width: 1020px) {
			.rt-grid { grid-template-columns: minmax(0, 1fr); }
			.rt-link {
				flex-direction: row;
				flex-wrap: wrap;
				justify-content: flex-start;
				gap: 8px 28px;
				padding: 14px 4px;
			}
			.rt-link li { flex-direction: row; align-items: center; gap: 10px; }
			.rt-link .dir { order: 2; }
			.rt-link code { order: 3; }
			.rt-arrow { display: none; }
			.rt-glyph { display: inline-block; order: 1; width: 1.2em; text-align: center; font-size: 20px; line-height: 1; color: var(--teal); }
			.pillar { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
			.pillar-head { grid-column: 1 / -1; }
		}

		@media (max-width: 800px) {
			.nav { display: none; }
			.menu-btn { display: inline-flex; }
			.header-right { gap: 10px; }
			.pillar { grid-template-columns: minmax(0, 1fr); }
			.prompt { grid-template-columns: minmax(0, 1fr); }
			.modes { grid-template-columns: minmax(0, 1fr); }
			.mode, .mode + .mode { padding: 24px 0; border-left: 0; }
			.mode + .mode { border-top: 1px solid var(--rule); }
			.show, .show.wide { grid-template-columns: minmax(0, 1fr); }
			.show:nth-child(even) .show-text { order: 0; }
			.session-runs li { grid-template-columns: 20px minmax(0, 1fr); }
			.session-runs .res { grid-column: 2; }
			.score-body { grid-template-columns: minmax(0, 1fr); }
			.bars li { grid-template-columns: minmax(0, 9rem) minmax(0, 1fr) 2.2em; }
			.start { grid-template-columns: minmax(0, 1fr); align-items: start; }
			.announce { flex-direction: column; align-items: flex-start; }
		}

		@media (max-width: 480px) {
			body { font-size: 16px; }
			.btn-row .btn { flex: 1 1 100%; }
			.logo img { height: 28px; }
			.rt-code pre { font-size: 12.5px; }
			.session-runs li { padding-inline: 16px; }
			.session-runs code { font-size: 12.5px; overflow-wrap: normal; }
			.bars li { grid-template-columns: minmax(0, 8.5rem) minmax(0, 1fr) 2.2em; gap: 10px; }
		}
	</style>
</head>
<body>
	<a class="skip-link" href="#main">Skip to content</a>

	<header class="site-header">
		<div class="wrap">
			<a href="/" class="logo" aria-label="Figma Console MCP home">
				<img src="https://docs.figma-console-mcp.southleft.com/logo/light.svg" alt="Figma Console MCP" class="for-dark" width="180" height="32">
				<img src="https://docs.figma-console-mcp.southleft.com/logo/dark.svg" alt="Figma Console MCP" class="for-light" width="180" height="32">
			</a>
			<div class="header-right">
				<nav class="nav" aria-label="Primary">
					<a href="https://docs.figma-console-mcp.southleft.com">Docs</a>
					<a href="https://github.com/southleft/figma-console-mcp">GitHub</a>
					<a href="https://www.npmjs.com/package/figma-console-mcp">npm</a>
					<a href="https://southleft.com/insights/ai/figma-console-mcp-ai-powered-design-system-management/">Blog</a>
					<a href="https://github.com/sponsors/southleft" class="sponsor"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.25 2.5c-1.336 0-2.75 1.164-2.75 3 0 2.15 1.58 4.144 3.365 5.682A20.6 20.6 0 0 0 8 13.393a20.6 20.6 0 0 0 3.135-2.211C12.92 9.644 14.5 7.65 14.5 5.5c0-1.836-1.414-3-2.75-3-1.373 0-2.609.986-3.029 2.456a.749.749 0 0 1-1.442 0C6.859 3.486 5.623 2.5 4.25 2.5"/></svg>Sponsor</a>
				</nav>
				<button type="button" class="icon-btn theme-toggle" aria-label="Switch color theme">
					<svg class="moon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
					<svg class="sun" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
				</button>
				<button type="button" class="icon-btn menu-btn" aria-label="Open menu" aria-expanded="false" aria-controls="mobileMenu">
					<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
				</button>
			</div>
		</div>
	</header>

	<div class="mobile-menu" id="mobileMenu" role="dialog" aria-modal="true" aria-label="Menu" hidden>
		<div class="mobile-menu-head">
			<a href="/" class="logo" aria-label="Figma Console MCP home">
				<img src="https://docs.figma-console-mcp.southleft.com/logo/light.svg" alt="Figma Console MCP" class="for-dark" width="180" height="32">
				<img src="https://docs.figma-console-mcp.southleft.com/logo/dark.svg" alt="Figma Console MCP" class="for-light" width="180" height="32">
			</a>
			<button type="button" class="icon-btn menu-close" aria-label="Close menu">
				<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 18L18 6M6 6l12 12"/></svg>
			</button>
		</div>
		<nav class="mobile-nav" aria-label="Primary">
			<a href="https://docs.figma-console-mcp.southleft.com">Docs</a>
			<a href="https://github.com/southleft/figma-console-mcp">GitHub</a>
			<a href="https://www.npmjs.com/package/figma-console-mcp">npm</a>
			<a href="https://southleft.com/insights/ai/figma-console-mcp-ai-powered-design-system-management/">Blog</a>
			<a href="https://github.com/sponsors/southleft" class="sponsor">Sponsor</a>
		</nav>
	</div>

	<main id="main">
		<!-- Hero -->
		<section class="hero" aria-labelledby="hero-title">
			<div class="wrap">
				<p class="eyebrow">Design-system management for frontier AI models</p>
				<h1 id="hero-title">Keep Figma and code on the same design system.</h1>
				<p class="hero-lede">Figma Console MCP gives your AI the tools to run a design system across Figma and code. It <strong>audits</strong> the system and <strong>checks components against their code</strong> with results that score the same way every time, <strong>syncs</strong> Figma and code in both directions, <strong>writes</strong> fixes into your files, and <strong>documents</strong> what's there, so the code it writes follows your own stack.</p>
				<div class="btn-row">
					<a href="https://docs.figma-console-mcp.southleft.com" class="btn btn-primary">Read the docs</a>
					<a href="https://docs.figma-console-mcp.southleft.com/setup" class="btn btn-quiet">Setup guide</a>
					<a href="https://github.com/southleft/figma-console-mcp" class="btn btn-quiet">
						<svg fill="currentColor" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
						GitHub
					</a>
				</div>

				<ul class="trust" aria-label="At a glance">
					<li>Open source, MIT</li>
					<li>Any Figma plan</li>
					<li>Any MCP client</li>
				</ul>

				<figure class="session" aria-labelledby="session-caption">
					<div class="art-panel">
						<div class="session-ask"><span class="who">You</span><p>Get the Button component ready for the 3.0 release.</p></div>
						<ol class="session-runs" aria-label="Tools the AI ran">
							<li><span class="tick" aria-hidden="true">&#10003;</span><code>figma_audit_design_system_report</code><span class="res">System health <b>84/100</b> across six categories</span></li>
							<li><span class="tick" aria-hidden="true">&#10003;</span><code>figma_check_design_parity</code><span class="res">Parity with the React component <b>85/100</b>: 1 major, 2 minor, 1 info</span></li>
							<li><span class="tick" aria-hidden="true">&#10003;</span><code>figma_audit_component_accessibility</code><span class="res"><b>No focus variant</b>, and 2 text colors below 4.5:1</span></li>
							<li><span class="tick" aria-hidden="true">&#10003;</span><code>figma_set_description</code><span class="res">Wrote descriptions to <b>3 variants</b> in Figma</span></li>
							<li><span class="tick" aria-hidden="true">&#10003;</span><code>figma_generate_component_doc</code><span class="res"><b>Button.md</b> with tokens per variant, pinned to commit 3f2a91c</span></li>
						</ol>
					</div>
					<figcaption id="session-caption">Example session. One request, five tools from four jobs, and every result is something you can check.</figcaption>
				</figure>
			</div>
		</section>

		<!-- Pillars -->
		<section class="section" aria-labelledby="pillars-title">
			<div class="wrap">
				<div class="section-head">
					<h2 id="pillars-title">What it does</h2>
					<p class="section-intro">Four jobs for teams that maintain a design system in Figma and ship it in code. Every tool is built for managing design systems at scale.</p>
				</div>
				<ul class="pillars">
					<li class="pillar">
						<div class="pillar-head">
							<h3>Deterministic checks</h3>
							<p class="claim">Repeatable scores, not vibes.</p>
						</div>
						<div class="pillar-body">
							<p>Checks run as code against your Figma file and your source, so the same input gives the same result. Compare a component's design to its implementation, audit accessibility on both sides, and measure design-system hygiene.</p>
							<p class="muted">Because the output doesn't drift between runs, you can use it as a review gate or track a component over time.</p>
						</div>
						<div>
							<ul class="facts">
								<li><span class="group">Design-code parity</span><code>figma_check_design_parity</code></li>
								<li><span class="group">Accessibility</span><code>figma_lint_design</code><br><code>figma_audit_component_accessibility</code><br><code>figma_scan_code_accessibility</code></li>
								<li><span class="group">Design-system hygiene</span><code>figma_audit_design_system_report</code><br><code>figma_ds_verify</code></li>
							</ul>
						</div>
					</li>

					<li class="pillar">
						<div class="pillar-head">
							<h3>Bidirectional</h3>
							<p class="claim">Figma to code, and code back to Figma.</p>
						</div>
						<div class="pillar-body">
							<p>Move the system in both directions. Give code the full spec of any component, sync variables and tokens in 10 formats with their Figma IDs intact, and bring changes made in code back into Figma.</p>
							<p class="muted">Starting from code instead? Extract the design system from a production codebase and push it into Figma.</p>
						</div>
						<div>
							<p class="facts-label">Tools</p>
							<ul class="facts">
								<li><code>figma_get_component_for_development</code></li>
								<li><code>figma_export_tokens</code> / <code>figma_import_tokens</code></li>
								<li><code>figma_ds_extract_tokens</code></li>
							</ul>
						</div>
					</li>

					<li class="pillar">
						<div class="pillar-head">
							<h3>Writes to Figma</h3>
							<p class="claim">Changes land in the file, not in a chat reply.</p>
						</div>
						<div class="pillar-body">
							<p>Create and edit variables and collections, components and component sets with variants, slots, and annotations. Build FigJam boards and Slides decks.</p>
							<p class="muted">When no structured tool fits, run Plugin API code directly, in one file or across several open files at once.</p>
						</div>
						<div>
							<p class="facts-label">Tools</p>
							<ul class="facts">
								<li><code>figma_batch_create_variables</code></li>
								<li><code>figma_create_component_set</code></li>
								<li><code>figma_create_slot</code></li>
								<li><code>figma_set_annotations</code></li>
								<li><code>figma_execute_across_files</code></li>
							</ul>
						</div>
					</li>

					<li class="pillar">
						<div class="pillar-head">
							<h3>Unbiased code</h3>
							<p class="claim">Facts about the design, not opinions about your code.</p>
						</div>
						<div class="pillar-body">
							<p>Your AI gets structured, verifiable data: exact tokens, variants, variable bindings, and states, plus component docs generated from the file and pinned to a commit.</p>
							<p class="muted">It isn't handed a framework or a house style, so the code it writes follows your team's stack and conventions.</p>
						</div>
						<div>
							<p class="facts-label">Tools</p>
							<ul class="facts">
								<li><code>figma_get_component_for_development_deep</code></li>
								<li><code>figma_analyze_component_set</code></li>
								<li><code>figma_generate_component_doc</code></li>
							</ul>
						</div>
					</li>
				</ul>
			</div>
		</section>

		<!-- Showcase -->
		<section class="section" aria-labelledby="work-title">
			<div class="wrap">
				<div class="section-head">
					<h2 id="work-title">See it work</h2>
					<p class="section-intro">Example output from four of the tools. Each result is structured data your AI can act on and you can review.</p>
				</div>
				<div class="showcase">
					<article class="show">
						<div class="show-text">
							<p class="show-kicker">Design-system health</p>
							<h3>Score the whole system, then fix what it finds</h3>
							<p>One call scores naming, token architecture, component metadata, accessibility, consistency, and coverage, using the same rules every run. Each finding says how to fix it, and which ones the MCP can fix for you.</p>
							<p class="show-tool"><code>figma_audit_design_system_report</code></p>
						</div>
						<figure aria-label="Example design-system health report">
							<div class="art-panel">
								<div class="rt-head"><strong>Design-system health</strong><span>Example file</span></div>
								<div class="score-body">
									<p class="score-total"><span class="big">84</span><span class="of">/100</span></p>
									<ul class="bars">
										<li><span>Naming &amp; Semantics</span><span class="bar" style="--v:88" aria-hidden="true"></span><span class="bar-num">88</span></li>
										<li><span>Token Architecture</span><span class="bar" style="--v:91" aria-hidden="true"></span><span class="bar-num">91</span></li>
										<li><span>Component Metadata</span><span class="bar" style="--v:72" aria-hidden="true"></span><span class="bar-num">72</span></li>
										<li><span>Accessibility</span><span class="bar" style="--v:79" aria-hidden="true"></span><span class="bar-num">79</span></li>
										<li><span>Consistency</span><span class="bar" style="--v:86" aria-hidden="true"></span><span class="bar-num">86</span></li>
										<li><span>Coverage</span><span class="bar" style="--v:88" aria-hidden="true"></span><span class="bar-num">88</span></li>
									</ul>
									<p class="score-fix"><strong>Top finding:</strong> 18 components have no description. <code>figma_set_description</code> can add them.</p>
								</div>
							</div>
						</figure>
					</article>

					<article class="show">
						<div class="show-text">
							<p class="show-kicker">Design-code parity</p>
							<h3>Check a component against its code</h3>
							<p>Compare a Figma component with its implementation, property by property: color, spacing, typography, tokens, the component API, and accessibility. You get a score and a fix list, not an opinion.</p>
							<p class="show-tool"><code>figma_check_design_parity</code></p>
						</div>
						<figure aria-label="Example parity report">
							<div class="art-panel">
								<div class="rt-head"><strong>Button / Primary</strong><span>Figma vs. React</span></div>
								<p class="parity-sum">Parity <b>85/100</b>. 1 major, 2 minor, 1 info.</p>
								<div class="table-scroll">
									<table class="parity">
										<thead><tr><th scope="col">Severity</th><th scope="col">Property</th><th scope="col">Figma</th><th scope="col">Code</th></tr></thead>
										<tbody>
											<tr><td><span class="sev major">major</span></td><td><code>backgroundColor</code></td><td><code>#0F766E</code></td><td><code>#0E7490</code></td></tr>
											<tr><td><span class="sev">minor</span></td><td><code>borderRadius</code></td><td><code>8px</code></td><td><code>6px</code></td></tr>
											<tr><td><span class="sev">minor</span></td><td><code>fontWeight</code></td><td><code>600</code></td><td><code>500</code></td></tr>
											<tr><td><span class="sev">info</span></td><td><code>prop:iconPosition</code></td><td>defined</td><td>missing</td></tr>
										</tbody>
									</table>
								</div>
							</div>
						</figure>
					</article>

					<article class="show">
						<div class="show-text">
							<p class="show-kicker">Component documentation</p>
							<h3>Docs generated from the file and the code</h3>
							<p>Anatomy, the tokens each variant uses, spacing and typography across sizes, annotations, and a parity section, written as markdown and linked to the commit it describes. Add a changelog from Figma version history and git.</p>
							<p class="show-tool"><code>figma_generate_component_doc</code></p>
						</div>
						<figure aria-label="Example generated component documentation">
							<div class="art-panel doc">
								<div class="rt-head"><strong>Button.md</strong><span>Generated</span></div>
<pre tabindex="0"><code><span class="h"># Button</span>
<span class="m">Source: src/components/Button.tsx @ 3f2a91c</span>

<span class="h">## Color Tokens</span>
| Variant   | Background            | Text               |
|-----------|-----------------------|--------------------|
| Primary   | color/brand/primary   | color/text/inverse |
| Secondary | color/surface/raised  | color/text/default |
| Danger    | color/feedback/danger | color/text/inverse |

<span class="h">## Spacing</span>
Padding varies by Size: sm 12 / 6, md 16 / 8, lg 20 / 12.
All values are bound to space/* tokens.</code></pre>
							</div>
						</figure>
					</article>

					<article class="show wide">
						<div class="show-text">
							<p class="show-kicker">Two-way token sync</p>
							<h3>Round-trip tokens without creating duplicates</h3>
							<p>Export variables to DTCG, CSS, Tailwind, SCSS, TypeScript, JSON, Style Dictionary, or Tokens Studio. Each token keeps its Figma variable ID, so importing an edit updates the variable you meant.</p>
							<p class="show-tool"><code>figma_export_tokens</code> / <code>figma_import_tokens</code></p>
						</div>
						<figure class="roundtrip" aria-labelledby="rt-caption">
							<div class="rt-grid">
								<div class="rt-panel rt-figma">
									<div class="rt-head"><strong>Figma variable</strong><span>Brand collection</span></div>
									<div class="rt-body">
										<div class="rt-name">
											<span class="swatch" style="--sw:#0F766E" aria-hidden="true"></span>
											<code>color/brand/primary</code>
										</div>
										<table class="rt-modes" aria-label="Values by mode">
											<tbody>
												<tr><th scope="row">Light</th><td><span class="swatch sm" style="--sw:#0F766E" aria-hidden="true"></span><code>#0F766E</code></td></tr>
												<tr><th scope="row">Dark</th><td><span class="swatch sm" style="--sw:#2DD4BF" aria-hidden="true"></span><code>#2DD4BF</code></td></tr>
											</tbody>
										</table>
										<p class="rt-id">ID <span class="id-mark">VariableID:12:48</span></p>
									</div>
								</div>
		
								<ul class="rt-link" aria-label="Tools that move the variable">
									<li>
										<span class="dir">Figma to code</span>
										<span class="rt-glyph" aria-hidden="true">&darr;</span>
										<svg class="rt-arrow fwd" viewBox="0 0 120 14" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 7h114M108 1l8 6-8 6"/></svg>
										<code>figma_export_tokens</code>
									</li>
									<li>
										<span class="dir">Code to Figma</span>
										<span class="rt-glyph" aria-hidden="true">&uarr;</span>
										<svg class="rt-arrow back" viewBox="0 0 120 14" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 7h114M108 1l8 6-8 6"/></svg>
										<code>figma_import_tokens</code>
									</li>
								</ul>
		
								<div class="rt-panel rt-code">
									<div class="rt-head"><strong>tokens.json</strong><span>DTCG</span></div>
		<pre tabindex="0" aria-label="Exported token"><code>{
  <span class="k">"color"</span>: { <span class="k">"brand"</span>: {
    <span class="k">"primary"</span>: {
      <span class="k">"$type"</span>: <span class="s">"color"</span>,
      <span class="k">"$value"</span>: <span class="s">"#0F766E"</span>,
      <span class="k">"$extensions"</span>: {
        <span class="k">"figma-console-mcp"</span>: {
          <span class="k">"variableId"</span>: <span class="id-mark">"VariableID:12:48"</span>,
          <span class="k">"modes"</span>: { <span class="k">"Dark"</span>: <span class="s">"#2DD4BF"</span> }
        }
      }
    }
  } }
}</code></pre>
								</div>
							</div>
							<figcaption id="rt-caption">Example: the token keeps its Figma variable ID. Edit the value in code, import it, and the same variable updates in Figma instead of a duplicate being created.</figcaption>
						</figure>
					</article>
				</div>
			</div>
		</section>

		<!-- Example prompts -->
		<section class="section" aria-labelledby="prompts-title">
			<div class="wrap">
				<div class="section-head">
					<h2 id="prompts-title">Ask in plain language</h2>
					<p class="section-intro">Each request maps to a named tool, so you can see exactly what ran.</p>
				</div>
				<ul class="prompts">
					<li class="prompt"><q>How healthy is our design system, and what should we fix first?</q><span class="runs">Runs <code>figma_audit_design_system_report</code></span></li>
					<li class="prompt"><q>Audit the Button component set for accessibility and give me a score.</q><span class="runs">Runs <code>figma_audit_component_accessibility</code></span></li>
					<li class="prompt"><q>Check this component's parity against my React code.</q><span class="runs">Runs <code>figma_check_design_parity</code></span></li>
					<li class="prompt"><q>What changed in the Card component since the last release?</q><span class="runs">Runs <code>figma_get_changes_since_version</code></span></li>
					<li class="prompt"><q>Build a Badge component set with size and tone variants.</q><span class="runs">Runs <code>figma_create_component_set</code></span></li>
					<li class="prompt"><q>Export my variables as Tailwind v4 and keep Figma IDs for round-trip.</q><span class="runs">Runs <code>figma_export_tokens</code></span></li>
				</ul>
			</div>
		</section>

		<!-- Modes -->
		<section class="section" aria-labelledby="modes-title">
			<div class="wrap">
				<div class="section-head">
					<h2 id="modes-title">Three ways to run it</h2>
					<p class="section-intro">Pick the mode that matches your AI client. The setup guide walks through each one.</p>
				</div>
				<div class="modes">
					<div class="mode">
						<h3>Local</h3>
						<p class="count"><span class="number">121+</span><span class="unit">tools</span></p>
						<p><strong>Everything</strong>, including writes, checks, and design-system extraction. Runs with npx next to Figma Desktop and the Desktop Bridge plugin.</p>
					</div>
					<div class="mode">
						<h3>Cloud</h3>
						<p class="count"><span data-mode="cloud">96</span><span class="unit">tools</span></p>
						<p><strong>For web AI clients</strong> such as Claude.ai. Pair the Desktop Bridge plugin with a code and keep write access.</p>
					</div>
					<div class="mode">
						<h3>Remote</h3>
						<p class="count"><span class="number">0</span><span class="unit">installs</span></p>
						<p><strong>Read-only</strong> access to a file over a hosted URL. Pair the plugin later to add writes.</p>
					</div>
				</div>
			</div>
		</section>

		<!-- Get started -->
		<section class="section" aria-labelledby="start-title">
			<div class="wrap">
				<div class="start">
					<div>
						<h2 id="start-title">Set it up</h2>
						<p>The setup guide helps you choose a mode, connect your AI client, and run your first request against a Figma file.</p>
					</div>
					<div class="btn-row">
						<a href="https://docs.figma-console-mcp.southleft.com/setup" class="btn btn-primary">View setup guide</a>
						<a href="https://docs.figma-console-mcp.southleft.com/tools" class="btn btn-quiet">Browse all tools</a>
					</div>
				</div>

				<a href="https://southleft.com/insights/ai/figma-console-mcp-ai-powered-design-system-management/" class="announce">
					<div class="announce-text">
						<span class="announce-icon" aria-hidden="true">
							<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
						</span>
						<div>
							<h2>Read the announcement</h2>
							<p>AI-Powered Design System Management with Figma Console MCP</p>
						</div>
					</div>
					<span class="go">Read article</span>
				</a>
			</div>
		</section>
	</main>

	<footer class="site-footer">
		<div class="wrap">
			<p>Version ${landing.version}. MIT License. Built by <a href="https://southleft.com">Southleft</a>.</p>
			<nav class="footer-links" aria-label="Footer">
				<a href="https://docs.figma-console-mcp.southleft.com">Docs</a>
				<a href="https://github.com/southleft/figma-console-mcp">GitHub</a>
				<a href="https://www.npmjs.com/package/figma-console-mcp">npm</a>
				<a href="https://github.com/southleft/figma-console-mcp/blob/main/CHANGELOG.md">Changelog</a>
				<a href="https://github.com/sponsors/southleft" class="sponsor">Sponsor</a>
			</nav>
		</div>
	</footer>

	<script>
		// Theme toggle: remembers an explicit choice; otherwise follows the system.
		(function () {
			var root = document.documentElement;
			var toggle = document.querySelector('.theme-toggle');
			var media = window.matchMedia('(prefers-color-scheme: dark)');

			function stored() {
				try { return localStorage.getItem('theme'); } catch (e) { return null; }
			}
			function label(theme) {
				toggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
			}
			function apply(theme, remember) {
				root.setAttribute('data-theme', theme);
				label(theme);
				if (remember) { try { localStorage.setItem('theme', theme); } catch (e) {} }
			}

			label(root.getAttribute('data-theme') || 'light');
			media.addEventListener('change', function (e) {
				if (!stored()) apply(e.matches ? 'dark' : 'light', false);
			});
			toggle.addEventListener('click', function () {
				apply(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark', true);
			});
		})();

		// Mobile menu: modal dialog with focus handling and Escape to close.
		(function () {
			var openBtn = document.querySelector('.menu-btn');
			var menu = document.getElementById('mobileMenu');
			var closeBtn = menu.querySelector('.menu-close');

			function open() {
				menu.hidden = false;
				document.body.classList.add('menu-open');
				openBtn.setAttribute('aria-expanded', 'true');
				closeBtn.focus();
			}
			function close() {
				menu.hidden = true;
				document.body.classList.remove('menu-open');
				openBtn.setAttribute('aria-expanded', 'false');
				openBtn.focus();
			}

			openBtn.addEventListener('click', open);
			closeBtn.addEventListener('click', close);
			menu.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', close); });
			document.addEventListener('keydown', function (e) {
				if (menu.hidden) return;
				if (e.key === 'Escape') { close(); return; }
				if (e.key === 'Tab') {
					var items = menu.querySelectorAll('a, button');
					var first = items[0], last = items[items.length - 1];
					if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
					else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
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
