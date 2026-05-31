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
import { dirname, resolve, join } from "path";
import { realpathSync, existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync } from "fs";
import { homedir } from "os";
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
import { registerVersionTools } from "./core/version-tools.js";
import { registerAnnotationTools } from "./core/annotation-tools.js";
import { registerDeepComponentTools } from "./core/deep-component-tools.js";
import { registerDesignSystemTools } from "./core/design-system-tools.js";
import { registerLibraryTools, registerLibraryVariableTools } from "./core/library-tools.js";
import { registerAccessibilityTools } from "./core/accessibility-tools.js";
import { registerDiagnoseTool } from "./core/diagnose-tool.js";
import { registerWriteTools } from "./core/write-tools.js";
import { registerTokensTools } from "./core/tokens-tools.js";
import { wrapServerForIdentity } from "./core/identity.js";
import { PACKAGE_ROOT } from "./core/resolve-package-root.js";
import type { IFigmaConnector } from "./core/figma-connector.js";
import { FigmaWebSocketServer } from "./core/websocket-server.js";
import { WebSocketConnector } from "./core/websocket-connector.js";
import {
	DEFAULT_WS_PORT,
	getPortRange,
	advertisePort,
	unadvertisePort,
	registerPortCleanup,
	startPeriodicReaper,
	discoverActiveInstances,
	cleanupStalePortFiles,
	cleanupOrphanedProcesses,
	evictOldestInstance,
	refreshPortAdvertisement,
	HEARTBEAT_INTERVAL_MS,
} from "./core/port-discovery.js";
import { registerTokenBrowserApp } from "./apps/token-browser/server.js";
import { registerDesignSystemDashboardApp } from "./apps/design-system-dashboard/server.js";
import { registerFigJamTools } from "./core/figjam-tools.js";
import { registerSlidesTools } from "./core/slides-tools.js";

const logger = createChildLogger({ component: "local-server" });

/**
 * Copy plugin files to a stable directory (~/.figma-console-mcp/plugin/).
 * This gives users a permanent, predictable path to import from instead of
 * the volatile npx cache path that changes between updates.
 *
 * Returns the stable manifest path, or null if copy failed.
 */
function setupStablePluginDir(sourcePluginDir: string): string | null {
	try {
		const stableDir = join(homedir(), ".figma-console-mcp", "plugin");
		mkdirSync(stableDir, { recursive: true });

		const filesToCopy = ["manifest.json", "code.js", "ui.html"];
		for (const file of filesToCopy) {
			const src = join(sourcePluginDir, file);
			const dest = join(stableDir, file);
			if (existsSync(src)) {
				copyFileSync(src, dest);
			}
		}

		// Write a version marker so we can detect stale copies
		try {
			const pkg = JSON.parse(readFileSync(join(sourcePluginDir, "..", "package.json"), "utf-8"));
			writeFileSync(join(stableDir, ".version"), pkg.version, "utf-8");
		} catch {
			// Non-critical — version marker is for diagnostics only
		}

		logger.info({ stableDir }, "Plugin files copied to stable directory");
		return join(stableDir, "manifest.json");
	} catch (error) {
		logger.warn({ error }, "Could not set up stable plugin directory (non-critical)");
		return null;
	}
}

/**
 * Local MCP Server
 * Connects to Figma Desktop and provides identical tools to Cloudflare mode
 */
class LocalFigmaConsoleMCP {
	private server: McpServer;
	private figmaAPI: FigmaAPI | null = null;
	private desktopConnector: IFigmaConnector | null = null;
	private wsServer: FigmaWebSocketServer | null = null;
	private wsStartupError: { code: string; port: number } | null = null;
	/** The port the WebSocket server actually bound to (may differ from preferred if fallback occurred) */
	private wsActualPort: number | null = null;
	/** The preferred port requested (from env var or default) */
	private wsPreferredPort: number = DEFAULT_WS_PORT;
	/** Stops the periodic background reaper (set once the WS port is bound) */
	private wsReaperStop: (() => void) | null = null;
	/** Heartbeat timer that refreshes port file to prove this server is active */
	private wsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
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

	/**
	 * Invalidate the variables cache after a write operation.
	 * Called after any successful variable create/update/delete/batch operation
	 * to ensure the next figma_get_variables call returns fresh data.
	 */
	private invalidateVariablesCache(): void {
		if (this.variablesCache.size > 0) {
			this.variablesCache.clear();
			logger.info('Variables cache invalidated after write operation');
		}
	}

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

		// Stamp every tool response (and every thrown error) with our MCP identity
		// so LLMs can attribute output unambiguously when multiple Figma-related
		// MCPs are connected. Idempotent for already-tagged responses.
		wrapServerForIdentity(this.server);
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

			logger.debug({ authMethod: accessToken.startsWith('figu_') ? 'OAuth' : 'PAT' }, 'Initializing Figma API');

