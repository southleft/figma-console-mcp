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
	getConsoleMonitor?: () => ConsoleMonitor | null
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

	// Tool 9: Get Variables (Design Tokens)
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
				.describe("If REST API fails with 403 (Enterprise required), provide console snippet for manual variable extraction. Default: true"),
			parseFromConsole: z
				.boolean()
				.optional()
				.default(false)
				.describe("Parse variables from recent console logs (after running the snippet). Use this after executing the console snippet."),
		},
		async ({ fileUrl, includePublished, enrich, include_usage, include_dependencies, include_exports, export_formats, useConsoleFallback, parseFromConsole }) => {
			try {
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

				// NEW: Parse from console logs if requested
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
							"Please run the snippet first:\n" +
							"1. Call figma_get_variables({ useConsoleFallback: true }) to get the snippet\n" +
							"2. Paste and run it in Figma's console\n" +
							"3. Then call figma_get_variables({ parseFromConsole: true })"
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

				// NEW: Handle 403 with console fallback snippet
				if (errorMessage.includes("403") && useConsoleFallback) {
					const snippet = snippetInjector.generateVariablesSnippet();

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										error: "Variables API requires Enterprise plan with file_variables:read scope",
										fallback_available: true,
										method: "console_capture",
										instructions: [
											"The Figma Variables API requires an Enterprise plan.",
											"However, you can extract variables using console logs:",
											"",
											"Step 1: Open Figma and navigate to your file",
											"Step 2: Open DevTools Console (Right-click → Inspect → Console tab)",
											"Step 3: Paste and run the snippet below",
											"Step 4: Call: figma_get_variables({ parseFromConsole: true })",
										],
										snippet: snippet,
										note: "This snippet is safe - it only reads variables using Figma's Plugin API and logs them to the console.",
									},
									null,
									2
								),
							},
						],
					};
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
