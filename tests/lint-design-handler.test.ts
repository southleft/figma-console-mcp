/**
 * Runs the REAL LINT_DESIGN handler from figma-desktop-bridge/code.js against
 * mock nodes. Covers false positives found grading a generated sign-up form:
 *  - a transparent (0% opacity) fill read as solid black
 *  - an input whose border meets 3:1 flagged because its fill doesn't
 *  - BEM sub-layers of a control ("al-c-input__footer") flagged as targets
 *  - nested layers of one control counted as separate targets
 *  - undersized targets that satisfy WCAG 2.5.8's spacing exception
 */
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "..", "figma-desktop-bridge", "code.js"), "utf8");
const start = src.indexOf("      console.log('🌉 [Desktop Bridge] Running design lint...');");
const end = src.indexOf("    } catch (error) {\n      var errorMsg = error && error.message ? error.message : String(error);\n      console.error('🌉 [Desktop Bridge] Lint design error:'");
if (start < 0 || end < 0) throw new Error("LINT_DESIGN handler markers not found in code.js");
const body = src.slice(start, end);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runLint = new AsyncFunction("figma", "msg", body);

const hex = (h: string) => {
	const n = parseInt(h.slice(1), 16);
	return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
};
const solid = (h: string, opacity = 1) => [{ type: "SOLID", visible: true, opacity, color: hex(h) }];

let ids = 0;
function node(name: string, o: any = {}): any {
	const n: any = {
		id: o.id ?? `n${++ids}`,
		name,
		type: o.type ?? "FRAME",
		visible: true,
		width: o.w ?? 100,
		height: o.h ?? 40,
		absoluteBoundingBox: { x: o.x ?? 0, y: o.y ?? 0, width: o.w ?? 100, height: o.h ?? 40 },
		fills: o.fills ?? [],
		strokes: o.strokes ?? [],
		children: [],
	};
	for (const c of o.children ?? []) {
		c.parent = n;
		n.children.push(c);
	}
	return n;
}

async function lint(root: any) {
	let result: any;
	const figma = {
		currentPage: root,
		getNodeByIdAsync: async () => root,
		getLocalPaintStylesAsync: async () => [],
		getLocalTextStylesAsync: async () => [],
		variables: { getLocalVariablesAsync: async () => [], getVariableById: () => null },
		ui: { postMessage: (m: any) => (result = m) },
	};
	await runLint(figma, { type: "LINT_DESIGN", nodeId: root.id, rules: ["wcag"], requestId: "t" });
	if (!result?.success) throw new Error(result?.error ?? "lint failed");
	const by: Record<string, any[]> = {};
	for (const c of result.data.categories) by[c.rule] = c.nodes;
	return by;
}

/** Dark sign-up form: page #131311, inputs with #1D1D1A fill + border, checkbox, link. */
function signUpForm(border: string) {
	const input = (y: number) =>
		node("Input", {
			type: "INSTANCE",
			y,
			w: 416,
			h: 92,
			children: [
				node("al-c-input__input", { y: y + 24, w: 416, h: 40, fills: solid("#1D1D1A"), strokes: solid(border) }),
				node("al-c-input__footer", { y: y + 68, w: 74, h: 20 }),
				node("al-c-input__field-notes", { y: y + 68, w: 74, h: 20 }),
			],
		});
	const checkbox = node("Checkbox", {
		type: "INSTANCE",
		y: 320,
		w: 149,
		h: 20,
		children: [
			node("al-c-checkbox__container", {
				y: 320,
				w: 149,
				h: 20,
				children: [
					node("al-c-checkbox__checkbox", { y: 321, w: 18, h: 18, fills: [{ type: "SOLID", visible: true, opacity: 0, color: hex("#000000") }] }),
					node("al-c-checkbox__label", { x: 22, y: 320, w: 127, h: 20 }),
				],
			}),
		],
	});
	const button = node("Button", { type: "INSTANCE", y: 356, w: 416, h: 40, fills: solid("#8EA6FF") });
	const link = node("Link", { type: "INSTANCE", y: 412, w: 248, h: 20 });
	return node("Sign-up", { fills: solid("#131311"), w: 480, h: 500, children: [input(0), input(108), input(216), checkbox, button, link] });
}

