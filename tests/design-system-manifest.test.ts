/**
 * Design System Manifest Tests
 *
 * Unit tests for DesignSystemManifestCache, searchComponents, getCategories,
 * getTokenSummary, rgbToHex, figmaColorToHex, generateManifestSummary, createEmptyManifest.
 */

import {
	DesignSystemManifestCache,
	searchComponents,
	getCategories,
	getTokenSummary,
	rgbToHex,
	figmaColorToHex,
	generateManifestSummary,
	createEmptyManifest,
} from "../src/core/design-system-manifest";
import type { DesignSystemManifest } from "../src/core/design-system-manifest";

// ============================================================================
// Helpers
// ============================================================================

function makeManifest(overrides: Partial<DesignSystemManifest> = {}): DesignSystemManifest {
	return {
		version: "1.0.0",
		generatedAt: Date.now(),
		fileKey: "test-file",
		fileName: "Test Design System",
		collections: [],
		tokens: {
			colors: {},
			spacing: {},
			typography: {},
			effects: {},
			other: {},
		},
		components: {},
		componentSets: {},
		patterns: {},
		rules: [],
		summary: {
			totalTokens: 0,
			totalComponents: 0,
			totalComponentSets: 0,
			colorPalette: [],
			spacingScale: [],
			typographyScale: [],
			componentCategories: [],
		},
		...overrides,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("Design System Manifest", () => {
	// ========================================================================
	// rgbToHex
	// ========================================================================

	describe("rgbToHex", () => {
		it("converts pure red", () => {
			expect(rgbToHex({ r: 1, g: 0, b: 0 })).toBe("#FF0000");
		});

		it("converts pure green", () => {
			expect(rgbToHex({ r: 0, g: 1, b: 0 })).toBe("#00FF00");
		});

		it("converts pure blue", () => {
			expect(rgbToHex({ r: 0, g: 0, b: 1 })).toBe("#0000FF");
		});

		it("converts black", () => {
			expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe("#000000");
		});

		it("converts white", () => {
			expect(rgbToHex({ r: 1, g: 1, b: 1 })).toBe("#FFFFFF");
		});

		it("handles fractional values", () => {
			// 0.5 * 255 = 127.5 → rounds to 128 = 0x80
			expect(rgbToHex({ r: 0.5, g: 0.5, b: 0.5 })).toBe("#808080");
		});
	});

	// ========================================================================
	// figmaColorToHex
	// ========================================================================

	describe("figmaColorToHex", () => {
		it("returns string values as-is", () => {
			expect(figmaColorToHex("#FF0000")).toBe("#FF0000");
		});

		it("converts RGB object to hex", () => {
			expect(figmaColorToHex({ r: 1, g: 0, b: 0 })).toBe("#FF0000");
		});

		it("returns #000000 for unknown values", () => {
			expect(figmaColorToHex(null)).toBe("#000000");
			expect(figmaColorToHex(undefined)).toBe("#000000");
			expect(figmaColorToHex(42)).toBe("#000000");
		});
	});

	// ========================================================================
	// createEmptyManifest
	// ========================================================================

	describe("createEmptyManifest", () => {
		it("creates a manifest with the given fileKey", () => {
			const manifest = createEmptyManifest("abc123");
			expect(manifest.fileKey).toBe("abc123");
			expect(manifest.version).toBe("1.0.0");
		});

		it("has empty token collections", () => {
			const manifest = createEmptyManifest("key");
			expect(Object.keys(manifest.tokens.colors)).toHaveLength(0);
			expect(Object.keys(manifest.tokens.spacing)).toHaveLength(0);
			expect(Object.keys(manifest.tokens.typography)).toHaveLength(0);
			expect(Object.keys(manifest.tokens.effects)).toHaveLength(0);
		});

		it("has zero summary counts", () => {
			const manifest = createEmptyManifest("key");
			expect(manifest.summary.totalTokens).toBe(0);
			expect(manifest.summary.totalComponents).toBe(0);
			expect(manifest.summary.totalComponentSets).toBe(0);
		});
	});

	// ========================================================================
	// searchComponents
	// ========================================================================

	describe("searchComponents", () => {
		const manifest = makeManifest({
			componentSets: {
				"Button/Primary": {
					key: "btn-key",
					nodeId: "1:1",
					name: "Button/Primary",
					description: "Main action button",
					variants: [],
					variantAxes: [],
				},
				"Input/Text": {
					key: "inp-key",
					nodeId: "2:1",
					name: "Input/Text",
					description: "Text input field",
					variants: [],
					variantAxes: [],
				},
			},
			components: {
				"Icon/Arrow": {
					key: "ico-key",
					nodeId: "3:1",
					name: "Icon/Arrow",
					description: "Arrow icon",
				},
			},
		});

		it("finds components by name query", () => {
			const { results, total } = searchComponents(manifest, "Button");
			expect(total).toBe(1);
			expect(results[0].name).toBe("Button/Primary");
		});

		it("finds components by description", () => {
			const { results } = searchComponents(manifest, "arrow");
			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Icon/Arrow");
		});

		it("returns all with empty query", () => {
			const { total } = searchComponents(manifest, "");
			expect(total).toBe(3); // 2 sets + 1 component
		});

		it("filters by category", () => {
			const { results } = searchComponents(manifest, "", { category: "Input" });
			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Input/Text");
		});

		it("supports pagination with limit and offset", () => {
			const { results, hasMore } = searchComponents(manifest, "", {
				limit: 2,
				offset: 0,
			});
			expect(results).toHaveLength(2);
			expect(hasMore).toBe(true);

			const page2 = searchComponents(manifest, "", { limit: 2, offset: 2 });
			expect(page2.results).toHaveLength(1);
			expect(page2.hasMore).toBe(false);
		});

		it("returns empty for no matches", () => {
			const { results, total } = searchComponents(manifest, "nonexistent");
			expect(results).toHaveLength(0);
			expect(total).toBe(0);
		});
	});

	// ========================================================================
	// getCategories
	// ========================================================================

	describe("getCategories", () => {
		it("extracts categories from component names", () => {
			const manifest = makeManifest({
				componentSets: {
					"Button/Primary": { key: "k", nodeId: "1", name: "Button/Primary", variants: [], variantAxes: [] },
					"Button/Secondary": { key: "k2", nodeId: "2", name: "Button/Secondary", variants: [], variantAxes: [] },
				},
				components: {
					"Icon/Arrow": { key: "k3", nodeId: "3", name: "Icon/Arrow" },
				},
			});

			const categories = getCategories(manifest);
			expect(categories).toHaveLength(2);

			const button = categories.find((c) => c.name === "Button");
			expect(button).toBeDefined();
			expect(button!.componentSetCount).toBe(2);

			const icon = categories.find((c) => c.name === "Icon");
			expect(icon).toBeDefined();
			expect(icon!.componentCount).toBe(1);
		});

		it("returns empty for empty manifest", () => {
			const manifest = makeManifest();
			expect(getCategories(manifest)).toHaveLength(0);
		});

		it("sorts by total count descending", () => {
			const manifest = makeManifest({
				componentSets: {
					"A/One": { key: "k", nodeId: "1", name: "A/One", variants: [], variantAxes: [] },
				},
				components: {
					"B/One": { key: "k2", nodeId: "2", name: "B/One" },
					"B/Two": { key: "k3", nodeId: "3", name: "B/Two" },
					"B/Three": { key: "k4", nodeId: "4", name: "B/Three" },
				},
			});

			const categories = getCategories(manifest);
			expect(categories[0].name).toBe("B"); // 3 items
			expect(categories[1].name).toBe("A"); // 1 item
		});
	});

	// ========================================================================
	// getTokenSummary
	// ========================================================================

	describe("getTokenSummary", () => {
		it("counts tokens by type", () => {
			const manifest = makeManifest({
				tokens: {
					colors: {
						"primary/500": { name: "primary/500", value: "#3B82F6" },
						"primary/600": { name: "primary/600", value: "#2563EB" },
					},
					spacing: {
						"sm": { name: "sm", value: 4 },
						"md": { name: "md", value: 8 },
						"lg": { name: "lg", value: 16 },
					},
					typography: {},
					effects: {},
					other: {},
				},
				collections: [{ id: "c1", name: "Primitives", modes: [], defaultModeId: "m1" }],
			});

			const summary = getTokenSummary(manifest);
			expect(summary.colors.count).toBe(2);
			expect(summary.spacing.count).toBe(3);
			expect(summary.spacing.scale).toEqual([4, 8, 16]);
			expect(summary.collections).toEqual(["Primitives"]);
		});

		it("groups colors by prefix", () => {
			const manifest = makeManifest({
				tokens: {
					colors: {
						"primary/100": { name: "primary/100", value: "#EFF6FF" },
						"primary/500": { name: "primary/500", value: "#3B82F6" },
						"secondary/500": { name: "secondary/500", value: "#8B5CF6" },
					},
					spacing: {},
					typography: {},
					effects: {},
					other: {},
				},
			});

			const summary = getTokenSummary(manifest);
			expect(summary.colors.groups).toContain("primary");
			expect(summary.colors.groups).toContain("secondary");
		});

		it("deduplicates spacing values", () => {
			const manifest = makeManifest({
				tokens: {
					colors: {},
					spacing: {
						"padding-sm": { name: "padding-sm", value: 4 },
						"gap-sm": { name: "gap-sm", value: 4 },
						"padding-md": { name: "padding-md", value: 8 },
					},
					typography: {},
					effects: {},
					other: {},
				},
			});

			const summary = getTokenSummary(manifest);
			expect(summary.spacing.scale).toEqual([4, 8]);
		});
	});

	// ========================================================================
	// generateManifestSummary
	// ========================================================================

	describe("generateManifestSummary", () => {
		it("generates markdown with file name", () => {
			const manifest = makeManifest({ fileName: "My Design System" });
			const md = generateManifestSummary(manifest);
			expect(md).toContain("My Design System");
			expect(md).toContain("# Design System Manifest");
		});

		it("includes token and component counts", () => {
			const manifest = makeManifest({
				summary: {
					totalTokens: 42,
					totalComponents: 10,
					totalComponentSets: 5,
					colorPalette: ["#FF0000"],
					spacingScale: [4, 8, 16],
					typographyScale: ["Heading 1"],
					componentCategories: ["Buttons"],
				},
			});

			const md = generateManifestSummary(manifest);
			expect(md).toContain("**42** design tokens");
			expect(md).toContain("**10** components");
			expect(md).toContain("**5** component sets");
		});
	});

	// ========================================================================
	// DesignSystemManifestCache
	// ========================================================================

	describe("DesignSystemManifestCache", () => {
		let cache: DesignSystemManifestCache;

		beforeEach(() => {
			cache = DesignSystemManifestCache.getInstance();
			cache.invalidateAll();
		});

		it("returns same instance (singleton)", () => {
			const a = DesignSystemManifestCache.getInstance();
			const b = DesignSystemManifestCache.getInstance();
			expect(a).toBe(b);
		});

		it("stores and retrieves a manifest", () => {
			const manifest = makeManifest({ fileKey: "f1" });
			cache.set("f1", manifest);

			const entry = cache.get("f1");
			expect(entry).not.toBeNull();
			expect(entry!.manifest.fileKey).toBe("f1");
		});

		it("returns null for missing keys", () => {
			expect(cache.get("nonexistent")).toBeNull();
		});

		it("invalidates a specific key", () => {
			cache.set("f1", makeManifest());
			cache.invalidate("f1");
			expect(cache.get("f1")).toBeNull();
		});

		it("invalidates all keys", () => {
			cache.set("f1", makeManifest());
			cache.set("f2", makeManifest());
			cache.invalidateAll();
			expect(cache.get("f1")).toBeNull();
			expect(cache.get("f2")).toBeNull();
		});

		it("reports stats for cached entries", () => {
			cache.set("f1", makeManifest({
				summary: { totalTokens: 10, totalComponents: 5, totalComponentSets: 2, colorPalette: [], spacingScale: [], typographyScale: [], componentCategories: [] },
			}));

			const stats = cache.getStats();
			expect(stats).toHaveLength(1);
			expect(stats[0].fileKey).toBe("f1");
			expect(stats[0].tokenCount).toBe(10);
			expect(stats[0].componentCount).toBe(7); // 5 + 2
		});

		it("expires entries after TTL", () => {
			const manifest = makeManifest();
			cache.set("f1", manifest);

			// Get the entry and manually backdate it
			const entry = cache.get("f1")!;
			entry.timestamp = Date.now() - 6 * 60 * 1000; // 6 minutes ago (TTL is 5 min)

			expect(cache.isValid(entry)).toBe(false);
			// get() should also return null for expired entries
			expect(cache.get("f1")).toBeNull();
		});
	});
});
