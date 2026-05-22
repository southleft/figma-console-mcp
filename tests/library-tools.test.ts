/**
 * Library Tools Tests
 *
 * Unit tests for figma_get_library_component_by_key.
 * Tests registerLibraryTools() with a mock McpServer and FigmaAPI,
 * covering: COMPONENT_SET resolution, COMPONENT fallback, 404 handling,
 * variant key matching, visual spec extraction, and adaptive compression.
 */

import {
	registerLibraryTools,
	registerLibraryVariableTools,
} from "../src/core/library-tools";

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
			},
		),
		_tools: tools,
		_getTool(name: string): RegisteredTool {
			return tools[name];
		},
	};
}

// ============================================================================
// Mock Figma API data — modeled on real REST responses (see openapi spec)
// ============================================================================

const COMPONENT_SET_KEY = "806826503bbd2ab15d0ff77d076a9406a5a83197";
const STANDALONE_COMPONENT_KEY = "e69126d1478dc2584bb57b9bf813ce5dcec239fb";
const UNKNOWN_KEY = "0000000000000000000000000000000000000000";

const FILE_KEY = "library-file-key-abc";
const SET_NODE_ID = "1:100";

// /v1/component_sets/{key} response — wraps PublishedComponentSet in meta
const MOCK_COMPONENT_SET_RESPONSE = {
	status: 200,
	error: false,
	meta: {
		key: COMPONENT_SET_KEY,
		file_key: FILE_KEY,
		node_id: SET_NODE_ID,
		name: "Button",
		description: "Primary action button",
		thumbnail_url: "https://thumbnails.figma.com/btn.png",
		created_at: "2023-01-15T12:00:00Z",
		updated_at: "2023-09-29T14:57:08Z",
		user: { id: "u1", handle: "designer", img_url: "https://example.com/u.png" },
		containing_frame: {
			name: "Buttons",
			nodeId: "1:90",
			pageId: "0:1",
			pageName: "Components",
		},
	},
};

// /v1/components/{key} response — for a standalone component
const MOCK_STANDALONE_COMPONENT_RESPONSE = {
	status: 200,
	error: false,
	meta: {
		key: STANDALONE_COMPONENT_KEY,
		file_key: FILE_KEY,
		node_id: "2:200",
		name: "circle-button",
		description: "Standalone circular icon button",
		thumbnail_url: "https://thumbnails.figma.com/circle.png",
		created_at: "2023-01-27T17:56:19Z",
		updated_at: "2023-01-27T17:56:19Z",
		user: { id: "u1", handle: "designer" },
	},
};

// /v1/files/{file_key}/nodes?ids=...&depth=2 response — wraps each node in { document }
const MOCK_SET_NODES_RESPONSE = {
	nodes: {
		[SET_NODE_ID]: {
			document: {
				id: SET_NODE_ID,
				name: "Button",
				type: "COMPONENT_SET",
				absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 80 },
				fills: [{ type: "SOLID", color: { r: 0, g: 0.4, b: 1, a: 1 } }],
				cornerRadius: 8,
				componentPropertyDefinitions: {
					"Variant": {
						type: "VARIANT",
						defaultValue: "Primary",
						variantOptions: ["Primary", "Secondary", "Ghost"],
					},
					"Show Icon": {
						type: "BOOLEAN",
						defaultValue: false,
					},
					"Label": {
						type: "TEXT",
						defaultValue: "Click me",
					},
				},
				children: [
					{
						id: "1:101",
						name: "Variant=Primary",
						type: "COMPONENT",
						fills: [{ type: "SOLID", color: { r: 0, g: 0.4, b: 1, a: 1 } }],
						cornerRadius: 8,
					},
					{
						id: "1:102",
						name: "Variant=Secondary",
						type: "COMPONENT",
						fills: [{ type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5, a: 1 } }],
						cornerRadius: 8,
					},
					{
						id: "1:103",
						name: "Variant=Ghost",
						type: "COMPONENT",
						fills: [],
						cornerRadius: 8,
					},
				],
			},
		},
	},
};

