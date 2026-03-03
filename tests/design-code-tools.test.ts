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
	parseComponentDescription,
	buildAnatomyTree,
	collectTypographyData,
	collectAllVariantData,
	cleanVariantName,
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

describe("Description Parser", () => {
	it("parses When to Use and When NOT to Use sections", () => {
		const desc = [
			"An alert component for notifications.",
			"",
			"**When to Use**",
			"- When communicating critical errors",
			"- When confirming successful actions",
			"",
			"**When NOT to Use**",
			"- Brief feedback — use Toast instead",
			"- Blocking decisions — use AlertDialog",
		].join("\n");

		const result = parseComponentDescription(desc);
		expect(result.overview).toBe("An alert component for notifications.");
		expect(result.whenToUse).toHaveLength(2);
		expect(result.whenToUse[0]).toContain("critical errors");
		expect(result.whenNotToUse).toHaveLength(2);
		expect(result.whenNotToUse[0]).toContain("Toast");
	});

	it("parses content guidelines sections", () => {
		const desc = [
			"A button component.",
			"",
			"**Title Text**",
			"- Keep concise: 2-5 words",
			"- Use sentence case",
			"",
			"**Description Text**",
			"- Complementary to title",
			"- Actionable when appropriate",
		].join("\n");

		const result = parseComponentDescription(desc);
		expect(result.contentGuidelines).toHaveLength(2);
		expect(result.contentGuidelines[0].heading).toBe("Title Text");
		expect(result.contentGuidelines[0].items).toHaveLength(2);
		expect(result.contentGuidelines[1].heading).toBe("Description Text");
	});

	it("parses accessibility notes", () => {
		const desc = [
			"A form input.",
			"",
			"**Accessibility**",
			"- Uses role='textbox'",
			"- Supports keyboard navigation",
			"- Meets WCAG AA contrast requirements",
		].join("\n");

		const result = parseComponentDescription(desc);
		expect(result.accessibilityNotes).toHaveLength(3);
		expect(result.accessibilityNotes[0]).toContain("role");
	});

	it("handles empty description", () => {
		const result = parseComponentDescription("");
		expect(result.overview).toBe("");
		expect(result.whenToUse).toHaveLength(0);
		expect(result.whenNotToUse).toHaveLength(0);
	});

	it("handles description with only overview text", () => {
		const result = parseComponentDescription("Just a simple component for display purposes.");
		expect(result.overview).toBe("Just a simple component for display purposes.");
		expect(result.whenToUse).toHaveLength(0);
	});

	it("handles ### markdown headers", () => {
		const desc = [
			"A card component.",
			"",
			"### When to Use",
			"- For content grouping",
			"",
			"### When NOT to Use",
			"- For navigation items",
		].join("\n");

		const result = parseComponentDescription(desc);
		expect(result.whenToUse).toHaveLength(1);
		expect(result.whenToUse[0]).toContain("content grouping");
		expect(result.whenNotToUse).toHaveLength(1);
	});
});

describe("Anatomy Tree Builder", () => {
	it("builds tree from simple frame", () => {
		const node = {
			name: "Button",
			type: "COMPONENT",
			children: [
				{ name: "Icon", type: "INSTANCE", visible: true },
				{ name: "Label", type: "TEXT", visible: true },
			],
		};
		const tree = buildAnatomyTree(node);
		expect(tree).toContain("Button");
		expect(tree).toContain("Icon");
		expect(tree).toContain("Label");
	});

	it("handles COMPONENT_SET by picking the deepest variant", () => {
		const node = {
			name: "Button Set",
			type: "COMPONENT_SET",
			children: [
				{
					name: "Variant=Default",
					type: "COMPONENT",
					children: [
						{ name: "Label", type: "TEXT", visible: true },
					],
				},
				{
					name: "Variant=Active",
					type: "COMPONENT",
					children: [
						{ name: "Container", type: "FRAME", visible: true, children: [
							{ name: "Icon", type: "INSTANCE", visible: true },
							{ name: "Label", type: "TEXT", visible: true },
						]},
					],
				},
			],
		};
		const tree = buildAnatomyTree(node);
		// Should pick Variant=Active since it has deeper children
		expect(tree).toContain("Variant=Active");
		expect(tree).toContain("Container");
		expect(tree).toContain("Icon");
		expect(tree).toContain("Label");
		// Should not include Variant=Default
		expect(tree).not.toContain("Variant=Default");
	});

	it("hides invisible nodes", () => {
		const node = {
			name: "Frame",
			type: "FRAME",
			children: [
				{ name: "Visible", type: "TEXT", visible: true },
				{ name: "Hidden", type: "TEXT", visible: false },
			],
		};
		const tree = buildAnatomyTree(node);
		expect(tree).toContain("Visible");
		expect(tree).not.toContain("Hidden");
	});

	it("includes layout info for auto-layout frames", () => {
		const node = {
			name: "Card",
			type: "FRAME",
			layoutMode: "VERTICAL",
			itemSpacing: 8,
			children: [],
		};
		const tree = buildAnatomyTree(node);
		expect(tree).toContain("vertical auto-layout");
		expect(tree).toContain("gap: 8px");
	});
});

