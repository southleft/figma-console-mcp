/**
 * ANALYZE_COMPONENT_SET variant diffs.
 *
 * Runs the real handler body from figma-desktop-bridge/code.js (sliced out by
 * its markers, not ported) against mock nodes. Cases come from live files:
 * - CBDS Button: an "Icon" layer hidden in every variant, the default
 *   included, was reported as a visibility change on all 134 other variants.
 * - Eventz Radio Button: disabled sets opacity on the variant itself, and
 *   checked/hover swap a nested icon instance whose vector changes fill
 *   token — all three diffed as "no change".
 * - Whole-file sweeps of CBDS, Eventz and DS Contracts: gradient and image
 *   fills, paint opacity, corner radius, typography, label text, swapped
 *   spacing tokens, nested layer size and position, and vector shapes all
 *   diffed as "no change".
 */
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "..", "figma-desktop-bridge", "code.js"), "utf8");
const start = src.indexOf("      var node = await figma.getNodeByIdAsync(msg.nodeId);");
const end = src.indexOf("      console.log('🌉 [Desktop Bridge] Component set analysis complete.");
const body = src.slice(start, end);

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const analyze = new AsyncFunction("figma", "msg", "extractSlots", body + "\nreturn result;");

const VARS: Record<string, string> = {
	"v:hover": "content/weak-hover",
	"v:default": "content/weak",
	"v:bg": "bg/brand",
};

function layer(name: string, opts: any = {}): any {
	return {
		name,
		type: opts.type || "FRAME",
		visible: opts.visible !== false,
		opacity: opts.opacity ?? 1,
		fills: opts.fill ? [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }] : [],
		strokes: [],
		boundVariables: opts.fill ? { fills: [{ id: opts.fill }] } : {},
		children: opts.children,
		getMainComponentAsync: async () => (opts.component ? { name: opts.component } : null),
	};
}

function variant(name: string, children: any[], opts: any = {}): any {
	return {
		id: name,
		name,
		type: "COMPONENT",
		width: 100,
		height: 40,
		opacity: opts.opacity ?? 1,
		fills: opts.fill ? [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }] : [],
		strokes: [],
		boundVariables: opts.fill ? { fills: [{ id: opts.fill }] } : {},
		children,
	};
}

function mockFigma(variants: any[], axes: Record<string, string[]>) {
	const defs: any = {};
	for (const k in axes) defs[k] = { type: "VARIANT", variantOptions: axes[k] };
	const set = {
		id: "set",
		name: "Set",
		type: "COMPONENT_SET",
		componentPropertyDefinitions: defs,
		defaultVariant: variants[0],
		children: variants,
	};
	return {
		getNodeByIdAsync: async () => set,
		variables: {
			getLocalVariablesAsync: async () =>
				Object.keys(VARS).map((id) => ({ id, name: VARS[id], variableCollectionId: "c", resolvedType: "COLOR" })),
			getLocalVariableCollectionsAsync: async () => [{ id: "c", name: "Colors" }],
		},
	};
}

async function run(variants: any[], axes: Record<string, string[]>) {
	const r = await analyze(mockFigma(variants, axes), { nodeId: "set" }, () => []);
	const byName: Record<string, any> = {};
	for (const v of r.variants) byName[v.name] = v;
	return { r, byName };
}

