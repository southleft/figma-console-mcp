#!/usr/bin/env node

/**
 * Figma Console MCP Server - Local Mode
 *
 * Entry point for local MCP server that connects to Figma Desktop
 * via Chrome Remote Debugging Protocol (port 9222).
 *
 * This implementation uses stdio transport for MCP communication,
 * suitable for local IDE integrations and development workflows.
 *
 * Requirements:
 * - Figma Desktop must be launched with: --remote-debugging-port=9222
 * - "Use Developer VM" enabled in Figma: Plugins → Development → Use Developer VM
 * - FIGMA_ACCESS_TOKEN environment variable for API access
 *
 * macOS launch command:
 *   open -a "Figma" --args --remote-debugging-port=9222
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LocalBrowserManager } from "./browser/local.js";
import { ConsoleMonitor } from "./core/console-monitor.js";
import { getConfig } from "./core/config.js";
import { createChildLogger } from "./core/logger.js";
import { FigmaAPI, extractFileKey } from "./core/figma-api.js";
import { registerFigmaAPITools } from "./core/figma-tools.js";

const logger = createChildLogger({ component: "local-server" });

/**
 * Local MCP Server
 * Connects to Figma Desktop and provides identical tools to Cloudflare mode
 */
class LocalFigmaConsoleMCP {
	private server: McpServer;
	private browserManager: LocalBrowserManager | null = null;
	private consoleMonitor: ConsoleMonitor | null = null;
	private figmaAPI: FigmaAPI | null = null;
	private config = getConfig();

	// In-memory cache for variables data to avoid MCP token limits
	// Maps fileKey -> {data, timestamp}
	private variablesCache: Map<string, {
		data: any;
		timestamp: number;
	}> = new Map();

	constructor() {
		this.server = new McpServer({
			name: "Figma Console MCP (Local)",
			version: "0.1.0",
		});
	}

	/**
	 * Get or create Figma API client
	 */
	private async getFigmaAPI(): Promise<FigmaAPI> {
		if (!this.figmaAPI) {
			const accessToken = process.env.FIGMA_ACCESS_TOKEN;

			if (!accessToken) {
				throw new Error(
					"FIGMA_ACCESS_TOKEN not configured. " +
					"Set it as an environment variable. " +
					"Get your token at: https://www.figma.com/developers/api#access-tokens"
				);
			}

			logger.info({
				tokenPreview: `${accessToken.substring(0, 10)}...`,
				tokenLength: accessToken.length
			}, "Initializing Figma API with token from environment");

			this.figmaAPI = new FigmaAPI({ accessToken });
		}

		return this.figmaAPI;
	}

