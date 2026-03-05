#!/usr/bin/env node

/**
 * Figma Console MCP Server - Local Mode
 *
 * Entry point for local MCP server that connects to Figma Desktop
 * via the WebSocket Desktop Bridge plugin.
 *
 * This implementation uses stdio transport for MCP communication,
 * suitable for local IDE integrations and development workflows.
 *
 * Requirements:
 * - Desktop Bridge plugin open in Figma (Plugins → Development → Figma Desktop Bridge)
 * - FIGMA_ACCESS_TOKEN environment variable for API access
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { realpathSync, existsSync } from "fs";
import { LocalBrowserManager } from "./browser/local.js";
import { ConsoleMonitor } from "./core/console-monitor.js";
import { getConfig } from "./core/config.js";
import { createChildLogger } from "./core/logger.js";
import {
	FigmaAPI,
	extractFileKey,
	extractFigmaUrlInfo,
	formatVariables,
} from "./core/figma-api.js";
import { registerFigmaAPITools } from "./core/figma-tools.js";
import { registerDesignCodeTools } from "./core/design-code-tools.js";
import { registerCommentTools } from "./core/comment-tools.js";
import { registerDesignSystemTools } from "./core/design-system-tools.js";
import { FigmaDesktopConnector } from "./core/figma-desktop-connector.js";
import type { IFigmaConnector } from "./core/figma-connector.js";
import { registerBridgeTools } from "./core/bridge-tools.js";
import { FigmaWebSocketServer } from "./core/websocket-server.js";
import { WebSocketConnector } from "./core/websocket-connector.js";
import {
	DEFAULT_WS_PORT,
	getPortRange,
	advertisePort,
	unadvertisePort,
	registerPortCleanup,
	discoverActiveInstances,
	cleanupStalePortFiles,
} from "./core/port-discovery.js";
import { registerTokenBrowserApp } from "./apps/token-browser/server.js";
import { registerDesignSystemDashboardApp } from "./apps/design-system-dashboard/server.js";

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
	private desktopConnector: IFigmaConnector | null = null;
	private wsServer: FigmaWebSocketServer | null = null;
	private wsStartupError: { code: string; port: number } | null = null;
	/** The port the WebSocket server actually bound to (may differ from preferred if fallback occurred) */
	private wsActualPort: number | null = null;
	/** The preferred port requested (from env var or default) */
	private wsPreferredPort: number = DEFAULT_WS_PORT;
	private config = getConfig();

	// In-memory cache for variables data to avoid MCP token limits
	// Maps fileKey -> {data, timestamp}
	private variablesCache: Map<
		string,
		{
			data: any;
			timestamp: number;
		}
	> = new Map();

	constructor() {
		this.server = new McpServer(
			{
				name: "Figma Console MCP (Local)",
				version: "0.1.0",
			},
			{
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
- Items not centered properly in their containers
- Components floating on blank canvas - always place within a Section or Frame

### COMPONENT PLACEMENT (REQUIRED)
Before creating ANY component, check for or create a proper parent container:
1. First, check if a Section or Frame already exists on the current page
2. If no container exists, create a Section first (e.g., "Design Components")
3. Place all new components INSIDE the Section/Frame, not on blank canvas
4. This keeps designs organized and prevents "floating" components

Example pattern:
\`\`\`javascript
// Find or create a Section for components
let section = figma.currentPage.findOne(n => n.type === 'SECTION' && n.name === 'Components');
if (!section) {
  section = figma.createSection();
  section.name = 'Components';
  section.x = 0;
  section.y = 0;
}
// Now create your component INSIDE the section
const frame = figma.createFrame();
section.appendChild(frame);
\`\`\`

### BATCH OPERATIONS (Performance Critical)
When creating or updating **multiple variables**, ALWAYS prefer batch tools over repeated individual calls:
- **figma_batch_create_variables**: Create up to 100 variables in one call (vs. N calls to figma_create_variable)
- **figma_batch_update_variables**: Update up to 100 variable values in one call (vs. N calls to figma_update_variable)
- **figma_setup_design_tokens**: Create a complete token system (collection + modes + variables) atomically in one call

Batch tools are 10-50x faster because they execute in a single roundtrip. Use individual tools only for one-off operations.

### DESIGN BEST PRACTICES
For component-specific design guidance (sizing, proportions, accessibility, etc.), query the Design Systems Assistant MCP which provides up-to-date best practices for any component type.

If Design Systems Assistant MCP is not available, install it from: https://github.com/southleft/design-systems-mcp`,
			},
		);
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
						"Get your token at: https://www.figma.com/developers/api#access-tokens",
				);
			}

			logger.info(
				{
					tokenPreview: `${accessToken.substring(0, 10)}...`,
					tokenLength: accessToken.length,
				},
				"Initializing Figma API with token from environment",
			);

			this.figmaAPI = new FigmaAPI({ accessToken });
		}

		return this.figmaAPI;
	}

	/**
	 * Get or create Desktop Connector for write operations.
	 * Returns the active WebSocket Desktop Bridge connector.
	 */
	private async getDesktopConnector(): Promise<IFigmaConnector> {
		// Try WebSocket first — instant check, no network timeout delay
		if (this.wsServer?.isClientConnected()) {
			try {
				const wsConnector = new WebSocketConnector(this.wsServer);
				await wsConnector.initialize();
				this.desktopConnector = wsConnector;
				logger.debug("Desktop connector initialized via WebSocket bridge");
				return this.desktopConnector;
			} catch (wsError) {
				const errorMsg = wsError instanceof Error ? wsError.message : String(wsError);
				logger.debug({ error: errorMsg }, "WebSocket connector init failed, trying legacy fallback");
			}
		}

		// Legacy fallback path
		try {
			await this.ensureInitialized();

			if (this.browserManager) {
				// Always get a fresh page reference to handle page navigation/refresh
				const page = await this.browserManager.getPage();

				// Always recreate the connector with the current page to avoid stale references
				// This prevents "detached Frame" errors when Figma page is refreshed
				const cdpConnector = new FigmaDesktopConnector(page);
				await cdpConnector.initialize();
				this.desktopConnector = cdpConnector;
				logger.debug("Desktop connector initialized via legacy fallback with fresh page reference");
				return this.desktopConnector;
			}
		} catch (cdpError) {
			const errorMsg = cdpError instanceof Error ? cdpError.message : String(cdpError);
			logger.debug({ error: errorMsg }, "Legacy fallback connection also unavailable");
		}

		const wsPort = this.wsActualPort || this.wsPreferredPort || DEFAULT_WS_PORT;
		throw new Error(
			"Cannot connect to Figma Desktop.\n\n" +
			"Open the Desktop Bridge plugin in Figma (Plugins → Development → Figma Desktop Bridge).\n" +
			`The plugin will connect automatically to ws://localhost:${wsPort}.\n` +
			"No special launch flags needed."
		);
	}

	/**
	 * Get the current Figma file URL from the best available source.
	 * Priority: Browser URL (full URL with branch/node info) → WebSocket file identity (synthesized URL).
	 * The synthesized URL is compatible with extractFileKey() and extractFigmaUrlInfo().
	 */
	private getCurrentFileUrl(): string | null {
		// Priority 1: Browser URL (full URL with branch/node info)
		const browserUrl = this.browserManager?.getCurrentUrl() || null;
		if (browserUrl) return browserUrl;

		// Priority 2: Synthesize URL from WebSocket file identity
		const wsFileInfo = this.wsServer?.getConnectedFileInfo() ?? null;
		if (wsFileInfo?.fileKey) {
			const pageIdParam = wsFileInfo.currentPageId
				? `?node-id=${wsFileInfo.currentPageId.replace(/:/g, '-')}`
				: '';
			return `https://www.figma.com/design/${wsFileInfo.fileKey}/${encodeURIComponent(wsFileInfo.fileName || 'Untitled')}${pageIdParam}`;
		}

		return null;
	}

	/**
	 * Check if Figma Desktop is accessible via WebSocket
	 */
	private async checkFigmaDesktop(): Promise<void> {
		if (!this.config.local) {
			throw new Error("Local mode configuration missing");
		}

		// Check WebSocket availability
		const wsAvailable = this.wsServer?.isClientConnected() ?? false;

		if (wsAvailable) {
			logger.info("Transport: WebSocket bridge connected");
		} else {
			// Not available yet — log guidance but don't throw
			// The user may open the plugin later
			logger.warn(
				`WebSocket transport not available yet.\n\n` +
				`Open the Desktop Bridge plugin in Figma (Plugins → Development → Figma Desktop Bridge).\n` +
				`No special launch flags needed — the plugin connects automatically.`,
			);
		}
	}

	/**
	 * Resolve the path to the Desktop Bridge plugin manifest.
	 * Works for both NPX installs (buried in npm cache) and local git clones.
	 */
	private getPluginPath(): string | null {
		try {
			const thisFile = fileURLToPath(import.meta.url);
			// From dist/local.js → go up to package root, then into figma-desktop-bridge
			const packageRoot = dirname(dirname(thisFile));
			const manifestPath = resolve(packageRoot, "figma-desktop-bridge", "manifest.json");
			return existsSync(manifestPath) ? manifestPath : null;
		} catch {
			return null;
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
				logger.info(
					"🔄 Auto-connecting to Figma Desktop for immediate log capture...",
				);
				await this.ensureInitialized();
				logger.info(
					"✅ Auto-connect successful - console monitoring active. Logs will be captured immediately.",
				);
			} catch (error) {
				// Don't crash - just log that auto-connect didn't work
				const errorMsg = error instanceof Error ? error.message : String(error);
				logger.warn(
					{ error: errorMsg },
					"⚠️ Auto-connect to Figma Desktop failed - will connect when you use a tool",
				);
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
				if (
					this.browserManager.isRunning() &&
					this.consoleMonitor.getStatus().isMonitoring
				) {
					const browser = (this.browserManager as any).browser;

					if (browser) {
						try {
							// Get all Figma pages
							const pages = await browser.pages();
							const figmaPages = pages
								.filter((p: any) => {
									const url = p.url();
									return url.includes("figma.com") && !url.includes("devtools");
								})
								.map((p: any) => ({
									page: p,
									url: p.url(),
									workerCount: p.workers().length,
								}));

							// Find current monitored page URL
							const currentUrl = this.browserManager.getCurrentUrl();
							const currentPageInfo = figmaPages.find(
								(p: { page: any; url: string; workerCount: number }) =>
									p.url === currentUrl,
							);
							const currentWorkerCount = currentPageInfo?.workerCount ?? 0;

							// Find best page (most workers)
							const bestPage = figmaPages
								.filter(
									(p: { page: any; url: string; workerCount: number }) =>
										p.workerCount > 0,
								)
								.sort(
									(
										a: { page: any; url: string; workerCount: number },
										b: { page: any; url: string; workerCount: number },
									) => b.workerCount - a.workerCount,
								)[0];

							// Switch if:
							// 1. Current page has 0 workers AND another page has workers
							// 2. Another page has MORE workers (prevent thrashing with threshold)
							const shouldSwitch =
								bestPage &&
								((currentWorkerCount === 0 && bestPage.workerCount > 0) ||
									bestPage.workerCount > currentWorkerCount + 1); // +1 threshold to prevent ping-pong

							if (shouldSwitch && bestPage.url !== currentUrl) {
								logger.info(
									{
										oldPage: currentUrl,
										oldWorkers: currentWorkerCount,
										newPage: bestPage.url,
										newWorkers: bestPage.workerCount,
									},
									"Switching to page with more workers",
								);

								// Stop monitoring old page
								this.consoleMonitor.stopMonitoring();

								// Start monitoring new page
								await this.consoleMonitor.startMonitoring(bestPage.page);

								// Don't clear logs - preserve history across page switches
								logger.info("Console monitoring restarted on new page");
							}
						} catch (error) {
							logger.error(
								{ error },
								"Failed to check for better pages with workers",
							);
							// Don't throw - this is a best-effort optimization
						}
					}
				}

				// If connection was lost and browser is now connected, FORCE restart monitoring
				// Note: Can't use isConnectionAlive() here because page might not be fetched yet after reconnection
				// Instead, check if browser is connected using isRunning()
				if (!wasAlive && this.browserManager.isRunning()) {
					logger.info(
						"Connection was lost and recovered - forcing monitoring restart with fresh page",
					);
					this.consoleMonitor.stopMonitoring(); // Clear stale state
					const page = await this.browserManager.getPage();
					await this.consoleMonitor.startMonitoring(page);
				} else if (
					this.browserManager.isRunning() &&
					!this.consoleMonitor.getStatus().isMonitoring
				) {
					// Connection is fine but monitoring stopped for some reason
					logger.info(
						"Connection alive but monitoring stopped - restarting console monitoring",
					);
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
			throw new Error(
				`Initialization failed: ${error instanceof Error ? error.message : String(error)}`,
			);
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
				count: z
					.number()
					.optional()
					.default(100)
					.describe("Number of recent logs to retrieve"),
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
					// Try console monitor first, fall back to WebSocket console buffer
					let logs: import("./core/types/index.js").ConsoleLogEntry[];
					let status: ReturnType<import("./core/console-monitor.js").ConsoleMonitor["getStatus"]> | ReturnType<NonNullable<typeof this.wsServer>["getConsoleStatus"]>;
					let source: "cdp" | "websocket" = "cdp";

					if (this.consoleMonitor?.getStatus().isMonitoring) {
						// Console monitor is active — use it (captures all page logs)
						logs = this.consoleMonitor.getLogs({ count, level, since });
						status = this.consoleMonitor.getStatus();
					} else if (this.wsServer?.isClientConnected()) {
						// WebSocket fallback — plugin-captured console logs
						logs = this.wsServer.getConsoleLogs({ count, level, since });
						status = this.wsServer.getConsoleStatus();
						source = "websocket";
					} else {
						// Neither available — try to initialize
						try {
							await this.ensureInitialized();
							if (this.consoleMonitor) {
								logs = this.consoleMonitor.getLogs({ count, level, since });
								status = this.consoleMonitor.getStatus();
							} else {
								throw new Error("Console monitor not initialized");
							}
						} catch {
							throw new Error(
								"No console monitoring available. Open the Desktop Bridge plugin in Figma for console capture.",
							);
						}
					}

					const responseData: any = {
						logs,
						totalCount: logs.length,
						oldestTimestamp: logs[0]?.timestamp,
						newestTimestamp: logs[logs.length - 1]?.timestamp,
						status,
						transport: source,
					};

					if (source === "websocket") {
						responseData.ai_instruction =
							"Console logs captured via WebSocket Bridge (plugin sandbox only). These logs include output from the Desktop Bridge plugin's code.js context.";
					}

					if (logs.length === 0) {
						if (source === "websocket") {
							responseData.ai_instruction =
								"No console logs captured yet via WebSocket. The Desktop Bridge plugin is connected and monitoring. Plugin console output (console.log/warn/error from code.js) will appear here automatically. Try running a design operation that triggers plugin logging.";
						} else {
							const isMonitoring = (status as any).isMonitoring;
							if (!isMonitoring) {
								responseData.ai_instruction =
									"Console monitoring is not active (likely lost connection after computer sleep). TAKE THESE STEPS: 1) Call figma_get_status to check connection, 2) Call figma_navigate with the Figma file URL to reconnect and restart monitoring, 3) Retry this tool.";
							} else {
								responseData.ai_instruction =
									"No console logs found. This usually means the Figma plugin hasn't run since monitoring started. Try running your Figma plugin, then check logs again.";
							}
						}
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(responseData),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to get console logs");
					const errorMessage =
						error instanceof Error ? error.message : String(error);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: errorMessage,
										message: "Failed to retrieve console logs.",
										troubleshooting: [
											"Open the Desktop Bridge plugin in Figma for WebSocket-based console capture",
											"Ensure the Desktop Bridge plugin is open and connected in Figma",
										],
									},
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
			`Export an image of the current Figma page or specific node via REST API. Returns an image URL (valid 30 days). Use for visual validation after design changes — check alignment, spacing, proportions. Pass nodeId to target specific elements. For components, prefer figma_get_component_image.`,
			{
				nodeId: z
					.string()
					.optional()
					.describe(
						"Optional node ID to screenshot. If not provided, uses the currently viewed page/frame from the browser URL.",
					),
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
					const currentUrl = this.getCurrentFileUrl();

					if (!currentUrl) {
						throw new Error(
							"No Figma file open. Either provide a nodeId parameter, call figma_navigate, or ensure the Desktop Bridge plugin is connected.",
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
						const nodeIdParam = urlObj.searchParams.get("node-id");
						if (nodeIdParam) {
							// Convert 123-456 to 123:456
							targetNodeId = nodeIdParam.replace(/-/g, ":");
						} else {
							throw new Error(
								"No node ID found. Either provide nodeId parameter or ensure the Figma URL contains a node-id parameter (e.g., ?node-id=123-456)",
							);
						}
					}

					logger.info(
						{ fileKey, nodeId: targetNodeId, scale, format },
						"Rendering image via Figma API",
					);

					// Use Figma REST API to get image
					const result = await api.getImages(fileKey, targetNodeId, {
						scale,
						format: format === "jpg" ? "jpg" : format, // normalize jpeg -> jpg
						contents_only: true,
					});

					const imageUrl = result.images[targetNodeId];

					if (!imageUrl) {
						throw new Error(
							`Failed to render image for node ${targetNodeId}. The node may not exist or may not be renderable.`,
						);
					}

					// Fetch the image and convert to base64 so Claude can actually see it
					logger.info({ imageUrl }, "Fetching image from Figma S3 URL");
					const imageResponse = await fetch(imageUrl);
					if (!imageResponse.ok) {
						throw new Error(
							`Failed to fetch image: ${imageResponse.status} ${imageResponse.statusText}`,
						);
					}

					const imageBuffer = await imageResponse.arrayBuffer();
					const base64Data = Buffer.from(imageBuffer).toString("base64");
					const mimeType =
						format === "jpg"
							? "image/jpeg"
							: format === "svg"
								? "image/svg+xml"
								: format === "pdf"
									? "application/pdf"
									: "image/png";

					logger.info(
						{ byteLength: imageBuffer.byteLength, mimeType },
						"Image fetched and converted to base64",
					);

					// Return as MCP image content type so Claude can actually see the image
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										fileKey,
										nodeId: targetNodeId,
										scale,
										format,
										byteLength: imageBuffer.byteLength,
										note: "Screenshot captured successfully. The image is included below for visual analysis.",
									},
								),
							},
							{
								type: "image",
								data: base64Data,
								mimeType: mimeType,
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to capture screenshot");
					const errorMessage =
						error instanceof Error ? error.message : String(error);
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
				// Determine which console source to use
				const useCDP = this.consoleMonitor?.getStatus().isMonitoring;
				const useWS = !useCDP && this.wsServer?.isClientConnected();

				if (!useCDP && !useWS) {
					throw new Error(
						"No console monitoring available. Open the Desktop Bridge plugin in Figma for console capture.",
					);
				}

				const startTime = Date.now();
				const startLogCount = useCDP
					? this.consoleMonitor!.getStatus().logCount
					: this.wsServer!.getConsoleStatus().logCount;

				// Wait for the specified duration while collecting logs
				await new Promise((resolve) => setTimeout(resolve, duration * 1000));

				const watchedLogs = useCDP
					? this.consoleMonitor!.getLogs({
							level: level === "all" ? undefined : level,
							since: startTime,
						})
					: this.wsServer!.getConsoleLogs({
							level: level === "all" ? undefined : level,
							since: startTime,
						});

				const endLogCount = useCDP
					? this.consoleMonitor!.getStatus().logCount
					: this.wsServer!.getConsoleStatus().logCount;
				const newLogsCount = endLogCount - startLogCount;

				const responseData: any = {
					status: "completed",
					duration: `${duration} seconds`,
					startTime: new Date(startTime).toISOString(),
					endTime: new Date(Date.now()).toISOString(),
					filter: level,
					transport: useCDP ? "cdp" : "websocket",
					statistics: {
						totalLogsInBuffer: endLogCount,
						logsAddedDuringWatch: newLogsCount,
						logsMatchingFilter: watchedLogs.length,
					},
					logs: watchedLogs,
				};

				if (useWS) {
					responseData.ai_instruction =
						"Console logs captured via WebSocket Bridge (plugin sandbox only).";
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(responseData),
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
					let transport: "cdp" | "websocket" = "cdp";
					let clearedCount = 0;
					let currentUrl: string | null = null;

					// Try browser reload first
					if (this.browserManager?.isRunning()) {
						if (clearConsoleBefore && this.consoleMonitor) {
							clearedCount = this.consoleMonitor.clear();
						}
						await this.browserManager.reload();
						currentUrl = this.browserManager.getCurrentUrl();
					} else if (this.wsServer?.isClientConnected()) {
						// WebSocket fallback: reload the plugin UI iframe
						transport = "websocket";
						if (clearConsoleBefore && this.wsServer) {
							clearedCount = this.wsServer.clearConsoleLogs();
						}
						await this.wsServer.sendCommand("RELOAD_UI", {}, 10000);
						// Wait for the UI to reload and WebSocket to reconnect
						await new Promise((resolve) => setTimeout(resolve, 3000));
					} else {
						// Try to initialize browser manager
						await this.ensureInitialized();
						if (!this.browserManager) {
							throw new Error(
								"No connection available. Open the Desktop Bridge plugin in Figma.",
							);
						}
						if (clearConsoleBefore && this.consoleMonitor) {
							clearedCount = this.consoleMonitor.clear();
						}
						await this.browserManager.reload();
						currentUrl = this.browserManager.getCurrentUrl();
					}

					const responseData: any = {
						status: "reloaded",
						timestamp: Date.now(),
						transport,
						consoleCleared: clearConsoleBefore,
						clearedCount: clearConsoleBefore ? clearedCount : 0,
					};

					if (currentUrl) {
						responseData.url = currentUrl;
					}

					if (transport === "websocket") {
						responseData.ai_instruction =
							"Plugin UI reloaded via WebSocket. The plugin's code.js continues running; only the UI iframe was refreshed. The WebSocket connection will auto-reconnect in a few seconds.";
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(responseData),
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
										troubleshooting: [
											"Open the Desktop Bridge plugin in Figma for WebSocket-based reload",
											"Ensure the Desktop Bridge plugin is open and connected in Figma",
										],
									},
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
			"Clear the console log buffer. Safely clears the buffer without disrupting the connection. Returns number of logs cleared.",
			{},
			async () => {
				try {
					let clearedCount = 0;
					let transport: "cdp" | "websocket" = "cdp";

					// Try WebSocket buffer first (non-disruptive)
					if (this.wsServer?.isClientConnected()) {
						clearedCount = this.wsServer.clearConsoleLogs();
						transport = "websocket";
					} else {
						// Try browser manager (initialize if needed)
						if (!this.consoleMonitor) {
							await this.ensureInitialized();
						}
						if (this.consoleMonitor) {
							clearedCount = this.consoleMonitor.clear();
						} else {
							throw new Error(
								"No console monitoring available. Open the Desktop Bridge plugin in Figma.",
							);
						}
					}

					const responseData: any = {
						status: "cleared",
						clearedCount,
						timestamp: Date.now(),
						transport,
					};

					if (transport === "websocket") {
						responseData.ai_instruction =
							"Console buffer cleared via WebSocket. No reconnection needed — monitoring continues automatically.";
					} else {
						responseData.ai_instruction =
							"Console cleared successfully.";
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(responseData),
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
			"Navigate browser to a Figma URL and start console monitoring. ALWAYS use this first when starting a new debugging session or switching files. Initializes browser connection and begins capturing console logs. Use when user provides a Figma URL or says: 'open this file', 'debug this design', 'switch to'. Returns navigation status and current URL. If the file is already open in a tab, switches to it without reloading.",
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
					// Try browser navigation first
					try {
						await this.ensureInitialized();
					} catch {
						// Browser not available — check if WebSocket is connected
						if (this.wsServer?.isClientConnected()) {
							const fileInfo = this.wsServer.getConnectedFileInfo();
							// Check if the requested URL points to the same file already connected via WebSocket
							const requestedFileKey = extractFileKey(url);
							const isSameFile = !!(requestedFileKey && fileInfo?.fileKey && requestedFileKey === fileInfo.fileKey);

							if (isSameFile) {
								return {
									content: [
										{
											type: "text",
											text: JSON.stringify(
												{
													status: "already_connected",
													timestamp: Date.now(),
													connectedFile: {
														fileName: fileInfo!.fileName,
														fileKey: fileInfo!.fileKey,
													},
													message:
														"Already connected to this file via WebSocket. All tools are ready to use — no navigation needed.",
													ai_instruction:
														"The requested file is already connected via WebSocket. You can proceed with any tool calls (figma_get_variables, figma_get_file_data, figma_execute, etc.) without further navigation.",
												},
											),
										},
									],
								};
							}

							// Check if the requested file is connected via multi-client WebSocket
							if (requestedFileKey) {
								const connectedFiles = this.wsServer.getConnectedFiles();
								const targetFile = connectedFiles.find(f => f.fileKey === requestedFileKey);
								if (targetFile) {
									this.wsServer.setActiveFile(requestedFileKey);
									return {
										content: [
											{
												type: "text",
												text: JSON.stringify(
													{
														status: "switched_active_file",
														timestamp: Date.now(),
														activeFile: {
															fileName: targetFile.fileName,
															fileKey: targetFile.fileKey,
														},
														connectedFiles: connectedFiles.map(f => ({
															fileName: f.fileName,
															fileKey: f.fileKey,
															isActive: f.fileKey === requestedFileKey,
														})),
														message: `Switched active file to "${targetFile.fileName}". All tools now target this file.`,
														ai_instruction:
															"Active file has been switched via WebSocket. All subsequent tool calls (figma_get_variables, figma_execute, etc.) will target this file. No browser navigation needed.",
													},
												),
											},
										],
									};
								}
							}

							return {
								content: [
									{
										type: "text",
										text: JSON.stringify(
											{
												status: "websocket_file_not_connected",
												timestamp: Date.now(),
												connectedFile: fileInfo
													? {
															fileName: fileInfo.fileName,
															fileKey: fileInfo.fileKey,
														}
													: undefined,
												connectedFiles: this.wsServer.getConnectedFiles().map(f => ({
													fileName: f.fileName,
													fileKey: f.fileKey,
													isActive: f.isActive,
												})),
												requestedFileKey,
												message:
													"The requested file is not connected via WebSocket. Open the Desktop Bridge plugin in the target file — it will auto-connect. Use figma_list_open_files to see all connected files.",
												ai_instruction:
													"The requested file is not in the connected files list. The user needs to open the Desktop Bridge plugin in the target Figma file. Once opened, it will auto-connect and appear in figma_list_open_files. Then use figma_navigate to switch to it.",
											},
										),
									},
								],
							};
						}
						throw new Error(
							"No connection available. Open the Desktop Bridge plugin in Figma.",
						);
					}

					if (!this.browserManager) {
						throw new Error("Browser manager not initialized");
					}

					// Navigate to the URL (may switch to existing tab)
					const result = await this.browserManager.navigateToFigma(url);

					if (result.action === 'switched_to_existing') {
						if (this.consoleMonitor) {
							this.consoleMonitor.stopMonitoring();
							await this.consoleMonitor.startMonitoring(result.page);
						}

						if (this.desktopConnector) {
							this.desktopConnector.clearFrameCache();
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
											message:
												"Switched to existing tab for this Figma file. Console monitoring is active.",
										},
									),
								},
							],
						};
					}

					// Normal navigation
					if (this.desktopConnector) {
						this.desktopConnector.clearFrameCache();
					}

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
										message:
											"Browser navigated to Figma. Console monitoring is active.",
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to navigate to Figma");
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: errorMessage,
										message: "Failed to navigate to Figma URL",
										troubleshooting: [
											"In WebSocket mode: navigate manually in Figma and ensure Desktop Bridge plugin is open",
											"Ensure the Desktop Bridge plugin is open in the target file",
										],
									},
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
			"Check connection status to Figma Desktop. Reports transport status and connection health via the Desktop Bridge plugin (WebSocket transport).",
			{},
			async () => {
				try {
					// Check WebSocket availability
					const wsConnected = this.wsServer?.isClientConnected() ?? false;

					let monitorStatus = this.consoleMonitor?.getStatus() ?? null;
					let currentUrl = this.getCurrentFileUrl();

					// Determine active transport
					let activeTransport: string = "none";
					if (wsConnected) {
						activeTransport = "websocket";
					}

					// Get current file name — prefer cached info from WebSocket (instant, no roundtrip)
					let currentFileName: string | null = null;
					let currentFileKey: string | null = null;
					const wsFileInfo = this.wsServer?.getConnectedFileInfo() ?? null;
					if (wsFileInfo) {
						currentFileName = wsFileInfo.fileName;
						currentFileKey = wsFileInfo.fileKey;
					} else if (activeTransport !== "none") {
						// Fallback: ask the plugin directly (requires roundtrip)
						try {
							const connector = await this.getDesktopConnector();
							const fileInfo = await connector.executeCodeViaUI(
								"return { fileName: figma.root.name, fileKey: figma.fileKey }",
								5000,
							);
							if (fileInfo.success && fileInfo.result) {
								currentFileName = fileInfo.result.fileName;
								currentFileKey = fileInfo.result.fileKey;
							}
						} catch {
							// Non-critical - Desktop Bridge might not be running yet
						}
					}

					const setupValid = activeTransport !== "none";

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										mode: "local",
										currentFileName:
											currentFileName ||
											"(unable to retrieve - Desktop Bridge may need to be opened)",
										currentFileKey: currentFileKey || undefined,
										monitoredPageUrl: currentUrl,
										monitorWorkerCount: monitorStatus?.workerCount ?? 0,
										transport: {
											active: activeTransport,
											websocket: {
												available: wsConnected,
												serverRunning: this.wsServer?.isStarted() ?? false,
												port: this.wsActualPort ? String(this.wsActualPort) : null,
												preferredPort: String(this.wsPreferredPort),
												portFallbackUsed: this.wsActualPort !== null && this.wsActualPort !== this.wsPreferredPort,
												startupError: this.wsStartupError ? {
													code: this.wsStartupError.code,
													port: this.wsStartupError.port,
													message: `All ports in range ${this.wsPreferredPort}-${this.wsPreferredPort + 9} are in use`,
												} : undefined,
												otherInstances: (() => {
													try {
														const instances = discoverActiveInstances(this.wsPreferredPort);
														const others = instances.filter(i => i.pid !== process.pid);
														if (others.length === 0) return undefined;
														return others.map(i => ({
															port: i.port,
															pid: i.pid,
															startedAt: i.startedAt,
														}));
													} catch { return undefined; }
												})(),
												connectedFile: wsFileInfo ? {
													fileName: wsFileInfo.fileName,
													fileKey: wsFileInfo.fileKey,
													currentPage: wsFileInfo.currentPage,
													connectedAt: new Date(wsFileInfo.connectedAt).toISOString(),
												} : undefined,
												connectedFiles: (() => {
													const files = this.wsServer?.getConnectedFiles();
													if (!files || files.length === 0) return undefined;
													return files.map(f => ({
														fileName: f.fileName,
														fileKey: f.fileKey,
														currentPage: f.currentPage,
														isActive: f.isActive,
														connectedAt: new Date(f.connectedAt).toISOString(),
													}));
												})(),
												currentSelection: (() => {
													const sel = this.wsServer?.getCurrentSelection();
													if (!sel || sel.count === 0) return undefined;
													return {
														count: sel.count,
														nodes: sel.nodes.slice(0, 5).map((n: any) => `${n.name} (${n.type})`),
														page: sel.page,
													};
												})(),
											},
										},
										setup: {
											valid: setupValid,
											message: activeTransport === "websocket"
												? this.wsActualPort !== this.wsPreferredPort
													? `✅ Connected to Figma Desktop via WebSocket Bridge (port ${this.wsActualPort}, fallback from ${this.wsPreferredPort})`
													: "✅ Connected to Figma Desktop via WebSocket Bridge"
												: this.wsStartupError?.code === "EADDRINUSE"
													? `❌ All WebSocket ports ${this.wsPreferredPort}-${this.wsPreferredPort + 9} are in use`
													: this.wsActualPort !== null && this.wsActualPort !== this.wsPreferredPort
													? `❌ WebSocket server running on port ${this.wsActualPort} (fallback) but no plugin connected. Re-import the Desktop Bridge plugin in Figma to enable multi-port scanning.`
													: "❌ No connection to Figma Desktop",
											setupInstructions: !setupValid
												? this.wsStartupError?.code === "EADDRINUSE"
													? {
														cause: `All ports in range ${this.wsPreferredPort}-${this.wsPreferredPort + 9} are in use by other MCP server instances.`,
														fix: "Close some of the other Claude Desktop tabs or terminal sessions running the MCP server, then restart this one.",
													}
													: {
														instructions: `Open the Desktop Bridge plugin in Figma (Plugins → Development → Figma Desktop Bridge). No special launch flags needed.${this.getPluginPath() ? ' Plugin manifest: ' + this.getPluginPath() : ''}`,
													}
												: undefined,
											ai_instruction: !setupValid
												? this.wsStartupError?.code === "EADDRINUSE"
													? `All WebSocket ports in range ${this.wsPreferredPort}-${this.wsPreferredPort + 9} are in use — most likely multiple Claude Desktop tabs or terminal sessions are running the Figma Console MCP server. Ask the user to close some sessions and restart.`
													: this.wsActualPort !== null && this.wsActualPort !== this.wsPreferredPort
														? `Server is running on fallback port ${this.wsActualPort} (port ${this.wsPreferredPort} was taken by another instance). The Desktop Bridge plugin is not connected — most likely because the plugin has old code that only scans port ${this.wsPreferredPort}. TELL THE USER: Re-import the Desktop Bridge plugin in Figma (Plugins → Development → Import plugin from manifest) to update it with multi-port scanning support. This is a one-time step.${this.getPluginPath() ? ' The manifest file is at: ' + this.getPluginPath() : ''}`
														: `No connection to Figma Desktop. Open the Desktop Bridge plugin in Figma to connect.${this.getPluginPath() ? ' Plugin manifest: ' + this.getPluginPath() : ''}`
												: activeTransport === "websocket"
													? `Connected via WebSocket Bridge to "${currentFileName || "unknown file"}" on port ${this.wsActualPort}. All design tools and console monitoring tools are available. Console logs are captured from the plugin sandbox (code.js). IMPORTANT: Always verify the file name before destructive operations when multiple files have the plugin open.`
													: "All tools are ready to use.",
										},
										pluginPath: this.getPluginPath() || undefined,
										consoleMonitor: monitorStatus,
										initialized: setupValid,
										timestamp: Date.now(),
									},
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
			"Force a complete reconnection to Figma Desktop. Use when connection seems stale or after switching files.",
			{},
			async () => {
				try {
					// Clear cached desktop connector to force fresh detection
					this.desktopConnector = null;

					let transport: string = "none";
					let currentUrl: string | null = null;
					let fileName: string | null = null;

					// Try browser manager reconnection if it exists
					if (this.browserManager) {
						try {
							await this.browserManager.forceReconnect();

							// Reinitialize console monitor with new page
							if (this.consoleMonitor) {
								this.consoleMonitor.stopMonitoring();
								const page = await this.browserManager.getPage();
								await this.consoleMonitor.startMonitoring(page);
							}

							currentUrl = this.getCurrentFileUrl();
							transport = "websocket";
						} catch (reconnectError) {
							logger.debug({ error: reconnectError }, "Browser reconnection failed, checking WebSocket");
						}
					}

					// If browser reconnect didn't work, check WebSocket
					if (transport === "none" && this.wsServer?.isClientConnected()) {
						transport = "websocket";
					}

					if (transport === "none") {
						throw new Error(
							"Cannot connect to Figma Desktop.\n\n" +
							"Open the Desktop Bridge plugin in Figma (Plugins → Development → Figma Desktop Bridge)."
						);
					}

					// Try to get the file name via whichever transport connected
					try {
						const connector = await this.getDesktopConnector();
						const fileInfo = await connector.executeCodeViaUI(
							"return { fileName: figma.root.name, fileKey: figma.fileKey }",
							5000,
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
										transport,
										currentUrl,
										fileName:
											fileName ||
											"(unknown - Desktop Bridge may need to be restarted)",
										timestamp: Date.now(),
										message: fileName
											? `Successfully reconnected via ${transport.toUpperCase()}. Now connected to: "${fileName}"`
											: `Successfully reconnected to Figma Desktop via ${transport.toUpperCase()}.`,
									},
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
										error:
											error instanceof Error ? error.message : String(error),
										message: "Failed to reconnect to Figma Desktop",
										hint: "Open the Desktop Bridge plugin in Figma",
									},
								),
							},
						],
						isError: true,
					};
				}
			},
		);

		// ============================================================================
		// REAL-TIME AWARENESS TOOLS (WebSocket-only)
		// ============================================================================

		// Tool: Get current user selection in Figma
		this.server.tool(
			"figma_get_selection",
			"Get the currently selected nodes in Figma. Returns node IDs, names, types, and dimensions. WebSocket-only — requires Desktop Bridge plugin. Use this to understand what the user is pointing at instead of asking them to describe it.",
			{
				verbose: z
					.boolean()
					.optional()
					.default(false)
					.describe("If true, fetches additional details (fills, strokes, styles) for each selected node via figma_execute"),
			},
			async ({ verbose }) => {
				try {
					const selection = this.wsServer?.getCurrentSelection() ?? null;

					if (!this.wsServer?.isClientConnected()) {
						return {
							content: [{
								type: "text",
								text: JSON.stringify({
									error: "WebSocket not connected. Open the Desktop Bridge plugin in Figma.",
									selection: null,
								}),
							}],
							isError: true,
						};
					}

					if (!selection || selection.count === 0) {
						return {
							content: [{
								type: "text",
								text: JSON.stringify({
									selection: [],
									count: 0,
									page: selection?.page ?? "unknown",
									message: "Nothing is selected in Figma. Select one or more elements to use this tool.",
								}),
							}],
						};
					}

					let result: Record<string, any> = {
						selection: selection.nodes,
						count: selection.count,
						page: selection.page,
						timestamp: selection.timestamp,
					};

					// If verbose, fetch additional details for selected nodes
					if (verbose && selection.nodes.length > 0 && selection.nodes.length <= 10) {
						try {
							const connector = await this.getDesktopConnector();
							const nodeIds = selection.nodes.map((n: any) => `"${n.id}"`).join(",");
							const details = await connector.executeCodeViaUI(
								`var ids = [${nodeIds}];
								var results = [];
								for (var i = 0; i < ids.length; i++) {
									var node = figma.getNodeById(ids[i]);
									if (!node) continue;
									var info = { id: node.id, name: node.name, type: node.type };
									if ('fills' in node) info.fills = node.fills;
									if ('strokes' in node) info.strokes = node.strokes;
									if ('effects' in node) info.effects = node.effects;
									if ('characters' in node) info.characters = node.characters;
									if ('fontSize' in node) info.fontSize = node.fontSize;
									if ('fontName' in node) info.fontName = node.fontName;
									if ('opacity' in node) info.opacity = node.opacity;
									if ('cornerRadius' in node) info.cornerRadius = node.cornerRadius;
									if ('componentProperties' in node) info.componentProperties = node.componentProperties;
									results.push(info);
								}
								return results;`,
								10000,
							);
							if (details.success && details.result) {
								result.details = details.result;
							}
						} catch (err) {
							result.detailsError = "Could not fetch detailed properties";
						}
					}

					return {
						content: [{
							type: "text",
							text: JSON.stringify(result),
						}],
					};
				} catch (error) {
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								message: "Failed to get selection",
							}),
						}],
						isError: true,
					};
				}
			},
		);

		// Tool: Get recent design changes
		this.server.tool(
			"figma_get_design_changes",
			"Get recent document changes detected in Figma. Returns buffered change events including which nodes changed, whether styles were modified, and change counts. WebSocket-only — events are captured via Desktop Bridge plugin. Use this to understand what changed since you last checked.",
			{
				since: z
					.number()
					.optional()
					.describe("Only return changes after this Unix timestamp (ms). Useful for incremental polling."),
				count: z
					.number()
					.optional()
					.describe("Maximum number of change events to return (chronological order, oldest to newest; returns the last N events)"),
				clear: z
					.boolean()
					.optional()
					.default(false)
					.describe("Clear the change buffer after reading. Set to true for polling workflows."),
			},
			async ({ since, count, clear }) => {
				try {
					if (!this.wsServer?.isClientConnected()) {
						return {
							content: [{
								type: "text",
								text: JSON.stringify({
									error: "WebSocket not connected. Open the Desktop Bridge plugin in Figma.",
									changes: [],
								}),
							}],
							isError: true,
						};
					}

					const changes = this.wsServer.getDocumentChanges({ since, count });

					// Compute summary
					let totalNodeChanges = 0;
					let totalStyleChanges = 0;
					const allChangedNodeIds = new Set<string>();
					for (const change of changes) {
						if (change.hasNodeChanges) totalNodeChanges++;
						if (change.hasStyleChanges) totalStyleChanges++;
						for (const id of change.changedNodeIds) {
							allChangedNodeIds.add(id);
						}
					}

					if (clear) {
						this.wsServer.clearDocumentChanges();
					}

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								changes,
								summary: {
									eventCount: changes.length,
									nodeChangeEvents: totalNodeChanges,
									styleChangeEvents: totalStyleChanges,
									uniqueNodesChanged: allChangedNodeIds.size,
									oldestTimestamp: changes[0]?.timestamp,
									newestTimestamp: changes[changes.length - 1]?.timestamp,
								},
								bufferCleared: clear,
							}),
						}],
					};
				} catch (error) {
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								message: "Failed to get design changes",
							}),
						}],
						isError: true,
					};
				}
			},
		);

		// Tool: List all open files connected via WebSocket
		this.server.tool(
			"figma_list_open_files",
			"List all Figma files currently connected via the Desktop Bridge plugin. Shows which files have the plugin open and which one is the active target for tool calls. Use figma_navigate to switch between files. WebSocket multi-client mode — each file with the Desktop Bridge plugin maintains its own connection.",
			{},
			async () => {
				try {
					if (!this.wsServer?.isClientConnected()) {
						// Fall back to browser manager if available
						if (this.browserManager) {
							try {
								await this.ensureInitialized();
								const currentUrl = this.browserManager.getCurrentUrl();
								return {
									content: [{
										type: "text",
										text: JSON.stringify({
											transport: "browser",
											files: currentUrl ? [{ url: currentUrl, isActive: true }] : [],
											message: "WebSocket not connected. Open the Desktop Bridge plugin for multi-file support.",
										}),
									}],
								};
							} catch {
								// Browser also unavailable
							}
						}

						return {
							content: [{
								type: "text",
								text: JSON.stringify({
									error: "No files connected. Open the Desktop Bridge plugin in Figma to connect files.",
									files: [],
								}),
							}],
							isError: true,
						};
					}

					const connectedFiles = this.wsServer.getConnectedFiles();
					const activeFileKey = this.wsServer.getActiveFileKey();

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								transport: "websocket",
								activeFileKey,
								files: connectedFiles.map(f => ({
									fileName: f.fileName,
									fileKey: f.fileKey,
									currentPage: f.currentPage,
									isActive: f.isActive,
									connectedAt: f.connectedAt,
									url: f.fileKey
										? `https://www.figma.com/design/${f.fileKey}/${encodeURIComponent(f.fileName || 'Untitled')}`
										: undefined,
								})),
								totalFiles: connectedFiles.length,
								message: connectedFiles.length === 1
									? `Connected to 1 file: "${connectedFiles[0].fileName}"`
									: `Connected to ${connectedFiles.length} files. Active: "${connectedFiles.find(f => f.isActive)?.fileName || 'none'}"`,
								ai_instruction: "Use figma_navigate with a file URL to switch the active file. All tools target the active file by default.",
							}),
						}],
					};
				} catch (error) {
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								message: "Failed to list open files",
							}),
						}],
						isError: true,
					};
				}
			},
		);

		// ============================================================================
		// WRITE OPERATION TOOLS - Figma Design Manipulation
		// ============================================================================

		registerBridgeTools(this.server, () => this.getDesktopConnector());

		// Register Figma API tools (Tools 8-11)
		registerFigmaAPITools(
			this.server,
			() => this.getFigmaAPI(),
			() => this.getCurrentFileUrl(),
			() => this.consoleMonitor || null,
			() => this.browserManager || null,
			() => this.ensureInitialized(),
			this.variablesCache, // Pass cache for efficient variable queries
			undefined, // options (use default)
			() => this.getDesktopConnector(), // Transport-aware connector factory
		);

		// Register Design-Code Parity & Documentation tools
		registerDesignCodeTools(
			this.server,
			() => this.getFigmaAPI(),
			() => this.getCurrentFileUrl(),
			this.variablesCache,
			undefined, // options
			() => this.getDesktopConnector(), // Desktop Bridge for description fallback
		);

		// Register Comment tools
		registerCommentTools(
			this.server,
			() => this.getFigmaAPI(),
			() => this.getCurrentFileUrl(),
		);

		// Register Design System Kit tool
		registerDesignSystemTools(
			this.server,
			() => this.getFigmaAPI(),
			() => this.getCurrentFileUrl(),
			this.variablesCache,
		);

		// MCP Apps - gated behind ENABLE_MCP_APPS env var
		if (process.env.ENABLE_MCP_APPS === "true") {
			registerTokenBrowserApp(this.server, async (fileUrl?: string) => {
				const url = fileUrl || this.getCurrentFileUrl();
				if (!url) {
					throw new Error(
						"No Figma file URL available. Either pass a fileUrl, call figma_navigate, or ensure the Desktop Bridge plugin is connected.",
					);
				}

				const urlInfo = extractFigmaUrlInfo(url);
				if (!urlInfo) {
					throw new Error(`Invalid Figma URL: ${url}`);
				}

				const fileKey = urlInfo.branchId || urlInfo.fileKey;

				// Fetch file info for display (non-blocking, best-effort)
				let fileInfo: { name: string } | undefined;
				try {
					const api = await this.getFigmaAPI();
					const fileData = await api.getFile(fileKey, { depth: 0 });
					if (fileData?.name) {
						fileInfo = { name: fileData.name };
					}
				} catch {
					// Fall back to extracting name from URL
					try {
						const urlObj = new URL(url);
						const segments = urlObj.pathname.split("/").filter(Boolean);
						const branchIdx = segments.indexOf("branch");
						const nameSegment =
							branchIdx >= 0
								? segments[branchIdx + 2]
								: segments.length >= 3
									? segments[2]
									: undefined;
						if (nameSegment) {
							fileInfo = {
								name: decodeURIComponent(nameSegment).replace(/-/g, " "),
							};
						}
					} catch {
						// Leave fileInfo undefined
					}
				}

				// Check cache first (works for both Desktop Bridge and REST API data)
				const cacheEntry = this.variablesCache.get(fileKey);
				if (cacheEntry && Date.now() - cacheEntry.timestamp < 5 * 60 * 1000) {
					const cached = cacheEntry.data;
					// Desktop Bridge caches arrays directly; REST API data needs formatVariables
					if (Array.isArray(cached.variables)) {
						return {
							variables: cached.variables,
							collections: cached.variableCollections || [],
							fileInfo,
						};
					}
					const formatted = formatVariables(cached);
					return {
						variables: formatted.variables,
						collections: formatted.collections,
						fileInfo,
					};
				}

				// Priority 1: Try Desktop Bridge via transport-agnostic connector
				try {
					const connector = await this.getDesktopConnector();
					const desktopResult =
						await connector.getVariablesFromPluginUI(fileKey);

					if (desktopResult.success && desktopResult.variables) {
						// Cache the desktop result
						this.variablesCache.set(fileKey, {
							data: {
								variables: desktopResult.variables,
								variableCollections: desktopResult.variableCollections,
							},
							timestamp: Date.now(),
						});

						return {
							variables: desktopResult.variables,
							collections: desktopResult.variableCollections || [],
							fileInfo,
						};
					}
				} catch (desktopErr) {
					logger.warn(
						{
							error:
								desktopErr instanceof Error
									? desktopErr.message
									: String(desktopErr),
						},
						"Desktop Bridge failed for token browser, trying REST API",
					);
				}

				// Priority 2: Fall back to REST API (requires Enterprise plan)
				const api = await this.getFigmaAPI();
				const { local, localError } = await api.getAllVariables(fileKey);

				if (localError) {
					throw new Error(
						`Could not fetch variables. Desktop Bridge unavailable and REST API returned: ${localError}`,
					);
				}

				// Cache raw REST API data
				this.variablesCache.set(fileKey, {
					data: local,
					timestamp: Date.now(),
				});

				const formatted = formatVariables(local);
				return {
					variables: formatted.variables,
					collections: formatted.collections,
					fileInfo,
				};
			});

			registerDesignSystemDashboardApp(
				this.server,
				async (fileUrl?: string) => {
					const url = fileUrl || this.getCurrentFileUrl();
					if (!url) {
						throw new Error(
							"No Figma file URL available. Either pass a fileUrl, call figma_navigate, or ensure the Desktop Bridge plugin is connected.",
						);
					}

					const urlInfo = extractFigmaUrlInfo(url);
					if (!urlInfo) {
						throw new Error(`Invalid Figma URL: ${url}`);
					}

					const fileKey = urlInfo.branchId || urlInfo.fileKey;

					// Track data availability for transparent scoring
					let variablesAvailable = false;
					let variableError: string | undefined;
					let desktopBridgeAttempted = false;
					let desktopBridgeFailed = false;
					let restApiAttempted = false;
					let restApiFailed = false;

					// Fetch variables + collections
					// Fallback chain: Cache → Desktop Bridge → REST API → Actionable error
					let variables: any[] = [];
					let collections: any[] = [];

					// 1. Check cache first
					const cacheEntry = this.variablesCache.get(fileKey);
					if (cacheEntry && Date.now() - cacheEntry.timestamp < 5 * 60 * 1000) {
						const cached = cacheEntry.data;
						if (Array.isArray(cached.variables)) {
							variables = cached.variables;
							collections = cached.variableCollections || [];
						} else {
							const formatted = formatVariables(cached);
							variables = formatted.variables;
							collections = formatted.collections;
						}
						variablesAvailable = variables.length > 0;
					}

					// 2. Try Desktop Bridge via transport-agnostic connector
					if (variables.length === 0) {
						desktopBridgeAttempted = true;
						try {
							const connector = await this.getDesktopConnector();
							const desktopResult =
								await connector.getVariablesFromPluginUI(fileKey);

							if (desktopResult.success && desktopResult.variables) {
								this.variablesCache.set(fileKey, {
									data: {
										variables: desktopResult.variables,
										variableCollections: desktopResult.variableCollections,
									},
									timestamp: Date.now(),
								});
								variables = desktopResult.variables;
								collections = desktopResult.variableCollections || [];
								variablesAvailable = true;
							} else {
								desktopBridgeFailed = true;
							}
						} catch (desktopErr) {
							desktopBridgeFailed = true;
							logger.warn(
								{
									error:
										desktopErr instanceof Error
											? desktopErr.message
											: String(desktopErr),
								},
								"Desktop Bridge failed for dashboard, trying REST API for variables",
							);
						}
					}

					// 3. Try REST API (works only with Enterprise plan)
					if (variables.length === 0) {
						restApiAttempted = true;
						try {
							const api = await this.getFigmaAPI();
							const { local, localError } = await api.getAllVariables(fileKey);
							if (!localError && local) {
								this.variablesCache.set(fileKey, {
									data: local,
									timestamp: Date.now(),
								});
								const formatted = formatVariables(local);
								variables = formatted.variables;
								collections = formatted.collections;
								variablesAvailable = true;
							} else {
								restApiFailed = true;
							}
						} catch (varErr) {
							restApiFailed = true;
							logger.warn(
								{
									error:
										varErr instanceof Error ? varErr.message : String(varErr),
								},
								"REST API variable fetch failed for dashboard",
							);
						}
					}

					// 4. Build actionable error message based on what was tried
					if (!variablesAvailable) {
						if (desktopBridgeFailed && restApiFailed) {
							variableError =
								"Desktop Bridge plugin not connected and REST API requires Enterprise plan. Please open the Desktop Bridge plugin in Figma to enable variable/token analysis.";
						} else if (desktopBridgeFailed) {
							variableError =
								"Desktop Bridge plugin not connected. Please open the Desktop Bridge plugin in Figma to enable variable/token analysis.";
						} else if (restApiFailed) {
							variableError =
								"REST API requires Figma Enterprise plan. Connect the Desktop Bridge plugin in Figma for variable/token access.";
						} else if (!desktopBridgeAttempted && !restApiAttempted) {
							variableError =
								"No variable fetch methods available. Connect the Desktop Bridge plugin in Figma.";
						}
					}

					// Fetch file metadata, components, component sets, and styles via REST API
					let fileInfo:
						| {
								name: string;
								lastModified: string;
								version?: string;
								thumbnailUrl?: string;
						  }
						| undefined;
					let components: any[] = [];
					let componentSets: any[] = [];
					let styles: any[] = [];

					try {
						const api = await this.getFigmaAPI();
						const [fileData, compResult, compSetResult, styleResult] =
							await Promise.all([
								api.getFile(fileKey, { depth: 0 }).catch(() => null),
								api
									.getComponents(fileKey)
									.catch(() => ({ meta: { components: [] } })),
								api
									.getComponentSets(fileKey)
									.catch(() => ({ meta: { component_sets: [] } })),
								api.getStyles(fileKey).catch(() => ({ meta: { styles: [] } })),
							]);
						if (fileData) {
							fileInfo = {
								name: fileData.name || "Unknown",
								lastModified: fileData.lastModified || "",
								version: fileData.version,
								thumbnailUrl: fileData.thumbnailUrl,
							};
						}
						components = compResult?.meta?.components || [];
						componentSets = compSetResult?.meta?.component_sets || [];
						styles = styleResult?.meta?.styles || [];
					} catch (apiErr) {
						logger.warn(
							{
								error:
									apiErr instanceof Error ? apiErr.message : String(apiErr),
							},
							"REST API fetch failed for dashboard",
						);
					}

					// Fallback: extract file name from URL if getFile failed
					if (!fileInfo) {
						try {
							const urlObj = new URL(url);
							const segments = urlObj.pathname.split("/").filter(Boolean);
							// /design/KEY/File-Name or /design/KEY/branch/BRANCHKEY/File-Name
							const branchIdx = segments.indexOf("branch");
							const nameSegment =
								branchIdx >= 0
									? segments[branchIdx + 2]
									: segments.length >= 3
										? segments[2]
										: undefined;
							if (nameSegment) {
								fileInfo = {
									name: decodeURIComponent(nameSegment).replace(/-/g, " "),
									lastModified: "",
								};
							}
						} catch {
							// URL parsing failed — leave fileInfo undefined
						}
					}

					return {
						variables,
						collections,
						components,
						styles,
						componentSets,
						fileInfo,
						dataAvailability: {
							variables: variablesAvailable,
							collections: variablesAvailable,
							components: components.length > 0,
							styles: styles.length > 0,
							variableError,
						},
					};
				},
				// Pass getCurrentUrl so dashboard can track which file was audited
				() => this.getCurrentFileUrl(),
			);

			logger.info("MCP Apps registered (ENABLE_MCP_APPS=true)");
		}

		logger.info(
			"All MCP tools registered successfully (including write operations)",
		);
	}

	/**
	 * Start the MCP server
	 */
	async start(): Promise<void> {
		try {
			logger.info(
				{ config: this.config },
				"Starting Figma Console MCP (Local Mode)",
			);

			// Start WebSocket bridge server with port range fallback.
			// If the preferred port is taken (e.g., Claude Desktop Chat tab already bound it),
			// try subsequent ports in the range (9223-9232) so multiple instances can coexist.
			const wsHost = process.env.FIGMA_WS_HOST || 'localhost';
			this.wsPreferredPort = parseInt(process.env.FIGMA_WS_PORT || String(DEFAULT_WS_PORT), 10);

			// Clean up any stale port files from crashed instances before trying to bind
			cleanupStalePortFiles();

			const portsToTry = getPortRange(this.wsPreferredPort);
			let boundPort: number | null = null;

			for (const port of portsToTry) {
				try {
					this.wsServer = new FigmaWebSocketServer({ port, host: wsHost });
					await this.wsServer.start();

					// Get the actual bound port (should match, but verify)
					const addr = this.wsServer.address();
					boundPort = addr?.port ?? port;
					this.wsActualPort = boundPort;

					if (boundPort !== this.wsPreferredPort) {
						logger.info(
							{ preferredPort: this.wsPreferredPort, actualPort: boundPort },
							"Preferred WebSocket port was in use, bound to fallback port",
						);
					} else {
						logger.info({ wsPort: boundPort }, "WebSocket bridge server started");
					}

					// Advertise the port so the Figma plugin and other tools can discover us
					advertisePort(boundPort, wsHost);
					registerPortCleanup(boundPort);

					break;
				} catch (wsError) {
					const errorMsg = wsError instanceof Error ? wsError.message : String(wsError);
					const errorCode = wsError instanceof Error ? (wsError as any).code : undefined;

					if (errorCode === "EADDRINUSE" || errorMsg.includes("EADDRINUSE")) {
						logger.debug(
							{ port, error: errorMsg },
							"Port in use, trying next in range",
						);
						this.wsServer = null;
						continue;
					}

					// Non-port-conflict error — don't try more ports
					logger.warn(
						{ error: errorMsg, port },
						"Failed to start WebSocket bridge server",
					);
					this.wsServer = null;
					break;
				}
			}

			if (!boundPort) {
				this.wsStartupError = {
					code: "EADDRINUSE",
					port: this.wsPreferredPort,
				};
				const rangeEnd = this.wsPreferredPort + portsToTry.length - 1;
				logger.warn(
					{ portRange: `${this.wsPreferredPort}-${rangeEnd}` },
					"All WebSocket ports in range are in use — running without WebSocket transport",
				);
			}

			if (this.wsServer) {
				// Log when plugin files connect/disconnect (with file identity)
				this.wsServer.on("fileConnected", (data: { fileKey: string; fileName: string }) => {
					logger.info({ fileKey: data.fileKey, fileName: data.fileName }, "Desktop Bridge plugin connected via WebSocket");
				});
				this.wsServer.on("fileDisconnected", (data: { fileKey: string; fileName: string }) => {
					logger.info({ fileKey: data.fileKey, fileName: data.fileName }, "Desktop Bridge plugin disconnected from WebSocket");
				});

				// Invalidate variable cache when document changes are reported.
				// Figma's documentchange API doesn't expose a specific variable change type —
				// variable operations manifest as node PROPERTY_CHANGE events, so we invalidate
				// on any style or node change to be safe.
				this.wsServer.on("documentChange", (data: any) => {
					if (data.hasStyleChanges || data.hasNodeChanges) {
						if (data.fileKey) {
							// Per-file cache invalidation — only clear the affected file's cache
							this.variablesCache.delete(data.fileKey);
						} else {
							this.variablesCache.clear();
						}
						logger.debug(
							{ fileKey: data.fileKey, changeCount: data.changeCount, hasStyleChanges: data.hasStyleChanges, hasNodeChanges: data.hasNodeChanges },
							"Variable cache invalidated due to document changes"
						);
					}
				});
			}

			// Check if Figma Desktop is accessible (non-blocking, just for logging)
			logger.info("Checking Figma Desktop accessibility...");
			await this.checkFigmaDesktop();

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
			// Clean up port advertisement before stopping the server
			if (this.wsActualPort) {
				unadvertisePort(this.wsActualPort);
			}

			if (this.wsServer) {
				await this.wsServer.stop();
			}

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
// realpathSync resolves symlinks (e.g. node_modules/.bin/figma-console-mcp -> dist/local.js)
// which is required for npx to work, since npx runs the binary via a symlink
const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";

if (currentFile === entryFile) {
	main().catch((error) => {
		console.error("Fatal error:", error);
		process.exit(1);
	});
}

export { LocalFigmaConsoleMCP };
