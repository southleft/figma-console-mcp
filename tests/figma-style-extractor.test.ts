/**
 * Figma Style Extractor Tests
 *
 * Tests actual extraction logic: color parsing, typography detection,
 * spacing/radius categorization, deduplication, tree depth limiting,
 * and output formatting.
 */

import { FigmaStyleExtractor } from "../src/core/figma-style-extractor";

// ============================================================================
// Tests
// ============================================================================

describe("FigmaStyleExtractor", () => {
	let extractor: FigmaStyleExtractor;

	beforeEach(() => {
		extractor = new FigmaStyleExtractor();
	});

	// ========================================================================
	// Color extraction
	// ========================================================================

	describe("color extraction", () => {
		it("extracts solid fill colors as hex", async () => {
			const fileData = {
				document: {
					id: "0:0",
					name: "Doc",
					type: "DOCUMENT",
					children: [
						{
							id: "1:1",
							name: "Blue Rectangle",
							type: "RECTANGLE",
							fills: [
								{
									type: "SOLID",
									color: { r: 0, g: 0, b: 1, a: 1 },
								},
							],
						},
					],
				},
			};

			const vars = await extractor.extractStylesFromFile(fileData);
			const colors = vars.filter((v) => v.type === "COLOR");

			expect(colors.length).toBeGreaterThan(0);
			expect(colors[0].value).toBe("#0000FF");
		});

		it("extracts stroke colors", async () => {
			const fileData = {
				document: {
					id: "0:0",
					name: "Doc",
					type: "DOCUMENT",
					children: [
						{
							id: "1:1",
							name: "Bordered",
							type: "RECTANGLE",
							strokes: [
								{
									type: "SOLID",
									color: { r: 1, g: 0, b: 0, a: 1 },
								},
							],
						},
					],
				},
			};

			const vars = await extractor.extractStylesFromFile(fileData);
			const colors = vars.filter((v) => v.type === "COLOR");

			expect(colors.length).toBeGreaterThan(0);
			expect(colors[0].value).toBe("#FF0000");
		});

		it("handles opacity in color values", async () => {
			const fileData = {
				document: {
					id: "0:0",
					name: "Doc",
					type: "DOCUMENT",
					children: [
						{
							id: "1:1",
							name: "Semi-transparent",
							type: "RECTANGLE",
							fills: [
								{
									type: "SOLID",
									opacity: 0.5,
									color: { r: 0, g: 0, b: 0, a: 1 },
								},
							],
						},
					],
				},
			};

			const vars = await extractor.extractStylesFromFile(fileData);
			const colors = vars.filter((v) => v.type === "COLOR");

			expect(colors[0].value).toContain("rgba");
			expect(colors[0].value).toContain("0.5");
		});

		it("skips invisible fills", async () => {
			const fileData = {
				document: {
					id: "0:0",
					name: "Doc",
					type: "DOCUMENT",
					children: [
						{
							id: "1:1",
							name: "Hidden",
							type: "RECTANGLE",
							fills: [
								{
									type: "SOLID",
									visible: false,
									color: { r: 1, g: 0, b: 0, a: 1 },
								},
							],
						},
					],
				},
			};

			const vars = await extractor.extractStylesFromFile(fileData);
			expect(vars.filter((v) => v.type === "COLOR")).toHaveLength(0);
		});

		it("deduplicates identical colors", async () => {
			const sameColor = { type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } };
			const fileData = {
				document: {
					id: "0:0",
					name: "Doc",
					type: "DOCUMENT",
					children: [
						{ id: "1:1", name: "Red1", type: "RECTANGLE", fills: [sameColor] },
						{ id: "1:2", name: "Red2", type: "RECTANGLE", fills: [sameColor] },
						{ id: "1:3", name: "Red3", type: "RECTANGLE", fills: [sameColor] },
					],
				},
			};

			const vars = await extractor.extractStylesFromFile(fileData);
			const reds = vars.filter((v) => v.type === "COLOR" && v.value === "#FF0000");
			expect(reds).toHaveLength(1);
		});

		it("infers color category from node name", async () => {
			const fileData = {
				document: {
					id: "0:0",
					name: "Doc",
					type: "DOCUMENT",
					children: [
						{
							id: "1:1",
							name: "Background Container",
							type: "FRAME",
							fills: [{ type: "SOLID", color: { r: 0.95, g: 0.95, b: 0.95, a: 1 } }],
						},
						{
							id: "1:2",
							name: "Error Message",
							type: "RECTANGLE",
							fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }],
						},
					],
				},
			};

			const vars = await extractor.extractStylesFromFile(fileData);
			const bgColor = vars.find((v) => v.category === "background");
			const semanticColor = vars.find((v) => v.category === "semantic");

			expect(bgColor).toBeDefined();
			expect(semanticColor).toBeDefined();
		});
	});

	// ========================================================================
	// Typography extraction
	// ========================================================================

	describe("typography extraction", () => {
		it("extracts typography from TEXT nodes", async () => {
			const fileData = {
				document: {
					id: "0:0",
					name: "Doc",
					type: "DOCUMENT",
					children: [
						{
							id: "1:1",
							name: "Heading 1",
							type: "TEXT",
							style: {
								fontFamily: "Inter",
								fontSize: 32,
								fontWeight: 700,
								lineHeightPx: 40,
							},
						},
					],
				},
			};

			const vars = await extractor.extractStylesFromFile(fileData);
			const typo = vars.filter((v) => v.type === "TYPOGRAPHY");

			expect(typo).toHaveLength(1);
			expect(typo[0].value).toContain('font-family: "Inter"');
			expect(typo[0].value).toContain("font-size: 32px");
			expect(typo[0].value).toContain("font-weight: 700");
			expect(typo[0].value).toContain("line-height: 40px");
		});

		it("generates heading name for heading nodes", async () => {
			const fileData = {
				document: {
					id: "0:0",
					name: "Doc",
					type: "DOCUMENT",
					children: [
						{
							id: "1:1",
							name: "H1 Title",
							type: "TEXT",
							style: { fontFamily: "Inter", fontSize: 32, fontWeight: 700 },
						},
					],
				},
			};

			const vars = await extractor.extractStylesFromFile(fileData);
			const typo = vars.find((v) => v.type === "TYPOGRAPHY");
			expect(typo!.name).toMatch(/^heading\//);
		});

		it("generates body name for body/paragraph nodes", async () => {
			const fileData = {
				document: {
					id: "0:0",
					name: "Doc",
					type: "DOCUMENT",
					children: [
						{
							id: "1:1",
							name: "Body Text",
							type: "TEXT",
							style: { fontFamily: "Inter", fontSize: 16, fontWeight: 400 },
						},
					],
				},
			};

			const vars = await extractor.extractStylesFromFile(fileData);
			const typo = vars.find((v) => v.type === "TYPOGRAPHY");
			expect(typo!.name).toMatch(/^body\//);
		});

		it("deduplicates identical typography", async () => {
			const sameStyle = { fontFamily: "Inter", fontSize: 16, fontWeight: 400 };
			const fileData = {
				document: {
					id: "0:0",
					name: "Doc",
					type: "DOCUMENT",
					children: [
						{ id: "1:1", name: "Text A", type: "TEXT", style: sameStyle },
						{ id: "1:2", name: "Text B", type: "TEXT", style: sameStyle },
					],
				},
			};

			const vars = await extractor.extractStylesFromFile(fileData);
			const typo = vars.filter((v) => v.type === "TYPOGRAPHY");
			expect(typo).toHaveLength(1);
		});
	});

	// ========================================================================
	// Spacing extraction
	// ========================================================================

	describe("spacing extraction", () => {
		it("extracts itemSpacing from auto-layout frames", async () => {
			const fileData = {
				document: {
					id: "0:0",
					name: "Doc",
					type: "DOCUMENT",
					children: [
						{
							id: "1:1",
							name: "Stack",
							type: "FRAME",
							layoutMode: "VERTICAL",
							itemSpacing: 16,
						},
					],
				},
			};

			const vars = await extractor.extractStylesFromFile(fileData);
			const spacing = vars.filter((v) => v.type === "SPACING");

			expect(spacing.length).toBeGreaterThan(0);
			expect(spacing[0].value).toBe("16px");
		});

		it("extracts padding from auto-layout frames", async () => {
			const fileData = {
				document: {
					id: "0:0",
					name: "Doc",
					type: "DOCUMENT",
					children: [
						{
							id: "1:1",
							name: "Card",
							type: "FRAME",
							layoutMode: "VERTICAL",
							paddingLeft: 24,
						},
					],
				},
			};

			const vars = await extractor.extractStylesFromFile(fileData);
			const padding = vars.filter(
				(v) => v.type === "SPACING" && v.category === "padding"
			);

			expect(padding.length).toBeGreaterThan(0);
			expect(padding[0].value).toBe("24px");
		});

		it("rounds spacing names to nearest 4px", async () => {
			const fileData = {
				document: {
					id: "0:0",
					name: "Doc",
					type: "DOCUMENT",
					children: [
						{
							id: "1:1",
							name: "Frame",
							type: "FRAME",
							layoutMode: "HORIZONTAL",
							itemSpacing: 12,
						},
					],
				},
			};

			const vars = await extractor.extractStylesFromFile(fileData);
			const spacing = vars.find((v) => v.type === "SPACING");
			expect(spacing!.name).toBe("spacing/12"); // 12 rounds to 12 (nearest 4)
		});
	});

	// ========================================================================
	// Radius extraction
	// ========================================================================

	describe("radius extraction", () => {
		it("extracts cornerRadius", async () => {
			const fileData = {
				document: {
					id: "0:0",
					name: "Doc",
					type: "DOCUMENT",
					children: [
						{
							id: "1:1",
							name: "Rounded",
							type: "RECTANGLE",
							cornerRadius: 8,
						},
					],
				},
			};

			const vars = await extractor.extractStylesFromFile(fileData);
			const radii = vars.filter((v) => v.type === "RADIUS");

			expect(radii).toHaveLength(1);
			expect(radii[0].value).toBe("8px");
			expect(radii[0].name).toBe("radius/md"); // 8px = md
		});

		it("categorizes radius sizes correctly", async () => {
			const fileData = {
				document: {
					id: "0:0",
					name: "Doc",
					type: "DOCUMENT",
					children: [
						{ id: "1:1", name: "XS", type: "RECTANGLE", cornerRadius: 2 },
						{ id: "1:2", name: "SM", type: "RECTANGLE", cornerRadius: 4 },
						{ id: "1:3", name: "LG", type: "RECTANGLE", cornerRadius: 16 },
						{ id: "1:4", name: "XXL", type: "RECTANGLE", cornerRadius: 32 },
					],
				},
			};

			const vars = await extractor.extractStylesFromFile(fileData);
			const radii = vars.filter((v) => v.type === "RADIUS");

			expect(radii.find((r) => r.name === "radius/xs")).toBeDefined();
			expect(radii.find((r) => r.name === "radius/sm")).toBeDefined();
			expect(radii.find((r) => r.name === "radius/lg")).toBeDefined();
			expect(radii.find((r) => r.name === "radius/xxl")).toBeDefined();
		});

		it("extracts unique radii from rectangleCornerRadii", async () => {
			const fileData = {
				document: {
					id: "0:0",
					name: "Doc",
					type: "DOCUMENT",
					children: [
						{
							id: "1:1",
							name: "Mixed",
							type: "RECTANGLE",
							rectangleCornerRadii: [8, 8, 0, 0],
						},
					],
				},
			};

			const vars = await extractor.extractStylesFromFile(fileData);
			const radii = vars.filter((v) => v.type === "RADIUS");

			// Should extract 8 but not 0
			expect(radii).toHaveLength(1);
			expect(radii[0].value).toBe("8px");
		});
	});

	// ========================================================================
	// Tree depth limiting
	// ========================================================================

	describe("tree depth limiting", () => {
		it("stops processing at depth 10", async () => {
			// Build a deeply nested tree
			let node: any = { id: "deep", name: "Deep", type: "FRAME", fills: [] };
			for (let i = 0; i < 15; i++) {
				node = {
					id: `${i}:1`,
					name: `Level ${i}`,
					type: "FRAME",
					children: [node],
					fills: [
						{
							type: "SOLID",
							color: {
								r: i / 15,
								g: 0,
								b: 0,
								a: 1,
							},
						},
					],
				};
			}

			const fileData = { document: node };
			const vars = await extractor.extractStylesFromFile(fileData);

			// Should have extracted colors from levels 0-10 but not deeper
			// Exact count depends on deduplication, but should be capped
			const colors = vars.filter((v) => v.type === "COLOR");
			expect(colors.length).toBeLessThanOrEqual(11);
		});
	});

	// ========================================================================
	// Named styles processing
	// ========================================================================

	describe("styles processing", () => {
		it("extracts named styles from file styles object", async () => {
			const fileData = {
				document: { id: "0:0", name: "Doc", type: "DOCUMENT", children: [] },
				styles: {
					"S:1": {
						name: "Brand/Primary",
						description: "Main brand color",
						styleType: "FILL",
					},
					"S:2": {
						name: "Heading/H1",
						description: "Main heading",
						styleType: "TEXT",
					},
					"S:3": {
						name: "Shadow/Card",
						description: "Card shadow",
						styleType: "EFFECT", // Should be skipped (not FILL or TEXT)
					},
				},
			};

			const vars = await extractor.extractStylesFromFile(fileData);

			const fillStyle = vars.find(
				(v) => v.name === "Brand/Primary" && v.type === "COLOR"
			);
			expect(fillStyle).toBeDefined();
			expect(fillStyle!.category).toBe("style");

			const textStyle = vars.find(
				(v) => v.name === "Heading/H1" && v.type === "TYPOGRAPHY"
			);
			expect(textStyle).toBeDefined();

			// EFFECT style should not be extracted
			const effectStyle = vars.find((v) => v.name === "Shadow/Card");
			expect(effectStyle).toBeUndefined();
		});
	});

	// ========================================================================
	// formatVariablesAsOutput
	// ========================================================================

	describe("formatVariablesAsOutput", () => {
		it("groups variables by name and adds metadata", async () => {
			const fileData = {
				document: {
					id: "0:0",
					name: "Doc",
					type: "DOCUMENT",
					children: [
						{
							id: "1:1",
							name: "Box",
							type: "RECTANGLE",
							fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }],
							cornerRadius: 8,
						},
					],
				},
			};

			const vars = await extractor.extractStylesFromFile(fileData);
			const output = extractor.formatVariablesAsOutput(vars);

			expect(output._metadata).toBeDefined();
			expect(output._metadata.extractionMethod).toBe("REST_API_STYLES");
			expect(output._metadata.counts.total).toBe(vars.length);
			expect(output._metadata.counts.colors).toBeGreaterThan(0);
		});

		it("returns empty output for no variables", () => {
			const output = extractor.formatVariablesAsOutput([]);
			expect(output._metadata.counts.total).toBe(0);
		});
	});

	// ========================================================================
	// State reset between calls
	// ========================================================================

	describe("state management", () => {
		it("resets state between extractStylesFromFile calls", async () => {
			const fileData = {
				document: {
					id: "0:0",
					name: "Doc",
					type: "DOCUMENT",
					children: [
						{
							id: "1:1",
							name: "Red",
							type: "RECTANGLE",
							fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }],
						},
					],
				},
			};

			const first = await extractor.extractStylesFromFile(fileData);
			const second = await extractor.extractStylesFromFile(fileData);

			// Should get same result both times (state was reset)
			expect(first.length).toBe(second.length);
		});
	});
});