// /v1/files/{file_key}/components response — used to map variant node_ids to keys
const MOCK_COMPONENTS_LIST_RESPONSE = {
	meta: {
		components: [
			{
				key: "variant-primary-key",
				file_key: FILE_KEY,
				node_id: "1:101",
				name: "Variant=Primary",
				containing_frame: { nodeId: SET_NODE_ID, name: "Button" },
			},
			{
				key: "variant-secondary-key",
				file_key: FILE_KEY,
				node_id: "1:102",
				name: "Variant=Secondary",
				containing_frame: { nodeId: SET_NODE_ID, name: "Button" },
			},
			{
				key: "variant-ghost-key",
				file_key: FILE_KEY,
				node_id: "1:103",
				name: "Variant=Ghost",
				containing_frame: { nodeId: SET_NODE_ID, name: "Button" },
			},
			// Unrelated component in the same file — should NOT appear in variants[]
			{
				key: "unrelated-key",
				file_key: FILE_KEY,
				node_id: "9:999",
				name: "Other Component",
			},
		],
	},
};

const MOCK_STANDALONE_NODES_RESPONSE = {
	nodes: {
		"2:200": {
			document: {
				id: "2:200",
				name: "circle-button",
				type: "COMPONENT",
				absoluteBoundingBox: { x: 0, y: 0, width: 48, height: 48 },
				cornerRadius: 24,
				fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
				// Note: standalone COMPONENT can have componentPropertyDefinitions too
				componentPropertyDefinitions: {
					"Icon": { type: "INSTANCE_SWAP", defaultValue: "" },
				},
			},
		},
	},
};

// ============================================================================
// Helpers
// ============================================================================

function notFoundError(): Error {
	return new Error(`Figma API error (404): {"status":404,"err":"Not found"}`);
}

function forbiddenError(): Error {
	return new Error(`Figma API error (403): {"err":"Forbidden"}`);
}

function rateLimitError(): Error {
	return new Error(`Figma API error (429): {"err":"Rate limited"}`);
}

function parseResult(result: any): any {
	expect(result.content).toBeDefined();
	expect(result.content[0].type).toBe("text");
	return JSON.parse(result.content[0].text);
}

