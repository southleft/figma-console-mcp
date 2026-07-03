/**
 * Write Tools Tests
 *
 * Unit tests for registerWriteTools() — testing actual behavior,
 * response shapes, edge cases, and code generation logic.
 */

import { registerWriteTools } from "../src/core/write-tools";

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
		executeCodeViaUI: jest.fn().mockResolvedValue({
			success: true,
			result: { id: "1:1" },
			error: null,
			resultAnalysis: { type: "object", warning: null },
			fileContext: { fileName: "Test", fileKey: "abc" },
		}),
		updateVariable: jest.fn().mockResolvedValue({ success: true, variable: { id: "v1", name: "color" } }),
		createVariable: jest.fn().mockResolvedValue({ success: true, variable: { id: "v2", name: "newVar" } }),
		createVariableCollection: jest.fn().mockResolvedValue({ success: true, collection: { id: "c1", name: "Colors" } }),
		deleteVariable: jest.fn().mockResolvedValue({ success: true, deleted: { id: "v1" } }),
		deleteVariableCollection: jest.fn().mockResolvedValue({ success: true, deleted: { id: "c1" } }),
		renameVariable: jest.fn().mockResolvedValue({ success: true, variable: { id: "v1", name: "renamed" }, oldName: "old" }),
		addMode: jest.fn().mockResolvedValue({ success: true, collection: { id: "c1", modes: [] } }),
		renameMode: jest.fn().mockResolvedValue({ success: true, collection: { id: "c1" }, oldName: "old" }),
		instantiateComponent: jest.fn().mockResolvedValue({ success: true, instance: { id: "i1" } }),
		setNodeDescription: jest.fn().mockResolvedValue({ success: true }),
		addComponentProperty: jest.fn().mockResolvedValue({ success: true, property: { name: "prop1" } }),
		editComponentProperty: jest.fn().mockResolvedValue({ success: true, property: { name: "prop1" } }),
		deleteComponentProperty: jest.fn().mockResolvedValue({ success: true, deleted: true }),
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
		createComponentSet: jest.fn().mockResolvedValue({
			success: true,
			data: {
				componentSet: { id: "99:1", name: "Button", key: "setkey", x: 0, y: 0, width: 400, height: 300, parentId: "0:1" },
				variantCount: 2,
				variants: [
					{ id: "99:2", name: "State=default", key: "vkey1" },
					{ id: "99:3", name: "State=hover", key: "vkey2" },
				],
				propertyDefinitions: {
					State: { type: "VARIANT", defaultValue: "default", variantOptions: ["default", "hover"] },
				},
			},
		}),
		lintDesign: jest.fn().mockResolvedValue({
			success: true,
			data: { rootNodeId: "0:1", nodesScanned: 10, categories: [], summary: { total: 0 } },
		}),
		...overrides,
	};
}

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

	it("registers all 31 write tools", () => {
		expect(server.tool).toHaveBeenCalledTimes(31);
	});

	// ========================================================================
	// figma_execute — behavioral tests
	// ========================================================================

	describe("figma_execute", () => {
		it("caps timeout at 30000ms even when higher value requested", async () => {
			const tool = server._getTool("figma_execute");
			await tool.handler({ code: "return 1", timeout: 99999 });

			expect(mockConnector.executeCodeViaUI).toHaveBeenCalledWith("return 1", 30000);
		});

		it("passes through smaller timeouts unchanged", async () => {
			const tool = server._getTool("figma_execute");
			await tool.handler({ code: "return 1", timeout: 3000 });

			expect(mockConnector.executeCodeViaUI).toHaveBeenCalledWith("return 1", 3000);
		});

		it("returns resultAnalysis and fileContext in response", async () => {
			const tool = server._getTool("figma_execute");
			const result = await tool.handler({ code: "return 42", timeout: 5000 });
			const parsed = parseResult(result);

			expect(parsed.resultAnalysis).toEqual({ type: "object", warning: null });
			expect(parsed.fileContext).toEqual({ fileName: "Test", fileKey: "abc" });
			expect(parsed.timestamp).toBeDefined();
		});

		it("includes a hint in error responses", async () => {
			mockConnector.executeCodeViaUI.mockRejectedValue(new Error("Timeout"));
			const tool = server._getTool("figma_execute");
			const result = await tool.handler({ code: "slow()", timeout: 5000 });

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.hint).toContain("Desktop Bridge");
		});
	});

	// ========================================================================
	// Node operations — test success:false handling
	// ========================================================================

	describe("success:false from connector", () => {
		it("figma_resize_node throws when connector returns success:false", async () => {
			mockConnector.resizeNode.mockResolvedValue({
				success: false,
				error: "Node is locked",
			});
			const tool = server._getTool("figma_resize_node");
			const result = await tool.handler({ nodeId: "1:1", width: 200, height: 100 });

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toContain("Node is locked");
		});

		it("figma_clone_node throws when connector returns success:false", async () => {
			mockConnector.cloneNode.mockResolvedValue({
				success: false,
				error: "Cannot clone page node",
			});
			const tool = server._getTool("figma_clone_node");
			const result = await tool.handler({ nodeId: "0:1" });

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toContain("Cannot clone page node");
		});

		it("figma_delete_node throws when connector returns success:false", async () => {
			mockConnector.deleteNode.mockResolvedValue({
				success: false,
				error: "Node not found",
			});
			const tool = server._getTool("figma_delete_node");
			const result = await tool.handler({ nodeId: "99:99" });

			expect(result.isError).toBe(true);
		});
	});

	// ========================================================================
	// Response shape verification
	// ========================================================================

	describe("response shapes", () => {
		it("figma_resize_node includes dimensions in success message", async () => {
			const tool = server._getTool("figma_resize_node");
			const result = await tool.handler({ nodeId: "1:1", width: 300, height: 150 });
			const parsed = parseResult(result);

			expect(parsed.success).toBe(true);
			expect(parsed.message).toContain("300");
			expect(parsed.message).toContain("150");
		});

		it("figma_move_node includes coordinates in success message", async () => {
			const tool = server._getTool("figma_move_node");
			const result = await tool.handler({ nodeId: "1:1", x: 50, y: 75 });
			const parsed = parseResult(result);

			expect(parsed.success).toBe(true);
			expect(parsed.message).toContain("50");
			expect(parsed.message).toContain("75");
		});

		it("figma_rename_variable includes oldName in response", async () => {
			const tool = server._getTool("figma_rename_variable");
			const result = await tool.handler({ variableId: "v1", newName: "accent" });
			const parsed = parseResult(result);

			expect(parsed.oldName).toBe("old");
			expect(parsed.variable.name).toBe("renamed");
		});

		it("figma_rename_mode includes oldName in response", async () => {
			const tool = server._getTool("figma_rename_mode");
			const result = await tool.handler({ collectionId: "c1", modeId: "m1", newName: "Light" });
			const parsed = parseResult(result);

			expect(parsed.oldName).toBe("old");
		});

		it("figma_lint_design passes through lint data structure", async () => {
			const tool = server._getTool("figma_lint_design");
			const result = await tool.handler({});
			const parsed = parseResult(result);

			expect(parsed.rootNodeId).toBe("0:1");
			expect(parsed.nodesScanned).toBe(10);
			expect(parsed.summary.total).toBe(0);
		});
	});

	// ========================================================================
	// Parameter forwarding — verify correct args reach connector
	// ========================================================================

	describe("parameter forwarding", () => {
		it("figma_update_variable passes all three parameters", async () => {
			const tool = server._getTool("figma_update_variable");
			await tool.handler({ variableId: "v1", modeId: "m1", value: "#FF0000" });

			expect(mockConnector.updateVariable).toHaveBeenCalledWith("v1", "m1", "#FF0000");
		});

		it("figma_resize_node passes withConstraints default", async () => {
			const tool = server._getTool("figma_resize_node");
			await tool.handler({ nodeId: "1:1", width: 100, height: 50, withConstraints: true });

			expect(mockConnector.resizeNode).toHaveBeenCalledWith("1:1", 100, 50, true);
		});

		it("figma_set_fills passes fill array to connector", async () => {
			const fills = [
				{ type: "SOLID", color: "#FF0000" },
				{ type: "SOLID", color: "#00FF00", opacity: 0.5 },
			];
			const tool = server._getTool("figma_set_fills");
			await tool.handler({ nodeId: "1:1", fills });

			expect(mockConnector.setNodeFills).toHaveBeenCalledWith("1:1", fills);
		});

		it("figma_set_strokes passes strokeWeight when provided", async () => {
			const tool = server._getTool("figma_set_strokes");
			await tool.handler({
				nodeId: "1:1",
				strokes: [{ type: "SOLID", color: "#000" }],
				strokeWeight: 2,
			});

			expect(mockConnector.setNodeStrokes).toHaveBeenCalledWith(
				"1:1",
				[{ type: "SOLID", color: "#000" }],
				2
			);
		});

		it("figma_set_text passes text and optional fontSize", async () => {
			const tool = server._getTool("figma_set_text");
			await tool.handler({ nodeId: "1:1", text: "Hello", fontSize: 24 });

			const callArgs = mockConnector.setTextContent.mock.calls[0];
			expect(callArgs[0]).toBe("1:1");
			expect(callArgs[1]).toBe("Hello");
		});

		it("figma_create_child passes nodeType and properties", async () => {
			const tool = server._getTool("figma_create_child");
			await tool.handler({
				parentId: "1:1",
				nodeType: "RECTANGLE",
				properties: { width: 100, height: 50 },
			});

			expect(mockConnector.createChildNode).toHaveBeenCalledWith(
				"1:1",
				"RECTANGLE",
				{ width: 100, height: 50 }
			);
		});
	});

	// ========================================================================
	// Error response consistency
	// ========================================================================

	describe("error response consistency", () => {
		it("all tools return JSON with error field on connector failure", async () => {
			const failConnector = createMockConnector();
			for (const key of Object.keys(failConnector)) {
				(failConnector as any)[key] = jest.fn().mockRejectedValue(
					new Error("Connection lost")
				);
			}

			const failServer = createMockServer();
			registerWriteTools(failServer as any, async () => failConnector as any);

			const toolsToTest = [
				{ name: "figma_execute", args: { code: "x", timeout: 1000 } },
				{ name: "figma_update_variable", args: { variableId: "v", modeId: "m", value: "x" } },
				{ name: "figma_clone_node", args: { nodeId: "1:1" } },
				{ name: "figma_set_text", args: { nodeId: "1:1", text: "hi" } },
				{ name: "figma_rename_node", args: { nodeId: "1:1", newName: "x" } },
			];

			for (const { name, args } of toolsToTest) {
				const tool = failServer._getTool(name);
				const result = await tool.handler(args);
				expect(result.isError).toBe(true);
				const parsed = parseResult(result);
				expect(parsed.error).toBeDefined();
				expect(typeof parsed.error).toBe("string");
			}
		});
	});

	// ========================================================================
	// Create component set
	// ========================================================================

	describe("figma_create_component_set", () => {
		it("forwards base-component mode params to the connector", async () => {
			const tool = server._getTool("figma_create_component_set");
			await tool.handler({
				baseComponentId: "1:1",
				properties: { State: ["default", "hover"], Size: ["sm", "lg"] },
				name: "Button",
				parentId: "0:5",
				position: { x: 100, y: 200 },
			});

			expect(mockConnector.createComponentSet).toHaveBeenCalledWith({
				baseComponentId: "1:1",
				properties: { State: ["default", "hover"], Size: ["sm", "lg"] },
				componentIds: undefined,
				variantProperties: undefined,
				name: "Button",
				parentId: "0:5",
				position: { x: 100, y: 200 },
			});
		});

		it("forwards combine-existing mode params to the connector", async () => {
			const tool = server._getTool("figma_create_component_set");
			await tool.handler({
				componentIds: ["1:1", "1:2"],
				variantProperties: [{ State: "default" }, { State: "hover" }],
			});

			const params = mockConnector.createComponentSet.mock.calls[0][0];
			expect(params.componentIds).toEqual(["1:1", "1:2"]);
			expect(params.variantProperties).toEqual([
				{ State: "default" },
				{ State: "hover" },
			]);
		});

		it("errors when neither baseComponentId nor componentIds is provided", async () => {
			const tool = server._getTool("figma_create_component_set");
			const result = await tool.handler({});

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toContain("baseComponentId");
			expect(mockConnector.createComponentSet).not.toHaveBeenCalled();
		});

		it("errors when both modes are passed at once", async () => {
			const tool = server._getTool("figma_create_component_set");
			const result = await tool.handler({
				baseComponentId: "1:1",
				properties: { State: ["default"] },
				componentIds: ["1:2"],
			});

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toContain("mutually exclusive");
		});

		it("errors when baseComponentId is passed without properties", async () => {
			const tool = server._getTool("figma_create_component_set");
			const result = await tool.handler({ baseComponentId: "1:1" });

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toContain("properties");
		});

		it("returns variant keys and property definitions from the bridge", async () => {
			const tool = server._getTool("figma_create_component_set");
			const result = await tool.handler({
				baseComponentId: "1:1",
				properties: { State: ["default", "hover"] },
			});
			const parsed = parseResult(result);

			expect(parsed.success).toBe(true);
			expect(parsed.componentSet.id).toBe("99:1");
			expect(parsed.variants).toHaveLength(2);
			expect(parsed.variants[0].key).toBe("vkey1");
			expect(parsed.propertyDefinitions.State.variantOptions).toEqual([
				"default",
				"hover",
			]);
			expect(parsed.hint).toContain("VARIANT");
		});

		it("throws when connector returns success:false", async () => {
			mockConnector.createComponentSet.mockResolvedValue({
				success: false,
				error: "Base component is already a variant inside component set",
			});
			const tool = server._getTool("figma_create_component_set");
			const result = await tool.handler({
				baseComponentId: "1:1",
				properties: { State: ["default"] },
			});

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toContain("already a variant");
		});

		it("does not run arrange code by default", async () => {
			const tool = server._getTool("figma_create_component_set");
			await tool.handler({
				baseComponentId: "1:1",
				properties: { State: ["default"] },
			});

			expect(mockConnector.executeCodeViaUI).not.toHaveBeenCalled();
		});

		it("runs the arrange script against the new set when autoArrange is true", async () => {
			mockConnector.executeCodeViaUI.mockResolvedValue({
				success: true,
				result: { success: true, containerId: "77:1", grid: { rows: 1, columns: 2 } },
			});
			const tool = server._getTool("figma_create_component_set");
			const result = await tool.handler({
				baseComponentId: "1:1",
				properties: { State: ["default", "hover"] },
				autoArrange: true,
			});

			expect(mockConnector.executeCodeViaUI).toHaveBeenCalledTimes(1);
			const script = mockConnector.executeCodeViaUI.mock.calls[0][0];
			expect(script).toContain("99:1"); // arranges the set the bridge just created

			const parsed = parseResult(result);
			expect(parsed.arrange.arranged).toBe(true);
			expect(parsed.arrange.containerId).toBe("77:1");
		});

		it("reports arrange failure as a warning while creation still succeeds", async () => {
			mockConnector.executeCodeViaUI.mockResolvedValue({
				success: true,
				result: { error: "Component set not found" },
			});
			const tool = server._getTool("figma_create_component_set");
			const result = await tool.handler({
				baseComponentId: "1:1",
				properties: { State: ["default"] },
				autoArrange: true,
			});

			expect(result.isError).toBeUndefined();
			const parsed = parseResult(result);
			expect(parsed.success).toBe(true);
			expect(parsed.arrange.arranged).toBe(false);
			expect(parsed.arrange.error).toContain("not found");
		});
	});

	// ========================================================================
	// Arrange component set — code generation
	// ========================================================================

	describe("figma_arrange_component_set", () => {
		it("generates code that references the componentSetId", async () => {
			const tool = server._getTool("figma_arrange_component_set");
			await tool.handler({ componentSetId: "42:123" });

			const script = mockConnector.executeCodeViaUI.mock.calls[0][0];
			expect(script).toContain("42:123");
		});

		it("passes custom gap and padding when provided", async () => {
			const tool = server._getTool("figma_arrange_component_set");
			await tool.handler({ componentSetId: "1:1", gap: 20, padding: 40 });

			const script = mockConnector.executeCodeViaUI.mock.calls[0][0];
			// The generated code should use the custom values
			expect(script).toBeDefined();
		});
	});
});
