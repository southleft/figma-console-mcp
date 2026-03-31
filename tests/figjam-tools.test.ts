/**
 * FigJam Tools Tests
 *
 * Unit tests for figjam_create_sticky, figjam_create_stickies,
 * figjam_create_connector, figjam_create_shape_with_text,
 * figjam_create_table, figjam_create_code_block, figjam_auto_arrange.
 * Tests the registerFigJamTools() function with a mock McpServer and connector.
 */

import { registerFigJamTools } from "../src/core/figjam-tools";

// ============================================================================
// Mock infrastructure
// ============================================================================

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
			}
		),
		_tools: tools,
		_getTool(name: string): RegisteredTool {
			return tools[name];
		},
	};
}

function createMockConnector(overrides: Record<string, jest.Mock> = {}) {
	return {
		createSticky: jest.fn().mockResolvedValue({
			success: true,
			data: { id: "1:1", type: "STICKY", name: "Test", x: 0, y: 0 },
		}),
		createStickies: jest.fn().mockResolvedValue({
			success: true,
			data: { created: 2, failed: 0, results: [], errors: [] },
		}),
		createConnector: jest.fn().mockResolvedValue({
			success: true,
			data: { id: "1:2", type: "CONNECTOR", name: "conn" },
		}),
		createShapeWithText: jest.fn().mockResolvedValue({
			success: true,
			data: { id: "1:3", type: "SHAPE_WITH_TEXT", name: "shape", x: 0, y: 0, width: 200, height: 100 },
		}),
		createSection: jest.fn().mockResolvedValue({
			success: true,
			data: { id: "1:6", type: "SECTION", name: "My Section", x: 0, y: 0, width: 1000, height: 800 },
		}),
		createTable: jest.fn().mockResolvedValue({
			success: true,
			data: { id: "1:4", type: "TABLE", name: "Table", rows: 2, columns: 2 },
		}),
		createCodeBlock: jest.fn().mockResolvedValue({
			success: true,
			data: { id: "1:5", type: "CODE_BLOCK", name: "Code block" },
		}),
		executeCodeViaUI: jest.fn().mockResolvedValue({
			success: true,
			result: { arranged: 3, layout: "grid" },
		}),
		getBoardContents: jest.fn().mockResolvedValue({
			success: true,
			data: {
				nodes: [
					{ id: "1:10", type: "STICKY", name: "Note", text: "Hello", x: 0, y: 0 },
					{ id: "1:11", type: "SHAPE_WITH_TEXT", name: "Step 1", text: "Start", x: 300, y: 0 },
				],
				totalFound: 2,
				truncated: false,
				page: "Page 1",
			},
		}),
		getConnections: jest.fn().mockResolvedValue({
			success: true,
			data: {
				edges: [
					{ connectorId: "1:20", startNodeId: "1:10", endNodeId: "1:11", label: "leads to" },
				],
				connectedNodes: {
					"1:10": { id: "1:10", type: "STICKY", name: "Note", text: "Hello" },
					"1:11": { id: "1:11", type: "SHAPE_WITH_TEXT", name: "Step 1", text: "Start" },
				},
				totalConnectors: 1,
				totalConnectedNodes: 2,
			},
		}),
		...overrides,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("FigJam Tools", () => {
	let server: ReturnType<typeof createMockServer>;
	let mockConnector: ReturnType<typeof createMockConnector>;

	beforeEach(() => {
		server = createMockServer();
		mockConnector = createMockConnector();

		registerFigJamTools(server as any, async () => mockConnector as any);
	});

	// ========================================================================
	// Registration
	// ========================================================================

	it("registers all 10 FigJam tools", () => {
		expect(server.tool).toHaveBeenCalledTimes(10);
		const names = server.tool.mock.calls.map((c: any[]) => c[0]);
		expect(names).toContain("figjam_create_sticky");
		expect(names).toContain("figjam_create_stickies");
		expect(names).toContain("figjam_create_connector");
		expect(names).toContain("figjam_create_shape_with_text");
		expect(names).toContain("figjam_create_section");
		expect(names).toContain("figjam_create_table");
		expect(names).toContain("figjam_create_code_block");
		expect(names).toContain("figjam_auto_arrange");
		expect(names).toContain("figjam_get_board_contents");
		expect(names).toContain("figjam_get_connections");
	});

	// ========================================================================
	// figjam_create_sticky
	// ========================================================================

	describe("figjam_create_sticky", () => {
		it("creates a sticky with text and color", async () => {
			const tool = server._getTool("figjam_create_sticky");
			const result = await tool.handler({
				text: "Hello",
				color: "BLUE",
				x: 100,
				y: 200,
			});

			expect(mockConnector.createSticky).toHaveBeenCalledWith({
				text: "Hello",
				color: "BLUE",
				x: 100,
				y: 200,
			});
			expect(result.isError).toBeUndefined();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(true);
		});

		it("returns error when connector fails", async () => {
			mockConnector.createSticky.mockRejectedValue(
				new Error("CREATE_STICKY is only available in FigJam files")
			);

			const tool = server._getTool("figjam_create_sticky");
			const result = await tool.handler({ text: "Hello" });

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toContain("only available in FigJam");
			expect(parsed.hint).toBeDefined();
		});
	});

	// ========================================================================
	// figjam_create_stickies
	// ========================================================================

	describe("figjam_create_stickies", () => {
		it("creates batch stickies", async () => {
			const tool = server._getTool("figjam_create_stickies");
			const stickies = [
				{ text: "A", color: "YELLOW", x: 0, y: 0 },
				{ text: "B", color: "GREEN", x: 300, y: 0 },
			];
			const result = await tool.handler({ stickies });

			expect(mockConnector.createStickies).toHaveBeenCalledWith({ stickies });
			expect(result.isError).toBeUndefined();
		});

		it("returns error when connector fails", async () => {
			mockConnector.createStickies.mockRejectedValue(
				new Error("CREATE_STICKIES is only available in FigJam files")
			);

			const tool = server._getTool("figjam_create_stickies");
			const result = await tool.handler({ stickies: [{ text: "A" }] });

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toContain("only available in FigJam");
			expect(parsed.hint).toBeDefined();
		});
	});

	// ========================================================================
	// figjam_create_connector
	// ========================================================================

	describe("figjam_create_connector", () => {
		it("connects two nodes with a label", async () => {
			const tool = server._getTool("figjam_create_connector");
			const result = await tool.handler({
				startNodeId: "1:1",
				endNodeId: "1:2",
				label: "relates to",
			});

			expect(mockConnector.createConnector).toHaveBeenCalledWith({
				startNodeId: "1:1",
				endNodeId: "1:2",
				label: "relates to",
			});
			expect(result.isError).toBeUndefined();
		});

		it("returns error when start node not found", async () => {
			mockConnector.createConnector.mockRejectedValue(
				new Error("Start node not found: 99:99")
			);

			const tool = server._getTool("figjam_create_connector");
			const result = await tool.handler({
				startNodeId: "99:99",
				endNodeId: "1:2",
			});

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toContain("Start node not found");
		});
	});

	// ========================================================================
	// figjam_create_shape_with_text
	// ========================================================================

	describe("figjam_create_shape_with_text", () => {
		it("creates a diamond shape with text", async () => {
			const tool = server._getTool("figjam_create_shape_with_text");
			const result = await tool.handler({
				text: "Decision",
				shapeType: "DIAMOND",
				x: 0,
				y: 0,
			});

			expect(mockConnector.createShapeWithText).toHaveBeenCalledWith({
				text: "Decision",
				shapeType: "DIAMOND",
				x: 0,
				y: 0,
			});
			expect(result.isError).toBeUndefined();
		});

		it("returns error when connector fails", async () => {
			mockConnector.createShapeWithText.mockRejectedValue(
				new Error("CREATE_SHAPE_WITH_TEXT is only available in FigJam files")
			);

			const tool = server._getTool("figjam_create_shape_with_text");
			const result = await tool.handler({ text: "Test" });

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toContain("only available in FigJam");
		});
	});

	// ========================================================================
	// figjam_create_table
	// ========================================================================

	describe("figjam_create_table", () => {
		it("creates a table with data", async () => {
			const tool = server._getTool("figjam_create_table");
			const result = await tool.handler({
				rows: 2,
				columns: 2,
				data: [
					["Name", "Status"],
					["Task 1", "Done"],
				],
				x: 0,
				y: 0,
			});

			expect(mockConnector.createTable).toHaveBeenCalledWith({
				rows: 2,
				columns: 2,
				data: [
					["Name", "Status"],
					["Task 1", "Done"],
				],
				x: 0,
				y: 0,
			});
			expect(result.isError).toBeUndefined();
		});

		it("returns error when connector fails", async () => {
			mockConnector.createTable.mockRejectedValue(
				new Error("CREATE_TABLE is only available in FigJam files")
			);

			const tool = server._getTool("figjam_create_table");
			const result = await tool.handler({ rows: 2, columns: 2 });

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toContain("only available in FigJam");
		});
	});

	// ========================================================================
	// figjam_create_code_block
	// ========================================================================

	describe("figjam_create_code_block", () => {
		it("creates a code block with language", async () => {
			const tool = server._getTool("figjam_create_code_block");
			const result = await tool.handler({
				code: "console.log('hello')",
				language: "JAVASCRIPT",
				x: 0,
				y: 0,
			});

			expect(mockConnector.createCodeBlock).toHaveBeenCalledWith({
				code: "console.log('hello')",
				language: "JAVASCRIPT",
				x: 0,
				y: 0,
			});
			expect(result.isError).toBeUndefined();
		});

		it("returns error when connector fails", async () => {
			mockConnector.createCodeBlock.mockRejectedValue(
				new Error("CREATE_CODE_BLOCK is only available in FigJam files")
			);

			const tool = server._getTool("figjam_create_code_block");
			const result = await tool.handler({ code: "test" });

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toContain("only available in FigJam");
		});
	});

	// ========================================================================
	// figjam_auto_arrange
	// ========================================================================

	describe("figjam_auto_arrange", () => {
		it("arranges nodes in horizontal layout", async () => {
			const tool = server._getTool("figjam_auto_arrange");
			const result = await tool.handler({
				nodeIds: ["1:1", "1:2", "1:3"],
				layout: "horizontal",
				spacing: 40,
			});

			expect(mockConnector.executeCodeViaUI).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();

			// Verify the generated code contains the params as JSON (not interpolated)
			const codeArg = mockConnector.executeCodeViaUI.mock.calls[0][0];
			expect(codeArg).toContain("JSON.parse");
			expect(codeArg).toContain("params.layout");
			expect(codeArg).toContain("params.spacing");
		});

		it("does not interpolate layout string into code (injection safety)", async () => {
			const tool = server._getTool("figjam_auto_arrange");
			await tool.handler({
				nodeIds: ["1:1"],
				layout: "grid",
				spacing: 40,
			});

			const codeArg = mockConnector.executeCodeViaUI.mock.calls[0][0];
			// The layout value should be inside a JSON string, not bare-interpolated
			expect(codeArg).not.toMatch(/const layout = '/);
			expect(codeArg).toContain("JSON.parse");
		});

		it("returns error when connector fails", async () => {
			mockConnector.executeCodeViaUI.mockRejectedValue(
				new Error("No valid nodes found")
			);

			const tool = server._getTool("figjam_auto_arrange");
			const result = await tool.handler({
				nodeIds: ["99:99"],
				layout: "grid",
				spacing: 40,
			});

			expect(result.isError).toBe(true);
		});
	});

	// ========================================================================
	// figjam_get_board_contents
	// ========================================================================

	describe("figjam_get_board_contents", () => {
		it("reads all board contents", async () => {
			const tool = server._getTool("figjam_get_board_contents");
			const result = await tool.handler({ maxNodes: 500 });

			expect(mockConnector.getBoardContents).toHaveBeenCalledWith({
				nodeTypes: undefined,
				maxNodes: 500,
			});
			expect(result.isError).toBeUndefined();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(true);
			expect(parsed.data.nodes).toHaveLength(2);
			expect(parsed.data.nodes[0].type).toBe("STICKY");
		});

		it("passes nodeTypes filter to connector", async () => {
			const tool = server._getTool("figjam_get_board_contents");
			await tool.handler({ nodeTypes: ["STICKY"], maxNodes: 100 });

			expect(mockConnector.getBoardContents).toHaveBeenCalledWith({
				nodeTypes: ["STICKY"],
				maxNodes: 100,
			});
		});

		it("returns error when not in FigJam", async () => {
			mockConnector.getBoardContents.mockRejectedValue(
				new Error("GET_BOARD_CONTENTS is only available in FigJam files")
			);

			const tool = server._getTool("figjam_get_board_contents");
			const result = await tool.handler({ maxNodes: 500 });

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toContain("only available in FigJam");
		});
	});

	// ========================================================================
	// figjam_get_connections
	// ========================================================================

	describe("figjam_get_connections", () => {
		it("reads the connection graph", async () => {
			const tool = server._getTool("figjam_get_connections");
			const result = await tool.handler({});

			expect(mockConnector.getConnections).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(true);
			expect(parsed.data.edges).toHaveLength(1);
			expect(parsed.data.edges[0].startNodeId).toBe("1:10");
			expect(parsed.data.edges[0].endNodeId).toBe("1:11");
			expect(parsed.data.edges[0].label).toBe("leads to");
			expect(parsed.data.totalConnectedNodes).toBe(2);
		});

		it("returns error when not in FigJam", async () => {
			mockConnector.getConnections.mockRejectedValue(
				new Error("GET_CONNECTIONS is only available in FigJam files")
			);

			const tool = server._getTool("figjam_get_connections");
			const result = await tool.handler({});

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toContain("only available in FigJam");
		});

		it("handles empty board with no connectors", async () => {
			mockConnector.getConnections.mockResolvedValue({
				success: true,
				data: { edges: [], connectedNodes: {}, totalConnectors: 0, totalConnectedNodes: 0 },
			});

			const tool = server._getTool("figjam_get_connections");
			const result = await tool.handler({});

			expect(result.isError).toBeUndefined();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.data.edges).toHaveLength(0);
			expect(parsed.data.totalConnectors).toBe(0);
		});
	});

	// ========================================================================
	// figjam_create_connector — enhanced magnets
	// ========================================================================

	describe("figjam_create_connector (magnet params)", () => {
		it("passes startMagnet and endMagnet to connector", async () => {
			const tool = server._getTool("figjam_create_connector");
			const result = await tool.handler({
				startNodeId: "1:1",
				endNodeId: "1:2",
				label: "flow",
				startMagnet: "BOTTOM",
				endMagnet: "TOP",
			});

			expect(mockConnector.createConnector).toHaveBeenCalledWith({
				startNodeId: "1:1",
				endNodeId: "1:2",
				label: "flow",
				startMagnet: "BOTTOM",
				endMagnet: "TOP",
			});
			expect(result.isError).toBeUndefined();
		});

		it("passes undefined magnets when not provided (defaults applied by Zod schema)", async () => {
			const tool = server._getTool("figjam_create_connector");
			await tool.handler({
				startNodeId: "1:1",
				endNodeId: "1:2",
			});

			const callArgs = mockConnector.createConnector.mock.calls[0][0];
			// In production, Zod .default("AUTO") applies before the handler.
			// Our mock bypasses schema validation, so we verify params are passed through.
			expect(mockConnector.createConnector).toHaveBeenCalledTimes(1);
			expect(callArgs.startNodeId).toBe("1:1");
			expect(callArgs.endNodeId).toBe("1:2");
		});
	});

	// ========================================================================
	// figjam_create_shape_with_text — enhanced params
	// ========================================================================

	describe("figjam_create_shape_with_text (enhanced params)", () => {
		it("passes size and color params to connector", async () => {
			const tool = server._getTool("figjam_create_shape_with_text");
			const result = await tool.handler({
				text: "Step 1",
				shapeType: "ROUNDED_RECTANGLE",
				x: 100,
				y: 200,
				width: 300,
				height: 150,
				fillColor: "#E1F5EE",
				strokeColor: "#2D6A4F",
				fontSize: 18,
				strokeDashPattern: "10,5",
			});

			expect(mockConnector.createShapeWithText).toHaveBeenCalledWith({
				text: "Step 1",
				shapeType: "ROUNDED_RECTANGLE",
				x: 100,
				y: 200,
				width: 300,
				height: 150,
				fillColor: "#E1F5EE",
				strokeColor: "#2D6A4F",
				fontSize: 18,
				strokeDashPattern: "10,5",
			});
			expect(result.isError).toBeUndefined();
		});

		it("works with only original params (backward compat)", async () => {
			const tool = server._getTool("figjam_create_shape_with_text");
			const result = await tool.handler({
				text: "Hello",
				shapeType: "DIAMOND",
				x: 0,
				y: 0,
			});

			const callArgs = mockConnector.createShapeWithText.mock.calls[0][0];
			expect(callArgs.text).toBe("Hello");
			expect(callArgs.shapeType).toBe("DIAMOND");
			expect(callArgs.width).toBeUndefined();
			expect(callArgs.fillColor).toBeUndefined();
			expect(result.isError).toBeUndefined();
		});
	});

	// ========================================================================
	// figjam_create_section
	// ========================================================================

	describe("figjam_create_section", () => {
		it("creates a section with name, position, and size", async () => {
			const tool = server._getTool("figjam_create_section");
			const result = await tool.handler({
				name: "Sprint Board",
				x: 0,
				y: 0,
				width: 2000,
				height: 1500,
			});

			expect(mockConnector.createSection).toHaveBeenCalledWith({
				name: "Sprint Board",
				x: 0,
				y: 0,
				width: 2000,
				height: 1500,
				fillColor: undefined,
			});
			expect(result.isError).toBeUndefined();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(true);
			expect(parsed.data.type).toBe("SECTION");
		});

		it("creates a section with fill color", async () => {
			const tool = server._getTool("figjam_create_section");
			await tool.handler({
				name: "Colored Section",
				fillColor: "#FFE4B5",
			});

			const callArgs = mockConnector.createSection.mock.calls[0][0];
			expect(callArgs.fillColor).toBe("#FFE4B5");
		});

		it("returns error when connector fails", async () => {
			mockConnector.createSection.mockRejectedValue(
				new Error("CREATE_SECTION is only available in FigJam files")
			);

			const tool = server._getTool("figjam_create_section");
			const result = await tool.handler({ name: "Test" });

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toContain("only available in FigJam");
			expect(parsed.hint).toBeDefined();
		});

		it("passes through params when width/height not provided (defaults applied by Zod schema)", async () => {
			const tool = server._getTool("figjam_create_section");
			await tool.handler({ name: "Default Size" });

			// In production, Zod .default(1000)/.default(800) applies before handler.
			// Our mock bypasses schema validation, so we just verify the call was made.
			expect(mockConnector.createSection).toHaveBeenCalledTimes(1);
			const callArgs = mockConnector.createSection.mock.calls[0][0];
			expect(callArgs.name).toBe("Default Size");
		});
	});

	// ========================================================================
	// Edge cases & robustness
	// ========================================================================

	describe("error handling edge cases", () => {
		it("handles non-Error thrown objects gracefully", async () => {
			mockConnector.createSticky.mockRejectedValue("raw string error");

			const tool = server._getTool("figjam_create_sticky");
			const result = await tool.handler({ text: "Hello" });

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toBe("raw string error");
		});

		it("handles getDesktopConnector failure", async () => {
			const failServer = createMockServer();
			registerFigJamTools(
				failServer as any,
				async () => { throw new Error("No plugin connected"); }
			);

			const tool = failServer._getTool("figjam_create_sticky");
			const result = await tool.handler({ text: "Hello" });

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toContain("No plugin connected");
		});
	});
});