describe("Typography Data Collection", () => {
	it("collects text styles from text nodes", () => {
		const node = {
			name: "Alert",
			type: "COMPONENT",
			children: [
				{
					name: "Title",
					type: "TEXT",
					style: {
						fontFamily: "Inter",
						fontWeight: 600,
						fontSize: 14,
						lineHeightPx: 20,
						letterSpacing: 0,
					},
				},
				{
					name: "Description",
					type: "TEXT",
					style: {
						fontFamily: "Inter",
						fontWeight: 400,
						fontSize: 14,
						lineHeightPx: 20,
						letterSpacing: 0,
					},
				},
			],
		};

		const styles = collectTypographyData(node);
		expect(styles).toHaveLength(2);
		expect(styles[0].nodeName).toBe("Title");
		expect(styles[0].fontFamily).toBe("Inter");
		expect(styles[0].fontWeight).toBe(600);
		expect(styles[0].fontWeightName).toBe("SemiBold");
		expect(styles[1].nodeName).toBe("Description");
		expect(styles[1].fontWeight).toBe(400);
		expect(styles[1].fontWeightName).toBe("Regular");
	});

	it("walks COMPONENT_SET default variant", () => {
		const node = {
			name: "Set",
			type: "COMPONENT_SET",
			children: [
				{
					name: "Default",
					type: "COMPONENT",
					children: [
						{
							name: "Label",
							type: "TEXT",
							style: { fontFamily: "Arial", fontWeight: 700, fontSize: 16, lineHeightPx: 24 },
						},
					],
				},
			],
		};

		const styles = collectTypographyData(node);
		expect(styles).toHaveLength(1);
		expect(styles[0].fontFamily).toBe("Arial");
	});

	it("returns empty for nodes without text children", () => {
		const node = {
			name: "Frame",
			type: "FRAME",
			children: [{ name: "Rect", type: "RECTANGLE" }],
		};
		expect(collectTypographyData(node)).toHaveLength(0);
	});
});

describe("Per-Variant Data Collection", () => {
	it("collects data from all variants in a COMPONENT_SET", () => {
		const node = {
			name: "Alert",
			type: "COMPONENT_SET",
			children: [
				{
					name: "Variant=Danger",
					type: "COMPONENT",
					fills: [{ type: "SOLID", color: { r: 1, g: 0.945, b: 0.949 } }],
					children: [
						{
							name: "Icon / CircleAlert",
							type: "INSTANCE",
							strokes: [{ type: "SOLID", color: { r: 0.745, g: 0.071, b: 0.235 } }],
						},
						{
							name: "Title",
							type: "TEXT",
							fills: [{ type: "SOLID", color: { r: 0.153, g: 0.153, b: 0.165 } }],
						},
					],
				},
				{
					name: "Variant=Success",
					type: "COMPONENT",
					fills: [{ type: "SOLID", color: { r: 0.925, g: 0.992, b: 0.961 } }],
					children: [
						{
							name: "Icon / CircleCheck",
							type: "INSTANCE",
							strokes: [{ type: "SOLID", color: { r: 0.016, g: 0.471, b: 0.341 } }],
						},
					],
				},
			],
		};

		const varNameMap = new Map<string, string>();
		const data = collectAllVariantData(node, varNameMap);

		expect(data).toHaveLength(2);
		expect(data[0].variantName).toBe("Variant=Danger");
		expect(data[0].fills).toHaveLength(1);
		expect(data[0].icons).toHaveLength(1);
		expect(data[0].icons[0].name).toBe("CircleAlert");
		expect(data[0].textColors).toHaveLength(1);

		expect(data[1].variantName).toBe("Variant=Success");
		expect(data[1].fills).toHaveLength(1);
		expect(data[1].icons).toHaveLength(1);
		expect(data[1].icons[0].name).toBe("CircleCheck");
	});

	it("resolves variable names from map", () => {
		const node = {
			name: "Badge",
			type: "COMPONENT",
			fills: [
				{
					type: "SOLID",
					color: { r: 0.941, g: 0.976, b: 1 },
					boundVariables: { color: { id: "var-123" } },
				},
			],
			children: [],
		};

		const varNameMap = new Map([["var-123", "base/informational-weak"]]);
		const data = collectAllVariantData(node, varNameMap);

		expect(data).toHaveLength(1);
		expect(data[0].fills[0].variableName).toBe("base/informational-weak");
	});

	it("handles single COMPONENT node", () => {
		const node = {
			name: "Chip",
			type: "COMPONENT",
			fills: [{ type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5 } }],
			children: [],
		};

		const data = collectAllVariantData(node, new Map());
		expect(data).toHaveLength(1);
		expect(data[0].variantName).toBe("Chip");
	});
});

