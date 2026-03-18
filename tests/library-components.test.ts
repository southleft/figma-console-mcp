/**
 * Library Component Access Tests
 *
 * Tests for figma_get_library_components and the library search path
 * in figma_search_components. These tools enable cross-file published
 * library component discovery via the Figma REST API.
 *
 * The core logic: REST API discovers component keys from library files,
 * then figma_instantiate_component uses importComponentByKeyAsync() to
 * import them into the current file.
 */

import { extractFileKey } from "../src/core/figma-api";

// ============================================================================
// Mock REST API response data
// ============================================================================

// Format A: containingComponentSet as boolean + containing_frame.nodeId matches set
// (This is the simplified/legacy format some API responses use)
const MOCK_LIBRARY_COMPONENTS_BOOLEAN = {
	meta: {
		components: [
			{
				key: "btn-primary-key",
				file_key: "lib123",
				node_id: "1:100",
				name: "Type=Primary, State=Default",
				description: "Primary button variant",
				containing_frame: {
					name: "Button",
					nodeId: "1:99",
					containingComponentSet: true,
				},
			},
			{
				key: "btn-secondary-key",
				file_key: "lib123",
				node_id: "1:101",
				name: "Type=Secondary, State=Default",
				description: "Secondary button variant",
				containing_frame: {
					name: "Button",
					nodeId: "1:99",
					containingComponentSet: true,
				},
			},
			{
				key: "btn-ghost-key",
				file_key: "lib123",
				node_id: "1:102",
				name: "Type=Ghost, State=Default",
				description: "",
				containing_frame: {
					name: "Button",
					nodeId: "1:99",
					containingComponentSet: true,
				},
			},
			{
				key: "card-key",
				file_key: "lib123",
				node_id: "1:200",
				name: "Card",
				description: "Content card component",
				containing_frame: {
					name: "Cards",
					nodeId: "1:199",
					containingComponentSet: false,
				},
			},
			{
				key: "badge-key",
				file_key: "lib123",
				node_id: "1:300",
				name: "Badge",
				description: "Status badge",
				containing_frame: {
					name: "Feedback",
					nodeId: "1:299",
					containingComponentSet: false,
				},
			},
			{
				key: "input-text-key",
				file_key: "lib123",
				node_id: "1:401",
				name: "Type=Text",
				description: "Text input variant",
				containing_frame: {
					name: "Input",
					nodeId: "1:400",
					containingComponentSet: true,
				},
			},
			{
				key: "input-password-key",
				file_key: "lib123",
				node_id: "1:402",
				name: "Type=Password",
				description: "Password input variant",
				containing_frame: {
					name: "Input",
					nodeId: "1:400",
					containingComponentSet: true,
				},
			},
		],
	},
};

