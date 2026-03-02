/**
 * Design System Kit Tool Tests
 *
 * Unit tests for figma_get_design_system_kit.
 * Tests the registerDesignSystemTools() function with a mock McpServer and FigmaAPI.
 */

import { registerDesignSystemTools } from "../src/core/design-system-tools";

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
		tool: jest.fn((name: string, description: string, schema: any, handler: any) => {
			tools[name] = { name, description, schema, handler };
		}),
		_tools: tools,
		_getTool(name: string): RegisteredTool {
			return tools[name];
		},
	};
}

// ============================================================================
// Mock Figma API data
// ============================================================================

const MOCK_VARIABLES_DATA = {
	variableCollections: {
		"col-1": {
			id: "col-1",
			name: "Colors",
			key: "colors-key",
			modes: [
				{ modeId: "mode-light", name: "Light" },
				{ modeId: "mode-dark", name: "Dark" },
			],
			variableIds: ["var-1", "var-2"],
		},
		"col-2": {
			id: "col-2",
			name: "Spacing",
			key: "spacing-key",
			modes: [{ modeId: "mode-default", name: "Default" }],
			variableIds: ["var-3"],
		},
	},
	variables: {
		"var-1": {
			id: "var-1",
			name: "primary",
			key: "primary-key",
			resolvedType: "COLOR",
			valuesByMode: {
				"mode-light": { r: 0, g: 0.4, b: 1, a: 1 },
				"mode-dark": { r: 0.2, g: 0.6, b: 1, a: 1 },
			},
			variableCollectionId: "col-1",
			scopes: ["ALL_FILLS"],
			description: "Primary brand color",
		},
		"var-2": {
			id: "var-2",
			name: "secondary",
			key: "secondary-key",
			resolvedType: "COLOR",
			valuesByMode: {
				"mode-light": { r: 0.5, g: 0, b: 0.8, a: 1 },
				"mode-dark": { r: 0.7, g: 0.2, b: 1, a: 1 },
			},
			variableCollectionId: "col-1",
			scopes: ["ALL_FILLS"],
			description: "",
		},
		"var-3": {
			id: "var-3",
			name: "space-md",
			key: "space-md-key",
			resolvedType: "FLOAT",
			valuesByMode: { "mode-default": 16 },
			variableCollectionId: "col-2",
			scopes: ["GAP", "WIDTH_HEIGHT"],
			description: "Medium spacing",
		},
	},
};

const MOCK_COMPONENTS = {
	meta: {
		components: [
			{
				node_id: "comp-1",
				name: "Button",
				description: "A clickable button",
				containing_frame: { nodeId: "set-1", containingComponentSet: true },
				component_set_id: "set-1",
			},
			{
				node_id: "comp-2",
				name: "Button/Primary",
				description: "",
				containing_frame: { nodeId: "set-1", containingComponentSet: true },
				component_set_id: "set-1",
			},
			{
				node_id: "comp-3",
				name: "Icon",
				description: "A standalone icon",
				containing_frame: { nodeId: "frame-x", containingComponentSet: false },
			},
		],
	},
};

const MOCK_COMPONENT_SETS = {
	meta: {
		component_sets: [
			{
				node_id: "set-1",
				name: "Button",
				description: "Interactive button component",
			},
		],
	},
};

const MOCK_STYLES = {
	meta: {
		styles: [
			{ key: "style-1", name: "Heading/H1", style_type: "TEXT", description: "Main heading", node_id: "s-1" },
			{ key: "style-2", name: "Fill/Primary", style_type: "FILL", description: "", node_id: "s-2" },
			{ key: "style-3", name: "Shadow/Soft", style_type: "EFFECT", description: "Subtle shadow", node_id: "s-3" },
		],
	},
};

const MOCK_NODE_RESPONSE = (nodeId: string) => ({
	nodes: {
		[nodeId]: {
			document: {
				id: nodeId,
				name: nodeId === "set-1" ? "Button" : "Icon",
				type: nodeId === "set-1" ? "COMPONENT_SET" : "COMPONENT",
				componentPropertyDefinitions: {
					variant: { type: "VARIANT", defaultValue: "primary" },
					size: { type: "VARIANT", defaultValue: "md" },
					disabled: { type: "BOOLEAN", defaultValue: false },
					label: { type: "TEXT", defaultValue: "Click me" },
				},
				absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 40 },
			},
		},
	},
});

function createMockFigmaAPI(overrides: Record<string, jest.Mock> = {}) {
	return {
		getLocalVariables: jest.fn().mockResolvedValue(MOCK_VARIABLES_DATA),
		getComponents: jest.fn().mockResolvedValue(MOCK_COMPONENTS),
		getComponentSets: jest.fn().mockResolvedValue(MOCK_COMPONENT_SETS),
		getStyles: jest.fn().mockResolvedValue(MOCK_STYLES),
		getNodes: jest.fn().mockImplementation((_fileKey: string, nodeIds: string[]) => {
			return Promise.resolve(MOCK_NODE_RESPONSE(nodeIds[0]));
		}),
		getImages: jest.fn().mockResolvedValue({
			images: { "set-1": "https://figma-images.com/button.png", "comp-3": "https://figma-images.com/icon.png" },
		}),
		...overrides,
	};
}

