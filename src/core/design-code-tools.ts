/**
 * Design-Code Parity Checker & Documentation Generator
 * MCP tools for comparing Figma design specs with code-side data
 * and generating platform-agnostic component documentation.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FigmaAPI } from "./figma-api.js";
import { extractFileKey } from "./figma-api.js";
import { createChildLogger } from "./logger.js";
import { EnrichmentService } from "./enrichment/index.js";
import type { EnrichmentOptions, EnrichedComponent } from "./types/enriched.js";
import type {
	CodeSpec,
	ParityDiscrepancy,
	ParityActionItem,
	ParityCheckResult,
	ParityCategory,
	DiscrepancySeverity,
	CodeDocInfo,
	DocSections,
	DocGenerationResult,
	CompanyDocsContentEntry,
} from "./types/design-code.js";

const logger = createChildLogger({ component: "design-code-tools" });
const enrichmentService = new EnrichmentService(logger);

// ============================================================================
// Shared Helpers
// ============================================================================

/** Convert Figma RGBA (0-1 floats) to hex string */
export function figmaRGBAToHex(color: { r: number; g: number; b: number; a?: number }): string {
	const r = Math.round(color.r * 255);
	const g = Math.round(color.g * 255);
	const b = Math.round(color.b * 255);
	const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase();
	if (color.a !== undefined && color.a < 1) {
		const a = Math.round(color.a * 255);
		return `${hex}${a.toString(16).padStart(2, "0")}`;
	}
	return hex;
}