describe("ANALYZE_COMPONENT_SET variant diffs", () => {
	it("found the handler body in code.js", () => {
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
	});

	it("does not report a layer hidden in the default and the variant as a change", async () => {
		const mk = (state: string, fill: string) =>
			variant(`state=${state}`, [layer("Label", { type: "TEXT" }), layer("Icon", { visible: false })], { fill });
		const { byName } = await run([mk("default", "v:bg"), mk("hover", "v:hover")], { state: ["default", "hover"] });
		expect(byName["state=hover"].diffFromDefault).toEqual({ fillToken: "content/weak-hover" });
	});

	it("reports visibility in both directions", async () => {
		const { byName } = await run(
			[
				variant("state=default", [layer("Icon", { visible: false }), layer("Badge")]),
				variant("state=hover", [layer("Icon"), layer("Badge", { visible: false })]),
			],
			{ state: ["default", "hover"] },
		);
		expect(byName["state=hover"].diffFromDefault.visibilityChanges).toEqual({ Icon: true, Badge: false });
	});

	it("reports opacity set on the variant itself", async () => {
		const kids = () => [layer("Icons/Radio", { type: "INSTANCE", component: "state=default" }), layer("stack")];
		const { byName } = await run(
			[variant("isDisabled=false", kids()), variant("isDisabled=true", kids(), { opacity: 0.4 })],
			{ isDisabled: ["false", "true"] },
		);
		expect(byName["isDisabled=true"].diffFromDefault).toEqual({ variantOpacity: 0.4 });
	});

	it("reports nested instance swaps and nested token changes by layer path", async () => {
		const mk = (state: string, fill: string) =>
			variant(`state=${state}`, [
				layer("Icons/Radio", {
					type: "INSTANCE",
					component: `state=${state}`,
					children: [layer("Icon", { type: "VECTOR", fill })],
				}),
				layer("stack", { children: [layer("Label", { type: "TEXT", fill: "v:default" })] }),
			]);
		const { r, byName } = await run([mk("default", "v:default"), mk("hover", "v:hover")], {
			state: ["default", "hover"],
		});
		expect(byName["state=hover"].diffFromDefault).toEqual({
			layers: {
				"Icons/Radio": { component: "state=hover" },
				"Icons/Radio › Icon": { fill: "content/weak-hover" },
			},
		});
		// Diff-only data stays out of the response.
		expect(Object.keys(byName["state=hover"].signature).some((k) => k.startsWith("_"))).toBe(false);
		expect(Object.keys(r.stateMachine.defaultSignature).some((k) => k.startsWith("_"))).toBe(false);
	});

	it("reports a background fill on the variant when the main layer is a child frame", async () => {
		// FDS Evals Button: background on the variant, label in a "Label" frame.
		const mk = (state: string, fill: string) =>
			variant(`state=${state}`, [layer("Label", { children: [layer("Button", { type: "TEXT", fill: "v:default" })] })], {
				fill,
			});
		const { byName } = await run([mk("default", "v:bg"), mk("hover", "v:hover")], { state: ["default", "hover"] });
		expect(byName["state=hover"].diffFromDefault).toEqual({ variantFill: "content/weak-hover" });
	});

	it("reports auto-layout changes on the variant", async () => {
		// FDS Evals Button Group: Alignment=Center only changes primaryAxisAlignItems.
		const mk = (align: string) =>
			Object.assign(variant(`Alignment=${align}`, [layer("Items")]), {
				layoutMode: "HORIZONTAL",
				primaryAxisAlignItems: align === "Center" ? "CENTER" : "MIN",
				counterAxisAlignItems: "CENTER",
				itemSpacing: 12,
				paddingTop: 0,
				paddingRight: 0,
				paddingBottom: 0,
				paddingLeft: 0,
			});
		const { byName } = await run([mk("Default"), mk("Center")], { Alignment: ["Default", "Center"] });
		expect(byName["Alignment=Center"].diffFromDefault).toEqual({ layout: { primaryAxisAlignItems: "CENTER" } });
	});

	it("does not list the main layer's fill twice", async () => {
		const mk = (state: string, fill: string) =>
			variant(`state=${state}`, [layer("Container", { fill, children: [layer("Label", { type: "TEXT" })] })]);
		const { byName } = await run([mk("default", "v:bg"), mk("hover", "v:hover")], { state: ["default", "hover"] });
		expect(byName["state=hover"].diffFromDefault).toEqual({ fillToken: "content/weak-hover" });
	});

	it("reports gradient, image and paint-opacity changes", async () => {
		// Eventz Badge (gradient per variant), .fileThumbnail (image vs
		// loading gradient), DS Contracts Cursor (stroke faded to 0).
		const grad = (r: number) => ({
			type: "GRADIENT_LINEAR",
			gradientStops: [
				{ color: { r, g: 0, b: 0 }, position: 0 },
				{ color: { r: 1, g: 1, b: 1 }, position: 1 },
			],
		});
		const mk = (name: string, fills: any[], strokeOpacity: number) => {
			const cursor = Object.assign(layer("cursor", { type: "LINE" }), {
				strokes: [{ type: "SOLID", opacity: strokeOpacity, color: { r: 0, g: 0, b: 0 } }],
			});
			return Object.assign(variant(name, [cursor]), { fills });
		};
		const { byName } = await run(
			[
				mk("variant=accent", [grad(1)], 1),
				mk("variant=warning", [grad(0)], 1),
				mk("variant=image", [{ type: "IMAGE" }], 1),
				mk("variant=hidden", [grad(1)], 0),
			],
			{ variant: ["accent", "warning", "image", "hidden"] },
		);
		expect(byName["variant=warning"].diffFromDefault).toEqual({ variantFill: "linear-gradient(#000000, #ffffff)" });
		expect(byName["variant=image"].diffFromDefault).toEqual({ variantFill: "image" });
		expect(byName["variant=hidden"].diffFromDefault).toEqual({ strokeHex: "#000000 @0" });
	});

	it("reports corner radius on the variant and on nested layers", async () => {
		// CBDS Chip round=true, Eventz .toggleGroupItem position=middle.
		const corners = (n: number) => ({ topLeftRadius: n, topRightRadius: n, bottomRightRadius: n, bottomLeftRadius: n });
		const mk = (name: string, root: number, inner: any) =>
			Object.assign(variant(name, [Object.assign(layer("Label", { type: "TEXT" }), {}), Object.assign(layer("Button", { type: "INSTANCE" }), inner)]), corners(root));
		const { byName } = await run(
			[
				mk("round=false", 4, corners(8)),
				mk("round=true", 999, corners(8)),
				mk("position=middle", 4, corners(0)),
				mk("position=left", 4, { topLeftRadius: 8, topRightRadius: 0, bottomRightRadius: 0, bottomLeftRadius: 8 }),
			],
			{ round: ["false", "true"] },
		);
		expect(byName["round=true"].diffFromDefault).toEqual({ cornerRadius: 999 });
		expect(byName["position=middle"].diffFromDefault).toEqual({ layers: { Button: { radius: 0 } } });
		expect(byName["position=left"].diffFromDefault).toEqual({ layers: { Button: { radius: "8 0 0 8" } } });
	});

	it("reports typography and label text on text layers", async () => {
		// CBDS Link underlined=true, Eventz Accordion sm vs lg, File Upload label.
		const text = (o: any) =>
			Object.assign(layer("Title", { type: "TEXT" }), {
				characters: "Upload photo",
				fontSize: 18,
				fontName: { family: "Inter", style: "Bold" },
				textDecoration: "NONE",
				textCase: "ORIGINAL",
				lineHeight: { unit: "PIXELS", value: 24 },
				letterSpacing: { unit: "PERCENT", value: 0 },
				...o,
			});
		const mk = (name: string, o: any) => variant(name, [layer("stack", { children: [text(o)] })]);
		const { byName } = await run(
			[
				mk("v=default", {}),
				mk("v=underlined", { textDecoration: "UNDERLINE" }),
				mk("v=sm", { fontSize: 16, fontName: { family: "Inter", style: "Medium" }, lineHeight: { unit: "PIXELS", value: 20 } }),
				mk("v=poster", { characters: "Upload poster" }),
			],
			{ v: ["default", "underlined", "sm", "poster"] },
		);
		expect(byName["v=underlined"].diffFromDefault).toEqual({ layers: { "stack › Title": { textDecoration: "UNDERLINE" } } });
		expect(byName["v=sm"].diffFromDefault).toEqual({
			layers: { "stack › Title": { fontSize: 16, font: "Inter Medium", lineHeight: "20px" } },
		});
		expect(byName["v=poster"].diffFromDefault).toEqual({ layers: { "stack › Title": { text: "Upload poster" } } });
	});

	it("reports a swapped spacing token even when the value is the same", async () => {
		// DS Contracts Select multi=true: paddingLeft bound to another token.
		VARS["v:pad-a"] = "space/inset-a";
		VARS["v:pad-b"] = "space/inset-b";
		const mk = (name: string, pad: string) =>
			Object.assign(variant(name, [layer("Label", { type: "TEXT" })]), {
				boundVariables: { paddingLeft: { type: "VARIABLE_ALIAS", id: pad } },
			});
		const { byName } = await run([mk("multi=false", "v:pad-a"), mk("multi=true", "v:pad-b")], { multi: ["false", "true"] });
		expect(byName["multi=true"].diffFromDefault).toEqual({ tokens: { paddingLeft: "space/inset-b" } });
	});

	it("reports nested size, free position, rotation and vector shape changes", async () => {
		// CBDS Tooltip pointerPosition, DS Contracts Heart hover, Eventz Radio icon paths.
		const mk = (name: string, o: any) =>
			variant(name, [
				Object.assign(layer("Body"), { width: 120, height: 32 }),
				Object.assign(layer("Pointer", { type: "VECTOR" }), { width: 12, height: 6, x: 10, y: 32, rotation: 0, vectorPaths: [{ data: "M0 0L6 6L12 0Z" }], ...o }),
			]);
		const { byName } = await run(
			[
				mk("p=top-right", {}),
				mk("p=bottom-left", { x: 98, y: -6, rotation: 180 }),
				mk("p=big", { width: 16, height: 8 }),
				mk("p=other", { vectorPaths: [{ data: "M0 0L12 0Z" }] }),
			],
			{ p: ["top-right", "bottom-left", "big", "other"] },
		);
		expect(byName["p=bottom-left"].diffFromDefault).toEqual({ layers: { Pointer: { x: 98, y: -6, rotation: 180 } } });
		expect(byName["p=big"].diffFromDefault).toEqual({ layers: { Pointer: { width: 16, height: 8 } } });
		expect(Object.keys(byName["p=other"].diffFromDefault.layers.Pointer)).toEqual(["shape"]);
	});

	it("does not report position for layers placed by auto-layout", async () => {
		const mk = (name: string, x: number) =>
			Object.assign(variant(name, [Object.assign(layer("Icon"), { width: 16, height: 16, x, y: 0 })]), { layoutMode: "HORIZONTAL" });
		const { byName } = await run([mk("a=1", 0), mk("a=2", 8)], { a: ["1", "2"] });
		expect(byName["a=2"].diffFromDefault).toBeNull();
	});
});
