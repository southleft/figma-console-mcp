/**
 * Buzz Tools Tests
 *
 * Unit tests for all 13 Figma Buzz tools.
 * Tests the registerBuzzTools() function with a mock McpServer and connector.
 */

import { registerBuzzTools } from "../src/core/buzz-tools";

interface RegisteredTool {
	name: string;
	description: string;
	schema: any;
	handler: (args: any) => Promise<any>;
}

function createMockServer() {
	const tools: Record<string, RegisteredTool> = {};
	return {
		tool: jest.fn(
			(name: string, description: string, schema: any, handler: any) => {
				tools[name] = { name, description, schema, handler };
			},
		),
		_tools: tools,
		_getTool(name: string): RegisteredTool {
			return tools[name];
		},
	};
}

function createMockConnector(overrides: Record<string, jest.Mock> = {}) {
	return {
		getCanvasGrid: jest.fn().mockResolvedValue({
			success: true,
			data: {
				rows: [
					{
						rowIndex: 0,
						assets: [
							{ nodeId: "1:1", name: "Instagram Story", columnIndex: 0 },
							{ nodeId: "1:2", name: "Post", columnIndex: 1 },
						],
					},
				],
			},
		}),
		createCanvasRow: jest.fn().mockResolvedValue({
			success: true,
			data: { rowIndex: 1 },
		}),
		moveNodesToCoord: jest.fn().mockResolvedValue({
			success: true,
			data: { moved: 2, rowIndex: 1, columnIndex: 0 },
		}),
		getCanvasView: jest.fn().mockResolvedValue({
			success: true,
			data: { view: "grid" },
		}),
		setCanvasView: jest.fn().mockResolvedValue({
			success: true,
			data: { view: "single-asset" },
		}),
		getFocusedAsset: jest.fn().mockResolvedValue({
			success: true,
			data: { focused: { id: "1:1", name: "Instagram Story" } },
		}),
		focusAsset: jest.fn().mockResolvedValue({
			success: true,
			data: { focused: { id: "1:2", name: "Post" }, view: "single-asset" },
		}),
		createBuzzFrame: jest.fn().mockResolvedValue({
			success: true,
			data: { id: "1:10", name: "New Asset", width: 1080, height: 1080 },
		}),
		getBuzzAssetType: jest.fn().mockResolvedValue({
			success: true,
			data: { nodeId: "1:1", assetType: "INSTAGRAM_STORY" },
		}),
		setBuzzAssetType: jest.fn().mockResolvedValue({
			success: true,
			data: { nodeId: "1:1", assetType: "INSTAGRAM_POST" },
		}),
		smartResizeBuzzNode: jest.fn().mockResolvedValue({
			success: true,
			data: { nodeId: "1:1", width: 1080, height: 1350 },
		}),
		getBuzzTextContent: jest.fn().mockResolvedValue({
			success: true,
			data: {
				nodeId: "1:1",
				fields: [
					{ index: 0, text: "Launch day", keys: ["text"] },
					{ index: 1, text: "Limited offer", keys: ["text"] },
				],
			},
		}),
		getBuzzMediaContent: jest.fn().mockResolvedValue({
			success: true,
			data: {
				nodeId: "1:1",
				fields: [
					{ index: 0, mediaType: "image", keys: ["mediaType"] },
				],
			},
		}),
		...overrides,
	};
}

