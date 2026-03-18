import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "figjam-tools" });

/**
 * Register FigJam-specific tools.
 * These tools only work when the connected file is a FigJam board (editorType === 'figjam').
 * Used by both local mode (src/local.ts) and cloud mode (src/index.ts).
 */
export function registerFigJamTools(
	server: McpServer,
	getDesktopConnector: () => Promise<any>,
) {
	// ============================================================================
	// STICKY NOTE TOOLS
	// ============================================================================

	server.tool(
		"figjam_create_sticky",
		`Create a sticky note on a FigJam board. Only works in FigJam files.

**Colors:** YELLOW, BLUE, GREEN, PINK, ORANGE, PURPLE, RED, LIGHT_GRAY, GRAY (default: YELLOW)`,
		{
			text: z.string().describe("Text content for the sticky note"),
			color: z
				.string()
				.optional()
				.describe("Sticky color: YELLOW, BLUE, GREEN, PINK, ORANGE, PURPLE, RED, LIGHT_GRAY, GRAY"),
			x: z.number().optional().describe("X position on canvas"),
			y: z.number().optional().describe("Y position on canvas"),
		},
		async ({ text, color, x, y }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.createSticky({ text, color, x, y });
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				logger.error({ error }, "figjam_create_sticky failed");
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							hint: "This tool only works in FigJam files. Make sure the Desktop Bridge plugin is running in a FigJam board.",
						}),
					}],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figjam_create_stickies",
		`Batch create multiple sticky notes on a FigJam board. Use this to populate boards from structured data (meeting notes, brainstorm ideas, etc.).

**Colors:** YELLOW, BLUE, GREEN, PINK, ORANGE, PURPLE, RED, LIGHT_GRAY, GRAY`,
		{
			stickies: z
				.array(
					z.object({
						text: z.string().describe("Text content"),
						color: z.string().optional().describe("Sticky color"),
						x: z.number().optional().describe("X position"),
						y: z.number().optional().describe("Y position"),
					}),
				)
				.describe("Array of sticky note specifications"),
		},
		async ({ stickies }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.createStickies({ stickies });
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				logger.error({ error }, "figjam_create_stickies failed");
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							hint: "This tool only works in FigJam files.",
						}),
					}],
					isError: true,
				};
			}
		},
	);

	// ============================================================================
	// CONNECTOR TOOL
	// ============================================================================

	server.tool(
		"figjam_create_connector",
		`Connect two nodes with a connector line in FigJam. Use to create flowcharts, diagrams, and relationship maps.

Nodes must exist on the board (stickies, shapes, etc.). Use their node IDs from creation results.`,
		{
			startNodeId: z.string().describe("Node ID of the start element"),
			endNodeId: z.string().describe("Node ID of the end element"),
			label: z.string().optional().describe("Optional text label on the connector"),
		},
		async ({ startNodeId, endNodeId, label }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.createConnector({ startNodeId, endNodeId, label });
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				logger.error({ error }, "figjam_create_connector failed");
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							hint: "This tool only works in FigJam files. Both start and end nodes must exist.",
						}),
					}],
					isError: true,
				};
			}
		},
	);

	// ============================================================================
	// SHAPE WITH TEXT TOOL
	// ============================================================================

	server.tool(
		"figjam_create_shape_with_text",
		`Create a labeled shape on a FigJam board. Use for flowchart nodes, process diagrams, and visual organization.

**Shape types:** ROUNDED_RECTANGLE (default), DIAMOND, ELLIPSE, TRIANGLE_UP, TRIANGLE_DOWN, PARALLELOGRAM_RIGHT, PARALLELOGRAM_LEFT, ENG_DATABASE, ENG_QUEUE, ENG_FILE, ENG_FOLDER`,
		{
			text: z.string().optional().describe("Text label for the shape"),
			shapeType: z
				.string()
				.optional()
				.describe("Shape type: ROUNDED_RECTANGLE, DIAMOND, ELLIPSE, TRIANGLE_UP, etc."),
			x: z.number().optional().describe("X position on canvas"),
			y: z.number().optional().describe("Y position on canvas"),
		},
		async ({ text, shapeType, x, y }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.createShapeWithText({ text, shapeType, x, y });
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				logger.error({ error }, "figjam_create_shape_with_text failed");
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							hint: "This tool only works in FigJam files.",
						}),
					}],
					isError: true,
				};
			}
		},
	);

	// ============================================================================
	// TABLE TOOL
	// ============================================================================

	server.tool(
		"figjam_create_table",
		`Create a table on a FigJam board with optional cell data. Use for structured data display, comparison matrices, and organized information.

**Data format:** 2D array of strings, e.g. [["Header1", "Header2"], ["Row1Col1", "Row1Col2"]]`,
		{
			rows: z.number().describe("Number of rows"),
			columns: z.number().describe("Number of columns"),
			data: z
				.array(z.array(z.string()))
				.optional()
				.describe("2D array of cell text content (row-major order)"),
			x: z.number().optional().describe("X position on canvas"),
			y: z.number().optional().describe("Y position on canvas"),
		},
		async ({ rows, columns, data, x, y }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.createTable({ rows, columns, data, x, y });
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				logger.error({ error }, "figjam_create_table failed");
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							hint: "This tool only works in FigJam files.",
						}),
					}],
					isError: true,
				};
			}
		},
	);

	// ============================================================================
	// CODE BLOCK TOOL
	// ============================================================================

	server.tool(
		"figjam_create_code_block",
		`Create a code block on a FigJam board. Use for sharing code snippets, config examples, or technical documentation in collaborative boards.`,
		{
			code: z.string().describe("The code content"),
			language: z
				.string()
				.optional()
				.describe("Programming language (e.g., 'JAVASCRIPT', 'PYTHON', 'TYPESCRIPT', 'JSON', 'HTML', 'CSS')"),
			x: z.number().optional().describe("X position on canvas"),
			y: z.number().optional().describe("Y position on canvas"),
		},
		async ({ code, language, x, y }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.createCodeBlock({ code, language, x, y });
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				logger.error({ error }, "figjam_create_code_block failed");
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							hint: "This tool only works in FigJam files.",
						}),
					}],
					isError: true,
				};
			}
		},
	);

	// ============================================================================
	// LAYOUT HELPER TOOL
	// ============================================================================

	server.tool(
		"figjam_auto_arrange",
		`Arrange nodes on a FigJam board in a grid, horizontal row, or vertical column layout. Use after batch-creating elements to organize them neatly.`,
		{
			nodeIds: z.array(z.string()).describe("Array of node IDs to arrange"),
			layout: z
				.enum(["grid", "horizontal", "vertical"])
				.optional()
				.default("grid")
				.describe("Layout type: grid, horizontal, or vertical"),
			spacing: z.number().optional().default(40).describe("Spacing between nodes in pixels"),
			columns: z.number().optional().describe("Number of columns for grid layout (defaults to sqrt of node count)"),
		},
		async ({ nodeIds, layout, spacing, columns }) => {
			try {
				const connector = await getDesktopConnector();

				// Build arrangement code to execute in plugin context
				const gridCols = columns || Math.ceil(Math.sqrt(nodeIds.length));
				const nodeIdsJson = JSON.stringify(nodeIds);

				const code = `
					const nodeIds = ${nodeIdsJson};
					const layout = '${layout}';
					const spacing = ${spacing};
					const gridCols = ${gridCols};
					const nodes = [];
					for (const id of nodeIds) {
						const node = await figma.getNodeByIdAsync(id);
						if (node) nodes.push(node);
					}
					if (nodes.length === 0) throw new Error('No valid nodes found');

					let x = nodes[0].x;
					let y = nodes[0].y;
					const startX = x;
					let maxRowHeight = 0;

					for (let i = 0; i < nodes.length; i++) {
						const node = nodes[i];
						if (layout === 'horizontal') {
							node.x = x;
							node.y = y;
							x += node.width + spacing;
						} else if (layout === 'vertical') {
							node.x = x;
							node.y = y;
							y += node.height + spacing;
						} else {
							// grid
							const col = i % gridCols;
							const row = Math.floor(i / gridCols);
							if (col === 0 && i > 0) {
								y += maxRowHeight + spacing;
								maxRowHeight = 0;
								x = startX;
							}
							node.x = x;
							node.y = y;
							maxRowHeight = Math.max(maxRowHeight, node.height);
							x += node.width + spacing;
						}
					}
					return { arranged: nodes.length, layout: layout };
				`;

				const result = await connector.executeCodeViaUI(code, 10000);
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				logger.error({ error }, "figjam_auto_arrange failed");
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							hint: "Make sure all node IDs are valid and the Desktop Bridge plugin is running.",
						}),
					}],
					isError: true,
				};
			}
		},
	);
}