/** Normalize a color string for comparison (uppercase hex without alpha if fully opaque) */
export function normalizeColor(color: string): string {
	let c = color.trim().toUpperCase();
	// Strip alpha if fully opaque (FF)
	if (c.length === 9 && c.endsWith("FF")) {
		c = c.slice(0, 7);
	}
	// Expand shorthand (#RGB -> #RRGGBB)
	if (/^#[0-9A-F]{3}$/.test(c)) {
		c = `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
	}
	return c;
}

/** Compare numeric values with a tolerance */
export function numericClose(a: number, b: number, tolerance: number = 1): boolean {
	return Math.abs(a - b) <= tolerance;
}

/** Calculate parity score from discrepancy counts */
export function calculateParityScore(critical: number, major: number, minor: number, info: number): number {
	return Math.max(0, 100 - (critical * 15 + major * 8 + minor * 3 + info * 1));
}

/** Extract first solid fill color from Figma node */
function extractFirstFillColor(fills: any[]): string | null {
	if (!fills || !Array.isArray(fills)) return null;
	const solid = fills.find((f: any) => f.type === "SOLID" && f.visible !== false);
	if (!solid?.color) return null;
	return figmaRGBAToHex({ ...solid.color, a: solid.opacity ?? solid.color.a ?? 1 });
}

/** Extract first stroke color from Figma node */
function extractFirstStrokeColor(strokes: any[]): string | null {
	if (!strokes || !Array.isArray(strokes)) return null;
	const solid = strokes.find((s: any) => s.type === "SOLID" && s.visible !== false);
	if (!solid?.color) return null;
	return figmaRGBAToHex({ ...solid.color, a: solid.opacity ?? solid.color.a ?? 1 });
}

/** Extract text style properties from a Figma text node */
function extractTextProperties(node: any): {
	fontFamily?: string;
	fontSize?: number;
	fontWeight?: number;
	lineHeight?: number;
	letterSpacing?: number;
} {
	const style = node.style || {};
	const result: any = {};
	if (style.fontFamily) result.fontFamily = style.fontFamily;
	if (style.fontSize) result.fontSize = style.fontSize;
	if (style.fontWeight) result.fontWeight = style.fontWeight;
	if (style.lineHeightPx) result.lineHeight = style.lineHeightPx;
	if (style.letterSpacing) result.letterSpacing = style.letterSpacing;
	return result;
}

/** Extract spacing/layout properties from a Figma node */
function extractSpacingProperties(node: any): {
	paddingTop?: number;
	paddingRight?: number;
	paddingBottom?: number;
	paddingLeft?: number;
	gap?: number;
	width?: number;
	height?: number;
} {
	const result: any = {};
	if (node.paddingTop !== undefined) result.paddingTop = node.paddingTop;
	if (node.paddingRight !== undefined) result.paddingRight = node.paddingRight;
	if (node.paddingBottom !== undefined) result.paddingBottom = node.paddingBottom;
	if (node.paddingLeft !== undefined) result.paddingLeft = node.paddingLeft;
	if (node.itemSpacing !== undefined) result.gap = node.itemSpacing;
	if (node.absoluteBoundingBox) {
		result.width = node.absoluteBoundingBox.width;
		result.height = node.absoluteBoundingBox.height;
	}
	return result;
}

/** Map Figma font weight number to CSS font weight */
function figmaFontWeight(weight: number): number {
	// Figma already uses numeric weights
	return weight;
}

/** Split markdown by H2 headers for platforms that need chunking */
export function chunkMarkdownByHeaders(markdown: string): Array<{ heading: string; content: string }> {
	const chunks: Array<{ heading: string; content: string }> = [];
	const lines = markdown.split("\n");
	let currentHeading = "";
	let currentContent: string[] = [];

	for (const line of lines) {
		if (line.startsWith("## ")) {
			if (currentHeading || currentContent.length > 0) {
				chunks.push({ heading: currentHeading, content: currentContent.join("\n").trim() });
			}
			currentHeading = line.replace("## ", "").trim();
			currentContent = [];
		} else {
			currentContent.push(line);
		}
	}
	if (currentHeading || currentContent.length > 0) {
		chunks.push({ heading: currentHeading, content: currentContent.join("\n").trim() });
	}
	return chunks;
}

/**
 * Clean a raw Figma variant name like "Type=Image, Size=12" into "Image / 12".
 * Extracts just the values from "Key=Value" pairs, joined by " / ".
 */
export function cleanVariantName(rawName: string): string {
	// Match Key=Value pairs separated by comma/space
	const pairs = rawName.match(/(\w[\w\s]*)=([^,]+)/g);
	if (!pairs || pairs.length === 0) return rawName;

	const values = pairs.map((p) => {
		const eqIdx = p.indexOf("=");
		return p.slice(eqIdx + 1).trim();
	});
	return values.join(" / ");
}

// ============================================================================
// Description Parser
// ============================================================================

/** Structured content extracted from a Figma component description */
interface ParsedDescription {
	/** The main overview/summary text */
	overview: string;
	/** "When to Use" bullet points */
	whenToUse: string[];
	/** "When NOT to Use" bullet points */
	whenNotToUse: string[];
	/** Content guidelines sections (title text, description text, etc.) */
	contentGuidelines: Array<{ heading: string; items: string[] }>;
	/** Accessibility notes */
	accessibilityNotes: string[];
	/** Any remaining unclassified content */
	additionalNotes: string[];
}

/**
 * Parse a Figma component description into structured sections.
 * Handles markdown-formatted descriptions with headers, bullet points, etc.
 */
export function parseComponentDescription(description: string): ParsedDescription {
	const result: ParsedDescription = {
		overview: "",
		whenToUse: [],
		whenNotToUse: [],
		contentGuidelines: [],
		accessibilityNotes: [],
		additionalNotes: [],
	};

	if (!description) return result;

	// Pre-process: split inline section headers onto their own lines.
	// Figma sometimes concatenates headers without newlines: "...sentence.When to Use\n- bullet..."
	// We detect known section header patterns appearing after sentence-ending chars (word, period, paren)
	// but NOT after markdown formatting like ** or ## to avoid breaking formatted headers.
	const inlineHeaderPatterns = [
		/(?<=[\w.)!?])(When\s+to\s+Use)/gi,
		/(?<=[\w.)!?])(When\s+NOT\s+to\s+Use)/gi,
		/(?<=[\w.)!?])(When\s+to\s+Not\s+Use)/gi,
		/(?<=[\w.)!?])(Don'?t\s+Use)/gi,
		/(?<=[\w.)!?])(Accessibility)/gi,
		/(?<=[\w.)!?])(Content\s+Requirements?)/gi,
		/(?<=[\w.)!?])(Content\s+Guidelines?)/gi,
		/(?<=[\w.)!?])(Writing\s+Guidelines?)/gi,
		/(?<=[\w.)!?])(Variants\b)/gi,
	];
	let normalized = description.replace(/\r\n/g, "\n");
	for (const pattern of inlineHeaderPatterns) {
		normalized = normalized.replace(pattern, "\n$1");
	}

	// Normalize line endings and split
	const lines = normalized.split("\n");

	type Section = "overview" | "when_to_use" | "when_not_to_use" | "content" | "accessibility" | "other";
	let currentSection: Section = "overview";
	let currentContentHeading = "";
	const overviewLines: string[] = [];

	// Known plain-text section header patterns (for descriptions without markdown formatting)
	const plainTextHeaders: Array<{ pattern: RegExp; section: Section; getHeading?: boolean }> = [
		{ pattern: /^when\s+to\s+use$/i, section: "when_to_use" },
		{ pattern: /^when\s+not\s+to\s+use$/i, section: "when_not_to_use" },
		{ pattern: /^when\s+to\s+not\s+use$/i, section: "when_not_to_use" },
		{ pattern: /^don'?t\s+use$/i, section: "when_not_to_use" },
		{ pattern: /^do\s+not\s+use$/i, section: "when_not_to_use" },
		{ pattern: /^accessibility$/i, section: "accessibility" },
		{ pattern: /^a11y$/i, section: "accessibility" },
		{ pattern: /^content\s*(requirements|guidelines)?$/i, section: "content", getHeading: true },
		{ pattern: /^writing\s*(guidelines)?$/i, section: "content", getHeading: true },
		{ pattern: /^copy\s*(guidelines)?$/i, section: "content", getHeading: true },
		{ pattern: /^variants$/i, section: "other" },
	];

	// Detect Figma per-property documentation headers like:
	// "Show Left Icon: True – Purpose", "Badge Text – Purpose", "Nested Instance: Checkbox – Purpose"
	const propertyDocPattern = /[–-]\s*Purpose\s*$/i;

	for (const line of lines) {
		const trimmed = line.trim();

		// Detect section headers: bold text (**Header**), markdown headers (## Header), or plain text exact matches
		const markdownHeaderMatch = trimmed.match(/^(?:\*\*|###?\s*)(.+?)(?:\*\*)?$/);
		const headerText = markdownHeaderMatch ? markdownHeaderMatch[1].trim().replace(/\*\*/g, "") : null;

		// Check if this is a Figma per-property documentation block (e.g., "Show Left Icon: True – Purpose")
		// These should be routed to "other" to avoid polluting content guidelines and accessibility sections
		const rawTextForPropertyCheck = headerText || trimmed;
		if (propertyDocPattern.test(rawTextForPropertyCheck)) {
			currentSection = "other";
			continue;
		}

		// Check plain-text headers first (exact line matches for known patterns)
		let plainMatch: { section: Section; heading: string } | null = null;
		if (!headerText) {
			for (const ph of plainTextHeaders) {
				if (ph.pattern.test(trimmed)) {
					plainMatch = { section: ph.section, heading: ph.getHeading ? trimmed : "" };
					break;
				}
			}
		}

		// Resolve the effective header
		const effectiveHeader = headerText || plainMatch?.heading || null;
		const isHeader = headerText !== null || plainMatch !== null;

		if (isHeader) {
			// If we matched a plain-text header with a known section, use it directly
			if (plainMatch) {
				if (plainMatch.section === "content" && plainMatch.heading) {
					currentContentHeading = plainMatch.heading;
					result.contentGuidelines.push({ heading: plainMatch.heading, items: [] });
				}
				currentSection = plainMatch.section;
				continue;
			}

			// Otherwise process the markdown header text
			const lower = (effectiveHeader || "").toLowerCase();
			if (lower.includes("when to use") && !lower.includes("not")) {
				currentSection = "when_to_use";
				continue;
			} else if (lower.includes("when not to use") || lower.includes("when to not use") || lower.includes("don't use") || lower.includes("do not use")) {
				currentSection = "when_not_to_use";
				continue;
			} else if (lower.includes("accessibility") || lower.includes("a11y") || lower.includes("aria")) {
				currentSection = "accessibility";
				continue;
			} else if (lower.includes("content") || lower.includes("title text") || lower.includes("description text") || lower.includes("button label") || lower.includes("writing") || lower.includes("copy")) {
				currentSection = "content";
				currentContentHeading = effectiveHeader || "";
				result.contentGuidelines.push({ heading: effectiveHeader || "", items: [] });
				continue;
			} else if (currentSection === "overview") {
				// A header after overview text means we're moving to a new section
				currentSection = "other";
				// Check if this might be a content guideline sub-section
				if (lower.includes("title") || lower.includes("description") || lower.includes("label") || lower.includes("variant")) {
					currentSection = "content";
					currentContentHeading = effectiveHeader || "";
					result.contentGuidelines.push({ heading: effectiveHeader || "", items: [] });
					continue;
				}
			} else if (currentSection === "content") {
				// New sub-heading within content guidelines
				currentContentHeading = effectiveHeader || "";
				result.contentGuidelines.push({ heading: effectiveHeader || "", items: [] });
				continue;
			}
		}

		// Skip empty lines (but don't change section)
		if (!trimmed) continue;

		// Skip horizontal rules
		if (/^---+$/.test(trimmed)) continue;

		// Extract bullet content
		const bulletMatch = trimmed.match(/^[-*•]\s*(.+)/);
		const content = bulletMatch ? bulletMatch[1] : trimmed;

		switch (currentSection) {
			case "overview":
				overviewLines.push(content);
				break;
			case "when_to_use":
				result.whenToUse.push(content);
				break;
			case "when_not_to_use":
				result.whenNotToUse.push(content);
				break;
			case "content": {
				const last = result.contentGuidelines[result.contentGuidelines.length - 1];
				if (last) last.items.push(content);
				break;
			}
			case "accessibility":
				result.accessibilityNotes.push(content);
				break;
			case "other":
				result.additionalNotes.push(content);
				break;
		}
	}

	result.overview = overviewLines.join(" ").trim();
	return result;
}

// ============================================================================
// Per-Variant Data Collection
// ============================================================================

/** Color data collected from a specific variant */
interface VariantColorData {
	variantName: string;
	fills: Array<{ hex: string; nodeName: string; variableId?: string; variableName?: string }>;
	strokes: Array<{ hex: string; nodeName: string; variableId?: string; variableName?: string }>;
	textColors: Array<{ hex: string; nodeName: string; variableId?: string; variableName?: string }>;
	icons: Array<{ name: string; type: string }>;
}

/** Typography data from a text node */
interface TextStyleData {
	nodeName: string;
	fontFamily: string;
	fontWeight: number;
	fontWeightName: string;
	fontSize: number;
	lineHeight: number;
	letterSpacing: number;
	variableBindings?: Record<string, string>;
}

/**
 * Collect color data from all variants in a COMPONENT_SET.
 * For single COMPONENTs, returns data for just that component.
 */
export function collectAllVariantData(node: any, varNameMap: Map<string, string>): VariantColorData[] {
	const variants: VariantColorData[] = [];

	const nodesToWalk = node.type === "COMPONENT_SET" && node.children?.length > 0
		? node.children
		: [node];

	for (const variant of nodesToWalk) {
		const data: VariantColorData = {
			variantName: variant.name || "Default",
			fills: [],
			strokes: [],
			textColors: [],
			icons: [],
		};

		walkVariantNode(variant, data, varNameMap, 0, 5);
		variants.push(data);
	}

	return variants;
}

/** Walk a single variant node tree to collect colors and icons */
function walkVariantNode(
	node: any,
	data: VariantColorData,
	varNameMap: Map<string, string>,
	depth: number,
	maxDepth: number,
): void {
	if (depth > maxDepth) return;

	const isText = node.type === "TEXT";

	// Check if this is an icon instance
	if (node.type === "INSTANCE" && (
		node.name?.toLowerCase().includes("icon") ||
		node.name?.toLowerCase().startsWith("icon")
	)) {
		const iconName = node.name.replace(/^icon\s*\/?\s*/i, "").trim();
		data.icons.push({ name: iconName || node.name, type: "instance" });
	}

	// Collect fills
	if (node.fills && Array.isArray(node.fills)) {
		for (const fill of node.fills) {
			if (fill.type === "SOLID" && fill.color && fill.visible !== false) {
				const hex = figmaRGBAToHex({ ...fill.color, a: fill.opacity ?? fill.color.a ?? 1 });
				const varId = fill.boundVariables?.color?.id;
				const entry = {
					hex,
					nodeName: node.name || "",
					variableId: varId,
					variableName: varId ? varNameMap.get(varId) : undefined,
				};
				if (isText) {
					data.textColors.push(entry);
				} else {
					data.fills.push(entry);
				}
			}
		}
	}

	// Collect strokes
	if (node.strokes && Array.isArray(node.strokes)) {
		for (const stroke of node.strokes) {
			if (stroke.type === "SOLID" && stroke.color && stroke.visible !== false) {
				const hex = figmaRGBAToHex({ ...stroke.color, a: stroke.opacity ?? stroke.color.a ?? 1 });
				const varId = stroke.boundVariables?.color?.id;
				data.strokes.push({
					hex,
					nodeName: node.name || "",
					variableId: varId,
					variableName: varId ? varNameMap.get(varId) : undefined,
				});
			}
		}
	}

	// Recurse into children
	if (node.children && Array.isArray(node.children)) {
		for (const child of node.children) {
			walkVariantNode(child, data, varNameMap, depth + 1, maxDepth);
		}
	}
}

/**
 * Collect typography data from all text nodes in a component tree.
 */
export function collectTypographyData(node: any, depth: number = 0, maxDepth: number = 5): TextStyleData[] {
	const results: TextStyleData[] = [];
	if (depth > maxDepth) return results;

	// For COMPONENT_SET, walk the default (first) variant
	if (node.type === "COMPONENT_SET" && node.children?.length > 0 && depth === 0) {
		return collectTypographyData(node.children[0], 0, maxDepth);
	}

	if (node.type === "TEXT" && node.style) {
		const s = node.style;
		const weightNames: Record<number, string> = {
			100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular",
			500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black",
		};
		results.push({
			nodeName: node.name || "Text",
			fontFamily: s.fontFamily || "Unknown",
			fontWeight: s.fontWeight || 400,
			fontWeightName: weightNames[s.fontWeight] || String(s.fontWeight),
			fontSize: s.fontSize || 14,
			lineHeight: s.lineHeightPx || s.fontSize || 14,
			letterSpacing: s.letterSpacing || 0,
		});
	}

	if (node.children && Array.isArray(node.children)) {
		for (const child of node.children) {
			results.push(...collectTypographyData(child, depth + 1, maxDepth));
		}
	}

	return results;
}

/**
 * Build an anatomy tree representation from a Figma node structure.
 * Returns a formatted string showing the component's nested structure.
 */
export function buildAnatomyTree(node: any, depth: number = 0, maxDepth: number = 5): string {
	if (depth > maxDepth) return "";

	// For COMPONENT_SET, pick the variant with the deepest children tree for the richest anatomy
	let targetNode = node;
	if (node.type === "COMPONENT_SET" && node.children?.length > 0 && depth === 0) {
		let bestChild = node.children[0];
		let bestDepth = countChildDepth(bestChild);
		for (let i = 1; i < node.children.length; i++) {
			const d = countChildDepth(node.children[i]);
			if (d > bestDepth) {
				bestDepth = d;
				bestChild = node.children[i];
			}
		}
		targetNode = bestChild;
	}

	const lines: string[] = [];
	buildAnatomyLines(targetNode, lines, "", true, 0, maxDepth);
	return lines.join("\n");
}

/** Count the maximum depth of a node's children tree */
function countChildDepth(node: any): number {
	if (!node.children || !Array.isArray(node.children) || node.children.length === 0) return 0;
	let max = 0;
	for (const child of node.children) {
		const d = countChildDepth(child);
		if (d > max) max = d;
	}
	return 1 + max;
}

function buildAnatomyLines(
	node: any,
	lines: string[],
	prefix: string,
	isLast: boolean,
	depth: number,
	maxDepth: number,
): void {
	if (depth > maxDepth) return;

	const connector = depth === 0 ? "" : (isLast ? "└── " : "├── ");
	const childPrefix = depth === 0 ? "" : (isLast ? "    " : "│   ");

	// Build node label
	let label = node.name || node.type;
	const typeHint = node.type === "TEXT" ? " (TEXT)"
		: node.type === "INSTANCE" ? " (INSTANCE)"
		: node.type === "COMPONENT" ? " (COMPONENT)"
		: node.type === "FRAME" ? ""
		: node.type === "VECTOR" ? " (VECTOR)"
		: node.type === "RECTANGLE" ? " (RECTANGLE)"
		: "";

	// Add layout info for frames
	let layoutInfo = "";
	if (node.layoutMode) {
		const dir = node.layoutMode === "HORIZONTAL" ? "horizontal" : "vertical";
		layoutInfo = ` — ${dir} auto-layout`;
		if (node.itemSpacing !== undefined) layoutInfo += `, gap: ${node.itemSpacing}px`;
	}

	// Add sizing info
	let sizingInfo = "";
	if (node.primaryAxisSizingMode || node.counterAxisSizingMode) {
		const parts: string[] = [];
		if (node.primaryAxisSizingMode === "FIXED") parts.push("fixed-width");
		if (node.primaryAxisSizingMode === "AUTO") parts.push("hug-content");
		if (node.counterAxisSizingMode === "FIXED") parts.push("fixed-height");
		if (node.layoutGrow === 1) parts.push("fill");
		if (parts.length > 0) sizingInfo = ` [${parts.join(", ")}]`;
	}

	lines.push(`${prefix}${connector}${label}${typeHint}${layoutInfo}${sizingInfo}`);

	// Recurse into children
	if (node.children && Array.isArray(node.children)) {
		const visibleChildren = node.children.filter((c: any) => c.visible !== false);
		for (let i = 0; i < visibleChildren.length; i++) {
			const isChildLast = i === visibleChildren.length - 1;
			buildAnatomyLines(
				visibleChildren[i],
				lines,
				prefix + childPrefix,
				isChildLast,
				depth + 1,
				maxDepth,
			);
		}
	}
}

/**
 * Collect spacing tokens with their bound variable names.
 */
function collectSpacingTokens(node: any): Array<{
	property: string;
	value: number;
	variableName?: string;
}> {
	const tokens: Array<{ property: string; value: number; variableName?: string }> = [];
	const boundVars = node.boundVariables || {};

	const spacingProps = [
		{ key: "paddingTop", label: "Padding top" },
		{ key: "paddingRight", label: "Padding right" },
		{ key: "paddingBottom", label: "Padding bottom" },
		{ key: "paddingLeft", label: "Padding left" },
		{ key: "itemSpacing", label: "Gap" },
		{ key: "cornerRadius", label: "Border radius" },
		{ key: "strokeWeight", label: "Border width" },
	];

	for (const { key, label } of spacingProps) {
		const value = node[key];
		if (value !== undefined && value !== null) {
			const varBinding = boundVars[key];
			const varName = varBinding?.id || varBinding?.name;
			tokens.push({
				property: label,
				value,
				variableName: typeof varName === "string" ? varName : undefined,
			});
		}
	}

	return tokens;
}

// ============================================================================
// Component Set Resolution Helpers
// ============================================================================

/**
 * Resolve the node to use for visual/spacing/typography comparisons.
 * COMPONENT_SET frames have container-level styling (Figma's purple dashed stroke,
 * default cornerRadius: 5, organizational padding) that are NOT actual design specs.
 * The real design properties live on the child COMPONENT variants.
 * Returns the default variant (first child) for COMPONENT_SET, or the node itself otherwise.
 */
export function resolveVisualNode(node: any): any {
	if (node.type === "COMPONENT_SET" && node.children?.length > 0) {
		return node.children[0];
	}
	return node;
}

/** Detect if a node name is a Figma variant pattern like "Variant=Default, State=Hover, Size=lg" */
export function isVariantName(name: string): boolean {
	return /^[A-Za-z]+=.+,.+[A-Za-z]+=/.test(name);
}

/** Sanitize a component name for use as a file path */
export function sanitizeComponentName(name: string): string {
	return name.replace(/[^a-zA-Z0-9-_ ]/g, "").replace(/\s+/g, "-").trim();
}

/**
 * Resolve the parent COMPONENT_SET info for a variant COMPONENT node.
 * Returns the set's name, nodeId, and componentPropertyDefinitions.
 */
async function resolveComponentSetInfo(
	api: FigmaAPI,
	fileKey: string,
	nodeId: string,
	componentMeta: any,
	allComponentsMeta: any[] | null,
): Promise<{
	setName: string | null;
	setNodeId: string | null;
	propertyDefinitions: Record<string, any>;
}> {
	const empty = { setName: null, setNodeId: null, propertyDefinitions: {} };

	// Strategy 1: Check componentMeta for component_set_id (from /files/:key/components)
	const meta = componentMeta || allComponentsMeta?.find((c: any) => c.node_id === nodeId);
	const setId = meta?.component_set_id;
	const setName = meta?.component_set_name || null;

	if (!setId) {
		// Strategy 2: Use containing_frame from component metadata
		const containingFrame = meta?.containing_frame;
		if (containingFrame?.containingComponentSet && containingFrame?.nodeId) {
			const frameNodeId = containingFrame.nodeId;
			try {
				const setResponse = await api.getNodes(fileKey, [frameNodeId], { depth: 1 });
				const setNode = setResponse?.nodes?.[frameNodeId]?.document;
				if (setNode?.componentPropertyDefinitions) {
					return {
						setName: setNode.name || containingFrame.name || setName,
						setNodeId: frameNodeId,
						propertyDefinitions: setNode.componentPropertyDefinitions,
					};
				}
			} catch {
				logger.warn("Could not fetch component set via containing_frame");
			}
		}

		// Strategy 3: Search getComponentSets for a set matching this component's containing frame
		try {
			const setsResponse = await api.getComponentSets(fileKey);
			const sets = setsResponse?.meta?.component_sets;
			if (sets && Array.isArray(sets)) {
				// Match by containing_frame name or by node name prefix
				const nodeName = allComponentsMeta?.find((c: any) => c.node_id === nodeId)?.name || "";
				const matchingSet = containingFrame?.name
					? sets.find((s: any) => s.name === containingFrame.name)
					: null;
				if (matchingSet) {
					const setNodeId = matchingSet.node_id;
					const setNodeResponse = await api.getNodes(fileKey, [setNodeId], { depth: 1 });
					const setNode = setNodeResponse?.nodes?.[setNodeId]?.document;
					if (setNode?.componentPropertyDefinitions) {
						return {
							setName: setNode.name || matchingSet.name,
							setNodeId,
							propertyDefinitions: setNode.componentPropertyDefinitions,
						};
					}
				}
			}
		} catch {
			logger.warn("Could not resolve component set via getComponentSets");
		}

		return { ...empty, setName };
	}

	// Fetch the COMPONENT_SET node to get componentPropertyDefinitions
	try {
		const setResponse = await api.getNodes(fileKey, [setId], { depth: 1 });
		const setNode = setResponse?.nodes?.[setId]?.document;
		if (setNode) {
			return {
				setName: setNode.name || setName,
				setNodeId: setId,
				propertyDefinitions: setNode.componentPropertyDefinitions || {},
			};
		}
	} catch {
		logger.warn({ setId }, "Could not fetch component set node");
	}

	return { ...empty, setName };
}

/**
 * Extract a clean component name from a node, resolving variant patterns.
 * "Variant=Default, State=Default, Size=default" -> uses parent set name or codeSpec fallback.
 * Preserves the casing of whatever source provides the name (no assumptions about convention).
 */
function resolveComponentName(
	node: any,
	setName: string | null,
	fallbackName?: string,
): string {
	// If we have a parent set name, prefer it (authoritative from Figma)
	if (setName) return setName;

	// If the node name is a variant pattern, try to extract something useful
	if (isVariantName(node.name)) {
		// Use fallback (from codeSpec.metadata.name or file path) preserving original casing
		if (fallbackName) return fallbackName;
		// Last resort: extract first variant value as name hint
		return node.name.split(",")[0].split("=")[1]?.trim() || node.name;
	}

	return node.name || fallbackName || "Component";
}

// ============================================================================
// Parity Comparators
// ============================================================================

function compareVisual(node: any, codeSpec: CodeSpec, discrepancies: ParityDiscrepancy[]): void {
	const cv = codeSpec.visual;
	if (!cv) return;

	// Background / fill color
	const figmaFill = extractFirstFillColor(node.fills);
	if (figmaFill && cv.backgroundColor) {
		const normalizedDesign = normalizeColor(figmaFill);
		const normalizedCode = normalizeColor(cv.backgroundColor);
		if (normalizedDesign !== normalizedCode) {
			discrepancies.push({
				category: "visual",
				property: "backgroundColor",
				severity: "major",
				designValue: figmaFill,
				codeValue: cv.backgroundColor,
				message: `Background color mismatch: design=${figmaFill}, code=${cv.backgroundColor}`,
				suggestion: `Update to match ${figmaFill}`,
			});
		}
	}

	// Border / stroke color
	const figmaStroke = extractFirstStrokeColor(node.strokes);
	if (figmaStroke && cv.borderColor) {
		const normalizedDesign = normalizeColor(figmaStroke);
		const normalizedCode = normalizeColor(cv.borderColor);
		if (normalizedDesign !== normalizedCode) {
			discrepancies.push({
				category: "visual",
				property: "borderColor",
				severity: "major",
				designValue: figmaStroke,
				codeValue: cv.borderColor,
				message: `Border color mismatch: design=${figmaStroke}, code=${cv.borderColor}`,
				suggestion: `Update to match ${figmaStroke}`,
			});
		}
	}

	// Border width / stroke weight
	if (node.strokeWeight !== undefined && cv.borderWidth !== undefined) {
		if (!numericClose(node.strokeWeight, cv.borderWidth)) {
			discrepancies.push({
				category: "visual",
				property: "borderWidth",
				severity: "minor",
				designValue: node.strokeWeight,
				codeValue: cv.borderWidth,
				message: `Border width mismatch: design=${node.strokeWeight}px, code=${cv.borderWidth}px`,
			});
		}
	}

	// Corner radius
	const figmaRadius = node.cornerRadius;
	if (figmaRadius !== undefined && cv.borderRadius !== undefined) {
		const codeRadius = typeof cv.borderRadius === "string" ? parseFloat(cv.borderRadius) : cv.borderRadius;
		if (!isNaN(codeRadius) && !numericClose(figmaRadius, codeRadius)) {
			discrepancies.push({
				category: "visual",
				property: "borderRadius",
				severity: "minor",
				designValue: figmaRadius,
				codeValue: cv.borderRadius,
				message: `Border radius mismatch: design=${figmaRadius}px, code=${cv.borderRadius}`,
			});
		}
	}

	// Opacity
	if (node.opacity !== undefined && cv.opacity !== undefined) {
		if (!numericClose(node.opacity, cv.opacity, 0.01)) {
			discrepancies.push({
				category: "visual",
				property: "opacity",
				severity: "minor",
				designValue: node.opacity,
				codeValue: cv.opacity,
				message: `Opacity mismatch: design=${node.opacity}, code=${cv.opacity}`,
			});
		}
	}
}

function compareSpacing(node: any, codeSpec: CodeSpec, discrepancies: ParityDiscrepancy[]): void {
	const cs = codeSpec.spacing;
	if (!cs) return;

	const designSpacing = extractSpacingProperties(node);

	const spacingProps: Array<{ key: string; designKey: string }> = [
		{ key: "paddingTop", designKey: "paddingTop" },
		{ key: "paddingRight", designKey: "paddingRight" },
		{ key: "paddingBottom", designKey: "paddingBottom" },
		{ key: "paddingLeft", designKey: "paddingLeft" },
		{ key: "gap", designKey: "gap" },
	];

	for (const { key, designKey } of spacingProps) {
		const dVal = designSpacing[designKey as keyof typeof designSpacing];
		const cVal = cs[key as keyof typeof cs];
		if (dVal !== undefined && cVal !== undefined) {
			const cNum = typeof cVal === "string" ? parseFloat(cVal) : (cVal as number);
			if (!isNaN(cNum) && !numericClose(dVal as number, cNum)) {
				discrepancies.push({
					category: "spacing",
					property: key,
					severity: "major",
					designValue: dVal as number,
					codeValue: cVal as number,
					message: `Spacing mismatch on ${key}: design=${dVal}px, code=${cVal}`,
				});
			}
		}
	}

	// Width/height (only compare if both are numeric)
	if (designSpacing.width !== undefined && cs.width !== undefined) {
		const cNum = typeof cs.width === "string" ? parseFloat(cs.width) : cs.width;
		if (!isNaN(cNum) && !numericClose(designSpacing.width, cNum, 2)) {
			discrepancies.push({
				category: "spacing",
				property: "width",
				severity: "minor",
				designValue: designSpacing.width,
				codeValue: cs.width,
				message: `Width mismatch: design=${designSpacing.width}px, code=${cs.width}`,
			});
		}
	}

	if (designSpacing.height !== undefined && cs.height !== undefined) {
		const cNum = typeof cs.height === "string" ? parseFloat(cs.height) : cs.height;
		if (!isNaN(cNum) && !numericClose(designSpacing.height, cNum, 2)) {
			discrepancies.push({
				category: "spacing",
				property: "height",
				severity: "minor",
				designValue: designSpacing.height,
				codeValue: cs.height,
				message: `Height mismatch: design=${designSpacing.height}px, code=${cs.height}`,
			});
		}
	}
}

function compareTypography(node: any, codeSpec: CodeSpec, discrepancies: ParityDiscrepancy[]): void {
	const ct = codeSpec.typography;
	if (!ct) return;

	// Find text nodes in children or check the node itself
	let textNode = node.type === "TEXT" ? node : null;
	if (!textNode && node.children) {
		textNode = node.children.find((c: any) => c.type === "TEXT");
	}
	if (!textNode) return;

	const designTypo = extractTextProperties(textNode);

	if (designTypo.fontFamily && ct.fontFamily) {
		if (designTypo.fontFamily.toLowerCase() !== ct.fontFamily.toLowerCase()) {
			discrepancies.push({
				category: "typography",
				property: "fontFamily",
				severity: "major",
				designValue: designTypo.fontFamily,
				codeValue: ct.fontFamily,
				message: `Font family mismatch: design="${designTypo.fontFamily}", code="${ct.fontFamily}"`,
			});
		}
	}

	if (designTypo.fontSize && ct.fontSize) {
		if (!numericClose(designTypo.fontSize, ct.fontSize)) {
			discrepancies.push({
				category: "typography",
				property: "fontSize",
				severity: "major",
				designValue: designTypo.fontSize,
				codeValue: ct.fontSize,
				message: `Font size mismatch: design=${designTypo.fontSize}px, code=${ct.fontSize}px`,
			});
		}
	}

	if (designTypo.fontWeight && ct.fontWeight) {
		const codeWeight = typeof ct.fontWeight === "string" ? parseInt(ct.fontWeight, 10) : ct.fontWeight;
		if (!isNaN(codeWeight) && designTypo.fontWeight !== codeWeight) {
			discrepancies.push({
				category: "typography",
				property: "fontWeight",
				severity: "minor",
				designValue: designTypo.fontWeight,
				codeValue: ct.fontWeight,
				message: `Font weight mismatch: design=${designTypo.fontWeight}, code=${ct.fontWeight}`,
			});
		}
	}

	if (designTypo.lineHeight && ct.lineHeight) {
		const codeLH = typeof ct.lineHeight === "string" ? parseFloat(ct.lineHeight) : ct.lineHeight;
		if (!isNaN(codeLH) && !numericClose(designTypo.lineHeight, codeLH, 1)) {
			discrepancies.push({
				category: "typography",
				property: "lineHeight",
				severity: "minor",
				designValue: designTypo.lineHeight,
				codeValue: ct.lineHeight,
				message: `Line height mismatch: design=${designTypo.lineHeight}px, code=${ct.lineHeight}`,
			});
		}
	}
}

function compareTokens(
	enrichedData: EnrichedComponent | null,
	codeSpec: CodeSpec,
	discrepancies: ParityDiscrepancy[],
): void {
	const ct = codeSpec.tokens;
	if (!ct || !enrichedData) return;

	// Check for hardcoded values in design
	if (enrichedData.hardcoded_values && enrichedData.hardcoded_values.length > 0) {
		for (const hv of enrichedData.hardcoded_values) {
			discrepancies.push({
				category: "tokens",
				property: `hardcoded:${hv.property}`,
				severity: "major",
				designValue: `${hv.value} (hardcoded)`,
				codeValue: null,
				message: `Design has hardcoded ${hv.type} value "${hv.value}" on ${hv.property}. Should use token${hv.suggested_token ? `: ${hv.suggested_token}` : ""}`,
				suggestion: hv.suggested_token ? `Use token: ${hv.suggested_token}` : undefined,
			});
		}
	}

	// Cross-reference design variables with code tokens
	if (enrichedData.variables_used && ct.usedTokens) {
		const designTokenNames = enrichedData.variables_used.map((v) => v.name.toLowerCase());
		const codeTokenNames = ct.usedTokens.map((t) => t.toLowerCase());

		for (const designToken of enrichedData.variables_used) {
			const normalizedName = designToken.name.toLowerCase();
			if (!codeTokenNames.some((ct) => ct.includes(normalizedName) || normalizedName.includes(ct))) {
				discrepancies.push({
					category: "tokens",
					property: `token:${designToken.name}`,
					severity: "minor",
					designValue: designToken.name,
					codeValue: null,
					message: `Design uses token "${designToken.name}" but code doesn't reference it`,
					suggestion: `Add token reference in code`,
				});
			}
		}

		for (const codeToken of ct.usedTokens) {
			const normalizedName = codeToken.toLowerCase();
			if (!designTokenNames.some((dt) => dt.includes(normalizedName) || normalizedName.includes(dt))) {
				discrepancies.push({
					category: "tokens",
					property: `token:${codeToken}`,
					severity: "info",
					designValue: null,
					codeValue: codeToken,
					message: `Code uses token "${codeToken}" but design doesn't reference it`,
				});
			}
		}
	}

	// Token coverage
	if (enrichedData.token_coverage !== undefined && enrichedData.token_coverage < 80) {
		discrepancies.push({
			category: "tokens",
			property: "tokenCoverage",
			severity: enrichedData.token_coverage < 50 ? "critical" : "major",
			designValue: `${enrichedData.token_coverage}%`,
			codeValue: null,
			message: `Design token coverage is ${enrichedData.token_coverage}% (target: ≥80%)`,
			suggestion: "Replace hardcoded values with design tokens",
		});
	}
}