// Format B: containingComponentSet as object { name, nodeId }
// (This is the real-world format from Figma REST API)
const MOCK_LIBRARY_COMPONENTS_OBJECT = {
	meta: {
		components: [
			{
				key: "btn-primary-key",
				file_key: "lib123",
				node_id: "1:100",
				name: "Type=Primary, State=Default",
				description: "Primary button variant",
				containing_frame: {
					name: "Buttons Section",
					nodeId: "1:50",  // Frame nodeId, NOT the component set
					pageName: "Components",
					containingComponentSet: {
						name: "Button",
						nodeId: "1:99",  // Component set nodeId
					},
				},
			},
			{
				key: "btn-secondary-key",
				file_key: "lib123",
				node_id: "1:101",
				name: "Type=Secondary, State=Default",
				description: "Secondary button variant",
				containing_frame: {
					name: "Buttons Section",
					nodeId: "1:50",
					pageName: "Components",
					containingComponentSet: {
						name: "Button",
						nodeId: "1:99",
					},
				},
			},
			{
				key: "btn-ghost-key",
				file_key: "lib123",
				node_id: "1:102",
				name: "Type=Ghost, State=Default",
				description: "",
				containing_frame: {
					name: "Buttons Section",
					nodeId: "1:50",
					pageName: "Components",
					containingComponentSet: {
						name: "Button",
						nodeId: "1:99",
					},
				},
			},
			{
				key: "card-key",
				file_key: "lib123",
				node_id: "1:200",
				name: "Card",
				description: "Content card component",
				containing_frame: {
					name: "Cards Section",
					nodeId: "1:199",
					pageName: "Components",
				},
			},
			{
				key: "badge-key",
				file_key: "lib123",
				node_id: "1:300",
				name: "Badge",
				description: "Status badge",
				containing_frame: {
					name: "Feedback Section",
					nodeId: "1:299",
					pageName: "Components",
				},
			},
			{
				key: "input-text-key",
				file_key: "lib123",
				node_id: "1:401",
				name: "Type=Text",
				description: "Text input variant",
				containing_frame: {
					name: "Inputs Section",
					nodeId: "1:350",
					pageName: "Components",
					containingComponentSet: {
						name: "Input",
						nodeId: "1:400",
					},
				},
			},
			{
				key: "input-password-key",
				file_key: "lib123",
				node_id: "1:402",
				name: "Type=Password",
				description: "Password input variant",
				containing_frame: {
					name: "Inputs Section",
					nodeId: "1:350",
					pageName: "Components",
					containingComponentSet: {
						name: "Input",
						nodeId: "1:400",
					},
				},
			},
		],
	},
};

// Format C: component_set_id field (alternative Figma API field)
const MOCK_LIBRARY_COMPONENTS_SET_ID = {
	meta: {
		components: [
			{
				key: "btn-primary-key",
				file_key: "lib123",
				node_id: "1:100",
				name: "Type=Primary, State=Default",
				description: "Primary button variant",
				component_set_id: "1:99",
				component_set_name: "Button",
				containing_frame: {
					name: "Page 1",
					nodeId: "0:1",
				},
			},
			{
				key: "card-key",
				file_key: "lib123",
				node_id: "1:200",
				name: "Card",
				description: "Content card component",
				containing_frame: {
					name: "Page 1",
					nodeId: "0:1",
				},
			},
		],
	},
};

const MOCK_LIBRARY_COMPONENT_SETS = {
	meta: {
		component_sets: [
			{
				key: "btn-set-key",
				file_key: "lib123",
				node_id: "1:99",
				name: "Button",
				description: "Button component with variants",
			},
			{
				key: "input-set-key",
				file_key: "lib123",
				node_id: "1:400",
				name: "Input",
				description: "Input component with variants",
			},
		],
	},
};

// ============================================================================
// Helper: Process library response (mirrors the logic in local.ts tools)
// Updated to match the fixed variant matching with multiple format support
// ============================================================================

