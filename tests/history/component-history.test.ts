/**
 * Component design-history tests.
 *
 * Covers the version walk (consecutive-pair diffing, snapshot cache reuse),
 * graceful degradation on API failure, and the NodeDiff → prose summarizer.
 */

import {
	buildDesignHistory,
	summarizeNodeDiff,
	_clearComponentHistoryCacheForTesting,
} from "../../src/core/history/component-history";
import type { NodeDiff } from "../../src/core/diff/diff-engine";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NODE_ID = "10:20";

function version(id: string, label: string, date: string, handle = "alice") {
	return {
		id,
		label,
		created_at: date,
		description: "",
		user: { id: "u1", handle, img_url: "" },
	};
}

/** A COMPONENT_SET snapshot with the given child layer names. */
function setNode(children: string[], extra: Record<string, unknown> = {}) {
	return {
		id: NODE_ID,
		name: "Button",
		type: "COMPONENT_SET",
		children: children.map((n, i) => ({ id: `${NODE_ID}:${i}`, name: n, type: "COMPONENT" })),
		...extra,
	};
}

/**
 * Mock FigmaAPI exposing only what buildDesignHistory uses. `snapshots` maps
 * version_id → node document (or null for "did not exist yet").
 */
function mockApi(opts: {
	versions: ReturnType<typeof version>[];
	snapshots: Record<string, any>;
	versionsError?: Error;
}) {
	const getNodes = jest.fn(async (_fileKey: string, ids: string[], o: any) => {
		const doc = opts.snapshots[o.version];
		return { nodes: doc ? { [ids[0]]: { document: doc } } : {} };
	});
	const getFileVersions = jest.fn(async () => {
		if (opts.versionsError) throw opts.versionsError;
		return { versions: opts.versions, pagination: {} };
	});
	return { getNodes, getFileVersions } as any;
}

beforeEach(() => {
	_clearComponentHistoryCacheForTesting();
});

// ---------------------------------------------------------------------------
// buildDesignHistory
// ---------------------------------------------------------------------------