describe("figma_lint_design handler (code.js)", () => {
	it("passes a form whose control borders meet 3:1 (no false positives)", async () => {
		const by = await lint(signUpForm("#7C7A70")); // 4.3:1 on #131311
		expect(by["wcag-non-text-contrast"] ?? []).toEqual([]);
		expect(by["wcag-target-size"] ?? []).toEqual([]);
	});

	it("still fails a control that nothing identifies (fill AND border under 3:1)", async () => {
		const by = await lint(signUpForm("#3C3C35")); // 1.7:1
		const nt = by["wcag-non-text-contrast"] ?? [];
		expect(nt.map((n: any) => n.name)).toEqual(["al-c-input__input", "al-c-input__input", "al-c-input__input"]);
		expect(nt[0]).toMatchObject({ element: "stroke", ratio: "1.7:1" });
	});

	it("never reads a transparent fill as black", async () => {
		const by = await lint(signUpForm("#7C7A70"));
		const names = (by["wcag-non-text-contrast"] ?? []).map((n: any) => n.name);
		expect(names).not.toContain("al-c-checkbox__checkbox");
	});

	it("flags undersized targets that are too close together", async () => {
		const a = node("Button", { type: "INSTANCE", x: 0, y: 0, w: 20, h: 20, fills: solid("#8EA6FF") });
		const b = node("Button", { type: "INSTANCE", x: 22, y: 0, w: 20, h: 20, fills: solid("#8EA6FF") });
		const by = await lint(node("Toolbar", { fills: solid("#FFFFFF"), w: 200, h: 40, children: [a, b] }));
		expect((by["wcag-target-size"] ?? []).length).toBe(2);
	});

	it("still checks small controls inside a group container (Radio group, Data Table)", async () => {
		const radio = (x: number) => node("Radio", { type: "INSTANCE", x, y: 0, w: 16, h: 16, strokes: solid("#7C7A70") });
		const group = node("Radio group", { w: 120, h: 16, children: [radio(0), radio(18), radio(36)] });
		const by = await lint(node("Form", { fills: solid("#FFFFFF"), w: 300, h: 100, children: [group] }));
		expect((by["wcag-target-size"] ?? []).map((n: any) => n.name)).toEqual(["Radio", "Radio", "Radio"]);
		const tableRow = node("Data Table", { type: "INSTANCE", w: 300, h: 40, children: [node("Checkbox", { type: "INSTANCE", x: 0, y: 0, w: 16, h: 16 }), node("Checkbox", { type: "INSTANCE", x: 18, y: 0, w: 16, h: 16 })] });
		const by2 = await lint(node("Page", { fills: solid("#FFFFFF"), w: 400, h: 100, children: [tableRow] }));
		expect((by2["wcag-target-size"] ?? []).length).toBe(2);
	});

	it("linting a single control doesn't treat its inner parts as separate targets", async () => {
		const box = node("Checkbox box", { type: "INSTANCE", x: 0, y: 2, w: 16, h: 16, strokes: solid("#7C7A70") });
		const root = node("Checkbox", { type: "COMPONENT", w: 120, h: 24, fills: solid("#FFFFFF"), children: [box] });
		const by = await lint(root);
		expect((by["wcag-target-size"] ?? []).map((n: any) => n.name)).not.toContain("Checkbox box");
	});

	it("reports both ratios and names the side closest to passing", async () => {
		const by = await lint(signUpForm("#3C3C35"));
		expect(by["wcag-non-text-contrast"][0]).toMatchObject({ element: "stroke", strokeRatio: "1.7:1", elementIs: expect.stringMatching(/closest to passing/) });
	});

	it("still checks each variant when the linted node is a control's component set", async () => {
		const v = (x: number) => node("Checkbox / State=Off", { type: "COMPONENT", x, y: 0, w: 16, h: 16, strokes: solid("#7C7A70") });
		const set = node("Checkbox", { type: "COMPONENT_SET", w: 200, h: 80, fills: solid("#FFFFFF"), children: [v(0), v(20)] });
		const by = await lint(set);
		expect((by["wcag-target-size"] ?? []).length).toBe(2);
	});

	describe("focus indicator", () => {
		const variant = (state: string, ring: boolean) =>
			node(`State=${state}`, { type: "COMPONENT", w: 26, h: 26, children: [node("box", { w: 26, h: 26, children: ring ? [node("Focus Ring", { w: 26, h: 26, strokes: solid("#8EA6FF") })] : [] })] });
		const lintSet = (vs: any[]) => lint(node("Checkbox", { type: "COMPONENT_SET", w: 200, h: 80, fills: solid("#FFFFFF"), children: vs }));

		it("finds a focus ring drawn on a child layer", async () => {
			const by = await lintSet([variant("Default", false), variant("Focus", true)]);
			expect(by["wcag-focus-indicator"] ?? []).toEqual([]);
		});
		it("flags a focus variant that looks the same as its default state", async () => {
			const by = await lintSet([variant("Default", true), variant("Focus", true)]);
			expect((by["wcag-focus-indicator"] ?? []).map((f: any) => f.issue)).toEqual(["no-visible-indicator"]);
		});
		it("checks every focus variant, not just the first", async () => {
			const v = (state: string, checked: string, ring: boolean) =>
				node(`State=${state}, Checked=${checked}`, { type: "COMPONENT", w: 26, h: 26, children: ring ? [node("Focus Ring", { w: 26, h: 26, strokes: solid("#8EA6FF") })] : [] });
			const by = await lintSet([v("Default", "On", false), v("Default", "Off", false), v("Focus", "On", true), v("Focus", "Off", false)]);
			expect((by["wcag-focus-indicator"] ?? []).map((f: any) => f.name)).toEqual(["Checkbox / State=Focus, Checked=Off"]);
		});
	});

	it("doesn't treat a table as a tab control, but still recognises camelCase controls", async () => {
		const tbl = node("al-c-table__table", { w: 400, h: 200, fills: solid("#1D1D1A") });
		const iconButton = node("IconButton", { type: "INSTANCE", w: 40, h: 40, fills: solid("#151515") });
		const by = await lint(node("Page", { fills: solid("#131311"), w: 600, h: 300, children: [tbl, iconButton] }));
		const names = (by["wcag-non-text-contrast"] ?? []).map((n: any) => n.name);
		expect(names).not.toContain("al-c-table__table");
		expect(names).toContain("IconButton");
	});

	it("treats 'disabled without context' as a best-practice hint, once per component set", async () => {
		const set = () => node("Button", { type: "COMPONENT_SET", w: 300, h: 80, fills: solid("#FFFFFF"), children: [
			node("State=Default", { type: "COMPONENT", w: 100, h: 40 }),
			node("State=Disabled, Size=Sm", { type: "COMPONENT", w: 100, h: 40 }),
			node("State=Disabled, Size=Lg", { type: "COMPONENT", w: 100, h: 40 }),
		] });
		const wcag = await lint(set());
		expect(wcag["wcag-disabled-no-context"]).toBeUndefined();
		let result: any;
		const root = set();
		await runLint({ currentPage: root, getNodeByIdAsync: async () => root, getLocalPaintStylesAsync: async () => [], getLocalTextStylesAsync: async () => [], variables: { getLocalVariablesAsync: async () => [], getVariableById: () => null }, ui: { postMessage: (m: any) => (result = m) } }, { type: "LINT_DESIGN", nodeId: root.id, rules: ["best-practice"], requestId: "t" });
		const cat = result.data.categories.find((c: any) => c.rule === "wcag-disabled-no-context");
		expect(cat).toMatchObject({ severity: "info", wcagLevel: "best-practice", count: 1 });
	});

	it("doesn't ask container sets (Checkbox Group, Tabs) for their own focus variant", async () => {
		for (const name of ["Checkbox Group", "Tabs", "Radio Group"]) {
			const set = node(name, { type: "COMPONENT_SET", w: 300, h: 80, fills: solid("#FFFFFF"), children: [node("Orientation=Horizontal", { type: "COMPONENT", w: 100, h: 40 })] });
			const by = await lint(set);
			expect(by["wcag-focus-indicator"] ?? []).toEqual([]);
		}
	});

	it("exempts disabled states from contrast (WCAG 1.4.3 / 1.4.11)", async () => {
		const label = (fill: string) => node("Label", { type: "TEXT", w: 60, h: 20, fills: solid(fill) });
		const v = (name: string) => node(name, { type: "COMPONENT", w: 120, h: 40, fills: solid("#131311"), children: [label("#4A4945")] });
		const set = node("Input", { type: "COMPONENT_SET", w: 300, h: 100, fills: solid("#131311"), children: [v("State=Default"), v("State=Disabled")] });
		const by = await lint(set);
		const names = (by["wcag-contrast"] ?? []).map((n: any) => n.id);
		expect(names).toHaveLength(1); // only the Default variant's label
	});

	it("reads only content layers for reading order (a focus outline is decoration)", async () => {
		const knob = Object.assign(node("Knob", { type: "ELLIPSE", x: 2, y: 2, w: 16, h: 16, fills: solid("#FFFFFF") }), { x: 2, y: 2 });
		const outline = Object.assign(node("Focus Outline", { x: -4, y: -4, w: 52, h: 28, strokes: solid("#8EA6FF") }), { x: -4, y: -4 });
		const toggle = node("Checked=Off, State=Focus", { type: "COMPONENT", w: 44, h: 20, children: [knob, outline] });
		const by = await lint(node("Toggle", { type: "COMPONENT_SET", w: 200, h: 80, fills: solid("#FFFFFF"), children: [toggle] }));
		expect(by["wcag-reading-order"] ?? []).toEqual([]);
		// Real content out of order is still caught.
		// node() only sets absoluteBoundingBox; the rule reads layer x/y, so set them too.
		const t = (name: string, x: number, y: number) => Object.assign(node(name, { type: "TEXT", x, y, w: 50, h: 20, fills: solid("#000000") }), { x, y });
		const card = node("Card", { w: 200, h: 200, fills: solid("#FFFFFF"), children: [t("Footer", 0, 150), t("Body", 0, 80), t("Title", 0, 0)] });
		const by2 = await lint(node("Page", { fills: solid("#FFFFFF"), w: 400, h: 400, children: [card] }));
		expect((by2["wcag-reading-order"] ?? []).map((n: any) => n.name)).toContain("Card");
	});
});

