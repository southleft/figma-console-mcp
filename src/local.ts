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
import { registerSlidesTools } from "./core/slides-tools.js";
import { FigmaDesktopConnector } from "./core/figma-desktop-connector.js";
import type { IFigmaConnector } from "./core/figma-connector.js";
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

Batch tools are 10-50x faster because they execute in a single CDP roundtrip. Use individual tools only for one-off operations.

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
	 * Tries WebSocket first (instant, no network timeout), falls back to CDP.
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
				logger.debug({ error: errorMsg }, "WebSocket connector init failed, trying CDP fallback");
			}
		}

		// CDP fallback (requires --remote-debugging-port=9222)
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
				logger.debug("Desktop connector initialized via CDP with fresh page reference");
				return this.desktopConnector;
			}
		} catch (cdpError) {
			const errorMsg = cdpError instanceof Error ? cdpError.message : String(cdpError);
			logger.debug({ error: errorMsg }, "CDP connection also unavailable");
		}

		const wsPort = this.wsActualPort || this.wsPreferredPort || DEFAULT_WS_PORT;
		throw new Error(
			"Cannot connect to Figma Desktop.\n\n" +
			"Option 1 (WebSocket): Open the Desktop Bridge plugin in Figma.\n" +
			`  The plugin will connect automatically to ws://localhost:${wsPort}.\n` +
			"  No special launch flags needed.\n\n" +
			"Option 2 (CDP): Launch Figma with --remote-debugging-port=9222\n" +
			"  macOS: open -a \"Figma\" --args --remote-debugging-port=9222\n" +
			"  Windows: start figma://--remote-debugging-port=9222"
		);
	}

	/**
	 * Get the current Figma file URL from the best available source.
	 * Priority: CDP browser URL (full URL with branch/node info) → WebSocket file identity (synthesized URL).
	 * The synthesized URL is compatible with extractFileKey() and extractFigmaUrlInfo().
	 */
	private getCurrentFileUrl(): string | null {
		// Priority 1: CDP browser URL (full URL with branch/node info)
		const browserUrl = this.browserManager?.getCurrentUrl() || null;
		if (browserUrl) return browserUrl;

		// Priority 2: Synthesize URL from WebSocket file identity
		const wsFileInfo = this.wsServer?.getConnectedFileInfo() ?? null;
		if (wsFileInfo?.fileKey) {
			return `https://www.figma.com/design/${wsFileInfo.fileKey}/${encodeURIComponent(wsFileInfo.fileName || 'Untitled')}`;
		}

		return null;
	}

	/**
	 * Check if Figma Desktop is accessible via CDP or WebSocket
	 */
	private async checkFigmaDesktop(): Promise<void> {
		if (!this.config.local) {
			throw new Error("Local mode configuration missing");
		}

		const { debugHost, debugPort } = this.config.local;
		const browserURL = `http://${debugHost}:${debugPort}`;
		let cdpAvailable = false;

		try {
			// Simple HTTP check to see if debug port is accessible
			const response = await fetch(`${browserURL}/json/version`, {
				signal: AbortSignal.timeout(3000),
			});

			if (response.ok) {
				const versionInfo = await response.json();
				logger.info({ versionInfo, browserURL }, "Figma Desktop is accessible via CDP");
				cdpAvailable = true;
			}
		} catch {
			logger.debug("CDP not available at startup (this is OK if using WebSocket bridge)");
		}

		// Check WebSocket availability
		const wsAvailable = this.wsServer?.isClientConnected() ?? false;

		if (cdpAvailable && wsAvailable) {
			logger.info("Transport: Both CDP and WebSocket available (WebSocket preferred)");
		} else if (cdpAvailable) {
			logger.info("Transport: CDP available");
		} else if (wsAvailable) {
			logger.info("Transport: WebSocket bridge connected");
		} else {
			// Neither available yet — log guidance but don't throw
			// The user may open the plugin later
			logger.warn(
				`Neither CDP nor WebSocket transport available yet.\n\n` +
				`Option 1 (CDP): Launch Figma with --remote-debugging-port=${debugPort}\n` +
				`  macOS: open -a "Figma" --args --remote-debugging-port=${debugPort}\n\n` +
				`Option 2 (WebSocket): Open the Desktop Bridge plugin in Figma.\n` +
				`  No special launch flags needed — the plugin connects automatically.`,
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
					// Try CDP console monitor first, fall back to WebSocket console buffer
					let logs: import("./core/types/index.js").ConsoleLogEntry[];
					let status: ReturnType<import("./core/console-monitor.js").ConsoleMonitor["getStatus"]> | ReturnType<NonNullable<typeof this.wsServer>["getConsoleStatus"]>;
					let source: "cdp" | "websocket" = "cdp";

					if (this.consoleMonitor?.getStatus().isMonitoring) {
						// CDP console monitor is active — use it (captures all page logs)
						logs = this.consoleMonitor.getLogs({ count, level, since });
						status = this.consoleMonitor.getStatus();
					} else if (this.wsServer?.isClientConnected()) {
						// WebSocket fallback — plugin-captured console logs
						logs = this.wsServer.getConsoleLogs({ count, level, since });
						status = this.wsServer.getConsoleStatus();
						source = "websocket";
					} else {
						// Neither available — try to initialize CDP
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
								"No console monitoring available. Either enable CDP (--remote-debugging-port=9222) or open the Desktop Bridge plugin for WebSocket-based console capture.",
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
							"Console logs captured via WebSocket Bridge (plugin sandbox only). These logs include output from the Desktop Bridge plugin's code.js context. For full-page console monitoring including Figma app internals, use CDP mode (--remote-debugging-port=9222).";
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
											"Or enable CDP: Relaunch Figma with --remote-debugging-port=9222",
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
							"No Figma file open. Either provide a nodeId parameter, call figma_navigate (CDP mode), or ensure the Desktop Bridge plugin is connected (WebSocket mode).",
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
						"No console monitoring available. Either enable CDP (--remote-debugging-port=9222) or open the Desktop Bridge plugin for WebSocket-based console capture.",
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
						"Console logs captured via WebSocket Bridge (plugin sandbox only). For full-page monitoring, use CDP mode.";
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

					// Try CDP first (full page reload)
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
						// Try to initialize CDP
						await this.ensureInitialized();
						if (!this.browserManager) {
							throw new Error(
								"No connection available. Open the Desktop Bridge plugin in Figma or enable CDP.",
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
											"Or enable CDP: Relaunch Figma with --remote-debugging-port=9222",
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
			"Clear the console log buffer. In WebSocket mode, this safely clears the buffer without disrupting the connection. In CDP mode, this disrupts monitoring and requires MCP reconnect. Returns number of logs cleared.",
			{},
			async () => {
				try {
					let clearedCount = 0;
					let transport: "cdp" | "websocket" = "cdp";

					// Try WebSocket buffer first (non-disruptive), then CDP
					if (this.wsServer?.isClientConnected()) {
						clearedCount = this.wsServer.clearConsoleLogs();
						transport = "websocket";
					} else {
						// Try CDP (initialize if needed)
						if (!this.consoleMonitor) {
							await this.ensureInitialized();
						}
						if (this.consoleMonitor) {
							clearedCount = this.consoleMonitor.clear();
						} else {
							throw new Error(
								"No console monitoring available. Open the Desktop Bridge plugin or enable CDP.",
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
							"⚠️ Console cleared via CDP. This may disrupt monitoring. Reconnect MCP if logs stop appearing.";
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
					// Try CDP first (full browser navigation)
					try {
						await this.ensureInitialized();
					} catch {
						// CDP not available — check if WebSocket is connected
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
							"No connection available. Open the Desktop Bridge plugin in Figma or enable CDP (--remote-debugging-port=9222).",
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
											"For automatic navigation: relaunch Figma with --remote-debugging-port=9222",
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
			"Check connection status to Figma Desktop. Reports which transport is active (CDP or WebSocket) and connection health. Works with both CDP (--remote-debugging-port=9222) and WebSocket (Desktop Bridge plugin) transports.",
			{},
			async () => {
				try {
					// Check CDP availability (non-blocking)
					let cdpAvailable = false;
					let debugPortAccessible = false;
					try {
						const debugHost = this.config?.local?.debugHost ?? "localhost";
						const debugPort = this.config?.local?.debugPort ?? 9222;
						const response = await fetch(`http://${debugHost}:${debugPort}/json/version`, {
							signal: AbortSignal.timeout(2000),
						});
						debugPortAccessible = response.ok;
						cdpAvailable = debugPortAccessible;
					} catch (e) {
						// CDP not available
					}

					// Check WebSocket availability
					const wsConnected = this.wsServer?.isClientConnected() ?? false;

					// Try CDP initialization if available (but don't fail on error)
					let browserRunning = this.browserManager?.isRunning() ?? false;
					let monitorStatus = this.consoleMonitor?.getStatus() ?? null;
					let currentUrl = this.getCurrentFileUrl();
					if (cdpAvailable && !browserRunning) {
						try {
							await this.ensureInitialized();
							browserRunning = this.browserManager?.isRunning() ?? false;
							monitorStatus = this.consoleMonitor?.getStatus() ?? null;
							currentUrl = this.getCurrentFileUrl();
						} catch {
							// CDP init failed - continue with WebSocket status
						}
					}

					// Determine active transport (matches getDesktopConnector priority: WS first)
					let activeTransport: string = "none";
					if (wsConnected) {
						activeTransport = "websocket";
					} else if (cdpAvailable && browserRunning) {
						activeTransport = "cdp";
					}

					// List available Figma pages (CDP only)
					let availablePages: Array<{
						url: string;
						workerCount: number;
						isCurrentPage: boolean;
					}> = [];
					if (this.browserManager && browserRunning) {
						try {
							const browser = (this.browserManager as any).browser;
							if (browser) {
								const pages = await browser.pages();
								availablePages = pages
									.filter((p: any) => {
										const url = p.url();
										return (
											url.includes("figma.com") && !url.includes("devtools")
										);
									})
									.map((p: any) => ({
										url: p.url(),
										workerCount: p.workers().length,
										isCurrentPage: p.url() === currentUrl,
									}));
							}
						} catch (e) {
							logger.error({ error: e }, "Failed to list available pages");
						}
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
											cdp: {
												available: cdpAvailable,
												debugPortAccessible,
												browserRunning,
											},
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
											message: activeTransport === "cdp"
												? "✅ Connected to Figma Desktop via CDP (Chrome DevTools Protocol)"
												: activeTransport === "websocket"
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
														option1_websocket: `Open the Desktop Bridge plugin in Figma (Plugins → Development → Figma Desktop Bridge). No special launch flags needed.${this.getPluginPath() ? ' Plugin manifest: ' + this.getPluginPath() : ''}`,
														option2_cdp: 'Launch Figma with: open -a "Figma" --args --remote-debugging-port=9222',
													}
												: undefined,
											ai_instruction: !setupValid
												? this.wsStartupError?.code === "EADDRINUSE"
													? `All WebSocket ports in range ${this.wsPreferredPort}-${this.wsPreferredPort + 9} are in use — most likely multiple Claude Desktop tabs or terminal sessions are running the Figma Console MCP server. Ask the user to close some sessions and restart.`
													: this.wsActualPort !== null && this.wsActualPort !== this.wsPreferredPort
														? `Server is running on fallback port ${this.wsActualPort} (port ${this.wsPreferredPort} was taken by another instance). The Desktop Bridge plugin is not connected — most likely because the plugin has old code that only scans port ${this.wsPreferredPort}. TELL THE USER: Re-import the Desktop Bridge plugin in Figma (Plugins → Development → Import plugin from manifest) to update it with multi-port scanning support. This is a one-time step.${this.getPluginPath() ? ' The manifest file is at: ' + this.getPluginPath() : ''}`
														: `No connection to Figma Desktop. The easiest option is to open the Desktop Bridge plugin in Figma. Alternatively, relaunch Figma with --remote-debugging-port=9222 for CDP.${this.getPluginPath() ? ' Plugin manifest: ' + this.getPluginPath() : ''}`
												: activeTransport === "websocket"
													? `Connected via WebSocket Bridge to "${currentFileName || "unknown file"}" on port ${this.wsActualPort}. All design tools and console monitoring tools are available. Console logs are captured from the plugin sandbox (code.js). For full-page console monitoring including Figma app internals, add CDP (--remote-debugging-port=9222). IMPORTANT: Always verify the file name before destructive operations when multiple files have the plugin open.`
													: availablePages.length > 1
														? `Multiple Figma pages detected. Current page has ${monitorStatus?.workerCount || 0} workers.`
														: "All tools are ready to use.",
										},
										pluginPath: this.getPluginPath() || undefined,
										availablePages:
											availablePages.length > 0 ? availablePages : undefined,
										browser: {
											running: browserRunning,
											currentUrl,
										},
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
			"Force a complete reconnection to Figma Desktop. Works with both CDP and WebSocket transports. Use when connection seems stale or after switching files.",
			{},
			async () => {
				try {
					// Clear cached desktop connector to force fresh detection
					this.desktopConnector = null;

					let transport: string = "none";
					let currentUrl: string | null = null;
					let fileName: string | null = null;

					// Try CDP reconnection if browser manager exists
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
							transport = "cdp";
						} catch (cdpError) {
							logger.debug({ error: cdpError }, "CDP reconnection failed, checking WebSocket");
						}
					}

					// If CDP didn't work, check WebSocket
					if (transport === "none" && this.wsServer?.isClientConnected()) {
						transport = "websocket";
					}

					if (transport === "none") {
						throw new Error(
							"Cannot connect to Figma Desktop.\n\n" +
							"Option 1 (WebSocket): Open the Desktop Bridge plugin in Figma.\n" +
							"Option 2 (CDP): Launch Figma with --remote-debugging-port=9222"
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
										hint: "Open the Desktop Bridge plugin in Figma, or launch Figma with --remote-debugging-port=9222",
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
						// Fall back to CDP if available
						if (this.browserManager) {
							try {
								await this.ensureInitialized();
								const currentUrl = this.browserManager.getCurrentUrl();
								return {
									content: [{
										type: "text",
										text: JSON.stringify({
											transport: "cdp",
											files: currentUrl ? [{ url: currentUrl, isActive: true }] : [],
											message: "Using CDP transport. WebSocket not connected. Open the Desktop Bridge plugin for multi-file support.",
										}),
									}],
								};
							} catch {
								// CDP also unavailable
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

		// Tool: Execute arbitrary code in Figma plugin context (Power Tool)
		this.server.tool(
			"figma_execute",
			`Execute arbitrary JavaScript in Figma's plugin context with full access to the figma API. Use for complex operations not covered by other tools. Requires Desktop Bridge plugin. CAUTION: Can modify your document.

**COMPONENT INSTANCES:** For instances (node.type === 'INSTANCE'), use figma_set_instance_properties — direct text editing FAILS SILENTLY. Check instance.componentProperties for available props (may have #nodeId suffixes).

**RESULT ANALYSIS:** Check resultAnalysis.warning for silent failures (empty arrays, null returns).

**VALIDATION:** After creating/modifying visuals: screenshot with figma_capture_screenshot, check alignment/spacing/proportions, iterate up to 3x.

**PLACEMENT:** Always create components inside a Section or Frame, never on blank canvas. Use parent.insertChild(0, bg) for z-ordering backgrounds behind content.`,
			{
				code: z
					.string()
					.describe(
						"JavaScript code to execute. Has access to the 'figma' global object. " +
							"Example: 'const rect = figma.createRectangle(); rect.resize(100, 100); return { id: rect.id };'",
					),
				timeout: z
					.number()
					.optional()
					.default(5000)
					.describe(
						"Execution timeout in milliseconds (default: 5000, max: 30000)",
					),
			},
			async ({ code, timeout }) => {
				const maxRetries = 2;
				let lastError: Error | null = null;

				for (let attempt = 0; attempt <= maxRetries; attempt++) {
					try {
						const connector = await this.getDesktopConnector();
						const result = await connector.executeCodeViaUI(
							code,
							Math.min(timeout, 30000),
						);

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
											...(attempt > 0
												? { reconnected: true, attempts: attempt + 1 }
												: {}),
										},
									),
								},
							],
						};
					} catch (error) {
						lastError =
							error instanceof Error ? error : new Error(String(error));
						const errorMessage = lastError.message;

						// Check if it's a detached frame error - auto-reconnect
						if (
							errorMessage.includes("detached Frame") ||
							errorMessage.includes("Execution context was destroyed") ||
							errorMessage.includes("Target closed")
						) {
							logger.warn(
								{ attempt, error: errorMessage },
								"Detached frame detected, forcing reconnection",
							);

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
									logger.error(
										{ error: reconnectError },
										"Failed to reconnect",
									);
								}
							}
						}

						// Non-recoverable error or max retries exceeded
						break;
					}
				}

				// All retries failed
				logger.error(
					{ error: lastError },
					"Failed to execute code after retries",
				);
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
			"Update a single variable's value. For multiple updates, use figma_batch_update_variables instead (10-50x faster). Use figma_get_variables first for IDs. COLOR: hex '#FF0000', FLOAT: number, STRING: text, BOOLEAN: true/false. Requires Desktop Bridge plugin.",
			{
				variableId: z
					.string()
					.describe(
						"The variable ID to update (e.g., 'VariableID:123:456'). Get this from figma_get_variables.",
					),
				modeId: z
					.string()
					.describe(
						"The mode ID to update the value in (e.g., '1:0'). Get this from the variable's collection modes.",
					),
				value: z
					.union([z.string(), z.number(), z.boolean()])
					.describe(
						"The new value. For COLOR: hex string like '#FF0000'. For FLOAT: number. For STRING: text. For BOOLEAN: true/false.",
					),
			},
			async ({ variableId, modeId, value }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.updateVariable(
						variableId,
						modeId,
						value,
					);

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
										error:
											error instanceof Error ? error.message : String(error),
										message: "Failed to update variable",
										hint: "Make sure the Desktop Bridge plugin is running and the variable ID is correct",
									},
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
			"Create a single Figma variable. For multiple variables, use figma_batch_create_variables instead (10-50x faster). Use figma_get_variables first to get collection IDs. Supports COLOR, FLOAT, STRING, BOOLEAN. Requires Desktop Bridge plugin.",
			{
				name: z
					.string()
					.describe("Name for the new variable (e.g., 'primary-blue')"),
				collectionId: z
					.string()
					.describe(
						"The collection ID to create the variable in (e.g., 'VariableCollectionId:123:456'). Get this from figma_get_variables.",
					),
				resolvedType: z
					.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"])
					.describe("The variable type: COLOR, FLOAT, STRING, or BOOLEAN"),
				description: z
					.string()
					.optional()
					.describe("Optional description for the variable"),
				valuesByMode: z
					.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
					.optional()
					.describe(
						"Optional initial values by mode ID. Example: { '1:0': '#FF0000', '1:1': '#0000FF' }",
					),
			},
			async ({
				name,
				collectionId,
				resolvedType,
				description,
				valuesByMode,
			}) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.createVariable(
						name,
						collectionId,
						resolvedType,
						{
							description,
							valuesByMode,
						},
					);

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
										error:
											error instanceof Error ? error.message : String(error),
										message: "Failed to create variable",
										hint: "Make sure the Desktop Bridge plugin is running and the collection ID is correct",
									},
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
			"Create an empty variable collection. To create a collection WITH variables and modes in one step, use figma_setup_design_tokens instead. Requires Desktop Bridge plugin.",
			{
				name: z
					.string()
					.describe("Name for the new collection (e.g., 'Brand Colors')"),
				initialModeName: z
					.string()
					.optional()
					.describe(
						"Name for the initial mode (default mode is created automatically). Example: 'Light'",
					),
				additionalModes: z
					.array(z.string())
					.optional()
					.describe(
						"Additional mode names to create. Example: ['Dark', 'High Contrast']",
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
										error:
											error instanceof Error ? error.message : String(error),
										message: "Failed to create variable collection",
										hint: "Make sure the Desktop Bridge plugin is running in Figma",
									},
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
				variableId: z
					.string()
					.describe(
						"The variable ID to delete (e.g., 'VariableID:123:456'). Get this from figma_get_variables.",
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
										warning:
											"This action cannot be undone programmatically. Use Figma's Edit > Undo if needed.",
									},
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
										error:
											error instanceof Error ? error.message : String(error),
										message: "Failed to delete variable",
										hint: "Make sure the Desktop Bridge plugin is running and the variable ID is correct",
									},
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
				collectionId: z
					.string()
					.describe(
						"The collection ID to delete (e.g., 'VariableCollectionId:123:456'). Get this from figma_get_variables.",
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
										warning:
											"This action cannot be undone programmatically. Use Figma's Edit > Undo if needed.",
									},
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
										error:
											error instanceof Error ? error.message : String(error),
										message: "Failed to delete variable collection",
										hint: "Make sure the Desktop Bridge plugin is running and the collection ID is correct",
									},
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
				variableId: z
					.string()
					.describe(
						"The variable ID to rename (e.g., 'VariableID:123:456'). Get this from figma_get_variables.",
					),
				newName: z
					.string()
					.describe(
						"The new name for the variable. Can include slashes for grouping (e.g., 'colors/primary/background').",
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
										error:
											error instanceof Error ? error.message : String(error),
										message: "Failed to rename variable",
										hint: "Make sure the Desktop Bridge plugin is running and the variable ID is correct",
									},
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
				collectionId: z
					.string()
					.describe(
						"The collection ID to add the mode to (e.g., 'VariableCollectionId:123:456'). Get this from figma_get_variables.",
					),
				modeName: z
					.string()
					.describe(
						"The name for the new mode (e.g., 'Dark', 'Mobile', 'High Contrast').",
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
										error:
											error instanceof Error ? error.message : String(error),
										message: "Failed to add mode to collection",
										hint: "Make sure the Desktop Bridge plugin is running, the collection ID is correct, and you haven't exceeded Figma's mode limit",
									},
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
				collectionId: z
					.string()
					.describe(
						"The collection ID containing the mode (e.g., 'VariableCollectionId:123:456'). Get this from figma_get_variables.",
					),
				modeId: z
					.string()
					.describe(
						"The mode ID to rename (e.g., '123:0'). Get this from the collection's modes array in figma_get_variables.",
					),
				newName: z
					.string()
					.describe(
						"The new name for the mode (e.g., 'Dark Theme', 'Tablet').",
					),
			},
			async ({ collectionId, modeId, newName }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.renameMode(
						collectionId,
						modeId,
						newName,
					);

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
										error:
											error instanceof Error ? error.message : String(error),
										message: "Failed to rename mode",
										hint: "Make sure the Desktop Bridge plugin is running, the collection ID and mode ID are correct",
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
		// BATCH OPERATIONS (Performance-Optimized)
		// ============================================================================
		// Execute multiple variable operations in a single CDP call,
		// reducing per-operation overhead from ~60-170ms to near-zero.
		// Use these instead of calling individual tools repeatedly.

		// Tool: Batch create variables
		this.server.tool(
			"figma_batch_create_variables",
			"Create multiple variables in one operation. Use instead of calling figma_create_variable repeatedly — up to 50x faster for bulk operations. Get collection IDs from figma_get_variables first. Requires Desktop Bridge plugin.",
			{
				collectionId: z
					.string()
					.describe(
						"Collection ID to create all variables in (e.g., 'VariableCollectionId:123:456')",
					),
				variables: z
					.array(
						z.object({
							name: z.string().describe("Variable name (e.g., 'primary-blue')"),
							resolvedType: z
								.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"])
								.describe("Variable type"),
							description: z
								.string()
								.optional()
								.describe("Optional description"),
							valuesByMode: z
								.record(
									z.string(),
									z.union([z.string(), z.number(), z.boolean()]),
								)
								.optional()
								.describe(
									"Values by mode ID. For COLOR: hex like '#FF0000'. Example: { '1:0': '#FF0000' }",
								),
						}),
					)
					.min(1)
					.max(100)
					.describe("Array of variables to create (1-100)"),
			},
			async ({ collectionId, variables }) => {
				try {
					const connector = await this.getDesktopConnector();

					const script = `
const results = [];
const collectionId = ${JSON.stringify(collectionId)};
const vars = ${JSON.stringify(variables)};

function hexToRgba(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return {
    r: parseInt(hex.substring(0, 2), 16) / 255,
    g: parseInt(hex.substring(2, 4), 16) / 255,
    b: parseInt(hex.substring(4, 6), 16) / 255,
    a: hex.length === 8 ? parseInt(hex.substring(6, 8), 16) / 255 : 1
  };
}

const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
if (!collection) return { created: 0, failed: vars.length, results: vars.map(v => ({ success: false, name: v.name, error: 'Collection not found: ' + collectionId })) };

for (const v of vars) {
  try {
    const variable = figma.variables.createVariable(v.name, collection, v.resolvedType);
    if (v.description) variable.description = v.description;
    if (v.valuesByMode) {
      for (const [modeId, value] of Object.entries(v.valuesByMode)) {
        const processed = v.resolvedType === 'COLOR' && typeof value === 'string' ? hexToRgba(value) : value;
        variable.setValueForMode(modeId, processed);
      }
    }
    results.push({ success: true, name: v.name, id: variable.id });
  } catch (err) {
    results.push({ success: false, name: v.name, error: String(err) });
  }
}

return {
  created: results.filter(r => r.success).length,
  failed: results.filter(r => !r.success).length,
  results
};`;

					const timeout = Math.max(5000, variables.length * 200);
					const result = await connector.executeCodeViaUI(
						script,
						Math.min(timeout, 30000),
					);

					if (result.error) {
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											error: result.error,
											message:
												"Batch create failed during execution",
											hint: "Check that the collection ID is valid and the Desktop Bridge plugin is running",
										},
									),
								},
							],
							isError: true,
						};
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: `Batch created ${result.result?.created ?? 0} variables (${result.result?.failed ?? 0} failed)`,
										...result.result,
										timestamp: Date.now(),
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to batch create variables");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error
												? error.message
												: String(error),
										message: "Failed to batch create variables",
										hint: "Make sure the Desktop Bridge plugin is running and the collection ID is correct",
									},
								),
							},
						],
						isError: true,
					};
				}
			},
		);

		// Tool: Batch update variables
		this.server.tool(
			"figma_batch_update_variables",
			"Update multiple variable values in one operation. Use instead of calling figma_update_variable repeatedly — up to 50x faster for bulk updates. Get variable/mode IDs from figma_get_variables first. Requires Desktop Bridge plugin.",
			{
				updates: z
					.array(
						z.object({
							variableId: z
								.string()
								.describe(
									"Variable ID (e.g., 'VariableID:123:456')",
								),
							modeId: z
								.string()
								.describe("Mode ID (e.g., '1:0')"),
							value: z
								.union([z.string(), z.number(), z.boolean()])
								.describe(
									"New value. COLOR: hex like '#FF0000'. FLOAT: number. STRING: text. BOOLEAN: true/false.",
								),
						}),
					)
					.min(1)
					.max(100)
					.describe("Array of updates to apply (1-100)"),
			},
			async ({ updates }) => {
				try {
					const connector = await this.getDesktopConnector();

					const script = `
const results = [];
const updates = ${JSON.stringify(updates)};

function hexToRgba(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return {
    r: parseInt(hex.substring(0, 2), 16) / 255,
    g: parseInt(hex.substring(2, 4), 16) / 255,
    b: parseInt(hex.substring(4, 6), 16) / 255,
    a: hex.length === 8 ? parseInt(hex.substring(6, 8), 16) / 255 : 1
  };
}

for (const u of updates) {
  try {
    const variable = await figma.variables.getVariableByIdAsync(u.variableId);
    if (!variable) throw new Error('Variable not found: ' + u.variableId);
    const isColor = variable.resolvedType === 'COLOR';
    const processed = isColor && typeof u.value === 'string' ? hexToRgba(u.value) : u.value;
    variable.setValueForMode(u.modeId, processed);
    results.push({ success: true, variableId: u.variableId, name: variable.name });
  } catch (err) {
    results.push({ success: false, variableId: u.variableId, error: String(err) });
  }
}

return {
  updated: results.filter(r => r.success).length,
  failed: results.filter(r => !r.success).length,
  results
};`;

					const timeout = Math.max(5000, updates.length * 150);
					const result = await connector.executeCodeViaUI(
						script,
						Math.min(timeout, 30000),
					);

					if (result.error) {
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											error: result.error,
											message:
												"Batch update failed during execution",
											hint: "Check that variable IDs and mode IDs are valid",
										},
									),
								},
							],
							isError: true,
						};
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: `Batch updated ${result.result?.updated ?? 0} variables (${result.result?.failed ?? 0} failed)`,
										...result.result,
										timestamp: Date.now(),
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to batch update variables");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error
												? error.message
												: String(error),
										message: "Failed to batch update variables",
										hint: "Make sure the Desktop Bridge plugin is running and variable/mode IDs are correct",
									},
								),
							},
						],
						isError: true,
					};
				}
			},
		);

		// Tool: Setup design tokens (collection + modes + variables atomically)
		this.server.tool(
			"figma_setup_design_tokens",
			"Create a complete design token structure in one operation: collection, modes, and all variables. Ideal for importing CSS custom properties or design tokens into Figma. Requires Desktop Bridge plugin.",
			{
				collectionName: z
					.string()
					.describe("Name for the token collection (e.g., 'Brand Tokens')"),
				modes: z
					.array(z.string())
					.min(1)
					.max(4)
					.describe(
						"Mode names (first becomes default). Example: ['Light', 'Dark']",
					),
				tokens: z
					.array(
						z.object({
							name: z
								.string()
								.describe("Token name (e.g., 'color/primary')"),
							resolvedType: z
								.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"])
								.describe("Token type"),
							description: z
								.string()
								.optional()
								.describe("Optional description"),
							values: z
								.record(
									z.string(),
									z.union([z.string(), z.number(), z.boolean()]),
								)
								.describe(
									"Values keyed by mode NAME (not ID). Example: { 'Light': '#FFFFFF', 'Dark': '#000000' }",
								),
						}),
					)
					.min(1)
					.max(100)
					.describe("Token definitions (1-100)"),
			},
			async ({ collectionName, modes, tokens }) => {
				try {
					const connector = await this.getDesktopConnector();

					const script = `
const collectionName = ${JSON.stringify(collectionName)};
const modeNames = ${JSON.stringify(modes)};
const tokenDefs = ${JSON.stringify(tokens)};

function hexToRgba(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return {
    r: parseInt(hex.substring(0, 2), 16) / 255,
    g: parseInt(hex.substring(2, 4), 16) / 255,
    b: parseInt(hex.substring(4, 6), 16) / 255,
    a: hex.length === 8 ? parseInt(hex.substring(6, 8), 16) / 255 : 1
  };
}

// Step 1: Create collection
const collection = figma.variables.createVariableCollection(collectionName);
const modeMap = {};

// Step 2: Set up modes - first mode uses the default mode that was auto-created
const defaultModeId = collection.modes[0].modeId;
collection.renameMode(defaultModeId, modeNames[0]);
modeMap[modeNames[0]] = defaultModeId;

for (let i = 1; i < modeNames.length; i++) {
  const newModeId = collection.addMode(modeNames[i]);
  modeMap[modeNames[i]] = newModeId;
}

// Step 3: Create all variables with values
const results = [];
for (const t of tokenDefs) {
  try {
    const variable = figma.variables.createVariable(t.name, collection, t.resolvedType);
    if (t.description) variable.description = t.description;
    for (const [modeName, value] of Object.entries(t.values)) {
      const modeId = modeMap[modeName];
      if (!modeId) { results.push({ success: false, name: t.name, error: 'Unknown mode: ' + modeName }); continue; }
      const processed = t.resolvedType === 'COLOR' && typeof value === 'string' ? hexToRgba(value) : value;
      variable.setValueForMode(modeId, processed);
    }
    results.push({ success: true, name: t.name, id: variable.id });
  } catch (err) {
    results.push({ success: false, name: t.name, error: String(err) });
  }
}

return {
  collectionId: collection.id,
  collectionName: collectionName,
  modes: modeMap,
  created: results.filter(r => r.success).length,
  failed: results.filter(r => !r.success).length,
  results
};`;

					const timeout = Math.max(
						10000,
						tokens.length * 200 + modes.length * 500,
					);
					const result = await connector.executeCodeViaUI(
						script,
						Math.min(timeout, 30000),
					);

					if (result.error) {
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											error: result.error,
											message:
												"Design token setup failed during execution",
											hint: "Check the token definitions and ensure the Desktop Bridge plugin is running",
										},
									),
								},
							],
							isError: true,
						};
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: `Created collection "${collectionName}" with ${modes.length} mode(s) and ${result.result?.created ?? 0} tokens`,
										...result.result,
										timestamp: Date.now(),
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to setup design tokens");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error
												? error.message
												: String(error),
										message: "Failed to setup design tokens",
										hint: "Make sure the Desktop Bridge plugin is running in Figma",
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
		// DESIGN SYSTEM TOOLS (Token-Efficient Tool Family)
		// ============================================================================
		// These tools provide progressive disclosure of design system data
		// to minimize context window usage. Start with summary, then search,
		// then get details for specific components.

		// Helper function to ensure design system cache is loaded (auto-loads if needed)
		const ensureDesignSystemCache = async (): Promise<{
			cacheEntry: any;
			fileKey: string;
			wasLoaded: boolean;
		}> => {
			const {
				DesignSystemManifestCache,
				createEmptyManifest,
				figmaColorToHex,
			} = await import("./core/design-system-manifest.js");

			const cache = DesignSystemManifestCache.getInstance();
			const currentUrl = this.getCurrentFileUrl();
			const fileKeyMatch = currentUrl?.match(/\/(file|design)\/([a-zA-Z0-9]+)/);
			const fileKey = fileKeyMatch ? fileKeyMatch[2] : "unknown";

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
					for (const collection of variablesResult.data.variableCollections ||
						[]) {
						manifest.collections.push({
							id: collection.id,
							name: collection.name,
							modes: collection.modes.map((m: any) => ({
								modeId: m.modeId,
								name: m.name,
							})),
							defaultModeId: collection.defaultModeId,
						});
					}
					for (const variable of variablesResult.data.variables || []) {
						const tokenName = variable.name;
						const defaultModeId = manifest.collections.find(
							(c: any) => c.id === variable.variableCollectionId,
						)?.defaultModeId;
						const defaultValue = defaultModeId
							? variable.valuesByMode?.[defaultModeId]
							: undefined;

						if (variable.resolvedType === "COLOR") {
							manifest.tokens.colors[tokenName] = {
								name: tokenName,
								value: figmaColorToHex(defaultValue),
								variableId: variable.id,
								scopes: variable.scopes,
							};
						} else if (variable.resolvedType === "FLOAT") {
							manifest.tokens.spacing[tokenName] = {
								name: tokenName,
								value: typeof defaultValue === "number" ? defaultValue : 0,
								variableId: variable.id,
							};
						}
					}
				}
			} catch (error) {
				logger.warn({ error }, "Could not fetch variables during auto-load");
			}

			// Get components
			let rawComponents:
				| { components: any[]; componentSets: any[] }
				| undefined;
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
							variants:
								compSet.variants?.map((v: any) => ({
									key: v.key,
									nodeId: v.nodeId,
									name: v.name,
								})) || [],
							variantAxes:
								compSet.variantAxes?.map((a: any) => ({
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
				totalTokens:
					Object.keys(manifest.tokens.colors).length +
					Object.keys(manifest.tokens.spacing).length,
				totalComponents: Object.keys(manifest.components).length,
				totalComponentSets: Object.keys(manifest.componentSets).length,
				colorPalette: Object.keys(manifest.tokens.colors).slice(0, 10),
				spacingScale: Object.values(manifest.tokens.spacing)
					.map((s: any) => s.value)
					.sort((a: number, b: number) => a - b)
					.slice(0, 10),
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
				forceRefresh: z
					.boolean()
					.optional()
					.default(false)
					.describe(
						"Force refresh the cached data (use sparingly - extraction can take minutes for large files)",
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
					} = await import("./core/design-system-manifest.js");

					const cache = DesignSystemManifestCache.getInstance();
					const currentUrl = this.getCurrentFileUrl();
					const fileKeyMatch = currentUrl?.match(
						/\/(file|design)\/([a-zA-Z0-9]+)/,
					);
					const fileKey = fileKeyMatch ? fileKeyMatch[2] : "unknown";

					// Check cache first
					let cacheEntry = cache.get(fileKey);
					if (cacheEntry && !forceRefresh) {
						const categories = getCategories(cacheEntry.manifest);
						const tokenSummary = getTokenSummary(cacheEntry.manifest);
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											success: true,
											cached: true,
											cacheAge: Math.round(
												(Date.now() - cacheEntry.timestamp) / 1000,
											),
											fileKey,
											categories: categories.slice(0, 15),
											tokens: tokenSummary,
											totals: {
												components: cacheEntry.manifest.summary.totalComponents,
												componentSets:
													cacheEntry.manifest.summary.totalComponentSets,
												tokens: cacheEntry.manifest.summary.totalTokens,
											},
											hint: "Use figma_search_components to find specific components by name or category.",
										},
									),
								},
							],
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
							for (const collection of variablesResult.data
								.variableCollections || []) {
								manifest.collections.push({
									id: collection.id,
									name: collection.name,
									modes: collection.modes.map((m: any) => ({
										modeId: m.modeId,
										name: m.name,
									})),
									defaultModeId: collection.defaultModeId,
								});
							}
							for (const variable of variablesResult.data.variables || []) {
								const tokenName = variable.name;
								const defaultModeId = manifest.collections.find(
									(c) => c.id === variable.variableCollectionId,
								)?.defaultModeId;
								const defaultValue = defaultModeId
									? variable.valuesByMode?.[defaultModeId]
									: undefined;

								if (variable.resolvedType === "COLOR") {
									manifest.tokens.colors[tokenName] = {
										name: tokenName,
										value: figmaColorToHex(defaultValue),
										variableId: variable.id,
										scopes: variable.scopes,
									};
								} else if (variable.resolvedType === "FLOAT") {
									manifest.tokens.spacing[tokenName] = {
										name: tokenName,
										value: typeof defaultValue === "number" ? defaultValue : 0,
										variableId: variable.id,
									};
								}
							}
						}
					} catch (error) {
						logger.warn({ error }, "Could not fetch variables");
					}

					// Get components (can be slow for large files)
					let rawComponents:
						| { components: any[]; componentSets: any[] }
						| undefined;
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
									variants:
										compSet.variants?.map((v: any) => ({
											key: v.key,
											nodeId: v.nodeId,
											name: v.name,
										})) || [],
									variantAxes:
										compSet.variantAxes?.map((a: any) => ({
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
						totalTokens:
							Object.keys(manifest.tokens.colors).length +
							Object.keys(manifest.tokens.spacing).length,
						totalComponents: Object.keys(manifest.components).length,
						totalComponentSets: Object.keys(manifest.componentSets).length,
						colorPalette: Object.keys(manifest.tokens.colors).slice(0, 10),
						spacingScale: Object.values(manifest.tokens.spacing)
							.map((s) => s.value)
							.sort((a, b) => a - b)
							.slice(0, 10),
						typographyScale: [],
						componentCategories: [],
					};

					// Cache the result
					cache.set(fileKey, manifest, rawComponents);

					const categories = getCategories(manifest);
					const tokenSummary = getTokenSummary(manifest);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
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
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to get design system summary");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error ? error.message : String(error),
										hint: "Make sure the Desktop Bridge plugin is running in Figma",
									},
								),
							},
						],
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
				query: z
					.string()
					.optional()
					.default("")
					.describe("Search query to match component names or descriptions"),
				category: z
					.string()
					.optional()
					.describe("Filter by category (e.g., 'Button', 'Input', 'Card')"),
				limit: z
					.number()
					.optional()
					.default(10)
					.describe("Maximum results to return (default: 10, max: 25)"),
				offset: z
					.number()
					.optional()
					.default(0)
					.describe("Offset for pagination"),
			},
			async ({ query, category, limit, offset }) => {
				try {
					const { searchComponents } = await import(
						"./core/design-system-manifest.js"
					);

					// Auto-load design system cache if needed (no error returned to user)
					const { cacheEntry } = await ensureDesignSystemCache();
					if (!cacheEntry) {
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											error:
												"Could not load design system data. Make sure the Desktop Bridge plugin is running.",
										},
									),
								},
							],
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
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
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
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to search components");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error ? error.message : String(error),
									},
								),
							},
						],
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
				componentKey: z
					.string()
					.optional()
					.describe("The component key (preferred for exact match)"),
				componentName: z
					.string()
					.optional()
					.describe("The component name (used if key not provided)"),
			},
			async ({ componentKey, componentName }) => {
				try {
					if (!componentKey && !componentName) {
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											error: "Either componentKey or componentName is required",
										},
									),
								},
							],
							isError: true,
						};
					}

					// Auto-load design system cache if needed
					const { cacheEntry } = await ensureDesignSystemCache();
					if (!cacheEntry) {
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											error:
												"Could not load design system data. Make sure the Desktop Bridge plugin is running.",
										},
									),
								},
							],
							isError: true,
						};
					}

					// Search for the component
					let component: any = null;
					let isComponentSet = false;

					// Check component sets first (they have variants)
					for (const [name, compSet] of Object.entries(
						cacheEntry.manifest.componentSets,
					) as [string, any][]) {
						if (
							(componentKey && compSet.key === componentKey) ||
							(componentName && name === componentName)
						) {
							component = compSet;
							isComponentSet = true;
							break;
						}
					}

					// Check standalone components
					if (!component) {
						for (const [name, comp] of Object.entries(
							cacheEntry.manifest.components,
						) as [string, any][]) {
							if (
								(componentKey && comp.key === componentKey) ||
								(componentName && name === componentName)
							) {
								component = comp;
								break;
							}
						}
					}

					if (!component) {
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											error: `Component not found: ${componentKey || componentName}`,
											hint: "Use figma_search_components to find available components.",
										},
									),
								},
							],
							isError: true,
						};
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										type: isComponentSet ? "componentSet" : "component",
										component,
										instantiation: {
											key: component.key,
											example: `Use figma_instantiate_component with componentKey: "${component.key}"`,
										},
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to get component details");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error ? error.message : String(error),
									},
								),
							},
						],
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
				type: z
					.enum(["colors", "spacing", "all"])
					.optional()
					.default("all")
					.describe("Type of tokens to retrieve"),
				filter: z
					.string()
					.optional()
					.describe(
						"Filter token names (e.g., 'primary' to get all primary colors)",
					),
				limit: z
					.number()
					.optional()
					.default(50)
					.describe("Maximum tokens to return (default: 50)"),
			},
			async ({ type, filter, limit }) => {
				try {
					// Auto-load design system cache if needed
					const { cacheEntry } = await ensureDesignSystemCache();
					if (!cacheEntry) {
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											error:
												"Could not load design system data. Make sure the Desktop Bridge plugin is running.",
										},
									),
								},
							],
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
						for (const [name, token] of Object.entries(tokens.colors) as [
							string,
							any,
						][]) {
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
						for (const [name, token] of Object.entries(tokens.spacing) as [
							string,
							any,
						][]) {
							if (count >= effectiveLimit) break;
							if (!filterLower || name.toLowerCase().includes(filterLower)) {
								spacing[name] = { value: token.value };
								count++;
							}
						}
						result.spacing = spacing;
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										type,
										filter: filter || "(none)",
										tokens: result,
										hint: "Use these exact token names and values when generating designs.",
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to get token values");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error ? error.message : String(error),
									},
								),
							},
						],
						isError: true,
					};
				}
			},
		);

		// Tool 5: Instantiate Component
		this.server.tool(
			"figma_instantiate_component",
			`Create an instance of a component from the design system.

**CRITICAL: Always pass BOTH componentKey AND nodeId together!**
Search results return both identifiers. Pass both so the tool can automatically fall back to nodeId if the component isn't published to a library. Most local/unpublished components require nodeId.

**IMPORTANT: Always re-search before instantiating!**
NodeIds are session-specific and may be stale from previous conversations. ALWAYS search for components at the start of each design session to get current, valid identifiers.

**VISUAL VALIDATION WORKFLOW:**
After instantiating components, use figma_take_screenshot to verify the result looks correct. Check placement, sizing, and visual balance.`,
			{
				componentKey: z
					.string()
					.optional()
					.describe(
						"The component key from search results. Pass this WITH nodeId for automatic fallback.",
					),
				nodeId: z
					.string()
					.optional()
					.describe(
						"The node ID from search results. ALWAYS pass this alongside componentKey - most local components need it.",
					),
				variant: z
					.record(z.string())
					.optional()
					.describe(
						"Variant properties to set (e.g., { Type: 'Simple', State: 'Active' })",
					),
				overrides: z
					.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
					.optional()
					.describe(
						"Property overrides (e.g., { 'Button Label': 'Click Me' })",
					),
				position: z
					.object({
						x: z.number(),
						y: z.number(),
					})
					.optional()
					.describe("Position on canvas (default: 0, 0)"),
				parentId: z
					.string()
					.optional()
					.describe("Parent node ID to append the instance to"),
			},
			async ({
				componentKey,
				nodeId,
				variant,
				overrides,
				position,
				parentId,
			}) => {
				try {
					if (!componentKey && !nodeId) {
						throw new Error("Either componentKey or nodeId is required");
					}
					const connector = await this.getDesktopConnector();
					const result = await connector.instantiateComponent(
						componentKey || "",
						{
							nodeId,
							position,
							overrides,
							variant,
							parentId,
						},
					);

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
										error:
											error instanceof Error ? error.message : String(error),
										message: "Failed to instantiate component",
										hint: "Make sure the component key is correct and the Desktop Bridge plugin is running",
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
		// NEW: Component Property Management Tools
		// ============================================================================

		// Tool: Set Node Description
		this.server.tool(
			"figma_set_description",
			"Set the description text on a component, component set, or style. Descriptions appear in Dev Mode and help document design intent. Supports plain text and markdown formatting.",
			{
				nodeId: z
					.string()
					.describe(
						"The node ID of the component or style to update (e.g., '123:456')",
					),
				description: z.string().describe("The plain text description to set"),
				descriptionMarkdown: z
					.string()
					.optional()
					.describe("Optional rich text description using markdown formatting"),
			},
			async ({ nodeId, description, descriptionMarkdown }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.setNodeDescription(
						nodeId,
						description,
						descriptionMarkdown,
					);

					if (!result.success) {
						throw new Error(result.error || "Failed to set description");
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: "Description set successfully",
										node: result.node,
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to set description");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error ? error.message : String(error),
										hint: "Make sure the node supports descriptions (components, component sets, styles)",
									},
								),
							},
						],
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
				nodeId: z.string().describe("The component or component set node ID"),
				propertyName: z
					.string()
					.describe(
						"Name for the new property (e.g., 'Show Icon', 'Button Label')",
					),
				type: z
					.enum(["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT"])
					.describe(
						"Property type: BOOLEAN for toggles, TEXT for strings, INSTANCE_SWAP for component swaps, VARIANT for variant selection",
					),
				defaultValue: z
					.union([z.string(), z.number(), z.boolean()])
					.describe(
						"Default value for the property. BOOLEAN: true/false, TEXT: string, INSTANCE_SWAP: component key, VARIANT: variant value",
					),
			},
			async ({ nodeId, propertyName, type, defaultValue }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.addComponentProperty(
						nodeId,
						propertyName,
						type,
						defaultValue,
					);

					if (!result.success) {
						throw new Error(result.error || "Failed to add property");
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: "Component property added",
										propertyName: result.propertyName,
										hint: "The property name includes a unique suffix (e.g., 'Show Icon#123:456'). Use the full name for editing/deleting.",
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to add component property");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error ? error.message : String(error),
										hint: "Cannot add properties to variant components. Add to the parent component set instead.",
									},
								),
							},
						],
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
				nodeId: z.string().describe("The component or component set node ID"),
				propertyName: z
					.string()
					.describe(
						"The full property name with suffix (e.g., 'Show Icon#123:456')",
					),
				newValue: z
					.object({
						name: z.string().optional().describe("New name for the property"),
						defaultValue: z
							.union([z.string(), z.number(), z.boolean()])
							.optional()
							.describe("New default value"),
						preferredValues: z
							.array(
								z.object({
									type: z
										.enum(["COMPONENT", "COMPONENT_SET"])
										.describe("Type of preferred value"),
									key: z.string().describe("Component or component set key"),
								}),
							)
							.optional()
							.describe("Preferred values (INSTANCE_SWAP only)"),
					})
					.describe("Object with the values to update"),
			},
			async ({ nodeId, propertyName, newValue }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.editComponentProperty(
						nodeId,
						propertyName,
						newValue,
					);

					if (!result.success) {
						throw new Error(result.error || "Failed to edit property");
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: "Component property updated",
										propertyName: result.propertyName,
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to edit component property");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error ? error.message : String(error),
									},
								),
							},
						],
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
				nodeId: z.string().describe("The component or component set node ID"),
				propertyName: z
					.string()
					.describe(
						"The full property name with suffix (e.g., 'Show Icon#123:456')",
					),
			},
			async ({ nodeId, propertyName }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.deleteComponentProperty(
						nodeId,
						propertyName,
					);

					if (!result.success) {
						throw new Error(result.error || "Failed to delete property");
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: "Component property deleted",
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to delete component property");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error ? error.message : String(error),
										hint: "Cannot delete VARIANT properties. Only BOOLEAN, TEXT, and INSTANCE_SWAP can be deleted.",
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
				withConstraints: z
					.boolean()
					.optional()
					.default(true)
					.describe(
						"Whether to apply child constraints during resize (default: true)",
					),
			},
			async ({ nodeId, width, height, withConstraints }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.resizeNode(
						nodeId,
						width,
						height,
						withConstraints,
					);

					if (!result.success) {
						throw new Error(result.error || "Failed to resize node");
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: `Node resized to ${width}x${height}`,
										node: result.node,
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to resize node");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error ? error.message : String(error),
									},
								),
							},
						],
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
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: `Node moved to (${x}, ${y})`,
										node: result.node,
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to move node");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error ? error.message : String(error),
									},
								),
							},
						],
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
				fills: z
					.array(
						z.object({
							type: z
								.literal("SOLID")
								.describe("Fill type (currently only SOLID supported)"),
							color: z
								.string()
								.describe(
									"Hex color string (e.g., '#FF0000', '#FF000080' for transparency)",
								),
							opacity: z
								.number()
								.optional()
								.describe("Opacity 0-1 (default: 1)"),
						}),
					)
					.describe("Array of fill objects"),
			},
			async ({ nodeId, fills }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.setNodeFills(nodeId, fills);

					if (!result.success) {
						throw new Error(result.error || "Failed to set fills");
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: "Fills updated",
										node: result.node,
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to set fills");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error ? error.message : String(error),
									},
								),
							},
						],
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
				strokes: z
					.array(
						z.object({
							type: z.literal("SOLID").describe("Stroke type"),
							color: z.string().describe("Hex color string"),
							opacity: z.number().optional().describe("Opacity 0-1"),
						}),
					)
					.describe("Array of stroke objects"),
				strokeWeight: z
					.number()
					.optional()
					.describe("Stroke thickness in pixels"),
			},
			async ({ nodeId, strokes, strokeWeight }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.setNodeStrokes(
						nodeId,
						strokes,
						strokeWeight,
					);

					if (!result.success) {
						throw new Error(result.error || "Failed to set strokes");
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: "Strokes updated",
										node: result.node,
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to set strokes");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error ? error.message : String(error),
									},
								),
							},
						],
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
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: "Node cloned",
										clonedNode: result.node,
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to clone node");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error ? error.message : String(error),
									},
								),
							},
						],
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
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: "Node deleted",
										deleted: result.deleted,
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to delete node");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error ? error.message : String(error),
									},
								),
							},
						],
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
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: `Node renamed to "${newName}"`,
										node: result.node,
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to rename node");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error ? error.message : String(error),
									},
								),
							},
						],
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
					const result = await connector.setTextContent(
						nodeId,
						text,
						fontSize ? { fontSize } : undefined,
					);

					if (!result.success) {
						throw new Error(result.error || "Failed to set text");
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: "Text content updated",
										node: result.node,
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to set text content");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error ? error.message : String(error),
										hint: "Make sure the node is a TEXT node",
									},
								),
							},
						],
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
				nodeType: z
					.enum(["RECTANGLE", "ELLIPSE", "FRAME", "TEXT", "LINE"])
					.describe("Type of node to create"),
				properties: z
					.object({
						name: z.string().optional().describe("Name for the new node"),
						x: z.number().optional().describe("X position within parent"),
						y: z.number().optional().describe("Y position within parent"),
						width: z.number().optional().describe("Width (default: 100)"),
						height: z.number().optional().describe("Height (default: 100)"),
						fills: z
							.array(
								z.object({
									type: z.literal("SOLID"),
									color: z.string(),
								}),
							)
							.optional()
							.describe("Fill colors (hex strings)"),
						text: z
							.string()
							.optional()
							.describe("Text content (for TEXT nodes only)"),
					})
					.optional()
					.describe("Properties for the new node"),
			},
			async ({ parentId, nodeType, properties }) => {
				try {
					const connector = await this.getDesktopConnector();
					const result = await connector.createChildNode(
						parentId,
						nodeType,
						properties,
					);

					if (!result.success) {
						throw new Error(result.error || "Failed to create node");
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										message: `Created ${nodeType} node`,
										node: result.node,
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to create child node");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error ? error.message : String(error),
										hint: "Make sure the parent node supports children (frames, groups, etc.)",
									},
								),
							},
						],
						isError: true,
					};
				}
			},
		);

		// Tool: Arrange Component Set (Professional Layout with Native Visualization)
		// Recreates component set using figma.combineAsVariants() for proper purple dashed frame
		this.server.tool(
			"figma_arrange_component_set",
			`Organize a component set with Figma's native purple dashed visualization. Use after creating variants, adding states (hover/disabled/pressed), or when component sets need cleanup.

Recreates the set using figma.combineAsVariants() for proper Figma integration, applies purple dashed border styling, and arranges variants in a labeled grid (columns = last property like State, rows = other properties like Type+Size). Creates a white container with title, row/column labels, and the component set.`,
			{
				componentSetId: z
					.string()
					.optional()
					.describe(
						"Node ID of the component set to arrange. If not provided, will look for a selected component set.",
					),
				componentSetName: z
					.string()
					.optional()
					.describe(
						"Name of the component set to find. Used if componentSetId not provided.",
					),
				options: z
					.object({
						gap: z
							.number()
							.optional()
							.default(24)
							.describe("Gap between grid cells in pixels (default: 24)"),
						cellPadding: z
							.number()
							.optional()
							.default(20)
							.describe(
								"Padding inside each cell around the variant (default: 20)",
							),
						columnProperty: z
							.string()
							.optional()
							.describe(
								"Property to use for columns (default: auto-detect last property, usually 'State')",
							),
					})
					.optional()
					.describe("Layout options"),
			},
			async ({ componentSetId, componentSetName, options }) => {
				try {
					const connector = await this.getDesktopConnector();

					// Build the code to execute in Figma
					const code = `
// ============================================================================
// COMPONENT SET ARRANGEMENT WITH PROPER LABELS AND CONTAINER
// Creates: White container frame → Row labels (left) → Column headers (top) → Component set (center)
// Uses auto-layout for proper alignment of labels with grid cells
// ============================================================================

// Configuration
const config = ${JSON.stringify(options || {})};
const gap = config.gap ?? 24;
const cellPadding = config.cellPadding ?? 20;
const columnProperty = config.columnProperty || null;

// Layout constants
const LABEL_FONT_SIZE = 12;
const LABEL_COLOR = { r: 0.4, g: 0.4, b: 0.4 };  // Gray text
const TITLE_FONT_SIZE = 24;
const TITLE_COLOR = { r: 0.1, g: 0.1, b: 0.1 };  // Dark text
const CONTAINER_PADDING = 40;
const LABEL_GAP = 16;  // Gap between labels and component set
const COLUMN_HEADER_HEIGHT = 32;

// Find the component set
let componentSet = null;
const csId = ${JSON.stringify(componentSetId || null)};
const csName = ${JSON.stringify(componentSetName || null)};

if (csId) {
	componentSet = await figma.getNodeByIdAsync(csId);
} else if (csName) {
	const allNodes = figma.currentPage.findAll(n => n.type === "COMPONENT_SET" && n.name === csName);
	componentSet = allNodes[0];
} else {
	const selection = figma.currentPage.selection;
	componentSet = selection.find(n => n.type === "COMPONENT_SET");
}

if (!componentSet || componentSet.type !== "COMPONENT_SET") {
	return { error: "Component set not found. Provide componentSetId, componentSetName, or select a component set." };
}

const page = figma.currentPage;
const csOriginalX = componentSet.x;
const csOriginalY = componentSet.y;
const csOriginalName = componentSet.name;

// Get all variant components
const variants = componentSet.children.filter(n => n.type === "COMPONENT");
if (variants.length === 0) {
	return { error: "No variants found in component set" };
}

// Parse variant properties from names
const parseVariantName = (name) => {
	const props = {};
	const parts = name.split(", ");
	for (const part of parts) {
		const [key, value] = part.split("=");
		if (key && value) {
			props[key.trim()] = value.trim();
		}
	}
	return props;
};

// Collect all properties and their unique values (preserving order)
const propertyValues = {};
const propertyOrder = [];
for (const variant of variants) {
	const props = parseVariantName(variant.name);
	for (const [key, value] of Object.entries(props)) {
		if (!propertyValues[key]) {
			propertyValues[key] = new Set();
			propertyOrder.push(key);
		}
		propertyValues[key].add(value);
	}
}
for (const key of Object.keys(propertyValues)) {
	propertyValues[key] = Array.from(propertyValues[key]);
}

// Determine grid structure: columns = last property (usually State), rows = other properties
const columnProp = columnProperty || propertyOrder[propertyOrder.length - 1];
const columnValues = propertyValues[columnProp] || [];
const rowProps = propertyOrder.filter(p => p !== columnProp);

// Generate all row combinations
const generateRowCombinations = (props, values) => {
	if (props.length === 0) return [{}];
	if (props.length === 1) {
		return values[props[0]].map(v => ({ [props[0]]: v }));
	}
	const result = [];
	const firstProp = props[0];
	const restProps = props.slice(1);
	const restCombos = generateRowCombinations(restProps, values);
	for (const value of values[firstProp]) {
		for (const combo of restCombos) {
			result.push({ [firstProp]: value, ...combo });
		}
	}
	return result;
};
const rowCombinations = generateRowCombinations(rowProps, propertyValues);

const totalCols = columnValues.length;
const totalRows = rowCombinations.length;

// Calculate max variant dimensions
let maxVariantWidth = 0;
let maxVariantHeight = 0;
for (const v of variants) {
	if (v.width > maxVariantWidth) maxVariantWidth = v.width;
	if (v.height > maxVariantHeight) maxVariantHeight = v.height;
}

// Calculate cell dimensions (each cell in the grid)
const cellWidth = Math.ceil(maxVariantWidth + cellPadding);
const cellHeight = Math.ceil(maxVariantHeight + cellPadding);

// Calculate component set dimensions
const edgePadding = 24;  // Padding inside component set
const csWidth = (totalCols * cellWidth) + ((totalCols - 1) * gap) + (edgePadding * 2);
const csHeight = (totalRows * cellHeight) + ((totalRows - 1) * gap) + (edgePadding * 2);

// ============================================================================
// STEP 1: Remove old labels and container frames from previous arrangements
// ============================================================================
const oldElements = page.children.filter(n =>
	(n.type === "TEXT" && (n.name.startsWith("Row: ") || n.name.startsWith("Col: "))) ||
	(n.type === "FRAME" && (n.name === "Component Container" || n.name === "Row Labels" || n.name === "Column Headers"))
);
for (const el of oldElements) {
	el.remove();
}

// ============================================================================
// STEP 2: Clone variants and recreate component set with native visualization
// ============================================================================
const clonedVariants = [];
for (const variant of variants) {
	const clone = variant.clone();
	page.appendChild(clone);
	clonedVariants.push(clone);
}

// Delete the old component set
componentSet.remove();

// Recreate using figma.combineAsVariants() for native purple dashed frame
const newComponentSet = figma.combineAsVariants(clonedVariants, page);
newComponentSet.name = csOriginalName;

// Apply purple dashed border (Figma's native component set styling)
newComponentSet.strokes = [{
	type: 'SOLID',
	color: { r: 151/255, g: 71/255, b: 255/255 }  // Figma's purple: #9747FF
}];
newComponentSet.dashPattern = [10, 5];
newComponentSet.strokeWeight = 1;
newComponentSet.strokeAlign = "INSIDE";

// ============================================================================
// STEP 3: Arrange variants in grid pattern inside component set
// ============================================================================
const newVariants = newComponentSet.children.filter(n => n.type === "COMPONENT");

for (const variant of newVariants) {
	const props = parseVariantName(variant.name);
	const colValue = props[columnProp];
	const colIdx = columnValues.indexOf(colValue);

	// Find matching row
	let rowIdx = -1;
	for (let i = 0; i < rowCombinations.length; i++) {
		const combo = rowCombinations[i];
		let match = true;
		for (const [key, value] of Object.entries(combo)) {
			if (props[key] !== value) {
				match = false;
				break;
			}
		}
		if (match) {
			rowIdx = i;
			break;
		}
	}

	if (colIdx >= 0 && rowIdx >= 0) {
		// Calculate cell position
		const cellX = edgePadding + colIdx * (cellWidth + gap);
		const cellY = edgePadding + rowIdx * (cellHeight + gap);

		// Center variant within cell
		const variantX = Math.round(cellX + (cellWidth - variant.width) / 2);
		const variantY = Math.round(cellY + (cellHeight - variant.height) / 2);

		variant.x = variantX;
		variant.y = variantY;
	}
}

// Resize component set to fit grid
newComponentSet.resize(csWidth, csHeight);

// ============================================================================
// STEP 4: Create white container frame with proper structure
// ============================================================================

// Load font for labels
await figma.loadFontAsync({ family: "Inter", style: "Regular" });
await figma.loadFontAsync({ family: "Inter", style: "Semi Bold" });

// Create the main container frame (white background)
const containerFrame = figma.createFrame();
containerFrame.name = "Component Container";
containerFrame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];  // White
containerFrame.cornerRadius = 8;
containerFrame.layoutMode = 'VERTICAL';
containerFrame.primaryAxisSizingMode = 'AUTO';
containerFrame.counterAxisSizingMode = 'AUTO';
containerFrame.paddingTop = CONTAINER_PADDING;
containerFrame.paddingRight = CONTAINER_PADDING;
containerFrame.paddingBottom = CONTAINER_PADDING;
containerFrame.paddingLeft = CONTAINER_PADDING;
containerFrame.itemSpacing = 24;

// Add title
const titleText = figma.createText();
titleText.name = "Title";
titleText.characters = csOriginalName;
titleText.fontSize = TITLE_FONT_SIZE;
titleText.fontName = { family: "Inter", style: "Semi Bold" };
titleText.fills = [{ type: 'SOLID', color: TITLE_COLOR }];
// Append to parent FIRST, then set layoutSizing
containerFrame.appendChild(titleText);
titleText.layoutSizingHorizontal = 'HUG';
titleText.layoutSizingVertical = 'HUG';

// Create content row (horizontal: row labels + grid column)
const contentRow = figma.createFrame();
contentRow.name = "Content Row";
contentRow.fills = [];  // Transparent
contentRow.layoutMode = 'HORIZONTAL';
contentRow.primaryAxisSizingMode = 'AUTO';
contentRow.counterAxisSizingMode = 'AUTO';
contentRow.itemSpacing = LABEL_GAP;
contentRow.counterAxisAlignItems = 'MIN';  // Align to top
containerFrame.appendChild(contentRow);

// ============================================================================
// STEP 5: Create row labels column (left side)
// ============================================================================
const rowLabelsFrame = figma.createFrame();
rowLabelsFrame.name = "Row Labels";
rowLabelsFrame.fills = [];  // Transparent
rowLabelsFrame.layoutMode = 'VERTICAL';
rowLabelsFrame.primaryAxisSizingMode = 'AUTO';
rowLabelsFrame.counterAxisSizingMode = 'AUTO';
rowLabelsFrame.counterAxisAlignItems = 'MAX';  // Right-align text
rowLabelsFrame.itemSpacing = 0;  // No spacing - we'll use fixed heights

// Add spacer for column headers alignment
// Must account for: column header height + gap + component set's internal edgePadding
const rowLabelSpacer = figma.createFrame();
rowLabelSpacer.name = "Spacer";
rowLabelSpacer.fills = [];
rowLabelSpacer.resize(10, COLUMN_HEADER_HEIGHT + gap + edgePadding);  // Align with first row inside component set
rowLabelsFrame.appendChild(rowLabelSpacer);
// IMPORTANT: Set layoutSizing AFTER appendChild (node must be in auto-layout parent first)
rowLabelSpacer.layoutSizingVertical = 'FIXED';

// Create row labels - each with VERTICAL layout for direct vertical centering
// Using VERTICAL layout: primaryAxis = vertical, counterAxis = horizontal
// So primaryAxisAlignItems = 'CENTER' directly controls vertical centering
for (let i = 0; i < rowCombinations.length; i++) {
	const combo = rowCombinations[i];
	const labelText = rowProps.map(p => combo[p]).join(" / ");
	const isLastRow = (i === rowCombinations.length - 1);

	// Create a frame to hold the label with VERTICAL layout
	const rowLabelContainer = figma.createFrame();
	rowLabelContainer.name = "Row: " + labelText;
	rowLabelContainer.fills = [];
	rowLabelContainer.layoutMode = 'VERTICAL';  // VERTICAL so primaryAxis controls Y
	rowLabelContainer.primaryAxisSizingMode = 'FIXED';  // CRITICAL: Don't hug content, maintain fixed height
	rowLabelContainer.primaryAxisAlignItems = 'CENTER';  // CENTER = vertically centered within fixed height
	rowLabelContainer.counterAxisAlignItems = 'MAX';  // MAX = right-aligned horizontally

	// Fixed height = cellHeight only (gap handled separately below)
	rowLabelContainer.resize(10, cellHeight);

	const label = figma.createText();
	label.characters = labelText;
	label.fontSize = LABEL_FONT_SIZE;
	label.fontName = { family: "Inter", style: "Regular" };
	label.fills = [{ type: 'SOLID', color: LABEL_COLOR }];
	label.textAlignHorizontal = 'RIGHT';
	rowLabelContainer.appendChild(label);

	// Append to parent FIRST, then set layoutSizing properties
	rowLabelsFrame.appendChild(rowLabelContainer);
	rowLabelContainer.layoutSizingHorizontal = 'HUG';
	rowLabelContainer.layoutSizingVertical = 'FIXED';

	// Add gap spacer AFTER the row label (except for the last row)
	// This separates the gap from the centering calculation entirely
	if (!isLastRow) {
		const gapSpacer = figma.createFrame();
		gapSpacer.name = "Row Gap";
		gapSpacer.fills = [];
		gapSpacer.resize(1, gap);
		rowLabelsFrame.appendChild(gapSpacer);
		// Plain frames can only use FIXED or FILL (not HUG)
		gapSpacer.layoutSizingHorizontal = 'FIXED';
		gapSpacer.layoutSizingVertical = 'FIXED';
	}
}

contentRow.appendChild(rowLabelsFrame);

// ============================================================================
// STEP 6: Create grid column (column headers + component set)
// ============================================================================
const gridColumn = figma.createFrame();
gridColumn.name = "Grid Column";
gridColumn.fills = [];  // Transparent
gridColumn.layoutMode = 'VERTICAL';
gridColumn.primaryAxisSizingMode = 'AUTO';
gridColumn.counterAxisSizingMode = 'AUTO';
gridColumn.itemSpacing = gap;

// Create column headers row
const columnHeadersRow = figma.createFrame();
columnHeadersRow.name = "Column Headers";
columnHeadersRow.fills = [];
columnHeadersRow.layoutMode = 'HORIZONTAL';
columnHeadersRow.resize(csWidth, COLUMN_HEADER_HEIGHT);
columnHeadersRow.itemSpacing = 0;  // No spacing - we control widths precisely
columnHeadersRow.paddingLeft = edgePadding;  // Match component set edge padding
columnHeadersRow.paddingRight = edgePadding;

// Create column header labels - each with width matching cell + gap
for (let i = 0; i < columnValues.length; i++) {
	const colValue = columnValues[i];
	const isLastCol = (i === columnValues.length - 1);

	const colHeaderContainer = figma.createFrame();
	colHeaderContainer.name = "Col: " + colValue;
	colHeaderContainer.fills = [];
	colHeaderContainer.layoutMode = 'HORIZONTAL';
	colHeaderContainer.primaryAxisAlignItems = 'CENTER';  // Center horizontally
	colHeaderContainer.counterAxisAlignItems = 'MAX';  // Align to bottom

	// Set width to match cell + gap (except last column)
	// Use paddingRight to push the gap to the RIGHT of the centered text area
	const colWidth = isLastCol ? cellWidth : cellWidth + gap;
	colHeaderContainer.resize(colWidth, COLUMN_HEADER_HEIGHT);
	if (!isLastCol) {
		colHeaderContainer.paddingRight = gap;  // Gap goes right, text centers in cellWidth
	}

	const label = figma.createText();
	label.characters = colValue;
	label.fontSize = LABEL_FONT_SIZE;
	label.fontName = { family: "Inter", style: "Regular" };
	label.fills = [{ type: 'SOLID', color: LABEL_COLOR }];
	label.textAlignHorizontal = 'CENTER';
	colHeaderContainer.appendChild(label);

	// Append to parent FIRST, then set layoutSizing
	columnHeadersRow.appendChild(colHeaderContainer);
	colHeaderContainer.layoutSizingHorizontal = 'FIXED';
	colHeaderContainer.layoutSizingVertical = 'FILL';
}

// Append to parent FIRST, then set layoutSizing
gridColumn.appendChild(columnHeadersRow);
columnHeadersRow.layoutSizingHorizontal = 'FIXED';
columnHeadersRow.layoutSizingVertical = 'FIXED';

// Create a wrapper frame to hold the component set (since component sets don't work well in auto-layout)
const componentSetWrapper = figma.createFrame();
componentSetWrapper.name = "Component Set Wrapper";
componentSetWrapper.fills = [];
componentSetWrapper.resize(csWidth, csHeight);

// Move component set inside wrapper (positioned at 0,0)
componentSetWrapper.appendChild(newComponentSet);
newComponentSet.x = 0;
newComponentSet.y = 0;

// Append to parent FIRST, then set layoutSizing
gridColumn.appendChild(componentSetWrapper);
componentSetWrapper.layoutSizingHorizontal = 'FIXED';
componentSetWrapper.layoutSizingVertical = 'FIXED';

contentRow.appendChild(gridColumn);

// Position container at original location
containerFrame.x = csOriginalX - CONTAINER_PADDING - 120;  // Account for row labels width
containerFrame.y = csOriginalY - CONTAINER_PADDING - TITLE_FONT_SIZE - 24 - COLUMN_HEADER_HEIGHT - gap;

// Select and zoom to show result
figma.currentPage.selection = [containerFrame];
figma.viewport.scrollAndZoomIntoView([containerFrame]);

return {
	success: true,
	message: "Component set arranged with proper container, labels, and alignment",
	containerId: containerFrame.id,
	componentSetId: newComponentSet.id,
	componentSetName: newComponentSet.name,
	grid: {
		rows: totalRows,
		columns: totalCols,
		cellWidth: cellWidth,
		cellHeight: cellHeight,
		gap: gap,
		columnProperty: columnProp,
		columnValues: columnValues,
		rowProperties: rowProps,
		rowLabels: rowCombinations.map(combo => rowProps.map(p => combo[p]).join(" / "))
	},
	componentSetSize: { width: csWidth, height: csHeight },
	variantCount: newVariants.length,
	structure: {
		container: "White frame with title, row labels, column headers, and component set",
		rowLabels: "Vertically aligned with each row's center",
		columnHeaders: "Horizontally aligned with each column's center"
	}
};
`;

					const result = await connector.executeCodeViaUI(code, 25000);

					if (!result.success) {
						throw new Error(result.error || "Failed to arrange component set");
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										...result.result,
										hint: result.result?.success
											? "Component set arranged in a white container frame with properly aligned row and column labels. The purple dashed border is visible. Use figma_capture_screenshot to validate the layout."
											: undefined,
									},
								),
							},
						],
					};
				} catch (error) {
					logger.error({ error }, "Failed to arrange component set");
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error:
											error instanceof Error ? error.message : String(error),
										hint: "Make sure the Desktop Bridge plugin is running and a component set exists.",
									},
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
		);

		// Register Comment tools
		registerCommentTools(
			this.server,
			() => this.getFigmaAPI(),
			() => this.getCurrentFileUrl(),
		);

		// Register Figma Slides tools
		registerSlidesTools(
			this.server,
			() => this.getDesktopConnector(),
		);

		// MCP Apps - gated behind ENABLE_MCP_APPS env var
		if (process.env.ENABLE_MCP_APPS === "true") {
			registerTokenBrowserApp(this.server, async (fileUrl?: string) => {
				const url = fileUrl || this.getCurrentFileUrl();
				if (!url) {
					throw new Error(
						"No Figma file URL available. Either pass a fileUrl, call figma_navigate (CDP mode), or ensure the Desktop Bridge plugin is connected (WebSocket mode).",
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

				// Priority 1: Try Desktop Bridge via transport-agnostic connector (WebSocket or CDP)
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
							"No Figma file URL available. Either pass a fileUrl, call figma_navigate (CDP mode), or ensure the Desktop Bridge plugin is connected (WebSocket mode).",
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

					// 2. Try Desktop Bridge via transport-agnostic connector (WebSocket or CDP)
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
