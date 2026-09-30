/**
 * Min/max sizing must survive every extraction path (Brett Cooper, 2026-09-30:
 * "If I place a 320 min width on a container, it consistently doesn't pick
 * this up when extracting the JSON").
 */
import { extractNodeSpec } from "../src/core/figma-reconstruction-spec";
import { extractVisualSpec } from "../src/core/design-system-tools";
import { compareSpacing } from "../src/core/design-code-tools";

// REST-shaped node, as GET /files/:key/nodes returns it: absolute boxes, no x/y,
// and fields at their default (AUTO sizing, 0 spacing) omitted.
const restComponent = {
	id: "15:436",
	name: "MinMaxProbe",
	type: "COMPONENT",
	absoluteBoundingBox: { x: 1276, y: 40, width: 320, height: 56 },
	layoutMode: "HORIZONTAL",
	paddingLeft: 16,
	paddingRight: 16,
	paddingTop: 8,
	paddingBottom: 8,
	layoutSizingHorizontal: "HUG",
	layoutSizingVertical: "HUG",
	minWidth: 320,
	maxWidth: 640,
	fills: [],
	children: [
		{
			id: "15:437",
			name: "Inner",
			type: "FRAME",
			absoluteBoundingBox: { x: 1292, y: 48, width: 288, height: 40 },
			layoutMode: "VERTICAL",
			primaryAxisSizingMode: "FIXED",
			counterAxisSizingMode: "FIXED",
			layoutSizingHorizontal: "FILL",
			layoutSizingVertical: "FIXED",
			minHeight: 40,
			maxHeight: 200,
			fills: [],
			children: [],
		},
	],
};

describe("reconstruction spec (REST node tree)", () => {
	const spec: any = extractNodeSpec(restComponent);

	it("keeps min/max constraints on the root and children", () => {
		expect(spec.minWidth).toBe(320);
		expect(spec.maxWidth).toBe(640);
		expect(spec.minHeight).toBeUndefined();
		expect(spec.children[0].minHeight).toBe(40);
		expect(spec.children[0].maxHeight).toBe(200);
	});

	it("uses real dimensions, not placeholders", () => {
		expect(spec.width).toBe(320);
		expect(spec.height).toBe(56);
	});

	it("places children relative to the parent instead of at 0,0", () => {
		expect(spec.x).toBe(0);
		expect(spec.y).toBe(0);
		expect(spec.children[0].x).toBe(16);
		expect(spec.children[0].y).toBe(8);
	});

	it("fills in REST defaults for required auto-layout fields", () => {
		expect(spec.primaryAxisSizingMode).toBe("AUTO");
		expect(spec.counterAxisSizingMode).toBe("AUTO");
		expect(spec.itemSpacing).toBe(0);
		expect(spec.paddingLeft).toBe(16);
		expect(spec.children[0].primaryAxisSizingMode).toBe("FIXED");
		expect(spec.children[0].paddingLeft).toBe(0);
	});
});

describe("design system kit visualSpec", () => {
	it("reports sizing mode and min/max constraints", () => {
		const vs: any = extractVisualSpec(restComponent);
		expect(vs.sizing).toEqual({ horizontal: "HUG", vertical: "HUG", minWidth: 320, maxWidth: 640 });
	});

	it("omits sizing when a node has none", () => {
		const vs: any = extractVisualSpec({ type: "RECTANGLE", fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }] });
		expect(vs?.sizing).toBeUndefined();
	});
});

describe("design-code parity: min/max", () => {
	const run = (spacing: any) => {
		const out: any[] = [];
		compareSpacing(restComponent, { spacing } as any, out);
		return out.filter((d) => /^(min|max)(Width|Height)$/.test(d.property));
	};

	it("passes when code matches", () => {
		expect(run({ minWidth: 320, maxWidth: 640 })).toEqual([]);
	});

	it("flags a different value", () => {
		const d = run({ minWidth: 300, maxWidth: 640 });
		expect(d).toHaveLength(1);
		expect(d[0]).toMatchObject({ property: "minWidth", designValue: 320, codeValue: 300, severity: "major" });
	});

	it("flags a min-width set in Figma but missing in code", () => {
		const d = run({ maxWidth: 640 });
		expect(d).toHaveLength(1);
		expect(d[0]).toMatchObject({ property: "minWidth", designValue: 320, codeValue: null });
	});

	it("notes a constraint that exists only in code", () => {
		const d = run({ minWidth: 320, maxWidth: 640, minHeight: 44 });
		expect(d).toHaveLength(1);
		expect(d[0]).toMatchObject({ property: "minHeight", severity: "info", codeValue: 44 });
	});
});

