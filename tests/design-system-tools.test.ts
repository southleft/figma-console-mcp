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
			// Banner variants — reference set via containingComponentSet.nodeId (intermediate frame pattern)
			{
				node_id: "comp-4",
				name: "Expanded=False, Variant=Info",
				description: "",
				containing_frame: { nodeId: "frame-intermediate", containingComponentSet: { name: "Banner", nodeId: "set-2" } },
			},
			{
				node_id: "comp-5",
				name: "Expanded=False, Variant=Danger",
				description: "",
				containing_frame: { nodeId: "frame-intermediate", containingComponentSet: { name: "Banner", nodeId: "set-2" } },
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
			{
				node_id: "set-2",
				name: "Banner",
				description: "Notification banner component",
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

const MOCK_NODE_RESPONSE = (nodeId: string) => {
	// Component set with children (depth: 2)
	if (nodeId === "set-1") {
		return {
			nodes: {
				[nodeId]: {
					document: {
						id: nodeId,
						name: "Button",
						type: "COMPONENT_SET",
						componentPropertyDefinitions: {
							variant: { type: "VARIANT", defaultValue: "primary" },
							size: { type: "VARIANT", defaultValue: "md" },
							disabled: { type: "BOOLEAN", defaultValue: false },
							label: { type: "TEXT", defaultValue: "Click me" },
						},
						absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 40 },
						fills: [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.1, a: 1 }, visible: true }],
						cornerRadius: 8,
						layoutMode: "HORIZONTAL",
						paddingTop: 12,
						paddingRight: 24,
						paddingBottom: 12,
						paddingLeft: 24,
						itemSpacing: 8,
						primaryAxisAlignItems: "CENTER",
						counterAxisAlignItems: "CENTER",
						children: [
							{
								id: "comp-1",
								name: "Button",
								type: "COMPONENT",
								fills: [{ type: "SOLID", color: { r: 0, g: 0.4, b: 1, a: 1 }, visible: true }],
								cornerRadius: 8,
								layoutMode: "HORIZONTAL",
								paddingTop: 12,
								paddingRight: 24,
								paddingBottom: 12,
								paddingLeft: 24,
								itemSpacing: 8,
							},
							{
								id: "comp-2",
								name: "Button/Primary",
								type: "COMPONENT",
								fills: [{ type: "SOLID", color: { r: 0, g: 0.2, b: 0.8, a: 1 }, visible: true }],
								cornerRadius: 8,
								layoutMode: "HORIZONTAL",
								paddingTop: 12,
								paddingRight: 24,
								paddingBottom: 12,
								paddingLeft: 24,
								itemSpacing: 8,
							},
						],
					},
				},
			},
		};
	}

	// Banner component set with variants via intermediate frame
	if (nodeId === "set-2") {
		return {
			nodes: {
				[nodeId]: {
					document: {
						id: nodeId,
						name: "Banner",
						type: "COMPONENT_SET",
						componentPropertyDefinitions: {
							Expanded: { type: "VARIANT", defaultValue: "False" },
							Variant: { type: "VARIANT", defaultValue: "Info" },
						},
						absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 200 },
						cornerRadius: 5,
						children: [
							{
								id: "comp-4",
								name: "Expanded=False, Variant=Info",
								type: "COMPONENT",
								fills: [{ type: "SOLID", color: { r: 0.15, g: 0.18, b: 0.22, a: 1 }, visible: true }],
								cornerRadius: 5,
							},
							{
								id: "comp-5",
								name: "Expanded=False, Variant=Danger",
								type: "COMPONENT",
								fills: [{ type: "SOLID", color: { r: 0.15, g: 0.18, b: 0.22, a: 1 }, visible: true }],
								cornerRadius: 5,
							},
						],
					},
				},
			},
		};
	}

	// Style nodes
	if (nodeId === "s-1") {
		return {
			nodes: {
				[nodeId]: {
					document: {
						id: nodeId,
						name: "Heading/H1",
						type: "TEXT",
						style: {
							fontFamily: "Inter",
							fontSize: 32,
							fontWeight: 700,
							lineHeightPx: 40,
							letterSpacing: -0.5,
						},
					},
				},
			},
		};
	}
	if (nodeId === "s-2") {
		return {
			nodes: {
				[nodeId]: {
					document: {
						id: nodeId,
						name: "Fill/Primary",
						type: "RECTANGLE",
						fills: [{ type: "SOLID", color: { r: 0, g: 0.4, b: 1, a: 1 }, visible: true }],
					},
				},
			},
		};
	}
	if (nodeId === "s-3") {
		return {
			nodes: {
				[nodeId]: {
					document: {
						id: nodeId,
						name: "Shadow/Soft",
						type: "RECTANGLE",
						effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.15 }, offset: { x: 0, y: 4 }, radius: 8, spread: 0, visible: true }],
					},
				},
			},
		};
	}

	// Standalone component (Icon)
	return {
		nodes: {
			[nodeId]: {
				document: {
					id: nodeId,
					name: "Icon",
					type: "COMPONENT",
					componentPropertyDefinitions: {
						variant: { type: "VARIANT", defaultValue: "primary" },
						size: { type: "VARIANT", defaultValue: "md" },
						disabled: { type: "BOOLEAN", defaultValue: false },
						label: { type: "TEXT", defaultValue: "Click me" },
					},
					absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
					fills: [{ type: "SOLID", color: { r: 0.2, g: 0.2, b: 0.2, a: 1 }, visible: true }],
					opacity: 0.9,
					children: [
						{
							name: "path",
							type: "VECTOR",
							fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, visible: true }],
						},
					],
				},
			},
		},
	};
};

