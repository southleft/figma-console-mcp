/**
 * Figma API Tools Tests
 *
 * Unit tests for registerFigmaAPITools() — all 9 REST API and bridge tools.
 * Tests registration, happy paths, and error handling.
 */

import { registerFigmaAPITools } from "../src/core/figma-tools";

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

function createMockFigmaAPI() {
	return {
		getFile: jest.fn().mockResolvedValue({
			name: "Test File",
			document: {
				id: "0:0",
				name: "Document",
				type: "DOCUMENT",
				children: [
					{
						id: "0:1",
						name: "Page 1",
						type: "CANVAS",
						children: [],
					},
				],
			},
			components: {},
			styles: {},
		}),
		getAllVariables: jest.fn().mockResolvedValue({
			variables: {},
			variableCollections: {},
		}),
		getStyles: jest.fn().mockResolvedValue({
			styles: [],
		}),
		getNodes: jest.fn().mockResolvedValue({
			nodes: { "1:1": { document: { id: "1:1", name: "Component", type: "COMPONENT" } } },
		}),
		getImages: jest.fn().mockResolvedValue({
			images: { "1:1": "https://figma.com/image.png" },
		}),
		getComponentData: jest.fn().mockResolvedValue({
			id: "1:1",
			name: "Button",
			type: "COMPONENT",
			description: "A button",
		}),
	};
}

function createMockDesktopConnector() {
	return {
		captureScreenshot: jest.fn().mockResolvedValue({
			success: true,
			image: {
				data: "base64data",
				format: "PNG",
				scale: 2,
				byteLength: 1024,
				width: 100,
				height: 100,
			},
		}),
		getTransportType: jest.fn().mockReturnValue("websocket"),
		setInstanceProperties: jest.fn().mockResolvedValue({
			success: true,
			instance: { id: "1:1", name: "Button" },
		}),
		getVariablesFromPluginUI: jest.fn().mockResolvedValue({
			success: true,
			variables: [],
			variableCollections: [],
		}),
		getVariables: jest.fn().mockResolvedValue({
			success: true,
			variables: [],
			variableCollections: [],
		}),
	};
}

function parseResult(result: any): any {
	return JSON.parse(result.content[0].text);
}

const MOCK_FILE_URL = "https://www.figma.com/design/abc123/Test-File";

// ============================================================================
// Tests
// ============================================================================

