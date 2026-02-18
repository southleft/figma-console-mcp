/**
 * Figma Slides MCP Tools
 * Tools for managing slides, transitions, and content in Figma Slides presentations.
 * Works via the Desktop Bridge plugin — all tools execute JavaScript in Figma's plugin context.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IFigmaConnector } from "./figma-connector.js";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "slides-tools" });

// Shared guard snippet injected at the start of every Slides tool's code string.
const SLIDES_GUARD = `if (figma.editorType !== 'slides') throw new Error('This tool requires a Figma Slides file. Current editor type: ' + figma.editorType);`;

// ============================================================================
// Tool Registration
// ============================================================================

export function registerSlidesTools(
	server: McpServer,
	getDesktopConnector: () => Promise<IFigmaConnector>,
): void {
	// -----------------------------------------------------------------------
	// Tool: figma_list_slides
	// -----------------------------------------------------------------------
	server.tool(
		"figma_list_slides",
		"List all slides in the current Figma Slides presentation with their IDs, names, positions, and skip status. Requires Desktop Bridge plugin in a Slides file.",
		{},
		async () => {
			try {
				const connector = await getDesktopConnector();
				const code = `
					${SLIDES_GUARD}
					const grid = figma.getSlideGrid();
					const result = [];
					for (let ri = 0; ri < grid.length; ri++) {
						const row = grid[ri];
						for (let ci = 0; ci < row.children.length; ci++) {
							const slide = row.children[ci];
							result.push({
								id: slide.id,
								name: slide.name,
								row: ri,
								col: ci,
								skipped: slide.skipped,
								childCount: slide.children.length
							});
						}
					}
					return result;
				`;
				const result = await connector.executeCodeViaUI(code, 10000);
				if (!result.success) {
					throw new Error(result.error || "Failed to list slides");
				}
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								slides: result.result,
								count: Array.isArray(result.result) ? result.result.length : 0,
							}),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "Failed to list slides");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_get_slide_content
	// -----------------------------------------------------------------------
	server.tool(
		"figma_get_slide_content",
		"Get the content tree of a specific slide including all text, shapes, and frames. Returns node hierarchy with properties.",
		{
			slideId: z.string().describe("The node ID of the slide, e.g. '1:23'"),
		},
		async ({ slideId }) => {
			try {
				const connector = await getDesktopConnector();
				const code = `
					${SLIDES_GUARD}
					const node = await figma.getNodeByIdAsync(${JSON.stringify(slideId)});
					if (!node || node.type !== 'SLIDE') throw new Error('Slide not found: ${slideId.replace(/'/g, "\\'")}');
					function serialize(n) {
						const base = { id: n.id, type: n.type, name: n.name, x: n.x, y: n.y, width: n.width, height: n.height };
						if (n.type === 'TEXT') { base.characters = n.characters; base.fontSize = n.fontSize; }
						if ('children' in n && n.children.length > 0) { base.children = n.children.map(serialize); }
						return base;
					}
					return { id: node.id, name: node.name, children: node.children.map(serialize) };
				`;
				const result = await connector.executeCodeViaUI(code, 10000);
				if (!result.success) {
					throw new Error(result.error || "Failed to get slide content");
				}
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result.result) }],
				};
			} catch (error) {
				logger.error({ error }, "Failed to get slide content");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_create_slide
	// -----------------------------------------------------------------------
	server.tool(
		"figma_create_slide",
		"Create a new blank slide in the Figma Slides presentation. Optionally specify grid position.",
		{
			row: z
				.number()
				.optional()
				.describe("Row index in the slide grid (0-based)"),
			col: z
				.number()
				.optional()
				.describe("Column index in the slide grid (0-based)"),
		},
		async ({ row, col }) => {
			try {
				const connector = await getDesktopConnector();
				const positionArg =
					row !== undefined && col !== undefined
						? `{ row: ${row}, col: ${col} }`
						: "";
				const code = `
					${SLIDES_GUARD}
					const slide = figma.createSlide(${positionArg});
					return { id: slide.id, name: slide.name };
				`;
				const result = await connector.executeCodeViaUI(code, 10000);
				if (!result.success) {
					throw new Error(result.error || "Failed to create slide");
				}
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result.result) }],
				};
			} catch (error) {
				logger.error({ error }, "Failed to create slide");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_delete_slide
	// -----------------------------------------------------------------------
	server.tool(
		"figma_delete_slide",
		"Delete a slide from the presentation. WARNING: This is a destructive operation (can be undone with Figma's undo).",
		{
			slideId: z.string().describe("The node ID of the slide to delete"),
		},
		async ({ slideId }) => {
			try {
				const connector = await getDesktopConnector();
				const code = `
					${SLIDES_GUARD}
					const node = await figma.getNodeByIdAsync(${JSON.stringify(slideId)});
					if (!node || node.type !== 'SLIDE') throw new Error('Slide not found: ${slideId.replace(/'/g, "\\'")}');
					const name = node.name;
					node.remove();
					return { deleted: ${JSON.stringify(slideId)}, name: name };
				`;
				const result = await connector.executeCodeViaUI(code, 5000);
				if (!result.success) {
					throw new Error(result.error || "Failed to delete slide");
				}
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result.result) }],
				};
			} catch (error) {
				logger.error({ error }, "Failed to delete slide");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_duplicate_slide
	// -----------------------------------------------------------------------
	server.tool(
		"figma_duplicate_slide",
		"Duplicate an existing slide. The clone is placed adjacent to the original.",
		{
			slideId: z.string().describe("The node ID of the slide to duplicate"),
		},
		async ({ slideId }) => {
			try {
				const connector = await getDesktopConnector();
				const code = `
					${SLIDES_GUARD}
					const node = await figma.getNodeByIdAsync(${JSON.stringify(slideId)});
					if (!node || node.type !== 'SLIDE') throw new Error('Slide not found: ${slideId.replace(/'/g, "\\'")}');
					const clone = node.clone();
					return { originalId: ${JSON.stringify(slideId)}, newId: clone.id, name: clone.name };
				`;
				const result = await connector.executeCodeViaUI(code, 5000);
				if (!result.success) {
					throw new Error(result.error || "Failed to duplicate slide");
				}
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result.result) }],
				};
			} catch (error) {
				logger.error({ error }, "Failed to duplicate slide");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_get_slide_grid
	// -----------------------------------------------------------------------
	server.tool(
		"figma_get_slide_grid",
		"Get the 2D slide grid layout showing how slides are organized in rows and columns.",
		{},
		async () => {
			try {
				const connector = await getDesktopConnector();
				const code = `
					${SLIDES_GUARD}
					const grid = figma.getSlideGrid();
					return grid.map((row, ri) => ({
						rowIndex: ri,
						rowId: row.id,
						slides: row.children.map((s, ci) => ({ id: s.id, name: s.name, col: ci, skipped: s.skipped }))
					}));
				`;
				const result = await connector.executeCodeViaUI(code, 10000);
				if (!result.success) {
					throw new Error(result.error || "Failed to get slide grid");
				}
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result.result) }],
				};
			} catch (error) {
				logger.error({ error }, "Failed to get slide grid");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_reorder_slides
	// -----------------------------------------------------------------------
	server.tool(
		"figma_reorder_slides",
		"Reorder slides by providing a new 2D array of slide IDs. Each inner array represents a row in the grid.",
		{
			grid: z
				.array(z.array(z.string()))
				.describe(
					"2D array of slide IDs representing the new order, e.g. [['1:2','1:3'],['1:4']]",
				),
		},
		async ({ grid }) => {
			try {
				const connector = await getDesktopConnector();
				const gridJson = JSON.stringify(grid);
				const code = `
					${SLIDES_GUARD}
					const newGrid = ${gridJson};
					const rows = [];
					for (const rowIds of newGrid) {
						const row = figma.createSlideRow();
						for (const sid of rowIds) {
							const node = await figma.getNodeByIdAsync(sid);
							if (node && node.type === 'SLIDE') row.appendChild(node);
						}
						rows.push(row);
					}
					figma.setSlideGrid(rows);
					return { success: true, rows: rows.length };
				`;
				const result = await connector.executeCodeViaUI(code, 15000);
				if (!result.success) {
					throw new Error(result.error || "Failed to reorder slides");
				}
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result.result) }],
				};
			} catch (error) {
				logger.error({ error }, "Failed to reorder slides");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_set_slide_transition
	// -----------------------------------------------------------------------
	server.tool(
		"figma_set_slide_transition",
		"Set the transition effect for a slide (style, duration, easing curve). Triggers on click by default.",
		{
			slideId: z.string().describe("The node ID of the slide"),
			style: z
				.enum([
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
				])
				.describe("Transition style"),
			duration: z
				.number()
				.optional()
				.default(0.4)
				.describe("Duration in seconds (0.01 to 10)"),
			curve: z
				.enum([
					"LINEAR",
					"EASE_IN",
					"EASE_OUT",
					"EASE_IN_AND_OUT",
					"EASE_IN_BACK",
					"EASE_OUT_BACK",
					"EASE_IN_AND_OUT_BACK",
				])
				.optional()
				.default("EASE_IN_AND_OUT")
				.describe("Easing curve"),
		},
		async ({ slideId, style, duration, curve }) => {
			try {
				const connector = await getDesktopConnector();
				const code = `
					${SLIDES_GUARD}
					const node = await figma.getNodeByIdAsync(${JSON.stringify(slideId)});
					if (!node || node.type !== 'SLIDE') throw new Error('Slide not found: ${slideId.replace(/'/g, "\\'")}');
					node.setSlideTransition({
						style: ${JSON.stringify(style)},
						duration: ${duration},
						curve: ${JSON.stringify(curve)},
						timing: { type: 'ON_CLICK' }
					});
					return { id: node.id, transition: node.getSlideTransition() };
				`;
				const result = await connector.executeCodeViaUI(code, 5000);
				if (!result.success) {
					throw new Error(result.error || "Failed to set slide transition");
				}
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result.result) }],
				};
			} catch (error) {
				logger.error({ error }, "Failed to set slide transition");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_get_slide_transition
	// -----------------------------------------------------------------------
	server.tool(
		"figma_get_slide_transition",
		"Get the current transition settings for a slide.",
		{
			slideId: z.string().describe("The node ID of the slide"),
		},
		async ({ slideId }) => {
			try {
				const connector = await getDesktopConnector();
				const code = `
					${SLIDES_GUARD}
					const node = await figma.getNodeByIdAsync(${JSON.stringify(slideId)});
					if (!node || node.type !== 'SLIDE') throw new Error('Slide not found: ${slideId.replace(/'/g, "\\'")}');
					return { id: node.id, transition: node.getSlideTransition() };
				`;
				const result = await connector.executeCodeViaUI(code, 5000);
				if (!result.success) {
					throw new Error(result.error || "Failed to get slide transition");
				}
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result.result) }],
				};
			} catch (error) {
				logger.error({ error }, "Failed to get slide transition");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_set_slides_view_mode
	// -----------------------------------------------------------------------
	server.tool(
		"figma_set_slides_view_mode",
		"Toggle the Figma Slides viewport between grid view and single-slide view.",
		{
			mode: z
				.enum(["grid", "single-slide"])
				.describe("Either 'grid' or 'single-slide'"),
		},
		async ({ mode }) => {
			try {
				const connector = await getDesktopConnector();
				const code = `
					${SLIDES_GUARD}
					figma.viewport.slidesMode = ${JSON.stringify(mode)};
					return { mode: figma.viewport.slidesMode };
				`;
				const result = await connector.executeCodeViaUI(code, 5000);
				if (!result.success) {
					throw new Error(result.error || "Failed to set slides view mode");
				}
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result.result) }],
				};
			} catch (error) {
				logger.error({ error }, "Failed to set slides view mode");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_get_focused_slide
	// -----------------------------------------------------------------------
	server.tool(
		"figma_get_focused_slide",
		"Get the slide currently focused in single-slide view.",
		{},
		async () => {
			try {
				const connector = await getDesktopConnector();
				const code = `
					${SLIDES_GUARD}
					const focused = figma.currentPage.focusedSlide;
					if (!focused) return { focused: null };
					return { id: focused.id, name: focused.name };
				`;
				const result = await connector.executeCodeViaUI(code, 5000);
				if (!result.success) {
					throw new Error(result.error || "Failed to get focused slide");
				}
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result.result) }],
				};
			} catch (error) {
				logger.error({ error }, "Failed to get focused slide");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_focus_slide
	// -----------------------------------------------------------------------
	server.tool(
		"figma_focus_slide",
		"Navigate to and focus a specific slide in single-slide view.",
		{
			slideId: z.string().describe("The node ID of the slide to focus"),
		},
		async ({ slideId }) => {
			try {
				const connector = await getDesktopConnector();
				const code = `
					${SLIDES_GUARD}
					const node = await figma.getNodeByIdAsync(${JSON.stringify(slideId)});
					if (!node || node.type !== 'SLIDE') throw new Error('Slide not found: ${slideId.replace(/'/g, "\\'")}');
					figma.viewport.slidesMode = 'single-slide';
					figma.currentPage.focusedSlide = node;
					return { focused: node.id, name: node.name };
				`;
				const result = await connector.executeCodeViaUI(code, 5000);
				if (!result.success) {
					throw new Error(result.error || "Failed to focus slide");
				}
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result.result) }],
				};
			} catch (error) {
				logger.error({ error }, "Failed to focus slide");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_skip_slide
	// -----------------------------------------------------------------------
	server.tool(
		"figma_skip_slide",
		"Toggle whether a slide is skipped during presentation mode.",
		{
			slideId: z.string().describe("The node ID of the slide"),
			skipped: z
				.boolean()
				.describe("True to skip the slide, false to include it"),
		},
		async ({ slideId, skipped }) => {
			try {
				const connector = await getDesktopConnector();
				const code = `
					${SLIDES_GUARD}
					const node = await figma.getNodeByIdAsync(${JSON.stringify(slideId)});
					if (!node || node.type !== 'SLIDE') throw new Error('Slide not found: ${slideId.replace(/'/g, "\\'")}');
					node.skipped = ${skipped};
					return { id: node.id, skipped: node.skipped };
				`;
				const result = await connector.executeCodeViaUI(code, 5000);
				if (!result.success) {
					throw new Error(result.error || "Failed to set slide skip status");
				}
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result.result) }],
				};
			} catch (error) {
				logger.error({ error }, "Failed to set slide skip status");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_add_text_to_slide
	// -----------------------------------------------------------------------
	server.tool(
		"figma_add_text_to_slide",
		"Add a new text element to a specific slide. Uses Inter font by default.",
		{
			slideId: z.string().describe("The node ID of the slide"),
			text: z.string().describe("The text content"),
			x: z.number().optional().default(100).describe("X position"),
			y: z.number().optional().default(100).describe("Y position"),
			fontSize: z
				.number()
				.optional()
				.default(24)
				.describe("Font size in pixels"),
		},
		async ({ slideId, text, x, y, fontSize }) => {
			try {
				const connector = await getDesktopConnector();
				const code = `
					${SLIDES_GUARD}
					const slide = await figma.getNodeByIdAsync(${JSON.stringify(slideId)});
					if (!slide || slide.type !== 'SLIDE') throw new Error('Slide not found: ${slideId.replace(/'/g, "\\'")}');
					const textNode = figma.createText();
					await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
					textNode.characters = ${JSON.stringify(text)};
					textNode.fontSize = ${fontSize};
					textNode.x = ${x};
					textNode.y = ${y};
					slide.appendChild(textNode);
					return { id: textNode.id, text: textNode.characters };
				`;
				const result = await connector.executeCodeViaUI(code, 10000);
				if (!result.success) {
					throw new Error(result.error || "Failed to add text to slide");
				}
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result.result) }],
				};
			} catch (error) {
				logger.error({ error }, "Failed to add text to slide");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_add_shape_to_slide
	// -----------------------------------------------------------------------
	server.tool(
		"figma_add_shape_to_slide",
		"Add a rectangle or ellipse shape to a specific slide with optional fill color.",
		{
			slideId: z.string().describe("The node ID of the slide"),
			shapeType: z
				.enum(["RECTANGLE", "ELLIPSE"])
				.describe("RECTANGLE or ELLIPSE"),
			x: z.number().describe("X position"),
			y: z.number().describe("Y position"),
			width: z.number().describe("Width in pixels"),
			height: z.number().describe("Height in pixels"),
			fillColor: z
				.string()
				.optional()
				.default("#CCCCCC")
				.describe("Hex color e.g. '#FF5733'. Defaults to '#CCCCCC'"),
		},
		async ({ slideId, shapeType, x, y, width, height, fillColor }) => {
			try {
				const connector = await getDesktopConnector();
				const createFn =
					shapeType === "ELLIPSE" ? "createEllipse" : "createRectangle";
				const code = `
					${SLIDES_GUARD}
					const slide = await figma.getNodeByIdAsync(${JSON.stringify(slideId)});
					if (!slide || slide.type !== 'SLIDE') throw new Error('Slide not found: ${slideId.replace(/'/g, "\\'")}');
					const shape = figma.${createFn}();
					shape.x = ${x};
					shape.y = ${y};
					shape.resize(${width}, ${height});
					const hex = ${JSON.stringify(fillColor)}.replace('#', '');
					const r = parseInt(hex.substring(0, 2), 16) / 255;
					const g = parseInt(hex.substring(2, 4), 16) / 255;
					const b = parseInt(hex.substring(4, 6), 16) / 255;
					shape.fills = [{ type: 'SOLID', color: { r, g, b } }];
					slide.appendChild(shape);
					return { id: shape.id, type: shape.type };
				`;
				const result = await connector.executeCodeViaUI(code, 5000);
				if (!result.success) {
					throw new Error(result.error || "Failed to add shape to slide");
				}
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result.result) }],
				};
			} catch (error) {
				logger.error({ error }, "Failed to add shape to slide");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				};
			}
		},
	);
}