function processLibraryResponse(
	componentsResponse: any,
	componentSetsResponse: any,
	options?: {
		query?: string;
		includeVariants?: boolean;
		limit?: number;
		offset?: number;
	}
) {
	const rawComponents = componentsResponse?.meta?.components || [];
	const rawComponentSets =
		componentSetsResponse?.meta?.component_sets || [];

	// Helper: check if a component belongs to a given component set
	// REST API returns containingComponentSet as an object { name, nodeId }
	const isVariantOf = (c: any, csNodeId: string): boolean => {
		const ccs = c.containing_frame?.containingComponentSet;
		// Match via containingComponentSet object (preferred — real API format)
		if (ccs && typeof ccs === "object" && ccs.nodeId === csNodeId) return true;
		// Fallback: match via containing_frame.nodeId (boolean format)
		if (ccs && c.containing_frame?.nodeId === csNodeId) return true;
		// Fallback: match via component_set_id field
		if (c.component_set_id === csNodeId) return true;
		return false;
	};
	const isVariant = (c: any): boolean => {
		return !!(c.containing_frame?.containingComponentSet || c.component_set_id);
	};
	const getParentSetName = (c: any): string | undefined => {
		const ccs = c.containing_frame?.containingComponentSet;
		if (ccs && typeof ccs === "object" && ccs.name) return ccs.name;
		return c.containing_frame?.name || c.component_set_name || undefined;
	};

	// Process component sets
	const componentSets = rawComponentSets.map((cs: any) => {
		const variants = rawComponents.filter((c: any) => isVariantOf(c, cs.node_id));
		return {
			name: cs.name,
			key: cs.key,
			nodeId: cs.node_id,
			description: cs.description || undefined,
			type: "COMPONENT_SET" as const,
			variantCount: variants.length,
			variants: variants.map((v: any) => ({
				name: v.name,
				key: v.key,
				nodeId: v.node_id,
			})),
		};
	});

	// Process standalone components
	const standaloneComponents = rawComponents
		.filter((c: any) => !isVariant(c))
		.map((c: any) => ({
			name: c.name,
			key: c.key,
			nodeId: c.node_id,
			description: c.description || undefined,
			type: "COMPONENT" as const,
		}));

	let allResults: any[] = [...componentSets, ...standaloneComponents];

	// Include individual variants if requested
	if (options?.includeVariants) {
		const variantComponents = rawComponents
			.filter((c: any) => isVariant(c))
			.map((c: any) => ({
				name: c.name,
				key: c.key,
				nodeId: c.node_id,
				description: c.description || undefined,
				type: "VARIANT" as const,
				parentSetName: getParentSetName(c),
			}));
		allResults = [...allResults, ...variantComponents];
	}

	// Apply search filter
	if (options?.query) {
		const queryLower = options.query.toLowerCase();
		allResults = allResults.filter(
			(item) =>
				item.name.toLowerCase().includes(queryLower) ||
				item.description?.toLowerCase().includes(queryLower)
		);
	}

	// Sort
	allResults.sort((a, b) => a.name.localeCompare(b.name));

	// Paginate
	const limit = Math.min(options?.limit || 25, 100);
	const offset = options?.offset || 0;
	const total = allResults.length;
	const paginatedResults = allResults.slice(offset, offset + limit);
	const hasMore = offset + limit < total;

	return {
		componentSets,
		standaloneComponents,
		allResults: paginatedResults,
		total,
		hasMore,
		rawComponentCount: rawComponents.length,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("Library Component Access", () => {
	// ========================================================================
	// extractFileKey utility
	// ========================================================================

	describe("extractFileKey", () => {
		it("should extract file key from design URL", () => {
			expect(
				extractFileKey("https://www.figma.com/design/abc123XYZ/My-Design-System")
			).toBe("abc123XYZ");
		});

		it("should extract file key from file URL", () => {
			expect(
				extractFileKey("https://www.figma.com/file/def456/Another-File")
			).toBe("def456");
		});

		it("should extract file key from URL with query params", () => {
			expect(
				extractFileKey("https://www.figma.com/design/abc123/File?node-id=1:2&t=xyz")
			).toBe("abc123");
		});

		it("should return null for invalid URLs", () => {
			expect(extractFileKey("not-a-url")).toBeNull();
			expect(extractFileKey("https://www.figma.com/board/abc123/file")).toBeNull();
		});
	});

	// ========================================================================
	// Variant matching formats (critical — the bug that was discovered)
	// ========================================================================

	describe("Variant matching formats", () => {
		it("should match variants with boolean containingComponentSet (legacy format)", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_BOOLEAN,
				MOCK_LIBRARY_COMPONENT_SETS
			);

			const buttonSet = result.componentSets.find((cs: any) => cs.name === "Button");
			expect(buttonSet).toBeDefined();
			expect(buttonSet.variantCount).toBe(3);
		});

		it("should match variants with object containingComponentSet (real API format)", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_OBJECT,
				MOCK_LIBRARY_COMPONENT_SETS
			);

			const buttonSet = result.componentSets.find((cs: any) => cs.name === "Button");
			expect(buttonSet).toBeDefined();
			expect(buttonSet.variantCount).toBe(3);
			expect(buttonSet.variants.map((v: any) => v.key)).toEqual(
				expect.arrayContaining(["btn-primary-key", "btn-secondary-key", "btn-ghost-key"])
			);
		});

		it("should match variants with object format when frame nodeId differs from set nodeId", () => {
			// This is the real-world scenario: containing_frame.nodeId is "1:50" (the section)
			// but containingComponentSet.nodeId is "1:99" (the actual component set)
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_OBJECT,
				MOCK_LIBRARY_COMPONENT_SETS
			);

			const inputSet = result.componentSets.find((cs: any) => cs.name === "Input");
			expect(inputSet).toBeDefined();
			expect(inputSet.variantCount).toBe(2);
		});

		it("should match variants via component_set_id fallback", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_SET_ID,
				MOCK_LIBRARY_COMPONENT_SETS
			);

			const buttonSet = result.componentSets.find((cs: any) => cs.name === "Button");
			expect(buttonSet).toBeDefined();
			expect(buttonSet.variantCount).toBe(1);
			expect(buttonSet.variants[0].key).toBe("btn-primary-key");
		});

		it("should correctly identify standalone components with object format", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_OBJECT,
				MOCK_LIBRARY_COMPONENT_SETS
			);

			expect(result.standaloneComponents).toHaveLength(2);
			expect(result.standaloneComponents.map((c: any) => c.name)).toEqual(
				expect.arrayContaining(["Card", "Badge"])
			);
		});

		it("should correctly identify standalone components with component_set_id format", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_SET_ID,
				MOCK_LIBRARY_COMPONENT_SETS
			);

			expect(result.standaloneComponents).toHaveLength(1);
			expect(result.standaloneComponents[0].name).toBe("Card");
		});

		it("should extract parent set name from containingComponentSet object", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_OBJECT,
				MOCK_LIBRARY_COMPONENT_SETS,
				{ includeVariants: true }
			);

			const variant = result.allResults.find(
				(r: any) => r.type === "VARIANT" && r.key === "btn-primary-key"
			);
			expect(variant).toBeDefined();
			expect(variant.parentSetName).toBe("Button");
		});

		it("should extract parent set name from component_set_name field when no containing_frame.name", () => {
			// Create a mock with component_set_name but no containing_frame.name
			const mockWithSetName = {
				meta: {
					components: [
						{
							key: "btn-primary-key",
							file_key: "lib123",
							node_id: "1:100",
							name: "Type=Primary",
							description: "",
							component_set_id: "1:99",
							component_set_name: "Button",
							containing_frame: null,
						},
					],
				},
			};

			const result = processLibraryResponse(
				mockWithSetName,
				MOCK_LIBRARY_COMPONENT_SETS,
				{ includeVariants: true }
			);

			const variant = result.allResults.find(
				(r: any) => r.type === "VARIANT" && r.key === "btn-primary-key"
			);
			expect(variant).toBeDefined();
			expect(variant.parentSetName).toBe("Button");
		});
	});

	// ========================================================================
	// Component set processing (using boolean format for backward compat tests)
	// ========================================================================

	describe("Component set grouping", () => {
		it("should group variants under their component sets", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_BOOLEAN,
				MOCK_LIBRARY_COMPONENT_SETS
			);

			const buttonSet = result.componentSets.find((cs: any) => cs.name === "Button");
			expect(buttonSet).toBeDefined();
			expect(buttonSet.variantCount).toBe(3);
			expect(buttonSet.key).toBe("btn-set-key");
			expect(buttonSet.type).toBe("COMPONENT_SET");
		});

		it("should identify standalone components correctly", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_BOOLEAN,
				MOCK_LIBRARY_COMPONENT_SETS
			);

			expect(result.standaloneComponents).toHaveLength(2);
			const card = result.standaloneComponents.find((c: any) => c.name === "Card");
			expect(card).toBeDefined();
			expect(card.type).toBe("COMPONENT");
			expect(card.key).toBe("card-key");
		});

		it("should not include variants in default results", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_BOOLEAN,
				MOCK_LIBRARY_COMPONENT_SETS
			);

			expect(result.allResults).toHaveLength(4);
			const types = result.allResults.map((r: any) => r.type);
			expect(types).not.toContain("VARIANT");
		});

		it("should include variants when includeVariants is true", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_BOOLEAN,
				MOCK_LIBRARY_COMPONENT_SETS,
				{ includeVariants: true }
			);

			expect(result.total).toBe(9);
			const variantResults = result.allResults.filter((r: any) => r.type === "VARIANT");
			expect(variantResults.length).toBeGreaterThan(0);
		});
	});

	// ========================================================================
	// Search / filtering
	// ========================================================================

	describe("Search filtering", () => {
		it("should filter by name query", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_BOOLEAN,
				MOCK_LIBRARY_COMPONENT_SETS,
				{ query: "Button" }
			);

			expect(result.allResults).toHaveLength(1);
			expect(result.allResults[0].name).toBe("Button");
		});

		it("should filter by description query", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_BOOLEAN,
				MOCK_LIBRARY_COMPONENT_SETS,
				{ query: "content card" }
			);

			expect(result.allResults).toHaveLength(1);
			expect(result.allResults[0].name).toBe("Card");
		});

		it("should be case-insensitive", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_BOOLEAN,
				MOCK_LIBRARY_COMPONENT_SETS,
				{ query: "button" }
			);

			expect(result.allResults).toHaveLength(1);
			expect(result.allResults[0].name).toBe("Button");
		});

		it("should return all results when query is empty", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_BOOLEAN,
				MOCK_LIBRARY_COMPONENT_SETS
			);

			expect(result.total).toBe(4);
		});

		it("should return empty results for non-matching query", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_BOOLEAN,
				MOCK_LIBRARY_COMPONENT_SETS,
				{ query: "nonexistent-component" }
			);

			expect(result.allResults).toHaveLength(0);
			expect(result.total).toBe(0);
		});
	});

	// ========================================================================
	// Pagination
	// ========================================================================

	describe("Pagination", () => {
		it("should respect limit", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_BOOLEAN,
				MOCK_LIBRARY_COMPONENT_SETS,
				{ limit: 2 }
			);

			expect(result.allResults).toHaveLength(2);
			expect(result.hasMore).toBe(true);
			expect(result.total).toBe(4);
		});

		it("should respect offset", () => {
			const firstPage = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_BOOLEAN,
				MOCK_LIBRARY_COMPONENT_SETS,
				{ limit: 2, offset: 0 }
			);
			const secondPage = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_BOOLEAN,
				MOCK_LIBRARY_COMPONENT_SETS,
				{ limit: 2, offset: 2 }
			);

			expect(firstPage.allResults[0].name).not.toBe(secondPage.allResults[0].name);
			expect(secondPage.hasMore).toBe(false);
		});

		it("should cap limit at 100", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_BOOLEAN,
				MOCK_LIBRARY_COMPONENT_SETS,
				{ limit: 500 }
			);

			expect(result.allResults).toHaveLength(4);
		});
	});

	// ========================================================================
	// Sorting
	// ========================================================================

	describe("Sorting", () => {
		it("should sort results alphabetically by name", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_BOOLEAN,
				MOCK_LIBRARY_COMPONENT_SETS
			);

			const names = result.allResults.map((r: any) => r.name);
			const sorted = [...names].sort();
			expect(names).toEqual(sorted);
		});
	});

	// ========================================================================
	// Edge cases
	// ========================================================================

	describe("Edge cases", () => {
		it("should handle empty component responses", () => {
			const result = processLibraryResponse(
				{ meta: { components: [] } },
				{ meta: { component_sets: [] } }
			);

			expect(result.allResults).toHaveLength(0);
			expect(result.total).toBe(0);
			expect(result.componentSets).toHaveLength(0);
			expect(result.standaloneComponents).toHaveLength(0);
		});

		it("should handle null/undefined meta gracefully", () => {
			const result = processLibraryResponse({}, {});

			expect(result.allResults).toHaveLength(0);
			expect(result.total).toBe(0);
		});

		it("should handle components with no containing_frame", () => {
			const orphanComponents = {
				meta: {
					components: [
						{
							key: "orphan-key",
							file_key: "lib123",
							node_id: "1:500",
							name: "OrphanComponent",
							description: "No frame",
							containing_frame: null,
						},
					],
				},
			};

			const result = processLibraryResponse(orphanComponents, {
				meta: { component_sets: [] },
			});

			expect(result.standaloneComponents).toHaveLength(1);
			expect(result.standaloneComponents[0].name).toBe("OrphanComponent");
		});

		it("should handle component sets with no matching variants", () => {
			const emptySet = {
				meta: {
					component_sets: [
						{
							key: "empty-set-key",
							file_key: "lib123",
							node_id: "1:999",
							name: "EmptySet",
							description: "No variants",
						},
					],
				},
			};

			const result = processLibraryResponse(
				{ meta: { components: [] } },
				emptySet
			);

			expect(result.componentSets).toHaveLength(1);
			expect(result.componentSets[0].variantCount).toBe(0);
			expect(result.componentSets[0].variants).toHaveLength(0);
		});
	});

	// ========================================================================
	// Component key integrity
	// ========================================================================

	describe("Component key integrity", () => {
		it("should preserve component keys for importComponentByKeyAsync", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_OBJECT,
				MOCK_LIBRARY_COMPONENT_SETS
			);

			for (const item of result.allResults) {
				expect(item.key).toBeDefined();
				expect(typeof item.key).toBe("string");
				expect(item.key.length).toBeGreaterThan(0);
			}
		});

		it("should include variant keys in component set results", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_OBJECT,
				MOCK_LIBRARY_COMPONENT_SETS
			);

			const buttonSet = result.componentSets.find((cs: any) => cs.name === "Button");
			expect(buttonSet.variants).toHaveLength(3);

			for (const variant of buttonSet.variants) {
				expect(variant.key).toBeDefined();
				expect(typeof variant.key).toBe("string");
			}
		});

		it("should have the set key distinct from variant keys", () => {
			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_OBJECT,
				MOCK_LIBRARY_COMPONENT_SETS
			);

			const buttonSet = result.componentSets.find((cs: any) => cs.name === "Button");
			const variantKeys = buttonSet.variants.map((v: any) => v.key);

			expect(variantKeys).not.toContain(buttonSet.key);
		});
	});

	// ========================================================================
	// Full workflow simulation
	// ========================================================================

	describe("Full workflow simulation", () => {
		it("should support discover → filter → instantiate workflow (object format)", () => {
			const allComponents = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_OBJECT,
				MOCK_LIBRARY_COMPONENT_SETS
			);
			expect(allComponents.total).toBeGreaterThan(0);

			const buttonSearch = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_OBJECT,
				MOCK_LIBRARY_COMPONENT_SETS,
				{ query: "Button" }
			);
			expect(buttonSearch.allResults).toHaveLength(1);

			const buttonKey = buttonSearch.allResults[0].key;
			expect(buttonKey).toBe("btn-set-key");

			const buttonVariants = buttonSearch.allResults[0].variants;
			expect(buttonVariants.length).toBeGreaterThan(0);
			const primaryVariantKey = buttonVariants.find(
				(v: any) => v.name.includes("Primary")
			)?.key;
			expect(primaryVariantKey).toBe("btn-primary-key");
		});

		it("should support library URL → file key extraction → component discovery", () => {
			const fileKey = extractFileKey(
				"https://www.figma.com/design/lib123/My-Design-System"
			);
			expect(fileKey).toBe("lib123");

			const result = processLibraryResponse(
				MOCK_LIBRARY_COMPONENTS_OBJECT,
				MOCK_LIBRARY_COMPONENT_SETS
			);
			expect(result.total).toBe(4);
		});
	});
});
