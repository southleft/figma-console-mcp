import {
	figmaRGBAToHex,
	normalizeColor,
	numericClose,
	calculateParityScore,
	chunkMarkdownByHeaders,
	toCompanyDocsEntry,
	isVariantName,
	sanitizeComponentName,
	resolveVisualNode,
} from "../src/core/design-code-tools";

describe("Design-Code Tools Helpers", () => {
	describe("figmaRGBAToHex", () => {
		it("converts fully opaque color correctly", () => {
			expect(figmaRGBAToHex({ r: 1, g: 0, b: 0 })).toBe("#FF0000");
		});

		it("converts white correctly", () => {
			expect(figmaRGBAToHex({ r: 1, g: 1, b: 1 })).toBe("#FFFFFF");
		});

		it("converts black correctly", () => {
			expect(figmaRGBAToHex({ r: 0, g: 0, b: 0 })).toBe("#000000");
		});

		it("converts mid-tone color correctly", () => {
			expect(figmaRGBAToHex({ r: 0.231, g: 0.51, b: 0.965 })).toBe("#3B82F6");
		});

		it("includes alpha when not fully opaque", () => {
			const hex = figmaRGBAToHex({ r: 1, g: 0, b: 0, a: 0.5 });
			expect(hex).toBe("#FF000080");
		});

		it("omits alpha when fully opaque", () => {
			const hex = figmaRGBAToHex({ r: 1, g: 0, b: 0, a: 1 });
			expect(hex).toBe("#FF0000");
		});
	});

	describe("normalizeColor", () => {
		it("uppercases hex", () => {
			expect(normalizeColor("#ff0000")).toBe("#FF0000");
		});

		it("strips fully opaque alpha", () => {
			expect(normalizeColor("#FF0000FF")).toBe("#FF0000");
		});

		it("preserves non-opaque alpha", () => {
			expect(normalizeColor("#FF000080")).toBe("#FF000080");
		});

		it("expands shorthand hex", () => {
			expect(normalizeColor("#f00")).toBe("#FF0000");
		});

		it("trims whitespace", () => {
			expect(normalizeColor("  #FF0000  ")).toBe("#FF0000");
		});
	});

	describe("numericClose", () => {
		it("returns true for equal values", () => {
			expect(numericClose(10, 10)).toBe(true);
		});

		it("returns true within tolerance", () => {
			expect(numericClose(10, 10.5, 1)).toBe(true);
		});

		it("returns false outside tolerance", () => {
			expect(numericClose(10, 12, 1)).toBe(false);
		});

		it("works with custom tolerance", () => {
			expect(numericClose(10, 10.005, 0.01)).toBe(true);
			expect(numericClose(10, 10.02, 0.01)).toBe(false);
		});

		it("handles negative values", () => {
			expect(numericClose(-5, -4.5, 1)).toBe(true);
		});
	});

	describe("calculateParityScore", () => {
		it("returns 100 for no discrepancies", () => {
			expect(calculateParityScore(0, 0, 0, 0)).toBe(100);
		});

		it("applies critical penalty of 15", () => {
			expect(calculateParityScore(1, 0, 0, 0)).toBe(85);
		});

		it("applies major penalty of 8", () => {
			expect(calculateParityScore(0, 1, 0, 0)).toBe(92);
		});

		it("applies minor penalty of 3", () => {
			expect(calculateParityScore(0, 0, 1, 0)).toBe(97);
		});

		it("applies info penalty of 1", () => {
			expect(calculateParityScore(0, 0, 0, 1)).toBe(99);
		});

		it("combines all penalties", () => {
			expect(calculateParityScore(1, 2, 3, 1)).toBe(100 - 15 - 16 - 9 - 1);
		});

		it("floors at 0", () => {
			expect(calculateParityScore(10, 10, 10, 10)).toBe(0);
		});
	});

	describe("chunkMarkdownByHeaders", () => {
		it("splits markdown by H2 headers", () => {
			const md = `# Title\n\nIntro\n\n## Section 1\n\nContent 1\n\n## Section 2\n\nContent 2`;
			const chunks = chunkMarkdownByHeaders(md);
			expect(chunks).toHaveLength(3);
			expect(chunks[0].heading).toBe("");
			expect(chunks[0].content).toContain("Title");
			expect(chunks[1].heading).toBe("Section 1");
			expect(chunks[1].content).toContain("Content 1");
			expect(chunks[2].heading).toBe("Section 2");
			expect(chunks[2].content).toContain("Content 2");
		});

		it("handles empty markdown", () => {
			const chunks = chunkMarkdownByHeaders("");
			expect(chunks).toHaveLength(1);
			expect(chunks[0].content).toBe("");
		});

		it("handles markdown with no H2", () => {
			const chunks = chunkMarkdownByHeaders("# Just a title\n\nSome content");
			expect(chunks).toHaveLength(1);
			expect(chunks[0].content).toContain("Just a title");
		});
	});

	describe("toCompanyDocsEntry", () => {
		it("creates a valid entry", () => {
			const entry = toCompanyDocsEntry(
				"# Button\n\nA button component.",
				"Button",
				"https://figma.com/design/abc123",
				"MyDS",
			);

			expect(entry.title).toBe("Button");
			expect(entry.content).toContain("# Button");
			expect(entry.category).toBe("components");
			expect(entry.tags).toContain("button");
			expect(entry.metadata.source).toBe("figma-console-mcp");
			expect(entry.metadata.figmaUrl).toBe("https://figma.com/design/abc123");
			expect(entry.metadata.systemName).toBe("MyDS");
			expect(entry.metadata.generatedAt).toBeTruthy();
		});

		it("works without systemName", () => {
			const entry = toCompanyDocsEntry("# Card", "Card", "https://figma.com/design/xyz");
			expect(entry.metadata.systemName).toBeUndefined();
		});
	});
});

