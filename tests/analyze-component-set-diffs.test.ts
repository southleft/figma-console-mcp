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
		fills: [],
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
});
