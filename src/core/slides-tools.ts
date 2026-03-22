import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "slides-tools" });

/** Maximum text length for slide content */
const MAX_TEXT_LENGTH = 10000;
/** Maximum font size */
const MAX_FONT_SIZE = 1000;
/** Maximum shape dimension */
const MAX_DIMENSION = 10000;
/** Maximum slides per grid row */
const MAX_GRID_ROW = 50;
/** Maximum grid rows */
const MAX_GRID_ROWS = 50;

/** Valid transition styles */
const TRANSITION_STYLES = [
	"NONE",
	"DISSOLVE",
	"SLIDE_FROM_LEFT",
	"SLIDE_FROM_RIGHT",
	"SLIDE_FROM_TOP",
	"SLIDE_FROM_BOTTOM",
	"PUSH_FROM_LEFT",
	"PUSH_FROM_RIGHT",
	"PUSH_FROM_TOP",
	"PUSH_FROM_BOTTOM",
	"MOVE_FROM_LEFT",
	"MOVE_FROM_RIGHT",
	"MOVE_FROM_TOP",
	"MOVE_FROM_BOTTOM",
	"SLIDE_OUT_TO_LEFT",
	"SLIDE_OUT_TO_RIGHT",
	"SLIDE_OUT_TO_TOP",
	"SLIDE_OUT_TO_BOTTOM",
	"MOVE_OUT_TO_LEFT",
	"MOVE_OUT_TO_RIGHT",
	"MOVE_OUT_TO_TOP",
	"MOVE_OUT_TO_BOTTOM",
	"SMART_ANIMATE",
] as const;

/** Valid easing curves */
/** Valid easing curves (Figma Slides uses a different set from the general Plugin API) */
const EASING_CURVES = [
	"LINEAR",
	"EASE_IN",
	"EASE_OUT",
	"EASE_IN_AND_OUT",
	"GENTLE",
	"QUICK",
	"BOUNCY",
	"SLOW",
] as const;

/** Valid shape types for slides */
const SLIDE_SHAPE_TYPES = ["RECTANGLE", "ELLIPSE"] as const;

/** Valid view modes */
const VIEW_MODES = ["grid", "single-slide"] as const;

/**
 * Register Figma Slides tools.
 * These tools only work when the connected file is a Figma Slides presentation (editorType === 'slides').
 * Used by both local mode (src/local.ts) and cloud mode (src/index.ts).
 */