describe("reconstruction spec: layout fields a rebuild depends on", () => {
	const box = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h });

	it("keeps alignment (REST omits MIN), wrap, hidden and absolute-positioned children", () => {
		const spec: any = extractNodeSpec({
			name: "Button", type: "COMPONENT", absoluteBoundingBox: box(0, 0, 120, 40),
			layoutMode: "HORIZONTAL", primaryAxisAlignItems: "CENTER", layoutWrap: "WRAP", counterAxisSpacing: 4,
			layoutSizingHorizontal: "FIXED", layoutSizingVertical: "HUG",
			children: [
				{ name: "Icon", type: "FRAME", visible: false, absoluteBoundingBox: box(10, 10, 20, 20) },
				{ name: "Badge", type: "FRAME", layoutPositioning: "ABSOLUTE", absoluteBoundingBox: box(100, -4, 12, 12) },
				{ name: "Label", type: "FRAME", layoutGrow: 1, layoutAlign: "STRETCH", absoluteBoundingBox: box(30, 10, 60, 20) },
			],
		});
		expect(spec.primaryAxisAlignItems).toBe("CENTER");
		expect(spec.counterAxisAlignItems).toBe("MIN");
		expect(spec.layoutWrap).toBe("WRAP");
		expect(spec.counterAxisSpacing).toBe(4);
		// Missing sizing modes derived from the axis resizing, not assumed AUTO
		expect(spec.primaryAxisSizingMode).toBe("FIXED");
		expect(spec.counterAxisSizingMode).toBe("AUTO");
		expect(spec.children[0].visible).toBe(false);
		expect(spec.children[1]).toMatchObject({ layoutPositioning: "ABSOLUTE", x: 100, y: -4 });
		expect(spec.children[2]).toMatchObject({ layoutGrow: 1, layoutAlign: "STRETCH" });
	});

	it("positions a group's children relative to the group's parent", () => {
		const spec: any = extractNodeSpec({
			name: "Card", type: "FRAME", absoluteBoundingBox: box(100, 100, 300, 200),
			children: [{
				name: "Group", type: "GROUP", absoluteBoundingBox: box(150, 120, 100, 50),
				children: [{ name: "Dot", type: "ELLIPSE", absoluteBoundingBox: box(160, 130, 8, 8) }],
			}],
		});
		expect(spec.children[0]).toMatchObject({ x: 50, y: 20 });
		expect(spec.children[0].children[0]).toMatchObject({ x: 60, y: 30 });
	});

	it("keeps grid fields and does not invent flex defaults for GRID", () => {
		const spec: any = extractNodeSpec({
			name: "Grid", type: "FRAME", absoluteBoundingBox: box(0, 0, 200, 200),
			layoutMode: "GRID", gridRowCount: 2, gridColumnCount: 3, gridRowGap: 8, gridColumnGap: 12,
		});
		expect(spec).toMatchObject({ layoutMode: "GRID", gridRowCount: 2, gridColumnCount: 3, gridRowGap: 8, gridColumnGap: 12 });
		expect(spec.primaryAxisSizingMode).toBeUndefined();
		expect(spec.itemSpacing).toBeUndefined();
	});
});

describe("design-code parity: min/max units", () => {
	const run = (spacing: any) => {
		const out: any[] = [];
		compareSpacing(restComponent, { spacing } as any, out);
		return out.filter((d) => d.property === "minWidth");
	};
	it("compares '320px' strings and weighs a mismatch like padding", () => {
		expect(run({ minWidth: "320px" })).toEqual([]);
		expect(run({ minWidth: "300px" })[0]).toMatchObject({ severity: "major", codeValue: 300 });
	});
	it("reports a non-px length without guessing a conversion", () => {
		expect(run({ minWidth: "20rem" })[0]).toMatchObject({ severity: "info", codeValue: "20rem", designValue: 320 });
	});
});

import { collectSpacingAcrossVariants } from "../src/core/design-code-tools";
describe("component docs: min/max sizing", () => {
	it("lists min width across variants", () => {
		const set = {
			type: "COMPONENT_SET",
			children: [
				{ type: "COMPONENT", name: "Size=md", layoutMode: "HORIZONTAL", minWidth: 320, children: [] },
				{ type: "COMPONENT", name: "Size=lg", layoutMode: "HORIZONTAL", minWidth: 320, children: [] },
			],
		};
		const out = JSON.stringify(collectSpacingAcrossVariants(set as any));
		expect(out).toContain("Min width");
		expect(out).toContain("320");
	});
});
