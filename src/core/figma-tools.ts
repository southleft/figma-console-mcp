/**
 * Figma API MCP Tools
 * MCP tool definitions for Figma REST API data extraction
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FigmaAPI } from "./figma-api.js";
import { extractFileKey, formatVariables, formatComponentData } from "./figma-api.js";
import { createChildLogger } from "./logger.js";
import { EnrichmentService } from "./enrichment/index.js";
import type { EnrichmentOptions } from "./types/enriched.js";
import { SnippetInjector } from "./snippet-injector.js";
import type { ConsoleMonitor } from "./console-monitor.js";

const logger = createChildLogger({ component: "figma-tools" });

// Initialize enrichment service
const enrichmentService = new EnrichmentService(logger);

// Initialize snippet injector
const snippetInjector = new SnippetInjector();

// ============================================================================
// Cache Management & Data Processing Helpers
// ============================================================================

/**
 * Cache configuration
 */
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_ENTRIES = 10; // LRU eviction

/**
 * Check if cache entry is still valid based on TTL
 */
function isCacheValid(timestamp: number, ttlMs: number = CACHE_TTL_MS): boolean {
	return Date.now() - timestamp < ttlMs;
}

/**
 * Rough token estimation for response size checking
 * Approximation: 1 token ≈ 4 characters for JSON
 */
function estimateTokens(data: any): number {
	const jsonString = JSON.stringify(data);
	return Math.ceil(jsonString.length / 4);
}

/**
 * Generate compact summary of variables data (~2K tokens)
 * Returns high-level overview with counts and names
 */
function generateSummary(data: any): any {
	const summary = {
		fileKey: data.fileKey,
		timestamp: data.timestamp,
		source: data.source || 'cache',
		overview: {
			total_variables: data.variables?.length || 0,
			total_collections: data.variableCollections?.length || 0,
		},
		collections: data.variableCollections?.map((c: any) => ({
			id: c.id,
			name: c.name,
			modes: c.modes?.map((m: any) => ({ id: m.modeId, name: m.name })),
			variable_count: c.variableIds?.length || 0,
		})) || [],
		variables_by_type: {} as Record<string, number>,
		variable_names: [] as string[],
	};

	// Count variables by type
	const typeCount: Record<string, number> = {};
	const names: string[] = [];

	data.variables?.forEach((v: any) => {
		typeCount[v.resolvedType] = (typeCount[v.resolvedType] || 0) + 1;
		names.push(v.name);
	});

	summary.variables_by_type = typeCount;
	summary.variable_names = names;

	return summary;
}

/**
 * Apply filters to variables data
 */
function applyFilters(
	data: any,
	filters: {
		collection?: string;
		namePattern?: string;
		mode?: string;
	}
): any {
	let filteredVariables = [...(data.variables || [])];
	let filteredCollections = [...(data.variableCollections || [])];

	// Filter by collection name or ID
	if (filters.collection) {
		const collectionFilter = filters.collection.toLowerCase();
		filteredCollections = filteredCollections.filter((c: any) =>
			c.name?.toLowerCase().includes(collectionFilter) ||
			c.id === filters.collection
		);

		const collectionIds = new Set(filteredCollections.map((c: any) => c.id));
		filteredVariables = filteredVariables.filter((v: any) =>
			collectionIds.has(v.variableCollectionId)
		);
	}

	// Filter by variable name pattern (regex or substring)
	if (filters.namePattern) {
		try {
			const regex = new RegExp(filters.namePattern, 'i');
			filteredVariables = filteredVariables.filter((v: any) =>
				regex.test(v.name)
			);
		} catch (e) {
			// If regex fails, fall back to substring match
			const pattern = filters.namePattern.toLowerCase();
			filteredVariables = filteredVariables.filter((v: any) =>
				v.name?.toLowerCase().includes(pattern)
			);
		}
	}

	// Filter by mode name or ID
	if (filters.mode) {
		const modeFilter = filters.mode.toLowerCase();
		filteredVariables = filteredVariables.filter((v: any) => {
			// Check if variable has values for the specified mode
			if (v.valuesByMode) {
				// Try to match by mode ID directly
				if (v.valuesByMode[filters.mode!]) {
					return true;
				}
				// Try to match by mode name through collections
				const collection = filteredCollections.find((c: any) =>
					c.id === v.variableCollectionId
				);
				if (collection?.modes) {
					const mode = collection.modes.find((m: any) =>
						m.name?.toLowerCase().includes(modeFilter) || m.modeId === filters.mode
					);
					return mode && v.valuesByMode[mode.modeId];
				}
			}
			return false;
		});
	}

	return {
		...data,
		variables: filteredVariables,
		variableCollections: filteredCollections,
	};
}

/**
 * Manage LRU cache eviction
 */
function evictOldestCacheEntry(
	cache: Map<string, { data: any; timestamp: number }>
): void {
	if (cache.size >= MAX_CACHE_ENTRIES) {
		// Find oldest entry
		let oldestKey: string | null = null;
		let oldestTime = Infinity;

		for (const [key, entry] of cache.entries()) {
			if (entry.timestamp < oldestTime) {
				oldestTime = entry.timestamp;
				oldestKey = key;
			}
		}

		if (oldestKey) {
			cache.delete(oldestKey);
			logger.info({ evictedKey: oldestKey }, 'Evicted oldest cache entry (LRU)');
		}
	}
}

/**
 * Register Figma API tools with the MCP server
 */
