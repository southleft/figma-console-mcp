/**
 * Design System Kit Tool
 * MCP tool that orchestrates existing Figma API tools to produce a structured
 * design system specification — tokens, components, styles — in a single call.
 *
 * This enables AI code generation tools (Figma Make, v0, Cursor, Claude, etc.)
 * to generate code with structural fidelity to the real design system.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FigmaAPI } from "./figma-api.js";
import { extractFileKey, formatVariables, formatComponentData } from "./figma-api.js";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "design-system-tools" });

// ============================================================================
// Types
// ============================================================================

interface TokenCollection {
	id: string;
	name: string;
	modes: Array<{ modeId: string; name: string }>;
	variables: Array<{
		id: string;
		name: string;
		type: string;
		description?: string;
		valuesByMode: Record<string, any>;
		scopes?: string[];
	}>;
}

interface ComponentSpec {
	id: string;
	name: string;
	description?: string;
	properties?: Record<string, any>;
	variants?: Array<{ name: string; id: string }>;
	bounds?: { width: number; height: number };
	imageUrl?: string;
}

interface StyleSpec {
	key: string;
	name: string;
	styleType: string;
	description?: string;
	nodeId?: string;
}

interface DesignSystemKit {
	fileKey: string;
	fileName?: string;
	generatedAt: string;
	format: string;
	tokens?: {
		collections: TokenCollection[];
		summary: {
			totalCollections: number;
			totalVariables: number;
			variablesByType: Record<string, number>;
		};
	};
	components?: {
		items: ComponentSpec[];
		summary: {
			totalComponents: number;
			totalComponentSets: number;
		};
	};
	styles?: {
		items: StyleSpec[];
		summary: {
			totalStyles: number;
			stylesByType: Record<string, number>;
		};
	};
	errors?: Array<{ section: string; message: string }>;
	ai_instruction: string;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Calculate JSON size in KB for response management
 */
function calculateSizeKB(data: any): number {
	return JSON.stringify(data).length / 1024;
}

/**
 * Group variables by collection for a clean hierarchical output
 */
function groupVariablesByCollection(formatted: {
	collections: any[];
	variables: any[];
}): TokenCollection[] {
	return formatted.collections.map((collection) => {
		const collectionVars = formatted.variables
			.filter((v) => v.variableCollectionId === collection.id)
			.map((v) => ({
				id: v.id,
				name: v.name,
				type: v.resolvedType,
				description: v.description || undefined,
				valuesByMode: v.valuesByMode,
				scopes: v.scopes,
			}));

		return {
			id: collection.id,
			name: collection.name,
			modes: collection.modes,
			variables: collectionVars,
		};
	});
}

/**
 * Deduplicate components — filter out individual variants when their
 * parent component set is already present.
 */
function deduplicateComponents(
	components: any[],
	componentSets: any[]
): { components: any[]; componentSets: any[] } {
	const setNodeIds = new Set(componentSets.map((s: any) => s.node_id));

	// Filter out variants that belong to a known component set
	const standalone = components.filter((c: any) => {
		if (c.containing_frame?.containingComponentSet) {
			// This is a variant — check if parent set is already included
			const parentNodeId = c.containing_frame?.nodeId;
			if (parentNodeId && setNodeIds.has(parentNodeId)) {
				return false; // Skip, parent set covers it
			}
		}
		return true;
	});

	return { components: standalone, componentSets };
}

/**
 * Compress the kit for large responses
 */