describe("Buzz Tools", () => {
	let server: ReturnType<typeof createMockServer>;
	let mockConnector: ReturnType<typeof createMockConnector>;

	beforeEach(() => {
		server = createMockServer();
		mockConnector = createMockConnector();

		registerBuzzTools(server as any, async () => mockConnector as any);
	});

	it("registers all 13 Buzz tools", () => {
		expect(server.tool).toHaveBeenCalledTimes(13);
		const names = server.tool.mock.calls.map((call: any[]) => call[0]);
		expect(names).toContain("figma_buzz_get_canvas_grid");
		expect(names).toContain("figma_buzz_create_canvas_row");
		expect(names).toContain("figma_buzz_move_nodes_to_coord");
		expect(names).toContain("figma_buzz_get_canvas_view");
		expect(names).toContain("figma_buzz_set_canvas_view");
		expect(names).toContain("figma_buzz_get_focused_asset");
		expect(names).toContain("figma_buzz_focus_asset");
		expect(names).toContain("figma_buzz_create_frame");
		expect(names).toContain("figma_buzz_get_asset_type");
		expect(names).toContain("figma_buzz_set_asset_type");
		expect(names).toContain("figma_buzz_smart_resize");
		expect(names).toContain("figma_buzz_get_text_content");
		expect(names).toContain("figma_buzz_get_media_content");
	});

	describe("figma_buzz_get_canvas_grid", () => {
		it("returns the Buzz canvas grid", async () => {
			const tool = server._getTool("figma_buzz_get_canvas_grid");
			const result = await tool.handler({});

			expect(mockConnector.getCanvasGrid).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(true);
			expect(parsed.data.rows[0].assets).toHaveLength(2);
		});

		it("returns a Buzz-only error when called outside Buzz", async () => {
			mockConnector.getCanvasGrid.mockRejectedValue(
				new Error("GET_CANVAS_GRID is only available in Buzz files"),
			);

			const tool = server._getTool("figma_buzz_get_canvas_grid");
			const result = await tool.handler({});

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toContain("only available in Buzz");
			expect(parsed.hint).toContain("Buzz files");
		});
	});

	describe("figma_buzz_create_canvas_row", () => {
		it("creates a row at an explicit index", async () => {
			const tool = server._getTool("figma_buzz_create_canvas_row");
			const result = await tool.handler({ rowIndex: 1 });

			expect(mockConnector.createCanvasRow).toHaveBeenCalledWith({ rowIndex: 1 });
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_buzz_move_nodes_to_coord", () => {
		it("moves multiple nodes to a grid coordinate", async () => {
			const tool = server._getTool("figma_buzz_move_nodes_to_coord");
			const result = await tool.handler({
				nodeIds: ["1:1", "1:2"],
				rowIndex: 1,
				columnIndex: 0,
			});

			expect(mockConnector.moveNodesToCoord).toHaveBeenCalledWith({
				nodeIds: ["1:1", "1:2"],
				rowIndex: 1,
				columnIndex: 0,
			});
			expect(result.isError).toBeUndefined();
		});

		it("returns a node-not-found error cleanly", async () => {
			mockConnector.moveNodesToCoord.mockRejectedValue(
				new Error("Node not found: 99:99"),
			);

			const tool = server._getTool("figma_buzz_move_nodes_to_coord");
			const result = await tool.handler({
				nodeIds: ["99:99"],
				rowIndex: 1,
				columnIndex: 0,
			});

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toContain("Node not found");
		});
	});

	describe("figma_buzz_get_canvas_view", () => {
		it("returns the current Buzz canvas view", async () => {
			const tool = server._getTool("figma_buzz_get_canvas_view");
			const result = await tool.handler({});

			expect(mockConnector.getCanvasView).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.data.view).toBe("grid");
		});
	});

	describe("figma_buzz_set_canvas_view", () => {
		it("sets the Buzz canvas view", async () => {
			const tool = server._getTool("figma_buzz_set_canvas_view");
			const result = await tool.handler({ view: "single-asset" });

			expect(mockConnector.setCanvasView).toHaveBeenCalledWith({
				view: "single-asset",
			});
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_buzz_get_focused_asset", () => {
		it("returns focused asset info", async () => {
			const tool = server._getTool("figma_buzz_get_focused_asset");
			const result = await tool.handler({});

			expect(mockConnector.getFocusedAsset).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.data.focused.id).toBe("1:1");
		});

		it("supports no focused asset", async () => {
			mockConnector.getFocusedAsset.mockResolvedValue({
				success: true,
				data: { focused: null },
			});

			const tool = server._getTool("figma_buzz_get_focused_asset");
			const result = await tool.handler({});

			expect(result.isError).toBeUndefined();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.data.focused).toBeNull();
		});
	});

	describe("figma_buzz_focus_asset", () => {
		it("focuses an asset in single-asset view", async () => {
			const tool = server._getTool("figma_buzz_focus_asset");
			const result = await tool.handler({ nodeId: "1:2" });

			expect(mockConnector.focusAsset).toHaveBeenCalledWith({ nodeId: "1:2" });
			expect(result.isError).toBeUndefined();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.data.view).toBe("single-asset");
		});

		it("returns an invalid focus error cleanly", async () => {
			mockConnector.focusAsset.mockRejectedValue(
				new Error("Node is not focusable: 99:99"),
			);

			const tool = server._getTool("figma_buzz_focus_asset");
			const result = await tool.handler({ nodeId: "99:99" });

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toContain("focusable");
		});
	});

	describe("figma_buzz_create_frame", () => {
		it("creates a Buzz frame with placement and size", async () => {
			const tool = server._getTool("figma_buzz_create_frame");
			const result = await tool.handler({
				row: 0,
				col: 1,
				name: "Promo Asset",
				width: 1080,
				height: 1080,
			});

			expect(mockConnector.createBuzzFrame).toHaveBeenCalledWith({
				row: 0,
				col: 1,
				name: "Promo Asset",
				width: 1080,
				height: 1080,
			});
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_buzz_get_asset_type", () => {
		it("returns the current Buzz asset type", async () => {
			const tool = server._getTool("figma_buzz_get_asset_type");
			const result = await tool.handler({ nodeId: "1:1" });

			expect(mockConnector.getBuzzAssetType).toHaveBeenCalledWith({ nodeId: "1:1" });
			expect(result.isError).toBeUndefined();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.data.assetType).toBe("INSTAGRAM_STORY");
		});
	});

	describe("figma_buzz_set_asset_type", () => {
		it("sets the Buzz asset type using a plain string", async () => {
			const tool = server._getTool("figma_buzz_set_asset_type");
			const result = await tool.handler({
				nodeId: "1:1",
				assetType: "INSTAGRAM_POST",
			});

			expect(mockConnector.setBuzzAssetType).toHaveBeenCalledWith({
				nodeId: "1:1",
				assetType: "INSTAGRAM_POST",
			});
			expect(result.isError).toBeUndefined();
		});

		it("preserves runtime validation errors", async () => {
			mockConnector.setBuzzAssetType.mockRejectedValue(
				new Error("Unsupported Buzz asset type: MADE_UP_TYPE"),
			);

			const tool = server._getTool("figma_buzz_set_asset_type");
			const result = await tool.handler({
				nodeId: "1:1",
				assetType: "MADE_UP_TYPE",
			});

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toContain("Unsupported Buzz asset type");
		});
	});

	describe("figma_buzz_smart_resize", () => {
		it("smart resizes a Buzz node", async () => {
			const tool = server._getTool("figma_buzz_smart_resize");
			const result = await tool.handler({
				nodeId: "1:1",
				width: 1080,
				height: 1350,
			});

			expect(mockConnector.smartResizeBuzzNode).toHaveBeenCalledWith({
				nodeId: "1:1",
				width: 1080,
				height: 1350,
			});
			expect(result.isError).toBeUndefined();
		});

		it("returns resize errors cleanly", async () => {
			mockConnector.smartResizeBuzzNode.mockRejectedValue(
				new Error("SMART_RESIZE_BUZZ_NODE is only available for Buzz assets"),
			);

			const tool = server._getTool("figma_buzz_smart_resize");
			const result = await tool.handler({
				nodeId: "1:1",
				width: 1080,
				height: 1350,
			});

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toContain("Buzz assets");
		});
	});

	describe("figma_buzz_get_text_content", () => {
		it("returns serialized Buzz text fields", async () => {
			const tool = server._getTool("figma_buzz_get_text_content");
			const result = await tool.handler({ nodeId: "1:1" });

			expect(mockConnector.getBuzzTextContent).toHaveBeenCalledWith({ nodeId: "1:1" });
			expect(result.isError).toBeUndefined();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.data.fields[0]).toEqual({
				index: 0,
				text: "Launch day",
				keys: ["text"],
			});
		});
	});

	describe("figma_buzz_get_media_content", () => {
		it("returns serialized Buzz media fields", async () => {
			const tool = server._getTool("figma_buzz_get_media_content");
			const result = await tool.handler({ nodeId: "1:1" });

			expect(mockConnector.getBuzzMediaContent).toHaveBeenCalledWith({ nodeId: "1:1" });
			expect(result.isError).toBeUndefined();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.data.fields[0]).toEqual({
				index: 0,
				mediaType: "image",
				keys: ["mediaType"],
			});
		});
	});

	describe("error handling edge cases", () => {
		it("handles non-Error thrown values gracefully", async () => {
			mockConnector.getCanvasGrid.mockRejectedValue("raw string error");

			const tool = server._getTool("figma_buzz_get_canvas_grid");
			const result = await tool.handler({});

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toBe("raw string error");
		});

		it("handles getDesktopConnector failure", async () => {
			const failServer = createMockServer();
			registerBuzzTools(
				failServer as any,
				async () => {
					throw new Error("No plugin connected");
				},
			);

			const tool = failServer._getTool("figma_buzz_get_canvas_grid");
			const result = await tool.handler({});

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toContain("No plugin connected");
		});
	});
});