export function registerFigmaAPITools(
	server: McpServer,
	getFigmaAPI: () => FigmaAPI,
	getCurrentUrl: () => string | null,
	getConsoleMonitor?: () => ConsoleMonitor | null,
	getBrowserManager?: () => any,
	ensureInitialized?: () => Promise<void>,
	variablesCache?: Map<string, { data: any; timestamp: number }>
) {
	// Tool 8: Get File Data (General Purpose)
	// NOTE: For specific use cases, consider using specialized tools:
	// - figma_get_component_for_development: For UI component implementation
	// - figma_get_file_for_plugin: For plugin development
	server.tool(
		"figma_get_file_data",
		"Get full file structure and document tree. WARNING: Can consume large amounts of tokens. NOT recommended for component descriptions (use figma_get_component instead). Best for understanding file structure or finding component nodeIds. Start with verbosity='summary' and depth=1 for initial exploration.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe(
					"Figma file URL (e.g., https://figma.com/design/abc123). REQUIRED unless figma_navigate was already called. If not provided, ask the user to share their Figma file URL (they can copy it from Figma Desktop via right-click → 'Copy link')."
				),
			depth: z
				.number()
				.min(0)
				.max(3)
				.optional()
				.default(1)
				.describe(
					"How many levels of children to include (default: 1, max: 3). Start with 1 to prevent context exhaustion. Use 0 for full tree only when absolutely necessary."
				),
			verbosity: z
				.enum(["summary", "standard", "full"])
				.optional()
				.default("summary")
				.describe(
					"Controls payload size: 'summary' (IDs/names/types only, ~90% smaller - RECOMMENDED), 'standard' (essential properties, ~50% smaller), 'full' (everything). Default: summary for token efficiency."
				),
			nodeIds: z
				.array(z.string())
				.optional()
				.describe("Specific node IDs to retrieve (optional)"),
			enrich: z
				.boolean()
				.optional()
				.describe(
					"Set to true when user asks for: file statistics, health metrics, design system audit, or quality analysis. Adds statistics, health scores, and audit summaries. Default: false"
				),
		},
		async ({ fileUrl, depth, nodeIds, enrich, verbosity }) => {
			try {
				const api = getFigmaAPI();

				// Use provided URL or current URL from browser
				const url = fileUrl || getCurrentUrl();
				if (!url) {
					throw new Error(
						"No Figma file URL provided. Either pass fileUrl parameter or call figma_navigate first."
					);
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					throw new Error(`Invalid Figma URL: ${url}`);
				}

				logger.info({ fileKey, depth, nodeIds, enrich, verbosity }, "Fetching file data");

				const fileData = await api.getFile(fileKey, {
					depth,
					ids: nodeIds,
				});

				// Apply verbosity filtering to reduce payload size
				const filterNode = (node: any, level: "summary" | "standard" | "full"): any => {
					if (!node) return node;

					if (level === "summary") {
						// Summary: Only IDs, names, types (~90% reduction)
						return {
							id: node.id,
							name: node.name,
							type: node.type,
							...(node.children && {
								children: node.children.map((child: any) => filterNode(child, level))
							}),
						};
					}

					if (level === "standard") {
						// Standard: Essential properties for plugin development (~50% reduction)
						const filtered: any = {
							id: node.id,
							name: node.name,
							type: node.type,
							visible: node.visible,
							locked: node.locked,
						};

						// Include bounds for layout calculations
						if (node.absoluteBoundingBox) filtered.absoluteBoundingBox = node.absoluteBoundingBox;
						if (node.size) filtered.size = node.size;

						// Include component/instance info for plugin work
						if (node.componentId) filtered.componentId = node.componentId;
						if (node.componentPropertyReferences) filtered.componentPropertyReferences = node.componentPropertyReferences;

						// Include basic styling (but not full details)
						if (node.fills && node.fills.length > 0) {
							filtered.fills = node.fills.map((fill: any) => ({
								type: fill.type,
								visible: fill.visible,
								...(fill.color && { color: fill.color }),
							}));
						}

						// Include plugin data if present
						if (node.pluginData) filtered.pluginData = node.pluginData;
						if (node.sharedPluginData) filtered.sharedPluginData = node.sharedPluginData;

						// Recursively filter children
						if (node.children) {
							filtered.children = node.children.map((child: any) => filterNode(child, level));
						}

						return filtered;
					}

					// Full: Return everything
					return node;
				};

				const filteredDocument = verbosity !== "full"
					? filterNode(fileData.document, verbosity || "standard")
					: fileData.document;

				let response: any = {
					fileKey,
					name: fileData.name,
					lastModified: fileData.lastModified,
					version: fileData.version,
					document: filteredDocument,
					components: fileData.components
						? Object.keys(fileData.components).length
						: 0,
					styles: fileData.styles
						? Object.keys(fileData.styles).length
						: 0,
					verbosity: verbosity || "standard",
					...(nodeIds && {
						requestedNodes: nodeIds,
						nodes: fileData.nodes,
					}),
				};

				// Apply enrichment if requested
				if (enrich) {
					const enrichmentOptions: EnrichmentOptions = {
						enrich: true,
						include_usage: true,
					};

					response = await enrichmentService.enrichFileData(
						{ ...response, ...fileData },
						enrichmentOptions
					);
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									...response,
									enriched: enrich || false,
								},
								null,
								2
							),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "Failed to get file data");
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: errorMessage,
									message: "Failed to retrieve Figma file data",
									hint: "Make sure FIGMA_ACCESS_TOKEN is configured and the file is accessible",
								},
								null,
								2
							),
						},
					],
					isError: true,
				};
			}
		}
	);

	/**
	 * Tool 9: Get Variables (Design Tokens)
	 *
	 * WORKFLOW:
	 * - Primary: Attempts to fetch variables via Figma REST API (requires Enterprise plan)
	 * - Fallback: On 403 error, provides console-based extraction snippet
	 *
	 * TWO-CALL PATTERN (when API unavailable):
	 * 1. First call: Returns snippet + instructions (useConsoleFallback: true, default)
	 * 2. User runs snippet in Figma plugin console
	 * 3. Second call: Parses captured data (parseFromConsole: true)
	 *
	 * IMPORTANT: Snippet requires Figma Plugin API context, not browser DevTools console.
	 */
	server.tool(
		"figma_get_variables",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe(
					"Figma file URL (e.g., https://figma.com/design/abc123). REQUIRED unless figma_navigate was already called. If not provided, ask the user to share their Figma file URL (they can copy it from Figma Desktop via right-click → 'Copy link')."
				),
			includePublished: z
				.boolean()
				.optional()
				.default(true)
				.describe("Include published variables from libraries"),
			verbosity: z
				.enum(["summary", "standard", "full"])
				.optional()
				.default("standard")
				.describe(
					"Controls payload size: 'summary' (names/values only, ~80% smaller), 'standard' (essential properties, ~45% smaller), 'full' (everything). Default: standard"
				),
			enrich: z
				.boolean()
				.optional()
				.describe(
					"Set to true when user asks for: CSS/Sass/Tailwind exports, code examples, design tokens, usage information, dependencies, or any export format. Adds resolved values, dependency graphs, and usage analysis. Default: false"
				),
			include_usage: z
				.boolean()
				.optional()
				.describe("Include usage in styles and components (requires enrich=true)"),
			include_dependencies: z
				.boolean()
				.optional()
				.describe("Include variable dependency graph (requires enrich=true)"),
			include_exports: z
				.boolean()
				.optional()
				.describe("Include export format examples (requires enrich=true)"),
				export_formats: z
				.array(z.enum(["css", "sass", "tailwind", "typescript", "json"]))
				.optional()
				.describe("Which code formats to generate examples for. Use when user mentions specific formats like 'CSS', 'Tailwind', 'SCSS', 'TypeScript', etc. Automatically enables enrichment."),
			format: z
				.enum(["summary", "filtered", "full"])
				.optional()
				.default("full")
				.describe(
					"Response format: 'summary' (~2K tokens with overview and names only), 'filtered' (apply collection/name/mode filters), 'full' (complete dataset from cache or fetch). " +
					"Summary is recommended for initial exploration. Full format returns all data but may be auto-summarized if >25K tokens. Default: full"
				),
			collection: z
				.string()
				.optional()
				.describe("Filter variables by collection name or ID. Case-insensitive substring match. Only applies when format='filtered'. Example: 'Primitives' or 'VariableCollectionId:123'"),
			namePattern: z
				.string()
				.optional()
				.describe("Filter variables by name using regex pattern or substring. Case-insensitive. Only applies when format='filtered'. Example: 'color/brand' or '^typography'"),
			mode: z
				.string()
				.optional()
				.describe("Filter variables by mode name or ID. Only returns variables that have values for this mode. Only applies when format='filtered'. Example: 'Light' or 'Dark'"),
			refreshCache: z
				.boolean()
				.optional()
				.default(false)
				.describe("Force refresh cache by fetching fresh data from Figma. Use when data may have changed since last fetch. Default: false (use cached data if available and fresh)"),
			useConsoleFallback: z
				.boolean()
				.optional()
				.default(true)
				.describe(
					"Enable automatic fallback to console-based extraction when REST API returns 403 (Figma Enterprise plan required). " +
					"When enabled, provides a JavaScript snippet that users run in Figma's plugin console. " +
					"This is STEP 1 of a two-call workflow. After receiving the snippet, instruct the user to run it, then call this tool again with parseFromConsole=true. " +
					"Default: true. Set to false only to disable the fallback entirely."
				),
			parseFromConsole: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					"Parse variables from console logs after user has executed the snippet. " +
					"This is STEP 2 of the two-call workflow. Set to true ONLY after: " +
					"(1) you received a console snippet from the first call, " +
					"(2) instructed the user to run it in Figma's PLUGIN console (Plugins → Development → Open Console or existing plugin), " +
					"(3) user confirmed they ran the snippet and saw '✅ Variables data captured!' message. " +
					"Default: false. Never set to true on the first call."
				),
		},
		async ({
			fileUrl,
			includePublished,
			verbosity,
			enrich,
			include_usage,
			include_dependencies,
			include_exports,
			export_formats,
			format,
			collection,
			namePattern,
			mode,
			refreshCache,
			useConsoleFallback,
			parseFromConsole
		}) => {
			// Extract fileKey outside try block so it's available in catch block
			const url = fileUrl || getCurrentUrl();
			if (!url) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: "No Figma file URL provided",
									message: "Either pass fileUrl parameter or call figma_navigate first."
								},
								null,
								2
							),
						},
					],
					isError: true,
				};
			}

			const fileKey = extractFileKey(url);
			if (!fileKey) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: `Invalid Figma URL: ${url}`,
									message: "Could not extract file key from URL"
								},
								null,
								2
							),
						},
					],
					isError: true,
				};
			}

			try {
				// =====================================================================
				// CACHE-FIRST LOGIC: Check if we have cached data before fetching
				// =====================================================================
				let cachedData: any = null;
				let shouldFetch = true;

				if (variablesCache && !parseFromConsole) {
					const cacheEntry = variablesCache.get(fileKey);

					if (cacheEntry) {
						const isValid = isCacheValid(cacheEntry.timestamp);

						if (isValid && !refreshCache) {
							// Cache hit! Use cached data
							cachedData = cacheEntry.data;
							shouldFetch = false;

							logger.info(
								{
									fileKey,
									cacheAge: Date.now() - cacheEntry.timestamp,
									variableCount: cachedData.variables?.length,
								},
								'Using cached variables data'
							);
						} else if (!isValid) {
							logger.info({ fileKey, cacheAge: Date.now() - cacheEntry.timestamp }, 'Cache expired, will refresh');
						} else if (refreshCache) {
							logger.info({ fileKey }, 'Refresh cache requested, will fetch fresh data');
						}
					} else {
						logger.info({ fileKey }, 'No cache entry found, will fetch data');
					}
				}

				// If we have cached data, skip fetching and jump to formatting
				if (cachedData && !shouldFetch) {
					// Apply format logic based on user request
					let responseData = cachedData;

					if (format === 'summary') {
						// Return compact summary
						responseData = generateSummary(cachedData);
						logger.info({ fileKey, estimatedTokens: estimateTokens(responseData) }, 'Generated summary from cache');
					} else if (format === 'filtered') {
						// Apply filters
						responseData = applyFilters(cachedData, {
							collection,
							namePattern,
							mode,
						});
						logger.info(
							{
								fileKey,
								originalCount: cachedData.variables?.length,
								filteredCount: responseData.variables?.length,
							},
							'Applied filters to cached data'
						);

						// Auto-summarize if still too large
						const estimatedTokens = estimateTokens(responseData);
						if (estimatedTokens > 25000) {
							logger.warn({ fileKey, estimatedTokens }, 'Filtered data still exceeds token limit, auto-summarizing');
							responseData = generateSummary(responseData);
						}
					} else {
						// format === 'full'
						// Check if we need to auto-summarize
						const estimatedTokens = estimateTokens(responseData);
						if (estimatedTokens > 25000) {
							logger.warn(
								{ fileKey, estimatedTokens },
								'Full data exceeds MCP token limit (25K), auto-summarizing. Use format=summary or format=filtered to get specific data.'
							);
							const summary = generateSummary(responseData);
							return {
								content: [
									{
										type: "text",
										text: JSON.stringify(
											{
												fileKey,
												source: 'cache_auto_summarized',
												warning: 'Full dataset exceeds MCP token limit (25,000 tokens)',
												suggestion: 'Use format="summary" for overview or format="filtered" with collection/namePattern/mode filters to get specific variables',
												estimatedTokens,
												summary,
											},
											null,
											2
										),
									},
								],
							};
						}
					}

					// Return cached/processed data
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										fileKey,
										source: 'cache',
										format: format || 'full',
										timestamp: cachedData.timestamp,
										data: responseData,
									},
									null,
									2
								),
							},
						],
					};
				}

				// =====================================================================
				// FETCH LOGIC: No cache or cache invalid/refresh requested
				// =====================================================================

				// BEST: Try Desktop connection first (like official Figma MCP does)
				// Ensure browser manager is initialized
				if (ensureInitialized && !parseFromConsole) {
					logger.info("Calling ensureInitialized to initialize browser manager");
					await ensureInitialized();
				}

				const browserManager = getBrowserManager?.();
				logger.info({ hasBrowserManager: !!browserManager, parseFromConsole }, "Desktop connection check");

				// Debug: Log why Desktop connection might be skipped
				if (!browserManager) {
					logger.error("Desktop connection skipped: browserManager is not available");
				} else if (parseFromConsole) {
					logger.info("Desktop connection skipped: parseFromConsole is true");
				}

				if (browserManager && !parseFromConsole) {
					try {
						logger.info({ fileKey }, "Attempting to get variables via Desktop connection");

						// Import and use the Desktop connector
						const { FigmaDesktopConnector } = await import('./figma-desktop-connector.js');
						const page = await browserManager.getPage();
						logger.info("Got page from browser manager");

						// Log to browser console for MCP capture
						await page.evaluate(() => {
							console.log('[FIGMA_TOOLS] 🚀 Got page from browser manager, creating Desktop connector...');
						});

						const connector = new FigmaDesktopConnector(page);

						await page.evaluate(() => {
							console.log('[FIGMA_TOOLS] ✅ Desktop connector created, initializing...');
						});

						await connector.initialize();
						logger.info("Desktop connector initialized, calling getVariablesFromPluginUI...");

						await page.evaluate(() => {
							console.log('[FIGMA_TOOLS] ✅ Desktop connector initialized, calling getVariablesFromPluginUI...');
						});

						const desktopResult = await connector.getVariablesFromPluginUI(fileKey);

						if (desktopResult.success && desktopResult.variables) {
							logger.info(
								{
									variableCount: desktopResult.variables.length,
									collectionCount: desktopResult.variableCollections?.length
								},
								"Successfully retrieved variables via Desktop connection!"
							);

							// Prepare data for caching (using the raw data, not enriched)
							const dataForCache = {
								fileKey,
								source: "desktop_connection",
								timestamp: desktopResult.timestamp || Date.now(),
								variables: desktopResult.variables,
								variableCollections: desktopResult.variableCollections,
							};

							// Store in cache with LRU eviction
							if (variablesCache) {
								evictOldestCacheEntry(variablesCache);
								variablesCache.set(fileKey, {
									data: dataForCache,
									timestamp: Date.now(),
								});
								logger.info(
									{ fileKey, cacheSize: variablesCache.size },
									'Stored variables in cache'
								);
							}

							// Apply format logic
							let responseData = dataForCache;

							if (format === 'summary') {
								responseData = generateSummary(dataForCache);
								logger.info({ fileKey, estimatedTokens: estimateTokens(responseData) }, 'Generated summary from fetched data');
							} else if (format === 'filtered') {
								responseData = applyFilters(dataForCache, {
									collection,
									namePattern,
									mode,
								});
								logger.info(
									{
										fileKey,
										originalCount: dataForCache.variables?.length,
										filteredCount: responseData.variables?.length,
									},
									'Applied filters to fetched data'
								);

								// Auto-summarize if still too large
								const estimatedTokens = estimateTokens(responseData);
								if (estimatedTokens > 25000) {
									logger.warn({ fileKey, estimatedTokens }, 'Filtered data still exceeds token limit, auto-summarizing');
									responseData = generateSummary(responseData);
								}
							} else {
								// format === 'full'
								// Check if we need to auto-summarize
								const estimatedTokens = estimateTokens(responseData);
								if (estimatedTokens > 25000) {
									logger.warn(
										{ fileKey, estimatedTokens },
										'Full data exceeds MCP token limit (25K), auto-summarizing. Use format=summary or format=filtered to get specific data.'
									);
									const summary = generateSummary(responseData);
									return {
										content: [
											{
												type: "text",
												text: JSON.stringify(
													{
														fileKey,
														source: 'desktop_connection_auto_summarized',
														warning: 'Full dataset exceeds MCP token limit (25,000 tokens)',
														suggestion: 'Use format="summary" for overview or format="filtered" with collection/namePattern/mode filters to get specific variables',
														estimatedTokens,
														summary,
													},
													null,
													2
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
												fileKey,
												source: "desktop_connection",
												format: format || 'full',
												timestamp: dataForCache.timestamp,
												data: responseData,
												cached: true,
											},
											null,
											2
										),
									},
								],
							};
						}
					} catch (desktopError) {
						const errorMessage = desktopError instanceof Error ? desktopError.message : String(desktopError);
						const errorStack = desktopError instanceof Error ? desktopError.stack : undefined;

						logger.error({
							error: desktopError,
							message: errorMessage,
							stack: errorStack
						}, "Desktop connection failed, falling back to other methods");

						// Try to log to browser console if we have access to page
						try {
							if (browserManager) {
								const page = await browserManager.getPage();
								await page.evaluate((msg: string, stack: string | undefined) => {
									console.error('[FIGMA_TOOLS] ❌ Desktop connection failed:', msg);
									if (stack) {
										console.error('[FIGMA_TOOLS] Stack trace:', stack);
									}
								}, errorMessage, errorStack);
							}
						} catch (logError) {
							// Ignore logging errors
						}

						// Continue to try other methods
					}
				}

				// FALLBACK: Parse from console logs if requested
				if (parseFromConsole) {
					const consoleMonitor = getConsoleMonitor?.();
					if (!consoleMonitor) {
						throw new Error("Console monitoring not available. Make sure browser is connected to Figma.");
					}

					logger.info({ fileKey }, "Parsing variables from console logs");

					// Get recent logs
					const logs = consoleMonitor.getLogs({ count: 100, level: "log" });
					const varLog = snippetInjector.findVariablesLog(logs);

					if (!varLog) {
						throw new Error(
							"No variables found in console logs.\n\n" +
							"Did you run the snippet in Figma's plugin console? Here's the correct workflow:\n\n" +
							"1. Call figma_get_variables() without parameters (you may have already done this)\n" +
							"2. Copy the provided snippet\n" +
							"3. Open Figma Desktop → Plugins → Development → Open Console\n" +
							"4. Paste and run the snippet in the PLUGIN console (not browser DevTools)\n" +
							"5. Wait for '✅ Variables data captured!' confirmation\n" +
							"6. Then call figma_get_variables({ parseFromConsole: true })\n\n" +
							"Note: The browser console won't work - you need a plugin console for the figma.variables API."
						);
					}

					// Parse variables from log
					const parsedData = snippetInjector.parseVariablesFromLog(varLog);

					if (!parsedData) {
						throw new Error("Failed to parse variables from console log");
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										fileKey,
										source: "console_capture",
										local: {
											summary: {
												total_variables: parsedData.variables.length,
												total_collections: parsedData.variableCollections.length,
											},
											collections: parsedData.variableCollections,
											variables: parsedData.variables,
										},
										timestamp: parsedData.timestamp,
										enriched: false,
									},
									null,
									2
								),
							},
						],
					};
				}

				// Try REST API
				logger.info({ fileKey, includePublished, verbosity, enrich }, "Fetching variables via REST API");
				const api = getFigmaAPI();

				const { local, published } = await api.getAllVariables(fileKey);

				let localFormatted = formatVariables(local);
				let publishedFormatted = includePublished
					? formatVariables(published)
					: null;

				// Apply verbosity filtering
				const filterVariable = (variable: any, level: "summary" | "standard" | "full"): any => {
					if (!variable) return variable;

					if (level === "summary") {
						// Summary: Only id, name, value (~80% reduction)
						return {
							id: variable.id,
							name: variable.name,
							resolvedType: variable.resolvedType,
							valuesByMode: variable.valuesByMode,
						};
					}

					if (level === "standard") {
						// Standard: Essential properties (~45% reduction)
						return {
							id: variable.id,
							name: variable.name,
							resolvedType: variable.resolvedType,
							valuesByMode: variable.valuesByMode,
							description: variable.description,
							variableCollectionId: variable.variableCollectionId,
							...(variable.scopes && { scopes: variable.scopes }),
						};
					}

					// Full: Return everything
					return variable;
				};

				const filterCollection = (collection: any, level: "summary" | "standard" | "full"): any => {
					if (!collection) return collection;

					if (level === "summary") {
						return {
							id: collection.id,
							name: collection.name,
						};
					}

					if (level === "standard") {
						return {
							id: collection.id,
							name: collection.name,
							modes: collection.modes,
							defaultModeId: collection.defaultModeId,
						};
					}

					return collection;
				};

				if (verbosity !== "full") {
					const level = verbosity || "standard";
					localFormatted.variables = localFormatted.variables.map((v: any) => filterVariable(v, level));
					localFormatted.collections = localFormatted.collections.map((c: any) => filterCollection(c, level));

					if (publishedFormatted) {
						publishedFormatted.variables = publishedFormatted.variables.map((v: any) => filterVariable(v, level));
						publishedFormatted.collections = publishedFormatted.collections.map((c: any) => filterCollection(c, level));
					}
				}

				// Apply enrichment if requested
				if (enrich) {
					const enrichmentOptions: EnrichmentOptions = {
						enrich: true,
						include_usage: include_usage !== false,
						include_dependencies: include_dependencies !== false,
						include_exports: include_exports !== false,
						export_formats: export_formats || ["css", "sass", "tailwind", "typescript", "json"],
					};

					// Enrich local variables
					const enrichedLocal = await enrichmentService.enrichVariables(
						localFormatted.variables,
						fileKey,
						enrichmentOptions
					);
					localFormatted = { ...localFormatted, variables: enrichedLocal };

					// Enrich published variables if included
					if (publishedFormatted) {
						const enrichedPublished = await enrichmentService.enrichVariables(
							publishedFormatted.variables,
							fileKey,
							enrichmentOptions
						);
						publishedFormatted = { ...publishedFormatted, variables: enrichedPublished };
					}
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									fileKey,
									local: {
										summary: localFormatted.summary,
										collections: localFormatted.collections,
										variables: localFormatted.variables,
									},
									...(includePublished &&
										publishedFormatted && {
											published: {
												summary: publishedFormatted.summary,
												collections: publishedFormatted.collections,
												variables: publishedFormatted.variables,
											},
										}),
									verbosity: verbosity || "standard",
									enriched: enrich || false,
								},
								null,
								2
							),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "Failed to get variables");
				const errorMessage =
					error instanceof Error ? error.message : String(error);

				// FIXED: Jump directly to Styles API (fast) instead of full file data (slow)
				if (errorMessage.includes("403")) {
					try {
						logger.info({ fileKey }, "Variables API requires Enterprise, falling back to Styles API");

						const api = getFigmaAPI();
						// Use the Styles API directly - much faster than getFile!
						const stylesData = await api.getStyles(fileKey);

						// Format the styles data similar to variables
						const formattedStyles = {
							summary: {
								total_styles: stylesData.meta?.styles?.length || 0,
								message: "Variables API requires Enterprise. Here are your design styles instead.",
								note: "These are Figma Styles (not Variables). Styles are the traditional way to store design tokens in Figma."
							},
							styles: stylesData.meta?.styles || []
						};

						logger.info(
							{ styleCount: formattedStyles.summary.total_styles },
							"Successfully retrieved styles as fallback!"
						);

						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											fileKey,
											source: "styles_api",
											message: "Variables API requires an Enterprise plan. Retrieved your design system styles instead.",
											data: formattedStyles,
											fallback_method: true,
										},
										null,
										2
									),
								},
							],
						};
					} catch (styleError) {
						logger.warn({ error: styleError }, "Style extraction failed");

						// Return a simple error message without the console snippet
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											error: "Unable to extract variables or styles from this file",
											message: "The Variables API requires an Enterprise plan, and the automatic style extraction encountered an error.",
											possibleReasons: [
												"The file may be private or require additional permissions",
												"The file structure may not contain extractable styles",
												"There may be a network or authentication issue"
											],
											suggestion: "Please ensure the file is accessible and try again, or check if your token has the necessary permissions.",
											technical: styleError instanceof Error ? styleError.message : String(styleError)
										},
										null,
										2
									),
								},
							],
						};
					}
				}

				// Standard error response
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: errorMessage,
									message: "Failed to retrieve Figma variables",
									hint: errorMessage.includes("403")
										? "Variables API requires Enterprise plan. Set useConsoleFallback=true for alternative method."
										: "Make sure FIGMA_ACCESS_TOKEN is configured and has appropriate permissions",
								},
								null,
								2
							),
						},
					],
					isError: true,
				};
			}
		}
	);

	// Tool 10: Get Component Data
	server.tool(
		"figma_get_component",
		"Get component metadata including reliable description fields. IMPORTANT: For local/unpublished components, ensure the Figma Desktop Bridge plugin is running (Right-click in Figma → Plugins → Development → Figma Desktop Bridge) to get complete description data. Without the plugin, descriptions may be missing due to REST API limitations.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe(
					"Figma file URL (e.g., https://figma.com/design/abc123). REQUIRED unless figma_navigate was already called. If not provided, ask the user to share their Figma file URL (they can copy it from Figma Desktop via right-click → 'Copy link')."
				),
			nodeId: z
				.string()
				.describe("Component node ID (e.g., '123:456')"),
			enrich: z
				.boolean()
				.optional()
				.describe(
					"Set to true when user asks for: design token coverage, hardcoded value analysis, or component quality metrics. Adds token coverage analysis and hardcoded value detection. Default: false"
				),
		},
		async ({ fileUrl, nodeId, enrich }) => {
			try {
				const api = getFigmaAPI();

				const url = fileUrl || getCurrentUrl();
				if (!url) {
					throw new Error(
						"No Figma file URL provided. Either pass fileUrl parameter or call figma_navigate first."
					);
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					throw new Error(`Invalid Figma URL: ${url}`);
				}

				logger.info({ fileKey, nodeId, enrich }, "Fetching component data");

				// PRIORITY 1: Try Desktop Bridge plugin UI first (has reliable description field!)
				const browserManager = getBrowserManager?.();
				if (browserManager && ensureInitialized) {
					try {
						logger.info({ nodeId }, "Attempting to get component via Desktop Bridge plugin UI");
						await ensureInitialized();

						const { FigmaDesktopConnector } = await import('./figma-desktop-connector.js');
						const page = await browserManager.getPage();
						const connector = new FigmaDesktopConnector(page);
						await connector.initialize();

						const desktopResult = await connector.getComponentFromPluginUI(nodeId);

						if (desktopResult.success && desktopResult.component) {
							logger.info(
								{
									componentName: desktopResult.component.name,
									hasDescription: !!desktopResult.component.description,
									hasDescriptionMarkdown: !!desktopResult.component.descriptionMarkdown
								},
								"Successfully retrieved component via Desktop Bridge plugin UI!"
							);

							let formatted = desktopResult.component;

							// Apply enrichment if requested
							if (enrich) {
								const enrichmentOptions: EnrichmentOptions = {
									enrich: true,
									include_usage: true,
								};

								formatted = await enrichmentService.enrichComponent(
									formatted,
									fileKey,
									enrichmentOptions
								);
							}

							return {
								content: [
									{
										type: "text",
										text: JSON.stringify(
											{
												fileKey,
												nodeId,
												component: formatted,
												source: "desktop_bridge_plugin",
												enriched: enrich || false,
												note: "Retrieved via Desktop Bridge plugin - description fields are reliable and current"
											},
											null,
											2
										),
									},
								],
							};
						}
					} catch (desktopError) {
						logger.warn({ error: desktopError, nodeId }, "Desktop Bridge plugin failed, falling back to REST API");
					}
				}

				// FALLBACK: Use REST API (may have missing/outdated description)
				logger.info({ nodeId }, "Using REST API fallback");
				const componentData = await api.getComponentData(fileKey, nodeId);

				if (!componentData) {
					throw new Error(`Component not found: ${nodeId}`);
				}

				let formatted = formatComponentData(componentData.document);

				// Apply enrichment if requested
				if (enrich) {
					const enrichmentOptions: EnrichmentOptions = {
						enrich: true,
						include_usage: true,
					};

					formatted = await enrichmentService.enrichComponent(
						formatted,
						fileKey,
						enrichmentOptions
					);
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									fileKey,
									nodeId,
									component: formatted,
									source: "rest_api",
									enriched: enrich || false,
									warning: "Retrieved via REST API - description field may be missing due to known Figma API bug",
									action_required: formatted.description || formatted.descriptionMarkdown ? null : "To get reliable component descriptions, run the Desktop Bridge plugin in Figma Desktop: Right-click → Plugins → Development → Figma Desktop Bridge, then try again."
								},
								null,
								2
							),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "Failed to get component");
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: errorMessage,
									message: "Failed to retrieve component data",
									hint: "Make sure the node ID is correct and the file is accessible",
								},
								null,
								2
							),
						},
					],
					isError: true,
				};
			}
		}
	);

	// Tool 11: Get Styles
	server.tool(
		"figma_get_styles",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe(
					"Figma file URL (e.g., https://figma.com/design/abc123). REQUIRED unless figma_navigate was already called. If not provided, ask the user to share their Figma file URL (they can copy it from Figma Desktop via right-click → 'Copy link')."
				),
			verbosity: z
				.enum(["summary", "standard", "full"])
				.optional()
				.default("standard")
				.describe(
					"Controls payload size: 'summary' (names/types only, ~85% smaller), 'standard' (essential properties, ~40% smaller), 'full' (everything). Default: standard"
				),
			enrich: z
				.boolean()
				.optional()
				.describe(
					"Set to true when user asks for: CSS/Sass/Tailwind code, export formats, usage information, code examples, or design system exports. Adds resolved values, usage analysis, and export format examples. Default: false for backward compatibility"
				),
			include_usage: z
				.boolean()
				.optional()
				.describe("Include component usage information (requires enrich=true)"),
			include_exports: z
				.boolean()
				.optional()
				.describe("Include export format examples (requires enrich=true)"),
			export_formats: z
				.array(z.enum(["css", "sass", "tailwind", "typescript", "json"]))
				.optional()
				.describe(
					"Which code formats to generate examples for. Use when user mentions specific formats like 'CSS', 'Tailwind', 'SCSS', 'TypeScript', etc. Automatically enables enrichment. Default: all formats"
				),
		},
		async ({ fileUrl, verbosity, enrich, include_usage, include_exports, export_formats }) => {
			try {
				const api = getFigmaAPI();

				const url = fileUrl || getCurrentUrl();
				if (!url) {
					throw new Error(
						"No Figma file URL provided. Either pass fileUrl parameter or call figma_navigate first."
					);
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					throw new Error(`Invalid Figma URL: ${url}`);
				}

				logger.info({ fileKey, verbosity, enrich }, "Fetching styles");

				const stylesData = await api.getStyles(fileKey);
				let styles = stylesData.meta?.styles || [];

				// Apply verbosity filtering
				const filterStyle = (style: any, level: "summary" | "standard" | "full"): any => {
					if (!style) return style;

					if (level === "summary") {
						// Summary: Only key, name, type (~85% reduction)
						return {
							key: style.key,
							name: style.name,
							style_type: style.style_type,
						};
					}

					if (level === "standard") {
						// Standard: Essential properties (~40% reduction)
						return {
							key: style.key,
							name: style.name,
							description: style.description,
							style_type: style.style_type,
							...(style.remote && { remote: style.remote }),
						};
					}

					// Full: Return everything
					return style;
				};

				if (verbosity !== "full") {
					styles = styles.map((style: any) => filterStyle(style, verbosity || "standard"));
				}

				// Apply enrichment if requested
				if (enrich) {
					const enrichmentOptions: EnrichmentOptions = {
						enrich: true,
						include_usage: include_usage !== false,
						include_exports: include_exports !== false,
						export_formats: export_formats || [
							"css",
							"sass",
							"tailwind",
							"typescript",
							"json",
						],
					};

					styles = await enrichmentService.enrichStyles(
						styles,
						fileKey,
						enrichmentOptions
					);
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									fileKey,
									styles,
									totalStyles: styles.length,
									verbosity: verbosity || "standard",
									enriched: enrich || false,
								},
								null,
								2
							),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "Failed to get styles");
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: errorMessage,
									message: "Failed to retrieve styles",
								},
								null,
								2
							),
						},
					],
					isError: true,
				};
			}
		}
	);

	// Tool 12: Get Component Image (Visual Reference)
	server.tool(
		"figma_get_component_image",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe(
					"Figma file URL (e.g., https://figma.com/design/abc123). REQUIRED unless figma_navigate was already called. If not provided, ask the user to share their Figma file URL (they can copy it from Figma Desktop via right-click → 'Copy link')."
				),
			nodeId: z
				.string()
				.describe("Component node ID to render as image (e.g., '695:313')"),
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
		async ({ fileUrl, nodeId, scale, format }) => {
			try {
				const api = getFigmaAPI();

				const url = fileUrl || getCurrentUrl();
				if (!url) {
					throw new Error(
						"No Figma file URL provided. Either pass fileUrl parameter or call figma_navigate first."
					);
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					throw new Error(`Invalid Figma URL: ${url}`);
				}

				logger.info({ fileKey, nodeId, scale, format }, "Rendering component image");

				// Call the new getImages method
				const result = await api.getImages(fileKey, nodeId, {
					scale,
					format,
					contents_only: true,
				});

				const imageUrl = result.images[nodeId];

				if (!imageUrl) {
					throw new Error(
						`Failed to render image for node ${nodeId}. The node may not exist or may not be renderable.`
					);
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									fileKey,
									nodeId,
									imageUrl,
									scale,
									format,
									expiresIn: "30 days",
									note: "Use this image as visual reference for component development. Image URLs expire after 30 days.",
								},
								null,
								2
							),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "Failed to render component image");
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: errorMessage,
									message: "Failed to render component image",
									hint: "Make sure the node ID is correct and the component is renderable",
								},
								null,
								2
							),
						},
					],
					isError: true,
				};
			}
		}
	);

	// Tool 13: Get Component for Development (UI Implementation)
	server.tool(
		"figma_get_component_for_development",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe(
					"Figma file URL (e.g., https://figma.com/design/abc123). REQUIRED unless figma_navigate was already called."
				),
			nodeId: z
				.string()
				.describe("Component node ID to get data for (e.g., '695:313')"),
			includeImage: z
				.boolean()
				.optional()
				.default(true)
				.describe("Include rendered image for visual reference (default: true)"),
		},
		async ({ fileUrl, nodeId, includeImage }) => {
			try {
				const api = getFigmaAPI();

				const url = fileUrl || getCurrentUrl();
				if (!url) {
					throw new Error(
						"No Figma file URL provided. Either pass fileUrl parameter or call figma_navigate first."
					);
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					throw new Error(`Invalid Figma URL: ${url}`);
				}

				logger.info({ fileKey, nodeId, includeImage }, "Fetching component for development");

				// Get node data with depth for children
				const nodeData = await api.getNodes(fileKey, [nodeId], { depth: 2 });
				const node = nodeData.nodes?.[nodeId]?.document;

				if (!node) {
					throw new Error(`Component not found: ${nodeId}`);
				}

				// Filter to visual/layout properties only
				const filterForDevelopment = (n: any): any => {
					if (!n) return n;

					const result: any = {
						id: n.id,
						name: n.name,
						type: n.type,
						description: n.description,
						descriptionMarkdown: n.descriptionMarkdown,
					};

					// Layout & positioning
					if (n.absoluteBoundingBox) result.absoluteBoundingBox = n.absoluteBoundingBox;
					if (n.relativeTransform) result.relativeTransform = n.relativeTransform;
					if (n.size) result.size = n.size;
					if (n.constraints) result.constraints = n.constraints;
					if (n.layoutAlign) result.layoutAlign = n.layoutAlign;
					if (n.layoutGrow) result.layoutGrow = n.layoutGrow;
					if (n.layoutPositioning) result.layoutPositioning = n.layoutPositioning;

					// Auto-layout
					if (n.layoutMode) result.layoutMode = n.layoutMode;
					if (n.primaryAxisSizingMode) result.primaryAxisSizingMode = n.primaryAxisSizingMode;
					if (n.counterAxisSizingMode) result.counterAxisSizingMode = n.counterAxisSizingMode;
					if (n.primaryAxisAlignItems) result.primaryAxisAlignItems = n.primaryAxisAlignItems;
					if (n.counterAxisAlignItems) result.counterAxisAlignItems = n.counterAxisAlignItems;
					if (n.paddingLeft !== undefined) result.paddingLeft = n.paddingLeft;
					if (n.paddingRight !== undefined) result.paddingRight = n.paddingRight;
					if (n.paddingTop !== undefined) result.paddingTop = n.paddingTop;
					if (n.paddingBottom !== undefined) result.paddingBottom = n.paddingBottom;
					if (n.itemSpacing !== undefined) result.itemSpacing = n.itemSpacing;
					if (n.itemReverseZIndex) result.itemReverseZIndex = n.itemReverseZIndex;
					if (n.strokesIncludedInLayout) result.strokesIncludedInLayout = n.strokesIncludedInLayout;

					// Visual properties
					if (n.fills) result.fills = n.fills;
					if (n.strokes) result.strokes = n.strokes;
					if (n.strokeWeight !== undefined) result.strokeWeight = n.strokeWeight;
					if (n.strokeAlign) result.strokeAlign = n.strokeAlign;
					if (n.strokeCap) result.strokeCap = n.strokeCap;
					if (n.strokeJoin) result.strokeJoin = n.strokeJoin;
					if (n.dashPattern) result.dashPattern = n.dashPattern;
					if (n.cornerRadius !== undefined) result.cornerRadius = n.cornerRadius;
					if (n.rectangleCornerRadii) result.rectangleCornerRadii = n.rectangleCornerRadii;
					if (n.effects) result.effects = n.effects;
					if (n.opacity !== undefined) result.opacity = n.opacity;
					if (n.blendMode) result.blendMode = n.blendMode;
					if (n.isMask) result.isMask = n.isMask;
					if (n.clipsContent) result.clipsContent = n.clipsContent;

					// Typography
					if (n.characters) result.characters = n.characters;
					if (n.style) result.style = n.style;
					if (n.characterStyleOverrides) result.characterStyleOverrides = n.characterStyleOverrides;
					if (n.styleOverrideTable) result.styleOverrideTable = n.styleOverrideTable;

					// Component properties & variants
					if (n.componentProperties) result.componentProperties = n.componentProperties;
					if (n.componentPropertyDefinitions) result.componentPropertyDefinitions = n.componentPropertyDefinitions;
					if (n.variantProperties) result.variantProperties = n.variantProperties;
					if (n.componentId) result.componentId = n.componentId;

					// State
					if (n.visible !== undefined) result.visible = n.visible;
					if (n.locked) result.locked = n.locked;

					// Recursively process children
					if (n.children) {
						result.children = n.children.map((child: any) => filterForDevelopment(child));
					}

					return result;
				};

				const componentData = filterForDevelopment(node);

				// Get image if requested
				let imageUrl = null;
				if (includeImage) {
					try {
						const imageResult = await api.getImages(fileKey, nodeId, {
							scale: 2,
							format: "png",
							contents_only: true,
						});
						imageUrl = imageResult.images[nodeId];
					} catch (error) {
						logger.warn({ error }, "Failed to render component image, continuing without it");
					}
				}

				// Build response with component data and image URL
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									fileKey,
									nodeId,
									imageUrl,
									component: componentData,
									metadata: {
										purpose: "component_development",
										note: imageUrl
											? "Image URL provided above (valid for 30 days). Full component data optimized for UI implementation."
											: "Full component data optimized for UI implementation.",
									},
								},
								null,
								2
							),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "Failed to get component for development");
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: errorMessage,
									message: "Failed to retrieve component development data",
								},
								null,
								2
							),
						},
					],
					isError: true,
				};
			}
		}
	);

	// Tool 14: Get File for Plugin Development
	server.tool(
		"figma_get_file_for_plugin",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe(
					"Figma file URL (e.g., https://figma.com/design/abc123). REQUIRED unless figma_navigate was already called."
				),
			depth: z
				.number()
				.min(0)
				.max(5)
				.optional()
				.default(2)
				.describe(
					"How many levels of children to include (default: 2, max: 5). Higher depths are safe here due to filtering."
				),
			nodeIds: z
				.array(z.string())
				.optional()
				.describe("Specific node IDs to retrieve (optional)"),
		},
		async ({ fileUrl, depth, nodeIds }) => {
			try {
				const api = getFigmaAPI();

				const url = fileUrl || getCurrentUrl();
				if (!url) {
					throw new Error(
						"No Figma file URL provided. Either pass fileUrl parameter or call figma_navigate first."
					);
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					throw new Error(`Invalid Figma URL: ${url}`);
				}

				logger.info({ fileKey, depth, nodeIds }, "Fetching file data for plugin development");

				const fileData = await api.getFile(fileKey, {
					depth,
					ids: nodeIds,
				});

				// Filter to plugin-relevant properties only
				const filterForPlugin = (node: any): any => {
					if (!node) return node;

					const result: any = {
						id: node.id,
						name: node.name,
						type: node.type,
						description: node.description,
						descriptionMarkdown: node.descriptionMarkdown,
					};

					// Navigation & structure
					if (node.visible !== undefined) result.visible = node.visible;
					if (node.locked) result.locked = node.locked;
					if (node.removed) result.removed = node.removed;

					// Lightweight bounds (just position/size)
					if (node.absoluteBoundingBox) {
						result.bounds = {
							x: node.absoluteBoundingBox.x,
							y: node.absoluteBoundingBox.y,
							width: node.absoluteBoundingBox.width,
							height: node.absoluteBoundingBox.height,
						};
					}

					// Plugin data (CRITICAL for plugins)
					if (node.pluginData) result.pluginData = node.pluginData;
					if (node.sharedPluginData) result.sharedPluginData = node.sharedPluginData;

					// Component relationships (important for plugins)
					if (node.componentId) result.componentId = node.componentId;
					if (node.mainComponent) result.mainComponent = node.mainComponent;
					if (node.componentPropertyReferences) result.componentPropertyReferences = node.componentPropertyReferences;
					if (node.instanceOf) result.instanceOf = node.instanceOf;
					if (node.exposedInstances) result.exposedInstances = node.exposedInstances;

					// Component properties (for manipulation)
					if (node.componentProperties) result.componentProperties = node.componentProperties;

					// Characters for text nodes (plugins often need this)
					if (node.characters !== undefined) result.characters = node.characters;

					// Recursively process children
					if (node.children) {
						result.children = node.children.map((child: any) => filterForPlugin(child));
					}

					return result;
				};

				const filteredDocument = filterForPlugin(fileData.document);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									fileKey,
									name: fileData.name,
									lastModified: fileData.lastModified,
									version: fileData.version,
									document: filteredDocument,
									components: fileData.components
										? Object.keys(fileData.components).length
										: 0,
									styles: fileData.styles
										? Object.keys(fileData.styles).length
										: 0,
									...(nodeIds && {
										requestedNodes: nodeIds,
										nodes: fileData.nodes,
									}),
									metadata: {
										purpose: "plugin_development",
										note: "Optimized for plugin development. Contains IDs, structure, plugin data, and component relationships.",
									},
								},
								null,
								2
							),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "Failed to get file for plugin");
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: errorMessage,
									message: "Failed to retrieve file data for plugin development",
								},
								null,
								2
							),
						},
					],
					isError: true,
				};
			}
		}
	);
}