function createMockFigmaAPI(overrides: Record<string, jest.Mock> = {}) {
	return {
		getLocalVariables: jest.fn().mockResolvedValue(MOCK_VARIABLES_DATA),
		getComponents: jest.fn().mockResolvedValue(MOCK_COMPONENTS),
		getComponentSets: jest.fn().mockResolvedValue(MOCK_COMPONENT_SETS),
		getStyles: jest.fn().mockResolvedValue(MOCK_STYLES),
		getNodes: jest.fn().mockImplementation((_fileKey: string, nodeIds: string[]) => {
			// Batched response — merge all requested node responses
			const nodes: Record<string, any> = {};
			for (const nodeId of nodeIds) {
				const response = MOCK_NODE_RESPONSE(nodeId);
				Object.assign(nodes, response.nodes);
			}
			return Promise.resolve({ nodes });
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
			expect(data.ai_instruction).toContain("STRICT VISUAL FIDELITY REQUIRED");
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

			// Should have 3 items: Button (set) + Banner (set) + Icon (standalone)
			// Variants should be folded into their parent sets
			expect(components.items).toHaveLength(3);

			const buttonSet = components.items.find((c: any) => c.name === "Button" && c.variants);
			expect(buttonSet).toBeDefined();
			expect(buttonSet.variants).toHaveLength(2);

			const bannerSet = components.items.find((c: any) => c.name === "Banner");
			expect(bannerSet).toBeDefined();
			expect(bannerSet.variants).toHaveLength(2);

			const icon = components.items.find((c: any) => c.name === "Icon");
			expect(icon).toBeDefined();
			expect(icon.variants).toBeUndefined();

			expect(components.summary.totalComponentSets).toBe(2);
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

		it("returns compact output with format='compact'", async () => {
			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["tokens", "components", "styles"],
				format: "compact",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);

			// Compact: tokens collections should be empty (only summary kept)
			if (data.tokens) {
				expect(data.tokens.collections).toEqual([]);
				expect(data.tokens.summary).toBeDefined();
			}

			// Compact: components should have no visualSpec or bounds
			if (data.components) {
				for (const item of data.components.items) {
					expect(item.visualSpec).toBeUndefined();
					expect(item.bounds).toBeUndefined();
					expect(item.imageUrl).toBeUndefined();
				}
			}

			// Compact: styles should have no resolvedValue or description
			if (data.styles) {
				for (const item of data.styles.items) {
					expect(item.resolvedValue).toBeUndefined();
					expect(item.description).toBeUndefined();
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

	describe("Visual spec extraction", () => {
		it("extracts visual spec from component set root node", async () => {
			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["components"],
				format: "full",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);
			const buttonSet = data.components.items.find((c: any) => c.name === "Button" && c.variants);

			expect(buttonSet.visualSpec).toBeDefined();
			expect(buttonSet.visualSpec.fills).toHaveLength(1);
			expect(buttonSet.visualSpec.fills[0].color).toBe("#1A1A1A");
			expect(buttonSet.visualSpec.cornerRadius).toBe(8);
			expect(buttonSet.visualSpec.layout).toBeDefined();
			expect(buttonSet.visualSpec.layout.mode).toBe("HORIZONTAL");
			expect(buttonSet.visualSpec.layout.paddingTop).toBe(12);
			expect(buttonSet.visualSpec.layout.paddingRight).toBe(24);
			expect(buttonSet.visualSpec.layout.itemSpacing).toBe(8);
		});

		it("extracts visual spec from standalone component", async () => {
			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["components"],
				format: "full",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);
			const icon = data.components.items.find((c: any) => c.name === "Icon");

			expect(icon.visualSpec).toBeDefined();
			expect(icon.visualSpec.fills).toHaveLength(1);
			expect(icon.visualSpec.fills[0].color).toBe("#333333");
			expect(icon.visualSpec.opacity).toBe(0.9);
		});

		it("matches variants via containingComponentSet.nodeId (intermediate frame)", async () => {
			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["components"],
				format: "full",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);
			const bannerSet = data.components.items.find((c: any) => c.name === "Banner");

			expect(bannerSet).toBeDefined();
			expect(bannerSet.variants).toHaveLength(2);
			expect(bannerSet.variants[0].name).toBe("Expanded=False, Variant=Info");
			expect(bannerSet.variants[1].name).toBe("Expanded=False, Variant=Danger");
			// Variants should have visual specs from depth-2 children
			expect(bannerSet.variants[0].visualSpec).toBeDefined();
			expect(bannerSet.variants[0].visualSpec.cornerRadius).toBe(5);
		});

		it("attaches visual specs to individual variants", async () => {
			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["components"],
				format: "full",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);
			const buttonSet = data.components.items.find((c: any) => c.name === "Button" && c.variants);

			expect(buttonSet.variants).toHaveLength(2);
			// First variant (comp-1)
			const v1 = buttonSet.variants.find((v: any) => v.id === "comp-1");
			expect(v1.visualSpec).toBeDefined();
			expect(v1.visualSpec.fills[0].color).toBe("#0066FF");
			expect(v1.visualSpec.cornerRadius).toBe(8);

			// Second variant (comp-2)
			const v2 = buttonSet.variants.find((v: any) => v.id === "comp-2");
			expect(v2.visualSpec).toBeDefined();
			expect(v2.visualSpec.fills[0].color).toBe("#0033CC");
		});
	});

	describe("Style value resolution", () => {
		it("resolves actual color values for FILL styles", async () => {
			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["styles"],
				format: "full",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);
			const fillStyle = data.styles.items.find((s: any) => s.name === "Fill/Primary");

			expect(fillStyle.resolvedValue).toBeDefined();
			expect(fillStyle.resolvedValue.fills).toHaveLength(1);
			expect(fillStyle.resolvedValue.fills[0].color).toBe("#0066FF");
		});

		it("resolves typography values for TEXT styles", async () => {
			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["styles"],
				format: "full",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);
			const textStyle = data.styles.items.find((s: any) => s.name === "Heading/H1");

			expect(textStyle.resolvedValue).toBeDefined();
			expect(textStyle.resolvedValue.typography).toBeDefined();
			expect(textStyle.resolvedValue.typography.fontFamily).toBe("Inter");
			expect(textStyle.resolvedValue.typography.fontSize).toBe(32);
			expect(textStyle.resolvedValue.typography.fontWeight).toBe(700);
		});

		it("resolves effect values for EFFECT styles", async () => {
			const tool = server._getTool("figma_get_design_system_kit");
			const result = await tool.handler({
				include: ["styles"],
				format: "full",
				includeImages: false,
			});

			const data = JSON.parse(result.content[0].text);
			const effectStyle = data.styles.items.find((s: any) => s.name === "Shadow/Soft");

			expect(effectStyle.resolvedValue).toBeDefined();
			expect(effectStyle.resolvedValue.effects).toHaveLength(1);
			expect(effectStyle.resolvedValue.effects[0].type).toBe("DROP_SHADOW");
			expect(effectStyle.resolvedValue.effects[0].color).toBe("#000000");
			expect(effectStyle.resolvedValue.effects[0].radius).toBe(8);
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
			expect(data.ai_instruction).toContain("3 components");
			expect(data.ai_instruction).toContain("3 styles");
		});
	});
});