describe("cleanVariantName", () => {
	it("cleans Key=Value pairs to values only", () => {
		expect(cleanVariantName("Type=Image, Size=12")).toBe("Image / 12");
	});

	it("handles single property variant", () => {
		expect(cleanVariantName("Variant=Danger")).toBe("Danger");
	});

	it("handles three properties", () => {
		expect(cleanVariantName("Type=Filled, Size=Large, State=Hover")).toBe("Filled / Large / Hover");
	});

	it("passes through non-variant names unchanged", () => {
		expect(cleanVariantName("Button")).toBe("Button");
	});
});

describe("Description Parser - Plain Text", () => {
	it("parses plain-text headers without bold/markdown markers", () => {
		const desc = [
			"The Avatar component displays a user's profile image or initials.",
			"",
			"When to Use",
			"- Displaying user profile images",
			"- Showing initials when no image available",
			"",
			"When NOT to Use",
			"- For decorative icons — use Icon instead",
			"- For brand logos — use Logo component",
			"",
			"Accessibility",
			"- Always provide alt text for images",
			"- Fallback text should be meaningful",
		].join("\n");

		const result = parseComponentDescription(desc);
		expect(result.overview).toBe("The Avatar component displays a user's profile image or initials.");
		expect(result.whenToUse).toHaveLength(2);
		expect(result.whenToUse[0]).toContain("profile images");
		expect(result.whenNotToUse).toHaveLength(2);
		expect(result.whenNotToUse[0]).toContain("Icon");
		expect(result.accessibilityNotes).toHaveLength(2);
		expect(result.accessibilityNotes[0]).toContain("alt text");
	});

	it("handles mixed markdown and plain-text headers", () => {
		const desc = [
			"A card component.",
			"",
			"**When to Use**",
			"- For grouping content",
			"",
			"When NOT to Use",
			"- For navigation — use Nav",
			"",
			"### Accessibility",
			"- Ensure keyboard access",
		].join("\n");

		const result = parseComponentDescription(desc);
		expect(result.whenToUse).toHaveLength(1);
		expect(result.whenNotToUse).toHaveLength(1);
		expect(result.accessibilityNotes).toHaveLength(1);
	});

	it("handles Content Requirements as plain-text header", () => {
		const desc = [
			"A button component.",
			"",
			"Content Requirements",
			"- Labels should be action-oriented",
			"- Keep text under 3 words",
		].join("\n");

		const result = parseComponentDescription(desc);
		expect(result.contentGuidelines).toHaveLength(1);
		expect(result.contentGuidelines[0].items).toHaveLength(2);
	});

	it("handles inline section headers concatenated to overview text", () => {
		// Figma sometimes outputs "...sentence.When to Use\n- bullet" with no newline before header
		const desc = "The Badge component displays status.When to Use\n- Status indicators\n- Category labels\nWhen NOT to Use\n- Time-sensitive alerts\nContent Requirements\n- Keep text concise\nAccessibility\n- Use aria-label for icon-only badges";

		const result = parseComponentDescription(desc);
		expect(result.overview).toBe("The Badge component displays status.");
		expect(result.whenToUse).toHaveLength(2);
		expect(result.whenToUse[0]).toContain("Status indicators");
		expect(result.whenNotToUse).toHaveLength(1);
		expect(result.whenNotToUse[0]).toContain("Time-sensitive");
		expect(result.contentGuidelines).toHaveLength(1);
		expect(result.contentGuidelines[0].items[0]).toContain("concise");
		expect(result.accessibilityNotes).toHaveLength(1);
		expect(result.accessibilityNotes[0]).toContain("aria-label");
	});

	it("handles Variants section header to stop consuming overview", () => {
		const desc = "A button.Variants\n- Default, Primary, Danger\nWhen to Use\n- For actions";

		const result = parseComponentDescription(desc);
		expect(result.overview).toBe("A button.");
		expect(result.whenToUse).toHaveLength(1);
	});
});
