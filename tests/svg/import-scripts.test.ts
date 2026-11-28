/**
 * figma_import_svg plugin scripts (spec §2.9, §8.1 "assets-import-scripts"),
 * run with `new AsyncFunction("figma", script)` against a fake figma.
 */

import { EDITOR_SUPPORT } from "../../src/core/assets/limits";
import {
	ALL_SVG_BODIES,
	SVG_CHECKPOINT_BODY,
	SVG_CONTAINER_BODY,
	SVG_IMPORT_BODY,
	SVG_PREFLIGHT_BODY,
	assetScript,
} from "../../src/core/assets/plugin-scripts";
import { IMAGE_CONTAINER_BODY } from "../../src/core/assets/image-scripts";
import { sanitizeSvg } from "../../src/core/assets/svg-sanitize";
import { FakeFigma, FNode, makeIconComponent, rgb, runScript, solid } from "./fake-figma";

const RUN = "abcdefabcdef";

afterEach(() => {
	delete (globalThis as any).__figmaConsoleSvgImport;
	delete (globalThis as any).__figmaConsoleImageImport;
	delete (globalThis as any).__figmaConsoleSvgCheckpoints;
});

function san(markup: string) {
	const r = sanitizeSvg(markup);
	if (!r.ok) throw new Error(r.error);
	return r;
}
const svg = (body: string, attrs = 'viewBox="0 0 24 24"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

let keyN = 0;
function item(markup: string, over: Record<string, unknown> = {}) {
	const s = san(markup);
	return { key: `k${keyN++}`, name: "Icon", markup: s.markup, sentinel: s.sentinel, rootColor: s.meta.rootColor, artHash: "hash1", source: "svgs[0]", hasText: s.meta.hasText, action: "create", ...over };
}

function payload(fake: FakeFigma, over: Record<string, any> = {}) {
	const { opts, layout, ...rest } = over;
	return {
		runId: RUN,
		targetId: fake.currentPage.id,
		final: true,
		focus: false,
		focusIds: [],
		editorImportMode: "frame",
		opts: { box: null, square: false, scaleStrokes: true, asComponent: false, flatten: false, keepOverrides: false, color: null, colorRef: "inherit", ...(opts ?? {}) },
		layout: { mode: "shelf", columns: 12, gap: 24, padding: 40, cursor: null, container: null, ...(layout ?? {}) },
		groups: [],
		...rest,
	};
}
const singles = (...items: any[]) => items.map((i) => ({ kind: "single", item: i }));
const runImport = (fake: FakeFigma, p: unknown) => runScript(assetScript("Import SVG (1 items)", p, SVG_IMPORT_BODY), fake.api());

function preflightPayload(over: Record<string, unknown> = {}) {
	return {
		runId: RUN,
		parentId: null,
		wantsComponents: false,
		color: null,
		containerName: null,
		matchScope: "file",
		resumeRunId: null,
		editorSupport: EDITOR_SUPPORT,
		busyStaleMs: 900_000,
		maxCounted: 200,
		matches: [],
		...over,
	};
}
const runPreflight = (fake: FakeFigma, over: Record<string, unknown> = {}) => runScript(assetScript("Import SVG: check target", preflightPayload(over), SVG_PREFLIGHT_BODY), fake.api());

const STROKE_ICON = svg('<path d="M5 12h14" fill="none" stroke="currentColor"/><path d="M12 5l7 7-7 7" fill="none" stroke="currentColor"/>');

describe("import: basics", () => {
	it("imports each SVG to a named frame in the target; a throw and an empty import are reported and the batch continues", async () => {
		const fake = new FakeFigma();
		const frame = new FNode("FRAME", fake);
		frame._w = 500;
		frame._h = 500;
		fake.currentPage.appendChild(frame);
		let n = 0;
		const base = fake.svgFactory;
		fake.svgFactory = (m) => {
			n++;
			if (n === 2) throw new Error("failed to invert transform");
			if (n === 3) {
				const empty = new FNode("FRAME", fake);
				empty._w = 24;
				empty._h = 24;
				return empty;
			}
			return base(m);
		};
		const items = [item(STROKE_ICON, { name: "A" }), item(STROKE_ICON, { name: "B" }), item(STROKE_ICON, { name: "C" }), item(STROKE_ICON, { name: "D" })];
		const r = await runImport(fake, payload(fake, { targetId: frame.id, groups: singles(...items) }));
		expect(r.results.map((x: any) => x.status)).toEqual(["created", "failed", "failed", "created"]);
		expect(r.results[1]).toMatchObject({ stage: "import", reason: "Figma could not import this SVG: failed to invert transform" });
		expect(r.results[2]).toMatchObject({ stage: "import", reason: "Figma imported nothing visible from this SVG." });
		expect(frame.children!.map((c) => c.name)).toEqual(["A", "D"]);
		// createNodeFromSvg's frame comes with a white fill; an icon's box must be transparent.
		expect(frame.children!.map((c) => c.fills)).toEqual([[], []]);
		expect(fake.currentPage.children!.filter((c) => c.type === "FRAME" && c !== frame)).toHaveLength(0);
	});

	it("a container this run created keeps its starting size when every item fails", async () => {
		const fake = new FakeFigma();
		const section = new FNode("SECTION", fake);
		section._w = 500;
		section._h = 500;
		fake.currentPage.appendChild(section);
		fake.svgFactory = () => {
			throw new Error("failed to invert transform");
		};
		const layout = { mode: "grid", columns: 2, gap: 10, padding: 20, cell: { w: 24, h: 24 }, container: { id: section.id, created: true } };
		const r = await runImport(fake, payload(fake, { targetId: section.id, layout, groups: singles(item(STROKE_ICON, { name: "A" }), item(STROKE_ICON, { name: "B" })) }));
		expect(r.results.map((x: any) => x.status)).toEqual(["failed", "failed"]);
		expect([section.width, section.height]).toEqual([500, 500]);
	});

	it("editorImportMode group groups the children into the target and removes the frame", async () => {
		const fake = new FakeFigma();
		fake.editorType = "figjam";
		const r = await runImport(fake, payload(fake, { editorImportMode: "group", groups: singles(item(STROKE_ICON, { name: "G" })) }));
		expect(r.results[0]).toMatchObject({ status: "created", type: "GROUP" });
		const kids = fake.currentPage.children!;
		expect(kids.map((c) => c.type)).toEqual(["GROUP"]);
		expect(kids[0].name).toBe("G");
		expect(kids[0].children).toHaveLength(2);
	});

	it("fit uses rescale with the min ratio; scaleStrokes false uses SCALE constraints and resize; square centers a 24×16 icon", async () => {
		const fake = new FakeFigma();
		const wide = svg('<rect x="0" y="0" width="48" height="32" fill="#000"/>', 'viewBox="0 0 48 32"');
		const r1 = await runImport(fake, payload(fake, { opts: { box: { w: 24, h: 24 } }, groups: singles(item(wide)) }));
		expect(r1.results[0]).toMatchObject({ width: 24, height: 16 });
		expect(fake.currentPage.children![0].children![0].strokeWeight).toBe(0.5);

		const fake2 = new FakeFigma();
		const r2 = await runImport(fake2, payload(fake2, { opts: { box: { w: 24, h: 24 }, scaleStrokes: false }, groups: singles(item(wide)) }));
		expect(r2.results[0]).toMatchObject({ width: 24, height: 16 });
		const leaf = fake2.currentPage.children![0].children![0];
		expect(leaf.constraints).toEqual({ horizontal: "SCALE", vertical: "SCALE" });
		expect(leaf.strokeWeight).toBe(1);
		expect(leaf.width).toBe(24);

		const fake3 = new FakeFigma();
		const art = svg('<rect x="0" y="0" width="24" height="16" fill="#000"/>', 'width="24" height="16" viewBox="0 0 24 16"');
		const r3 = await runImport(fake3, payload(fake3, { opts: { box: { w: 24, h: 24 }, square: true, asComponent: true }, groups: singles(item(art)) }));
		expect(r3.results[0]).toMatchObject({ type: "COMPONENT", width: 24, height: 24 });
		const comp = fake3.nodes.get(r3.results[0].nodeId)!;
		expect(comp.children![0].y).toBe(4);
		expect(comp.children![0].x).toBe(0);
	});

	it("asComponent makes a component with SCALE constraints, description and svgImport plugin data", async () => {
		const fake = new FakeFigma();
		const r = await runImport(fake, payload(fake, { opts: { asComponent: true, colorRef: "var:KEY1" }, groups: singles(item(STROKE_ICON, { name: "Icon/arrow", description: "Arrow", artHash: "H42" })) }));
		const comp = fake.nodes.get(r.results[0].nodeId)!;
		expect(comp.type).toBe("COMPONENT");
		expect(comp.description).toBe("Arrow");
		expect(comp.children!.every((c) => c.constraints?.horizontal === "SCALE")).toBe(true);
		const rec = JSON.parse(comp.getPluginData("svgImport"));
		expect(rec).toMatchObject({ v: 1, runId: RUN, artHash: "H42", colorRef: "var:KEY1", source: "svgs[0]", hasText: false });
		expect(fake.calls).toContain("createComponentFromNode");
	});

	it("plain vectors also get plugin data with the runId", async () => {
		const fake = new FakeFigma();
		const r = await runImport(fake, payload(fake, { groups: singles(item(STROKE_ICON)) }));
		const node = fake.nodes.get(r.results[0].nodeId)!;
		expect(node.type).toBe("FRAME");
		expect(JSON.parse(node.getPluginData("svgImport"))).toMatchObject({ runId: RUN, colorRef: "none" });
	});

	it("sentinel paints become the root color, or black when there is none", async () => {
		const fake = new FakeFigma();
		const withRoot = item(svg('<path d="M1 1h2" fill="currentColor"/>', 'viewBox="0 0 24 24" color="#3366ff"'));
		const plain = item(svg('<path d="M1 1h2" fill="currentColor"/>'));
		const r = await runImport(fake, payload(fake, { groups: singles(withRoot, plain) }));
		const [a, b] = r.results.map((x: any) => fake.nodes.get(x.nodeId)!.children![0]);
		expect(a.fills[0].color).toEqual(rgb("#3366ff"));
		expect(b.fills[0].color).toEqual({ r: 0, g: 0, b: 0 });
	});
});

describe("import: flatten and color", () => {
	const variable = { id: "VariableID:1:1", key: "KEY1", name: "icon/default", resolvedType: "COLOR", variableCollectionId: "C1" };
	const colorVar = { variableId: variable.id, apply: "auto", targets: ["fills", "strokes"], label: "Icons/icon/default" };

	it("flatten merges identical leaves (currentColor markers included), carries the refs, then binds the color", async () => {
		const fake = new FakeFigma();
		fake.localVariables = [variable];
		const r = await runImport(fake, payload(fake, { opts: { flatten: true, color: colorVar, colorRef: "var:KEY1" }, groups: singles(item(STROKE_ICON)) }));
		const frame = fake.nodes.get(r.results[0].nodeId)!;
		expect(frame.children!.map((c) => [c.type, c.name])).toEqual([["VECTOR", "Vector"]]);
		expect(frame.children![0].strokes[0].boundVariables.color.id).toBe(variable.id);
		expect(r.results[0].color).toMatchObject({ applied: true, mode: "variable", variable: "Icons/icon/default", source: "currentColor", paints: 1 });
	});

	it("skips flatten with a note when paints differ", async () => {
		const fake = new FakeFigma();
		const r = await runImport(fake, payload(fake, { opts: { flatten: true }, groups: singles(item(svg('<path d="M1 1h2" fill="#ff0000"/><path d="M3 3h2" fill="#0000ff"/>'))) }));
		expect(r.results[0].notes).toContain("flatten skipped: layers have different colors or strokes.");
		expect(fake.nodes.get(r.results[0].nodeId)!.children).toHaveLength(2);
	});

	it("auto binds only currentColor paints in a duotone, all paints of a single-color icon, and skips multi-color", async () => {
		const fake = new FakeFigma();
		fake.localVariables = [variable];
		const duo = item(svg('<path d="M4 4h16" fill="currentColor"/><circle cx="12" cy="12" r="4" fill="#FFB800"/>'));
		const single = item(svg('<path d="M1 1h2" fill="#1F2937"/><rect width="2" height="7" fill="#1F2937"/>'));
		const multi = item(svg('<rect width="2" height="2" fill="#1A73E8"/><rect width="2" height="2" fill="#EA4335"/><rect width="2" height="2" fill="#FBBC05"/>'));
		const r = await runImport(fake, payload(fake, { opts: { color: colorVar, colorRef: "var:KEY1" }, groups: singles(duo, single, multi) }));
		const nodes = r.results.map((x: any) => fake.nodes.get(x.nodeId)!);
		expect(nodes[0].children![0].fills[0].boundVariables?.color.id).toBe(variable.id);
		expect(nodes[0].children![1].fills[0].boundVariables).toBeUndefined();
		expect(nodes[0].children![1].fills[0].color).toEqual(rgb("#FFB800"));
		expect(r.results[1].color).toMatchObject({ applied: true, source: "single-color", paints: 2 });
		expect(r.results[2].color).toEqual({ applied: false, reason: 'multi-color (#1A73E8, #EA4335, #FBBC05); left as is. Pass color.apply "all" to recolor everything.' });
	});

	it("apply all binds every solid; targets strokes leaves fills; a variableKey is imported once per chunk", async () => {
		const fake = new FakeFigma();
		fake.libraryCollections = [{ key: "LC", name: "Brand", libraryName: "Brand DS", vars: [{ key: "LIBKEY", name: "icon/default", resolvedType: "COLOR" }] }];
		const api = fake.api();
		const multi = item(svg('<rect width="2" height="2" fill="#1A73E8" stroke="#000000"/><rect width="2" height="2" fill="#EA4335"/>'));
		const r = await runScript(
			assetScript("Import SVG (2 items)", payload(fake, { opts: { color: { variableKey: "LIBKEY", apply: "all", targets: ["strokes"], label: "Brand/icon/default" }, colorRef: "var:LIBKEY" }, groups: singles(multi, item(STROKE_ICON)) }), SVG_IMPORT_BODY),
			api,
		);
		expect(api.variables.importVariableByKeyAsync).toHaveBeenCalledTimes(1);
		const first = fake.nodes.get(r.results[0].nodeId)!;
		expect(first.children![0].fills[0].boundVariables).toBeUndefined();
		expect(first.children![0].strokes[0].boundVariables.color.id).toBe("VariableID:lib/LIBKEY");
		expect(r.results[0].color).toMatchObject({ applied: true, source: "all", paints: 1 });
	});

	it("color value sets a literal color and keeps paint opacity", async () => {
		const fake = new FakeFigma();
		fake.svgFactory = () => {
			const f = new FNode("FRAME", fake);
			f._w = 24;
			f._h = 24;
			const v = new FNode("VECTOR", fake);
			v._w = 24;
			v._h = 24;
			v.fills = [solid("#000000", { opacity: 0.4 })];
			f.appendChild(v);
			return f;
		};
		const r = await runImport(fake, payload(fake, { opts: { color: { value: "#ff0000", apply: "auto", targets: ["fills", "strokes"] }, colorRef: "value:ff0000" }, groups: singles(item(STROKE_ICON)) }));
		const v = fake.nodes.get(r.results[0].nodeId)!.children![0];
		expect(v.fills[0]).toMatchObject({ color: rgb("#ff0000"), opacity: 0.4 });
		expect(r.results[0].color).toMatchObject({ applied: true, mode: "value", value: "#FF0000" });
	});
});

/** A staging frame whose structure the test controls. */
function stagingFactory(fake: FakeFigma, build: (frame: FNode) => void, size: [number, number] = [24, 24]) {
	return () => {
		const f = new FNode("FRAME", fake);
		f._w = size[0];
		f._h = size[1];
		build(f);
		return f;
	};
}
function vec(fake: FakeFigma, parent: FNode, o: { x?: number; y?: number; w?: number; h?: number; d?: string; rt?: number[][]; fills?: any[] } = {}) {
	const v = new FNode("VECTOR", fake);
	v._w = o.w ?? 20;
	v._h = o.h ?? 20;
	if (o.rt) v.rt = o.rt;
	else {
		v.x = o.x ?? 2;
		v.y = o.y ?? 2;
	}
	v.vectorNetwork = { vertices: [{ x: 0, y: 0 }, { x: v._w, y: v._h }], segments: [], regions: [], d: o.d ?? "new" };
	v.fills = o.fills ?? [solid("#000000")];
	parent.appendChild(v);
	return v;
}
const update = (target: FNode, over: Record<string, unknown> = {}) => item(STROKE_ICON, { action: "update", targetId: target.id, name: target.name, ...over });

describe("import: update in place", () => {
	it("geometry: same-shape vectors get setVectorNetworkAsync, ids unchanged, bound paints kept", async () => {
		const fake = new FakeFigma();
		const variable = { id: "VariableID:9:9", key: "K9", name: "icon", resolvedType: "COLOR", variableCollectionId: "C" };
		fake.localVariables = [variable];
		const comp = makeIconComponent(fake, { name: "Icon/a" });
		const leaf = comp.children![0];
		leaf.fills = [{ ...solid("#000000"), boundVariables: { color: { type: "VARIABLE_ALIAS", id: variable.id } } }];
		const leafId = leaf.id;
		fake.svgFactory = stagingFactory(fake, (f) => vec(fake, f, { x: 2, y: 2, d: "new" }));
		const r = await runImport(fake, payload(fake, { groups: singles(update(comp)) }));
		expect(r.results[0]).toMatchObject({ status: "updated", nodeId: comp.id, update: { strategy: "geometry", overridesKept: true } });
		expect(comp.children![0].id).toBe(leafId);
		expect(leaf.setVectorNetworkAsync).toHaveBeenCalledWith(expect.objectContaining({ d: "new" }));
		expect(leaf.fills[0].boundVariables.color.id).toBe(variable.id);
		expect(leaf.x).toBe(2);
		expect(r.results[0].color).toMatchObject({ source: "inherited" });
		expect(JSON.parse(comp.getPluginData("svgImport")).colorRef).toBe("var:K9");
	});

	it("geometry maps nested GROUP transforms, takes a rotated leaf's relativeTransform and strips region fills when old paints are kept", async () => {
		const fake = new FakeFigma();
		fake.localVariables = [{ id: "V1", key: "K1", name: "c", resolvedType: "COLOR", variableCollectionId: "C" }];
		const comp = makeIconComponent(fake, { name: "Icon/g", leaves: 0 });
		const g = new FNode("GROUP", fake);
		comp.appendChild(g);
		const a = vec(fake, g, { x: 1, y: 1, d: "a-old", fills: [{ ...solid("#000000"), boundVariables: { color: { type: "VARIABLE_ALIAS", id: "V1" } } }] });
		const b = vec(fake, g, { x: 5, y: 5, d: "b-old" });
		const rotated = [
			[0, -1, 22],
			[1, 0, 2],
		];
		fake.svgFactory = stagingFactory(fake, (f) => {
			const sg = new FNode("GROUP", fake);
			f.appendChild(sg);
			const na = vec(fake, sg, { x: 3, y: 4, d: "a-new" });
			na.vectorNetwork.regions = [{ windingRule: "NONZERO", loops: [[0]], fills: [solid("#ff0000")], fillStyleId: "S:1" }];
			vec(fake, sg, { rt: rotated, d: "b-new" });
		});
		const r = await runImport(fake, payload(fake, { groups: singles(update(comp)) }));
		expect(r.results[0].update).toEqual({ strategy: "geometry", overridesKept: true });
		expect([a.x, a.y]).toEqual([3, 4]);
		expect(b.relativeTransform).toEqual(rotated);
		const sentNet = a.setVectorNetworkAsync.mock.calls[0][0];
		expect(sentNet.regions[0].fills).toBeUndefined();
		expect(sentNet.regions[0].fillStyleId).toBeUndefined();
	});

	it("geometry pairs only VECTOR leaves (every SVG shape imports as VECTOR); other leaf types fall back to replace", async () => {
		// A hand-drawn RECTANGLE can never line up with fresh art: createNodeFromSvg always makes VECTORs.
		const fake = new FakeFigma();
		const comp = makeIconComponent(fake, { name: "Icon/shapes", leaves: 0 });
		const rect = new FNode("RECTANGLE", fake);
		rect._w = 10;
		rect._h = 10;
		comp.appendChild(rect);
		fake.svgFactory = stagingFactory(fake, (f) => {
			const r2 = new FNode("RECTANGLE", fake);
			r2._w = 12;
			r2._h = 8;
			f.appendChild(r2);
		});
		const r = await runImport(fake, payload(fake, { groups: singles(update(comp)) }));
		expect(r.results[0].update).toMatchObject({ strategy: "replace", fallbackReason: "unsupported layer type" });
		// And the real factory turns <rect>, <circle> and <line> into VECTORs that pair with an earlier import.
		const fake2 = new FakeFigma();
		const art = svg('<rect x="2" y="2" width="20" height="20" fill="#000"/><circle cx="12" cy="12" r="4" fill="#000"/>');
		const first = await runImport(fake2, payload(fake2, { opts: { asComponent: true }, groups: singles(item(art, { name: "Icon/rc" })) }));
		const made = fake2.nodes.get(first.results[0].nodeId)!;
		expect(made.children!.map((c) => c.type)).toEqual(["VECTOR", "VECTOR"]);
		const again = await runImport(fake2, payload(fake2, { groups: singles(item(art, { action: "update", targetId: made.id, name: "Icon/rc" })) }));
		expect(again.results[0].update).toEqual({ strategy: "geometry", overridesKept: true });
	});

	it("falls back to replace for a different layer count, nested frames, a rotated component and a bounds mismatch", async () => {
		const cases: Array<[string, (fake: FakeFigma, comp: FNode) => void]> = [
			["layer count differs", (fake) => (fake.svgFactory = stagingFactory(fake, (f) => (vec(fake, f), vec(fake, f))))],
			[
				"nested frames",
				(fake, comp) => {
					comp.children![0].remove();
					const fr = new FNode("FRAME", fake);
					comp.appendChild(fr);
					vec(fake, fr);
					fake.svgFactory = stagingFactory(fake, (f) => {
						const sf = new FNode("FRAME", fake);
						f.appendChild(sf);
						vec(fake, sf);
					});
				},
			],
			[
				"rotated component",
				(fake, comp) => {
					comp.rt = [
						[0, -1, 24],
						[1, 0, 0],
					];
					fake.svgFactory = stagingFactory(fake, (f) => vec(fake, f));
				},
			],
			[
				"geometry check failed (off by 6 px)",
				(fake, comp) => {
					comp.children![0].setVectorNetworkAsync.mockImplementation(async (net: any) => {
						comp.children![0].vectorNetwork = net;
						comp.children![0]._w = 26;
					});
					fake.svgFactory = stagingFactory(fake, (f) => vec(fake, f));
				},
			],
		];
		for (const [why, setup] of cases) {
			const fake = new FakeFigma();
			const comp = makeIconComponent(fake, { name: "Icon/x" });
			setup(fake, comp);
			const r = await runImport(fake, payload(fake, { groups: singles(update(comp)) }));
			expect(r.results[0]).toMatchObject({ status: "updated", update: { strategy: "replace", overridesKept: false, fallbackReason: why } });
			expect(r.results[0].notes).toContain(`Layer structure changed (${why}), so overrides on the old layers reset in instances.`);
		}
	});

	it("keepOverrides: a structure change is skipped with the children untouched; a bounds mismatch restores the snapshot", async () => {
		const fake = new FakeFigma();
		const comp = makeIconComponent(fake, { name: "Icon/k" });
		const leaf = comp.children![0];
		fake.svgFactory = stagingFactory(fake, (f) => (vec(fake, f), vec(fake, f)));
		const r = await runImport(fake, payload(fake, { opts: { keepOverrides: true }, groups: singles(update(comp)) }));
		expect(r.results[0]).toMatchObject({ status: "skipped", reason: "Layer structure changed (layer count differs), so updating would reset instance overrides; left as is (keepOverrides)." });
		expect(comp.children).toEqual([leaf]);
		expect(leaf.setVectorNetworkAsync).not.toHaveBeenCalled();

		const fake2 = new FakeFigma();
		const comp2 = makeIconComponent(fake2, { name: "Icon/k2" });
		const leaf2 = comp2.children![0];
		const before = { w: leaf2.width, x: leaf2.x, net: leaf2.vectorNetwork };
		leaf2.setVectorNetworkAsync.mockImplementation(async (net: any) => {
			leaf2.vectorNetwork = net;
			leaf2._w = net.d === "new" ? 30 : 24;
		});
		fake2.svgFactory = stagingFactory(fake2, (f) => vec(fake2, f, { x: 2, y: 2 }));
		const r2 = await runImport(fake2, payload(fake2, { opts: { keepOverrides: true }, groups: singles(update(comp2)) }));
		expect(r2.results[0].status).toBe("skipped");
		expect(r2.results[0].reason).toMatch(/^Layer structure changed \(geometry check failed \(off by \d+(\.\d)? px\)\)/);
		expect({ w: leaf2.width, x: leaf2.x, net: leaf2.vectorNetwork }).toEqual(before);
		expect(comp2.children).toEqual([leaf2]);
	});

	it("replace swaps the children, keeps the component and centers the art in the existing box", async () => {
		const fake = new FakeFigma();
		const comp = makeIconComponent(fake, { name: "Icon/r" });
		const oldLeaf = comp.children![0];
		fake.svgFactory = stagingFactory(
			fake,
			(f) => {
				vec(fake, f, { x: 0, y: 0, w: 24, h: 16 });
				vec(fake, f, { x: 0, y: 0, w: 10, h: 10 });
			},
			[24, 16],
		);
		const r = await runImport(fake, payload(fake, { groups: singles(update(comp)) }));
		expect(r.results[0]).toMatchObject({ status: "updated", nodeId: comp.id, update: { strategy: "replace" } });
		expect(fake.nodes.get(comp.id)).toBe(comp);
		expect(oldLeaf.removed).toBe(true);
		expect(comp.children!.map((c) => c.y)).toEqual([4, 4]);
		expect(fake.currentPage.children!.filter((c) => c.type === "FRAME")).toHaveLength(0);
	});

	it("an update with size keeps a square icon square and centers the art", async () => {
		const fake = new FakeFigma();
		const comp = makeIconComponent(fake, { name: "Icon/sq" });
		fake.svgFactory = stagingFactory(fake, (f) => vec(fake, f, { x: 0, y: 0, w: 48, h: 32 }), [48, 32]);
		const r = await runImport(fake, payload(fake, { opts: { box: { w: 24, h: 24 }, square: true, asComponent: true }, groups: singles(update(comp)) }));
		expect(r.results[0]).toMatchObject({ status: "updated", width: 24, height: 24 });
		expect([comp.width, comp.height]).toEqual([24, 24]);
		expect(comp.children![0].y).toBe(4);
	});

	it("metadata items change only the description", async () => {
		const fake = new FakeFigma();
		const comp = makeIconComponent(fake, { name: "Icon/m" });
		const before = JSON.stringify(comp.children!.map((c) => c.vectorNetwork));
		const r = await runImport(fake, payload(fake, { groups: singles({ key: "m", name: "Icon/m", action: "metadata", targetId: comp.id, description: "New words", artHash: "h", source: "s", sentinel: null, hasText: false }) }));
		expect(r.results[0]).toMatchObject({ status: "unchanged", metadataUpdated: true });
		expect(comp.description).toBe("New words");
		expect(JSON.stringify(comp.children!.map((c) => c.vectorNetwork))).toBe(before);
		expect(fake.calls).not.toContain("createNodeFromSvg");
	});

	it("a processing error removes the partial frame; an update failure leaves the component untouched", async () => {
		const fake = new FakeFigma();
		const api = fake.api();
		api.createComponentFromNode = () => {
			throw new Error("boom");
		};
		const r = await runScript(assetScript("Import SVG (1 items)", payload(fake, { opts: { asComponent: true }, groups: singles(item(STROKE_ICON)) }), SVG_IMPORT_BODY), api);
		expect(r.results[0]).toMatchObject({ status: "failed", stage: "process", reason: "Couldn't finish this SVG: boom" });
		expect(fake.currentPage.children).toHaveLength(0);

		const fake2 = new FakeFigma();
		const comp = makeIconComponent(fake2, { name: "Icon/u" });
		const leaf = comp.children![0];
		const api2 = fake2.api();
		api2.util.solidPaint = () => {
			throw new Error("bad color");
		};
		const r2 = await runScript(
			assetScript("Import SVG (1 items)", payload(fake2, { groups: singles(update(comp, { sentinel: "#17E95B", rootColor: "#123456" })) }), SVG_IMPORT_BODY),
			api2,
		);
		// solidPaint failing for the root color falls back to black; the update still applies.
		expect(r2.results[0].status).toBe("updated");
		const fake3 = new FakeFigma();
		const comp3 = makeIconComponent(fake3, { name: "Icon/v" });
		const leaf3 = comp3.children![0];
		const api3 = fake3.api();
		api3.flatten = () => {
			throw new Error("flatten exploded");
		};
		const r3 = await runScript(assetScript("Import SVG (1 items)", payload(fake3, { opts: { flatten: true }, groups: singles(update(comp3)) }), SVG_IMPORT_BODY), api3);
		expect(r3.results[0]).toMatchObject({ status: "failed", reason: "Updating failed, so the existing component was left as is: flatten exploded" });
		expect(comp3.children).toEqual([leaf3]);
		expect(leaf3.setVectorNetworkAsync).not.toHaveBeenCalled();
		expect(fake3.currentPage.children!.filter((c) => c.type === "FRAME")).toHaveLength(0);
		// fake2 replaced its art (layer count differed), so its old leaf is gone: the color fallback didn't abort the update.
		expect(leaf.removed).toBe(true);
	});

	it("re-checks eligibility before writing and reports a conflict if the component grew text", async () => {
		const fake = new FakeFigma();
		const comp = makeIconComponent(fake, { name: "Icon/t" });
		comp.appendChild(new FNode("TEXT", fake));
		const r = await runImport(fake, payload(fake, { groups: singles(update(comp)) }));
		expect(r.results[0].status).toBe("conflict");
		expect(fake.calls).not.toContain("createNodeFromSvg");
	});
});

describe("import: sets", () => {
	it("a new set: combineAsVariants with Axis=value names, matrix layout, default top-left, dashed border", async () => {
		const fake = new FakeFigma();
		const variants = [
			["16", "outline"],
			["16", "solid"],
			["24", "outline"],
			["24", "solid"],
		].map(([Size, Style]) => item(svg('<path d="M1 1h2" fill="#000"/>', `viewBox="0 0 ${Size} ${Size}"`), { name: `Size=${Size}, Style=${Style}`, props: { Size, Style } }));
		const r = await runImport(fake, payload(fake, { opts: { asComponent: true }, groups: [{ kind: "set", name: "Icon/bell", action: "create", axes: ["Size", "Style"], variants }] }));
		expect(fake.calls).toContain("combineAsVariants");
		expect(r.sets[0]).toMatchObject({ name: "Icon/bell", created: true, variants: 4, added: 4 });
		const set = fake.nodes.get(r.sets[0].id)!;
		expect(set.name).toBe("Icon/bell");
		expect(set.children!.map((c) => c.name)).toEqual(["Size=16, Style=outline", "Size=16, Style=solid", "Size=24, Style=outline", "Size=24, Style=solid"]);
		const pos = set.children!.map((c) => [c.x, c.y]);
		// cell 24×24, gap 16, padding 16; rows by Size, columns by Style; 16px icons centered in the cell.
		expect(pos).toEqual([
			[20, 20],
			[60, 20],
			[16, 56],
			[56, 56],
		]);
		expect([set.width, set.height]).toEqual([16 * 2 + 2 * 24 + 16, 16 * 2 + 2 * 24 + 16]);
		expect(set.strokes[0].color).toEqual({ r: 0.592, g: 0.278, b: 1 });
		expect(set.dashPattern).toEqual([10, 5]);
		expect(r.results.every((x: any) => x.componentSetId === set.id)).toBe(true);
		expect(JSON.parse(set.getPluginData("svgImport"))).toEqual({ v: 1, kind: "set", runId: RUN });
	});

	it("an existing set: matched variants updated, new ones appended into free cells, the set grown", async () => {
		const fake = new FakeFigma();
		const set = new FNode("COMPONENT_SET", fake);
		set.name = "Icon/zap";
		set._w = 56;
		set._h = 56;
		fake.currentPage.appendChild(set);
		const v16 = makeIconComponent(fake, { name: "Size=16", parent: set, size: [24, 24] });
		v16.x = 16;
		v16.y = 16;
		fake.svgFactory = stagingFactory(fake, (f) => vec(fake, f));
		const groups = [
			{
				kind: "set",
				name: "Icon/zap",
				action: "update",
				setId: set.id,
				axes: ["Size"],
				untouched: 0,
				variants: [update(v16, { name: "Size=16", props: { Size: "16" } }), item(STROKE_ICON, { name: "Size=24", props: { Size: "24" } })],
			},
		];
		const r = await runImport(fake, payload(fake, { opts: { asComponent: true }, groups }));
		expect(r.results.map((x: any) => x.status)).toEqual(["updated", "created"]);
		expect(r.sets[0]).toMatchObject({ id: set.id, created: false, added: 1, updated: 1, variants: 2 });
		const added = set.children![1];
		expect(added.name).toBe("Size=24");
		expect(added.y).toBe(16 + 24 + 16);
		expect(set.height).toBeGreaterThanOrEqual(added.y + added.height + 16);
		expect(set.width).toBe(56);
	});
});

describe("import: layout, undo, busy marker", () => {
	const small = () => item(svg('<rect width="16" height="16" fill="#000"/>', 'viewBox="0 0 16 16"'));

	it("grid with size, continued across two chunks; a container this run created is fitted to its content, a reused one only grows", async () => {
		const fake = new FakeFigma();
		const section = new FNode("SECTION", fake);
		section._w = 1000;
		section._h = 50;
		fake.currentPage.appendChild(section);
		const layout = { mode: "grid", columns: 2, gap: 10, padding: 20, cell: { w: 24, h: 24 }, container: { id: section.id, created: true } };
		const r1 = await runImport(fake, payload(fake, { targetId: section.id, final: false, layout, groups: singles(small(), small(), small()) }));
		const r2 = await runImport(fake, payload(fake, { targetId: section.id, layout: { ...layout, cursor: r1.cursor }, groups: singles(small()) }));
		const pos = [...r1.results, ...r2.results].map((x: any) => {
			const n = fake.nodes.get(x.nodeId)!;
			return [n.x, n.y];
		});
		expect(pos).toEqual([
			[24, 24],
			[58, 24],
			[24, 58],
			[58, 58],
		]);
		// Created by this run: fitted to the content plus padding (FigJam starts sections at ~500x500).
		expect(section.width).toBe(58 + 16 + 20);
		expect(section.height).toBe(58 + 16 + 20);
		// Reused (the person's own section, or one from an earlier run): never shrinks.
		const fake3 = new FakeFigma();
		const own = new FNode("SECTION", fake3);
		own._w = 1000;
		own._h = 50;
		fake3.currentPage.appendChild(own);
		await runImport(fake3, payload(fake3, { targetId: own.id, layout: { ...layout, container: { id: own.id, created: false } }, groups: singles(small(), small(), small()) }));
		expect(own.width).toBe(1000);
		expect(own.height).toBe(58 + 16 + 20);
	});

	it("shelf otherwise, wrapping after columns; no positioning in an auto-layout target", async () => {
		const fake = new FakeFigma();
		const r = await runImport(fake, payload(fake, { layout: { mode: "shelf", columns: 2, gap: 10, padding: 0, origin: { x: 100, y: 200 } }, groups: singles(small(), small(), small()) }));
		const pos = r.results.map((x: any) => [fake.nodes.get(x.nodeId)!.x, fake.nodes.get(x.nodeId)!.y]);
		expect(pos).toEqual([
			[100, 200],
			[126, 200],
			[100, 226],
		]);
		const fake2 = new FakeFigma();
		const al = new FNode("FRAME", fake2);
		al.layoutMode = "HORIZONTAL";
		fake2.currentPage.appendChild(al);
		const r2 = await runImport(fake2, payload(fake2, { targetId: al.id, layout: { mode: "auto-layout" }, groups: singles(small(), small()) }));
		expect(r2.results.map((x: any) => fake2.nodes.get(x.nodeId)!.x)).toEqual([0, 0]);
		expect(r2.cursor).toBeNull();
	});

	it("places on a page at clear space right of existing content", async () => {
		const fake = new FakeFigma();
		const existing = new FNode("FRAME", fake);
		existing._w = 300;
		existing._h = 100;
		existing.x = 50;
		existing.y = -20;
		fake.currentPage.appendChild(existing);
		const r = await runImport(fake, payload(fake, { layout: { mode: "single" }, groups: singles(small()) }));
		const n = fake.nodes.get(r.results[0].nodeId)!;
		expect([n.x, n.y]).toEqual([510, -20]);
	});

	it("focuses only in the final chunk and only on the current page", async () => {
		const fake = new FakeFigma();
		const api = fake.api();
		await runScript(assetScript("Import SVG (1 items)", payload(fake, { final: false, focus: true, groups: singles(small()) }), SVG_IMPORT_BODY), api);
		expect(api.viewport.scrollAndZoomIntoView).not.toHaveBeenCalled();
		const r = await runScript(assetScript("Import SVG (1 items)", payload(fake, { final: true, focus: true, groups: singles(small()) }), SVG_IMPORT_BODY), api);
		expect(api.viewport.scrollAndZoomIntoView).toHaveBeenCalledTimes(1);
		expect((fake.currentPage.selection ?? []).map((n: FNode) => n.id)).toEqual([r.results[0].nodeId]);

		const other = new FNode("PAGE", fake);
		other.name = "Icons";
		fake.pages.push(other);
		const api2 = fake.api();
		const r2 = await runScript(assetScript("Import SVG (1 items)", payload(fake, { targetId: other.id, final: true, focus: true, groups: singles(small()) }), SVG_IMPORT_BODY), api2);
		expect(api2.viewport.scrollAndZoomIntoView).not.toHaveBeenCalled();
		expect(r2.notes[0]).toMatch(/is on the page "Icons", so it wasn't selected/);
	});

	it("every write script calls commitUndo first and last; the checkpoint saves a version before any change", async () => {
		const fake = new FakeFigma();
		await runImport(fake, payload(fake, { groups: singles(small()) }));
		expect(fake.calls[0]).toBe("commitUndo");
		expect(fake.calls[fake.calls.length - 1]).toBe("commitUndo");

		const fake2 = new FakeFigma();
		await runScript(assetScript("Import SVG: container", { runId: RUN, parentId: fake2.currentPage.id, type: "section", name: "Icons", gap: 24, padding: 40 }, SVG_CONTAINER_BODY), fake2.api());
		expect(fake2.calls[0]).toBe("commitUndo");
		expect(fake2.calls[fake2.calls.length - 1]).toBe("commitUndo");

		const fake3 = new FakeFigma();
		const r = await runScript(assetScript("Import SVG: save a restore version", { title: "Before SVG import (Figma Console MCP)", description: "x" }, SVG_CHECKPOINT_BODY), fake3.api());
		expect(fake3.calls).toEqual(["commitUndo", "saveVersionHistoryAsync:Before SVG import (Figma Console MCP):x", "commitUndo"]);
		expect(r).toEqual({ versionId: "4471234567" });
		fake3.versionResult = null;
		expect(await runScript(assetScript("Import SVG: save a restore version", { title: "t" }, SVG_CHECKPOINT_BODY), fake3.api())).toEqual({ versionId: null });
	});

	it("the container script creates a wrapping frame at clear space, or reuses one", async () => {
		const fake = new FakeFigma();
		const r = await runScript(
			assetScript("Import SVG: container", { runId: RUN, parentId: fake.currentPage.id, type: "frame", name: "SVG import", gap: 24, padding: 40, width: 500 }, SVG_CONTAINER_BODY),
			fake.api(),
		);
		const f = fake.nodes.get(r.id)!;
		expect(r).toMatchObject({ type: "FRAME", created: true, autoLayout: true });
		expect([f.layoutMode, f.layoutWrap, f.width, f.fills, f.clipsContent]).toEqual(["HORIZONTAL", "WRAP", 500, [], false]);
		const again = await runScript(assetScript("Import SVG: container", { runId: RUN, parentId: fake.currentPage.id, type: "frame", name: "SVG import", gap: 24, padding: 40, reuseId: r.id }, SVG_CONTAINER_BODY), fake.api());
		expect(again).toMatchObject({ id: r.id, created: false });
	});

	it("busy marker: set during a chunk and removed in finally even when the body throws", async () => {
		const fake = new FakeFigma();
		let seen: any;
		const base = fake.svgFactory;
		fake.svgFactory = (m) => {
			seen = (globalThis as any).__figmaConsoleSvgImport;
			return base(m);
		};
		await runImport(fake, payload(fake, { groups: singles(small()) }));
		expect(seen).toMatchObject({ runId: RUN });
		expect((globalThis as any).__figmaConsoleSvgImport).toBeUndefined();
		await expect(runImport(fake, payload(fake, { targetId: "999:999", groups: singles(small()) }))).rejects.toThrow("The target layer 999:999 no longer exists.");
		expect((globalThis as any).__figmaConsoleSvgImport).toBeUndefined();
		expect(fake.calls[fake.calls.length - 1]).toBe("commitUndo");
	});
});

describe("preflight", () => {
	it("refuses while a fresh busy marker exists and ignores a stale one", async () => {
		const fake = new FakeFigma();
		(globalThis as any).__figmaConsoleSvgImport = { runId: "x", startedAt: Date.now() - 5000 };
		expect((await runPreflight(fake)).fatal).toMatch(/^An earlier SVG import is still running in Figma \(started 5 s ago\)/);
		(globalThis as any).__figmaConsoleSvgImport = { runId: "x", startedAt: Date.now() - 2_000_000 };
		expect((await runPreflight(fake)).fatal).toBeUndefined();
	});

	it("rejects Dev Mode, unsupported editors, components outside Design and binding where unsupported", async () => {
		const fake = new FakeFigma();
		fake.editorType = "dev";
		expect((await runPreflight(fake)).fatal).toBe("Dev Mode is read-only. Switch the file to Design mode (Shift+D) and run again.");
		fake.editorType = "buzz";
		expect((await runPreflight(fake)).fatal).toBe("SVG import doesn't work in buzz yet.");
		fake.editorType = "figjam";
		expect((await runPreflight(fake, { wantsComponents: true })).fatal).toMatch(/^Components and variant sets can only be made in Figma Design files\. In FigJam/);
		const noBinding = { ...EDITOR_SUPPORT, figjam: { ...EDITOR_SUPPORT.figjam, variableBinding: false } };
		expect((await runPreflight(fake, { editorSupport: noBinding, color: { variable: "x" } })).fatal).toBe("Binding variables isn't available in FigJam. Pass color.value instead.");
		const noVectors = { ...EDITOR_SUPPORT, slides: { ...EDITOR_SUPPORT.slides, vectors: false } };
		fake.editorType = "slides";
		expect((await runPreflight(fake, { editorSupport: noVectors })).fatal).toBe("SVG import doesn't work in Slides yet.");
	});

	it("checks the parent: missing, invalid, inside a component, Slides defaults", async () => {
		const fake = new FakeFigma();
		expect((await runPreflight(fake, { parentId: "9:9" })).fatal).toMatch(/^Parent 9:9 not found/);
		const inst = new FNode("INSTANCE", fake);
		inst.children = [];
		fake.currentPage.appendChild(inst);
		expect((await runPreflight(fake, { parentId: inst.id })).fatal).toBe("Can't put layers inside a INSTANCE. Use a frame, section, group, page or slide.");
		const comp = makeIconComponent(fake, { name: "C" });
		const inner = new FNode("FRAME", fake);
		comp.appendChild(inner);
		expect((await runPreflight(fake, { parentId: inner.id, wantsComponents: true })).fatal).toBe("Components can't be created inside another component. Use a section, frame or page outside it.");
		expect((await runPreflight(fake, { parentId: inner.id })).fatal).toBeUndefined();
		const set = new FNode("COMPONENT_SET", fake);
		fake.currentPage.appendChild(set);
		expect((await runPreflight(fake, { parentId: set.id })).fatal).toMatch(/Can't put layers inside a COMPONENT_SET/);

		fake.editorType = "slides";
		expect((await runPreflight(fake)).fatal).toBe("In Slides, pass parentId (a slide id from figma_list_slides) or focus a slide.");
		const slide = new FNode("SLIDE", fake);
		fake.currentPage.appendChild(slide);
		fake.currentPage.focusedSlide = slide;
		expect((await runPreflight(fake)).parent).toMatchObject({ id: slide.id, type: "SLIDE" });
		const loose = new FNode("FRAME", fake);
		fake.currentPage.appendChild(loose);
		expect((await runPreflight(fake, { parentId: loose.id })).fatal).toBe("In Slides, put the import on a slide: pass a slide id (figma_list_slides) or a frame inside one.");
	});

	it("resolves a COLOR variable by name, Collection/name and id, with options when ambiguous or missing", async () => {
		const fake = new FakeFigma();
		fake.collections = [
			{ id: "C1", name: "Icons" },
			{ id: "C2", name: "Brand" },
		];
		fake.localVariables = [
			{ id: "V1", key: "K1", name: "icon/default", resolvedType: "COLOR", variableCollectionId: "C1" },
			{ id: "V2", key: "K2", name: "icon/default", resolvedType: "COLOR", variableCollectionId: "C2" },
			{ id: "V3", key: "K3", name: "icon/muted", resolvedType: "COLOR", variableCollectionId: "C1" },
		];
		expect((await runPreflight(fake, { color: { variable: "Icons/icon/default" } })).variable).toMatchObject({ id: "V1", key: "K1", label: "Icons/icon/default", remote: false });
		expect((await runPreflight(fake, { color: { variable: "V3" } })).colorRef).toBe("var:K3");
		const amb = await runPreflight(fake, { color: { variable: "icon/default" } });
		expect(amb.fatal).toBe('Several COLOR variables match "icon/default"; use Collection/name or the id.');
		expect(amb.options).toEqual(["Icons/icon/default", "Brand/icon/default"]);
		const miss = await runPreflight(fake, { color: { variable: "icon/mutd" } });
		expect(miss.fatal).toMatch(/^No COLOR variable named "icon\/mutd" in this file or its libraries\. Close names: "Icons\/icon\/muted"/);
		fake.libraryCollections = [{ key: "LC", name: "Core", libraryName: "Core DS", vars: [{ key: "LK", name: "icon/brand", resolvedType: "COLOR" }] }];
		const lib = await runPreflight(fake, { color: { variable: "icon/brand" } });
		expect(lib.fatal).toBe('No local COLOR variable named "icon/brand". Library matches: "Core/icon/brand" (variableKey "LK"). Pass color.variableKey to use one.');
		expect((await runPreflight(fake, { color: { variableKey: "LK" } })).variable).toMatchObject({ key: "LK", remote: true });
		expect((await runPreflight(fake, { color: { variableKey: "NOPE" } })).fatal).toMatch(/^No COLOR variable with key "NOPE" in the libraries this file uses/);
		expect((await runPreflight(fake, { color: { value: "#ff0000" } })).colorRef).toBe("value:ff0000");
		expect((await runPreflight(fake, { color: { value: "chartreuse-ish" } })).fatal).toBe('Could not read color "chartreuse-ish". Use hex or a CSS color.');
		expect((await runPreflight(fake)).colorRef).toBe("inherit");
	});

	it("matches: none, one, many, kind mismatch; eligibility rules", async () => {
		const fake = new FakeFigma();
		const ok = makeIconComponent(fake, { name: "Icon/ok" });
		makeIconComponent(fake, { name: "Icon/dup" });
		makeIconComponent(fake, { name: "Icon/dup" });
		const set = new FNode("COMPONENT_SET", fake);
		set.name = "Icon/set";
		fake.currentPage.appendChild(set);
		const text = makeIconComponent(fake, { name: "Icon/text" });
		text.appendChild(new FNode("TEXT", fake));
		const textOk = makeIconComponent(fake, { name: "Icon/textok", record: { hasText: true } });
		textOk.appendChild(new FNode("TEXT", fake));
		const inst = makeIconComponent(fake, { name: "Icon/inst", record: { runId: "old", artHash: "h" } });
		inst.appendChild(new FNode("INSTANCE", fake));
		const al = makeIconComponent(fake, { name: "Icon/al" });
		al.layoutMode = "VERTICAL";
		const wired = makeIconComponent(fake, { name: "Icon/wired" });
		wired.children![0].componentPropertyReferences = { visible: "Show#1:2" };
		const bool = makeIconComponent(fake, { name: "Icon/bool" });
		bool._defs = { "Show badge#3:4": { type: "BOOLEAN" } };
		const q = (name: string, kind = "component") => ({ key: name, kind, name, artHash: "h", force: false });
		const r = await runPreflight(fake, {
			wantsComponents: true,
			matches: ["Icon/none", "Icon/ok", "Icon/dup", "Icon/text", "Icon/textok", "Icon/inst", "Icon/al", "Icon/wired", "Icon/bool"].map((n) => q(n)).concat([q("Icon/set")]),
		});
		const by = Object.fromEntries(r.matches.map((m: any) => [m.key, m]));
		expect(by["Icon/none"].status).toBe("none");
		expect(by["Icon/ok"]).toMatchObject({ status: "one", existingId: ok.id, eligible: true });
		expect(by["Icon/dup"]).toMatchObject({ status: "many", count: 2 });
		expect(by["Icon/set"]).toMatchObject({ status: "kind-mismatch", existingKind: "set" });
		expect(by["Icon/text"]).toMatchObject({ eligible: false, why: "it contains a text layer" });
		expect(by["Icon/textok"].eligible).toBe(true);
		expect(by["Icon/inst"]).toMatchObject({ eligible: false, why: "it contains an instance layer" });
		expect(by["Icon/al"]).toMatchObject({ eligible: false, why: "it uses auto layout" });
		expect(by["Icon/wired"]).toMatchObject({ eligible: false, why: "it has layers wired to component properties" });
		expect(by["Icon/bool"]).toMatchObject({ eligible: false, why: 'it has a boolean property ("Show badge")' });
		expect(fake.calls).toContain("loadAllPagesAsync");
	});

	it("a set whose property definitions throw is the variant-errors conflict; variants match by properties", async () => {
		const fake = new FakeFigma();
		const broken = new FNode("COMPONENT_SET", fake);
		broken.name = "Icon/broken";
		broken._defsThrow = true;
		fake.currentPage.appendChild(broken);
		const set = new FNode("COMPONENT_SET", fake);
		set.name = "Icon/bell";
		fake.currentPage.appendChild(set);
		const a = makeIconComponent(fake, { name: "Size=16", parent: set, record: { artHash: "same", colorRef: "none" } });
		makeIconComponent(fake, { name: "size=24", parent: set });
		makeIconComponent(fake, { name: "Size=32", parent: set });
		const r = await runPreflight(fake, {
			wantsComponents: true,
			matches: [
				{ key: "set:Icon/broken", kind: "set", name: "Icon/broken", artHash: "", force: false, variants: [] },
				{
					key: "set:Icon/bell",
					kind: "set",
					name: "Icon/bell",
					artHash: "",
					force: false,
					variants: [
						{ key: "v16", props: { Size: "16" }, artHash: "same" },
						{ key: "v24", props: { Size: "24" }, artHash: "x" },
						{ key: "v48", props: { Size: "48" }, artHash: "x" },
					],
				},
			],
		});
		expect(r.matches[0]).toMatchObject({ status: "one", variantErrors: true });
		const bell = r.matches[1];
		expect(bell.axes).toEqual(expect.arrayContaining(["Size"]));
		expect(bell.variants[0]).toMatchObject({ key: "v16", existingId: a.id, matchedBy: "exact", unchanged: true });
		expect(bell.variants[1]).toMatchObject({ key: "v24", matchedBy: "case-insensitive", matchedName: "size=24", unchanged: false });
		expect(bell.variants[2]).toMatchObject({ key: "v48", existingId: null });
		expect(bell.untouched).toBe(1);
	});

	it("unchanged needs the same artHash and colorRef (inherit matches any); force disables it; a new description is reported", async () => {
		const fake = new FakeFigma();
		const c = makeIconComponent(fake, { name: "Icon/u", record: { artHash: "H", colorRef: "var:K1" } });
		c.description = "old";
		const q = (over: Record<string, unknown> = {}) => [{ key: "u", kind: "component", name: "Icon/u", artHash: "H", force: false, ...over }];
		expect((await runPreflight(fake, { wantsComponents: true, matches: q() })).matches[0].unchanged).toBe(true);
		expect((await runPreflight(fake, { wantsComponents: true, matches: q({ artHash: "X" }) })).matches[0].unchanged).toBe(false);
		expect((await runPreflight(fake, { wantsComponents: true, matches: q({ force: true }) })).matches[0].unchanged).toBe(false);
		expect((await runPreflight(fake, { wantsComponents: true, color: { value: "#ff0000" }, matches: q() })).matches[0].unchanged).toBe(false);
		expect((await runPreflight(fake, { wantsComponents: true, matches: q({ description: "new" }) })).matches[0]).toMatchObject({ unchanged: true, descriptionDiffers: true });
	});

	it("counts instances and reads publish status only for changed targets, at most maxCounted; a throwing status is UNKNOWN", async () => {
		const fake = new FakeFigma();
		const same = makeIconComponent(fake, { name: "A", record: { artHash: "H", colorRef: "none" } });
		same._instances = [{ name: "a1" }];
		const changed = makeIconComponent(fake, { name: "B" });
		changed._instances = [{ name: "Toolbar / Search" }, { name: "x" }];
		changed._publish = "CURRENT";
		const throws = makeIconComponent(fake, { name: "C" });
		throws._publish = new Error("offline");
		const beyond = makeIconComponent(fake, { name: "D" });
		beyond._instances = [{ name: "d" }];
		const q = (name: string) => ({ key: name, kind: "component", name, artHash: "H", force: false });
		const r = await runPreflight(fake, { wantsComponents: true, maxCounted: 2, matches: ["A", "B", "C", "D"].map(q) });
		const [a, b, c, d] = r.matches;
		expect(a).toMatchObject({ unchanged: true });
		expect(a.instanceCount).toBeUndefined();
		expect(b).toMatchObject({ instanceCount: 2, publish: "CURRENT", firstInstance: "Toolbar / Search" });
		expect(c).toMatchObject({ instanceCount: 0, publish: "UNKNOWN" });
		expect(d).toMatchObject({ instanceCount: null, publish: "UNKNOWN", counted: false });
	});

	it("resumeRunId finds the nodes the earlier run created, by source and artHash", async () => {
		const fake = new FakeFigma();
		const f = new FNode("FRAME", fake);
		f.setPluginData("svgImport", JSON.stringify({ v: 1, runId: RUN, artHash: "H1", source: "svgs[0]" }));
		fake.currentPage.appendChild(f);
		const other = new FNode("FRAME", fake);
		other.setPluginData("svgImport", JSON.stringify({ v: 1, runId: "ffffffffffff", artHash: "H2", source: "svgs[1]" }));
		fake.currentPage.appendChild(other);
		const r = await runPreflight(fake, { resumeRunId: RUN });
		expect(r.resumed).toEqual([{ source: "svgs[0]", artHash: "H1", nodeId: f.id, type: "FRAME", width: 0, height: 0 }]);
	});

	it("finds a reusable container by name in the parent", async () => {
		const fake = new FakeFigma();
		const s = new FNode("SECTION", fake);
		s.name = "Icons";
		fake.currentPage.appendChild(s);
		expect((await runPreflight(fake, { containerName: "Icons" })).container).toEqual({ id: s.id, type: "SECTION", name: "Icons", autoLayout: false });
	});
});

describe("script safety", () => {
	it("no body contains ${ or a backtick; the label line never holds payload text", () => {
		for (const [name, body] of Object.entries(ALL_SVG_BODIES)) {
			expect({ name, interp: body.includes("${") }).toEqual({ name, interp: false });
			expect({ name, tick: body.includes("`") }).toEqual({ name, tick: false });
		}
		const script = assetScript("Import SVG (1 items)", { markup: "evil\n// injected" }, SVG_IMPORT_BODY);
		expect(script.split("\n")[0]).toBe("// Import SVG (1 items)");
		expect(() => assetScript("Import \"x\"; alert(1)", {}, SVG_IMPORT_BODY)).toThrow();
	});

	it("every body parses as an async function", () => {
		const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
		for (const body of Object.values(ALL_SVG_BODIES)) expect(() => new AsyncFunction("figma", `const P = {};\n${body}`)).not.toThrow();
	});
});

describe("review fixes", () => {
	const runContainer = (fake: FakeFigma, p: Record<string, unknown>, body = SVG_CONTAINER_BODY) =>
		runScript(assetScript("Import SVG: container", { runId: RUN, parentId: fake.currentPage.id, type: "frame", name: "SVG import", gap: 24, padding: 40, busyStaleMs: 900_000, ...p }, body), fake.api());

	it("an update with size that keepOverrides skips leaves the component's size untouched", async () => {
		// Structure change (1 layer → 2) with a 32×32 box.
		const fake = new FakeFigma();
		const comp = makeIconComponent(fake, { name: "Icon/k" });
		fake.svgFactory = stagingFactory(fake, (f) => (vec(fake, f), vec(fake, f)));
		const r = await runImport(fake, payload(fake, { opts: { box: { w: 32, h: 32 }, square: true, asComponent: true, keepOverrides: true }, groups: singles(update(comp)) }));
		expect(r.results[0].status).toBe("skipped");
		expect([comp.width, comp.height]).toEqual([24, 24]);
		// Geometry applied, check failed, snapshot restored, with size 20.
		const fake2 = new FakeFigma();
		const comp2 = makeIconComponent(fake2, { name: "Icon/k2" });
		const leaf2 = comp2.children![0];
		leaf2.setVectorNetworkAsync.mockImplementation(async (net: any) => {
			leaf2.vectorNetwork = net;
			leaf2._w = net.d === "new" ? 30 : 24;
		});
		fake2.svgFactory = stagingFactory(fake2, (f) => vec(fake2, f, { x: 2, y: 2 }));
		const r2 = await runImport(fake2, payload(fake2, { opts: { box: { w: 20, h: 20 }, square: true, asComponent: true, keepOverrides: true }, groups: singles(update(comp2)) }));
		expect(r2.results[0].status).toBe("skipped");
		expect([comp2.width, comp2.height]).toEqual([24, 24]);
		// Without keepOverrides the same update goes ahead and resizes.
		const fake3 = new FakeFigma();
		const comp3 = makeIconComponent(fake3, { name: "Icon/k3" });
		fake3.svgFactory = stagingFactory(fake3, (f) => (vec(fake3, f), vec(fake3, f)));
		const r3 = await runImport(fake3, payload(fake3, { opts: { box: { w: 32, h: 32 }, square: true, asComponent: true }, groups: singles(update(comp3)) }));
		expect(r3.results[0]).toMatchObject({ status: "updated", width: 32, height: 32 });
	});

	it("a failure after the artwork changed says so instead of 'left as is'", async () => {
		const fake = new FakeFigma();
		const comp = makeIconComponent(fake, { name: "Icon/p" });
		comp.setPluginData = () => {
			throw new Error("boom");
		};
		fake.svgFactory = stagingFactory(fake, (f) => vec(fake, f, { x: 2, y: 2 }));
		const r = await runImport(fake, payload(fake, { groups: singles(update(comp)) }));
		expect(r.results[0]).toMatchObject({ status: "failed", reason: 'Updating failed partway, so "Icon/p" may be partly updated (restore the saved version if needed): boom' });
	});

	it("the wrapping frame keeps hug height: resize comes before the sizing modes (SVG and image containers)", async () => {
		for (const body of [SVG_CONTAINER_BODY, IMAGE_CONTAINER_BODY]) {
			const fake = new FakeFigma();
			const r = await runContainer(fake, { width: 500 }, body);
			const f = fake.nodes.get(r.id)!;
			expect([f.width, f.primaryAxisSizingMode, f.counterAxisSizingMode]).toEqual([500, "FIXED", "AUTO"]);
		}
	});

	it("FigJam with the shipped EDITOR_SUPPORT: color.variable and color.variableKey fail cleanly without touching figma.variables", async () => {
		expect(EDITOR_SUPPORT.figjam).toEqual({ vectors: true, components: false, variableBinding: false, importMode: "frame" });
		expect(EDITOR_SUPPORT.slides).toMatchObject({ vectors: true, variableBinding: true });
		for (const color of [{ variable: "icon/default" }, { variableKey: "abc" }]) {
			const fake = new FakeFigma();
			fake.editorType = "figjam";
			fake.variablesAvailable = false;
			expect(await runPreflight(fake, { color })).toEqual({ fatal: "Binding variables isn't available in FigJam. Pass color.value instead." });
		}
		// A future editor that claims binding but has no figma.variables fails the same way.
		const fake = new FakeFigma();
		fake.variablesAvailable = false;
		expect((await runPreflight(fake, { color: { variable: "x" } })).fatal).toBe("Binding variables isn't available in Figma Design. Pass color.value instead.");
		// color.value still works in FigJam.
		const fj = new FakeFigma();
		fj.editorType = "figjam";
		fj.variablesAvailable = false;
		expect((await runPreflight(fj, { color: { value: "#ff0000" } })).colorRef).toBe("value:ff0000");
	});

	it("an update never touches figma.variables where it doesn't exist (inherited binding is skipped)", async () => {
		const fake = new FakeFigma();
		fake.variablesAvailable = false;
		const comp = makeIconComponent(fake, { name: "Icon/v" });
		comp.children![0].fills = [{ ...solid("#000000"), boundVariables: { color: { type: "VARIABLE_ALIAS", id: "V1" } } }];
		fake.svgFactory = stagingFactory(fake, (f) => vec(fake, f, { x: 2, y: 2 }));
		const r = await runImport(fake, payload(fake, { groups: singles(update(comp)) }));
		expect(r.results[0].status).toBe("updated");
	});

	it("resume looks in the whole parent, even when a same-named container exists", async () => {
		const fake = new FakeFigma();
		const old = new FNode("FRAME", fake);
		old.name = "SVG import";
		fake.currentPage.appendChild(old);
		const placed = new FNode("FRAME", fake);
		placed._w = 24;
		placed._h = 24;
		placed.setPluginData("svgImport", JSON.stringify({ v: 1, runId: RUN, source: "svgs[0]", artHash: "H1" }));
		fake.currentPage.appendChild(placed);
		const r = await runPreflight(fake, { containerName: "SVG import", resumeRunId: RUN });
		expect(r.container).toMatchObject({ id: old.id });
		expect(r.resumed).toEqual([{ source: "svgs[0]", artHash: "H1", nodeId: placed.id, type: "FRAME", width: 24, height: 24 }]);
	});

	it("force on a set re-imports matching variants (and counts their risk)", async () => {
		const fake = new FakeFigma();
		const set = new FNode("COMPONENT_SET", fake);
		set.name = "Icon/arrow";
		fake.currentPage.appendChild(set);
		const v = makeIconComponent(fake, { name: "Size=24", parent: set, record: { artHash: "H", colorRef: "none" } });
		v._instances = [{ name: "i1" }, { name: "i2" }];
		const q = (force: boolean, variantForce?: boolean) => [
			{ key: "set:Icon/arrow", kind: "set", name: "Icon/arrow", artHash: "", force, variants: [{ key: "k1", props: { Size: "24" }, artHash: "H", ...(variantForce !== undefined ? { force: variantForce } : {}) }] },
		];
		expect((await runPreflight(fake, { wantsComponents: true, matches: q(false) })).matches[0].variants[0].unchanged).toBe(true);
		const forced = (await runPreflight(fake, { wantsComponents: true, matches: q(true) })).matches[0].variants[0];
		expect(forced).toMatchObject({ unchanged: false, instanceCount: 2 });
		expect((await runPreflight(fake, { wantsComponents: true, matches: q(false, true) })).matches[0].variants[0].unchanged).toBe(false);
	});

	it("the checkpoint remembers its version for a resume of the same run in the same file; a wrong file is refused", async () => {
		const fake = new FakeFigma();
		const cp = (p: Record<string, unknown>) => runScript(assetScript("Import SVG: save a restore version", { title: "t", description: "d", runId: RUN, fileKey: "FILE123", ...p }, SVG_CHECKPOINT_BODY), fake.api());
		expect(await cp({})).toEqual({ versionId: "4471234567" });
		expect((await runPreflight(fake, { resumeRunId: RUN })).checkpoint).toEqual({ versionId: "4471234567" });
		expect((await runPreflight(fake, { resumeRunId: "bbbbbbbbbbbb" })).checkpoint).toBeUndefined();
		fake.fileKey = "OTHER_FILE";
		expect((await runPreflight(fake, { resumeRunId: RUN })).checkpoint).toBeUndefined();
		const before = fake.calls.length;
		expect((await cp({})).refused).toMatch(/^This step reached a different Figma file/);
		expect(fake.calls.length).toBe(before);
	});

	it("write steps refuse to run in a file other than the one the preflight checked", async () => {
		const fake = new FakeFigma();
		expect((await runContainer(fake, { fileKey: "FILE_A" })).refused).toMatch(/^This step reached a different Figma file than the one checked at the start of this call/);
		const r = await runImport(fake, payload(fake, { fileKey: "FILE_A", groups: singles(item(STROKE_ICON)) }));
		expect(r.refused).toMatch(/^This step reached a different Figma file/);
		expect(fake.calls).not.toContain("createNodeFromSvg");
		expect(fake.currentPage.children).toHaveLength(0);
		// The matching file runs.
		expect((await runImport(fake, payload(fake, { fileKey: "FILE123", groups: singles(item(STROKE_ICON)) }))).results[0].status).toBe("created");
	});

	it("busy markers: a fresh marker of another run (SVG or image) refuses the step; finally removes only its own marker", async () => {
		const fake = new FakeFigma();
		for (const name of ["__figmaConsoleSvgImport", "__figmaConsoleImageImport"]) {
			(globalThis as any)[name] = { runId: "otherrun0000", startedAt: Date.now() - 3000, token: "theirs" };
			const r = await runImport(fake, payload(fake, { busyStaleMs: 900_000, groups: singles(item(STROKE_ICON)) }));
			expect(r.refused).toMatch(/^Another (SVG|image) import is still writing in Figma \(started 3 s ago\), so this step didn't start and nothing was changed/);
			expect((await runContainer(fake, {})).refused).toMatch(/^Another/);
			expect((globalThis as any)[name].token).toBe("theirs");
			delete (globalThis as any)[name];
		}
		expect(fake.calls).not.toContain("createNodeFromSvg");
		// If the marker changed hands mid-run, this run's finally leaves the new owner's marker alone.
		const base = fake.svgFactory;
		fake.svgFactory = (m) => {
			(globalThis as any).__figmaConsoleSvgImport = { runId: "otherrun0000", startedAt: Date.now(), token: "theirs" };
			return base(m);
		};
		await runImport(fake, payload(fake, { busyStaleMs: 900_000, groups: singles(item(STROKE_ICON)) }));
		expect((globalThis as any).__figmaConsoleSvgImport).toMatchObject({ token: "theirs" });
	});

	it("componentSets lists only sets that exist", async () => {
		const fake = new FakeFigma();
		fake.svgFactory = () => {
			throw new Error("bad svg");
		};
		const variants = ["16", "24"].map((Size) => item(STROKE_ICON, { name: `Size=${Size}`, props: { Size } }));
		const r = await runImport(fake, payload(fake, { opts: { asComponent: true }, groups: [{ kind: "set", name: "Icon/zap", action: "create", axes: ["Size"], variants }] }));
		expect(r.results.map((x: any) => x.status)).toEqual(["failed", "failed"]);
		expect(r.sets).toEqual([]);
		const gone = await runImport(fake, payload(fake, { opts: { asComponent: true }, groups: [{ kind: "set", name: "Icon/zap", action: "update", setId: "999:9", axes: ["Size"], untouched: 2, variants }] }));
		expect(gone.sets).toEqual([]);
		expect(gone.results[0].reason).toBe("The component set 999:9 is gone; run again to create it.");
	});

	it("a slide or a clipping frame keeps the result inside its visible area", async () => {
		const art = svg('<path d="M0 0h200v200H0z" fill="#000"/>', 'viewBox="0 0 200 200"');
		// A slide with a full-bleed background: a single SVG is centered on it, not placed below it.
		const fake = new FakeFigma();
		fake.editorType = "slides";
		const slide = new FNode("SLIDE", fake);
		slide._w = 1920;
		slide._h = 1080;
		fake.currentPage.appendChild(slide);
		const bg = new FNode("RECTANGLE", fake);
		bg._w = 1920;
		bg._h = 1080;
		slide.appendChild(bg);
		const r = await runImport(fake, payload(fake, { targetId: slide.id, layout: { mode: "single" }, groups: singles(item(art, { name: "Logo" })) }));
		const node = fake.nodes.get(r.results[0].nodeId)!;
		expect([node.x, node.y, node.width]).toEqual([860, 440, 200]);
		expect(r.notes[0]).toMatch(/^There was no free space inside the slide, so "Logo" was placed inside its visible area/);
		// An explicit x/y wins.
		const r2 = await runImport(fake, payload(fake, { targetId: slide.id, layout: { mode: "single", origin: { x: 1800, y: 1000 } }, groups: singles(item(art)) }));
		expect([fake.nodes.get(r2.results[0].nodeId)!.x, fake.nodes.get(r2.results[0].nodeId)!.y]).toEqual([1800, 1000]);
		// A clipping 375×812 screen: clamped inside. The same frame without clipping keeps "below the children".
		const fake2 = new FakeFigma();
		const screen = new FNode("FRAME", fake2);
		screen._w = 375;
		screen._h = 812;
		fake2.currentPage.appendChild(screen);
		const full = new FNode("RECTANGLE", fake2);
		full._w = 375;
		full._h = 812;
		screen.appendChild(full);
		const small = svg('<path d="M0 0h24v24H0z" fill="#000"/>');
		const r3 = await runImport(fake2, payload(fake2, { targetId: screen.id, groups: singles(item(small)) }));
		const n3 = fake2.nodes.get(r3.results[0].nodeId)!;
		expect([n3.x, n3.y]).toEqual([0, 812 - 24]);
		screen.clipsContent = false;
		const r4 = await runImport(fake2, payload(fake2, { targetId: screen.id, groups: singles(item(small)) }));
		expect(fake2.nodes.get(r4.results[0].nodeId)!.y).toBe(812 + 24);
		// A container created on a slide is clamped too.
		const fake3 = new FakeFigma();
		const slide3 = new FNode("SLIDE", fake3);
		slide3._w = 1920;
		slide3._h = 1080;
		fake3.currentPage.appendChild(slide3);
		const bg3 = new FNode("RECTANGLE", fake3);
		bg3._w = 1920;
		bg3._h = 1080;
		slide3.appendChild(bg3);
		const c = await runContainer(fake3, { parentId: slide3.id, width: 600 });
		const cf = fake3.nodes.get(c.id)!;
		expect(cf.y + cf.height).toBeLessThanOrEqual(1080);
		expect(c.notes).toHaveLength(1);
	});

	it("text SVGs: fonts are loaded before rescaling; a font Figma can't load fails a resize with a clear reason", async () => {
		const text = svg('<path d="M0 0h1v1H0z"/><text x="0" y="10">Hi</text>', 'viewBox="0 0 120 40"');
		const fake = new FakeFigma();
		const r = await runImport(fake, payload(fake, { opts: { box: { w: 24, h: 24 } }, groups: singles(item(text)) }));
		expect(r.results[0].status).toBe("created");
		expect(fake.calls).toContain("loadFontAsync:Inter/Regular");
		const fake2 = new FakeFigma();
		fake2.missingFonts.add("Inter/Regular");
		const r2 = await runImport(fake2, payload(fake2, { opts: { box: { w: 24, h: 24 } }, groups: singles(item(text)) }));
		expect(r2.results[0]).toMatchObject({
			status: "failed",
			reason: "This SVG's text uses Inter Regular, which Figma can't load, so it can't be resized. Convert the text to paths, or leave out size, width and height.",
		});
		expect(fake2.currentPage.children).toHaveLength(0);
		// No resize: the text imports as before.
		expect((await runImport(fake2, payload(fake2, { groups: singles(item(text)) }))).results[0].status).toBe("created");
	});

	it("bodies use only syntax the Figma sandbox accepts (no ?., ??, or spread)", () => {
		for (const [name, body] of Object.entries(ALL_SVG_BODIES)) {
			expect([name, /\?\.(?!\d)|\?\?|\.\.\./.test(body)]).toEqual([name, false]);
		}
	});
});
