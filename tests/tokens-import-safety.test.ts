/**
 * figma_import_tokens / figma_export_tokens safety regressions.
 *
 *  #122 — a configPath import whose source dir held `tokens.json` (default
 *         pattern is `*.tokens.json`) parsed 0 files, returned success, and
 *         planned to delete every variable; `replace` would have done it.
 *  #122 — replace with token files covering only some collections must not
 *         delete variables in the collections it doesn't cover.
 *  #91  — import/export read the plugin's load-time snapshot, so renames
 *         made in Figma afterwards were invisible (export emitted old names;
 *         import diffed against stale state).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerExportTokensTool, registerImportTokensTool } from "../src/core/tokens-tools.js";

function state(names: { primary: string } = { primary: "color/primary" }) {
	return {
		success: true,
		variableCollections: [
			{ id: "C:1", name: "Theme", modes: [{ modeId: "m1", name: "Default" }], variableIds: ["V:1", "V:2"] },
			{ id: "C:2", name: "Spacing", modes: [{ modeId: "s1", name: "Default" }], variableIds: ["V:3"] },
		],
		variables: [
			{ id: "V:1", name: names.primary, resolvedType: "COLOR", variableCollectionId: "C:1", valuesByMode: { m1: { r: 1, g: 0, b: 0, a: 1 } } },
			{ id: "V:2", name: "color/accent", resolvedType: "COLOR", variableCollectionId: "C:1", valuesByMode: { m1: { r: 0, g: 1, b: 0, a: 1 } } },
			{ id: "V:3", name: "space/4", resolvedType: "FLOAT", variableCollectionId: "C:2", valuesByMode: { s1: 4 } },
		],
	};
}

function connector(live: any, snapshot: any = live) {
	const deletes: string[] = [];
	const scripts: string[] = [];
	return {
		deletes,
		scripts,
		getVariables: async () => ({ success: true, result: live }),
		getVariablesFromPluginUI: async () => snapshot,
		executeCodeViaUI: async (script: string) => {
			scripts.push(script);
			return { success: true, result: { applied: 0, failed: 0, results: [], created: 0, createdIds: {}, createdCollections: [], aliasFailures: [] } };
		},
		deleteVariable: async (id: string) => {
			deletes.push(id);
			return { success: true };
		},
	};
}

function importHandler(conn: any, isRemoteMode: boolean) {
	let h: any;
	registerImportTokensTool({ tool: (_n: string, _d: string, _s: any, cb: any) => { h = cb; } } as any, async () => conn, { isRemoteMode });
	return h;
}

const text = (res: any) => res.content[0].text as string;

describe("#122 configPath import that finds no token files", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fcm-import-safety-"));
		mkdirSync(join(root, "tokens"));
		writeFileSync(
			join(root, "tokens.config.json"),
			JSON.stringify({ source: { dir: "tokens", canonical: "dtcg" }, generated: { dir: "generated", formats: [{ format: "css-vars" }] } }),
		);
		writeFileSync(join(root, "tokens", "tokens.json"), JSON.stringify({ Theme: { color: { primary: { $type: "color", $value: "#FF0000" } } } }));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it.each(["dry-run", "merge", "replace"])("refuses under strategy %s and changes nothing", async (strategy) => {
		const conn = connector(state());
		const res = await importHandler(conn, false)({ configPath: join(root, "tokens.config.json"), strategy });
		expect(res.isError).toBe(true);
		expect(text(res)).toContain("Nothing was imported or changed");
		expect(text(res)).toContain("tokens.json");
		expect(conn.deletes).toEqual([]);
		expect(conn.scripts).toEqual([]);
	});

	it("reads the file once source.pattern matches it", async () => {
		writeFileSync(
			join(root, "tokens.config.json"),
			JSON.stringify({ source: { dir: "tokens", canonical: "dtcg", pattern: "*.json" }, generated: { dir: "generated", formats: [{ format: "css-vars" }] } }),
		);
		const res = await importHandler(connector(state()), false)({ configPath: join(root, "tokens.config.json"), strategy: "dry-run" });
		expect(res.isError).toBeFalsy();
		expect(JSON.parse(text(res)).parsedTokenCount).toBe(1);
	});
});

describe("#122 imports that parse no tokens", () => {
	it("refuses an empty payload instead of planning to delete everything", async () => {
		const conn = connector(state());
		const res = await importHandler(conn, true)({ payload: "{}", format: "dtcg", strategy: "replace" });
		expect(res.isError).toBe(true);
		expect(text(res)).toContain("produced 0 tokens");
		expect(conn.deletes).toEqual([]);
	});
});

describe("#122 replace only deletes inside the collections being imported", () => {
	it("deletes the Theme variable missing from the file but leaves Spacing alone", async () => {
		const conn = connector(state());
		const payload = JSON.stringify({ Theme: { color: { primary: { $type: "color", $value: "#FF0000" } } } });
		const res = await importHandler(conn, true)({ payload, strategy: "replace" });
		const body = JSON.parse(text(res));
		expect(conn.deletes).toEqual(["V:2"]);
		expect(body.diff.summary.toDelete).toBe(1);
		expect(body.warnings.some((w: string) => w.includes("Spacing") && w.includes("left alone"))).toBe(true);
	});
});

describe("#91 token tools read live Figma state, not the load-time snapshot", () => {
	const renamed = state({ primary: "color/brand" });
	const stale = state();

	it("import diffs against the live names (a Figma-side rename is not a delete)", async () => {
		const conn = connector(renamed, stale);
		const payload = JSON.stringify({ Theme: { color: { brand: { $type: "color", $value: "#FF0000" }, accent: { $type: "color", $value: "#00FF00" } } } });
		const res = await importHandler(conn, true)({ payload, strategy: "replace" });
		const body = JSON.parse(text(res));
		expect(body.diff.summary.toDelete).toBe(0);
		expect(body.diff.summary.toCreate).toBe(0);
		expect(conn.deletes).toEqual([]);
	});

	it("export emits the live name", async () => {
		let h: any;
		registerExportTokensTool({ tool: (_n: string, _d: string, _s: any, cb: any) => { h = cb; } } as any, async () => connector(renamed, stale) as any, {});
		const res = await h({ scope: "collection", collectionIds: ["C:1"], format: "dtcg" });
		expect(res.isError).toBeFalsy();
		expect(text(res)).toContain("brand");
		expect(text(res)).not.toContain("primary");
	});

	it("export falls back to the snapshot with a warning when the live read fails", async () => {
		let h: any;
		const conn = { ...connector(stale), getVariables: async () => { throw new Error("timeout"); } };
		registerExportTokensTool({ tool: (_n: string, _d: string, _s: any, cb: any) => { h = cb; } } as any, async () => conn as any, {});
		const res = await h({ scope: "collection", collectionIds: ["C:1"], format: "dtcg" });
		expect(res.isError).toBeFalsy();
		expect(text(res)).toContain("snapshot taken when it opened");
	});
});
