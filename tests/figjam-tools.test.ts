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
			data: { id: "1:3", type: "SHAPE_WITH_TEXT", name: "shape" },
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

	it("registers all 7 FigJam tools", () => {
		expect(server.tool).toHaveBeenCalledTimes(7);
		const names = server.tool.mock.calls.map((c: any[]) => c[0]);
		expect(names).toContain("figjam_create_sticky");
		expect(names).toContain("figjam_create_stickies");
		expect(names).toContain("figjam_create_connector");
		expect(names).toContain("figjam_create_shape_with_text");
		expect(names).toContain("figjam_create_table");
		expect(names).toContain("figjam_create_code_block");
		expect(names).toContain("figjam_auto_arrange");
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
});
