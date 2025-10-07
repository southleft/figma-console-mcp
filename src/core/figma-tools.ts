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

/**
 * Register Figma API tools with the MCP server
 */
export function registerFigmaAPITools(
	server: McpServer,
	getFigmaAPI: () => FigmaAPI,
	getCurrentUrl: () => string | null,
	getConsoleMonitor?: () => ConsoleMonitor | null,
	getBrowserManager?: () => any
) {
	// Tool 8: Get File Data
	server.tool(
		"figma_get_file_data",
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
				.optional()
				.describe(
					"How many levels of children to include (default: 1, use 0 for full tree)"
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
		async ({ fileUrl, depth, nodeIds, enrich }) => {
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

				logger.info({ fileKey, depth, nodeIds, enrich }, "Fetching file data");

				const fileData = await api.getFile(fileKey, {
					depth,
					ids: nodeIds,
				});

				let response: any = {
					fileKey,
					name: fileData.name,
					lastModified: fileData.lastModified,
					version: fileData.version,
					document: fileData.document,
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
		async ({ fileUrl, includePublished, enrich, include_usage, include_dependencies, include_exports, export_formats, useConsoleFallback, parseFromConsole }) => {
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
				// BEST: Try Desktop connection first (like official Figma MCP does)
				const browserManager = getBrowserManager?.();
				if (browserManager && !parseFromConsole) {
					try {
						logger.info({ fileKey }, "Attempting to get variables via Desktop connection");

						// Import and use the Desktop connector
						const { FigmaDesktopConnector } = await import('./figma-desktop-connector.js');
						const page = await browserManager.getPage();
						const connector = new FigmaDesktopConnector(page);

						await connector.initialize();
						const desktopResult = await connector.getVariables(fileKey);

						if (desktopResult.success && desktopResult.variables) {
							logger.info(
								{
									variableCount: desktopResult.variables.length,
									collectionCount: desktopResult.variableCollections?.length
								},
								"Successfully retrieved variables via Desktop connection!"
							);

							// Enrich if requested
							let enrichedData = null;
							if (enrich && enrichmentService) {
								enrichedData = await enrichmentService.enrichVariables(
									desktopResult.variables,
									desktopResult.variableCollections,
									{
										include_usage: include_usage,
										include_dependencies: include_dependencies,
										include_exports: include_exports,
										export_formats: export_formats
									}
								);
							}

							return {
								content: [
									{
										type: "text",
										text: JSON.stringify(
											{
												fileKey,
												source: "desktop_connection",
												local: enrichedData || {
													summary: {
														total_variables: desktopResult.variables.length,
														total_collections: desktopResult.variableCollections?.length,
													},
													collections: desktopResult.variableCollections,
													variables: desktopResult.variables,
												},
												timestamp: desktopResult.timestamp,
												enriched: !!enrichedData,
											},
											null,
											2
										),
									},
								],
							};
						}
					} catch (desktopError) {
						logger.warn({ error: desktopError }, "Desktop connection failed, falling back to other methods");
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
				logger.info({ fileKey, includePublished, enrich }, "Fetching variables via REST API");
				const api = getFigmaAPI();

				const { local, published } = await api.getAllVariables(fileKey);

				let localFormatted = formatVariables(local);
				let publishedFormatted = includePublished
					? formatVariables(published)
					: null;

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
									enriched: enrich || false,
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
		async ({ fileUrl, enrich, include_usage, include_exports, export_formats }) => {
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

				logger.info({ fileKey, enrich }, "Fetching styles");

				const stylesData = await api.getStyles(fileKey);
				let styles = stylesData.meta?.styles || [];

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
}