export function registerSlidesTools(
	server: McpServer,
	getDesktopConnector: () => Promise<any>,
): void {
	// ============================================================================
	// READ TOOLS — Query slide data
	// ============================================================================

	server.tool(
		"figma_list_slides",
		`List all slides in the current Figma Slides presentation with their IDs, names, grid positions, and skip status. Only works in Slides files.`,
		{},
		async () => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.listSlides();
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								slides: result.data || result.result,
								count: Array.isArray(result.data || result.result)
									? (result.data || result.result).length
									: 0,
							}),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_list_slides failed");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "This tool only works in Figma Slides files. Make sure the Desktop Bridge plugin is running in a Slides presentation.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_get_slide_content",
		`Get the content tree of a specific slide including all text, shapes, and frames. Returns node hierarchy with properties.`,
		{
			slideId: z
				.string()
				.max(50)
				.describe("The node ID of the slide, e.g. '1:23'"),
		},
		async ({ slideId }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.getSlideContent({ slideId });
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(result) },
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_get_slide_content failed");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "This tool only works in Figma Slides files.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_get_slide_grid",
		`Get the 2D slide grid layout showing how slides are organized in rows and columns.`,
		{},
		async () => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.getSlideGrid();
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(result) },
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_get_slide_grid failed");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "This tool only works in Figma Slides files.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_get_slide_transition",
		`Get the current transition settings for a slide (style, duration, easing curve, timing).`,
		{
			slideId: z
				.string()
				.max(50)
				.describe("The node ID of the slide"),
		},
		async ({ slideId }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.getSlideTransition({ slideId });
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(result) },
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_get_slide_transition failed");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "This tool only works in Figma Slides files.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_get_focused_slide",
		`Get the slide currently focused in single-slide view.`,
		{},
		async () => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.getFocusedSlide();
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(result) },
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_get_focused_slide failed");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "This tool only works in Figma Slides files.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// ============================================================================
	// WRITE TOOLS — Create and modify slides
	// ============================================================================

	server.tool(
		"figma_create_slide",
		`Create a new blank slide in the Figma Slides presentation. Optionally specify grid position.`,
		{
			row: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe("Row index in the slide grid (0-based)"),
			col: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe("Column index in the slide grid (0-based)"),
		},
		async ({ row, col }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.createSlide({ row, col });
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(result) },
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_create_slide failed");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "This tool only works in Figma Slides files.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_delete_slide",
		`Delete a slide from the presentation. WARNING: This is a destructive operation (can be undone with Figma's undo).`,
		{
			slideId: z
				.string()
				.max(50)
				.describe("The node ID of the slide to delete"),
		},
		async ({ slideId }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.deleteSlide({ slideId });
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(result) },
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_delete_slide failed");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "This tool only works in Figma Slides files.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_duplicate_slide",
		`Duplicate an existing slide. The clone is placed adjacent to the original.`,
		{
			slideId: z
				.string()
				.max(50)
				.describe("The node ID of the slide to duplicate"),
		},
		async ({ slideId }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.duplicateSlide({ slideId });
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(result) },
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_duplicate_slide failed");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "This tool only works in Figma Slides files.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_reorder_slides",
		`Reorder slides by providing a new 2D array of slide IDs. Each inner array represents a row in the grid. WARNING: This is a destructive operation.`,
		{
			grid: z
				.array(z.array(z.string().max(50)).max(MAX_GRID_ROW))
				.max(MAX_GRID_ROWS)
				.describe(
					"2D array of slide IDs representing the new order, e.g. [['1:2','1:3'],['1:4']]",
				),
		},
		async ({ grid }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.reorderSlides({ grid });
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(result) },
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_reorder_slides failed");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "This tool only works in Figma Slides files.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_set_slide_transition",
		`Set the transition effect for a slide (style, duration, easing curve). Triggers on click by default.`,
		{
			slideId: z
				.string()
				.max(50)
				.describe("The node ID of the slide"),
			style: z
				.enum(TRANSITION_STYLES)
				.describe("Transition style"),
			duration: z
				.number()
				.min(0.01)
				.max(10)
				.optional()
				.default(0.4)
				.describe("Duration in seconds (0.01 to 10)"),
			curve: z
				.enum(EASING_CURVES)
				.optional()
				.default("EASE_IN_AND_OUT")
				.describe("Easing curve"),
		},
		async ({ slideId, style, duration, curve }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.setSlideTransition({
					slideId,
					style,
					duration,
					curve,
				});
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(result) },
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_set_slide_transition failed");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "This tool only works in Figma Slides files.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_skip_slide",
		`Toggle whether a slide is skipped during presentation mode.`,
		{
			slideId: z
				.string()
				.max(50)
				.describe("The node ID of the slide"),
			skip: z
				.boolean()
				.describe("True to skip the slide, false to include it"),
		},
		async ({ slideId, skip }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.skipSlide({ slideId, skip });
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(result) },
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_skip_slide failed");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "This tool only works in Figma Slides files.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_add_text_to_slide",
		`Add a new text element to a specific slide. Uses Inter font by default.`,
		{
			slideId: z
				.string()
				.max(50)
				.describe("The node ID of the slide"),
			text: z
				.string()
				.max(MAX_TEXT_LENGTH)
				.describe("The text content"),
			x: z.number().optional().default(100).describe("X position"),
			y: z.number().optional().default(100).describe("Y position"),
			fontSize: z
				.number()
				.min(1)
				.max(MAX_FONT_SIZE)
				.optional()
				.default(24)
				.describe("Font size in pixels"),
		},
		async ({ slideId, text, x, y, fontSize }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.addTextToSlide({
					slideId,
					text,
					x,
					y,
					fontSize,
				});
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(result) },
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_add_text_to_slide failed");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "This tool only works in Figma Slides files.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_add_shape_to_slide",
		`Add a rectangle or ellipse shape to a specific slide with optional fill color.`,
		{
			slideId: z
				.string()
				.max(50)
				.describe("The node ID of the slide"),
			shapeType: z
				.enum(SLIDE_SHAPE_TYPES)
				.describe("Shape type"),
			x: z.number().describe("X position"),
			y: z.number().describe("Y position"),
			width: z
				.number()
				.min(1)
				.max(MAX_DIMENSION)
				.describe("Width in pixels"),
			height: z
				.number()
				.min(1)
				.max(MAX_DIMENSION)
				.describe("Height in pixels"),
			fillColor: z
				.string()
				.regex(/^#[0-9a-fA-F]{6}$/, "Must be a 6-digit hex color like '#FF5733'")
				.optional()
				.default("#CCCCCC")
				.describe("Hex color e.g. '#FF5733'"),
		},
		async ({ slideId, shapeType, x, y, width, height, fillColor }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.addShapeToSlide({
					slideId,
					shapeType,
					x,
					y,
					width,
					height,
					fillColor,
				});
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(result) },
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_add_shape_to_slide failed");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "This tool only works in Figma Slides files.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// ============================================================================
	// NAVIGATION TOOLS — Control slide view
	// ============================================================================

	server.tool(
		"figma_set_slides_view_mode",
		`Toggle the Figma Slides viewport between grid view and single-slide view.`,
		{
			mode: z
				.enum(VIEW_MODES)
				.describe("View mode"),
		},
		async ({ mode }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.setSlidesViewMode({ mode });
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(result) },
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_set_slides_view_mode failed");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "This tool only works in Figma Slides files.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_focus_slide",
		`Navigate to and focus a specific slide in single-slide view.`,
		{
			slideId: z
				.string()
				.max(50)
				.describe("The node ID of the slide to focus"),
		},
		async ({ slideId }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.focusSlide({ slideId });
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(result) },
					],
				};
			} catch (error) {
				logger.error({ error }, "figma_focus_slide failed");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
								hint: "This tool only works in Figma Slides files.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);
}
