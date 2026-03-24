/**
 * Figma Annotations MCP Tools
 * Tools for reading, writing, and managing design annotations on Figma nodes.
 * Annotations are a Plugin API feature — requires Desktop Bridge plugin connection.
 *
 * Annotations are distinct from comments: they are node-level design specs that
 * can pin specific properties (fills, width, typography, etc.) and support
 * markdown-formatted labels. Designers use them to communicate animation timings,
 * accessibility requirements, interaction specs, and other implementation details
 * that don't fit in the description field.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "annotation-tools" });

// Valid AnnotationPropertyType values from the Figma Plugin API
// Sourced from @figma/plugin-typings — keep in sync with AnnotationPropertyType union
// Reference: https://developers.figma.com/docs/plugins/api/AnnotationProperty
const ANNOTATION_PROPERTY_TYPES = [
	"width",
	"height",
	"maxWidth",
	"minWidth",
	"maxHeight",
	"minHeight",
	"fills",
	"strokes",
	"effects",
	"strokeWeight",
	"cornerRadius",
	"textStyleId",
	"textAlignHorizontal",
	"fontFamily",
	"fontStyle",
	"fontSize",
	"fontWeight",
	"lineHeight",
	"letterSpacing",
	"itemSpacing",
	"padding",
	"layoutMode",
	"alignItems",
	"opacity",
	"mainComponent",
	"gridRowGap",
	"gridColumnGap",
	"gridRowCount",
	"gridColumnCount",
	"gridRowAnchorIndex",
	"gridColumnAnchorIndex",
	"gridRowSpan",
	"gridColumnSpan",
] as const;

// Zod schema for annotation property
const annotationPropertySchema = z.object({
	type: z
		.enum(ANNOTATION_PROPERTY_TYPES)
		.describe("Design property to pin (e.g., 'fills', 'width', 'fontSize')"),
});

// Zod schema for a single annotation
const annotationSchema = z.object({
	label: z
		.string()
		.optional()
		.describe("Plain text annotation label"),
	labelMarkdown: z
		.string()
		.optional()
		.describe("Rich text annotation label with markdown formatting. Supports bold, italic, links, lists, code, and headers."),
	properties: z
		.array(annotationPropertySchema)
		.optional()
		.describe("Design properties to pin to this annotation (e.g., fills, width, fontSize)"),
	categoryId: z
		.string()
		.optional()
		.describe("Annotation category ID. Use figma_get_annotation_categories to list available categories."),
});

// ============================================================================
// Tool Registration
// ============================================================================

export function registerAnnotationTools(
	server: McpServer,
	getDesktopConnector: () => Promise<any>,
): void {
	// -----------------------------------------------------------------------
	// Tool: figma_get_annotations
	// -----------------------------------------------------------------------
	server.tool(
		"figma_get_annotations",
		"Read annotations from a Figma node. Annotations are designer-authored specs attached to nodes — they can include notes (plain text or markdown), pinned design properties (fills, width, fontSize, etc.), and category labels. Use this to discover animation timings, interaction specs, accessibility requirements, and other implementation details that designers annotate directly on the design. Set include_children=true to get annotations from child nodes too (useful for full component documentation). Requires Desktop Bridge plugin.",
		{
			nodeId: z
				.string()
				.describe("Node ID to read annotations from (e.g., '695:313')"),
			include_children: z.preprocess(
				(v) => (typeof v === "string" ? v === "true" : v),
				z.boolean().optional().default(false),
			).describe("Also read annotations from child nodes. Useful for getting all annotations within a component tree."),
			depth: z.preprocess(
				(v) => (typeof v === "string" ? Number(v) : v),
				z.number().optional().default(1),
			).describe("How many levels deep to traverse when include_children is true (default: 1, max recommended: 5)"),
		},
		async ({ nodeId, include_children = false, depth = 1 }) => {
			try {
				logger.info({ nodeId, include_children, depth }, "Getting annotations");

				const connector = await getDesktopConnector();
				const result = await connector.getAnnotations(
					nodeId,
					include_children,
					Math.min(depth, 10),
				);

				if (!result || (result.success === false)) {
					throw new Error(result?.error || "Failed to get annotations");
				}

				// The result may come back as { success, data } (WebSocket) or directly as data
				const data = result.data || result;

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(data),
						},
					],
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error({ error }, "Failed to get annotations");

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: "get_annotations_failed",
								message: `Cannot get annotations. ${message}`,
								hint: "Annotations require the Desktop Bridge plugin to be running in Figma.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_set_annotations
	// -----------------------------------------------------------------------
	server.tool(
		"figma_set_annotations",
		"Write or clear annotations on a Figma node. Annotations communicate design specs to developers — use them to document animation timings, easing curves, interaction behaviors, accessibility requirements, and implementation notes. Supports plain text labels, rich markdown labels, pinned design properties, and annotation categories. Pass an empty array to clear all annotations. Use mode='append' to add to existing annotations, or mode='replace' (default) to overwrite. Requires Desktop Bridge plugin. This operation is undoable in Figma (Cmd+Z).",
		{
			nodeId: z
				.string()
				.describe("Node ID to write annotations to (e.g., '695:313')"),
			annotations: z.preprocess(
				(v) => {
					if (typeof v === "string") {
						try { return JSON.parse(v); } catch { return v; }
					}
					return v;
				},
				z.array(annotationSchema),
			).describe("Array of annotations to set. Each annotation can have a label (plain or markdown), pinned properties, and a category. Pass an empty array [] to clear all annotations."),
			mode: z
				.enum(["replace", "append"])
				.optional()
				.default("replace")
				.describe("'replace' (default) overwrites all existing annotations. 'append' adds new annotations while keeping existing ones."),
		},
		async ({ nodeId, annotations, mode = "replace" }) => {
			try {
				logger.info({ nodeId, count: annotations.length, mode }, "Setting annotations");

				const connector = await getDesktopConnector();
				const result = await connector.setAnnotations(nodeId, annotations, mode);

				if (!result || (result.success === false)) {
					throw new Error(result?.error || "Failed to set annotations");
				}

				const data = result.data || result;

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								...data,
								note: "Annotations set successfully. This operation is undoable in Figma (Cmd+Z).",
							}),
						},
					],
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error({ error }, "Failed to set annotations");

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: "set_annotations_failed",
								message: `Cannot set annotations. ${message}`,
								hint: "Annotations require the Desktop Bridge plugin to be running in Figma.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_get_annotation_categories
	// -----------------------------------------------------------------------
	server.tool(
		"figma_get_annotation_categories",
		"List available annotation categories in the current Figma file. Categories group annotations by purpose (e.g., interactions, accessibility, development notes). Use the returned category IDs when creating annotations with figma_set_annotations. Requires Desktop Bridge plugin.",
		{},
		async () => {
			try {
				logger.info("Getting annotation categories");

				const connector = await getDesktopConnector();
				const result = await connector.getAnnotationCategories();

				if (!result || (result.success === false)) {
					throw new Error(result?.error || "Failed to get annotation categories");
				}

				const data = result.data || result;

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(data),
						},
					],
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error({ error }, "Failed to get annotation categories");

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: "get_annotation_categories_failed",
								message: `Cannot get annotation categories. ${message}`,
								hint: "Annotation categories require the Desktop Bridge plugin to be running in Figma.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);
}