function createMockFigmaAPI(overrides: Record<string, jest.Mock> = {}) {
	return {
		getComponentSetByKey: jest
			.fn()
			.mockResolvedValue(MOCK_COMPONENT_SET_RESPONSE),
		getComponentByKey: jest
			.fn()
			.mockResolvedValue(MOCK_STANDALONE_COMPONENT_RESPONSE),
		getNodes: jest
			.fn()
			.mockImplementation((_fileKey: string, nodeIds: string[]) => {
				if (nodeIds.includes(SET_NODE_ID)) {
					return Promise.resolve(MOCK_SET_NODES_RESPONSE);
				}
				if (nodeIds.includes("2:200")) {
					return Promise.resolve(MOCK_STANDALONE_NODES_RESPONSE);
				}
				return Promise.resolve({ nodes: {} });
			}),
		getComponents: jest.fn().mockResolvedValue(MOCK_COMPONENTS_LIST_RESPONSE),
		...overrides,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("Library Tools — figma_get_library_component_by_key", () => {
	let server: ReturnType<typeof createMockServer>;
	let mockApi: ReturnType<typeof createMockFigmaAPI>;

	beforeEach(() => {
		server = createMockServer();
		mockApi = createMockFigmaAPI();
		registerLibraryTools(server as any, async () => mockApi as any);
	});

	it("registers the figma_get_library_component_by_key tool", () => {
		expect(server.tool).toHaveBeenCalledTimes(1);
		expect(
			server._getTool("figma_get_library_component_by_key"),
		).toBeDefined();
	});

	describe("COMPONENT_SET resolution (variant container)", () => {
		it("resolves a COMPONENT_SET key and returns properties + variants with keys", async () => {
			const tool = server._getTool("figma_get_library_component_by_key");
			const result = await tool.handler({
				componentKey: COMPONENT_SET_KEY,
				includeVisualSpecs: true,
				format: "full",
			});

			const data = parseResult(result);

			expect(data._mcp).toBe("figma-console-mcp");
			expect(data.componentKey).toBe(COMPONENT_SET_KEY);
			expect(data.resolvedAs).toBe("COMPONENT_SET");
			expect(data.fileKey).toBe(FILE_KEY);
			expect(data.nodeId).toBe(SET_NODE_ID);
			expect(data.name).toBe("Button");
			expect(data.description).toBe("Primary action button");

			// Properties from componentPropertyDefinitions
			expect(data.properties).toBeDefined();
			expect(data.properties.Variant.type).toBe("VARIANT");
			expect(data.properties.Variant.variantOptions).toEqual([
				"Primary",
				"Secondary",
				"Ghost",
			]);
			expect(data.properties["Show Icon"].type).toBe("BOOLEAN");
			expect(data.properties.Label.type).toBe("TEXT");

			// Variants matched to keys via /components endpoint
			expect(data.variants).toHaveLength(3);
			const primary = data.variants.find(
				(v: any) => v.name === "Variant=Primary",
			);
			expect(primary.key).toBe("variant-primary-key");
			expect(primary.nodeId).toBe("1:101");
			expect(primary.visualSpec).toBeDefined();
			expect(primary.visualSpec.fills[0].color).toBe("#0066FF");

			// Should NOT include the unrelated component
			expect(
				data.variants.some((v: any) => v.key === "unrelated-key"),
			).toBe(false);

			// Usage hint should reference a variant key, not the set key
			expect(data.usage.example).toContain("variant-primary-key");
			expect(data.usage.instantiate).toContain("VARIANT key");
		});

		it("calls both REST endpoints in parallel: getNodes + getComponents", async () => {
			const tool = server._getTool("figma_get_library_component_by_key");
			await tool.handler({ componentKey: COMPONENT_SET_KEY });

			expect(mockApi.getComponentSetByKey).toHaveBeenCalledWith(
				COMPONENT_SET_KEY,
			);
			expect(mockApi.getNodes).toHaveBeenCalledWith(
				FILE_KEY,
				[SET_NODE_ID],
				{ depth: 2 },
			);
			expect(mockApi.getComponents).toHaveBeenCalledWith(FILE_KEY);
		});

		it("returns variants without keys (with warning) if getComponents fails", async () => {
			mockApi.getComponents.mockRejectedValueOnce(
				new Error("Network glitch"),
			);

			const tool = server._getTool("figma_get_library_component_by_key");
			const result = await tool.handler({
				componentKey: COMPONENT_SET_KEY,
			});
			const data = parseResult(result);

			expect(data.variants).toHaveLength(3);
			expect(data.variants.every((v: any) => v.key === undefined)).toBe(
				true,
			);
			expect(data.warnings).toBeDefined();
			expect(
				data.warnings.some((w: string) =>
					w.includes("variant key resolution"),
				),
			).toBe(true);
		});
	});

	describe("Standalone COMPONENT fallback", () => {
		it("falls back to /v1/components/{key} when /v1/component_sets/{key} returns 404", async () => {
			mockApi.getComponentSetByKey.mockRejectedValueOnce(notFoundError());

			const tool = server._getTool("figma_get_library_component_by_key");
			const result = await tool.handler({
				componentKey: STANDALONE_COMPONENT_KEY,
			});
			const data = parseResult(result);

			expect(data.resolvedAs).toBe("COMPONENT");
			expect(data.name).toBe("circle-button");
			expect(data.nodeId).toBe("2:200");
			expect(data.variants).toBeUndefined();
			expect(data.properties.Icon.type).toBe("INSTANCE_SWAP");

			// Standalone usage example uses the input key directly
			expect(data.usage.example).toContain(STANDALONE_COMPONENT_KEY);
			expect(data.usage.instantiate).toContain("standalone");

			expect(mockApi.getComponentByKey).toHaveBeenCalledWith(
				STANDALONE_COMPONENT_KEY,
			);
			// Should NOT call getComponents for standalone — we already have the key
			expect(mockApi.getComponents).not.toHaveBeenCalled();
		});
	});

	describe("Error handling", () => {
		it("returns a clean error when both endpoints 404", async () => {
			mockApi.getComponentSetByKey.mockRejectedValueOnce(notFoundError());
			mockApi.getComponentByKey.mockRejectedValueOnce(notFoundError());

			const tool = server._getTool("figma_get_library_component_by_key");
			const result = await tool.handler({ componentKey: UNKNOWN_KEY });
			const data = parseResult(result);

			expect(result.isError).toBe(true);
			expect(data.error).toContain("not found");
			expect(data.hint).toContain("Verify the key");
			expect(data.componentKey).toBe(UNKNOWN_KEY);
		});

		it("returns an auth hint on 403/Forbidden", async () => {
			mockApi.getComponentSetByKey.mockRejectedValueOnce(forbiddenError());

			const tool = server._getTool("figma_get_library_component_by_key");
			const result = await tool.handler({
				componentKey: COMPONENT_SET_KEY,
			});
			const data = parseResult(result);

			expect(result.isError).toBe(true);
			expect(data.hint).toContain("library_assets:read");
		});

		it("returns a rate-limit hint on 429", async () => {
			mockApi.getComponentSetByKey.mockRejectedValueOnce(rateLimitError());

			const tool = server._getTool("figma_get_library_component_by_key");
			const result = await tool.handler({
				componentKey: COMPONENT_SET_KEY,
			});
			const data = parseResult(result);

			expect(result.isError).toBe(true);
			expect(data.hint).toContain("Rate limited");
		});

		it("does NOT fall back to /components on non-404 errors from /component_sets", async () => {
			// Network error should bubble up, not silently fall through to the next endpoint
			mockApi.getComponentSetByKey.mockRejectedValueOnce(
				new Error("Figma API error (500): Internal Server Error"),
			);

			const tool = server._getTool("figma_get_library_component_by_key");
			const result = await tool.handler({
				componentKey: COMPONENT_SET_KEY,
			});
			const data = parseResult(result);

			expect(result.isError).toBe(true);
			expect(data.error).toContain("500");
			// Critically: we did NOT call getComponentByKey because it wasn't a 404
			expect(mockApi.getComponentByKey).not.toHaveBeenCalled();
		});
	});

	describe("Format and compression", () => {
		it("omits visualSpec when format='summary'", async () => {
			const tool = server._getTool("figma_get_library_component_by_key");
			const result = await tool.handler({
				componentKey: COMPONENT_SET_KEY,
				format: "summary",
			});
			const data = parseResult(result);

			expect(data.format).toBe("summary");
			expect(data.visualSpec).toBeUndefined();
			expect(
				data.variants.every((v: any) => v.visualSpec === undefined),
			).toBe(true);
			// Properties and variant names still present
			expect(data.properties).toBeDefined();
			expect(data.variants).toHaveLength(3);
		});

		it("omits visualSpec when includeVisualSpecs=false", async () => {
			const tool = server._getTool("figma_get_library_component_by_key");
			const result = await tool.handler({
				componentKey: COMPONENT_SET_KEY,
				includeVisualSpecs: false,
			});
			const data = parseResult(result);

			expect(data.visualSpec).toBeUndefined();
			expect(
				data.variants.every((v: any) => v.visualSpec === undefined),
			).toBe(true);
		});

		it("auto-strips visualSpec when response exceeds 500KB", async () => {
			// Inflate the node response with many large children to push past 500KB
			const bigChildren = Array.from({ length: 200 }, (_, i) => ({
				id: `1:${1000 + i}`,
				name: `Variant=Big${i}`,
				type: "COMPONENT",
				fills: Array.from({ length: 50 }, () => ({
					type: "SOLID",
					color: { r: Math.random(), g: Math.random(), b: Math.random(), a: 1 },
				})),
				strokes: Array.from({ length: 50 }, () => ({
					type: "SOLID",
					color: { r: Math.random(), g: Math.random(), b: Math.random(), a: 1 },
				})),
				effects: Array.from({ length: 20 }, (_, j) => ({
					type: "DROP_SHADOW",
					color: { r: 0, g: 0, b: 0, a: 0.5 },
					offset: { x: j, y: j },
					radius: j,
				})),
				strokeWeight: 2,
				strokeAlign: "INSIDE",
				cornerRadius: 8,
			}));

			mockApi.getNodes.mockResolvedValueOnce({
				nodes: {
					[SET_NODE_ID]: {
						document: {
							...MOCK_SET_NODES_RESPONSE.nodes[SET_NODE_ID].document,
							children: bigChildren,
						},
					},
				},
			});

			const tool = server._getTool("figma_get_library_component_by_key");
			const result = await tool.handler({
				componentKey: COMPONENT_SET_KEY,
				includeVisualSpecs: true,
				format: "full",
			});
			const data = parseResult(result);

			expect(data.compression).toBeDefined();
			expect(data.compression.strippedVisualSpecs).toBe(true);
			expect(data.compression.originalSizeKB).toBeGreaterThan(500);
			expect(
				data.variants.every((v: any) => v.visualSpec === undefined),
			).toBe(true);
			expect(data.warnings).toBeDefined();
			expect(
				data.warnings.some((w: string) => w.includes("KB")),
			).toBe(true);
		});
	});

	describe("Identity and contract", () => {
		it("always tags response with _mcp identity", async () => {
			const tool = server._getTool("figma_get_library_component_by_key");
			const result = await tool.handler({
				componentKey: COMPONENT_SET_KEY,
			});
			const data = parseResult(result);
			expect(data._mcp).toBe("figma-console-mcp");
		});

		it("returns isError=true on terminal failures (not on warning-only paths)", async () => {
			// getComponents failing is a warning, not a hard error
			mockApi.getComponents.mockRejectedValueOnce(new Error("network"));
			const tool = server._getTool("figma_get_library_component_by_key");
			const result = await tool.handler({
				componentKey: COMPONENT_SET_KEY,
			});
			expect(result.isError).toBeUndefined();
			const data = parseResult(result);
			expect(data.warnings).toBeDefined();
		});
	});
});

// ============================================================================
// Plugin-API tools — figma_get_library_variables + figma_import_library_variable
// ============================================================================

describe("Library Variable Tools (Plugin API)", () => {
	let server: ReturnType<typeof createMockServer>;
	let mockConnector: { executeCodeViaUI: jest.Mock };

	const MOCK_COLLECTIONS = [
		{
			libraryName: "Northright Wordpress Design System",
			collectionKey: "lib-coll-colors",
			collectionName: "Colors",
			variableCount: 2,
			variables: [
				{ key: "var-key-primary", name: "primary", resolvedType: "COLOR" },
				{ key: "var-key-secondary", name: "secondary", resolvedType: "COLOR" },
			],
		},
		{
			libraryName: "Northright Wordpress Design System",
			collectionKey: "lib-coll-spacing",
			collectionName: "Spacing",
			variableCount: 1,
			variables: [
				{ key: "var-key-md", name: "md", resolvedType: "FLOAT" },
			],
		},
		{
			libraryName: "Altitude Design System",
			collectionKey: "lib-coll-altitude-colors",
			collectionName: "Colors",
			variableCount: 1,
			variables: [
				{ key: "var-key-altitude-bg", name: "bg", resolvedType: "COLOR" },
			],
		},
	];

	beforeEach(() => {
		server = createMockServer();
		mockConnector = {
			executeCodeViaUI: jest.fn(),
		};
		registerLibraryVariableTools(server as any, async () => mockConnector as any);
	});

	it("registers both Plugin-API tools", () => {
		expect(server._getTool("figma_get_library_variables")).toBeDefined();
		expect(server._getTool("figma_import_library_variable")).toBeDefined();
	});

	describe("figma_get_library_variables", () => {
		it("returns all collections grouped by library when no filter is passed", async () => {
			mockConnector.executeCodeViaUI.mockResolvedValueOnce(MOCK_COLLECTIONS);

			const tool = server._getTool("figma_get_library_variables");
			const result = await tool.handler({});
			const data = parseResult(result);

			expect(data._mcp).toBe("figma-console-mcp");
			expect(data.collections).toHaveLength(3);
			expect(data.summary.totalCollections).toBe(3);
			expect(data.summary.totalVariables).toBe(4);
			expect(data.usage.import).toContain("figma_import_library_variable");
		});

		it("filters by libraryName (case-insensitive substring)", async () => {
			mockConnector.executeCodeViaUI.mockResolvedValueOnce(MOCK_COLLECTIONS);

			const tool = server._getTool("figma_get_library_variables");
			const result = await tool.handler({ libraryName: "northright" });
			const data = parseResult(result);

			expect(data.collections).toHaveLength(2);
			expect(
				data.collections.every((c: any) =>
					c.libraryName.includes("Northright"),
				),
			).toBe(true);
			expect(data.filters.libraryName).toBe("northright");
		});

		it("filters by resolvedType and prunes empty collections", async () => {
			mockConnector.executeCodeViaUI.mockResolvedValueOnce(MOCK_COLLECTIONS);

			const tool = server._getTool("figma_get_library_variables");
			const result = await tool.handler({ resolvedType: "FLOAT" });
			const data = parseResult(result);

			expect(data.collections).toHaveLength(1);
			expect(data.collections[0].collectionName).toBe("Spacing");
			expect(data.collections[0].variables).toHaveLength(1);
			expect(data.collections[0].variableCount).toBe(1);
		});

		it("returns __error sentinel as a clean isError response", async () => {
			mockConnector.executeCodeViaUI.mockResolvedValueOnce({
				__error: "figma.teamLibrary API not available.",
			});

			const tool = server._getTool("figma_get_library_variables");
			const result = await tool.handler({});
			const data = parseResult(result);

			expect(result.isError).toBe(true);
			expect(data.error).toContain("teamLibrary");
			expect(data.hint).toContain("Desktop Bridge");
		});

		it("surfaces connector failures with helpful hint", async () => {
			mockConnector.executeCodeViaUI.mockRejectedValueOnce(
				new Error("Desktop Bridge disconnected"),
			);

			const tool = server._getTool("figma_get_library_variables");
			const result = await tool.handler({});
			const data = parseResult(result);

			expect(result.isError).toBe(true);
			expect(data.error).toContain("disconnected");
			expect(data.hint).toContain("figma_get_status");
		});

		it("sends a Plugin API script that calls getAvailableLibraryVariableCollectionsAsync", async () => {
			mockConnector.executeCodeViaUI.mockResolvedValueOnce([]);

			const tool = server._getTool("figma_get_library_variables");
			await tool.handler({});

			expect(mockConnector.executeCodeViaUI).toHaveBeenCalledTimes(1);
			const [script] = mockConnector.executeCodeViaUI.mock.calls[0];
			expect(script).toContain(
				"figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync",
			);
			expect(script).toContain("getVariablesInLibraryCollectionAsync");
		});
	});

	describe("figma_import_library_variable", () => {
		const IMPORTED_VARIABLE = {
			id: "VariableID:1:42",
			key: "var-key-primary",
			name: "primary",
			resolvedType: "COLOR",
			description: null,
			variableCollectionId: "VariableCollectionId:1:7",
			remote: true,
		};

		it("imports a variable and returns its local id", async () => {
			mockConnector.executeCodeViaUI.mockResolvedValueOnce(IMPORTED_VARIABLE);

			const tool = server._getTool("figma_import_library_variable");
			const result = await tool.handler({ variableKey: "var-key-primary" });
			const data = parseResult(result);

			expect(data._mcp).toBe("figma-console-mcp");
			expect(data.imported.id).toBe("VariableID:1:42");
			expect(data.imported.name).toBe("primary");
			expect(data.imported.resolvedType).toBe("COLOR");
			expect(data.usage.bind).toContain("VariableID:1:42");
		});

		it("safely escapes the variable key into the Plugin script", async () => {
			mockConnector.executeCodeViaUI.mockResolvedValueOnce(IMPORTED_VARIABLE);

			const tool = server._getTool("figma_import_library_variable");
			// Try to break out of the JS string literal — this MUST be neutralized
			const evilKey = `evil-key"; figma.root.children.forEach(n=>n.remove()); //`;
			await tool.handler({ variableKey: evilKey });

			const [script] = mockConnector.executeCodeViaUI.mock.calls[0];
			// JSON.stringify escapes the double quote, so the injection becomes inert
			expect(script).toContain(JSON.stringify(evilKey));
			expect(script).not.toContain(`"${evilKey}"`);
		});

		it("returns a specific hint when library is not subscribed", async () => {
			mockConnector.executeCodeViaUI.mockResolvedValueOnce({
				__error: "The source library is not subscribed by this file.",
			});

			const tool = server._getTool("figma_import_library_variable");
			const result = await tool.handler({ variableKey: "var-key-x" });
			const data = parseResult(result);

			expect(result.isError).toBe(true);
			expect(data.hint).toContain("Subscribe");
			expect(data.variableKey).toBe("var-key-x");
		});

		it("returns generic hint for other __error sentinels", async () => {
			mockConnector.executeCodeViaUI.mockResolvedValueOnce({
				__error: "Some other plugin failure",
			});

			const tool = server._getTool("figma_import_library_variable");
			const result = await tool.handler({ variableKey: "var-key-x" });
			const data = parseResult(result);

			expect(result.isError).toBe(true);
			expect(data.hint).toContain("figma_get_library_variables");
		});

		it("handles connector throws (Desktop Bridge offline)", async () => {
			mockConnector.executeCodeViaUI.mockRejectedValueOnce(
				new Error("Connection refused"),
			);

			const tool = server._getTool("figma_import_library_variable");
			const result = await tool.handler({ variableKey: "var-key-x" });
			const data = parseResult(result);

			expect(result.isError).toBe(true);
			expect(data.error).toContain("Connection refused");
			expect(data.hint).toContain("Desktop Bridge");
		});

		it("sends a Plugin API script that calls importVariableByKeyAsync", async () => {
			mockConnector.executeCodeViaUI.mockResolvedValueOnce(IMPORTED_VARIABLE);

			const tool = server._getTool("figma_import_library_variable");
			await tool.handler({ variableKey: "var-key-primary" });

			const [script] = mockConnector.executeCodeViaUI.mock.calls[0];
			expect(script).toContain(
				"figma.variables.importVariableByKeyAsync",
			);
		});
	});
});