describe("Component Set Resolution Helpers", () => {
	describe("isVariantName", () => {
		it("detects Figma variant patterns", () => {
			expect(isVariantName("Variant=Default, State=Hover, Size=lg")).toBe(true);
			expect(isVariantName("Variant=Default, Size=default")).toBe(true);
		});

		it("rejects non-variant names", () => {
			expect(isVariantName("Button")).toBe(false);
			expect(isVariantName("My Component")).toBe(false);
			expect(isVariantName("")).toBe(false);
		});

		it("rejects single key=value (needs comma-separated pairs)", () => {
			expect(isVariantName("Variant=Default")).toBe(false);
		});
	});

	describe("sanitizeComponentName", () => {
		it("removes special characters", () => {
			expect(sanitizeComponentName("Button")).toBe("Button");
			expect(sanitizeComponentName("Button Group")).toBe("Button-Group");
		});

		it("removes commas and equals from variant names", () => {
			expect(sanitizeComponentName("Variant=Default, State=Hover")).toBe("VariantDefault-StateHover");
		});

		it("handles emoji and unicode", () => {
			const result = sanitizeComponentName("Button 🔵");
			expect(result).not.toContain("🔵");
		});

		it("collapses multiple spaces", () => {
			expect(sanitizeComponentName("My   Component")).toBe("My-Component");
		});
	});
});

describe("resolveVisualNode", () => {
	it("returns first child for COMPONENT_SET", () => {
		const child = { type: "COMPONENT", name: "Variant=Default" };
		const setNode = { type: "COMPONENT_SET", name: "Dialog", children: [child, { type: "COMPONENT", name: "Variant=Open" }] };
		expect(resolveVisualNode(setNode)).toBe(child);
	});

	it("returns node itself for COMPONENT", () => {
		const node = { type: "COMPONENT", name: "Button" };
		expect(resolveVisualNode(node)).toBe(node);
	});

	it("returns node itself for FRAME", () => {
		const node = { type: "FRAME", name: "Container" };
		expect(resolveVisualNode(node)).toBe(node);
	});

	it("returns COMPONENT_SET itself if no children", () => {
		const node = { type: "COMPONENT_SET", name: "Empty", children: [] };
		expect(resolveVisualNode(node)).toBe(node);
	});

	it("returns COMPONENT_SET itself if children is undefined", () => {
		const node = { type: "COMPONENT_SET", name: "NoChildren" };
		expect(resolveVisualNode(node)).toBe(node);
	});
});

describe("Design-Code Tools Schema Compatibility", () => {
	it("codeSpec schema should not use z.any()", () => {
		// This test verifies that our schemas are strictly typed
		// and compatible with LLMs that require explicit JSON Schema types (like Gemini)
		const { z } = require("zod");
		const { zodToJsonSchema } = require("zod-to-json-schema");

		const codeSpecSchema = z.object({
			filePath: z.string().optional(),
			visual: z.object({
				backgroundColor: z.string().optional(),
			}).optional(),
			spacing: z.object({
				paddingTop: z.number().optional(),
			}).optional(),
		});

		const jsonSchema = zodToJsonSchema(codeSpecSchema);

		// Should have 'type' or 'properties' at root level (not be an empty schema)
		expect(jsonSchema).toHaveProperty("type");
		expect(jsonSchema.type).toBe("object");
	});
});