function compressKit(kit: DesignSystemKit, level: "summary" | "inventory"): DesignSystemKit {
	const compressed = { ...kit };

	if (compressed.tokens) {
		if (level === "inventory") {
			// Only keep variable names and types, drop values
			compressed.tokens = {
				...compressed.tokens,
				collections: compressed.tokens.collections.map((c) => ({
					...c,
					variables: c.variables.map((v) => ({
						id: v.id,
						name: v.name,
						type: v.type,
						description: v.description,
						valuesByMode: {}, // Strip values
						scopes: v.scopes,
					})),
				})),
			};
		}
	}

	if (compressed.components) {
		if (level === "inventory") {
			// Only keep names and property keys
			compressed.components = {
				...compressed.components,
				items: compressed.components.items.map((c) => ({
					id: c.id,
					name: c.name,
					description: c.description,
					properties: c.properties
						? Object.fromEntries(
								Object.entries(c.properties).map(([k, v]: [string, any]) => [
									k,
									{ type: v.type, defaultValue: v.defaultValue },
								])
						  )
						: undefined,
				})),
			};
		}
		// Drop image URLs at any compression level to save tokens
		compressed.components.items = compressed.components.items.map((c) => {
			const { imageUrl, ...rest } = c;
			return rest;
		});
	}

	return compressed;
}

// ============================================================================
// Tool Registration
// ============================================================================

