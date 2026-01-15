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
import { fileURLToPath } from "url";
import { resolve } from "path";
import { LocalBrowserManager } from "./browser/local.js";
import { ConsoleMonitor } from "./core/console-monitor.js";
import { getConfig } from "./core/config.js";
import { createChildLogger } from "./core/logger.js";
import { FigmaAPI, extractFileKey } from "./core/figma-api.js";
import { registerFigmaAPITools } from "./core/figma-tools.js";
import { FigmaDesktopConnector } from "./core/figma-desktop-connector.js";

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
	private desktopConnector: FigmaDesktopConnector | null = null;
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
			instructions: `## Figma Console MCP - Visual Design Workflow

This MCP server enables AI-assisted design creation in Figma. Follow these mandatory workflows:

### VISUAL VALIDATION WORKFLOW (Required)
After creating or modifying ANY visual design elements:
1. **CREATE**: Execute design code via figma_execute
2. **SCREENSHOT**: Capture result with figma_take_screenshot
3. **ANALYZE**: Check alignment, spacing, proportions, visual balance
4. **ITERATE**: Fix issues and repeat (max 3 iterations)
5. **VERIFY**: Final screenshot to confirm

### COMPONENT INSTANTIATION
- ALWAYS call figma_search_components at the start of each session
- NodeIds are session-specific and become stale across conversations
- Never reuse nodeIds from previous sessions without re-searching

### PAGE CREATION
- Before creating a page, check if it already exists to avoid duplicates
- Use: await figma.loadAllPagesAsync(); const existing = figma.root.children.find(p => p.name === 'PageName');

### COMMON DESIGN ISSUES TO CHECK
- Elements using "hug contents" instead of "fill container" (causes lopsided layouts)
- Inconsistent padding (elements not visually balanced)
- Text/inputs not filling available width
- Items not centered properly in their containers`,
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
	 * Get or create Desktop Connector for write operations
	 * Requires the browser to be initialized and the Desktop Bridge plugin to be running
	 */
	private async getDesktopConnector(): Promise<FigmaDesktopConnector> {
		await this.ensureInitialized();

		if (!this.browserManager) {
			throw new Error("Browser manager not initialized");
		}

		// Always get a fresh page reference to handle page navigation/refresh
		const page = await this.browserManager.getPage();

		// Always recreate the connector with the current page to avoid stale references
		// This prevents "detached Frame" errors when Figma page is refreshed
		this.desktopConnector = new FigmaDesktopConnector(page);
		await this.desktopConnector.initialize();
		logger.debug("Desktop connector initialized with fresh page reference");

		return this.desktopConnector;
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
	 * Auto-connect to Figma Desktop at startup
	 * Runs in background - never blocks or throws
	 * Enables "get latest logs" workflow without manual setup
	 */
	private autoConnectToFigma(): void {
		// Fire-and-forget with proper async handling
		(async () => {
			try {
				logger.info("🔄 Auto-connecting to Figma Desktop for immediate log capture...");
				await this.ensureInitialized();
				logger.info("✅ Auto-connect successful - console monitoring active. Logs will be captured immediately.");
			} catch (error) {
				// Don't crash - just log that auto-connect didn't work
				const errorMsg = error instanceof Error ? error.message : String(error);
				logger.warn({ error: errorMsg }, "⚠️ Auto-connect to Figma Desktop failed - will connect when you use a tool");
				// This is fine - the user can still use tools to trigger connection later
			}
		})();
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

				// 🆕 NEW: Dynamic page switching for worker migration
				// Check if we should switch to a page with more workers
				if (this.browserManager.isRunning() && this.consoleMonitor.getStatus().isMonitoring) {
					const browser = (this.browserManager as any).browser;

					if (browser) {
						try {
							// Get all Figma pages
							const pages = await browser.pages();
							const figmaPages = pages
								.filter((p: any) => {
									const url = p.url();
									return url.includes('figma.com') && !url.includes('devtools');
								})
								.map((p: any) => ({
									page: p,
									url: p.url(),
									workerCount: p.workers().length
								}));

							// Find current monitored page URL
							const currentUrl = this.browserManager.getCurrentUrl();
							const currentPageInfo = figmaPages.find((p: { page: any; url: string; workerCount: number }) => p.url === currentUrl);
							const currentWorkerCount = currentPageInfo?.workerCount ?? 0;

							// Find best page (most workers)
							const bestPage = figmaPages
								.filter((p: { page: any; url: string; workerCount: number }) => p.workerCount > 0)
								.sort((a: { page: any; url: string; workerCount: number }, b: { page: any; url: string; workerCount: number }) => b.workerCount - a.workerCount)[0];

							// Switch if:
							// 1. Current page has 0 workers AND another page has workers
							// 2. Another page has MORE workers (prevent thrashing with threshold)
							const shouldSwitch = bestPage && (
								(currentWorkerCount === 0 && bestPage.workerCount > 0) ||
								(bestPage.workerCount > currentWorkerCount + 1) // +1 threshold to prevent ping-pong
							);

							if (shouldSwitch && bestPage.url !== currentUrl) {
								logger.info({
									oldPage: currentUrl,
									oldWorkers: currentWorkerCount,
									newPage: bestPage.url,
									newWorkers: bestPage.workerCount
								}, 'Switching to page with more workers');

								// Stop monitoring old page
								this.consoleMonitor.stopMonitoring();

								// Start monitoring new page
								await this.consoleMonitor.startMonitoring(bestPage.page);

								// Don't clear logs - preserve history across page switches
								logger.info('Console monitoring restarted on new page');
							}
						} catch (error) {
							logger.error({ error }, 'Failed to check for better pages with workers');
							// Don't throw - this is a best-effort optimization
						}
					}
				}

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
			`Export an image of the currently viewed Figma page or specific node using Figma's REST API. Returns an image URL (valid for 30 days). For specific components, use figma_get_component_image instead.

**CRITICAL: Use this tool for visual validation after ANY design creation or modification.**
This is an essential part of the visual validation workflow:
1. After creating/modifying designs with figma_execute, ALWAYS take a screenshot
2. Analyze the screenshot to verify the design matches specifications
3. Check for alignment, spacing, proportions, and visual balance
4. If issues are found, iterate with fixes and take another screenshot
5. Continue until the design looks correct (max 3 iterations)

Pass a nodeId to screenshot specific frames/elements, or omit to capture the current view.`,
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

					// Try to get the current file name for better context
					let currentFileName: string | null = null;
					if (browserRunning && debugPortAccessible) {
						try {
							const connector = await this.getDesktopConnector();
							const fileInfo = await connector.executeCodeViaUI(
								"return { fileName: figma.root.name, fileKey: figma.fileKey }",
								5000
							);
							if (fileInfo.success && fileInfo.result) {
								currentFileName = fileInfo.result.fileName;
							}
						} catch {
							// Non-critical - Desktop Bridge might not be running yet
						}
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										mode: "local",
										// Surface file name prominently for context clarity
										currentFileName: currentFileName || "(Desktop Bridge not running - file name unavailable)",
										monitoredPageUrl: currentUrl,
										monitorWorkerCount: monitorStatus?.workerCount ?? 0,
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

		// ============================================================================
		// CONNECTION MANAGEMENT TOOLS
		// ============================================================================

		// Tool: Force reconnect to Figma Desktop
		this.server.tool(
			"figma_reconnect",
			"Force a complete reconnection to Figma Desktop. Use this when you get 'detached Frame' errors or when the connection seems stale. This will disconnect and reconnect to Figma, getting fresh page and frame references.",
			{},
			async () => {
				try {
					if (!this.browserManager) {
						throw new Error("Browser manager not initialized. Run any tool first to initialize.");
					}

					// Clear our cached desktop connector
					this.desktopConnector = null;

					// Force the browser manager to reconnect
					await this.browserManager.forceReconnect();

					// Reinitialize console monitor with new page
					if (this.consoleMonitor) {
						this.consoleMonitor.stopMonitoring();
					}
					const page = await this.browserManager.getPage();
					await this.consoleMonitor!.startMonitoring(page);

					const currentUrl = this.browserManager.getCurrentUrl();

					// Try to get the file name for better context clarity
					let fileName: string | null = null;
					try {
						const connector = await this.getDesktopConnector();
						const fileInfo = await connector.executeCodeViaUI(
							"return { fileName: figma.root.name, fileKey: figma.fileKey }",
							5000
						);
						if (fileInfo.success && fileInfo.result) {
							fileName = fileInfo.result.fileName;
						}
					} catch {
						// Non-critical - just for context
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										status: "reconnected",
										currentUrl,
										// Include file name prominently for clarity
										fileName: fileName || "(unknown - Desktop Bridge may need to be restarted)",
										timestamp: Date.now(),
										message: fileName
											? `Successfully reconnected to Figma Desktop. Now monitoring: "${fileName}"`
											: "Successfully reconnected to Figma Desktop. Console monitoring restarted.",
									},
									null,
									2,
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to reconnect");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: error instanceof Error ? error.message : String(error),
										message: "Failed to reconnect to Figma Desktop",
										hint: "Make sure Figma Desktop is running with --remote-debugging-port=9222",
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

		// ============================================================================
		// WRITE OPERATION TOOLS - Figma Design Manipulation
		// ============================================================================

		// Tool: Execute arbitrary code in Figma plugin context (Power Tool)
		this.server.tool(
			"figma_execute",
			`Execute arbitrary JavaScript code in Figma's plugin context. This is a POWER TOOL that can run any Figma Plugin API code. Use for complex operations not covered by other tools. Requires the Desktop Bridge plugin to be running in Figma. Returns the result of the code execution. CAUTION: Can modify your Figma document - use carefully.

**IMPORTANT: COMPONENT INSTANCES vs DIRECT NODE EDITING**
When working with component instances (node.type === 'INSTANCE'), you must use the correct approach:
- Components expose TEXT, BOOLEAN, INSTANCE_SWAP, and VARIANT properties
- Direct editing of text nodes inside instances often FAILS SILENTLY
- Use figma_set_instance_properties tool to update component properties
- Use instance.componentProperties to see available properties
- Property names may have #nodeId suffixes (e.g., 'Label#1:234')

**SILENT FAILURE DETECTION:**
This tool now returns a 'resultAnalysis' field that warns when operations may have failed:
- Empty arrays/objects indicate searches found nothing
- Null/undefined returns may indicate missing nodes
- Always check resultAnalysis.warning for potential issues

**VISUAL VALIDATION WORKFLOW (REQUIRED for design creation):**
After creating or modifying any visual design elements, you MUST follow this validation loop:
1. CREATE: Execute the design code
2. SCREENSHOT: Use figma_capture_screenshot (NOT figma_take_screenshot) for reliable validation - it reads from plugin runtime, not cloud state
3. ANALYZE: Compare screenshot against specifications for:
   - Alignment: Are elements properly aligned and balanced?
   - Spacing: Is padding/margin consistent and visually correct?
   - Proportions: Do widths fill containers appropriately?
   - Typography: Are fonts, sizes, and weights correct?
   - Visual balance: Does it look professional and centered?
4. ITERATE: If issues found, fix and repeat (max 3 iterations)
5. VERIFY: Take final screenshot to confirm fixes

Common issues to check:
- Elements using "hug contents" instead of "fill container" (causes lopsided layouts)
- Inconsistent padding (elements not visually balanced)
- Text/inputs not filling available width
- Component text not changing (use figma_set_instance_properties instead)
- Duplicate pages created (check before creating new pages)`,
			{
				code: z.string().describe(
					"JavaScript code to execute. Has access to the 'figma' global object. " +
					"Example: 'const rect = figma.createRectangle(); rect.resize(100, 100); return { id: rect.id };'"
				),
				timeout: z.number().optional().default(5000).describe(
					"Execution timeout in milliseconds (default: 5000, max: 30000)"
				),
			},
			async ({ code, timeout }) => {
				const maxRetries = 2;
				let lastError: Error | null = null;

				for (let attempt = 0; attempt <= maxRetries; attempt++) {
					try {
						const connector = await this.getDesktopConnector();
						const result = await connector.executeCodeViaUI(code, Math.min(timeout, 30000));

						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											success: result.success,
											result: result.result,
											error: result.error,
											// Include resultAnalysis for silent failure detection
											resultAnalysis: result.resultAnalysis,
											// Include file context so users know which file was queried
											fileContext: result.fileContext,
											timestamp: Date.now(),
											...(attempt > 0 ? { reconnected: true, attempts: attempt + 1 } : {}),
										},
										null,
										2,
									),
								},
							],
						};
					} catch (error) {
						lastError = error instanceof Error ? error : new Error(String(error));
						const errorMessage = lastError.message;

						// Check if it's a detached frame error - auto-reconnect
						if (errorMessage.includes("detached Frame") ||
							errorMessage.includes("Execution context was destroyed") ||
							errorMessage.includes("Target closed")) {

							logger.warn({ attempt, error: errorMessage }, "Detached frame detected, forcing reconnection");

							// Clear cached connector and force browser reconnection
							this.desktopConnector = null;

							if (this.browserManager && attempt < maxRetries) {
								try {
									await this.browserManager.forceReconnect();

									// Reinitialize console monitor with new page
									if (this.consoleMonitor) {
										this.consoleMonitor.stopMonitoring();
										const page = await this.browserManager.getPage();
										await this.consoleMonitor.startMonitoring(page);
									}

									logger.info("Reconnection successful, retrying execution");
									continue; // Retry the execution
								} catch (reconnectError) {
									logger.error({ error: reconnectError }, "Failed to reconnect");
								}
							}
						}

						// Non-recoverable error or max retries exceeded
						break;
					}
				}

				// All retries failed
				logger.error({ error: lastError }, "Failed to execute code after retries");
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: lastError?.message || "Unknown error",
									message: "Failed to execute code in Figma plugin context",
									hint: "Make sure the Desktop Bridge plugin is running in Figma",
								},
								null,
								2,
							),
						},
					],
					isError: true,
				};
			},
		);

		// Tool: Update a variable's value
		this.server.tool(
			"figma_update_variable",
			"Update a Figma variable's value in a specific mode. Use figma_get_variables first to get variable IDs and mode IDs. Supports COLOR (hex string like '#FF0000'), FLOAT (number), STRING (text), and BOOLEAN values. Requires the Desktop Bridge plugin to be running.",
			{
				variableId: z.string().describe(
					"The variable ID to update (e.g., 'VariableID:123:456'). Get this from figma_get_variables."
				),
				modeId: z.string().describe(
					"The mode ID to update the value in (e.g., '1:0'). Get this from the variable's collection modes."
				),
				value: z.any().describe(
					"The new value. For COLOR: hex string like '#FF0000'. For FLOAT: number. For STRING: text. For BOOLEAN: true/false."
				),
			},
			async ({ variableId, modeId, value }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.updateVariable(variableId, modeId, value);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: `Variable "${result.variable.name}" updated successfully`,
										variable: result.variable,
										timestamp: Date.now(),
									},
									null,
									2,
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to update variable");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: error instanceof Error ? error.message : String(error),
										message: "Failed to update variable",
										hint: "Make sure the Desktop Bridge plugin is running and the variable ID is correct",
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

		// Tool: Create a new variable
		this.server.tool(
			"figma_create_variable",
			"Create a new Figma variable in an existing collection. Use figma_get_variables first to get collection IDs. Supports COLOR, FLOAT, STRING, and BOOLEAN types. Requires the Desktop Bridge plugin to be running.",
			{
				name: z.string().describe("Name for the new variable (e.g., 'primary-blue')"),
				collectionId: z.string().describe(
					"The collection ID to create the variable in (e.g., 'VariableCollectionId:123:456'). Get this from figma_get_variables."
				),
				resolvedType: z.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]).describe(
					"The variable type: COLOR, FLOAT, STRING, or BOOLEAN"
				),
				description: z.string().optional().describe("Optional description for the variable"),
				valuesByMode: z.record(z.any()).optional().describe(
					"Optional initial values by mode ID. Example: { '1:0': '#FF0000', '1:1': '#0000FF' }"
				),
			},
			async ({ name, collectionId, resolvedType, description, valuesByMode }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.createVariable(name, collectionId, resolvedType, {
						description,
						valuesByMode,
					});

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: `Variable "${name}" created successfully`,
										variable: result.variable,
										timestamp: Date.now(),
									},
									null,
									2,
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to create variable");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: error instanceof Error ? error.message : String(error),
										message: "Failed to create variable",
										hint: "Make sure the Desktop Bridge plugin is running and the collection ID is correct",
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

		// Tool: Create a new variable collection
		this.server.tool(
			"figma_create_variable_collection",
			"Create a new Figma variable collection. Collections organize variables and define modes (like Light/Dark themes). Requires the Desktop Bridge plugin to be running.",
			{
				name: z.string().describe("Name for the new collection (e.g., 'Brand Colors')"),
				initialModeName: z.string().optional().describe(
					"Name for the initial mode (default mode is created automatically). Example: 'Light'"
				),
				additionalModes: z.array(z.string()).optional().describe(
					"Additional mode names to create. Example: ['Dark', 'High Contrast']"
				),
			},
			async ({ name, initialModeName, additionalModes }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.createVariableCollection(name, {
						initialModeName,
						additionalModes,
					});

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: `Collection "${name}" created successfully`,
										collection: result.collection,
										timestamp: Date.now(),
									},
									null,
									2,
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to create collection");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: error instanceof Error ? error.message : String(error),
										message: "Failed to create variable collection",
										hint: "Make sure the Desktop Bridge plugin is running in Figma",
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

		// Tool: Delete a variable
		this.server.tool(
			"figma_delete_variable",
			"Delete a Figma variable. WARNING: This is a destructive operation that cannot be undone (except with Figma's undo). Use figma_get_variables first to get variable IDs. Requires the Desktop Bridge plugin to be running.",
			{
				variableId: z.string().describe(
					"The variable ID to delete (e.g., 'VariableID:123:456'). Get this from figma_get_variables."
				),
			},
			async ({ variableId }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.deleteVariable(variableId);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: `Variable "${result.deleted.name}" deleted successfully`,
										deleted: result.deleted,
										timestamp: Date.now(),
										warning: "This action cannot be undone programmatically. Use Figma's Edit > Undo if needed.",
									},
									null,
									2,
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to delete variable");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: error instanceof Error ? error.message : String(error),
										message: "Failed to delete variable",
										hint: "Make sure the Desktop Bridge plugin is running and the variable ID is correct",
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

		// Tool: Delete a variable collection
		this.server.tool(
			"figma_delete_variable_collection",
			"Delete a Figma variable collection and ALL its variables. WARNING: This is a destructive operation that deletes all variables in the collection and cannot be undone (except with Figma's undo). Requires the Desktop Bridge plugin to be running.",
			{
				collectionId: z.string().describe(
					"The collection ID to delete (e.g., 'VariableCollectionId:123:456'). Get this from figma_get_variables."
				),
			},
			async ({ collectionId }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.deleteVariableCollection(collectionId);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: `Collection "${result.deleted.name}" and ${result.deleted.variableCount} variables deleted successfully`,
										deleted: result.deleted,
										timestamp: Date.now(),
										warning: "This action cannot be undone programmatically. Use Figma's Edit > Undo if needed.",
									},
									null,
									2,
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to delete collection");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: error instanceof Error ? error.message : String(error),
										message: "Failed to delete variable collection",
										hint: "Make sure the Desktop Bridge plugin is running and the collection ID is correct",
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

		// Tool: Rename a variable
		this.server.tool(
			"figma_rename_variable",
			"Rename an existing Figma variable. This updates the variable's name while preserving all its values and settings. Requires the Desktop Bridge plugin to be running.",
			{
				variableId: z.string().describe(
					"The variable ID to rename (e.g., 'VariableID:123:456'). Get this from figma_get_variables."
				),
				newName: z.string().describe(
					"The new name for the variable. Can include slashes for grouping (e.g., 'colors/primary/background')."
				),
			},
			async ({ variableId, newName }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.renameVariable(variableId, newName);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: `Variable renamed from "${result.oldName}" to "${result.variable.name}"`,
										oldName: result.oldName,
										variable: result.variable,
										timestamp: Date.now(),
									},
									null,
									2,
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to rename variable");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: error instanceof Error ? error.message : String(error),
										message: "Failed to rename variable",
										hint: "Make sure the Desktop Bridge plugin is running and the variable ID is correct",
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

		// Tool: Add a mode to a collection
		this.server.tool(
			"figma_add_mode",
			"Add a new mode to an existing Figma variable collection. Modes allow variables to have different values for different contexts (e.g., Light/Dark themes, device sizes). Requires the Desktop Bridge plugin to be running.",
			{
				collectionId: z.string().describe(
					"The collection ID to add the mode to (e.g., 'VariableCollectionId:123:456'). Get this from figma_get_variables."
				),
				modeName: z.string().describe(
					"The name for the new mode (e.g., 'Dark', 'Mobile', 'High Contrast')."
				),
			},
			async ({ collectionId, modeName }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.addMode(collectionId, modeName);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: `Mode "${modeName}" added to collection "${result.collection.name}"`,
										newMode: result.newMode,
										collection: result.collection,
										timestamp: Date.now(),
									},
									null,
									2,
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to add mode");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: error instanceof Error ? error.message : String(error),
										message: "Failed to add mode to collection",
										hint: "Make sure the Desktop Bridge plugin is running, the collection ID is correct, and you haven't exceeded Figma's mode limit",
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

		// Tool: Rename a mode in a collection
		this.server.tool(
			"figma_rename_mode",
			"Rename an existing mode in a Figma variable collection. Requires the Desktop Bridge plugin to be running.",
			{
				collectionId: z.string().describe(
					"The collection ID containing the mode (e.g., 'VariableCollectionId:123:456'). Get this from figma_get_variables."
				),
				modeId: z.string().describe(
					"The mode ID to rename (e.g., '123:0'). Get this from the collection's modes array in figma_get_variables."
				),
				newName: z.string().describe(
					"The new name for the mode (e.g., 'Dark Theme', 'Tablet')."
				),
			},
			async ({ collectionId, modeId, newName }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.renameMode(collectionId, modeId, newName);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: `Mode renamed from "${result.oldName}" to "${newName}"`,
										oldName: result.oldName,
										collection: result.collection,
										timestamp: Date.now(),
									},
									null,
									2,
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to rename mode");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: error instanceof Error ? error.message : String(error),
										message: "Failed to rename mode",
										hint: "Make sure the Desktop Bridge plugin is running, the collection ID and mode ID are correct",
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

		// ============================================================================
		// DESIGN SYSTEM TOOLS (Token-Efficient Tool Family)
		// ============================================================================
		// These tools provide progressive disclosure of design system data
		// to minimize context window usage. Start with summary, then search,
		// then get details for specific components.

		// Helper function to ensure design system cache is loaded (auto-loads if needed)
		const ensureDesignSystemCache = async (): Promise<{ cacheEntry: any; fileKey: string; wasLoaded: boolean }> => {
			const {
				DesignSystemManifestCache,
				createEmptyManifest,
				figmaColorToHex,
			} = await import('./core/design-system-manifest.js');

			const cache = DesignSystemManifestCache.getInstance();
			const currentUrl = this.browserManager?.getCurrentUrl();
			const fileKeyMatch = currentUrl?.match(/\/(file|design)\/([a-zA-Z0-9]+)/);
			const fileKey = fileKeyMatch ? fileKeyMatch[2] : 'unknown';

			// Check cache first
			let cacheEntry = cache.get(fileKey);
			if (cacheEntry) {
				return { cacheEntry, fileKey, wasLoaded: false };
			}

			// Need to extract fresh data - do this silently without returning an error
			logger.info({ fileKey }, "Auto-loading design system cache");
			const connector = await this.getDesktopConnector();
			const manifest = createEmptyManifest(fileKey);
			manifest.fileUrl = currentUrl || undefined;

			// Get variables (tokens)
			try {
				const variablesResult = await connector.getVariables(fileKey);
				if (variablesResult.success && variablesResult.data) {
					for (const collection of variablesResult.data.variableCollections || []) {
						manifest.collections.push({
							id: collection.id,
							name: collection.name,
							modes: collection.modes.map((m: any) => ({ modeId: m.modeId, name: m.name })),
							defaultModeId: collection.defaultModeId,
						});
					}
					for (const variable of variablesResult.data.variables || []) {
						const tokenName = variable.name;
						const defaultModeId = manifest.collections.find((c: any) => c.id === variable.variableCollectionId)?.defaultModeId;
						const defaultValue = defaultModeId ? variable.valuesByMode?.[defaultModeId] : undefined;

						if (variable.resolvedType === 'COLOR') {
							manifest.tokens.colors[tokenName] = {
								name: tokenName,
								value: figmaColorToHex(defaultValue),
								variableId: variable.id,
								scopes: variable.scopes,
							};
						} else if (variable.resolvedType === 'FLOAT') {
							manifest.tokens.spacing[tokenName] = {
								name: tokenName,
								value: typeof defaultValue === 'number' ? defaultValue : 0,
								variableId: variable.id,
							};
						}
					}
				}
			} catch (error) {
				logger.warn({ error }, "Could not fetch variables during auto-load");
			}

			// Get components
			let rawComponents: { components: any[]; componentSets: any[] } | undefined;
			try {
				const componentsResult = await connector.getLocalComponents();
				if (componentsResult.success && componentsResult.data) {
					rawComponents = {
						components: componentsResult.data.components || [],
						componentSets: componentsResult.data.componentSets || [],
					};
					for (const comp of rawComponents.components) {
						manifest.components[comp.name] = {
							key: comp.key,
							nodeId: comp.nodeId,
							name: comp.name,
							description: comp.description || undefined,
							defaultSize: { width: comp.width, height: comp.height },
						};
					}
					for (const compSet of rawComponents.componentSets) {
						manifest.componentSets[compSet.name] = {
							key: compSet.key,
							nodeId: compSet.nodeId,
							name: compSet.name,
							description: compSet.description || undefined,
							variants: compSet.variants?.map((v: any) => ({
								key: v.key,
								nodeId: v.nodeId,
								name: v.name,
							})) || [],
							variantAxes: compSet.variantAxes?.map((a: any) => ({
								name: a.name,
								values: a.values,
							})) || [],
						};
					}
				}
			} catch (error) {
				logger.warn({ error }, "Could not fetch components during auto-load");
			}

			// Update summary
			manifest.summary = {
				totalTokens: Object.keys(manifest.tokens.colors).length + Object.keys(manifest.tokens.spacing).length,
				totalComponents: Object.keys(manifest.components).length,
				totalComponentSets: Object.keys(manifest.componentSets).length,
				colorPalette: Object.keys(manifest.tokens.colors).slice(0, 10),
				spacingScale: Object.values(manifest.tokens.spacing).map((s: any) => s.value).sort((a: number, b: number) => a - b).slice(0, 10),
				typographyScale: [],
				componentCategories: [],
			};

			// Cache the result
			cache.set(fileKey, manifest, rawComponents);
			cacheEntry = cache.get(fileKey);

			return { cacheEntry, fileKey, wasLoaded: true };
		};

		// Tool 1: Get Design System Summary (~1000 tokens response)
		this.server.tool(
			"figma_get_design_system_summary",
			"Get a compact overview of the design system. Returns categories, component counts, and token collection names WITHOUT full details. Use this first to understand what's available, then use figma_search_components to find specific components. This tool is optimized for minimal token usage.",
			{
				forceRefresh: z.boolean().optional().default(false).describe(
					"Force refresh the cached data (use sparingly - extraction can take minutes for large files)"
				),
			},
			async ({ forceRefresh }) => {
				try {
					const {
						DesignSystemManifestCache,
						createEmptyManifest,
						figmaColorToHex,
						getCategories,
						getTokenSummary,
					} = await import('./core/design-system-manifest.js');

					const cache = DesignSystemManifestCache.getInstance();
					const currentUrl = this.browserManager?.getCurrentUrl();
					const fileKeyMatch = currentUrl?.match(/\/(file|design)\/([a-zA-Z0-9]+)/);
					const fileKey = fileKeyMatch ? fileKeyMatch[2] : 'unknown';

					// Check cache first
					let cacheEntry = cache.get(fileKey);
					if (cacheEntry && !forceRefresh) {
						const categories = getCategories(cacheEntry.manifest);
						const tokenSummary = getTokenSummary(cacheEntry.manifest);
						return {
							content: [{
								type: "text",
								text: JSON.stringify({
									success: true,
									cached: true,
									cacheAge: Math.round((Date.now() - cacheEntry.timestamp) / 1000),
									fileKey,
									categories: categories.slice(0, 15),
									tokens: tokenSummary,
									totals: {
										components: cacheEntry.manifest.summary.totalComponents,
										componentSets: cacheEntry.manifest.summary.totalComponentSets,
										tokens: cacheEntry.manifest.summary.totalTokens,
									},
									hint: "Use figma_search_components to find specific components by name or category.",
								}, null, 2),
							}],
						};
					}

					// Need to extract fresh data
					const connector = await this.getDesktopConnector();
					const manifest = createEmptyManifest(fileKey);
					manifest.fileUrl = currentUrl || undefined;

					// Get variables (tokens)
					try {
						const variablesResult = await connector.getVariables(fileKey);
						if (variablesResult.success && variablesResult.data) {
							for (const collection of variablesResult.data.variableCollections || []) {
								manifest.collections.push({
									id: collection.id,
									name: collection.name,
									modes: collection.modes.map((m: any) => ({ modeId: m.modeId, name: m.name })),
									defaultModeId: collection.defaultModeId,
								});
							}
							for (const variable of variablesResult.data.variables || []) {
								const tokenName = variable.name;
								const defaultModeId = manifest.collections.find(c => c.id === variable.variableCollectionId)?.defaultModeId;
								const defaultValue = defaultModeId ? variable.valuesByMode?.[defaultModeId] : undefined;

								if (variable.resolvedType === 'COLOR') {
									manifest.tokens.colors[tokenName] = {
										name: tokenName,
										value: figmaColorToHex(defaultValue),
										variableId: variable.id,
										scopes: variable.scopes,
									};
								} else if (variable.resolvedType === 'FLOAT') {
									manifest.tokens.spacing[tokenName] = {
										name: tokenName,
										value: typeof defaultValue === 'number' ? defaultValue : 0,
										variableId: variable.id,
									};
								}
							}
						}
					} catch (error) {
						logger.warn({ error }, "Could not fetch variables");
					}

					// Get components (can be slow for large files)
					let rawComponents: { components: any[]; componentSets: any[] } | undefined;
					try {
						const componentsResult = await connector.getLocalComponents();
						if (componentsResult.success && componentsResult.data) {
							rawComponents = {
								components: componentsResult.data.components || [],
								componentSets: componentsResult.data.componentSets || [],
							};
							for (const comp of rawComponents.components) {
								manifest.components[comp.name] = {
									key: comp.key,
									nodeId: comp.nodeId,
									name: comp.name,
									description: comp.description || undefined,
									defaultSize: { width: comp.width, height: comp.height },
								};
							}
							for (const compSet of rawComponents.componentSets) {
								manifest.componentSets[compSet.name] = {
									key: compSet.key,
									nodeId: compSet.nodeId,
									name: compSet.name,
									description: compSet.description || undefined,
									variants: compSet.variants?.map((v: any) => ({
										key: v.key,
										nodeId: v.nodeId,
										name: v.name,
									})) || [],
									variantAxes: compSet.variantAxes?.map((a: any) => ({
										name: a.name,
										values: a.values,
									})) || [],
								};
							}
						}
					} catch (error) {
						logger.warn({ error }, "Could not fetch components");
					}

					// Update summary
					manifest.summary = {
						totalTokens: Object.keys(manifest.tokens.colors).length + Object.keys(manifest.tokens.spacing).length,
						totalComponents: Object.keys(manifest.components).length,
						totalComponentSets: Object.keys(manifest.componentSets).length,
						colorPalette: Object.keys(manifest.tokens.colors).slice(0, 10),
						spacingScale: Object.values(manifest.tokens.spacing).map(s => s.value).sort((a, b) => a - b).slice(0, 10),
						typographyScale: [],
						componentCategories: [],
					};

					// Cache the result
					cache.set(fileKey, manifest, rawComponents);

					const categories = getCategories(manifest);
					const tokenSummary = getTokenSummary(manifest);

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								success: true,
								cached: false,
								fileKey,
								categories: categories.slice(0, 15),
								tokens: tokenSummary,
								totals: {
									components: manifest.summary.totalComponents,
									componentSets: manifest.summary.totalComponentSets,
									tokens: manifest.summary.totalTokens,
								},
								hint: "Use figma_search_components to find specific components by name or category.",
							}, null, 2),
						}],
					};
				} catch (error) {
					logger.error({ error }, "Failed to get design system summary");
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "Make sure the Desktop Bridge plugin is running in Figma",
							}, null, 2),
						}],
						isError: true,
					};
				}
			},
		);

		// Tool 2: Search Components (~3000 tokens response max, paginated)
		this.server.tool(
			"figma_search_components",
			"Search for components by name, category, or description. Returns paginated results with component keys for instantiation. Automatically loads the design system cache if needed.",
			{
				query: z.string().optional().default("").describe(
					"Search query to match component names or descriptions"
				),
				category: z.string().optional().describe(
					"Filter by category (e.g., 'Button', 'Input', 'Card')"
				),
				limit: z.number().optional().default(10).describe(
					"Maximum results to return (default: 10, max: 25)"
				),
				offset: z.number().optional().default(0).describe(
					"Offset for pagination"
				),
			},
			async ({ query, category, limit, offset }) => {
				try {
					const { searchComponents } = await import('./core/design-system-manifest.js');

					// Auto-load design system cache if needed (no error returned to user)
					const { cacheEntry } = await ensureDesignSystemCache();
					if (!cacheEntry) {
						return {
							content: [{
								type: "text",
								text: JSON.stringify({
									error: "Could not load design system data. Make sure the Desktop Bridge plugin is running.",
								}, null, 2),
							}],
							isError: true,
						};
					}

					const effectiveLimit = Math.min(limit || 10, 25);
					const results = searchComponents(cacheEntry.manifest, query || "", {
						category,
						limit: effectiveLimit,
						offset: offset || 0,
					});

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								success: true,
								query: query || "(all)",
								category: category || "(all)",
								results: results.results,
								pagination: {
									offset: offset || 0,
									limit: effectiveLimit,
									total: results.total,
									hasMore: results.hasMore,
								},
								hint: results.hasMore
									? `Use offset=${(offset || 0) + effectiveLimit} to get more results.`
									: "Use figma_get_component_details with a component key for full details.",
							}, null, 2),
						}],
					};
				} catch (error) {
					logger.error({ error }, "Failed to search components");
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}, null, 2),
						}],
						isError: true,
					};
				}
			},
		);

		// Tool 3: Get Component Details (~500 tokens per component)
		this.server.tool(
			"figma_get_component_details",
			"Get full details for a specific component including all variants, properties, and keys needed for instantiation. Use the component key or name from figma_search_components.",
			{
				componentKey: z.string().optional().describe(
					"The component key (preferred for exact match)"
				),
				componentName: z.string().optional().describe(
					"The component name (used if key not provided)"
				),
			},
			async ({ componentKey, componentName }) => {
				try {
					if (!componentKey && !componentName) {
						return {
							content: [{
								type: "text",
								text: JSON.stringify({
									error: "Either componentKey or componentName is required",
								}, null, 2),
							}],
							isError: true,
						};
					}

					// Auto-load design system cache if needed
					const { cacheEntry } = await ensureDesignSystemCache();
					if (!cacheEntry) {
						return {
							content: [{
								type: "text",
								text: JSON.stringify({
									error: "Could not load design system data. Make sure the Desktop Bridge plugin is running.",
								}, null, 2),
							}],
							isError: true,
						};
					}

					// Search for the component
					let component: any = null;
					let isComponentSet = false;

					// Check component sets first (they have variants)
					for (const [name, compSet] of Object.entries(cacheEntry.manifest.componentSets) as [string, any][]) {
						if ((componentKey && compSet.key === componentKey) || (componentName && name === componentName)) {
							component = compSet;
							isComponentSet = true;
							break;
						}
					}

					// Check standalone components
					if (!component) {
						for (const [name, comp] of Object.entries(cacheEntry.manifest.components) as [string, any][]) {
							if ((componentKey && comp.key === componentKey) || (componentName && name === componentName)) {
								component = comp;
								break;
							}
						}
					}

					if (!component) {
						return {
							content: [{
								type: "text",
								text: JSON.stringify({
									error: `Component not found: ${componentKey || componentName}`,
									hint: "Use figma_search_components to find available components.",
								}, null, 2),
							}],
							isError: true,
						};
					}

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								success: true,
								type: isComponentSet ? "componentSet" : "component",
								component,
								instantiation: {
									key: component.key,
									example: `Use figma_instantiate_component with componentKey: "${component.key}"`,
								},
							}, null, 2),
						}],
					};
				} catch (error) {
					logger.error({ error }, "Failed to get component details");
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}, null, 2),
						}],
						isError: true,
					};
				}
			},
		);

		// Tool 4: Get Token Values (~2000 tokens response max)
		this.server.tool(
			"figma_get_token_values",
			"Get actual values for design tokens (colors, spacing, etc). Use after figma_get_design_system_summary to get specific token values for implementation.",
			{
				type: z.enum(["colors", "spacing", "all"]).optional().default("all").describe(
					"Type of tokens to retrieve"
				),
				filter: z.string().optional().describe(
					"Filter token names (e.g., 'primary' to get all primary colors)"
				),
				limit: z.number().optional().default(50).describe(
					"Maximum tokens to return (default: 50)"
				),
			},
			async ({ type, filter, limit }) => {
				try {
					// Auto-load design system cache if needed
					const { cacheEntry } = await ensureDesignSystemCache();
					if (!cacheEntry) {
						return {
							content: [{
								type: "text",
								text: JSON.stringify({
									error: "Could not load design system data. Make sure the Desktop Bridge plugin is running.",
								}, null, 2),
							}],
							isError: true,
						};
					}

					const tokens = cacheEntry.manifest.tokens;
					const effectiveLimit = Math.min(limit || 50, 100);
					const filterLower = filter?.toLowerCase();

					const result: Record<string, any> = {};

					if (type === "colors" || type === "all") {
						const colors: Record<string, any> = {};
						let count = 0;
						for (const [name, token] of Object.entries(tokens.colors) as [string, any][]) {
							if (count >= effectiveLimit) break;
							if (!filterLower || name.toLowerCase().includes(filterLower)) {
								colors[name] = { value: token.value, scopes: token.scopes };
								count++;
							}
						}
						result.colors = colors;
					}

					if (type === "spacing" || type === "all") {
						const spacing: Record<string, any> = {};
						let count = 0;
						for (const [name, token] of Object.entries(tokens.spacing) as [string, any][]) {
							if (count >= effectiveLimit) break;
							if (!filterLower || name.toLowerCase().includes(filterLower)) {
								spacing[name] = { value: token.value };
								count++;
							}
						}
						result.spacing = spacing;
					}

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								success: true,
								type,
								filter: filter || "(none)",
								tokens: result,
								hint: "Use these exact token names and values when generating designs.",
							}, null, 2),
						}],
					};
				} catch (error) {
					logger.error({ error }, "Failed to get token values");
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}, null, 2),
						}],
						isError: true,
					};
				}
			},
		);

		// Tool 5: Instantiate Component
		this.server.tool(
			"figma_instantiate_component",
			`Create an instance of a component from the design system. Works with both published library components (by key) and local/unpublished components (by nodeId).

**IMPORTANT: Always re-search before instantiating!**
NodeIds are session-specific and may be stale from previous conversations. ALWAYS call figma_search_components at the start of each design session to get current, valid identifiers.

**VISUAL VALIDATION WORKFLOW:**
After instantiating components, use figma_take_screenshot to verify the result looks correct. Check placement, sizing, and visual balance.`,
			{
				componentKey: z.string().optional().describe(
					"The component key (for published library components). Get this from figma_search_components."
				),
				nodeId: z.string().optional().describe(
					"The node ID (for local/unpublished components). Get this from figma_search_components. Required if componentKey doesn't work."
				),
				variant: z.record(z.string()).optional().describe(
					"Variant properties to set (e.g., { Type: 'Simple', State: 'Active' })"
				),
				overrides: z.record(z.any()).optional().describe(
					"Property overrides (e.g., { 'Button Label': 'Click Me' })"
				),
				position: z.object({
					x: z.number(),
					y: z.number(),
				}).optional().describe(
					"Position on canvas (default: 0, 0)"
				),
				parentId: z.string().optional().describe(
					"Parent node ID to append the instance to"
				),
			},
			async ({ componentKey, nodeId, variant, overrides, position, parentId }) => {
				try {
					if (!componentKey && !nodeId) {
						throw new Error("Either componentKey or nodeId is required");
					}
					const connector = await this.getDesktopConnector();
					const result = await connector.instantiateComponent(componentKey || "", {
						nodeId,
						position,
						overrides,
						variant,
						parentId,
					});

					if (!result.success) {
						throw new Error(result.error || "Failed to instantiate component");
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: "Component instantiated successfully",
										instance: result.instance,
										timestamp: Date.now(),
									},
									null,
									2,
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to instantiate component");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: error instanceof Error ? error.message : String(error),
										message: "Failed to instantiate component",
										hint: "Make sure the component key is correct and the Desktop Bridge plugin is running",
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

		// ============================================================================
		// NEW: Component Property Management Tools
		// ============================================================================

		// Tool: Set Node Description
		this.server.tool(
			"figma_set_description",
			"Set the description text on a component, component set, or style. Descriptions appear in Dev Mode and help document design intent. Supports plain text and markdown formatting.",
			{
				nodeId: z.string().describe(
					"The node ID of the component or style to update (e.g., '123:456')"
				),
				description: z.string().describe(
					"The plain text description to set"
				),
				descriptionMarkdown: z.string().optional().describe(
					"Optional rich text description using markdown formatting"
				),
			},
			async ({ nodeId, description, descriptionMarkdown }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.setNodeDescription(nodeId, description, descriptionMarkdown);

					if (!result.success) {
						throw new Error(result.error || "Failed to set description");
					}

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: "Description set successfully",
								node: result.node,
							}, null, 2),
						}],
					};
				} catch (error) {
					logger.error({ error }, "Failed to set description");
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "Make sure the node supports descriptions (components, component sets, styles)",
							}, null, 2),
						}],
						isError: true,
					};
				}
			},
		);

		// Tool: Add Component Property
		this.server.tool(
			"figma_add_component_property",
			"Add a new component property to a component or component set. Properties enable dynamic content and behavior in component instances. Supported types: BOOLEAN (toggle), TEXT (string), INSTANCE_SWAP (component swap), VARIANT (variant selection).",
			{
				nodeId: z.string().describe(
					"The component or component set node ID"
				),
				propertyName: z.string().describe(
					"Name for the new property (e.g., 'Show Icon', 'Button Label')"
				),
				type: z.enum(["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT"]).describe(
					"Property type: BOOLEAN for toggles, TEXT for strings, INSTANCE_SWAP for component swaps, VARIANT for variant selection"
				),
				defaultValue: z.any().describe(
					"Default value for the property. BOOLEAN: true/false, TEXT: string, INSTANCE_SWAP: component key, VARIANT: variant value"
				),
			},
			async ({ nodeId, propertyName, type, defaultValue }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.addComponentProperty(nodeId, propertyName, type, defaultValue);

					if (!result.success) {
						throw new Error(result.error || "Failed to add property");
					}

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: "Component property added",
								propertyName: result.propertyName,
								hint: "The property name includes a unique suffix (e.g., 'Show Icon#123:456'). Use the full name for editing/deleting.",
							}, null, 2),
						}],
					};
				} catch (error) {
					logger.error({ error }, "Failed to add component property");
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "Cannot add properties to variant components. Add to the parent component set instead.",
							}, null, 2),
						}],
						isError: true,
					};
				}
			},
		);

		// Tool: Edit Component Property
		this.server.tool(
			"figma_edit_component_property",
			"Edit an existing component property. Can change the name, default value, or preferred values (for INSTANCE_SWAP). Use the full property name including the unique suffix.",
			{
				nodeId: z.string().describe(
					"The component or component set node ID"
				),
				propertyName: z.string().describe(
					"The full property name with suffix (e.g., 'Show Icon#123:456')"
				),
				newValue: z.object({
					name: z.string().optional().describe("New name for the property"),
					defaultValue: z.any().optional().describe("New default value"),
					preferredValues: z.array(z.any()).optional().describe("Preferred values (INSTANCE_SWAP only)"),
				}).describe("Object with the values to update"),
			},
			async ({ nodeId, propertyName, newValue }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.editComponentProperty(nodeId, propertyName, newValue);

					if (!result.success) {
						throw new Error(result.error || "Failed to edit property");
					}

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: "Component property updated",
								propertyName: result.propertyName,
							}, null, 2),
						}],
					};
				} catch (error) {
					logger.error({ error }, "Failed to edit component property");
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}, null, 2),
						}],
						isError: true,
					};
				}
			},
		);

		// Tool: Delete Component Property
		this.server.tool(
			"figma_delete_component_property",
			"Delete a component property. Only works with BOOLEAN, TEXT, and INSTANCE_SWAP properties (not VARIANT). This is a destructive operation.",
			{
				nodeId: z.string().describe(
					"The component or component set node ID"
				),
				propertyName: z.string().describe(
					"The full property name with suffix (e.g., 'Show Icon#123:456')"
				),
			},
			async ({ nodeId, propertyName }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.deleteComponentProperty(nodeId, propertyName);

					if (!result.success) {
						throw new Error(result.error || "Failed to delete property");
					}

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: "Component property deleted",
							}, null, 2),
						}],
					};
				} catch (error) {
					logger.error({ error }, "Failed to delete component property");
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "Cannot delete VARIANT properties. Only BOOLEAN, TEXT, and INSTANCE_SWAP can be deleted.",
							}, null, 2),
						}],
						isError: true,
					};
				}
			},
		);

		// ============================================================================
		// NEW: Node Manipulation Tools
		// ============================================================================

		// Tool: Resize Node
		this.server.tool(
			"figma_resize_node",
			"Resize a node to specific dimensions. By default respects child constraints; use withConstraints=false to ignore them.",
			{
				nodeId: z.string().describe("The node ID to resize"),
				width: z.number().describe("New width in pixels"),
				height: z.number().describe("New height in pixels"),
				withConstraints: z.boolean().optional().default(true).describe(
					"Whether to apply child constraints during resize (default: true)"
				),
			},
			async ({ nodeId, width, height, withConstraints }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.resizeNode(nodeId, width, height, withConstraints);

					if (!result.success) {
						throw new Error(result.error || "Failed to resize node");
					}

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: `Node resized to ${width}x${height}`,
								node: result.node,
							}, null, 2),
						}],
					};
				} catch (error) {
					logger.error({ error }, "Failed to resize node");
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}, null, 2),
						}],
						isError: true,
					};
				}
			},
		);

		// Tool: Move Node
		this.server.tool(
			"figma_move_node",
			"Move a node to a new position within its parent.",
			{
				nodeId: z.string().describe("The node ID to move"),
				x: z.number().describe("New X position"),
				y: z.number().describe("New Y position"),
			},
			async ({ nodeId, x, y }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.moveNode(nodeId, x, y);

					if (!result.success) {
						throw new Error(result.error || "Failed to move node");
					}

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: `Node moved to (${x}, ${y})`,
								node: result.node,
							}, null, 2),
						}],
					};
				} catch (error) {
					logger.error({ error }, "Failed to move node");
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}, null, 2),
						}],
						isError: true,
					};
				}
			},
		);

		// Tool: Set Node Fills
		this.server.tool(
			"figma_set_fills",
			"Set the fill colors on a node. Accepts hex color strings (e.g., '#FF0000') or full paint objects.",
			{
				nodeId: z.string().describe("The node ID to modify"),
				fills: z.array(z.object({
					type: z.literal("SOLID").describe("Fill type (currently only SOLID supported)"),
					color: z.string().describe("Hex color string (e.g., '#FF0000', '#FF000080' for transparency)"),
					opacity: z.number().optional().describe("Opacity 0-1 (default: 1)"),
				})).describe("Array of fill objects"),
			},
			async ({ nodeId, fills }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.setNodeFills(nodeId, fills);

					if (!result.success) {
						throw new Error(result.error || "Failed to set fills");
					}

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: "Fills updated",
								node: result.node,
							}, null, 2),
						}],
					};
				} catch (error) {
					logger.error({ error }, "Failed to set fills");
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}, null, 2),
						}],
						isError: true,
					};
				}
			},
		);

		// Tool: Set Node Strokes
		this.server.tool(
			"figma_set_strokes",
			"Set the stroke (border) on a node. Accepts hex color strings and optional stroke weight.",
			{
				nodeId: z.string().describe("The node ID to modify"),
				strokes: z.array(z.object({
					type: z.literal("SOLID").describe("Stroke type"),
					color: z.string().describe("Hex color string"),
					opacity: z.number().optional().describe("Opacity 0-1"),
				})).describe("Array of stroke objects"),
				strokeWeight: z.number().optional().describe("Stroke thickness in pixels"),
			},
			async ({ nodeId, strokes, strokeWeight }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.setNodeStrokes(nodeId, strokes, strokeWeight);

					if (!result.success) {
						throw new Error(result.error || "Failed to set strokes");
					}

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: "Strokes updated",
								node: result.node,
							}, null, 2),
						}],
					};
				} catch (error) {
					logger.error({ error }, "Failed to set strokes");
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}, null, 2),
						}],
						isError: true,
					};
				}
			},
		);

		// Tool: Clone Node
		this.server.tool(
			"figma_clone_node",
			"Duplicate a node. The clone is placed at a slight offset from the original.",
			{
				nodeId: z.string().describe("The node ID to clone"),
			},
			async ({ nodeId }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.cloneNode(nodeId);

					if (!result.success) {
						throw new Error(result.error || "Failed to clone node");
					}

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: "Node cloned",
								clonedNode: result.node,
							}, null, 2),
						}],
					};
				} catch (error) {
					logger.error({ error }, "Failed to clone node");
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}, null, 2),
						}],
						isError: true,
					};
				}
			},
		);

		// Tool: Delete Node
		this.server.tool(
			"figma_delete_node",
			"Delete a node from the canvas. WARNING: This is a destructive operation (can be undone with Figma's undo).",
			{
				nodeId: z.string().describe("The node ID to delete"),
			},
			async ({ nodeId }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.deleteNode(nodeId);

					if (!result.success) {
						throw new Error(result.error || "Failed to delete node");
					}

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: "Node deleted",
								deleted: result.deleted,
							}, null, 2),
						}],
					};
				} catch (error) {
					logger.error({ error }, "Failed to delete node");
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}, null, 2),
						}],
						isError: true,
					};
				}
			},
		);

		// Tool: Rename Node
		this.server.tool(
			"figma_rename_node",
			"Rename a node in the layer panel.",
			{
				nodeId: z.string().describe("The node ID to rename"),
				newName: z.string().describe("The new name for the node"),
			},
			async ({ nodeId, newName }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.renameNode(nodeId, newName);

					if (!result.success) {
						throw new Error(result.error || "Failed to rename node");
					}

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: `Node renamed to "${newName}"`,
								node: result.node,
							}, null, 2),
						}],
					};
				} catch (error) {
					logger.error({ error }, "Failed to rename node");
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}, null, 2),
						}],
						isError: true,
					};
				}
			},
		);

		// Tool: Set Text Content
		this.server.tool(
			"figma_set_text",
			"Set the text content of a text node. Optionally adjust font size.",
			{
				nodeId: z.string().describe("The text node ID"),
				text: z.string().describe("The new text content"),
				fontSize: z.number().optional().describe("Optional font size to set"),
			},
			async ({ nodeId, text, fontSize }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.setTextContent(nodeId, text, fontSize ? { fontSize } : undefined);

					if (!result.success) {
						throw new Error(result.error || "Failed to set text");
					}

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: "Text content updated",
								node: result.node,
							}, null, 2),
						}],
					};
				} catch (error) {
					logger.error({ error }, "Failed to set text content");
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "Make sure the node is a TEXT node",
							}, null, 2),
						}],
						isError: true,
					};
				}
			},
		);

		// Tool: Create Child Node
		this.server.tool(
			"figma_create_child",
			"Create a new child node inside a parent container. Useful for adding shapes, text, or frames to existing structures.",
			{
				parentId: z.string().describe("The parent node ID"),
				nodeType: z.enum(["RECTANGLE", "ELLIPSE", "FRAME", "TEXT", "LINE"]).describe(
					"Type of node to create"
				),
				properties: z.object({
					name: z.string().optional().describe("Name for the new node"),
					x: z.number().optional().describe("X position within parent"),
					y: z.number().optional().describe("Y position within parent"),
					width: z.number().optional().describe("Width (default: 100)"),
					height: z.number().optional().describe("Height (default: 100)"),
					fills: z.array(z.object({
						type: z.literal("SOLID"),
						color: z.string(),
					})).optional().describe("Fill colors (hex strings)"),
					text: z.string().optional().describe("Text content (for TEXT nodes only)"),
				}).optional().describe("Properties for the new node"),
			},
			async ({ parentId, nodeType, properties }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.createChildNode(parentId, nodeType, properties);

					if (!result.success) {
						throw new Error(result.error || "Failed to create node");
					}

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: `Created ${nodeType} node`,
								node: result.node,
							}, null, 2),
						}],
					};
				} catch (error) {
					logger.error({ error }, "Failed to create child node");
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "Make sure the parent node supports children (frames, groups, etc.)",
							}, null, 2),
						}],
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

		logger.info("All MCP tools registered successfully (including write operations)");
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

			// 🆕 AUTO-CONNECT: Start monitoring immediately if Figma Desktop is available
			// This enables "get latest logs" workflow without requiring manual setup
			this.autoConnectToFigma();
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
// Note: On Windows, import.meta.url uses file:/// (3 slashes) while process.argv uses backslashes
// We normalize both paths to compare correctly across platforms
const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? resolve(process.argv[1]) : "";

if (currentFile === entryFile) {
	main().catch((error) => {
		console.error("Fatal error:", error);
		process.exit(1);
	});
}

export { LocalFigmaConsoleMCP };
