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

interface VisualSpec {
	fills?: Array<{ type: string; color?: string; opacity?: number }>;
	strokes?: Array<{ type: string; color?: string; weight?: number; align?: string }>;
	effects?: Array<{ type: string; color?: string; offset?: { x: number; y: number }; radius?: number; spread?: number }>;
	cornerRadius?: number;
	rectangleCornerRadii?: number[];
	opacity?: number;
	layout?: {
		mode?: string; // HORIZONTAL | VERTICAL
		paddingTop?: number;
		paddingRight?: number;
		paddingBottom?: number;
		paddingLeft?: number;
		itemSpacing?: number;
		primaryAxisAlign?: string;
		counterAxisAlign?: string;
	};
	typography?: {
		fontFamily?: string;
		fontSize?: number;
		fontWeight?: number;
		lineHeight?: any;
		letterSpacing?: any;
		textAlignHorizontal?: string;
	};
}

interface ComponentSpec {
	id: string;
	name: string;
	description?: string;
	properties?: Record<string, any>;
	variants?: Array<{ name: string; id: string; visualSpec?: VisualSpec }>;
	bounds?: { width: number; height: number };
	imageUrl?: string;
	visualSpec?: VisualSpec;
}

interface StyleSpec {
	key: string;
	name: string;
	styleType: string;
	description?: string;
	nodeId?: string;
	resolvedValue?: any;
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
 * Wrap a promise with a timeout to prevent indefinite hangs
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
		),
	]);
}

/**
 * Convert Figma RGBA (0-1 range) to hex string
 */
function rgbaToHex(color: { r: number; g: number; b: number; a?: number }): string {
	const r = Math.round(color.r * 255);
	const g = Math.round(color.g * 255);
	const b = Math.round(color.b * 255);
	const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
	return hex.toUpperCase();
}

/**
 * Extract a compact visual specification from a Figma node.
 * Captures the essential CSS-equivalent properties an AI needs to reproduce the component.
 */
function extractVisualSpec(node: any): VisualSpec | undefined {
	if (!node) return undefined;

	const spec: VisualSpec = {};
	let hasData = false;

	// Fills → background colors/gradients
	if (node.fills && Array.isArray(node.fills) && node.fills.length > 0) {
		spec.fills = node.fills
			.filter((f: any) => f.visible !== false)
			.map((f: any) => {
				const fill: any = { type: f.type };
				if (f.color) fill.color = rgbaToHex(f.color);
				if (f.opacity !== undefined) fill.opacity = f.opacity;
				return fill;
			});
		if (spec.fills!.length > 0) hasData = true;
	}

	// Strokes → borders
	if (node.strokes && Array.isArray(node.strokes) && node.strokes.length > 0) {
		spec.strokes = node.strokes
			.filter((s: any) => s.visible !== false)
			.map((s: any) => {
				const stroke: any = { type: s.type };
				if (s.color) stroke.color = rgbaToHex(s.color);
				return stroke;
			});
		if (node.strokeWeight !== undefined) spec.strokes!.forEach((s: any) => s.weight = node.strokeWeight);
		if (node.strokeAlign) spec.strokes!.forEach((s: any) => s.align = node.strokeAlign);
		if (spec.strokes!.length > 0) hasData = true;
	}

	// Effects → shadows, blurs
	if (node.effects && Array.isArray(node.effects) && node.effects.length > 0) {
		spec.effects = node.effects
			.filter((e: any) => e.visible !== false)
			.map((e: any) => {
				const effect: any = { type: e.type };
				if (e.color) effect.color = rgbaToHex(e.color);
				if (e.offset) effect.offset = e.offset;
				if (e.radius !== undefined) effect.radius = e.radius;
				if (e.spread !== undefined) effect.spread = e.spread;
				return effect;
			});
		if (spec.effects!.length > 0) hasData = true;
	}

	// Corner radius
	if (node.cornerRadius !== undefined && node.cornerRadius > 0) {
		spec.cornerRadius = node.cornerRadius;
		hasData = true;
	}
	if (node.rectangleCornerRadii) {
		spec.rectangleCornerRadii = node.rectangleCornerRadii;
		hasData = true;
	}

	// Opacity
	if (node.opacity !== undefined && node.opacity < 1) {
		spec.opacity = node.opacity;
		hasData = true;
	}

	// Auto-layout → CSS flex equivalent
	if (node.layoutMode && node.layoutMode !== "NONE") {
		spec.layout = {
			mode: node.layoutMode,
		};
		if (node.paddingTop !== undefined) spec.layout.paddingTop = node.paddingTop;
		if (node.paddingRight !== undefined) spec.layout.paddingRight = node.paddingRight;
		if (node.paddingBottom !== undefined) spec.layout.paddingBottom = node.paddingBottom;
		if (node.paddingLeft !== undefined) spec.layout.paddingLeft = node.paddingLeft;
		if (node.itemSpacing !== undefined) spec.layout.itemSpacing = node.itemSpacing;
		if (node.primaryAxisAlignItems) spec.layout.primaryAxisAlign = node.primaryAxisAlignItems;
		if (node.counterAxisAlignItems) spec.layout.counterAxisAlign = node.counterAxisAlignItems;
		hasData = true;
	}

	// Typography (for TEXT nodes)
	if (node.type === "TEXT" && node.style) {
		spec.typography = {};
		const s = node.style;
		if (s.fontFamily) spec.typography.fontFamily = s.fontFamily;
		if (s.fontSize) spec.typography.fontSize = s.fontSize;
		if (s.fontWeight) spec.typography.fontWeight = s.fontWeight;
		if (s.lineHeightPx) spec.typography.lineHeight = s.lineHeightPx;
		if (s.letterSpacing) spec.typography.letterSpacing = s.letterSpacing;
		if (s.textAlignHorizontal) spec.typography.textAlignHorizontal = s.textAlignHorizontal;
		hasData = true;
	}

	return hasData ? spec : undefined;
}

