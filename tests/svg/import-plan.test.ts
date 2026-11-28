/**
 * Pure planning rules for figma_import_svg (spec §2.2 defaults, §2.6.4
 * actions, §2.6.5 wording, §2.6.6 container resolution).
 */

import {
	assembleResponse,
	buildMatchQueries,
	confirmMessage,
	isRisky,
	normalizeImportArgs,
	planFromPreflight,
	planLayout,
	unsupportedSkipReason,
	type ImportItem,
	type PlanGroup,
	type PreflightResult,
} from "../../src/core/assets/import-plan";

const pre = (over: Partial<PreflightResult> = {}): PreflightResult => ({
	editorType: "figma",
	fileKey: "F",
	fileName: "Acme DS",
	parent: { id: "0:1", type: "PAGE", name: "Page 1", autoLayout: false, pageId: "0:1", onCurrentPage: true },
	colorRef: "inherit",
	matches: [],
	...over,
});
const mk = (key: string, over: Partial<ImportItem> = {}): ImportItem => ({ key, source: key, kind: "inline", notes: [], name: key, artHash: "h", markup: "<svg/>", action: "create", ...over });
const singles = (n: number): PlanGroup[] => Array.from({ length: n }, (_, i) => ({ kind: "single", item: mk(`i${i}`) }));

describe("normalizeImportArgs", () => {
	it("applies every default and records whether onExisting was explicit", () => {
		const n = normalizeImportArgs({ svgs: [{ markup: "<svg/>" }], parentId: "12-34", color: { value: "#000" } });
		expect(n).toMatchObject({
			recursive: false,
			offset: 0,
			limit: 200,
			scaleStrokes: true,
			asComponent: false,
			flatten: false,
			onExisting: "update",
			explicitOnExisting: false,
			keepOverrides: false,
			force: false,
			matchScope: "file",
			layout: { container: "auto", gap: 24, padding: 40 },
			focus: true,
			dryRun: false,
			verbose: false,
			parentId: "12:34",
			color: { value: "#000", apply: "auto", targets: ["fills", "strokes"] },
		});
		expect(normalizeImportArgs({ variants: { pattern: "{name}-{Size}" } }).asComponent).toBe(true);
		expect(normalizeImportArgs({ onExisting: "update" }).explicitOnExisting).toBe(true);
	});
});

describe("planLayout", () => {
	const n = (args: Record<string, unknown> = {}) => normalizeImportArgs({ svgs: [{ markup: "x" }], ...args });

	it("auto: none for one item or an auto-layout parent, a section for components or FigJam, a frame for vector batches", () => {
		expect(planLayout(singles(1), pre(), n()).container).toBe("none");
		expect(planLayout(singles(1), pre(), n()).mode).toBe("single");
		expect(planLayout(singles(3), pre({ parent: { ...pre().parent, type: "FRAME", autoLayout: true } }), n()).container).toBe("none");
		expect(planLayout(singles(3), pre(), n({ asComponent: true })).container).toBe("section");
		expect(planLayout(singles(3), pre({ editorType: "figjam" }), n()).container).toBe("section");
		const frame = planLayout(singles(3), pre(), n({ size: 24 }));
		expect(frame).toMatchObject({ container: "frame", mode: "auto-layout", columns: 3, frameWidth: 3 * 24 + 2 * 24 + 80 });
		// Sections can't go inside frames: auto falls back to none; explicit section is an error.
		const inFrame = pre({ parent: { ...pre().parent, type: "FRAME" } });
		expect(planLayout(singles(3), inFrame, n({ asComponent: true })).container).toBe("none");
		expect(planLayout(singles(3), inFrame, n({ asComponent: true, layout: { container: "section" } })).error).toMatch(/^A section can only go on a page or inside another section/);
	});

	it("grid with size and no set group, shelf otherwise; reuse ignores x/y with a note", () => {
		expect(planLayout(singles(3), pre(), n({ size: 16, asComponent: true }))).toMatchObject({ mode: "grid", cell: { w: 16, h: 16 } });
		const set: PlanGroup = { kind: "set", name: "S", axes: ["Size"], action: "create", items: [mk("a"), mk("b")] };
		expect(planLayout([set, ...singles(2)], pre(), n({ size: 16, asComponent: true })).mode).toBe("shelf");
		const reused = planLayout(singles(3), pre({ container: { id: "9:9", type: "SECTION", name: "Icons", autoLayout: false } }), n({ asComponent: true, x: 10, y: 10 }));
		expect(reused.reuse).toEqual({ id: "9:9", type: "SECTION", autoLayout: false });
		expect(reused.notes).toEqual(['x/y ignored: the existing "Icons" was reused.']);
		expect(planLayout(singles(1), pre(), n({ x: 5, y: 6 })).origin).toEqual({ x: 5, y: 6 });
	});
});