export function registerDesignSystemTools(
	server: McpServer,
	getFigmaAPI: () => Promise<FigmaAPI>,
	getCurrentUrl: () => string | null,
	variablesCache?: Map<string, { data: any; timestamp: number }>,
	options?: { isRemoteMode?: boolean },
): void {
	server.tool(
		"figma_get_design_system_kit",
		"Get a complete design system specification (tokens, components, styles) from a Figma file in a single call. " +
		"Ideal for AI code generation tools that need structured design system data to produce code with accurate " +
		"component APIs, token values, and style references. Returns hierarchical token collections with modes, " +
		"component specs with property definitions and variants, and published styles.",
		{
			fileKey: z
				.string()
				.optional()
				.describe(
					"Figma file key. If omitted, extracted from the current browser URL."
				),
			include: z
				.array(z.enum(["tokens", "components", "styles"]))
				.optional()
				.default(["tokens", "components", "styles"])
				.describe("Which sections to include. Defaults to all."),
			componentIds: z
				.array(z.string())
				.optional()
				.describe(
					"Optional list of specific component node IDs to include. If omitted, all published components are returned."
				),
			includeImages: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					"Include image URLs for components (adds latency). Default false."
				),
			format: z
				.enum(["full", "summary"])
				.optional()
				.default("full")
				.describe(
					"'full' returns complete data. 'summary' returns names/types/keys without values (smaller payload)."
				),
		},
		async ({ fileKey, include, componentIds, includeImages, format }) => {
			try {
				const api = await getFigmaAPI();

				// Resolve file key
				let resolvedFileKey = fileKey;
				if (!resolvedFileKey) {
					const currentUrl = getCurrentUrl();
					if (currentUrl) {
						resolvedFileKey = extractFileKey(currentUrl) || undefined;
					}
				}

				if (!resolvedFileKey) {
					throw new Error(
						"No file key provided and no Figma file currently open. " +
						"Provide a fileKey parameter or navigate to a Figma file first."
					);
				}

				const errors: Array<{ section: string; message: string }> = [];
				const kit: DesignSystemKit = {
					fileKey: resolvedFileKey,
					generatedAt: new Date().toISOString(),
					format,
					ai_instruction: "",
				};

				// ----------------------------------------------------------------
				// Fetch tokens (variables)
				// ----------------------------------------------------------------
				if (include.includes("tokens")) {
					try {
						logger.info({ fileKey: resolvedFileKey }, "Fetching design tokens");

						// Check cache first
						let variablesData: any = null;
						const cacheKey = `vars:${resolvedFileKey}`;

						if (variablesCache) {
							const cached = variablesCache.get(cacheKey);
							if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
								variablesData = cached.data;
								logger.info("Using cached variables data");
							}
						}

						if (!variablesData) {
							variablesData = await api.getLocalVariables(resolvedFileKey);
							if (variablesCache) {
								variablesCache.set(cacheKey, {
									data: variablesData,
									timestamp: Date.now(),
								});
							}
						}

						const formatted = formatVariables(variablesData);
						const collections = groupVariablesByCollection(formatted);

						kit.tokens = {
							collections,
							summary: formatted.summary,
						};
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						logger.warn({ error: msg }, "Failed to fetch tokens");
						errors.push({ section: "tokens", message: msg });
					}
				}

				// ----------------------------------------------------------------
				// Fetch components
				// ----------------------------------------------------------------
				if (include.includes("components")) {
					try {
						logger.info({ fileKey: resolvedFileKey }, "Fetching components");

						const [componentsResponse, componentSetsResponse] = await Promise.all([
							api.getComponents(resolvedFileKey),
							api.getComponentSets(resolvedFileKey),
						]);

						const allComponents = componentsResponse?.meta?.components || [];
						const allComponentSets = componentSetsResponse?.meta?.component_sets || [];

						const { components: standaloneComponents, componentSets } =
							deduplicateComponents(allComponents, allComponentSets);

						// Filter by component IDs if provided
						let targetComponents = standaloneComponents;
						let targetSets = componentSets;

						if (componentIds && componentIds.length > 0) {
							const idSet = new Set(componentIds);
							targetComponents = standaloneComponents.filter(
								(c: any) => idSet.has(c.node_id)
							);
							targetSets = componentSets.filter(
								(s: any) => idSet.has(s.node_id)
							);
						}

						// Build component specs
						const componentSpecs: ComponentSpec[] = [];

						// Process component sets (multi-variant components)
						for (const set of targetSets) {
							const spec: ComponentSpec = {
								id: set.node_id,
								name: set.name,
								description: set.description || undefined,
							};

							// Get variant info from the child components
							const variants = allComponents
								.filter((c: any) => c.component_set_id === set.node_id || c.containing_frame?.nodeId === set.node_id)
								.map((c: any) => ({ name: c.name, id: c.node_id }));

							if (variants.length > 0) {
								spec.variants = variants;
							}

							// Fetch property definitions from the set node
							try {
								const nodeResponse = await api.getNodes(
									resolvedFileKey,
									[set.node_id],
									{ depth: 1 }
								);
								const setNode = nodeResponse?.nodes?.[set.node_id]?.document;
								if (setNode?.componentPropertyDefinitions) {
									spec.properties = setNode.componentPropertyDefinitions;
								}
								if (setNode?.absoluteBoundingBox) {
									spec.bounds = {
										width: setNode.absoluteBoundingBox.width,
										height: setNode.absoluteBoundingBox.height,
									};
								}
							} catch (err) {
								logger.warn(
									{ componentSet: set.name, error: err },
									"Failed to fetch component set node details"
								);
							}

							componentSpecs.push(spec);
						}

						// Process standalone components (not part of a set)
						for (const comp of targetComponents) {
							const spec: ComponentSpec = {
								id: comp.node_id,
								name: comp.name,
								description: comp.description || undefined,
							};

							// Standalone components may have their own property definitions
							try {
								const nodeResponse = await api.getNodes(
									resolvedFileKey,
									[comp.node_id],
									{ depth: 1 }
								);
								const node = nodeResponse?.nodes?.[comp.node_id]?.document;
								if (node?.componentPropertyDefinitions) {
									spec.properties = node.componentPropertyDefinitions;
								}
								if (node?.absoluteBoundingBox) {
									spec.bounds = {
										width: node.absoluteBoundingBox.width,
										height: node.absoluteBoundingBox.height,
									};
								}
							} catch (err) {
								logger.warn(
									{ component: comp.name, error: err },
									"Failed to fetch component node details"
								);
							}

							componentSpecs.push(spec);
						}

						// Optionally fetch component images
						if (includeImages && componentSpecs.length > 0) {
							try {
								const nodeIds = componentSpecs.map((c) => c.id);
								// Batch in groups of 50 to stay within API limits
								const batchSize = 50;
								for (let i = 0; i < nodeIds.length; i += batchSize) {
									const batch = nodeIds.slice(i, i + batchSize);
									const imagesResult = await api.getImages(
										resolvedFileKey,
										batch,
										{ scale: 2, format: "png" }
									);
									if (imagesResult?.images) {
										for (const spec of componentSpecs) {
											const url = imagesResult.images[spec.id];
											if (url) {
												spec.imageUrl = url;
											}
										}
									}
								}
							} catch (err) {
								const msg = err instanceof Error ? err.message : String(err);
								logger.warn({ error: msg }, "Failed to fetch component images");
								errors.push({ section: "component_images", message: msg });
							}
						}

						kit.components = {
							items: componentSpecs,
							summary: {
								totalComponents: componentSpecs.length,
								totalComponentSets: targetSets.length,
							},
						};
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						logger.warn({ error: msg }, "Failed to fetch components");
						errors.push({ section: "components", message: msg });
					}
				}

				// ----------------------------------------------------------------
				// Fetch styles
				// ----------------------------------------------------------------
				if (include.includes("styles")) {
					try {
						logger.info({ fileKey: resolvedFileKey }, "Fetching styles");

						const stylesResponse = await api.getStyles(resolvedFileKey);
						const allStyles = stylesResponse?.meta?.styles || [];

						const styleSpecs: StyleSpec[] = allStyles.map((s: any) => ({
							key: s.key,
							name: s.name,
							styleType: s.style_type,
							description: s.description || undefined,
							nodeId: s.node_id,
						}));

						const stylesByType: Record<string, number> = {};
						for (const s of styleSpecs) {
							stylesByType[s.styleType] = (stylesByType[s.styleType] || 0) + 1;
						}

						kit.styles = {
							items: styleSpecs,
							summary: {
								totalStyles: styleSpecs.length,
								stylesByType,
							},
						};
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						logger.warn({ error: msg }, "Failed to fetch styles");
						errors.push({ section: "styles", message: msg });
					}
				}

				// ----------------------------------------------------------------
				// Build AI instruction
				// ----------------------------------------------------------------
				if (errors.length > 0) {
					kit.errors = errors;
				}

				const sections = [];
				if (kit.tokens) sections.push(`${kit.tokens.summary.totalVariables} tokens in ${kit.tokens.summary.totalCollections} collections`);
				if (kit.components) sections.push(`${kit.components.summary.totalComponents} components (${kit.components.summary.totalComponentSets} sets)`);
				if (kit.styles) sections.push(`${kit.styles.summary.totalStyles} styles`);

				kit.ai_instruction =
					"This is a structured design system specification. Use these exact token names, " +
					"component property definitions, and style references when generating code. " +
					"Component 'properties' define the props/API the component accepts — generate " +
					"components with matching prop interfaces. Token 'valuesByMode' contains values " +
					"per mode (e.g., light/dark) — use CSS custom properties or theme objects to " +
					"support all modes. " +
					`Summary: ${sections.join(", ")}.`;

				// ----------------------------------------------------------------
				// Adaptive compression for large responses
				// ----------------------------------------------------------------
				const sizeKB = calculateSizeKB(kit);

				if (format === "summary" || sizeKB > 500) {
					const level = sizeKB > 1000 ? "inventory" : "summary";
					const compressed = compressKit(kit, level);

					if (sizeKB > 500) {
						compressed.ai_instruction =
							`Response auto-compressed from ${sizeKB.toFixed(0)}KB. ` +
							compressed.ai_instruction +
							" For full token values, re-call with include=['tokens'] and specific componentIds.";
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(compressed),
							},
						],
					};
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(kit),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "Failed to generate design system kit");
				const errorMessage =
					error instanceof Error ? error.message : String(error);

				// Check if it's an auth error
				let parsedError: any = null;
				try {
					parsedError = JSON.parse(errorMessage);
				} catch {
					// Not a JSON error
				}

				if (parsedError?.error === "authentication_required" || parsedError?.error === "oauth_error") {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(parsedError),
							},
						],
						isError: true,
					};
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: errorMessage,
								message: "Failed to generate design system kit",
								hint: "Ensure you have a valid Figma file key and the file contains published components/variables.",
							}),
						},
					],
					isError: true,
				};
			}
		}
	);
}