function compareComponentAPI(node: any, codeSpec: CodeSpec, discrepancies: ParityDiscrepancy[]): void {
	const ca = codeSpec.componentAPI;
	if (!ca?.props) return;

	const figmaProps = node.componentPropertyDefinitions || {};
	const figmaPropNames = Object.keys(figmaProps);

	// Map Figma property types
	const figmaPropList = figmaPropNames.map((name) => ({
		name,
		type: figmaProps[name].type, // VARIANT, TEXT, BOOLEAN, INSTANCE_SWAP
		defaultValue: figmaProps[name].defaultValue,
		values: figmaProps[name].variantOptions || [],
	}));

	// Check each code prop against Figma properties
	for (const codeProp of ca.props) {
		const matchingFigma = figmaPropList.find(
			(fp) => fp.name.toLowerCase().replace(/[^a-z0-9]/g, "") === codeProp.name.toLowerCase().replace(/[^a-z0-9]/g, ""),
		);

		if (!matchingFigma) {
			discrepancies.push({
				category: "componentAPI",
				property: `prop:${codeProp.name}`,
				severity: "minor",
				designValue: null,
				codeValue: codeProp.name,
				message: `Code prop "${codeProp.name}" has no matching Figma component property`,
				suggestion: `Add component property in Figma`,
			});
		} else if (matchingFigma.type === "VARIANT" && codeProp.values) {
			// Check variant values match
			const figmaValues = matchingFigma.values.map((v: string) => v.toLowerCase());
			const codeValues = codeProp.values.map((v) => v.toLowerCase());
			const missingInDesign = codeValues.filter((v) => !figmaValues.includes(v));
			const missingInCode = figmaValues.filter((v: string) => !codeValues.includes(v));

			if (missingInDesign.length > 0) {
				discrepancies.push({
					category: "componentAPI",
					property: `prop:${codeProp.name}:values`,
					severity: "major",
					designValue: matchingFigma.values.join(", "),
					codeValue: codeProp.values.join(", "),
					message: `Code has variant values not in design: ${missingInDesign.join(", ")}`,
				});
			}
			if (missingInCode.length > 0) {
				discrepancies.push({
					category: "componentAPI",
					property: `prop:${codeProp.name}:values`,
					severity: "info",
					designValue: matchingFigma.values.join(", "),
					codeValue: codeProp.values.join(", "),
					message: `Design has variant values not in code: ${missingInCode.join(", ")}`,
				});
			}
		}
	}

	// Check for Figma properties not in code
	for (const figmaProp of figmaPropList) {
		const matchingCode = ca.props.find(
			(cp) => cp.name.toLowerCase().replace(/[^a-z0-9]/g, "") === figmaProp.name.toLowerCase().replace(/[^a-z0-9]/g, ""),
		);
		if (!matchingCode) {
			discrepancies.push({
				category: "componentAPI",
				property: `prop:${figmaProp.name}`,
				severity: "info",
				designValue: figmaProp.name,
				codeValue: null,
				message: `Figma property "${figmaProp.name}" (${figmaProp.type}) has no matching code prop`,
			});
		}
	}
}