/**
 * Extract visual specs from a component node and its first-level children.
 * Returns a compact representation of the component's visual appearance.
 */
function extractComponentVisualData(node: any): {
	visualSpec?: VisualSpec;
	childSpecs?: Array<{ name: string; type: string; visualSpec?: VisualSpec; characters?: string }>;
} {
	if (!node) return {};

	const result: any = {};

	const rootSpec = extractVisualSpec(node);
	if (rootSpec) result.visualSpec = rootSpec;

	// Extract first-level children specs (the structural elements)
	if (node.children && Array.isArray(node.children)) {
		const childSpecs: any[] = [];
		for (const child of node.children) {
			const childInfo: any = {
				name: child.name,
				type: child.type,
			};
			const childVisual = extractVisualSpec(child);
			if (childVisual) childInfo.visualSpec = childVisual;
			if (child.characters) childInfo.characters = child.characters;
			childSpecs.push(childInfo);
		}
		if (childSpecs.length > 0) result.childSpecs = childSpecs;
	}

	return result;
}

/**
 * Resolve style node IDs to their actual visual values.
 * Styles only contain metadata from the styles endpoint — we need getNodes to get actual colors/fonts/effects.
 */
async function resolveStyleValues(
	api: FigmaAPI,
	fileKey: string,
	styles: StyleSpec[],
): Promise<Map<string, any>> {
	const resolved = new Map<string, any>();
	const nodeIds = styles.filter((s) => s.nodeId).map((s) => s.nodeId as string);

	if (nodeIds.length === 0) return resolved;

	try {
		const batchSize = 50;
		for (let i = 0; i < nodeIds.length; i += batchSize) {
			const batch = nodeIds.slice(i, i + batchSize);
			const nodeResponse = await withTimeout(
				api.getNodes(fileKey, batch),
				30000,
				`getStyleNodes(batch ${Math.floor(i / batchSize) + 1})`,
			);
			if (nodeResponse?.nodes) {
				for (const [nodeId, nodeData] of Object.entries(nodeResponse.nodes)) {
					const doc = (nodeData as any)?.document;
					if (!doc) continue;

					const value: any = {};

					// FILL styles → extract colors
					if (doc.fills && Array.isArray(doc.fills)) {
						value.fills = doc.fills
							.filter((f: any) => f.visible !== false)
							.map((f: any) => ({
								type: f.type,
								color: f.color ? rgbaToHex(f.color) : undefined,
								opacity: f.opacity,
							}));
					}

					// TEXT styles → extract typography
					if (doc.type === "TEXT" && doc.style) {
						value.typography = {
							fontFamily: doc.style.fontFamily,
							fontSize: doc.style.fontSize,
							fontWeight: doc.style.fontWeight,
							lineHeight: doc.style.lineHeightPx,
							letterSpacing: doc.style.letterSpacing,
						};
					}

					// EFFECT styles → extract shadows/blurs
					if (doc.effects && Array.isArray(doc.effects)) {
						value.effects = doc.effects
							.filter((e: any) => e.visible !== false)
							.map((e: any) => ({
								type: e.type,
								color: e.color ? rgbaToHex(e.color) : undefined,
								offset: e.offset,
								radius: e.radius,
								spread: e.spread,
							}));
					}

					resolved.set(nodeId, value);
				}
			}
		}
	} catch (err) {
		logger.warn({ error: err }, "Failed to resolve style values");
	}

	return resolved;
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
			// Check both direct frame nodeId and the containingComponentSet.nodeId
			// (some designs nest variants inside intermediate frames)
			const frameNodeId = c.containing_frame?.nodeId;
			const setNodeId = c.containing_frame?.containingComponentSet?.nodeId;
			if ((frameNodeId && setNodeIds.has(frameNodeId)) ||
				(setNodeId && setNodeIds.has(setNodeId))) {
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
function compressKit(kit: DesignSystemKit, level: "summary" | "inventory" | "compact"): DesignSystemKit {
	const compressed = { ...kit };

	if (compressed.tokens) {
		if (level === "compact") {
			// Compact: only summary counts, drop all collections/variables
			compressed.tokens = {
				collections: [],
				summary: compressed.tokens.summary,
			};
		} else if (level === "inventory") {
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
		if (level === "compact") {
			// Compact: drastically reduce for large systems
			// Separate component sets (design building blocks) from standalone components
			const sets = compressed.components.items.filter((c) => c.variants && c.variants.length > 0);
			const standalone = compressed.components.items.filter((c) => !c.variants || c.variants.length === 0);

			// Keep all sets (they're the main building blocks), limit standalone to 100
			const limitedStandalone = standalone.slice(0, 100);
			const trimmedItems = [...sets, ...limitedStandalone];

			compressed.components = {
				...compressed.components,
				items: trimmedItems.map((c) => ({
					id: c.id,
					name: c.name,
					// Compact: variant count only (not individual names) for very large sets
					variants: c.variants
						? c.variants.length > 10
							? [{ name: `${c.variants.length} variants`, id: "" }]
							: c.variants.map((v) => ({ name: v.name, id: v.id }))
						: undefined,
					properties: c.properties
						? Object.fromEntries(
								Object.entries(c.properties).map(([k, v]: [string, any]) => [
									k,
									{ type: v.type, defaultValue: v.defaultValue },
								])
						  )
						: undefined,
				})),
				summary: {
					...compressed.components.summary,
					totalComponents: trimmedItems.length,
					...(standalone.length > 100 ? { omittedStandaloneComponents: standalone.length - 100 } as any : {}),
				},
			};
		} else if (level === "inventory") {
			// Only keep names and property keys — strip visual specs and variants
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
		} else if (level === "summary") {
			// Keep visual specs but strip variant-level specs to save space
			compressed.components = {
				...compressed.components,
				items: compressed.components.items.map((c) => ({
					...c,
					variants: c.variants?.map((v) => ({ name: v.name, id: v.id })),
				})),
			};
		}
		// Drop image URLs at any compression level to save tokens
		compressed.components.items = compressed.components.items.map((c) => {
			const { imageUrl, ...rest } = c;
			return rest;
		});
	}

	if (compressed.styles) {
		if (level === "compact") {
			// Compact: only style names and types grouped by type, no resolved values
			compressed.styles = {
				...compressed.styles,
				items: compressed.styles.items.map((s) => ({
					key: s.key,
					name: s.name,
					styleType: s.styleType,
				})),
			};
		} else if (level === "inventory") {
			// Strip resolved values in inventory mode
			compressed.styles = {
				...compressed.styles,
				items: compressed.styles.items.map((s) => ({
					key: s.key,
					name: s.name,
					styleType: s.styleType,
					description: s.description,
				})),
			};
		}
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
		"PREFERRED TOOL for design system extraction — replaces separate figma_get_styles, figma_get_variables, and figma_get_component calls. " +
		"Returns tokens, components, and styles in a single optimized response with adaptive compression for large systems. " +
		"Includes component visual specs (exact colors, padding, typography, layout), rendered screenshots, " +
		"token values per mode (light/dark), and resolved style values. " +
		"Use this instead of calling individual tools to avoid context window overflow. " +
		"Ideal for AI code generation — use visualSpec for pixel-accurate reproduction.",
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
				.enum(["full", "summary", "compact"])
				.optional()
				.default("full")
				.describe(
					"'full' returns complete data with visual specs and resolved values. " +
					"'summary' strips variant-level visual specs (medium payload). " +
					"'compact' returns only names, types, and property definitions (smallest payload, best for large design systems). " +
					"Auto-compresses if response exceeds safe size regardless of format setting."
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
							variablesData = await withTimeout(
								api.getLocalVariables(resolvedFileKey),
								30000,
								"getLocalVariables",
							);
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
							withTimeout(api.getComponents(resolvedFileKey), 30000, "getComponents"),
							withTimeout(api.getComponentSets(resolvedFileKey), 30000, "getComponentSets"),
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

						// Collect all node IDs we need to fetch details for (batched, not N+1)
						const allNodeIds = [
							...targetSets.map((s: any) => s.node_id),
							...targetComponents.map((c: any) => c.node_id),
						];

						// Batch fetch ALL node details in one call (max 50 per batch)
						const nodeDetailsMap: Record<string, any> = {};
						if (allNodeIds.length > 0) {
							try {
								const batchSize = 50;
								for (let i = 0; i < allNodeIds.length; i += batchSize) {
									const batch = allNodeIds.slice(i, i + batchSize);
									const nodeResponse = await withTimeout(
										api.getNodes(resolvedFileKey, batch, { depth: 2 }),
										30000,
										`getNodes(batch ${Math.floor(i / batchSize) + 1})`,
									);
									if (nodeResponse?.nodes) {
										for (const [nodeId, nodeData] of Object.entries(nodeResponse.nodes)) {
											nodeDetailsMap[nodeId] = (nodeData as any)?.document;
										}
									}
								}
							} catch (err) {
								logger.warn({ error: err }, "Failed to batch-fetch component node details");
							}
						}

						// Process component sets (multi-variant components)
						for (const set of targetSets) {
							const spec: ComponentSpec = {
								id: set.node_id,
								name: set.name,
								description: set.description || undefined,
							};

							// Use pre-fetched node details
							const setNode = nodeDetailsMap[set.node_id];

							// Get variant info from the child components
							// Match by component_set_id, containing_frame.nodeId, OR containingComponentSet.nodeId
							// (some designs nest variants inside intermediate frames)
							const variants = allComponents
								.filter((c: any) =>
									c.component_set_id === set.node_id ||
									c.containing_frame?.nodeId === set.node_id ||
									c.containing_frame?.containingComponentSet?.nodeId === set.node_id
								)
								.map((c: any) => {
									const entry: { name: string; id: string; visualSpec?: VisualSpec } = { name: c.name, id: c.node_id };
									// Attach visual spec from depth-2 children of the set node
									if (setNode?.children) {
										const variantNode = setNode.children.find((ch: any) => ch.id === c.node_id);
										if (variantNode) {
											const vs = extractVisualSpec(variantNode);
											if (vs) entry.visualSpec = vs;
										}
									}
									return entry;
								});

							if (variants.length > 0) {
								spec.variants = variants;
							}

							if (setNode?.componentPropertyDefinitions) {
								spec.properties = setNode.componentPropertyDefinitions;
							}
							if (setNode?.absoluteBoundingBox) {
								spec.bounds = {
									width: setNode.absoluteBoundingBox.width,
									height: setNode.absoluteBoundingBox.height,
								};
							}

							// Extract visual spec from the set node (root + children)
							if (setNode) {
								const visualData = extractComponentVisualData(setNode);
								if (visualData.visualSpec) {
									spec.visualSpec = visualData.visualSpec;
								}
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

							// Use pre-fetched node details
							const node = nodeDetailsMap[comp.node_id];
							if (node?.componentPropertyDefinitions) {
								spec.properties = node.componentPropertyDefinitions;
							}
							if (node?.absoluteBoundingBox) {
								spec.bounds = {
									width: node.absoluteBoundingBox.width,
									height: node.absoluteBoundingBox.height,
								};
							}

							// Extract visual spec from the component node (root + children)
							if (node) {
								const visualData = extractComponentVisualData(node);
								if (visualData.visualSpec) {
									spec.visualSpec = visualData.visualSpec;
								}
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
									const imagesResult = await withTimeout(
									api.getImages(resolvedFileKey, batch, { scale: 2, format: "png" }),
									30000,
									"getImages",
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

						const stylesResponse = await withTimeout(
							api.getStyles(resolvedFileKey),
							30000,
							"getStyles",
						);
						const allStyles = stylesResponse?.meta?.styles || [];

						const styleSpecs: StyleSpec[] = allStyles.map((s: any) => ({
							key: s.key,
							name: s.name,
							styleType: s.style_type,
							description: s.description || undefined,
							nodeId: s.node_id,
						}));

						// Resolve actual values for styles (colors, typography, effects)
						if (styleSpecs.length > 0) {
							try {
								const resolvedValues = await resolveStyleValues(api, resolvedFileKey, styleSpecs);
								for (const style of styleSpecs) {
									if (style.nodeId && resolvedValues.has(style.nodeId)) {
										style.resolvedValue = resolvedValues.get(style.nodeId);
									}
								}
							} catch (err) {
								logger.warn({ error: err }, "Failed to resolve style values");
							}
						}

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
					"DESIGN SYSTEM SPECIFICATION — STRICT VISUAL FIDELITY REQUIRED\n\n" +
					`Contains: ${sections.join(", ")}.\n\n` +
					"RULES:\n" +
					"1. ONLY use colors, spacing, and typography values from this data. " +
					"Do NOT invent, guess, or add any visual properties not explicitly present.\n" +
					"2. Map 'visualSpec' directly to CSS:\n" +
					"   - fills[].color → background-color (e.g. #181818)\n" +
					"   - strokes[].color/weight → border (e.g. 1px solid #9747FF)\n" +
					"   - effects[] → box-shadow (type DROP_SHADOW: offset.x offset.y radius spread color)\n" +
					"   - cornerRadius → border-radius\n" +
					"   - layout.mode HORIZONTAL → flex-direction:row, VERTICAL → flex-direction:column\n" +
					"   - layout.paddingTop/Right/Bottom/Left → padding\n" +
					"   - layout.itemSpacing → gap\n" +
					"   - layout.primaryAxisAlign → justify-content, counterAxisAlign → align-items\n" +
					"   - typography → font-family, font-size, font-weight, line-height, letter-spacing\n" +
					"3. Do NOT add decorative elements (colored borders, accents, dividers, gradients) " +
					"unless they appear in the visualSpec data.\n" +
					"4. Use 'imageUrl' screenshots as the visual ground truth. If the screenshot " +
					"shows a simple dark card, do not add colored side borders or other embellishments.\n" +
					"5. Style 'resolvedValue' contains the exact design system colors and typography — " +
					"match these values precisely, do not substitute similar colors.\n" +
					"6. Component 'properties' define the component API (props). " +
					"VARIANT type properties define the visual variants (e.g. Info, Danger, Success). " +
					"BOOLEAN properties toggle features. TEXT properties accept string content.\n" +
					"7. When applying to an existing component library (e.g. shadcn, MUI, Chakra), " +
					"override the library's default theme values with the exact colors, spacing, and " +
					"typography from this specification. Do not blend with library defaults.";

				// ----------------------------------------------------------------
				// Adaptive compression for large responses
				// Thresholds tuned for consumer AI context windows (~128K tokens ≈ ~400KB text)
				// ----------------------------------------------------------------
				const sizeKB = calculateSizeKB(kit);
				logger.info({ sizeKB: sizeKB.toFixed(0), format }, "Kit assembled, checking compression");

				// Determine compression level from format + size
				let compressionLevel: "summary" | "inventory" | "compact" | null = null;

				if (format === "compact") {
					compressionLevel = "compact";
				} else if (format === "summary") {
					compressionLevel = "summary";
				}

				// Auto-compress based on size regardless of format setting
				// Lower thresholds to stay within consumer context windows
				if (sizeKB > 500) {
					compressionLevel = "compact"; // >500KB → just names and types
				} else if (sizeKB > 200) {
					// Upgrade to at least inventory if not already more aggressive
					if (!compressionLevel || compressionLevel === "summary") {
						compressionLevel = "inventory";
					}
				} else if (sizeKB > 100) {
					// Upgrade to at least summary
					if (!compressionLevel) {
						compressionLevel = "summary";
					}
				}

				if (compressionLevel) {
					const compressed = compressKit(kit, compressionLevel);
					const compressedSizeKB = calculateSizeKB(compressed);

					if (sizeKB > 100) {
						compressed.ai_instruction =
							`Response auto-compressed (${compressionLevel}) from ${sizeKB.toFixed(0)}KB to ${compressedSizeKB.toFixed(0)}KB. ` +
							compressed.ai_instruction +
							" For full visual specs of specific components, re-call with specific componentIds and format='full'.";
					}

					logger.info({ originalKB: sizeKB.toFixed(0), compressedKB: compressedSizeKB.toFixed(0), level: compressionLevel }, "Kit compressed");

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