const MOCK_FILE_URL = "https://www.figma.com/design/abc123/My-Design-System";

// ============================================================================
// Tests
// ============================================================================

describe("Design System Kit Tool", () => {
	let server: ReturnType<typeof createMockServer>;
	let mockApi: ReturnType<typeof createMockFigmaAPI>;

	beforeEach(() => {
		server = createMockServer();
		mockApi = createMockFigmaAPI();

		registerDesignSystemTools(
			server as any,
			async () => mockApi as any,
			() => MOCK_FILE_URL,
		);
	});

	it("registers the figma_get_design_system_kit tool", () => {
		expect(server.tool).toHaveBeenCalledTimes(1);
		expect(server._getTool("figma_get_design_system_kit")).toBeDefined();
	});

	describe("Full kit assembly", () => {
		it("returns tokens, components, and styles", async () => {
			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["tokens", "components", "styles"],
				format: "full",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);

			expect(data.fileKey).toBe("abc123");
			expect(data.tokens).toBeDefined();
			expect(data.components).toBeDefined();
			expect(data.styles).toBeDefined();
			expect(data.ai_instruction).toContain("structured design system specification");
		});

		it("groups tokens by collection with modes", async () => {
			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["tokens"],
				format: "full",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);
			const { tokens } = data;

			expect(tokens.collections).toHaveLength(2);

			const colors = tokens.collections.find((c: any) => c.name === "Colors");
			expect(colors.modes).toHaveLength(2);
			expect(colors.modes[0].name).toBe("Light");
			expect(colors.variables).toHaveLength(2);
			expect(colors.variables[0].name).toBe("primary");
			expect(colors.variables[0].type).toBe("COLOR");

			const spacing = tokens.collections.find((c: any) => c.name === "Spacing");
			expect(spacing.variables).toHaveLength(1);
			expect(spacing.variables[0].name).toBe("space-md");

			expect(tokens.summary.totalCollections).toBe(2);
			expect(tokens.summary.totalVariables).toBe(3);
		});

		it("deduplicates variant components from sets", async () => {
			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["components"],
				format: "full",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);
			const { components } = data;

			// Should have 2 items: Button (set) + Icon (standalone)
			// Variants "Button" and "Button/Primary" should be folded into the set
			expect(components.items).toHaveLength(2);

			const buttonSet = components.items.find((c: any) => c.name === "Button" && c.variants);
			expect(buttonSet).toBeDefined();
			expect(buttonSet.variants).toHaveLength(2);

			const icon = components.items.find((c: any) => c.name === "Icon");
			expect(icon).toBeDefined();
			expect(icon.variants).toBeUndefined();

			expect(components.summary.totalComponentSets).toBe(1);
		});

		it("fetches property definitions from component set nodes", async () => {
			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["components"],
				format: "full",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);
			const buttonSet = data.components.items.find((c: any) => c.name === "Button" && c.variants);

			expect(buttonSet.properties).toBeDefined();
			expect(buttonSet.properties.variant).toEqual({ type: "VARIANT", defaultValue: "primary" });
			expect(buttonSet.properties.disabled).toEqual({ type: "BOOLEAN", defaultValue: false });
			expect(buttonSet.properties.label).toEqual({ type: "TEXT", defaultValue: "Click me" });
			expect(buttonSet.bounds).toEqual({ width: 120, height: 40 });
		});

		it("returns styles grouped by type", async () => {
			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["styles"],
				format: "full",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);
			const { styles } = data;

			expect(styles.items).toHaveLength(3);
			expect(styles.summary.totalStyles).toBe(3);
			expect(styles.summary.stylesByType).toEqual({
				TEXT: 1,
				FILL: 1,
				EFFECT: 1,
			});
		});
	});

	describe("Filtered output", () => {
		it("returns only tokens when include=['tokens']", async () => {
			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["tokens"],
				format: "full",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);

			expect(data.tokens).toBeDefined();
			expect(data.components).toBeUndefined();
			expect(data.styles).toBeUndefined();
		});

		it("returns only components when include=['components']", async () => {
			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["components"],
				format: "full",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);

			expect(data.tokens).toBeUndefined();
			expect(data.components).toBeDefined();
			expect(data.styles).toBeUndefined();
		});

		it("filters components by componentIds", async () => {
			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["components"],
				componentIds: ["comp-3"], // Only the standalone Icon
				format: "full",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);

			// Only the Icon should remain (comp-3 matches standalone, set-1 does not)
			expect(data.components.items).toHaveLength(1);
			expect(data.components.items[0].name).toBe("Icon");
		});
	});

	describe("Image support", () => {
		it("includes image URLs when includeImages is true", async () => {
			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["components"],
				format: "full",
				includeImages: true,
			});

			const data = JSON.parse(result.content[0].text);
			const buttonSet = data.components.items.find((c: any) => c.name === "Button" && c.variants);
			const icon = data.components.items.find((c: any) => c.name === "Icon");

			expect(buttonSet.imageUrl).toBe("https://figma-images.com/button.png");
			expect(icon.imageUrl).toBe("https://figma-images.com/icon.png");
			expect(mockApi.getImages).toHaveBeenCalled();
		});

		it("does not fetch images when includeImages is false", async () => {
			const tool = server._getTool("figma_get_design_system_kit");
			await tool.handler({
				include: ["components"],
				format: "full",
				includeImages: false,
			});

			expect(mockApi.getImages).not.toHaveBeenCalled();
		});
	});

	describe("Summary format", () => {
		it("returns compressed output with format='summary'", async () => {
			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["tokens", "components", "styles"],
				format: "summary",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);

			// Summary format strips image URLs from components
			if (data.components) {
				for (const item of data.components.items) {
					expect(item.imageUrl).toBeUndefined();
				}
			}
		});
	});

	describe("Error handling", () => {
		it("gracefully degrades when token fetch fails", async () => {
			mockApi.getLocalVariables.mockRejectedValue(new Error("403 Forbidden"));

			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["tokens", "components", "styles"],
				format: "full",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);

			// Tokens should be missing, but components and styles should still be present
			expect(data.tokens).toBeUndefined();
			expect(data.components).toBeDefined();
			expect(data.styles).toBeDefined();
			expect(data.errors).toHaveLength(1);
			expect(data.errors[0].section).toBe("tokens");
		});

		it("gracefully degrades when component fetch fails", async () => {
			mockApi.getComponents.mockRejectedValue(new Error("Rate limited"));

			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["tokens", "components"],
				format: "full",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);

			expect(data.tokens).toBeDefined();
			expect(data.components).toBeUndefined();
			expect(data.errors).toHaveLength(1);
			expect(data.errors[0].section).toBe("components");
		});

		it("reports image errors without failing the whole response", async () => {
			mockApi.getImages.mockRejectedValue(new Error("Image rendering failed"));

			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["components"],
				format: "full",
				includeImages: true,
			});

			const data = JSON.parse(result.content[0].text);

			expect(data.components).toBeDefined();
			expect(data.errors).toHaveLength(1);
			expect(data.errors[0].section).toBe("component_images");
		});

		it("returns error when no file key available", async () => {
			const noUrlServer = createMockServer();
			registerDesignSystemTools(
				noUrlServer as any,
				async () => mockApi as any,
				() => null,
			);

			const tool = noUrlServer._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["tokens"],
				format: "full",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);
			expect(result.isError).toBe(true);
			expect(data.error).toContain("No file key provided");
		});
	});

	describe("Cache support", () => {
		it("uses cached variables data when available", async () => {
			const cache = new Map<string, { data: any; timestamp: number }>();
			cache.set("vars:abc123", {
				data: MOCK_VARIABLES_DATA,
				timestamp: Date.now(),
			});

			const cachedServer = createMockServer();
			registerDesignSystemTools(
				cachedServer as any,
				async () => mockApi as any,
				() => MOCK_FILE_URL,
				cache,
			);

			const tool = cachedServer._getTool("figma_get_design_system_kit");
			await tool.handler({
				include: ["tokens"],
				format: "full",
				includeImages: false,
			});

			// Should NOT have called the API since cache was available
			expect(mockApi.getLocalVariables).not.toHaveBeenCalled();
		});

		it("fetches fresh data when cache is expired", async () => {
			const cache = new Map<string, { data: any; timestamp: number }>();
			cache.set("vars:abc123", {
				data: MOCK_VARIABLES_DATA,
				timestamp: Date.now() - 10 * 60 * 1000, // 10 minutes ago (past TTL)
			});

			const cachedServer = createMockServer();
			registerDesignSystemTools(
				cachedServer as any,
				async () => mockApi as any,
				() => MOCK_FILE_URL,
				cache,
			);

			const tool = cachedServer._getTool("figma_get_design_system_kit");
			await tool.handler({
				include: ["tokens"],
				format: "full",
				includeImages: false,
			});

			// Should have called the API since cache was expired
			expect(mockApi.getLocalVariables).toHaveBeenCalled();
		});
	});

	describe("AI instruction", () => {
		it("includes summary counts in ai_instruction", async () => {
			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["tokens", "components", "styles"],
				format: "full",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);

			expect(data.ai_instruction).toContain("3 tokens");
			expect(data.ai_instruction).toContain("2 collections");
			expect(data.ai_instruction).toContain("2 components");
			expect(data.ai_instruction).toContain("3 styles");
		});
	});
});