			this.figmaAPI = new FigmaAPI({ accessToken });
		}

		return this.figmaAPI;
	}

	/**
	 * Get or create Desktop Connector for write operations.
	 * Returns the active WebSocket Desktop Bridge connector.
	 */
	private async getDesktopConnector(): Promise<IFigmaConnector> {
		if (this.wsServer?.isClientConnected()) {
			try {
				const wsConnector = new WebSocketConnector(this.wsServer);
				await wsConnector.initialize();
				this.desktopConnector = wsConnector;
				logger.debug("Desktop connector initialized via WebSocket bridge");
				return this.desktopConnector;
			} catch (wsError) {
				const errorMsg = wsError instanceof Error ? wsError.message : String(wsError);
				logger.debug({ error: errorMsg }, "WebSocket connector init failed");
			}
		}

		const wsPort = this.wsActualPort || this.wsPreferredPort || DEFAULT_WS_PORT;
		const err = new Error(
			"Cannot connect to Figma Desktop.\n\n" +
			"Open the Desktop Bridge plugin in Figma (Plugins → Development → Figma Desktop Bridge).\n" +
			`The plugin will connect automatically to ws://localhost:${wsPort}.\n` +
			"No special launch flags needed."
		);
		// Attach structured connection error for programmatic agent recovery
		(err as any).connectionError = this.buildConnectionError(err);
		throw err;
	}

	/**
	 * Build a bridge tool error response with structured connectionError.
	 * Extracts connectionError from enhanced Error objects thrown by getDesktopConnector(),
	 * or computes it on-demand for other errors. Backward compatible — adds connectionError
	 * alongside existing error/message/hint fields.
	 */
	private bridgeToolError(error: unknown, message: string, hint: string) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		const connectionError = (error as any)?.connectionError || this.buildConnectionError(error);
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify({
						error: errorMsg,
						message,
						hint,
						connectionError,
					}),
				},
			],
			isError: true as const,
		};
	}

	/**
	 * Build a structured connectionError object for bridge-dependent tool failures.
	 * Added alongside existing error/message/hint fields for backward compatibility.
	 * Agents can key on this field for programmatic recovery instead of parsing hint strings.
	 */
	private buildConnectionError(error: Error | unknown): {
		layer: 1 | 2;
		type: string;
		canRetry: boolean;
		recoverySteps: string[];
	} {
		const errorMsg = error instanceof Error ? error.message : String(error);
		const wsServerRunning = this.wsServer?.isStarted() ?? false;
		const isTimeout = errorMsg.includes('timed out');
		const isNoClient = errorMsg.includes('No active file') || errorMsg.includes('No WebSocket client');

		if (!wsServerRunning) {
			return {
				layer: 1,
				type: 'MCP_SERVER_UNAVAILABLE',
				canRetry: true,
				recoverySteps: [
					"Ensure your AI client is running with figma-console-mcp configured",
					"Check for port conflicts: lsof -i :9223-9232 | grep LISTEN",
					"Restart your AI client — the MCP server starts automatically",
				],
			};
		}

		if (isTimeout) {
			return {
				layer: 2,
				type: 'BRIDGE_COMMAND_TIMEOUT',
				canRetry: true,
				recoverySteps: [
					"The plugin may be unresponsive — close and reopen the Desktop Bridge plugin in Figma",
					"If the issue persists, restart Figma Desktop",
					"Call figma_get_status with probe:true to verify the connection",
				],
			};
		}

		return {
			layer: isNoClient ? 2 : 2,
			type: isNoClient ? 'BRIDGE_NOT_CONNECTED' : 'BRIDGE_ERROR',
			canRetry: !isNoClient,
			recoverySteps: [
				"Open Figma Desktop with your target file",
				"Go to Plugins → Development → Figma Desktop Bridge",
				"Click 'Run' to open the plugin",
				"Wait 3 seconds, then call figma_get_status with probe:true to verify",
			],
		};
	}

	/**
	 * Get the current Figma file URL from the best available source.
	 * Priority: Browser URL (full URL with branch/node info) → WebSocket file identity (synthesized URL).
	 * The synthesized URL is compatible with extractFileKey() and extractFigmaUrlInfo().
	 */
	private getCurrentFileUrl(): string | null {
		// Synthesize the URL from the WebSocket plugin's reported file identity.
		// (Pre-Phase-3 this also tried a live Puppeteer browser URL; that path is
		// gone now along with the LocalBrowserManager.)
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

	/** Stable plugin directory path (set during startup) */
	private stablePluginPath: string | null = null;

	/**
	 * Resolve the path to the Desktop Bridge plugin manifest.
	 * Prefers the stable directory (~/.figma-console-mcp/plugin/) over the npx cache path.
	 */
	private getPluginPath(): string | null {
		// Prefer stable path — consistent across npx updates
		if (this.stablePluginPath && existsSync(this.stablePluginPath)) {
			return this.stablePluginPath;
		}
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
					let status: ReturnType<NonNullable<typeof this.wsServer>["getConsoleStatus"]>;
					let source: "websocket" = "websocket";

					if (this.wsServer?.isClientConnected()) {
						// Plugin-captured console logs delivered via WebSocket bridge
						logs = this.wsServer.getConsoleLogs({ count, level, since });
						status = this.wsServer.getConsoleStatus();
						source = "websocket";
					} else {
						throw new Error(
							"No console monitoring available. Open the Desktop Bridge plugin in Figma for console capture.",
						);
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
						"Optional node ID to screenshot (e.g., '123:456'). If omitted, uses the node-id from the Desktop Bridge plugin's reported file URL when present. To screenshot what the user is currently looking at on the canvas, prefer figma_capture_screenshot (uses the plugin's exportAsync and reflects the current state).",
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
				if (!this.wsServer?.isClientConnected()) {
					throw new Error(
						"No console monitoring available. Open the Desktop Bridge plugin in Figma for console capture.",
					);
				}

				const startTime = Date.now();
				const startLogCount = this.wsServer.getConsoleStatus().logCount;

				// Wait for the specified duration while collecting logs
				await new Promise((resolve) => setTimeout(resolve, duration * 1000));

				const watchedLogs = this.wsServer.getConsoleLogs({
					level: level === "all" ? undefined : level,
					since: startTime,
				});

				const endLogCount = this.wsServer.getConsoleStatus().logCount;
				const newLogsCount = endLogCount - startLogCount;

				const responseData: any = {
					status: "completed",
					duration: `${duration} seconds`,
					startTime: new Date(startTime).toISOString(),
					endTime: new Date(Date.now()).toISOString(),
					filter: level,
					transport: "websocket",
					statistics: {
						totalLogsInBuffer: endLogCount,
						logsAddedDuringWatch: newLogsCount,
						logsMatchingFilter: watchedLogs.length,
					},
					logs: watchedLogs,
					ai_instruction:
						"Console logs captured via WebSocket Bridge (plugin sandbox only).",
				};

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
					let transport: "websocket" = "websocket";
					let clearedCount = 0;
					let currentUrl: string | null = null;

					// Reload the plugin UI iframe through the WebSocket bridge.
					if (this.wsServer?.isClientConnected()) {
						transport = "websocket";
						if (clearConsoleBefore) {
							clearedCount = this.wsServer.clearConsoleLogs();
						}
						await this.wsServer.sendCommand("RELOAD_UI", {}, 10000);
						// Wait for the UI to reload and WebSocket to reconnect
						await new Promise((resolve) => setTimeout(resolve, 3000));
					} else {
						throw new Error(
							"No connection available. Open the Desktop Bridge plugin in Figma.",
						);
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
					let transport: "websocket" = "websocket";

					// Clear the WebSocket plugin-side log buffer (non-disruptive)
					if (this.wsServer?.isClientConnected()) {
						clearedCount = this.wsServer.clearConsoleLogs();
						transport = "websocket";
					} else {
						throw new Error(
							"No console monitoring available. Open the Desktop Bridge plugin in Figma.",
						);
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

		// Tool 6: Navigate / switch active file
		this.server.tool(
			"figma_navigate",
			"Switch the active Figma file target among files that already have the Desktop Bridge plugin running. Local mode is WebSocket-only — this tool does NOT launch a browser or open files. If the requested URL is already the active file, it confirms the connection. If another connected plugin matches the URL, it switches the active target so subsequent tool calls hit that file. If no connected plugin matches, returns guidance for the user to open the Desktop Bridge plugin in the target file. Use figma_list_open_files to see all connected files.",
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
					// Phase 3: local mode now talks to Figma exclusively through the
					// WebSocket Desktop Bridge plugin. Navigation is plugin-side: we
					// either switch the active file (if the target file already has
					// the plugin open) or ask the user to open the plugin in the
					// target file. Cross-file browser navigation via the old CDP
					// path no longer exists.
					if (this.wsServer?.isClientConnected()) {
						{
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

					// If we got here, the WebSocket plugin bridge wasn't connected.
					// Tell the user how to recover — local mode has no Puppeteer
					// fallback after the Phase 3 CDP cleanup.
					throw new Error(
						"Desktop Bridge plugin is not connected. Open the Figma Console MCP plugin in Figma Desktop and try again.",
					);
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
			"Check connection status to Figma Desktop. Reports transport status and connection health via the Desktop Bridge plugin (WebSocket transport). Use probe:true for an active roundtrip verification that the plugin is actually responding.",
			{
				probe: z.boolean().optional().describe("When true, sends a live roundtrip command to the plugin to verify the connection is actually responsive (not just TCP-open). Returns probeResult with success/latency. Recommended for health checks."),
			},
			async ({ probe }) => {
				try {
					// Check WebSocket availability
					const wsConnected = this.wsServer?.isClientConnected() ?? false;

					// ConsoleMonitor is gone in WS-only local mode — both fields below
					// (monitorWorkerCount, consoleMonitor) report static zero/null so the
					// status-shape stays stable for any consumer that parses it.
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

					// Compute failure layer for machine-readable diagnostics
					// Layer 1 = MCP server/WS server issue, Layer 2 = plugin bridge not connected
					const wsServerRunning = this.wsServer?.isStarted() ?? false;
					const failureLayer: 1 | 2 | null = setupValid
						? null
						: !wsServerRunning
							? 1
							: 2;

					// Active probe: verify the plugin actually responds to commands
					let probeResult: { success: boolean; latencyMs: number; error?: string } | undefined;
					if (probe) {
						const probeStart = Date.now();
						try {
							const result = await this.wsServer!.sendCommand('GET_FILE_INFO', {}, 3000);
							probeResult = {
								success: !!(result && result.fileInfo),
								latencyMs: Date.now() - probeStart,
							};
						} catch (probeError: any) {
							probeResult = {
								success: false,
								latencyMs: Date.now() - probeStart,
								error: probeError?.message || String(probeError),
							};
						}
					}

					// Recovery steps for agents to act on programmatically
					const recoverySteps: string[] | undefined = setupValid
						? undefined
						: failureLayer === 1
							? [
								"Ensure your AI client (Claude Code, Cursor, etc.) is running with figma-console-mcp configured",
								"Check if all ports 9223-9232 are occupied: lsof -i :9223-9232 | grep LISTEN",
								"Kill stale processes if needed: pkill -f figma-console-mcp",
								"Restart your AI client — the MCP server will start automatically on the next tool call",
							]
							: [
								"Open Figma Desktop with your target file",
								"Go to Plugins → Development → Figma Desktop Bridge",
								"Click 'Run' to open the plugin",
								"Wait 3 seconds for the WebSocket connection to establish",
								"Call figma_get_status with probe:true to verify the connection",
							];

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
										editorType: this.wsServer?.getEditorType() || "figma",
										monitoredPageUrl: currentUrl,
										monitorWorkerCount: 0,
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
														editorType: f.editorType || 'figma',
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
												lastPongAt: this.wsServer?.getActiveClientLastPongAt() ? new Date(this.wsServer.getActiveClientLastPongAt()!).toISOString() : undefined,
											},
										},
										setup: {
											valid: setupValid,
											failureLayer,
											probeResult,
											recoverySteps,
											message: activeTransport === "websocket"
												? this.wsActualPort !== this.wsPreferredPort
													? `✅ Connected to Figma Desktop via WebSocket Bridge (port ${this.wsActualPort}, fallback from ${this.wsPreferredPort})`
													: "✅ Connected to Figma Desktop via WebSocket Bridge"
												: this.wsStartupError?.code === "EADDRINUSE"
													? `❌ All WebSocket ports ${this.wsPreferredPort}-${this.wsPreferredPort + 9} are in use`
													: this.wsActualPort !== null && this.wsActualPort !== this.wsPreferredPort
													? `❌ WebSocket server running on port ${this.wsActualPort} (fallback) but no plugin connected. Restart the Desktop Bridge plugin in Figma to reconnect.`
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
														? `Server is running on fallback port ${this.wsActualPort} (port ${this.wsPreferredPort} was taken by another instance). The Desktop Bridge plugin is not connected. TELL THE USER: Close and reopen the Desktop Bridge plugin in Figma to reconnect. The plugin scans the whole port range (9223–9232) on launch and will pick up this server automatically.`
														: `No connection to Figma Desktop. Open the Desktop Bridge plugin in Figma to connect.${this.getPluginPath() ? ' Plugin manifest: ' + this.getPluginPath() : ''}`
												: activeTransport === "websocket"
													? `Connected via WebSocket Bridge to "${currentFileName || "unknown file"}" on port ${this.wsActualPort}. All design tools and console monitoring tools are available. Console logs are captured from the plugin sandbox (code.js). IMPORTANT: Always verify the file name before destructive operations when multiple files have the plugin open.`
													: "All tools are ready to use.",
										},
										pluginPath: this.getPluginPath() || undefined,
										consoleMonitor: null,
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

					// figma_reconnect is informational in WebSocket-only mode — the
					// plugin handles its own reconnect logic. We just report whether
					// the bridge is currently connected.
					if (this.wsServer?.isClientConnected()) {
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
										connectionError: this.buildConnectionError(error),
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
									if ('annotations' in node && node.annotations && node.annotations.length > 0) info.annotations = node.annotations;
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
		// ============================================================================
		// READ-SIDE LIBRARY / DESIGN-SYSTEM TOOLS
		// (Previously interleaved with write tools in local.ts; restored after the
		// Phase-2 write-tools dedupe excised them along with the surrounding writes.)
		// ============================================================================

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
			`Search for components by name, category, or description. Returns paginated results with component keys for instantiation. Automatically loads the design system cache if needed.

**NEW: Cross-file library search!** Pass a libraryFileKey or libraryFileUrl to search for components in a published shared library (different file). This uses the REST API and requires FIGMA_ACCESS_TOKEN.

Without libraryFileKey/libraryFileUrl, searches the currently open file (local components via Plugin API).`,
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
				libraryFileKey: z
					.string()
					.optional()
					.describe(
						"File key of a published library to search in (for cross-file library access). Overrides local search.",
					),
				libraryFileUrl: z
					.string()
					.optional()
					.describe(
						"URL of a published library file to search in (e.g., https://www.figma.com/design/abc123/...). Alternative to libraryFileKey.",
					),
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
			async ({ query, category, libraryFileKey, libraryFileUrl, limit, offset }) => {
				try {
					// Determine if this is a library search or local search
					let resolvedLibraryKey = libraryFileKey;
					if (!resolvedLibraryKey && libraryFileUrl) {
						const { extractFileKey } = await import(
							"./core/figma-api.js"
						);
						resolvedLibraryKey = extractFileKey(libraryFileUrl) ?? undefined;
					}

					// LIBRARY SEARCH PATH: Use REST API for cross-file access
					if (resolvedLibraryKey) {
						const api = await this.getFigmaAPI();
						const [componentsResponse, componentSetsResponse] =
							await Promise.all([
								api.getComponents(resolvedLibraryKey).catch((err: Error) => {
									logger.warn(
										{ error: err },
										"Failed to fetch components from library",
									);
									return { meta: { components: [] } };
								}),
								api
									.getComponentSets(resolvedLibraryKey)
									.catch((err: Error) => {
										logger.warn(
											{ error: err },
											"Failed to fetch component sets from library",
										);
										return { meta: { component_sets: [] } };
									}),
							]);

						const rawComponents =
							componentsResponse?.meta?.components || [];
						const rawComponentSets =
							componentSetsResponse?.meta?.component_sets || [];

						// Build combined results — component sets + standalone components
						const componentSetNodeIds = new Set(
							rawComponentSets.map((cs: any) => cs.node_id),
						);

						let results: any[] = [];

						// Add component sets with their variant info
						// NOTE: REST API returns containingComponentSet as an object { name, nodeId }
						// not a boolean. Match via containingComponentSet.nodeId or component_set_id.
						for (const cs of rawComponentSets) {
							const variants = rawComponents.filter((c: any) => {
								const ccs = c.containing_frame?.containingComponentSet;
								// Match via containingComponentSet object (preferred)
								if (ccs && typeof ccs === "object" && ccs.nodeId === cs.node_id) return true;
								// Fallback: match via containing_frame.nodeId (some API versions)
								if (ccs && c.containing_frame?.nodeId === cs.node_id) return true;
								// Fallback: match via component_set_id field
								if (c.component_set_id === cs.node_id) return true;
								return false;
							});
							results.push({
								name: cs.name,
								key: cs.key,
								nodeId: cs.node_id,
								description: cs.description || undefined,
								type: "COMPONENT_SET",
								variantCount: variants.length,
								variants: variants.slice(0, 5).map((v: any) => ({
									name: v.name,
									key: v.key,
								})),
								source: "library",
							});
						}

						// Add standalone components (not part of a set)
						for (const c of rawComponents) {
							const ccs = c.containing_frame?.containingComponentSet;
							const isVariant = ccs || c.component_set_id;
							if (!isVariant) {
								results.push({
									name: c.name,
									key: c.key,
									nodeId: c.node_id,
									description: c.description || undefined,
									type: "COMPONENT",
									source: "library",
								});
							}
						}

						// Apply search filter
						if (query) {
							const queryLower = query.toLowerCase();
							results = results.filter(
								(item) =>
									item.name.toLowerCase().includes(queryLower) ||
									item.description?.toLowerCase().includes(queryLower),
							);
						}

						if (category) {
							const catLower = category.toLowerCase();
							results = results.filter(
								(item) =>
									item.name.toLowerCase().includes(catLower) ||
									item.description?.toLowerCase().includes(catLower),
							);
						}

						// Sort and paginate
						results.sort((a: any, b: any) => a.name.localeCompare(b.name));
						const effectiveLimit = Math.min(limit || 10, 25);
						const effectiveOffset = offset || 0;
						const total = results.length;
						const paginatedResults = results.slice(
							effectiveOffset,
							effectiveOffset + effectiveLimit,
						);

						return {
							content: [
								{
									type: "text",
									text: JSON.stringify({
										success: true,
										source: "library",
										libraryFileKey: resolvedLibraryKey,
										query: query || "(all)",
										category: category || "(all)",
										results: paginatedResults,
										pagination: {
											offset: effectiveOffset,
											limit: effectiveLimit,
											total,
											hasMore: effectiveOffset + effectiveLimit < total,
										},
										hint: "Use figma_instantiate_component with the componentKey to place library components in your current file.",
									}),
								},
							],
						};
					}

					// LOCAL SEARCH PATH: Use cached design system manifest (existing behavior)
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
											hint: "If you're trying to search a published library from another file, pass the libraryFileKey or libraryFileUrl parameter.",
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
										source: "local",
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
											: "Use figma_get_component_details with a component key for full details. To search a published library, pass libraryFileKey.",
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
			"figma_get_library_components",
			`Discover published components from a shared/team library file.

**USE THIS when you need to use components from a published design system library** (a different file than the one currently open). This bridges the gap between library discovery and instantiation.

**WORKFLOW:**
1. Call this tool with the library file's URL or file key
2. Browse the returned components — results include COMPONENT_SET (with variants array) and standalone COMPONENT types
3. Use figma_instantiate_component with a VARIANT key (from the variants array inside a COMPONENT_SET result, NOT the component set key itself)

**SEARCH NOTE:** The query filter matches both component names AND descriptions. If you get unexpected results (e.g., "Accordion" when searching "Button"), verify the result name matches what you need — it may have matched on a description mention.

**MULTI-FILE TIP:** If you need to find a specific component and REST API search returns too many results, you can switch to the library file via figma_navigate, use figma_execute to find the exact component and its variant key, then switch back.

**NOTE:** Requires FIGMA_ACCESS_TOKEN to be set (uses the Figma REST API to read the library file).`,
			{
				libraryFileUrl: z
					.string()
					.optional()
					.describe(
						"The URL of the library file (e.g., https://www.figma.com/design/abc123/My-Design-System). Either this or libraryFileKey is required.",
					),
				libraryFileKey: z
					.string()
					.optional()
					.describe(
						"The file key of the library file (e.g., 'abc123'). Either this or libraryFileUrl is required.",
					),
				query: z
					.string()
					.optional()
					.describe(
						"Search query to filter components by name (e.g., 'Button', 'Card'). Leave empty to get all components.",
					),
				limit: z
					.number()
					.optional()
					.default(25)
					.describe("Maximum results to return (default: 25, max: 100)"),
				offset: z
					.number()
					.optional()
					.default(0)
					.describe("Offset for pagination"),
				includeVariants: z
					.boolean()
					.optional()
					.default(false)
					.describe(
						"Include individual variant components (default: false, only returns component sets)",
					),
			},
			async ({
				libraryFileUrl,
				libraryFileKey,
				query,
				limit,
				offset,
				includeVariants,
			}) => {
				try {
					// Resolve file key from URL or direct key
					let fileKey = libraryFileKey;
					if (!fileKey && libraryFileUrl) {
						const { extractFileKey } = await import(
							"./core/figma-api.js"
						);
						fileKey = extractFileKey(libraryFileUrl) ?? undefined;
						if (!fileKey) {
							return {
								content: [
									{
										type: "text",
										text: JSON.stringify({
											error:
												"Could not extract file key from URL. Please provide a valid Figma file URL or use libraryFileKey directly.",
											example:
												"https://www.figma.com/design/abc123/My-Design-System",
										}),
									},
								],
								isError: true,
							};
						}
					}

					if (!fileKey) {
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify({
										error:
											"Either libraryFileUrl or libraryFileKey is required.",
										hint: "Provide the URL of your design system file, e.g., https://www.figma.com/design/abc123/My-Design-System",
									}),
								},
							],
							isError: true,
						};
					}

					// Use REST API to get published components from the library file
					const api = await this.getFigmaAPI();

					// Fetch both components and component sets in parallel
					// Surface errors instead of swallowing them — token/scope issues need to be visible
					const apiErrors: string[] = [];
					const [componentsResponse, componentSetsResponse] =
						await Promise.all([
							api.getComponents(fileKey).catch((err: Error) => {
								const msg = err.message || String(err);
								logger.warn(
									{ error: err },
									"Failed to fetch components from library",
								);
								apiErrors.push(`Components API: ${msg}`);
								return { meta: { components: [] } };
							}),
							api.getComponentSets(fileKey).catch((err: Error) => {
								const msg = err.message || String(err);
								logger.warn(
									{ error: err },
									"Failed to fetch component sets from library",
								);
								apiErrors.push(`Component Sets API: ${msg}`);
								return { meta: { component_sets: [] } };
							}),
						]);

					const rawComponents =
						componentsResponse?.meta?.components || [];
					const rawComponentSets =
						componentSetsResponse?.meta?.component_sets || [];

					// Helper: check if a component belongs to a given component set
					// REST API returns containingComponentSet as an object { name, nodeId }
					const isVariantOf = (c: any, csNodeId: string): boolean => {
						const ccs = c.containing_frame?.containingComponentSet;
						if (ccs && typeof ccs === "object" && ccs.nodeId === csNodeId) return true;
						if (ccs && c.containing_frame?.nodeId === csNodeId) return true;
						if (c.component_set_id === csNodeId) return true;
						return false;
					};
					const isVariant = (c: any): boolean => {
						return !!(c.containing_frame?.containingComponentSet || c.component_set_id);
					};
					const getParentSetName = (c: any): string | undefined => {
						const ccs = c.containing_frame?.containingComponentSet;
						if (ccs && typeof ccs === "object" && ccs.name) return ccs.name;
						return c.containing_frame?.name || c.component_set_name || undefined;
					};

					// Process component sets (groups of variants)
					const componentSets = rawComponentSets.map((cs: any) => {
						const variants = rawComponents.filter((c: any) => isVariantOf(c, cs.node_id));

						return {
							name: cs.name,
							key: cs.key,
							nodeId: cs.node_id,
							description: cs.description || undefined,
							type: "COMPONENT_SET" as const,
							variantCount: variants.length,
							variants: variants.map((v: any) => ({
								name: v.name,
								key: v.key,
								nodeId: v.node_id,
							})),
						};
					});

					// Process standalone components (not part of a set)
					const standaloneComponents = rawComponents
						.filter((c: any) => !isVariant(c))
						.map((c: any) => ({
							name: c.name,
							key: c.key,
							nodeId: c.node_id,
							description: c.description || undefined,
							type: "COMPONENT" as const,
						}));

					// Combine results
					let allResults: any[] = [
						...componentSets,
						...standaloneComponents,
					];

					// Include individual variants if requested
					if (includeVariants) {
						const variantComponents = rawComponents
							.filter((c: any) => isVariant(c))
							.map((c: any) => ({
								name: c.name,
								key: c.key,
								nodeId: c.node_id,
								description: c.description || undefined,
								type: "VARIANT" as const,
								parentSetName: getParentSetName(c),
							}));
						allResults = [...allResults, ...variantComponents];
					}

					// Apply search filter
					if (query) {
						const queryLower = query.toLowerCase();
						allResults = allResults.filter(
							(item) =>
								item.name
									.toLowerCase()
									.includes(queryLower) ||
								item.description
									?.toLowerCase()
									.includes(queryLower),
						);
					}

					// Sort by name for consistent results
					allResults.sort((a, b) => a.name.localeCompare(b.name));

					// Apply pagination
					const effectiveLimit = Math.min(limit || 25, 100);
					const effectiveOffset = offset || 0;
					const total = allResults.length;
					const paginatedResults = allResults.slice(
						effectiveOffset,
						effectiveOffset + effectiveLimit,
					);
					const hasMore =
						effectiveOffset + effectiveLimit < total;

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									success: apiErrors.length === 0,
									libraryFileKey: fileKey,
									query: query || "(all)",
									...(apiErrors.length > 0 && {
										apiErrors,
										hint: "REST API errors occurred. Check that FIGMA_ACCESS_TOKEN is valid and has file_content:read scope. If the token is correct, the library components may not be published to a team library.",
									}),
									summary: {
										totalComponentSets:
											componentSets.length,
										totalStandaloneComponents:
											standaloneComponents.length,
										totalComponents: rawComponents.length,
									},
									results: paginatedResults,
									pagination: {
										offset: effectiveOffset,
										limit: effectiveLimit,
										total,
										hasMore,
									},
									usage: {
										instantiate: `To use a component: call figma_instantiate_component with a VARIANT key (not the component set key). For COMPONENT_SET results, pick a variant from the "variants" array.`,
										example: (() => {
											const first = paginatedResults[0];
											if (!first) return undefined;
											if (first.type === "COMPONENT_SET" && first.variants?.length > 0) {
												return `figma_instantiate_component({ componentKey: "${first.variants[0].key}" }) — using first variant of "${first.name}"`;
											}
											return `figma_instantiate_component({ componentKey: "${first.key}" })`;
										})(),
										note: "IMPORTANT: Use variant keys (type COMPONENT), not component set keys (type COMPONENT_SET). Component set keys will fail. Also pre-load any custom fonts the component uses via figma_execute before instantiating.",
									},
								}),
							},
						],
					};
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					logger.error(
						{ error },
						"Failed to get library components",
					);

					// Provide helpful guidance based on error type
					let hint =
						"Make sure FIGMA_ACCESS_TOKEN is set and the library file key is correct.";
					if (errorMessage.includes("FIGMA_ACCESS_TOKEN")) {
						hint =
							"Set FIGMA_ACCESS_TOKEN environment variable with your Figma personal access token. Get one at: https://www.figma.com/developers/api#access-tokens";
					} else if (
						errorMessage.includes("403") ||
						errorMessage.includes("Forbidden")
					) {
						hint =
							"Access denied. Make sure your Figma token has access to this file and the file's library is published.";
					} else if (
						errorMessage.includes("404") ||
						errorMessage.includes("Not found")
					) {
						hint =
							"File not found. Check the file URL/key and make sure the file exists and you have access to it.";
					} else if (
						errorMessage.includes("429") ||
						errorMessage.includes("Rate")
					) {
						hint =
							"Rate limited by Figma API. Wait a moment and try again, or reduce the number of requests.";
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: errorMessage,
									hint,
								}),
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
		// Register all write/manipulation tools (figma_execute, variable CRUD, node mutations,
		// design-token setup, accessibility audits, etc.). Sourced from src/core/write-tools.ts
		// so local mode and cloud mode share the same 30 implementations — no risk of drift.
		registerWriteTools(this.server, () => this.getDesktopConnector());

		// Register token sync tools — figma_export_tokens and figma_import_tokens.
		// Replace Style Dictionary and Tokens Studio's export pipeline for the
		// popular styling methods (DTCG canonical, plus CSS/Tailwind/SCSS/etc.
		// as Phase 2+ extensions to a single internal token model).
		registerTokensTools(this.server, () => this.getDesktopConnector());

		// Register Figma API tools (Tools 8-11)
		registerFigmaAPITools(
			this.server,
			() => this.getFigmaAPI(),
			() => this.getCurrentFileUrl(),
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

		// Register Version History tools
		registerVersionTools(
			this.server,
			() => this.getFigmaAPI(),
			() => this.getCurrentFileUrl(),
			undefined, // options
			() => {
				// Selection fallback for blame/diff/changelog tools
				const sel = this.wsServer?.getCurrentSelection();
				return sel?.nodes?.map((n) => n.id) ?? null;
			},
			// v1.25.0: metadata-change buffer reader. Surfaces description/annotation
			// edits captured by the Desktop Bridge plugin while it was connected.
			// Returns [] if the WebSocket server isn't running.
			(opts) => {
				if (!this.wsServer) return [];
				return this.wsServer.getMetadataChanges(opts);
			},
		);

		// Register Design System Kit tool
		registerDesignSystemTools(
			this.server,
			() => this.getFigmaAPI(),
			() => this.getCurrentFileUrl(),
			this.variablesCache,
			undefined, // options (use default)
			() => this.getDesktopConnector(), // bridge-first variable resolution (works on any plan)
		);

		// Register Library Tools (key-based component inspection across shared libraries)
		registerLibraryTools(this.server, () => this.getFigmaAPI());

		// Register Library Variable Tools (Plugin-API based — list + import variables
		// from subscribed team libraries; works on every Figma plan, no Enterprise needed)
		registerLibraryVariableTools(this.server, () => this.getDesktopConnector());

		// Register code-side accessibility scanning (axe-core + JSDOM)
		registerAccessibilityTools(this.server);

		// Register figma_diagnose — designer-readable health check + cross-MCP disambiguator.
		// This is the first tool to point a confused user at: it self-identifies the server,
		// reports plugin/token state in plain language, and explicitly disclaims any
		// token/OAuth error that may have been emitted by a different Figma-related MCP.
		registerDiagnoseTool(this.server, {
			mode: "local",
			getServerVersion: () => {
				try {
					return JSON.parse(
						readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"),
					).version;
				} catch {
					return "0.0.0";
				}
			},
			getPluginState: () => {
				if (!this.wsServer) return null;
				const fileInfo = this.wsServer.getConnectedFileInfo();
				const connected = this.wsServer.isClientConnected();
				return {
					connected,
					fileName: fileInfo?.fileName,
					fileKey: fileInfo?.fileKey ?? undefined,
					currentPage: fileInfo?.currentPage,
					editorType: fileInfo?.editorType,
					port: this.wsActualPort ?? undefined,
					portFallbackFrom: this.wsPreferredPort,
				};
			},
			getTokenState: () => {
				const hasToken = !!process.env.FIGMA_ACCESS_TOKEN;
				return { hasToken, source: hasToken ? "env" : undefined };
			},
		});

		// Register Annotation tools (read/write design annotations via Desktop Bridge)
		registerAnnotationTools(
			this.server,
			() => this.getDesktopConnector(),
		);

		// Register Deep Component tools (full Plugin API tree extraction for code generation)
		registerDeepComponentTools(
			this.server,
			() => this.getDesktopConnector(),
		);

		// Register FigJam-specific tools (sticky notes, connectors, tables, etc.)
		registerFigJamTools(
			this.server,
			() => this.getDesktopConnector(),
		);

		// Register Figma Slides tools (slide management, transitions, content)
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

			// Copy plugin files to stable directory (~/.figma-console-mcp/plugin/)
			// so users have a permanent import path that survives npx cache changes.
			try {
				const thisFile = fileURLToPath(import.meta.url);
				const packageRoot = dirname(dirname(thisFile));
				const sourcePluginDir = resolve(packageRoot, "figma-desktop-bridge");
				if (existsSync(sourcePluginDir)) {
					this.stablePluginPath = setupStablePluginDir(sourcePluginDir);
				}
			} catch {
				// Non-critical — stable dir is a convenience feature
			}

			// Start WebSocket bridge server with port range fallback.
			// If the preferred port is taken (e.g., Claude Desktop Chat tab already bound it),
			// try subsequent ports in the range (9223-9232) so multiple instances can coexist.
			const wsHost = process.env.FIGMA_WS_HOST || 'localhost';
			this.wsPreferredPort = parseInt(process.env.FIGMA_WS_PORT || String(DEFAULT_WS_PORT), 10);

			// Clean up stale/orphaned MCP server instances before trying to bind.
			// Phase 1: Remove stale port files and terminate zombie processes that have port files
			cleanupStalePortFiles();
			// Phase 2: Deep scan for orphaned processes holding ports WITHOUT port files
			// (e.g., old instances from before port file tracking, or files already cleaned up)
			cleanupOrphanedProcesses(this.wsPreferredPort);

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

					// Start heartbeat — periodically refresh the port file to prove this server is active.
					// Other instances use this to detect zombie processes on startup.
					const heartbeatPort = boundPort;
					this.wsHeartbeatTimer = setInterval(() => refreshPortAdvertisement(heartbeatPort), HEARTBEAT_INTERVAL_MS);
					this.wsHeartbeatTimer.unref(); // Don't prevent process exit

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

			// Phase 3: If all ports exhausted, try evicting the oldest instance and retry ONCE
			if (!boundPort && evictOldestInstance(this.wsPreferredPort)) {
				for (const port of portsToTry) {
					try {
						this.wsServer = new FigmaWebSocketServer({ port, host: wsHost });
						await this.wsServer.start();
						const addr = this.wsServer.address();
						boundPort = addr?.port ?? port;
						this.wsActualPort = boundPort;
						logger.info(
							{ wsPort: boundPort, eviction: true },
							"WebSocket bridge server started after evicting stale instance",
						);
						advertisePort(boundPort, wsHost);
						registerPortCleanup(boundPort);
						const heartbeatPort = boundPort;
						this.wsHeartbeatTimer = setInterval(() => refreshPortAdvertisement(heartbeatPort), HEARTBEAT_INTERVAL_MS);
						this.wsHeartbeatTimer.unref();
						break;
					} catch (wsError) {
						const errorCode = wsError instanceof Error ? (wsError as any).code : undefined;
						if (errorCode === "EADDRINUSE") {
							this.wsServer = null;
							continue;
						}
						this.wsServer = null;
						break;
					}
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

				// Plugin disconnect leaves cached variables stale — when the plugin reconnects
				// after a sleep/wake or network blip, the file may have edits we missed
				// (no DOCUMENT_CHANGE event was delivered while we were disconnected).
				// Invalidate the cache for the disconnected file so the next read is fresh.
				this.wsServer.on("fileDisconnected", (data: { fileKey: string; fileName: string }) => {
					logger.info({ fileKey: data.fileKey, fileName: data.fileName }, "Desktop Bridge plugin disconnected from WebSocket");
					if (data.fileKey) {
						this.variablesCache.delete(data.fileKey);
					}
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
							logger.debug(
								{ fileKey: data.fileKey, changeCount: data.changeCount, hasStyleChanges: data.hasStyleChanges, hasNodeChanges: data.hasNodeChanges },
								"Variable cache invalidated due to document changes"
							);
						} else {
							// Unidentified file (event arrived before FILE_INFO handshake completed).
							// We don't know which cache entry to invalidate; do nothing rather than
							// blanket-clear other files' caches. FILE_INFO will arrive shortly and
							// any subsequent document changes will route correctly.
							logger.debug(
								{ changeCount: data.changeCount },
								"Document change received before file identification — cache untouched"
							);
						}
					}
				});
			}

			// Periodically reap orphaned/zombie servers for the whole run, not just
			// at startup, so the port range stays clean over long sessions. Runs
			// only when the WS bridge actually bound a port. Unref'd internally.
			if (this.wsActualPort !== null && !this.wsReaperStop) {
				this.wsReaperStop = startPeriodicReaper(this.wsPreferredPort);
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
			// In WS-only mode, no auto-connect is needed — the Desktop Bridge plugin
			// pushes a connection from the Figma side as soon as the user opens it.
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
			// Stop heartbeat timer
			if (this.wsHeartbeatTimer) {
				clearInterval(this.wsHeartbeatTimer);
				this.wsHeartbeatTimer = null;
			}

			// Stop the periodic reaper
			if (this.wsReaperStop) {
				this.wsReaperStop();
				this.wsReaperStop = null;
			}

			// Clean up port advertisement before stopping the server
			if (this.wsActualPort) {
				unadvertisePort(this.wsActualPort);
			}

			if (this.wsServer) {
				await this.wsServer.stop();
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

	// Handle graceful shutdown. A hard backstop guarantees the process exits even
	// if shutdown() hangs (e.g. an HTTP/WebSocket close that blocks on a lingering
	// connection). Without this, the SIGTERM listener suppresses Node's default
	// terminate-on-SIGTERM and the process zombifies — holding its port forever.
	const SHUTDOWN_TIMEOUT_MS = 5000;
	let shuttingDown = false;
	const gracefulExit = async (code: number) => {
		if (shuttingDown) return;
		shuttingDown = true;
		const backstop = setTimeout(() => {
			logger.error(`Shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit`);
			process.exit(code);
		}, SHUTDOWN_TIMEOUT_MS);
		backstop.unref();
		try {
			await server.shutdown();
		} catch (error) {
			logger.error({ error }, "Error during shutdown");
		}
		clearTimeout(backstop);
		process.exit(code);
	};

	process.on("SIGINT", () => { void gracefulExit(0); });
	process.on("SIGTERM", () => { void gracefulExit(0); });

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
	// Handle --print-path: print the Desktop Bridge manifest path and exit.
	// MUST always print a path and exit — never fall through to main().
	if (process.argv.includes("--print-path")) {
		try {
			const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
			const sourceDir = resolve(packageRoot, "figma-desktop-bridge");

			// Try to set up stable directory with the latest plugin files.
			const stablePath = setupStablePluginDir(sourceDir);
			if (stablePath && existsSync(stablePath)) {
				console.log(stablePath);
				console.error(
					"\nImport this manifest in Figma (Plugins → Development →\n" +
					"Import plugin from manifest). The MCP server refreshes the\n" +
					"plugin files in this directory on every startup.\n" +
					"\n" +
					"Re-importing after a package update is OPTIONAL — most\n" +
					"upgrades stay wire-compatible with the previous plugin.\n" +
					"Re-import only when release notes call for it, or when you\n" +
					"want the latest cosmetic touches (status-pill copy, plugin\n" +
					"version reporting). Figma caches plugin files at the app\n" +
					"level, so re-importing is what makes Figma pick up changes.\n"
				);
				process.exit(0);
			}

			// Fallback to npm package path
			const manifestPath = resolve(sourceDir, "manifest.json");
			if (existsSync(manifestPath)) {
				console.log(manifestPath);
				process.exit(0);
			}

			// Last resort: print the stable dir path even if it doesn't exist yet
			// (the server will create it on first startup)
			const stableDir = join(homedir(), ".figma-console-mcp", "plugin", "manifest.json");
			console.log(stableDir);
			console.error("\nNote: This path will be populated when the MCP server starts.");
			process.exit(0);
		} catch (error) {
			console.error("Error resolving plugin path:", error);
			process.exit(1);
		}
	}

	main().catch((error) => {
		console.error("Fatal error:", error);
		process.exit(1);
	});
}

export { LocalFigmaConsoleMCP };
