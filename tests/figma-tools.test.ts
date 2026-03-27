/**
 * Figma API Tools Tests
 *
 * Tests actual behavior: connector vs REST API fallback,
 * response formats, file URL resolution, error handling patterns.
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
		getStyles: jest.fn().mockResolvedValue({ styles: [] }),
		getNodes: jest.fn().mockResolvedValue({
			nodes: { "1:1": { document: { id: "1:1", name: "Component", type: "COMPONENT" } } },
		}),
		getImages: jest.fn().mockResolvedValue({
			images: { "1:1": "https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/abc" },
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
		setInstanceProperties: jest.fn().mockResolvedValue({
			success: true,
			instance: { id: "1:1", name: "Button" },
		}),
		getVariablesFromPluginUI: jest.fn().mockResolvedValue({
			success: true,
			variables: [{ id: "v1", name: "primary", resolvedType: "COLOR" }],
			variableCollections: [{ id: "c1", name: "Colors" }],
		}),
		getVariables: jest.fn().mockResolvedValue({
			success: true,
			variables: [],
			variableCollections: [],
		}),
		getTransportType: jest.fn().mockReturnValue("websocket"),
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
			() => null,
			() => null,
			undefined,
			new Map(),
			undefined,
			async () => mockConnector as any,
		);
	});

	// ========================================================================
	// File URL resolution
	// ========================================================================

	describe("file URL resolution", () => {
		it("figma_get_file_data uses auto-detected URL when none provided", async () => {
			const tool = server._getTool("figma_get_file_data");
			await tool.handler({ depth: 1, verbosity: "summary" });

			// Should have called getFile with the fileKey extracted from MOCK_FILE_URL
			expect(mockApi.getFile).toHaveBeenCalled();
			const callArgs = mockApi.getFile.mock.calls[0];
			expect(callArgs[0]).toBe("abc123"); // extracted from the URL
		});

		it("figma_get_file_data uses explicit URL when provided", async () => {
			const tool = server._getTool("figma_get_file_data");
			await tool.handler({
				fileUrl: "https://www.figma.com/design/xyz789/Other-File",
				depth: 1,
				verbosity: "summary",
			});

			expect(mockApi.getFile).toHaveBeenCalled();
			const callArgs = mockApi.getFile.mock.calls[0];
			expect(callArgs[0]).toBe("xyz789");
		});

		it("returns error when no URL available", async () => {
			const noUrlServer = createMockServer();
			registerFigmaAPITools(
				noUrlServer as any,
				async () => mockApi as any,
				() => null, // no URL
				() => null,
				() => null,
				undefined,
				new Map(),
				undefined,
				async () => mockConnector as any,
			);

			const tool = noUrlServer._getTool("figma_get_file_data");
			const result = await tool.handler({ depth: 1, verbosity: "summary" });

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toBeDefined();
		});
	});

	// ========================================================================
	// figma_get_variables — connector preference
	// ========================================================================

	describe("figma_get_variables", () => {
		it("prefers desktop connector over REST API", async () => {
			const tool = server._getTool("figma_get_variables");
			const result = await tool.handler({
				includePublished: false,
				verbosity: "summary",
				enrich: false,
			});

			const parsed = parseResult(result);
			// Should use connector data, not REST API
			expect(parsed.source).toBe("desktop_connection");
		});

		it("returns variable data from connector in response", async () => {
			const tool = server._getTool("figma_get_variables");
			const result = await tool.handler({
				includePublished: false,
				verbosity: "summary",
				enrich: false,
			});

			const parsed = parseResult(result);
			expect(parsed.data).toBeDefined();
			expect(parsed.data.variables).toBeDefined();
			expect(parsed.data.variableCollections).toBeDefined();
		});
	});

	// ========================================================================
	// figma_capture_screenshot — response format
	// ========================================================================

	describe("figma_capture_screenshot", () => {
		it("returns image metadata in response", async () => {
			const tool = server._getTool("figma_capture_screenshot");
			const result = await tool.handler({ format: "PNG", scale: 2 });
			const parsed = parseResult(result);

			expect(parsed.success).toBe(true);
			expect(parsed.image).toBeDefined();
			expect(parsed.image.format).toBe("PNG");
			expect(parsed.image.byteLength).toBe(1024);
		});

		it("passes nodeId and options to connector", async () => {
			const tool = server._getTool("figma_capture_screenshot");
			await tool.handler({ nodeId: "42:10", format: "JPG", scale: 3 });

			expect(mockConnector.captureScreenshot).toHaveBeenCalledWith(
				"42:10",
				{ format: "JPG", scale: 3 }
			);
		});

		it("uses empty string for nodeId when not provided", async () => {
			const tool = server._getTool("figma_capture_screenshot");
			await tool.handler({ format: "PNG", scale: 2 });

			expect(mockConnector.captureScreenshot).toHaveBeenCalledWith(
				"",
				{ format: "PNG", scale: 2 }
			);
		});

		it("returns error with guidance when connector fails", async () => {
			mockConnector.captureScreenshot.mockRejectedValue(
				new Error("Plugin not running")
			);
			const tool = server._getTool("figma_capture_screenshot");
			const result = await tool.handler({ format: "PNG", scale: 2 });

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toContain("Plugin not running");
		});
	});

	// ========================================================================
	// figma_set_instance_properties — behavior
	// ========================================================================

	describe("figma_set_instance_properties", () => {
		it("forwards properties to connector with correct nodeId", async () => {
			const tool = server._getTool("figma_set_instance_properties");
			await tool.handler({
				nodeId: "99:42",
				properties: { "Label": "Click Me", "Show Icon": true },
			});

			expect(mockConnector.setInstanceProperties).toHaveBeenCalledWith(
				"99:42",
				{ "Label": "Click Me", "Show Icon": true }
			);
		});

		it("returns error when node is not an instance", async () => {
			mockConnector.setInstanceProperties.mockRejectedValue(
				new Error("Node 1:1 is not an instance")
			);
			const tool = server._getTool("figma_set_instance_properties");
			const result = await tool.handler({ nodeId: "1:1", properties: {} });

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toContain("not an instance");
		});
	});

	// ========================================================================
	// figma_get_component_image — URL in response
	// ========================================================================

	describe("figma_get_component_image", () => {
		it("returns image URL from Figma API", async () => {
			const tool = server._getTool("figma_get_component_image");
			const result = await tool.handler({ nodeId: "1:1", scale: 2, format: "png" });
			const parsed = parseResult(result);

			expect(parsed.imageUrl || parsed.url || parsed.images).toBeDefined();
		});
	});

	// ========================================================================
	// Error pattern — all tools return structured error JSON
	// ========================================================================

	describe("error response structure", () => {
		it("figma_get_file_data error includes error string", async () => {
			mockApi.getFile.mockRejectedValue(new Error("403 Forbidden"));
			const tool = server._getTool("figma_get_file_data");
			const result = await tool.handler({ depth: 1, verbosity: "summary" });

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toContain("403 Forbidden");
		});

		it("figma_set_instance_properties error includes error string", async () => {
			mockConnector.setInstanceProperties.mockRejectedValue(new Error("Node locked"));
			const tool = server._getTool("figma_set_instance_properties");
			const result = await tool.handler({ nodeId: "1:1", properties: {} });

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toContain("Node locked");
		});
	});
});