describe("planFromPreflight", () => {
	const n = (args: Record<string, unknown> = {}) => normalizeImportArgs({ svgs: [{ markup: "x" }], asComponent: true, ...args });

	it("maps matches to actions per §2.6.4", () => {
		const groups = ["none", "one", "unch", "meta", "many", "kind", "inel", "verr"].map((k) => ({ kind: "single", item: mk(k) }) as PlanGroup);
		const p = pre({
			matches: [
				{ key: "none", status: "none" },
				{ key: "one", status: "one", existingId: "1:1", eligible: true, instanceCount: 0, publish: "UNPUBLISHED" },
				{ key: "unch", status: "one", existingId: "1:2", eligible: true, unchanged: true },
				{ key: "meta", status: "one", existingId: "1:3", eligible: true, unchanged: true, descriptionDiffers: true },
				{ key: "many", status: "many", count: 3, ids: ["1:4", "1:5", "1:6"] },
				{ key: "kind", status: "kind-mismatch", existingKind: "set" },
				{ key: "inel", status: "one", existingId: "1:7", eligible: false, why: "it uses auto layout" },
				{ key: "verr", status: "one", existingId: "1:8", variantErrors: true },
			],
		});
		planFromPreflight(groups, p, n());
		const actions = groups.map((g) => (g.kind === "single" ? g.item.action : null));
		expect(actions).toEqual(["create", "update", "unchanged", "metadata", "conflict", "conflict", "conflict", "conflict"]);
		const items = groups.map((g) => (g as Extract<PlanGroup, { kind: "single" }>).item);
		expect(items[4].reason).toBe('3 components are named "many" (ids 1:4, 1:5, 1:6). Rename them so one is left, or pass onExisting: "duplicate".');
		expect(items[5].reason).toBe('"kind" is a component set, but this import makes a single component. Rename one of them.');
		expect(items[6].reason).toBe('"inel" isn\'t plain vector artwork (it uses auto layout), so it wasn\'t replaced. Rename the import (namePrefix) or pass onExisting: "duplicate".');
		expect(isRisky(items[1])).toBe(false);

		const skip = [{ kind: "single", item: mk("one") } as PlanGroup];
		planFromPreflight(skip, p, n({ onExisting: "skip" }));
		expect((skip[0] as any).item).toMatchObject({ action: "skip", reason: '"one" already exists; left as is.' });
		const dup = [{ kind: "single", item: mk("one") } as PlanGroup];
		planFromPreflight(dup, p, n({ onExisting: "duplicate" }));
		expect((dup[0] as any).item).toMatchObject({ action: "create", notes: ['A component named "one" already exists; this one is a duplicate.'] });
	});

	it("checks set axes and matches variants", () => {
		const set: PlanGroup = { kind: "set", name: "Icon/a", axes: ["Size", "Style"], action: "create", items: [mk("v1", { props: { Size: "16", Style: "solid" } }), mk("v2", { props: { Size: "24", Style: "solid" } })] };
		planFromPreflight([set], pre({ matches: [{ key: "set:Icon/a", status: "one", existingId: "5:5", axes: ["Size"] }] }), n());
		expect(set.items[0]).toMatchObject({ action: "conflict", reason: 'The existing set "Icon/a" has properties [Size]; this import has [Size, Style].' });
		const set2: PlanGroup = { kind: "set", name: "Icon/a", axes: ["Size"], action: "create", items: [mk("v1", { name: "Size=16" }), mk("v2", { name: "Size=24" })] };
		planFromPreflight(
			[set2],
			pre({ matches: [{ key: "set:Icon/a", status: "one", existingId: "5:5", axes: ["Size"], untouched: 2, variants: [{ key: "v1", existingId: "6:1", matchedBy: "case-insensitive", matchedName: "size=16", eligible: true, instanceCount: 2, publish: "CURRENT" }, { key: "v2", existingId: null }] }] }),
			n(),
		);
		expect(set2).toMatchObject({ action: "update", setId: "5:5", untouched: 2 });
		expect(set2.items[0]).toMatchObject({ action: "update", targetId: "6:1", instanceCount: 2, published: "CURRENT", notes: ['Matched variant "Size=16" to existing "size=16".'] });
		expect(set2.items[1].action).toBe("create");
		expect(isRisky(set2.items[0])).toBe(true);
	});
});

