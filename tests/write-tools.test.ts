/**
 * Write Tools Tests
 *
 * Unit tests for registerWriteTools() — all 29 write/manipulation tools.
 * Tests registration, happy paths, and error handling.
 */

import { registerWriteTools } from "../src/core/write-tools";

// ============================================================================
// Mock infrastructure (matches comment-tools.test.ts pattern)
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
	// Most tools check result.success and throw if falsy, so all mocks include success: true
	return {
		// Core execution
		executeCodeViaUI: jest.fn().mockResolvedValue({
			success: true,
			result: { id: "1:1" },
			error: null,
			resultAnalysis: { type: "object", warning: null },
			fileContext: { fileName: "Test", fileKey: "abc" },
		}),
		// Variable operations
		updateVariable: jest.fn().mockResolvedValue({ success: true, variable: { id: "v1", name: "color" } }),
		createVariable: jest.fn().mockResolvedValue({ success: true, variable: { id: "v2", name: "newVar" } }),
		createVariableCollection: jest.fn().mockResolvedValue({ success: true, collection: { id: "c1", name: "Colors" } }),
		deleteVariable: jest.fn().mockResolvedValue({ success: true, deleted: { id: "v1" } }),
		deleteVariableCollection: jest.fn().mockResolvedValue({ success: true, deleted: { id: "c1" } }),
		renameVariable: jest.fn().mockResolvedValue({ success: true, variable: { id: "v1", name: "renamed" }, oldName: "old" }),
		addMode: jest.fn().mockResolvedValue({ success: true, collection: { id: "c1", modes: [] } }),
		renameMode: jest.fn().mockResolvedValue({ success: true, collection: { id: "c1" }, oldName: "old" }),
		// Component operations
		instantiateComponent: jest.fn().mockResolvedValue({ success: true, instance: { id: "i1" } }),
		setNodeDescription: jest.fn().mockResolvedValue({ success: true }),
		addComponentProperty: jest.fn().mockResolvedValue({ success: true, property: { name: "prop1" } }),
		editComponentProperty: jest.fn().mockResolvedValue({ success: true, property: { name: "prop1" } }),
		deleteComponentProperty: jest.fn().mockResolvedValue({ success: true, deleted: true }),
		// Node manipulation
		resizeNode: jest.fn().mockResolvedValue({ success: true, node: { id: "n1", width: 200, height: 100 } }),
		moveNode: jest.fn().mockResolvedValue({ success: true, node: { id: "n1", x: 10, y: 20 } }),
		setNodeFills: jest.fn().mockResolvedValue({ success: true, node: { id: "n1" } }),
		setImageFill: jest.fn().mockResolvedValue({ success: true, imageHash: "hash123" }),
		setNodeStrokes: jest.fn().mockResolvedValue({ success: true, node: { id: "n1" } }),
		cloneNode: jest.fn().mockResolvedValue({ success: true, node: { id: "n2" } }),
		deleteNode: jest.fn().mockResolvedValue({ success: true, deleted: { id: "n1" } }),
		renameNode: jest.fn().mockResolvedValue({ success: true, node: { id: "n1", name: "new" } }),
		setTextContent: jest.fn().mockResolvedValue({ success: true, node: { id: "n1" } }),
		createChildNode: jest.fn().mockResolvedValue({ success: true, child: { id: "n3" } }),
		// Lint
		lintDesign: jest.fn().mockResolvedValue({
			success: true,
			data: { rootNodeId: "0:1", nodesScanned: 10, categories: [], summary: { total: 0 } },
		}),
		...overrides,
	};
}

/** Helper to parse the JSON response from a tool result */
function parseResult(result: any): any {
	return JSON.parse(result.content[0].text);
}

// ============================================================================
// Tests
// ============================================================================

