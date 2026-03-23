import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "buzz-tools" });

const MAX_NODE_IDS = 200;
const MAX_GRID_INDEX = 1000;
const MAX_DIMENSION = 10000;
const MAX_NAME_LENGTH = 500;
const MAX_ASSET_TYPE_LENGTH = 100;
const BUZZ_VIEW_MODES = ["grid", "single-asset"] as const;

/**
 * Register Figma Buzz tools.
 * These tools only work when the connected file is a Figma Buzz file (editorType === 'buzz').
 * Used by both local mode (src/local.ts) and cloud mode (src/index.ts).
 */
export function registerBuzzTools(
	server: McpServer,
	getDesktopConnector: () => Promise<any>,
): void {
	server.tool(
		"figma_buzz_get_canvas_grid",
		"Get the 2D canvas grid layout for the current Figma Buzz file. Returns rows and asset positions so AI agents can reason about asset placement.",
		{},
		async () => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.getCanvasGrid();
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				logger.error({ error }, "figma_buzz_get_canvas_grid failed");
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							hint: "This tool only works in Figma Buzz files. Make sure the Desktop Bridge plugin is running in a Buzz file.",
						}),
					}],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_buzz_create_canvas_row",
		"Create a new row in the Figma Buzz canvas grid. Optionally specify the row index.",
		{
			rowIndex: z.number().int().min(0).max(MAX_GRID_INDEX).optional().describe("Optional row index for the new grid row."),
		},
		async ({ rowIndex }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.createCanvasRow({ rowIndex });
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				logger.error({ error }, "figma_buzz_create_canvas_row failed");
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							hint: "This tool only works in Figma Buzz files.",
						}),
					}],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_buzz_move_nodes_to_coord",
		"Move one or more nodes to a specific coordinate in the Figma Buzz canvas grid.",
		{
			nodeIds: z.array(z.string()).min(1).max(MAX_NODE_IDS).describe(`Node IDs to move (max ${MAX_NODE_IDS}).`),
			rowIndex: z.number().int().min(0).max(MAX_GRID_INDEX).optional().describe("Target row index."),
			columnIndex: z.number().int().min(0).max(MAX_GRID_INDEX).optional().describe("Target column index."),
		},
		async ({ nodeIds, rowIndex, columnIndex }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.moveNodesToCoord({ nodeIds, rowIndex, columnIndex });
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				logger.error({ error }, "figma_buzz_move_nodes_to_coord failed");
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							hint: "This tool only works in Figma Buzz files. All node IDs must exist in the current file.",
						}),
					}],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_buzz_get_canvas_view",
		"Get the current Figma Buzz canvas view (`grid` or `single-asset`).",
		{},
		async () => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.getCanvasView();
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				logger.error({ error }, "figma_buzz_get_canvas_view failed");
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							hint: "This tool only works in Figma Buzz files.",
						}),
					}],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_buzz_set_canvas_view",
		"Set the Figma Buzz canvas view to either `grid` or `single-asset`.",
		{
			view: z.enum(BUZZ_VIEW_MODES).describe("Canvas view mode."),
		},
		async ({ view }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.setCanvasView({ view });
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				logger.error({ error }, "figma_buzz_set_canvas_view failed");
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							hint: "This tool only works in Figma Buzz files.",
						}),
					}],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_buzz_get_focused_asset",
		"Get the currently focused asset in single-asset view for a Figma Buzz file.",
		{},
		async () => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.getFocusedAsset();
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				logger.error({ error }, "figma_buzz_get_focused_asset failed");
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							hint: "This tool only works in Figma Buzz files.",
						}),
					}],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_buzz_focus_asset",
		"Focus a specific asset in a Figma Buzz file. Automatically switches to `single-asset` view first.",
		{
			nodeId: z.string().describe("Node ID of the asset to focus."),
		},
		async ({ nodeId }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.focusAsset({ nodeId });
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				logger.error({ error }, "figma_buzz_focus_asset failed");
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							hint: "This tool only works in Figma Buzz files. The node must exist and be focusable in the current file.",
						}),
					}],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_buzz_create_frame",
		"Create a grid-aware Buzz frame using Figma Buzz's native frame creation API. Optionally set grid position, name, and size.",
		{
			row: z.number().int().min(0).max(MAX_GRID_INDEX).optional().describe("Optional grid row index."),
			col: z.number().int().min(0).max(MAX_GRID_INDEX).optional().describe("Optional grid column index."),
			name: z.string().max(MAX_NAME_LENGTH).optional().describe("Optional frame name."),
			width: z.number().min(1).max(MAX_DIMENSION).optional().describe("Optional frame width in pixels."),
			height: z.number().min(1).max(MAX_DIMENSION).optional().describe("Optional frame height in pixels."),
		},
		async ({ row, col, name, width, height }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.createBuzzFrame({ row, col, name, width, height });
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				logger.error({ error }, "figma_buzz_create_frame failed");
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							hint: "This tool only works in Figma Buzz files.",
						}),
					}],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_buzz_get_asset_type",
		"Get the Buzz asset type assigned to a node.",
		{
			nodeId: z.string().describe("Node ID to inspect."),
		},
		async ({ nodeId }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.getBuzzAssetType({ nodeId });
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				logger.error({ error }, "figma_buzz_get_asset_type failed");
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							hint: "This tool only works in Figma Buzz files.",
						}),
					}],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_buzz_set_asset_type",
		"Set the Buzz asset type on a node. Asset type is passed through as a string so the runtime can validate the current Buzz API set.",
		{
			nodeId: z.string().describe("Node ID to update."),
			assetType: z.string().min(1).max(MAX_ASSET_TYPE_LENGTH).describe("Buzz asset type string, e.g. `INSTAGRAM_STORY`."),
		},
		async ({ nodeId, assetType }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.setBuzzAssetType({ nodeId, assetType });
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				logger.error({ error }, "figma_buzz_set_asset_type failed");
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							hint: "This tool only works in Figma Buzz files. The asset type must be valid for the current Buzz runtime.",
						}),
					}],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_buzz_smart_resize",
		"Smart resize a Buzz node using Figma Buzz's native resize API.",
		{
			nodeId: z.string().describe("Node ID to resize."),
			width: z.number().min(1).max(MAX_DIMENSION).describe("Target width in pixels."),
			height: z.number().min(1).max(MAX_DIMENSION).describe("Target height in pixels."),
		},
		async ({ nodeId, width, height }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.smartResizeBuzzNode({ nodeId, width, height });
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				logger.error({ error }, "figma_buzz_smart_resize failed");
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							hint: "This tool only works in Figma Buzz files.",
						}),
					}],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_buzz_get_text_content",
		"Extract Buzz text fields from an asset. Returns serialized field metadata only; no field mutation is performed in v1.",
		{
			nodeId: z.string().describe("Node ID to inspect."),
		},
		async ({ nodeId }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.getBuzzTextContent({ nodeId });
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				logger.error({ error }, "figma_buzz_get_text_content failed");
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							hint: "This tool only works in Figma Buzz files.",
						}),
					}],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"figma_buzz_get_media_content",
		"Extract Buzz media fields from an asset. Returns serialized field metadata only; no media mutation is performed in v1.",
		{
			nodeId: z.string().describe("Node ID to inspect."),
		},
		async ({ nodeId }) => {
			try {
				const connector = await getDesktopConnector();
				const result = await connector.getBuzzMediaContent({ nodeId });
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				logger.error({ error }, "figma_buzz_get_media_content failed");
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							error: error instanceof Error ? error.message : String(error),
							hint: "This tool only works in Figma Buzz files.",
						}),
					}],
					isError: true,
				};
			}
		},
	);
}