describe("Figma API Tools", () => {
	let server: ReturnType<typeof createMockServer>;
	let mockApi: ReturnType<typeof createMockFigmaAPI>;
	let mockConnector: ReturnType<typeof createMockDesktopConnector>;

	beforeEach(() => {
		server = createMockServer();
		mockApi = createMockFigmaAPI();
		mockConnector = createMockDesktopConnector();

		registerFigmaAPITools(
			server as any,
			async () => mockApi as any,
			() => MOCK_FILE_URL,
			() => null, // consoleMonitor
			() => null, // browserManager
			undefined, // ensureInitialized
			new Map(), // variablesCache
			undefined, // options
			async () => mockConnector as any, // desktopConnector
		);
	});

	// ========================================================================
	// Registration
	// ========================================================================

	it("registers all 9 Figma API tools", () => {
		expect(server.tool).toHaveBeenCalledTimes(9);
	});

	it("registers all expected tool names", () => {
		const expectedTools = [
			"figma_get_file_data",
			"figma_get_variables",
			"figma_get_component",
			"figma_get_styles",
			"figma_get_component_image",
			"figma_get_component_for_development",
			"figma_get_file_for_plugin",
			"figma_capture_screenshot",
			"figma_set_instance_properties",
		];

		for (const name of expectedTools) {
			expect(server._getTool(name)).toBeDefined();
		}
	});

	// ========================================================================
	// figma_get_file_data
	// ========================================================================

	describe("figma_get_file_data", () => {
		it("returns file data with default parameters", async () => {
			const tool = server._getTool("figma_get_file_data");
			const result = await tool.handler({ depth: 1, verbosity: "summary" });

			expect(mockApi.getFile).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});

		it("returns error when API fails", async () => {
			mockApi.getFile.mockRejectedValue(new Error("File not found"));
			const tool = server._getTool("figma_get_file_data");
			const result = await tool.handler({ depth: 1, verbosity: "summary" });

			expect(result.isError).toBe(true);
		});
	});

	// ========================================================================
	// figma_get_variables
	// ========================================================================

	describe("figma_get_variables", () => {
		it("fetches variables from REST API", async () => {
			const tool = server._getTool("figma_get_variables");
			const result = await tool.handler({
				includePublished: false,
				verbosity: "summary",
				enrich: false,
			});

			expect(result.isError).toBeUndefined();
		});

		it("returns error when both connector and API fail", async () => {
			mockConnector.getVariablesFromPluginUI.mockRejectedValue(new Error("No connection"));
			mockConnector.getVariables.mockRejectedValue(new Error("No connection"));
			mockApi.getAllVariables.mockRejectedValue(new Error("Unauthorized"));
			const tool = server._getTool("figma_get_variables");
			const result = await tool.handler({
				includePublished: false,
				verbosity: "summary",
				enrich: false,
			});

			expect(result.isError).toBe(true);
		});
	});

	// ========================================================================
	// figma_get_component_image
	// ========================================================================

	describe("figma_get_component_image", () => {
		it("returns image URL for a node", async () => {
			const tool = server._getTool("figma_get_component_image");
			const result = await tool.handler({
				nodeId: "1:1",
				scale: 2,
				format: "png",
			});

			expect(mockApi.getImages).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});
	});

	// ========================================================================
	// figma_capture_screenshot
	// ========================================================================

	describe("figma_capture_screenshot", () => {
		it("captures screenshot via desktop connector", async () => {
			const tool = server._getTool("figma_capture_screenshot");
			const result = await tool.handler({ format: "PNG", scale: 2 });

			expect(mockConnector.captureScreenshot).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});

		it("returns error when connector fails", async () => {
			mockConnector.captureScreenshot.mockRejectedValue(
				new Error("Plugin not running")
			);
			const tool = server._getTool("figma_capture_screenshot");
			const result = await tool.handler({ format: "PNG", scale: 2 });

			expect(result.isError).toBe(true);
		});
	});

	// ========================================================================
	// figma_set_instance_properties
	// ========================================================================

	describe("figma_set_instance_properties", () => {
		it("sets properties on an instance", async () => {
			const tool = server._getTool("figma_set_instance_properties");
			const result = await tool.handler({
				nodeId: "1:1",
				properties: { "Button Label": "Click Me" },
			});

			expect(mockConnector.setInstanceProperties).toHaveBeenCalledWith(
				"1:1",
				{ "Button Label": "Click Me" }
			);
			expect(result.isError).toBeUndefined();
		});

		it("returns error on failure", async () => {
			mockConnector.setInstanceProperties.mockRejectedValue(
				new Error("Node is not an instance")
			);
			const tool = server._getTool("figma_set_instance_properties");
			const result = await tool.handler({
				nodeId: "1:1",
				properties: {},
			});

			expect(result.isError).toBe(true);
		});
	});

	// ========================================================================
	// figma_get_styles
	// ========================================================================

	describe("figma_get_styles", () => {
		it("returns styles from file", async () => {
			const tool = server._getTool("figma_get_styles");
			const result = await tool.handler({
				verbosity: "summary",
				enrich: false,
			});

			expect(result.isError).toBeUndefined();
		});
	});

	// ========================================================================
	// figma_get_file_for_plugin
	// ========================================================================

	describe("figma_get_file_for_plugin", () => {
		it("returns filtered file data for plugin use", async () => {
			const tool = server._getTool("figma_get_file_for_plugin");
			const result = await tool.handler({ depth: 2 });

			expect(mockApi.getFile).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});
	});

	// ========================================================================
	// Error handling pattern
	// ========================================================================

	describe("error handling", () => {
		it("returns isError:true with hint for all API failures", async () => {
			mockApi.getFile.mockRejectedValue(new Error("Network error"));

			const tool = server._getTool("figma_get_file_data");
			const result = await tool.handler({ depth: 1, verbosity: "summary" });

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toContain("Network error");
		});
	});
});