describe("confirmation wording", () => {
	it("says 'at least' when counts are missing and 'may be published' for UNKNOWN", () => {
		const items = [mk("a", { action: "update", instanceCount: 3, published: "UNPUBLISHED", firstInstance: "Nav" }), mk("b", { action: "update", instanceCount: null, published: "UNKNOWN" })];
		expect(confirmMessage("Lib", items)).toBe(
			'In "Lib", replace the artwork of 2 existing components (used by at least 3 instances in this file, including "Nav")? 1 of them may be published: files using this library get the new artwork when they accept the library update. Where the layer structure is unchanged, instance overrides are kept; where it changed, overrides on the old layers reset. A version named "Before SVG import (Figma Console MCP)" is saved first; restore it from version history if needed.',
		);
		expect(unsupportedSkipReason(mk("Icon/x", { instanceCount: 0, published: "CURRENT" }))).toBe('"Icon/x" is published, and this client can\'t ask for confirmation, so it wasn\'t updated. Pass onExisting: "update" to update it anyway.');
		expect(unsupportedSkipReason(mk("Icon/y", { instanceCount: 1, published: "UNKNOWN" }))).toMatch(/^"Icon\/y" has 1 instance and may be published,/);
	});
});

describe("review fixes", () => {
	const n = (over: Record<string, unknown> = {}) => normalizeImportArgs({ svgs: [{ markup: "<svg/>" }], ...over });

	it("force travels on every variant query, not only on the set", () => {
		const set: PlanGroup = { kind: "set", name: "Icon/arrow", axes: ["Size"], action: "create", items: [mk("k1", { props: { Size: "24" } })] };
		const q = buildMatchQueries([set], n({ asComponent: true, force: true }));
		expect(q[0]).toMatchObject({ kind: "set", force: true, variants: [{ key: "k1", force: true }] });
	});

	it("x or y alone, and x/y into an auto-layout parent, get a note instead of being dropped silently", () => {
		expect(planLayout(singles(1), pre(), n({ x: 100 })).notes).toEqual(["x ignored: pass both x and y to place the result; it went to clear space."]);
		expect(planLayout(singles(3), pre(), n({ y: 5 })).notes).toEqual(["y ignored: pass both x and y to place the result; it went to clear space."]);
		const auto = pre({ parent: { ...pre().parent, type: "FRAME", autoLayout: true } });
		expect(planLayout(singles(1), auto, n({ x: 1, y: 2 })).notes).toEqual(["x/y ignored: the parent uses auto layout, which positions the result."]);
		expect(planLayout(singles(1), pre(), n({ x: 1, y: 2 })).notes).toEqual([]);
	});

	it("success is false while work is unfinished; componentSets counts only sets that exist", () => {
		const items = [mk("a", { status: "created" }), mk("b", { status: "unknown" })];
		const stopped = assembleResponse({ n: n(), items, sets: [], notes: [], runId: "r", incomplete: { reason: "x", runId: "r", notAttempted: [], inProgress: ["b"] } });
		expect(stopped.body.success).toBe(false);
		const notSent = assembleResponse({ n: n(), items: [mk("a", { status: "created" })], sets: [], notes: [], runId: "r", incomplete: { reason: "x", runId: "r", notAttempted: ["c"] } });
		expect(notSent.body.success).toBe(false);
		// A cancel after the last chunk: everything finished.
		const done = assembleResponse({ n: n(), items: [mk("a", { status: "created" })], sets: [], notes: [], runId: "r", incomplete: { reason: "x", runId: "r", notAttempted: [] } });
		expect(done.body.success).toBe(true);
		const sets = assembleResponse({ n: n(), items: [], sets: [{ id: "1:1", name: "A" }, { name: "B", created: false }], notes: [] });
		expect((sets.body.summary as any).componentSets).toBe(1);
		expect(sets.body.componentSets).toEqual([{ id: "1:1", name: "A" }]);
	});

	it("a dry-run preview of a skipped risky update is worded as a prediction", () => {
		expect(unsupportedSkipReason(mk("x", { name: "Icon/bell", instanceCount: 2, published: "UNPUBLISHED" }), true)).toBe(
			'"Icon/bell" has 2 instances, and this client can\'t ask for confirmation, so a real run would skip it. Pass onExisting: "update" to update it anyway.',
		);
	});
});