describe("Write Tools", () => {
	let server: ReturnType<typeof createMockServer>;
	let mockConnector: ReturnType<typeof createMockConnector>;

	beforeEach(() => {
		server = createMockServer();
		mockConnector = createMockConnector();
		registerWriteTools(server as any, async () => mockConnector as any);
	});

	// ========================================================================
	// Registration
	// ========================================================================

	it("registers all 29 write tools", () => {
		expect(server.tool).toHaveBeenCalledTimes(29);
	});

	it("registers all expected tool names", () => {
		const expectedTools = [
			"figma_execute",
			"figma_update_variable",
			"figma_create_variable",
			"figma_create_variable_collection",
			"figma_delete_variable",
			"figma_delete_variable_collection",
			"figma_rename_variable",
			"figma_add_mode",
			"figma_rename_mode",
			"figma_batch_create_variables",
			"figma_batch_update_variables",
			"figma_setup_design_tokens",
			"figma_instantiate_component",
			"figma_set_description",
			"figma_add_component_property",
			"figma_edit_component_property",
			"figma_delete_component_property",
			"figma_resize_node",
			"figma_move_node",
			"figma_set_fills",
			"figma_set_image_fill",
			"figma_set_strokes",
			"figma_clone_node",
			"figma_delete_node",
			"figma_rename_node",
			"figma_set_text",
			"figma_create_child",
			"figma_arrange_component_set",
			"figma_lint_design",
		];

		for (const name of expectedTools) {
			expect(server._getTool(name)).toBeDefined();
		}
	});

	// ========================================================================
	// figma_execute
	// ========================================================================

	describe("figma_execute", () => {
		it("executes code and returns result", async () => {
			const tool = server._getTool("figma_execute");
			const result = await tool.handler({ code: "return 42", timeout: 5000 });

			expect(mockConnector.executeCodeViaUI).toHaveBeenCalledWith(
				"return 42",
				5000
			);
			const parsed = parseResult(result);
			expect(parsed.success).toBe(true);
			expect(parsed.result).toEqual({ id: "1:1" });
		});

		it("caps timeout at 30000ms", async () => {
			const tool = server._getTool("figma_execute");
			await tool.handler({ code: "return 1", timeout: 99999 });

			expect(mockConnector.executeCodeViaUI).toHaveBeenCalledWith(
				"return 1",
				30000
			);
		});

		it("returns error when connector fails", async () => {
			mockConnector.executeCodeViaUI.mockRejectedValue(
				new Error("Plugin not running")
			);
			const tool = server._getTool("figma_execute");
			const result = await tool.handler({ code: "fail", timeout: 5000 });

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toContain("Plugin not running");
			expect(parsed.hint).toBeDefined();
		});
	});

	// ========================================================================
	// Variable operations
	// ========================================================================

	describe("figma_update_variable", () => {
		it("updates a variable value", async () => {
			const tool = server._getTool("figma_update_variable");
			const result = await tool.handler({
				variableId: "v1",
				modeId: "m1",
				value: "#FF0000",
			});

			expect(mockConnector.updateVariable).toHaveBeenCalledWith("v1", "m1", "#FF0000");
			expect(result.isError).toBeUndefined();
		});

		it("returns error on failure", async () => {
			mockConnector.updateVariable.mockRejectedValue(new Error("Variable not found"));
			const tool = server._getTool("figma_update_variable");
			const result = await tool.handler({
				variableId: "bad",
				modeId: "m1",
				value: "x",
			});
			expect(result.isError).toBe(true);
		});
	});

	describe("figma_create_variable", () => {
		it("creates a variable with options", async () => {
			const tool = server._getTool("figma_create_variable");
			const result = await tool.handler({
				name: "primary",
				collectionId: "c1",
				resolvedType: "COLOR",
			});

			expect(mockConnector.createVariable).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_create_variable_collection", () => {
		it("creates a collection", async () => {
			const tool = server._getTool("figma_create_variable_collection");
			const result = await tool.handler({ name: "Tokens" });

			expect(mockConnector.createVariableCollection).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_delete_variable", () => {
		it("deletes a variable", async () => {
			const tool = server._getTool("figma_delete_variable");
			const result = await tool.handler({ variableId: "v1" });

			expect(mockConnector.deleteVariable).toHaveBeenCalledWith("v1");
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_delete_variable_collection", () => {
		it("deletes a collection", async () => {
			const tool = server._getTool("figma_delete_variable_collection");
			const result = await tool.handler({ collectionId: "c1" });

			expect(mockConnector.deleteVariableCollection).toHaveBeenCalledWith("c1");
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_rename_variable", () => {
		it("renames a variable", async () => {
			const tool = server._getTool("figma_rename_variable");
			const result = await tool.handler({
				variableId: "v1",
				newName: "accent",
			});

			expect(mockConnector.renameVariable).toHaveBeenCalledWith("v1", "accent");
			expect(result.isError).toBeUndefined();
		});
	});

	// ========================================================================
	// Mode operations
	// ========================================================================

	describe("figma_add_mode", () => {
		it("adds a mode to a collection", async () => {
			const tool = server._getTool("figma_add_mode");
			const result = await tool.handler({
				collectionId: "c1",
				modeName: "Dark",
			});

			expect(mockConnector.addMode).toHaveBeenCalledWith("c1", "Dark");
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_rename_mode", () => {
		it("renames a mode", async () => {
			const tool = server._getTool("figma_rename_mode");
			const result = await tool.handler({
				collectionId: "c1",
				modeId: "m1",
				newName: "Light",
			});

			expect(mockConnector.renameMode).toHaveBeenCalledWith("c1", "m1", "Light");
			expect(result.isError).toBeUndefined();
		});
	});

	// ========================================================================
	// Batch operations (use executeCodeViaUI)
	// ========================================================================

	describe("figma_batch_create_variables", () => {
		it("creates variables via plugin execution", async () => {
			const tool = server._getTool("figma_batch_create_variables");
			const result = await tool.handler({
				collectionId: "c1",
				variables: [
					{ name: "color/primary", resolvedType: "COLOR", valuesByMode: {} },
				],
			});

			expect(mockConnector.executeCodeViaUI).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_batch_update_variables", () => {
		it("updates variables via plugin execution", async () => {
			const tool = server._getTool("figma_batch_update_variables");
			const result = await tool.handler({
				updates: [{ variableId: "v1", modeId: "m1", value: "#000" }],
			});

			expect(mockConnector.executeCodeViaUI).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_setup_design_tokens", () => {
		it("sets up tokens via plugin execution", async () => {
			const tool = server._getTool("figma_setup_design_tokens");
			const result = await tool.handler({
				collectionName: "Tokens",
				modes: ["Light", "Dark"],
				tokens: [
					{
						name: "bg",
						resolvedType: "COLOR",
						values: { Light: "#FFF", Dark: "#000" },
					},
				],
			});

			expect(mockConnector.executeCodeViaUI).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});
	});

	// ========================================================================
	// Component operations
	// ========================================================================

	describe("figma_instantiate_component", () => {
		it("instantiates a component by key", async () => {
			const tool = server._getTool("figma_instantiate_component");
			const result = await tool.handler({ componentKey: "key123" });

			expect(mockConnector.instantiateComponent).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_set_description", () => {
		it("sets a node description", async () => {
			const tool = server._getTool("figma_set_description");
			const result = await tool.handler({
				nodeId: "1:1",
				description: "A button component",
			});

			expect(mockConnector.setNodeDescription).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_add_component_property", () => {
		it("adds a property to a component", async () => {
			const tool = server._getTool("figma_add_component_property");
			const result = await tool.handler({
				nodeId: "1:1",
				propertyName: "showIcon",
				propertyType: "BOOLEAN",
				defaultValue: true,
			});

			expect(mockConnector.addComponentProperty).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_edit_component_property", () => {
		it("edits a component property", async () => {
			const tool = server._getTool("figma_edit_component_property");
			const result = await tool.handler({
				nodeId: "1:1",
				propertyName: "showIcon",
				newValue: false,
			});

			expect(mockConnector.editComponentProperty).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_delete_component_property", () => {
		it("deletes a component property", async () => {
			const tool = server._getTool("figma_delete_component_property");
			const result = await tool.handler({
				nodeId: "1:1",
				propertyName: "showIcon",
			});

			expect(mockConnector.deleteComponentProperty).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});
	});

	// ========================================================================
	// Node manipulation
	// ========================================================================

	describe("figma_resize_node", () => {
		it("resizes a node", async () => {
			const tool = server._getTool("figma_resize_node");
			const result = await tool.handler({
				nodeId: "1:1",
				width: 200,
				height: 100,
			});

			expect(mockConnector.resizeNode).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_move_node", () => {
		it("moves a node", async () => {
			const tool = server._getTool("figma_move_node");
			const result = await tool.handler({ nodeId: "1:1", x: 10, y: 20 });

			expect(mockConnector.moveNode).toHaveBeenCalledWith("1:1", 10, 20);
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_set_fills", () => {
		it("sets fills on a node", async () => {
			const tool = server._getTool("figma_set_fills");
			const result = await tool.handler({
				nodeId: "1:1",
				fills: [{ type: "SOLID", color: "#FF0000" }],
			});

			expect(mockConnector.setNodeFills).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_set_image_fill", () => {
		it("sets image fill", async () => {
			const tool = server._getTool("figma_set_image_fill");
			const result = await tool.handler({
				nodeIds: ["1:1"],
				imageData: "base64data",
				scaleMode: "FILL",
			});

			expect(mockConnector.setImageFill).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_set_strokes", () => {
		it("sets strokes on a node", async () => {
			const tool = server._getTool("figma_set_strokes");
			const result = await tool.handler({
				nodeId: "1:1",
				strokes: [{ type: "SOLID", color: "#000000" }],
			});

			expect(mockConnector.setNodeStrokes).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_clone_node", () => {
		it("clones a node", async () => {
			const tool = server._getTool("figma_clone_node");
			const result = await tool.handler({ nodeId: "1:1" });

			expect(mockConnector.cloneNode).toHaveBeenCalledWith("1:1");
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_delete_node", () => {
		it("deletes a node", async () => {
			const tool = server._getTool("figma_delete_node");
			const result = await tool.handler({ nodeId: "1:1" });

			expect(mockConnector.deleteNode).toHaveBeenCalledWith("1:1");
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_rename_node", () => {
		it("renames a node", async () => {
			const tool = server._getTool("figma_rename_node");
			const result = await tool.handler({ nodeId: "1:1", newName: "Button" });

			expect(mockConnector.renameNode).toHaveBeenCalledWith("1:1", "Button");
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_set_text", () => {
		it("sets text content", async () => {
			const tool = server._getTool("figma_set_text");
			const result = await tool.handler({
				nodeId: "1:1",
				text: "Hello world",
			});

			expect(mockConnector.setTextContent).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_create_child", () => {
		it("creates a child node", async () => {
			const tool = server._getTool("figma_create_child");
			const result = await tool.handler({
				parentId: "1:1",
				nodeType: "RECTANGLE",
			});

			expect(mockConnector.createChildNode).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});
	});

	// ========================================================================
	// Arrange & Lint
	// ========================================================================

	describe("figma_arrange_component_set", () => {
		it("arranges components via plugin execution", async () => {
			const tool = server._getTool("figma_arrange_component_set");
			const result = await tool.handler({ componentSetId: "cs1" });

			expect(mockConnector.executeCodeViaUI).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});
	});

	describe("figma_lint_design", () => {
		it("runs design lint", async () => {
			const tool = server._getTool("figma_lint_design");
			const result = await tool.handler({});

			expect(mockConnector.lintDesign).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});

		it("returns error on failure", async () => {
			mockConnector.lintDesign.mockRejectedValue(new Error("Node not found"));
			const tool = server._getTool("figma_lint_design");
			const result = await tool.handler({ nodeId: "bad" });

			expect(result.isError).toBe(true);
		});
	});

	// ========================================================================
	// Common error handling pattern
	// ========================================================================

	describe("error handling", () => {
		it("all tools return isError:true when connector throws", async () => {
			const failConnector = createMockConnector();
			// Make every method reject
			for (const key of Object.keys(failConnector)) {
				(failConnector as any)[key] = jest.fn().mockRejectedValue(
					new Error("Connection lost")
				);
			}

			const failServer = createMockServer();
			registerWriteTools(failServer as any, async () => failConnector as any);

			// Test a sample of tools across categories
			const toolsToTest = [
				{ name: "figma_execute", args: { code: "x", timeout: 1000 } },
				{ name: "figma_update_variable", args: { variableId: "v", modeId: "m", value: "x" } },
				{ name: "figma_clone_node", args: { nodeId: "1:1" } },
				{ name: "figma_set_text", args: { nodeId: "1:1", text: "hi" } },
			];

			for (const { name, args } of toolsToTest) {
				const tool = failServer._getTool(name);
				const result = await tool.handler(args);
				expect(result.isError).toBe(true);
				const parsed = parseResult(result);
				expect(parsed.error).toContain("Connection lost");
			}
		});
	});
});