function compareAccessibility(node: any, codeSpec: CodeSpec, discrepancies: ParityDiscrepancy[]): void {
	const ca = codeSpec.accessibility;
	if (!ca) return;

	// Check description/annotations for accessibility hints
	const description = node.descriptionMarkdown || node.description || "";
	const hasAriaAnnotation = description.toLowerCase().includes("aria") || description.toLowerCase().includes("accessibility");

	if (ca.role && !hasAriaAnnotation) {
		discrepancies.push({
			category: "accessibility",
			property: "role",
			severity: "info",
			designValue: null,
			codeValue: ca.role,
			message: `Code defines role="${ca.role}" but design has no accessibility annotations`,
			suggestion: "Add accessibility annotations in Figma description",
		});
	}

	if (ca.contrastRatio !== undefined && ca.contrastRatio < 4.5) {
		discrepancies.push({
			category: "accessibility",
			property: "contrastRatio",
			severity: "critical",
			designValue: null,
			codeValue: ca.contrastRatio,
			message: `Contrast ratio ${ca.contrastRatio}:1 fails WCAG AA minimum (4.5:1)`,
			suggestion: "Increase contrast ratio to at least 4.5:1",
		});
	}
}

function compareNaming(node: any, codeSpec: CodeSpec, discrepancies: ParityDiscrepancy[]): void {
	const cm = codeSpec.metadata;
	if (!cm?.name) return;

	const designName = node.name || "";
	const codeName = cm.name;

	// Check PascalCase consistency
	const isPascal = (s: string) => /^[A-Z][a-zA-Z0-9]*$/.test(s);
	const isKebab = (s: string) => /^[a-z][a-z0-9-]*$/.test(s);

	if (isPascal(designName) !== isPascal(codeName) && isKebab(designName) !== isKebab(codeName)) {
		discrepancies.push({
			category: "naming",
			property: "componentName",
			severity: "info",
			designValue: designName,
			codeValue: codeName,
			message: `Naming convention differs: design="${designName}", code="${codeName}"`,
			suggestion: "Align naming conventions between design and code",
		});
	}
}

function compareMetadata(node: any, componentMeta: any, codeSpec: CodeSpec, discrepancies: ParityDiscrepancy[]): void {
	const cm = codeSpec.metadata;
	if (!cm) return;

	const designDesc = node.description || componentMeta?.description || "";
	if (cm.description && designDesc) {
		// Only flag if descriptions are meaningfully different (not just formatting)
		const normalizeDesc = (d: string) => d.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
		if (normalizeDesc(designDesc) !== normalizeDesc(cm.description)) {
			discrepancies.push({
				category: "metadata",
				property: "description",
				severity: "info",
				designValue: designDesc.slice(0, 100),
				codeValue: cm.description.slice(0, 100),
				message: "Component descriptions differ between design and code",
			});
		}
	}

	if (cm.status && componentMeta?.description) {
		// Check if design description contains a status
		const statusKeywords = ["stable", "experimental", "deprecated", "beta", "alpha", "draft"];
		const designStatus = statusKeywords.find((s) => componentMeta.description.toLowerCase().includes(s));
		if (designStatus && designStatus !== cm.status.toLowerCase()) {
			discrepancies.push({
				category: "metadata",
				property: "status",
				severity: "minor",
				designValue: designStatus,
				codeValue: cm.status,
				message: `Status mismatch: design implies "${designStatus}", code says "${cm.status}"`,
			});
		}
	}
}

// ============================================================================
// Action Item Generator
// ============================================================================