	/**
	 * Check if Figma Desktop is accessible
	 */
	private async checkFigmaDesktop(): Promise<void> {
		if (!this.config.local) {
			throw new Error("Local mode configuration missing");
		}

		const { debugHost, debugPort } = this.config.local;
		const browserURL = `http://${debugHost}:${debugPort}`;

		try {
			// Simple HTTP check to see if debug port is accessible
			const response = await fetch(`${browserURL}/json/version`, {
				signal: AbortSignal.timeout(5000),
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const versionInfo = await response.json();
			logger.info({ versionInfo, browserURL }, "Figma Desktop is accessible");
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);

			throw new Error(
				`Failed to connect to Figma Desktop at ${browserURL}\n\n` +
				`Make sure:\n` +
				`1. Figma Desktop is running\n` +
				`2. Figma was launched with: --remote-debugging-port=${debugPort}\n` +
				`3. "Use Developer VM" is enabled in: Plugins → Development → Use Developer VM\n\n` +
				`macOS launch command:\n` +
				`  open -a "Figma" --args --remote-debugging-port=${debugPort}\n\n` +
				`Windows launch command:\n` +
				`  start figma://--remote-debugging-port=${debugPort}\n\n` +
				`Error: ${errorMsg}`
			);
		}
	}

	/**
	 * Initialize browser and console monitoring
	 */
	private async ensureInitialized(): Promise<void> {
		try {
			if (!this.browserManager) {
				logger.info("Initializing LocalBrowserManager");

				if (!this.config.local) {
					throw new Error("Local mode configuration missing");
				}

				this.browserManager = new LocalBrowserManager(this.config.local);
			}

			// Always check connection health (handles computer sleep/reconnects)
			if (this.browserManager && this.consoleMonitor) {
				const wasAlive = await this.browserManager.isConnectionAlive();
				await this.browserManager.ensureConnection();

				// If connection was lost and browser is now connected, FORCE restart monitoring
				// Note: Can't use isConnectionAlive() here because page might not be fetched yet after reconnection
				// Instead, check if browser is connected using isRunning()
				if (!wasAlive && this.browserManager.isRunning()) {
					logger.info("Connection was lost and recovered - forcing monitoring restart with fresh page");
					this.consoleMonitor.stopMonitoring(); // Clear stale state
					const page = await this.browserManager.getPage();
					await this.consoleMonitor.startMonitoring(page);
				} else if (this.browserManager.isRunning() && !this.consoleMonitor.getStatus().isMonitoring) {
					// Connection is fine but monitoring stopped for some reason
					logger.info("Connection alive but monitoring stopped - restarting console monitoring");
					const page = await this.browserManager.getPage();
					await this.consoleMonitor.startMonitoring(page);
				}
			}

			if (!this.consoleMonitor) {
				logger.info("Initializing ConsoleMonitor");
				this.consoleMonitor = new ConsoleMonitor(this.config.console);

				// Connect to browser and begin monitoring
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

	/**
	 * Register all MCP tools
	 */
	private registerTools(): void {
		// Tool 1: Get Console Logs
		this.server.tool(
			"figma_get_console_logs",
			"Retrieve console logs from Figma Desktop. FOR PLUGIN DEVELOPERS: This works immediately - no navigation needed! Just check logs, run your plugin in Figma Desktop, check logs again. All plugin logs ([Main], [Swapper], etc.) appear instantly.",
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
						const monitorStatus = this.consoleMonitor.getStatus();
						const isMonitoring = monitorStatus.isMonitoring;

						// Detect if connection might be stale
						if (!isMonitoring) {
							responseData.ai_instruction = "Console monitoring is not active (likely lost connection after computer sleep). TAKE THESE STEPS: 1) Call figma_get_status to check connection, 2) Call figma_navigate with the Figma file URL to reconnect and restart monitoring, 3) Retry this tool - logs should appear.";
							responseData.ai_recovery_steps = [
								"Console monitoring is not active - connection was likely lost",
								"STEP 1: Call figma_get_status to verify browser connection status",
								"STEP 2: Call figma_navigate with the Figma file URL to reconnect",
								"STEP 3: Retry figma_get_console_logs - monitoring will be restarted automatically"
							];
						} else {
							responseData.ai_instruction = "No console logs found. This usually means the Figma plugin hasn't run since monitoring started. Please inform the user: 'No console logs found yet. Try running your Figma plugin now, then I'll check for logs again.' The MCP only captures logs AFTER monitoring starts - it cannot retrieve historical logs from before the browser connected.";
						}
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

					// Check if it's a connection issue
					const isConnectionError = errorMessage.includes("connect") || errorMessage.includes("ECONNREFUSED");

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: errorMessage,
										message: isConnectionError
											? "Cannot connect to Figma Desktop. Figma must be running with remote debugging enabled for local mode to work."
											: "Failed to retrieve console logs.",
										setup: isConnectionError ? {
											step1: "QUIT Figma Desktop completely (Cmd+Q on macOS / Alt+F4 on Windows)",
											step2_macOS: "Open Terminal and run: open -a \"Figma\" --args --remote-debugging-port=9222",
											step2_windows: "Open Command Prompt and run: start figma://--remote-debugging-port=9222",
											step3: "Open your design file and run your plugin",
											step4: "Then try this tool again - logs will appear instantly",
											verify: "To verify setup worked, visit http://localhost:9222 in Chrome - you should see inspectable pages"
										} : undefined,
										ai_instruction: isConnectionError
											? "IMPORTANT: You must ask the user to complete the setup steps above. DO NOT proceed until they confirm Figma has been restarted with the --remote-debugging-port=9222 flag. After they restart Figma, you should call this tool again and the logs will work."
											: undefined,
										hint: !isConnectionError ? "Try: figma_navigate({ url: 'https://www.figma.com/design/your-file' })" : undefined,
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
			"Stream console logs in real-time for a specified duration (max 5 minutes). Use for monitoring plugin execution while user tests manually. Returns all logs captured during watch period with summary statistics. NOT for retrieving past logs (use figma_get_console_logs). Best for: watching plugin output during manual testing, debugging race conditions, monitoring async operations.",
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
				if (!this.browserManager || !this.consoleMonitor) {
					throw new Error("Browser not connected. Ensure Figma Desktop is running with --remote-debugging-port=9222");
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
			"Reload the current Figma page/plugin to test code changes. Optionally clears console logs before reload. Use when user says: 'reload plugin', 'refresh page', 'restart plugin', 'test my changes'. Returns reload confirmation and current URL. Best for rapid iteration during plugin development.",
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
					const errorMessage = String(error);
					const isNoPageError = errorMessage.includes("No active page");

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: errorMessage,
										message: "Failed to reload plugin",
										ai_recovery_steps: isNoPageError ? [
											"Connection to Figma Desktop was lost (likely from computer sleep)",
											"STEP 1: Call figma_get_status to check browser connection",
											"STEP 2: Call figma_navigate with the Figma file URL to reconnect",
											"STEP 3: Retry this operation - connection should be restored"
										] : [
											"STEP 1: Call figma_get_status to diagnose the issue",
											"STEP 2: Try figma_navigate to re-establish connection",
											"STEP 3: Retry this operation"
										],
										ai_instruction: isNoPageError
											? "The browser connection was lost (computer likely went to sleep). Call figma_navigate to reconnect, then retry."
											: "Connection issue detected. Call figma_get_status first to diagnose, then figma_navigate to reconnect."
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
			"Clear the console log buffer. ⚠️ WARNING: Disrupts monitoring connection - requires MCP reconnect afterward. AVOID using this - prefer filtering logs with figma_get_console_logs instead. Only use if user explicitly requests clearing logs. Returns number of logs cleared.",
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
			"Navigate browser to a Figma URL and start console monitoring. ALWAYS use this first when starting a new debugging session or switching files. Initializes browser connection and begins capturing console logs. Use when user provides a Figma URL or says: 'open this file', 'debug this design', 'switch to'. Returns navigation status and current URL.",
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
										troubleshooting: [
											"Verify the Figma URL is valid and accessible",
											"Make sure Figma Desktop is running with remote debugging enabled",
											"Check that the debug port (9222) is accessible"
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

		// Tool 7: Get Status (with setup validation)
		this.server.tool(
			"figma_get_status",
			"Check browser and monitoring status. Also validates if Figma Desktop is running with the required --remote-debugging-port=9222 flag. Automatically initializes connection if needed.",
			{},
			async () => {
				try {
					// Ensure initialized (connects to Figma Desktop if not already connected)
					await this.ensureInitialized();

					const browserRunning = this.browserManager?.isRunning() ?? false;
					const monitorStatus = this.consoleMonitor?.getStatus() ?? null;
					const currentUrl = this.browserManager?.getCurrentUrl() ?? null;

					// Check if debug port is accessible
					let debugPortAccessible = false;
					let setupValid = false;
					try {
						const response = await fetch('http://localhost:9222/json/version', {
							signal: AbortSignal.timeout(2000)
						});
						debugPortAccessible = response.ok;
						setupValid = debugPortAccessible;
					} catch (e) {
						// Port not accessible
					}

					// List ALL available Figma pages with worker counts
					let availablePages: Array<{url: string, workerCount: number, isCurrentPage: boolean}> = [];
					if (this.browserManager && browserRunning) {
						try {
							const browser = (this.browserManager as any).browser;
							if (browser) {
								const pages = await browser.pages();
								availablePages = pages
									.filter((p: any) => {
										const url = p.url();
										return url.includes('figma.com') && !url.includes('devtools');
									})
									.map((p: any) => ({
										url: p.url(),
										workerCount: p.workers().length,
										isCurrentPage: p.url() === currentUrl
									}));
							}
						} catch (e) {
							logger.error({ error: e }, "Failed to list available pages");
						}
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										mode: "local",
										setup: {
											valid: setupValid,
											debugPortAccessible,
											message: setupValid
												? "✅ Figma Desktop is running with remote debugging enabled"
												: "❌ Figma Desktop is NOT running with --remote-debugging-port=9222",
											setupInstructions: !setupValid ? {
												step1: "QUIT Figma Desktop completely (Cmd+Q on macOS / Alt+F4 on Windows)",
												step2_macOS: "Open Terminal and run: open -a \"Figma\" --args --remote-debugging-port=9222",
												step2_windows: "Open Command Prompt and run: start figma://--remote-debugging-port=9222",
												step3: "Open your design file and run your plugin",
												verify: "Visit http://localhost:9222 in Chrome to verify - you should see inspectable pages"
											} : undefined,
											ai_instruction: !setupValid
												? "CRITICAL: User must restart Figma with the debug flag before any console tools will work. Ask them to follow the setupInstructions above, then call figma_get_status again to verify."
												: availablePages.length > 1
													? `Multiple Figma pages detected. The MCP automatically selects the page with the most workers (active plugins). Current page has ${monitorStatus?.workerCount || 0} workers. If you're not seeing the expected plugin logs, the plugin might be running in a different page/tab.`
													: "Setup is valid. Console tools are ready to use."
										},
										availablePages: availablePages.length > 0 ? availablePages : undefined,
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

		// Register Figma API tools (Tools 8-11)
		registerFigmaAPITools(
			this.server,
			() => this.getFigmaAPI(),
			() => this.browserManager?.getCurrentUrl() || null,
			() => this.consoleMonitor || null,
			() => this.browserManager || null,
			() => this.ensureInitialized(),
			this.variablesCache  // Pass cache for efficient variable queries
		);

		logger.info("All MCP tools registered successfully");
	}

	/**
	 * Start the MCP server
	 */
	async start(): Promise<void> {
		try {
			logger.info({ config: this.config }, "Starting Figma Console MCP (Local Mode)");

			// Check if Figma Desktop is accessible (non-blocking, just for logging)
			logger.info("Checking Figma Desktop accessibility...");
			try {
				await this.checkFigmaDesktop();
				logger.info("✅ Figma Desktop is accessible and ready");
			} catch (error) {
				// Don't crash if Figma isn't running yet - just log a warning
				const errorMsg = error instanceof Error ? error.message : String(error);
				logger.warn({ error: errorMsg }, "⚠️ Figma Desktop not accessible yet - MCP will connect when you use a tool");
				console.error("\n⚠️ Figma Desktop Check:\n");
				console.error("Figma Desktop is not currently running with remote debugging enabled.");
				console.error("The MCP server will start anyway, but tools won't work until you:");
				console.error("1. Launch Figma Desktop with: --remote-debugging-port=9222");
				console.error("2. Then use figma_get_status to verify connection\n");
			}

			// Register all tools
			this.registerTools();

			// Create stdio transport
			const transport = new StdioServerTransport();

			// Connect server to transport
			await this.server.connect(transport);

			logger.info("MCP server started successfully on stdio transport");
		} catch (error) {
			logger.error({ error }, "Failed to start MCP server");

			// Log helpful error message to stderr
			console.error("\n❌ Failed to start Figma Console MCP:\n");
			console.error(error instanceof Error ? error.message : String(error));
			console.error("\n");

			process.exit(1);
		}
	}

	/**
	 * Cleanup and shutdown
	 */
	async shutdown(): Promise<void> {
		logger.info("Shutting down MCP server...");

		try {
			if (this.consoleMonitor) {
				await this.consoleMonitor.stopMonitoring();
			}

			if (this.browserManager) {
				await this.browserManager.close();
			}

			logger.info("MCP server shutdown complete");
		} catch (error) {
			logger.error({ error }, "Error during shutdown");
		}
	}
}

/**
 * Main entry point
 */
async function main() {
	const server = new LocalFigmaConsoleMCP();

	// Handle graceful shutdown
	process.on("SIGINT", async () => {
		await server.shutdown();
		process.exit(0);
	});

	process.on("SIGTERM", async () => {
		await server.shutdown();
		process.exit(0);
	});

	// Start the server
	await server.start();
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error("Fatal error:", error);
		process.exit(1);
	});
}

export { LocalFigmaConsoleMCP };