describe("buildDesignHistory", () => {
	it("produces one entry per version that changed the scoped node", async () => {
		const api = mockApi({
			versions: [
				version("v3", "v1.2 icon slot", "2026-03-01T00:00:00Z", "carol"),
				version("v2", "v1.1 sizes", "2026-02-01T00:00:00Z", "bob"),
				version("v1", "v1.0 initial", "2026-01-01T00:00:00Z", "alice"),
			],
			snapshots: {
				v1: setNode(["Label"]),
				v2: setNode(["Label"]), // no change between v1 and v2
				v3: setNode(["Label", "Icon"]), // Icon added in v3
			},
		});

		const result = await buildDesignHistory(api, "file1", [NODE_ID], { versions: 2 });

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]).toMatchObject({
			version_id: "v3",
			label: "v1.2 icon slot",
			author: "carol",
			is_labeled: true,
		});
		expect(result.entries[0].changes.join(" ")).toContain("Added 1 layer");
		expect(result.entries[0].changes.join(" ")).toContain("Icon");
	});

	it("reuses cached snapshots across consecutive pairs (N+1 fetches, not 2N)", async () => {
		const api = mockApi({
			versions: [
				version("v3", "c", "2026-03-01T00:00:00Z"),
				version("v2", "b", "2026-02-01T00:00:00Z"),
				version("v1", "a", "2026-01-01T00:00:00Z"),
			],
			snapshots: {
				v1: setNode(["A"]),
				v2: setNode(["A", "B"]),
				v3: setNode(["A", "B", "C"]),
			},
		});

		const result = await buildDesignHistory(api, "file1", [NODE_ID], { versions: 2 });

		// 2 pairs over 3 versions = 3 distinct snapshots fetched, 1 cache hit
		expect(api.getNodes).toHaveBeenCalledTimes(3);
		expect(result._meta.cache_hits).toBe(1);
		expect(result.entries).toHaveLength(2);
	});

	it("orders entries newest-first", async () => {
		const api = mockApi({
			versions: [
				version("v3", "c", "2026-03-01T00:00:00Z"),
				version("v2", "b", "2026-02-01T00:00:00Z"),
				version("v1", "a", "2026-01-01T00:00:00Z"),
			],
			snapshots: {
				v1: setNode(["A"]),
				v2: setNode(["A", "B"]),
				v3: setNode(["A", "B", "C"]),
			},
		});

		const result = await buildDesignHistory(api, "file1", [NODE_ID], { versions: 2 });
		expect(result.entries.map((e) => e.version_id)).toEqual(["v3", "v2"]);
	});

	it("reports the introduction of a component that did not exist in the older version", async () => {
		const api = mockApi({
			versions: [
				version("v2", "adds Button", "2026-02-01T00:00:00Z"),
				version("v1", "before Button", "2026-01-01T00:00:00Z"),
			],
			snapshots: { v1: null, v2: setNode(["Label"]) },
		});

		const result = await buildDesignHistory(api, "file1", [NODE_ID], { versions: 1 });
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].changes).toContain("Component introduced");
	});

	it("degrades to a note when version history is unreadable (missing scope)", async () => {
		const api = mockApi({
			versions: [],
			snapshots: {},
			versionsError: new Error("Figma API error: 403 Forbidden"),
		});

		const result = await buildDesignHistory(api, "file1", [NODE_ID]);

		expect(result.entries).toEqual([]);
		expect(result.notes.join(" ")).toContain("file_versions:read");
		expect(api.getNodes).not.toHaveBeenCalled();
	});

	it("degrades to a note when there is not enough version history at all", async () => {
		const api = mockApi({
			versions: [version("v1", "only version", "2026-01-01T00:00:00Z")],
			snapshots: { v1: setNode(["A"]) },
		});

		const result = await buildDesignHistory(api, "file1", [NODE_ID]);
		expect(result.entries).toEqual([]);
		expect(result.notes.join(" ")).toContain("Not enough version history");
	});

	// Real design-system files frequently have zero labeled versions (verified
	// live: 72 auto-saves, 0 labeled). Emitting nothing there would make the
	// feature look broken on its primary use case.
	it("falls back to auto-saves when the file has no labeled versions", async () => {
		const autosaves = [
			{ ...version("v3", "", "2026-03-01T00:00:00Z", "carol"), label: "" },
			{ ...version("v2", "", "2026-02-01T00:00:00Z", "bob"), label: "" },
		];
		const getFileVersions = jest.fn(async () => ({ versions: autosaves, pagination: {} }));
		const api = mockApi({
			versions: [],
			snapshots: { v2: setNode(["Label"]), v3: setNode(["Label", "Icon"]) },
		});
		api.getFileVersions = getFileVersions;

		const result = await buildDesignHistory(api, "file1", [NODE_ID], { versions: 2 });

		expect(result._meta.used_autosave_fallback).toBe(true);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].is_labeled).toBe(false);
		expect(result.notes.join(" ")).toContain("no labeled versions");
		expect(result.notes.join(" ")).toContain("Add label");
	});

	it("does not fall back when labeled versions are sufficient", async () => {
		const api = mockApi({
			versions: [
				version("v3", "labeled c", "2026-03-01T00:00:00Z"),
				version("v2", "labeled b", "2026-02-01T00:00:00Z"),
			],
			snapshots: { v2: setNode(["Label"]), v3: setNode(["Label", "Icon"]) },
		});

		const result = await buildDesignHistory(api, "file1", [NODE_ID], { versions: 2 });

		expect(result._meta.used_autosave_fallback).toBeUndefined();
		expect(api.getFileVersions).toHaveBeenCalledTimes(1);
		expect(result.notes.join(" ")).not.toContain("no labeled versions");
	});

	it("does not fall back when the caller already opted into auto-saves", async () => {
		const api = mockApi({
			versions: [version("v1", "", "2026-01-01T00:00:00Z")],
			snapshots: { v1: setNode(["A"]) },
		});

		const result = await buildDesignHistory(api, "file1", [NODE_ID], {
			includeAutosaves: true,
		});

		expect(api.getFileVersions).toHaveBeenCalledTimes(1);
		expect(result._meta.used_autosave_fallback).toBeUndefined();
	});

	it("always appends the coverage caveat so empty history is not read as 'no changes'", async () => {
		const api = mockApi({
			versions: [
				version("v2", "b", "2026-02-01T00:00:00Z"),
				version("v1", "a", "2026-01-01T00:00:00Z"),
			],
			snapshots: { v1: setNode(["A"]), v2: setNode(["A"]) },
		});

		const result = await buildDesignHistory(api, "file1", [NODE_ID], { versions: 1 });
		expect(result.entries).toEqual([]);
		expect(result.notes.join(" ")).toContain("omit description and Dev Mode annotation edits");
	});

	it("returns a note rather than throwing when no node IDs are given", async () => {
		const api = mockApi({ versions: [], snapshots: {} });
		const result = await buildDesignHistory(api, "file1", []);
		expect(result.entries).toEqual([]);
		expect(result.notes[0]).toContain("No node IDs");
		expect(api.getFileVersions).not.toHaveBeenCalled();
	});

	it("survives a per-pair fetch failure without losing other rows", async () => {
		const api = mockApi({
			versions: [
				version("v3", "c", "2026-03-01T00:00:00Z"),
				version("v2", "b", "2026-02-01T00:00:00Z"),
				version("v1", "a", "2026-01-01T00:00:00Z"),
			],
			snapshots: {
				v1: setNode(["A"]),
				v2: setNode(["A", "B"]),
				v3: setNode(["A", "B", "C"]),
			},
		});
		// Fail only the v3 snapshot fetch; the v2↔v1 pair should still produce a row.
		api.getNodes.mockImplementation(async (_f: string, ids: string[], o: any) => {
			if (o.version === "v3") throw new Error("network blip");
			const snaps: Record<string, any> = { v1: setNode(["A"]), v2: setNode(["A", "B"]) };
			return { nodes: { [ids[0]]: { document: snaps[o.version] } } };
		});

		const result = await buildDesignHistory(api, "file1", [NODE_ID], { versions: 2 });

		expect(result.entries.map((e) => e.version_id)).toEqual(["v2"]);
		expect(result.notes.join(" ")).toContain("network blip");
	});

	it("clamps the requested version count to the hard cap", async () => {
		const api = mockApi({ versions: [], snapshots: {} });
		await buildDesignHistory(api, "file1", [NODE_ID], { versions: 9999 });
		// Cap is 20 rows → 21 snapshots requested as the page limit.
		expect(api.getFileVersions).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// summarizeNodeDiff
// ---------------------------------------------------------------------------

function emptyDiff(overrides: Partial<NodeDiff> = {}): NodeDiff {
	return {
		node_id: NODE_ID,
		node_name: "Button",
		node_type: "COMPONENT_SET",
		name_changed: null,
		description_changed: null,
		children_added: [],
		children_removed: [],
		component_properties: null,
		binding_changes: [],
		change_count: 1,
		notes: [],
		...overrides,
	};
}

describe("summarizeNodeDiff", () => {
	it("describes renames", () => {
		const out = summarizeNodeDiff(emptyDiff({ name_changed: { from: "Btn", to: "Button" } }));
		expect(out).toEqual(["Renamed `Btn` → `Button`"]);
	});

	it("distinguishes description added / removed / updated", () => {
		expect(
			summarizeNodeDiff(emptyDiff({ description_changed: { from: "", to: "Hello" } })),
		).toEqual(["Description added"]);
		expect(
			summarizeNodeDiff(emptyDiff({ description_changed: { from: "Hello", to: "" } })),
		).toEqual(["Description removed"]);
		expect(
			summarizeNodeDiff(emptyDiff({ description_changed: { from: "Hi", to: "Hello" } }))[0],
		).toContain("Description updated");
	});

	it("truncates long child lists with an overflow marker", () => {
		const children = Array.from({ length: 8 }, (_, i) => ({
			id: `c${i}`,
			name: `Layer${i}`,
			type: "FRAME",
		}));
		const out = summarizeNodeDiff(emptyDiff({ children_added: children }));
		expect(out[0]).toContain("Added 8 layers");
		expect(out[0]).toContain("+3 more");
	});

	it("summarizes component property counts in standard mode", () => {
		const out = summarizeNodeDiff(
			emptyDiff({
				component_properties: {
					added: [{ name: "Disabled", type: "BOOLEAN", default_value: false }],
					removed: [],
					type_changed: [],
					default_changed: [],
					summary: { added: 1, removed: 0, type_changed: 0, default_changed: 0 },
				} as any,
			}),
		);
		expect(out).toEqual(["Component properties: 1 added"]);
	});

	it("names individual properties in detailed mode", () => {
		const out = summarizeNodeDiff(
			emptyDiff({
				component_properties: {
					added: [{ name: "Disabled", type: "BOOLEAN", default_value: false }],
					removed: [],
					type_changed: [],
					default_changed: [],
					summary: { added: 1, removed: 0, type_changed: 0, default_changed: 0 },
				} as any,
			}),
			"detailed",
		);
		expect(out).toEqual(["Property `Disabled` added (BOOLEAN)"]);
	});

	// Regression: live run against a 24-variant Button produced 44 near-identical
	// "Variable bound: <variant> `counterAxisSpacing`" lines in one table cell.
	it("collapses per-variant binding fan-out by property in detailed mode", () => {
		const bindings = Array.from({ length: 20 }, (_, i) => ({
			change_kind: "added",
			property: "counterAxisSpacing",
			node_id: `n${i}`,
			node_name: `variant=v${i}`,
		}));
		bindings.push({
			change_kind: "added",
			property: "paddingLeft",
			node_id: "p1",
			node_name: "variant=v1",
		});

		const out = summarizeNodeDiff(emptyDiff({ binding_changes: bindings as any }), "detailed");

		expect(out).toEqual([
			"Variable bound: `counterAxisSpacing` on 20 layers",
			"Variable bound: variant=v1 `paddingLeft`",
		]);
	});

	it("keeps the node name when only one layer is affected in detailed mode", () => {
		const out = summarizeNodeDiff(
			emptyDiff({
				binding_changes: [
					{ change_kind: "added", property: "strokes[0]", node_id: "b", node_name: "Button" },
				] as any,
			}),
			"detailed",
		);
		expect(out).toEqual(["Variable bound: Button `strokes[0]`"]);
	});

	it("separates bound / unbound / rebound when grouping", () => {
		const out = summarizeNodeDiff(
			emptyDiff({
				binding_changes: [
					{ change_kind: "added", property: "fills", node_id: "a", node_name: "A" },
					{ change_kind: "added", property: "fills", node_id: "b", node_name: "B" },
					{ change_kind: "removed", property: "fills", node_id: "c", node_name: "C" },
					{ change_kind: "removed", property: "fills", node_id: "d", node_name: "D" },
				] as any,
			}),
			"detailed",
		);
		expect(out).toEqual([
			"Variable bound: `fills` on 2 layers",
			"Variable unbound: `fills` on 2 layers",
		]);
	});

	it("caps bullets per entry and states how many were dropped", () => {
		// 20 distinct properties → 20 groups, above the 12-bullet cap.
		const bindings = Array.from({ length: 20 }, (_, i) => ({
			change_kind: "added",
			property: `prop${i}`,
			node_id: `n${i}`,
			node_name: `Layer${i}`,
		}));
		const out = summarizeNodeDiff(emptyDiff({ binding_changes: bindings as any }), "detailed");

		expect(out).toHaveLength(13); // 12 + the truncation marker
		expect(out[12]).toBe("…and 8 more changes");
	});

	it("does not truncate when the bullet count is at the cap", () => {
		const bindings = Array.from({ length: 12 }, (_, i) => ({
			change_kind: "added",
			property: `prop${i}`,
			node_id: `n${i}`,
			node_name: `Layer${i}`,
		}));
		const out = summarizeNodeDiff(emptyDiff({ binding_changes: bindings as any }), "detailed");
		expect(out).toHaveLength(12);
		expect(out.join(" ")).not.toContain("more change");
	});

	it("groups variable binding changes by kind in standard mode", () => {
		const out = summarizeNodeDiff(
			emptyDiff({
				binding_changes: [
					{ change_kind: "added", property: "fills", node_id: "a", node_name: "BG" },
					{ change_kind: "added", property: "strokes", node_id: "b", node_name: "Border" },
					{ change_kind: "rebound", property: "fills", node_id: "c", node_name: "Text" },
				] as any,
			}),
		);
		expect(out).toEqual(["Variable bindings: 2 added, 1 rebound"]);
	});
});