function generateActionItems(
	discrepancies: ParityDiscrepancy[],
	nodeId: string,
	canonicalSource: "design" | "code",
	filePath?: string,
): ParityActionItem[] {
	const items: ParityActionItem[] = [];

	for (let i = 0; i < discrepancies.length; i++) {
		const d = discrepancies[i];
		// Determine which side needs the fix
		const fixSide = canonicalSource === "design" ? "code" : "design";

		const item: ParityActionItem = {
			discrepancyIndex: i,
			side: fixSide,
		};

		if (fixSide === "design") {
			// Generate Figma tool call parameters
			switch (d.category) {
				case "visual":
					if (d.property === "backgroundColor" && d.codeValue) {
						item.figmaTool = "figma_set_fills";
						item.figmaToolParams = {
							nodeId,
							fills: [{ type: "SOLID", color: String(d.codeValue) }],
						};
					} else if (d.property === "borderColor" && d.codeValue) {
						item.figmaTool = "figma_set_strokes";
						item.figmaToolParams = {
							nodeId,
							strokes: [{ type: "SOLID", color: String(d.codeValue) }],
						};
					} else if (d.property === "borderRadius" && d.codeValue) {
						item.figmaTool = "figma_execute";
						item.figmaToolParams = {
							code: `const node = figma.getNodeById("${nodeId}"); if (node && "cornerRadius" in node) { node.cornerRadius = ${d.codeValue}; }`,
						};
					} else if (d.property === "borderWidth" && d.codeValue) {
						item.figmaTool = "figma_execute";
						item.figmaToolParams = {
							code: `const node = figma.getNodeById("${nodeId}"); if (node && "strokeWeight" in node) { node.strokeWeight = ${d.codeValue}; }`,
						};
					}
					break;

				case "spacing":
					if (d.codeValue !== null && d.codeValue !== undefined) {
						const prop = d.property;
						if (["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "gap"].includes(prop)) {
							const figmaProp = prop === "gap" ? "itemSpacing" : prop;
							item.figmaTool = "figma_execute";
							item.figmaToolParams = {
								code: `const node = figma.getNodeById("${nodeId}"); if (node && "${figmaProp}" in node) { node.${figmaProp} = ${d.codeValue}; }`,
							};
						} else if (prop === "width" || prop === "height") {
							item.figmaTool = "figma_resize_node";
							item.figmaToolParams = {
								nodeId,
								[prop]: Number(d.codeValue),
							};
						}
					}
					break;

				case "componentAPI":
					if (d.property.startsWith("prop:") && d.codeValue && !d.designValue) {
						item.figmaTool = "figma_add_component_property";
						item.figmaToolParams = {
							nodeId,
							propertyName: String(d.codeValue),
							type: "VARIANT",
							defaultValue: "",
						};
					}
					break;

				case "metadata":
					if (d.property === "description" && d.codeValue) {
						item.figmaTool = "figma_set_description";
						item.figmaToolParams = {
							nodeId,
							description: String(d.codeValue),
						};
					}
					break;

				default:
					// For categories without direct tool mappings, provide a description
					item.codeChange = {
						filePath,
						property: d.property,
						currentValue: d.designValue,
						targetValue: d.codeValue,
						description: d.suggestion || d.message,
					};
					break;
			}

			// If no figma tool was assigned and no codeChange, add generic guidance
			if (!item.figmaTool && !item.codeChange) {
				item.codeChange = {
					property: d.property,
					currentValue: d.designValue,
					targetValue: d.codeValue,
					description: `Update design: ${d.message}`,
				};
			}
		} else {
			// Code-side fix
			item.codeChange = {
				filePath,
				property: d.property,
				currentValue: d.codeValue,
				targetValue: d.designValue,
				description: d.suggestion || `Update code to match design: ${d.message}`,
			};
		}

		items.push(item);
	}

	return items;
}

// ============================================================================
// Parity Report Presentation Instruction
// ============================================================================

/**
 * Build the ai_instruction for parity check results.
 * Defines a consistent presentation structure so any AI consuming this tool
 * produces scannable, structured reports with conversational analysis.
 */
function buildParityInstruction(
	componentName: string,
	parityScore: number,
	counts: { critical: number; major: number; minor: number; info: number },
	canonicalSource: string,
	totalDiscrepancies: number,
): string {
	if (totalDiscrepancies === 0) {
		return [
			`No discrepancies found for ${componentName}. Design and code are in sync (parity score: 100/100).`,
			"",
			"Present as:",
			"",
			`## ${componentName} — Parity Report`,
			`**Score: 100/100** | 0 critical | 0 major | 0 minor | 0 info`,
			"",
			"### Action Required",
			"None — design and code are fully aligned.",
			"",
			"### Verdict",
			"Ready for sign-off. All compared properties match between design and code.",
		].join("\n");
	}

	return [
		`Found ${totalDiscrepancies} discrepancies (parity score: ${parityScore}/100) for ${componentName}. Canonical source: '${canonicalSource}'.`,
		"",
		"Present results using this consistent structure:",
		"",
		`## ${componentName} — Parity Report`,
		`**Score: ${parityScore}/100** | ${counts.critical} critical | ${counts.major} major | ${counts.minor} minor | ${counts.info} info`,
		"",
		"### Action Required",
		"List discrepancies that represent real spec gaps needing resolution before sign-off.",
		"For each, state what differs and suggest the fix direction based on the canonical source.",
		"If no actionable items exist, write: \"None — design and code are aligned on all spec values.\"",
		"",
		"### Aligned",
		"Compact bulleted list of properties that matched between design and code (no discrepancy flagged).",
		"Include: colors/fills, border, spacing/padding, gap, typography, layout — whichever were compared and matched.",
		"This builds confidence in what's already correct.",
		"",
		"### Notes",
		"Conversational analysis of remaining items. Explain paradigm differences (e.g., Figma component properties vs React composition slots),",
		"note missing accessibility annotations, flag metadata differences, and provide editorial recommendations.",
		"This is where context and judgment live — interpret the findings, don't just list them.",
		"",
		"### Verdict",
		"One sentence: is this component ready for sign-off, does it need minor adjustments, or are there blockers?",
		"",
		"Categorization rules:",
		"- Critical/major discrepancies → always Action Required",
		"- Minor discrepancies that are real spec gaps (colors, spacing, radius, typography, tokens) → Action Required",
		"- Minor discrepancies that are paradigm differences (className prop, React-only behavioral props) → Notes",
		"- Info-level items → always Notes",
		"- Keep Action Required focused — if a developer only reads one section, this is it",
		"- The Aligned section should be scannable in under 5 seconds",
		"- Offer to apply fixes when actionable items exist",
	].join("\n");
}

// ============================================================================
// Documentation Section Generators
// ============================================================================

function generateFrontmatter(
	componentName: string,
	description: string,
	node: any,
	componentMeta: any,
	fileUrl: string,
	codeInfo?: CodeDocInfo,
	canonicalSource?: "figma" | "code" | "reconciled",
): string {
	const status = codeInfo?.changelog?.[0]
		? "stable"
		: componentMeta?.description?.toLowerCase().includes("deprecated")
			? "deprecated"
			: "stable";
	const version = codeInfo?.changelog?.[0]?.version || "1.0.0";
	const tags = [componentName.toLowerCase()];
	if (node.type === "COMPONENT_SET") tags.push("variants");
	if (node.componentPropertyDefinitions) tags.push("configurable");

	const lines = [
		"---",
		`title: ${componentName}`,
		`description: ${(description.split(/(?:When to Use|When NOT to Use|Variants|Content Requirements|Accessibility)/i)[0] || description).replace(/\n/g, " ").replace(/\s+/g, " ").trim() || `${componentName} component`}`,
		`status: ${status}`,
		`version: ${version}`,
		`category: components`,
		`tags: [${tags.join(", ")}]`,
		`figma: ${fileUrl}`,
	];

	if (codeInfo?.filePath) {
		lines.push(`source: ${codeInfo.filePath}`);
	}
	if (codeInfo?.packageName) {
		lines.push(`package: ${codeInfo.packageName}`);
	}
	if (canonicalSource) {
		lines.push(`canonical: ${canonicalSource}`);
	}

	lines.push(`lastUpdated: ${new Date().toISOString().split("T")[0]}`);
	lines.push("---");
	return lines.join("\n");
}

function generateOverviewSection(
	componentName: string,
	description: string,
	fileUrl: string,
	parsedDesc: ParsedDescription,
	codeInfo?: CodeDocInfo,
): string {
	const lines: string[] = [
		`# ${componentName}`,
		"",
	];

	// Build links line
	const links: string[] = [`**[Open in Figma](${fileUrl})**`];
	if (codeInfo?.filePath) {
		links.push(`**[View Source](${codeInfo.filePath})**`);
	}
	// Add Storybook link if stories file exists in sourceFiles
	const storiesFile = codeInfo?.sourceFiles?.find(
		(f) => f.role.toLowerCase().includes("storybook") || f.role.toLowerCase().includes("stories") || f.path.includes(".stories."),
	);
	if (storiesFile) {
		links.push(`**[Storybook](${storiesFile.path})**`);
	}
	lines.push(links.join(" | "));
	lines.push("");

	lines.push("## Overview");
	lines.push("");

	// Use parsed overview or fall back to raw description
	const overviewText = parsedDesc.overview || description?.split("\n")[0] || `The ${componentName} component.`;
	lines.push(overviewText);
	lines.push("");

	// Base component attribution
	if (codeInfo?.baseComponent) {
		const baseLink = codeInfo.baseComponent.url
			? `[${codeInfo.baseComponent.name}](${codeInfo.baseComponent.url})`
			: codeInfo.baseComponent.name;
		if (codeInfo.baseComponent.description) {
			lines.push(`Built on ${baseLink}, ${codeInfo.baseComponent.description}`);
		} else {
			lines.push(`Built on ${baseLink}.`);
		}
		lines.push("");
	}

	// When to Use
	if (parsedDesc.whenToUse.length > 0) {
		lines.push("### When to Use");
		lines.push("");
		for (const item of parsedDesc.whenToUse) {
			lines.push(`- ${item}`);
		}
		lines.push("");
	}

	// When NOT to Use
	if (parsedDesc.whenNotToUse.length > 0) {
		lines.push("### When NOT to Use");
		lines.push("");
		for (const item of parsedDesc.whenNotToUse) {
			lines.push(`- ${item}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

function generateStatesAndVariantsSection(
	node: any,
	variantData?: VariantColorData[],
): string {
	const props = node.componentPropertyDefinitions;
	if (!props || Object.keys(props).length === 0) return "";

	const lines = ["", "## Variants", ""];

	const variants: Array<{ name: string; values: string[]; defaultValue: string }> = [];
	const booleans: Array<{ name: string; defaultValue: boolean }> = [];
	const textProps: Array<{ name: string; defaultValue: string }> = [];

	for (const [rawName, def] of Object.entries(props) as Array<[string, any]>) {
		// Strip Figma internal ID suffixes like "#17100:0" from property names
		const name = rawName.replace(/#\d+:\d+$/, "").trim();
		if (def.type === "VARIANT") {
			variants.push({
				name,
				values: def.variantOptions || [],
				defaultValue: def.defaultValue || "",
			});
		} else if (def.type === "BOOLEAN") {
			booleans.push({ name, defaultValue: def.defaultValue ?? true });
		} else if (def.type === "TEXT") {
			textProps.push({ name, defaultValue: def.defaultValue || "" });
		}
	}

	// Variant matrix with per-variant color data
	if (variants.length > 0 && variantData && variantData.length > 0) {
		lines.push("### Variant Matrix");
		lines.push("");

		// Determine which columns to show based on available data
		const hasIcons = variantData.some((v) => v.icons.length > 0);
		const hasFills = variantData.some((v) => v.fills.length > 0);

		if (hasFills || hasIcons) {
			const headerParts = ["Variant", "Background"];
			if (hasIcons) headerParts.push("Icon");
			headerParts.push("Text/Icon Color");
			lines.push("| " + headerParts.join(" | ") + " |");

			const separatorParts = ["--------", "----------"];
			if (hasIcons) separatorParts.push("----");
			separatorParts.push("---------------");
			lines.push("|" + separatorParts.join("|") + "|");

			for (const vd of variantData) {
				const displayName = cleanVariantName(vd.variantName);

				// Get primary fill (background)
				const bgFill = vd.fills[0];
				const bgVal = bgFill
					? (bgFill.variableName ? `\`${bgFill.variableName}\` (${bgFill.hex})` : bgFill.hex)
					: "—";

				// Get primary text/icon color
				const textColor = vd.textColors[0] || vd.strokes[0];
				const textVal = textColor
					? (textColor.variableName ? `\`${textColor.variableName}\` (${textColor.hex})` : textColor.hex)
					: "—";

				const rowParts = [`**${displayName}**`, bgVal];
				if (hasIcons) {
					const icon = vd.icons[0]?.name || "—";
					rowParts.push(icon);
				}
				rowParts.push(textVal);
				lines.push("| " + rowParts.join(" | ") + " |");
			}
			lines.push("");
		}

		// Icon-to-variant mapping table
		if (hasIcons) {
			lines.push("### Icon Mapping");
			lines.push("");
			lines.push("| Variant | Figma Icon Instance |");
			lines.push("|---------|---------------------|");
			for (const vd of variantData) {
				const displayName = cleanVariantName(vd.variantName);
				const icon = vd.icons[0]?.name || "—";
				lines.push(`| ${displayName} | ${icon} |`);
			}
			lines.push("");
		}
	} else if (variants.length > 0) {
		// Fallback: simple variant table without color data
		lines.push("| Variant | Values | Default |");
		lines.push("|---------|--------|---------|");
		for (const v of variants) {
			lines.push(`| ${v.name} | ${v.values.join(", ")} | ${v.defaultValue} |`);
		}
		lines.push("");
	}

	// Configurable properties table (all property types)
	if (booleans.length > 0 || textProps.length > 0) {
		lines.push("### Configurable Properties");
		lines.push("");
		lines.push("| Property | Type | Default | Description |");
		lines.push("|----------|------|---------|-------------|");

		for (const v of variants) {
			lines.push(`| **${v.name}** | \`${v.values.map((val) => `"${val}"`).join(" \\| ")}\` | \`"${v.defaultValue}"\` | Changes visual treatment |`);
		}
		for (const b of booleans) {
			lines.push(`| **${b.name}** | \`boolean\` | \`${b.defaultValue}\` | Shows/hides ${b.name.toLowerCase()} element |`);
		}
		for (const t of textProps) {
			lines.push(`| **${t.name}** | \`string\` | \`"${t.defaultValue}"\` | Sets ${t.name.toLowerCase()} content |`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

/** Collected color entry from walking a node tree */
interface CollectedColor {
	hex: string;
	property: "fill" | "stroke" | "text";
	nodeName: string;
	variableId?: string;
}

/**
 * Recursively walk a node tree and collect all unique colors from fills, strokes, and text.
 * For COMPONENT_SET nodes, walks the first child (default variant) instead of the set frame.
 */
function collectNodeColors(node: any, colors: CollectedColor[], depth: number = 0, maxDepth: number = 3): void {
	if (depth > maxDepth) return;

	// For COMPONENT_SET, walk into the first child (default variant) for visual data
	if (node.type === "COMPONENT_SET" && node.children?.length > 0 && depth === 0) {
		collectNodeColors(node.children[0], colors, 0, maxDepth);
		return;
	}

	const isText = node.type === "TEXT";

	// Fills
	if (node.fills && Array.isArray(node.fills)) {
		for (const fill of node.fills) {
			if (fill.type === "SOLID" && fill.color && fill.visible !== false) {
				const hex = figmaRGBAToHex({ ...fill.color, a: fill.opacity ?? fill.color.a ?? 1 });
				colors.push({
					hex,
					property: isText ? "text" : "fill",
					nodeName: node.name || "",
					variableId: fill.boundVariables?.color?.id,
				});
			}
		}
	}

	// Strokes
	if (node.strokes && Array.isArray(node.strokes)) {
		for (const stroke of node.strokes) {
			if (stroke.type === "SOLID" && stroke.color && stroke.visible !== false) {
				const hex = figmaRGBAToHex({ ...stroke.color, a: stroke.opacity ?? stroke.color.a ?? 1 });
				colors.push({
					hex,
					property: "stroke",
					nodeName: node.name || "",
					variableId: stroke.boundVariables?.color?.id,
				});
			}
		}
	}

	// Recurse into children
	if (node.children && Array.isArray(node.children)) {
		for (const child of node.children) {
			collectNodeColors(child, colors, depth + 1, maxDepth);
		}
	}
}

/** Deduplicate collected colors, keeping the most descriptive context for each unique hex */
function deduplicateColors(colors: CollectedColor[]): CollectedColor[] {
	const seen = new Map<string, CollectedColor>();
	for (const c of colors) {
		const key = `${c.hex}:${c.property}`;
		if (!seen.has(key)) {
			seen.set(key, c);
		}
	}
	return Array.from(seen.values());
}

function generateVisualSpecsSection(
	node: any,
	enrichedData: EnrichedComponent | null,
	variantData?: VariantColorData[],
): string {
	const lines = ["", "## Token Specification", ""];

	// Build variable name lookup from enrichment data
	const varNameMap = new Map<string, string>();
	if (enrichedData?.variables_used) {
		for (const v of enrichedData.variables_used) {
			varNameMap.set(v.id, v.name);
		}
	}

	// Per-variant color token table
	if (variantData && variantData.length > 0) {
		lines.push("### Color Tokens");
		lines.push("");
		lines.push("| Element | Figma Variable | Value |");
		lines.push("|---------|---------------|-------|");

		for (const vd of variantData) {
			const nameMatch = vd.variantName.match(/Variant=([^,]+)/i);
			const displayName = nameMatch ? nameMatch[1].trim() : vd.variantName;

			// Section header for this variant
			lines.push(`| **${displayName}** | | |`);

			// Background fills
			for (const fill of vd.fills) {
				const varName = fill.variableName || (fill.variableId ? varNameMap.get(fill.variableId) : undefined);
				lines.push(
					`| Background | ${varName ? `\`${varName}\`` : "—"} | ${fill.hex} |`,
				);
			}

			// Text colors
			for (const text of vd.textColors) {
				const varName = text.variableName || (text.variableId ? varNameMap.get(text.variableId) : undefined);
				lines.push(
					`| Text (${text.nodeName}) | ${varName ? `\`${varName}\`` : "—"} | ${text.hex} |`,
				);
			}

			// Strokes
			for (const stroke of vd.strokes) {
				const varName = stroke.variableName || (stroke.variableId ? varNameMap.get(stroke.variableId) : undefined);
				lines.push(
					`| Stroke | ${varName ? `\`${varName}\`` : "—"} | ${stroke.hex} |`,
				);
			}
		}
		lines.push("");
	} else {
		// Fallback: collect from default variant
		const allColors: CollectedColor[] = [];
		collectNodeColors(node, allColors);
		const uniqueColors = deduplicateColors(allColors);

		if (uniqueColors.length > 0) {
			lines.push("### Colors & Fills");
			lines.push("| Property | Element | Value |");
			lines.push("|----------|---------|-------|");

			const order = { fill: 0, text: 1, stroke: 2 };
			uniqueColors.sort((a, b) => order[a.property] - order[b.property]);

			for (const c of uniqueColors) {
				const label = c.property === "fill" ? "Fill" : c.property === "text" ? "Text" : "Stroke";
				const tokenName = c.variableId ? varNameMap.get(c.variableId) : undefined;
				const value = tokenName ? `${c.hex} (\`${tokenName}\`)` : c.hex;
				lines.push(`| ${label} | ${c.nodeName} | ${value} |`);
			}
			lines.push("");
		}
	}

	// Spacing tokens with variable names
	const visualNode = resolveVisualNode(node);
	const spacingTokens = collectSpacingTokens(visualNode);
	if (spacingTokens.length > 0) {
		lines.push("### Spacing Tokens");
		lines.push("");
		lines.push("| Property | Figma Variable | Value |");
		lines.push("|----------|---------------|-------|");
		for (const token of spacingTokens) {
			const varDisplay = token.variableName ? `\`${token.variableName}\`` : "—";
			lines.push(`| ${token.property} | ${varDisplay} | ${token.value}px |`);
		}
		lines.push("");
	} else {
		// Fallback: simple spacing output
		const spacing = extractSpacingProperties(visualNode);
		const hasSpacing = Object.keys(spacing).length > 0;
		if (hasSpacing) {
			lines.push("### Spacing & Layout");
			if (spacing.paddingTop !== undefined || spacing.paddingRight !== undefined) {
				lines.push(
					`- Padding: ${spacing.paddingTop ?? 0}px ${spacing.paddingRight ?? 0}px ${spacing.paddingBottom ?? 0}px ${spacing.paddingLeft ?? 0}px`,
				);
			}
			if (spacing.gap !== undefined) lines.push(`- Gap: ${spacing.gap}px`);
			lines.push("");
		}

		if (visualNode.cornerRadius !== undefined) {
			lines.push(`- Border Radius: ${visualNode.cornerRadius}px`);
			lines.push("");
		}
	}

	// Token coverage
	if (enrichedData?.token_coverage !== undefined) {
		lines.push("### Token Coverage");
		lines.push(`Score: ${enrichedData.token_coverage}%`);
		if (enrichedData.hardcoded_values && enrichedData.hardcoded_values.length > 0) {
			lines.push(`| Hardcoded values: ${enrichedData.hardcoded_values.length}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

function generateImplementationSection(codeInfo?: CodeDocInfo): string {
	if (!codeInfo) return "";

	const lines = ["", "## Implementation", ""];

	// Source files table
	if (codeInfo.sourceFiles && codeInfo.sourceFiles.length > 0) {
		lines.push("### Source Files");
		lines.push("");
		lines.push("| File | Role | Variants |");
		lines.push("|------|------|----------|");
		for (const sf of codeInfo.sourceFiles) {
			lines.push(`| \`${sf.path}\` | ${sf.role} | ${sf.variants ?? "—"} |`);
		}
		lines.push("");
	}

	// Import statement
	if (codeInfo.importStatement) {
		lines.push("### Import");
		lines.push("");
		lines.push("```tsx");
		lines.push(codeInfo.importStatement);
		lines.push("```");
		lines.push("");
	}

	// CVA / variant definition
	if (codeInfo.variantDefinition) {
		lines.push("### Variant Definition");
		lines.push("");
		lines.push("```tsx");
		lines.push(codeInfo.variantDefinition);
		lines.push("```");
		lines.push("");
	}

	// Component API - main props
	if (codeInfo.props && codeInfo.props.length > 0) {
		lines.push("### Component API");
		lines.push("");
		lines.push("| Prop | Type | Default | Description |");
		lines.push("|------|------|---------|-------------|");
		for (const p of codeInfo.props) {
			lines.push(
				`| \`${p.name}\` | \`${p.type.replace(/\|/g, "\\|")}\` | ${p.defaultValue ? `\`${p.defaultValue}\`` : "—"} | ${p.description ?? "—"} |`,
			);
		}
		lines.push("");
	}

	// Sub-component APIs
	if (codeInfo.subComponents && codeInfo.subComponents.length > 0) {
		for (const sub of codeInfo.subComponents) {
			lines.push(`#### ${sub.name}`);
			lines.push("");
			if (sub.description) {
				lines.push(sub.description);
				lines.push("");
			}
			if (sub.element) {
				lines.push(`Renders a \`<${sub.element}>\`${sub.dataSlot ? ` with \`data-slot="${sub.dataSlot}"\`` : ""}.`);
				lines.push("");
			}
			if (sub.props && sub.props.length > 0) {
				lines.push("| Prop | Type | Default | Description |");
				lines.push("|------|------|---------|-------------|");
				for (const p of sub.props) {
					lines.push(
						`| \`${p.name}\` | \`${p.type.replace(/\|/g, "\\|")}\` | ${p.defaultValue ? `\`${p.defaultValue}\`` : "—"} | ${p.description ?? "—"} |`,
					);
				}
				lines.push("");
			}
		}
	}

	// Events
	if (codeInfo.events && codeInfo.events.length > 0) {
		lines.push("### Events");
		lines.push("");
		lines.push("| Event | Payload | Description |");
		lines.push("|-------|---------|-------------|");
		for (const e of codeInfo.events) {
			lines.push(`| ${e.name} | ${e.payload ?? "—"} | ${e.description ?? "—"} |`);
		}
		lines.push("");
	}

	// Slots
	if (codeInfo.slots && codeInfo.slots.length > 0) {
		lines.push("### Slots");
		lines.push("");
		for (const s of codeInfo.slots) {
			lines.push(`- **${s.name}**: ${s.description ?? ""}`);
		}
		lines.push("");
	}

	// Usage examples
	if (codeInfo.usageExamples && codeInfo.usageExamples.length > 0) {
		lines.push("### Usage Examples");
		lines.push("");
		for (const ex of codeInfo.usageExamples) {
			lines.push(`#### ${ex.title}`);
			lines.push("");
			lines.push(`\`\`\`${ex.language || "tsx"}`);
			lines.push(ex.code);
			lines.push("```");
			lines.push("");
		}
	}

	return lines.join("\n");
}

function generateAccessibilitySection(
	node: any,
	parsedDesc: ParsedDescription,
	codeInfo?: CodeDocInfo,
): string {
	const lines = ["", "## Accessibility", ""];

	// Use structured accessibility notes from parsed description
	if (parsedDesc.accessibilityNotes.length > 0) {
		for (const note of parsedDesc.accessibilityNotes) {
			lines.push(`- ${note}`);
		}
		lines.push("");
	} else {
		// Fallback: check raw description for accessibility content
		const description = node.descriptionMarkdown || node.description || "";
		if (description.toLowerCase().includes("aria") || description.toLowerCase().includes("accessibility")) {
			// Extract accessibility-related lines from description
			const descLines = description.split("\n");
			for (const line of descLines) {
				const lower = line.toLowerCase();
				if (lower.includes("aria") || lower.includes("accessibility") || lower.includes("screen reader") || lower.includes("keyboard") || lower.includes("focus") || lower.includes("wcag") || lower.includes("contrast")) {
					lines.push(`- ${line.trim().replace(/^[-*•]\s*/, "")}`);
				}
			}
			if (lines.length > 2) {
				lines.push("");
			} else {
				lines.push("_Accessibility mentions found in description but not in structured format. Review the component description for details._");
				lines.push("");
			}
		} else {
			lines.push("_No accessibility annotations found in Figma. Add annotations to the component description._");
			lines.push("");
		}
	}

	return lines.join("\n");
}

function generateChangelogSection(codeInfo?: CodeDocInfo): string {
	if (!codeInfo?.changelog || codeInfo.changelog.length === 0) return "";

	const lines = ["", "## Changelog", ""];
	lines.push("| Version | Date | Changes |");
	lines.push("|---------|------|---------|");
	for (const entry of codeInfo.changelog) {
		lines.push(`| ${entry.version} | ${entry.date} | ${entry.changes} |`);
	}
	lines.push("");

	return lines.join("\n");
}

// ============================================================================
// New Section Generators (Anatomy, Typography, Content Guidelines, Parity)
// ============================================================================

function generateAnatomySection(node: any): string {
	const lines = ["", "## Component Anatomy", ""];

	// For COMPONENT_SET, list all variants first
	if (node.type === "COMPONENT_SET" && node.children?.length > 0) {
		lines.push(`**${node.children.length} variants:**`);
		for (const child of node.children) {
			lines.push(`- ${cleanVariantName(child.name || "Unknown")}`);
		}
		lines.push("");
	}

	lines.push("### Design Structure (Figma)");
	lines.push("");

	const tree = buildAnatomyTree(node);
	if (tree.includes("└── ") || tree.includes("├── ")) {
		// Rich tree with children
		lines.push("```");
		lines.push(tree);
		lines.push("```");
	} else {
		// Shallow tree (REST API depth limitation)
		lines.push("```");
		lines.push(tree);
		lines.push("```");
		lines.push("");
		lines.push("_Note: Tree depth may be limited by the Figma REST API. Use the Desktop Bridge plugin for full node-level anatomy._");
	}
	lines.push("");

	return lines.join("\n");
}

function generateTypographySection(node: any): string {
	const textStyles = collectTypographyData(node);
	if (textStyles.length === 0) return "";

	const lines = ["", "## Typography", ""];
	lines.push("| Element | Font | Weight | Size | Line Height | Letter Spacing |");
	lines.push("|---------|------|--------|------|-------------|----------------|");

	// Deduplicate by font properties
	const seen = new Set<string>();
	for (const ts of textStyles) {
		const key = `${ts.fontFamily}:${ts.fontWeight}:${ts.fontSize}:${ts.lineHeight}`;
		if (seen.has(key)) continue;
		seen.add(key);
		lines.push(
			`| ${ts.nodeName} | ${ts.fontFamily} | ${ts.fontWeightName} (${ts.fontWeight}) | ${ts.fontSize}px | ${ts.lineHeight}px | ${ts.letterSpacing === 0 ? "0" : `${ts.letterSpacing}px`} |`,
		);
	}
	lines.push("");

	return lines.join("\n");
}

function generateContentGuidelinesSection(parsedDesc: ParsedDescription): string {
	if (parsedDesc.contentGuidelines.length === 0 && parsedDesc.additionalNotes.length === 0) return "";

	const lines = ["", "## Content Guidelines", ""];

	for (const section of parsedDesc.contentGuidelines) {
		lines.push(`### ${section.heading}`);
		lines.push("");
		for (const item of section.items) {
			lines.push(`- ${item}`);
		}
		lines.push("");
	}

	if (parsedDesc.additionalNotes.length > 0 && parsedDesc.contentGuidelines.length === 0) {
		for (const note of parsedDesc.additionalNotes) {
			lines.push(`- ${note}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

function generateParitySection(
	node: any,
	codeInfo: CodeDocInfo,
): string {
	const lines = ["", "## Design-Code Parity", ""];

	// Variant coverage - compare Figma variants with code variants if available
	// Use case-insensitive comparison: Figma uses "Default", code uses "default"
	const figmaVariantsRaw = new Map<string, string>(); // lowercase → original name
	if (node.type === "COMPONENT_SET" && node.children) {
		for (const child of node.children) {
			const match = child.name?.match(/Variant=([^,]+)/i) || child.name?.match(/^([^,=]+)/);
			if (match) {
				const raw = match[1].trim();
				figmaVariantsRaw.set(raw.toLowerCase(), raw);
			}
		}
	}

	// Try to extract code variants from variant definition or props
	const codeVariantsRaw = new Map<string, string>(); // lowercase → original name
	if (codeInfo.props) {
		const variantProp = codeInfo.props.find(
			(p) => p.name.toLowerCase() === "variant",
		);
		if (variantProp?.type) {
			// Match both single and double quoted values: "default" or 'default'
			const matches = variantProp.type.match(/["']([^"']+)["']/g);
			if (matches) {
				for (const m of matches) {
					const raw = m.replace(/["']/g, "");
					codeVariantsRaw.set(raw.toLowerCase(), raw);
				}
			}
		}
	}

	if (figmaVariantsRaw.size > 0 || codeVariantsRaw.size > 0) {
		// Merge by lowercase key
		const allKeys = new Set([...figmaVariantsRaw.keys(), ...codeVariantsRaw.keys()]);

		lines.push("### Variant Coverage");
		lines.push("");
		lines.push("| Variant | In Figma | In Code | Status |");
		lines.push("|---------|----------|---------|--------|");

		for (const key of allKeys) {
			const figmaName = figmaVariantsRaw.get(key);
			const codeName = codeVariantsRaw.get(key);
			const displayName = figmaName || codeName || key;
			const inFigma = figmaVariantsRaw.has(key);
			const inCode = codeVariantsRaw.has(key);
			let status: string;
			if (inFigma && inCode) {
				status = "In sync";
			} else if (inFigma && !inCode) {
				status = "Figma-only — needs code variant";
			} else {
				status = "Code-only — needs Figma variant";
			}
			lines.push(
				`| ${displayName} | ${inFigma ? "Yes" : "**No**"} | ${inCode ? "Yes" : "**No**"} | ${status} |`,
			);
		}
		lines.push("");
	}

	return lines.join("\n");
}

// ============================================================================
// CompanyDocsMCP Helper
// ============================================================================

/** Convert generated markdown into a CompanyDocsMCP-compatible content entry */
export function toCompanyDocsEntry(
	markdown: string,
	componentName: string,
	figmaUrl: string,
	systemName?: string,
): CompanyDocsContentEntry {
	return {
		title: componentName,
		content: markdown,
		category: "components",
		tags: [componentName.toLowerCase(), "design-system", "component"],
		metadata: {
			source: "figma-console-mcp",
			figmaUrl,
			systemName,
			generatedAt: new Date().toISOString(),
		},
	};
}

// ============================================================================
// Zod Schemas
// ============================================================================

const codeSpecSchema = z.object({
	filePath: z.string().optional().describe("Path to the component source file"),
	visual: z.object({
		backgroundColor: z.string().optional(),
		borderColor: z.string().optional(),
		borderWidth: z.number().optional(),
		borderRadius: z.union([z.number(), z.string()]).optional(),
		opacity: z.number().optional(),
		fills: z.array(z.object({ color: z.string().optional(), opacity: z.number().optional() })).optional(),
		strokes: z.array(z.object({ color: z.string().optional(), width: z.number().optional() })).optional(),
		effects: z.array(z.object({
			type: z.string(),
			color: z.string().optional(),
			offset: z.object({ x: z.number(), y: z.number() }).optional(),
			blur: z.number().optional(),
		})).optional(),
	}).optional().describe("Visual properties from code (colors, borders, effects)"),
	spacing: z.object({
		paddingTop: z.number().optional(),
		paddingRight: z.number().optional(),
		paddingBottom: z.number().optional(),
		paddingLeft: z.number().optional(),
		gap: z.number().optional(),
		width: z.union([z.number(), z.string()]).optional(),
		height: z.union([z.number(), z.string()]).optional(),
		minWidth: z.number().optional(),
		minHeight: z.number().optional(),
		maxWidth: z.number().optional(),
		maxHeight: z.number().optional(),
		layoutDirection: z.enum(["horizontal", "vertical"]).optional(),
	}).optional().describe("Spacing and layout properties from code"),
	typography: z.object({
		fontFamily: z.string().optional(),
		fontSize: z.number().optional(),
		fontWeight: z.union([z.number(), z.string()]).optional(),
		lineHeight: z.union([z.number(), z.string()]).optional(),
		letterSpacing: z.number().optional(),
		textAlign: z.string().optional(),
		textDecoration: z.string().optional(),
		textTransform: z.string().optional(),
	}).optional().describe("Typography properties from code"),
	tokens: z.object({
		usedTokens: z.array(z.string()).optional(),
		hardcodedValues: z.array(z.object({
			property: z.string(),
			value: z.union([z.string(), z.number()]),
		})).optional(),
		tokenPrefix: z.string().optional(),
	}).optional().describe("Design token usage in code"),
	componentAPI: z.object({
		props: z.array(z.object({
			name: z.string(),
			type: z.string(),
			required: z.boolean().optional(),
			defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
			description: z.string().optional(),
			values: z.array(z.string()).optional(),
		})).optional(),
		events: z.array(z.string()).optional(),
		slots: z.array(z.string()).optional(),
	}).optional().describe("Component API (props, events, slots)"),
	accessibility: z.object({
		role: z.string().optional(),
		ariaLabel: z.string().optional(),
		ariaRequired: z.boolean().optional(),
		keyboardInteractions: z.array(z.string()).optional(),
		contrastRatio: z.number().optional(),
		focusVisible: z.boolean().optional(),
	}).optional().describe("Accessibility properties from code"),
	metadata: z.object({
		name: z.string().optional(),
		description: z.string().optional(),
		status: z.string().optional(),
		version: z.string().optional(),
		tags: z.array(z.string()).optional(),
	}).optional().describe("Component metadata from code"),
}).describe("Structured code-side component data. Read the component source code first, then fill in the relevant sections.");

const codeDocInfoSchema = z.object({
	props: z.array(z.object({
		name: z.string(),
		type: z.string(),
		required: z.boolean().optional(),
		defaultValue: z.string().optional(),
		description: z.string().optional(),
	})).optional().describe("Component props"),
	events: z.array(z.object({
		name: z.string(),
		payload: z.string().optional(),
		description: z.string().optional(),
	})).optional().describe("Events emitted by the component"),
	slots: z.array(z.object({
		name: z.string(),
		description: z.string().optional(),
	})).optional().describe("Named slots"),
	importStatement: z.string().optional().describe("Import statement for the component"),
	usageExamples: z.array(z.object({
		title: z.string(),
		code: z.string(),
		language: z.string().optional(),
	})).optional().describe("Usage examples"),
	changelog: z.array(z.object({
		version: z.string(),
		date: z.string(),
		changes: z.string(),
	})).optional().describe("Changelog entries"),
	filePath: z.string().optional().describe("Component file path"),
	packageName: z.string().optional().describe("Package name"),
	variantDefinition: z.string().optional().describe("CVA or variant definition code block"),
	subComponents: z.array(z.object({
		name: z.string(),
		description: z.string().optional(),
		element: z.string().optional().describe("HTML element rendered (e.g., 'div', 'span')"),
		dataSlot: z.string().optional().describe("data-slot attribute value"),
		props: z.array(z.object({
			name: z.string(),
			type: z.string(),
			required: z.boolean().optional(),
			defaultValue: z.string().optional(),
			description: z.string().optional(),
		})).optional(),
	})).optional().describe("Sub-components that compose this component (e.g., AlertTitle, AlertDescription)"),
	sourceFiles: z.array(z.object({
		path: z.string(),
		role: z.string(),
		variants: z.number().optional(),
		description: z.string().optional(),
	})).optional().describe("All source files related to this component"),
	baseComponent: z.object({
		name: z.string(),
		url: z.string().optional(),
		description: z.string().optional(),
	}).optional().describe("Base component this extends (e.g., shadcn/ui Alert)"),
}).describe("Code-side documentation info. Read the component source code first, then fill in relevant sections. Include variantDefinition for CVA/variant code, subComponents for composable sub-parts, sourceFiles for all related files, and baseComponent for attribution.");

// ============================================================================
// Tool Registration
// ============================================================================

export function registerDesignCodeTools(
	server: McpServer,
	getFigmaAPI: () => Promise<FigmaAPI>,
	getCurrentUrl: () => string | null,
	variablesCache?: Map<string, { data: any; timestamp: number }>,
	options?: { isRemoteMode?: boolean },
	getDesktopConnector?: () => Promise<any>,
): void {
	const isRemoteMode = options?.isRemoteMode ?? false;

	// -----------------------------------------------------------------------
	// Tool: figma_check_design_parity
	// -----------------------------------------------------------------------
	server.tool(
		"figma_check_design_parity",
		"Compare a Figma component's design specs against code-side data to find discrepancies. Returns a parity score, categorized discrepancies, and actionable fix items for both design-side (Figma tool calls) and code-side (file edits). Read the component source code first, then pass the data in codeSpec.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe("Figma file URL. Uses current URL if omitted."),
			nodeId: z.string().describe("Component node ID (e.g., '695:313')"),
			codeSpec: codeSpecSchema,
			canonicalSource: z
				.enum(["design", "code"])
				.optional()
				.default("design")
				.describe("Which source is the canonical truth. Fixes will target the other side. Default: 'design'"),
			enrich: z
				.boolean()
				.optional()
				.default(true)
				.describe("Enable token coverage and enrichment analysis. Default: true"),
		},
		async ({ fileUrl, nodeId, codeSpec, canonicalSource = "design", enrich = true }) => {
			try {
				const url = fileUrl || getCurrentUrl();
				if (!url) {
					throw new Error(
						"No Figma file URL available. Pass the fileUrl parameter or ensure the Desktop Bridge plugin is open in Figma.",
					);
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					throw new Error(`Invalid Figma URL: ${url}`);
				}

				logger.info({ fileKey, nodeId, canonicalSource, enrich }, "Starting design-code parity check");

				const api = await getFigmaAPI();

				// Fetch component node
				const nodesResponse = await api.getNodes(fileKey, [nodeId], { depth: 2 });
				const nodeData = nodesResponse?.nodes?.[nodeId];
				if (!nodeData?.document) {
					throw new Error(`Node ${nodeId} not found in file ${fileKey}`);
				}
				const node = nodeData.document;

				// Resolve the node to use for visual/spacing/typography comparisons.
				// COMPONENT_SET frames have container styling (purple annotation stroke, etc.)
				// that are NOT actual design specs — the real properties live on the variants.
				const nodeForVisual = resolveVisualNode(node);
				if (nodeForVisual !== node) {
					logger.info({ defaultVariant: nodeForVisual.name, type: node.type }, "Using default variant for visual comparison");
				}

				// Fetch component metadata for descriptions
				let componentMeta: any = null;
				let allComponentsMeta: any[] | null = null;
				try {
					const componentsResponse = await api.getComponents(fileKey);
					if (componentsResponse?.meta?.components) {
						allComponentsMeta = componentsResponse.meta.components;
						componentMeta = allComponentsMeta!.find(
							(c: any) => c.node_id === nodeId,
						);
					}
				} catch {
					logger.warn("Could not fetch component metadata");
				}

				// Resolve COMPONENT_SET info (property definitions, set name)
				let setInfo = { setName: null as string | null, setNodeId: null as string | null, propertyDefinitions: {} as Record<string, any> };
				if (node.type === "COMPONENT_SET") {
					// We already have the set — read property definitions directly
					setInfo = {
						setName: node.name,
						setNodeId: nodeId,
						propertyDefinitions: node.componentPropertyDefinitions || {},
					};
				} else if (node.type === "COMPONENT" && isVariantName(node.name)) {
					try {
						setInfo = await resolveComponentSetInfo(api, fileKey, nodeId, componentMeta, allComponentsMeta);
						if (setInfo.setName) {
							logger.info({ setName: setInfo.setName, setNodeId: setInfo.setNodeId }, "Resolved parent component set");
						}
					} catch {
						logger.warn("Could not resolve parent component set");
					}
				}

				// Build a merged node for componentAPI comparison (use set's property definitions)
				const nodeForAPI = Object.keys(setInfo.propertyDefinitions).length > 0
					? { ...node, componentPropertyDefinitions: setInfo.propertyDefinitions }
					: node;

				// Enrichment for token analysis
				let enrichedData: EnrichedComponent | null = null;
				if (enrich) {
					try {
						const enrichmentOptions: EnrichmentOptions = {
							enrich: true,
							include_usage: true,
						};
						enrichedData = await enrichmentService.enrichComponent(
							node,
							fileKey,
							enrichmentOptions,
						);
					} catch {
						logger.warn("Enrichment failed, proceeding without token data");
					}
				}

				// Run all comparators (use nodeForVisual for design properties, nodeForAPI for component API)
				const discrepancies: ParityDiscrepancy[] = [];
				compareVisual(nodeForVisual, codeSpec, discrepancies);
				compareSpacing(nodeForVisual, codeSpec, discrepancies);
				compareTypography(nodeForVisual, codeSpec, discrepancies);
				compareTokens(enrichedData, codeSpec, discrepancies);
				compareComponentAPI(nodeForAPI, codeSpec, discrepancies);
				compareAccessibility(node, codeSpec, discrepancies);
				compareNaming(node, codeSpec, discrepancies);
				compareMetadata(node, componentMeta, codeSpec, discrepancies);

				// Sort by severity
				const severityOrder: Record<DiscrepancySeverity, number> = {
					critical: 0,
					major: 1,
					minor: 2,
					info: 3,
				};
				discrepancies.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

				// Calculate scores
				const counts = { critical: 0, major: 0, minor: 0, info: 0 };
				const categoryMap: Partial<Record<ParityCategory, number>> = {};
				for (const d of discrepancies) {
					counts[d.severity]++;
					categoryMap[d.category] = (categoryMap[d.category] || 0) + 1;
				}

				const parityScore = calculateParityScore(counts.critical, counts.major, counts.minor, counts.info);

				// Generate action items
				const actionItems = generateActionItems(
					discrepancies,
					nodeId,
					canonicalSource,
					codeSpec.filePath,
				);

				const resolvedName = resolveComponentName(node, setInfo.setName, codeSpec.metadata?.name || codeSpec.filePath?.split("/").pop()?.replace(/\.\w+$/, ""));

				const result: ParityCheckResult = {
					summary: {
						totalDiscrepancies: discrepancies.length,
						parityScore,
						byCritical: counts.critical,
						byMajor: counts.major,
						byMinor: counts.minor,
						byInfo: counts.info,
						categories: categoryMap,
					},
					discrepancies,
					actionItems,
					ai_instruction: buildParityInstruction(resolvedName, parityScore, counts, canonicalSource, discrepancies.length),
					designData: {
						name: node.name,
						resolvedName,
						type: node.type,
						isComponentSet: node.type === "COMPONENT_SET",
						defaultVariantName: node.type === "COMPONENT_SET" ? nodeForVisual.name : undefined,
						componentSetName: setInfo.setName,
						componentSetNodeId: setInfo.setNodeId,
						fills: nodeForVisual.fills,
						strokes: nodeForVisual.strokes,
						cornerRadius: nodeForVisual.cornerRadius,
						opacity: nodeForVisual.opacity,
						spacing: extractSpacingProperties(nodeForVisual),
						componentProperties: nodeForAPI.componentPropertyDefinitions
							? Object.keys(nodeForAPI.componentPropertyDefinitions)
							: [],
						tokenCoverage: enrichedData?.token_coverage,
					},
					codeData: codeSpec,
				};

				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error({ error: message, nodeId }, "Design parity check failed");
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: message,
								ai_instruction: `Design parity check failed: ${message}. Verify the nodeId is correct and the Figma file is accessible.`,
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_generate_component_doc
	// -----------------------------------------------------------------------
	server.tool(
		"figma_generate_component_doc",
		"Generate AI-complete component documentation from a Figma component. Produces structured markdown with anatomy, per-variant color tokens, typography, content guidelines (parsed from Figma description), icon mapping, spacing tokens, and design-code parity analysis. Merges Figma design data with optional code-side info (CVA definitions, sub-component APIs, source files). Output works with any docs platform. For richest output, read the component source code first and pass codeInfo.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe("Figma file URL. Uses current URL if omitted."),
			nodeId: z.string().describe("Component node ID (e.g., '695:313')"),
			codeInfo: codeDocInfoSchema.optional(),
			sections: z.object({
				overview: z.boolean().optional().default(true),
				anatomy: z.boolean().optional().default(true),
				statesAndVariants: z.boolean().optional().default(true),
				visualSpecs: z.boolean().optional().default(true),
				typography: z.boolean().optional().default(true),
				contentGuidelines: z.boolean().optional().default(true),
				behavior: z.boolean().optional().default(false),
				implementation: z.boolean().optional().default(true),
				accessibility: z.boolean().optional().default(true),
				relatedComponents: z.boolean().optional().default(false),
				changelog: z.boolean().optional().default(true),
				parity: z.boolean().optional().default(true),
			}).optional().describe("Toggle which sections to include"),
			outputPath: z.string().optional().describe("Suggested output file path"),
			systemName: z.string().optional().describe("Design system name for headers"),
			enrich: z.boolean().optional().default(true).describe("Enable enrichment for token data"),
			includeFrontmatter: z.boolean().optional().default(true).describe("Include YAML frontmatter metadata"),
		},
		async ({
			fileUrl,
			nodeId,
			codeInfo,
			sections,
			outputPath,
			systemName,
			enrich = true,
			includeFrontmatter = true,
		}) => {
			try {
				const url = fileUrl || getCurrentUrl();
				if (!url) {
					throw new Error(
						"No Figma file URL available. Pass the fileUrl parameter or ensure the Desktop Bridge plugin is open in Figma.",
					);
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					throw new Error(`Invalid Figma URL: ${url}`);
				}

				logger.info({ fileKey, nodeId, enrich }, "Generating component documentation");

				const api = await getFigmaAPI();

				// Fetch component node with deeper depth for anatomy & per-variant data
				const nodesResponse = await api.getNodes(fileKey, [nodeId], { depth: 4 });
				const nodeData = nodesResponse?.nodes?.[nodeId];
				if (!nodeData?.document) {
					throw new Error(`Node ${nodeId} not found in file ${fileKey}`);
				}
				const node = nodeData.document;

				// Resolve visual node (default variant for COMPONENT_SET, node itself otherwise)
				const nodeForVisual = resolveVisualNode(node);
				if (nodeForVisual !== node) {
					logger.info({ defaultVariant: nodeForVisual.name, type: node.type }, "Using default variant for visual specs in docs");
				}

				// Fetch component metadata
				let componentMeta: any = null;
				let allComponentsMeta: any[] | null = null;
				try {
					const componentsResponse = await api.getComponents(fileKey);
					if (componentsResponse?.meta?.components) {
						allComponentsMeta = componentsResponse.meta.components;
						componentMeta = allComponentsMeta!.find(
							(c: any) => c.node_id === nodeId,
						);
					}
				} catch {
					logger.warn("Could not fetch component metadata");
				}

				// Resolve COMPONENT_SET info (property definitions, set name)
				let setInfo = { setName: null as string | null, setNodeId: null as string | null, propertyDefinitions: {} as Record<string, any> };
				if (node.type === "COMPONENT_SET") {
					setInfo = {
						setName: node.name,
						setNodeId: nodeId,
						propertyDefinitions: node.componentPropertyDefinitions || {},
					};
				} else if (node.type === "COMPONENT" && isVariantName(node.name)) {
					try {
						setInfo = await resolveComponentSetInfo(api, fileKey, nodeId, componentMeta, allComponentsMeta);
						if (setInfo.setName) {
							logger.info({ setName: setInfo.setName, setNodeId: setInfo.setNodeId }, "Resolved parent component set for docs");
						}
					} catch {
						logger.warn("Could not resolve parent component set");
					}
				}

				// Use set's property definitions for variants section if available
				const nodeForVariants = Object.keys(setInfo.propertyDefinitions).length > 0
					? { ...node, componentPropertyDefinitions: setInfo.propertyDefinitions }
					: node;

				// Enrichment
				let enrichedData: EnrichedComponent | null = null;
				if (enrich) {
					try {
						const enrichmentOptions: EnrichmentOptions = {
							enrich: true,
							include_usage: true,
						};
						enrichedData = await enrichmentService.enrichComponent(
							node,
							fileKey,
							enrichmentOptions,
						);
					} catch {
						logger.warn("Enrichment failed, proceeding without token data");
					}
				}

				// Build variable name lookup for per-variant color collection
				const varNameMap = new Map<string, string>();
				if (enrichedData?.variables_used) {
					for (const v of enrichedData.variables_used) {
						varNameMap.set(v.id, v.name);
					}
				}

				// Collect per-variant color/icon data
				const variantData = collectAllVariantData(node, varNameMap);

				// Resolve clean component name (prefer set name over variant name)
				const componentName = resolveComponentName(node, setInfo.setName, codeInfo?.filePath?.split("/").pop()?.replace(/\.\w+$/, ""));

				// Prefer markdown description (has headers/bold markers for parsing) over plain text
				// REST API getNodes() often returns empty description for COMPONENT_SET nodes,
				// so fall back to Desktop Bridge plugin API which has the reliable description.
				let description = node.descriptionMarkdown || node.description || componentMeta?.description || "";
				if (!description && getDesktopConnector) {
					try {
						const connector = await getDesktopConnector();
						const bridgeResult = await connector.getComponentFromPluginUI(nodeId);
						if (bridgeResult.success && bridgeResult.component) {
							description = bridgeResult.component.descriptionMarkdown || bridgeResult.component.description || "";
							if (description) {
								logger.info("Fetched description via Desktop Bridge (REST API returned empty)");
							}
						}
					} catch {
						logger.warn("Desktop Bridge description fetch failed, proceeding without description");
					}
				}
				const fileUrl_ = `${url}?node-id=${nodeId.replace(":", "-")}`;

				// Parse the component description for structured content
				const parsedDesc = parseComponentDescription(description);

				// Determine canonical source
				const hasCodeInfo = codeInfo !== undefined && codeInfo !== null;
				const hasFigmaData = node.type === "COMPONENT" || node.type === "COMPONENT_SET";
				const canonicalSource: "figma" | "code" | "reconciled" =
					hasFigmaData && hasCodeInfo ? "reconciled"
					: hasCodeInfo ? "code"
					: "figma";

				// Resolve sections with defaults
				const s: DocSections = {
					overview: true,
					anatomy: true,
					statesAndVariants: true,
					visualSpecs: true,
					typography: true,
					contentGuidelines: true,
					behavior: false,
					implementation: true,
					accessibility: true,
					relatedComponents: false,
					changelog: true,
					parity: true,
					...sections,
				};

				// Build markdown
				const parts: string[] = [];
				const includedSections: string[] = [];

				if (includeFrontmatter) {
					parts.push(generateFrontmatter(componentName, description, node, componentMeta, fileUrl_, codeInfo, canonicalSource));
					parts.push("");
				}

				if (s.overview) {
					parts.push(generateOverviewSection(componentName, description, fileUrl_, parsedDesc, codeInfo));
					includedSections.push("overview");
				}

				if (s.anatomy) {
					const anatomySection = generateAnatomySection(node);
					if (anatomySection.trim()) {
						parts.push(anatomySection);
						includedSections.push("anatomy");
					}
				}

				if (s.statesAndVariants) {
					const variantsSection = generateStatesAndVariantsSection(nodeForVariants, variantData);
					if (variantsSection) {
						parts.push(variantsSection);
						includedSections.push("statesAndVariants");
					}
				}

				if (s.visualSpecs) {
					parts.push(generateVisualSpecsSection(nodeForVisual, enrichedData, variantData));
					includedSections.push("visualSpecs");
				}

				if (s.typography) {
					const typoSection = generateTypographySection(node);
					if (typoSection) {
						parts.push(typoSection);
						includedSections.push("typography");
					}
				}

				if (s.contentGuidelines) {
					const contentSection = generateContentGuidelinesSection(parsedDesc);
					if (contentSection) {
						parts.push(contentSection);
						includedSections.push("contentGuidelines");
					}
				}

				if (s.implementation && codeInfo) {
					parts.push(generateImplementationSection(codeInfo));
					includedSections.push("implementation");
				}

				if (s.accessibility) {
					parts.push(generateAccessibilitySection(node, parsedDesc, codeInfo));
					includedSections.push("accessibility");
				}

				if (s.parity && hasCodeInfo && hasFigmaData && codeInfo) {
					const paritySection = generateParitySection(node, codeInfo);
					if (paritySection) {
						parts.push(paritySection);
						includedSections.push("parity");
					}
				}

				if (s.changelog && codeInfo?.changelog) {
					parts.push(generateChangelogSection(codeInfo));
					includedSections.push("changelog");
				}

				const markdown = parts.join("\n");
				const sanitizedName = sanitizeComponentName(componentName);
				const suggestedPath = outputPath || `docs/components/${sanitizedName}.md`;

				// Build enhanced AI instruction
				const aiInstParts = [
					`Documentation generated for ${componentName} component (canonical source: ${canonicalSource}).`,
					`Ask the user where they'd like to save this file. Suggested path: ${suggestedPath}`,
				];
				if (!hasCodeInfo) {
					aiInstParts.push(
						"",
						"To enhance this documentation, read the component's source code and call this tool again with codeInfo including:",
						"- filePath: path to the main component file",
						"- importStatement: how to import the component",
						"- props: component API (name, type, required, defaultValue, description)",
						"- variantDefinition: CVA or variant definition code block",
						"- subComponents: sub-components with their props (e.g., AlertTitle, AlertDescription)",
						"- sourceFiles: all related source files with roles",
						"- baseComponent: base component attribution (e.g., shadcn/ui)",
						"- usageExamples: code examples for each variant/use case",
					);
				}

				const result: DocGenerationResult = {
					componentName,
					figmaNodeId: nodeId,
					fileKey,
					timestamp: new Date().toISOString(),
					markdown,
					includedSections,
					canonicalSource,
					dataSourceSummary: {
						figmaEnriched: enrichedData !== null,
						hasCodeInfo,
						variablesIncluded: enrichedData?.variables_used !== undefined,
						stylesIncluded: enrichedData?.styles_used !== undefined,
					},
					suggestedOutputPath: suggestedPath,
					ai_instruction: aiInstParts.join("\n"),
				};

				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error({ error: message, nodeId }, "Documentation generation failed");
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: message,
								ai_instruction: `Documentation generation failed: ${message}. Verify the nodeId is correct and the Figma file is accessible.`,
							}),
						},
					],
					isError: true,
				};
			}
		},
	);
}
