/**
 * Extended variable collections (Figma collection extensions).
 *
 * Reported 2026-09-23: "When extending collections in Figma and assigning
 * collection-level overrides, the console MCP frequently has a very difficult
 * time seeing them, almost always claiming no override exists."
 *
 * Root cause: an extended collection keeps its overrides ON THE COLLECTION
 * (`variableOverrides[variableId][extendedModeId]`); its variables keep the
 * parent's id and `variableCollectionId`, and `variable.valuesByMode` holds only
 * the root collection's modes. Every tool read valuesByMode grouped by
 * variableCollectionId — so an extended collection looked empty.
 */

import { registerFigmaAPITools } from "../src/core/figma-tools";
import {
	annotateVariableOverrides,
	extendedCollectionView,
	mergeExtendedCollections,
	resolveValueInCollection,
	unwrapExtendedCollectionsResult,
} from "../src/core/extended-collections";

const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const RED = { r: 1, g: 0, b: 0, a: 1 };

/** Base "Brand" (Light/Dark) → extension "Brand B" → extension "Brand B Holiday" */
function fixture() {
	const variables = [
		{ id: "v-bg", name: "color/bg", resolvedType: "COLOR", variableCollectionId: "c-brand", valuesByMode: { light: WHITE, dark: BLACK } },
		{ id: "v-pad", name: "space/pad", resolvedType: "FLOAT", variableCollectionId: "c-brand", valuesByMode: { light: 8, dark: 8 } },
		{ id: "v-flag", name: "feature/on", resolvedType: "BOOLEAN", variableCollectionId: "c-brand", valuesByMode: { light: true, dark: true } },
	];
	// What the plugin's cached payload lists today: the extensions appear, but
	// with none of their extension data.
	const variableCollections = [
		{ id: "c-brand", name: "Brand", modes: [{ modeId: "light", name: "Light" }, { modeId: "dark", name: "Dark" }], defaultModeId: "light", variableIds: ["v-bg", "v-pad", "v-flag"] },
		{ id: "c-b", name: "Brand B", modes: [{ modeId: "b-light", name: "Light" }, { modeId: "b-dark", name: "Dark" }], defaultModeId: "b-light", variableIds: ["v-bg", "v-pad", "v-flag"] },
		{ id: "c-bh", name: "Brand B Holiday", modes: [{ modeId: "h-light", name: "Light" }, { modeId: "h-dark", name: "Dark" }], defaultModeId: "h-light", variableIds: ["v-bg", "v-pad", "v-flag"] },
	];
	// What the Plugin API reports for the two extended collections
	const extensions = [
		{
			id: "c-b", name: "Brand B", isExtension: true as const, parentVariableCollectionId: "c-brand", rootVariableCollectionId: "c-brand", defaultModeId: "b-light",
			modes: [{ modeId: "b-light", name: "Light", parentModeId: "light" }, { modeId: "b-dark", name: "Dark", parentModeId: "dark" }],
			variableIds: ["v-bg", "v-pad", "v-flag"],
			// falsy overrides on purpose: 0 and false are real values
			variableOverrides: { "v-bg": { "b-light": RED }, "v-pad": { "b-dark": 0 }, "v-flag": { "b-light": false } },
		},
		{
			id: "c-bh", name: "Brand B Holiday", isExtension: true as const, parentVariableCollectionId: "c-b", rootVariableCollectionId: "c-brand", defaultModeId: "h-light",
			modes: [{ modeId: "h-light", name: "Light", parentModeId: "b-light" }, { modeId: "h-dark", name: "Dark", parentModeId: "b-dark" }],
			variableIds: ["v-bg", "v-pad", "v-flag"],
			variableOverrides: { "v-pad": { "h-light": 24 } },
		},
	];
	return { variables, variableCollections, extensions };
}

function merged() {
	const f = fixture();
	const data = { variables: f.variables, variableCollections: f.variableCollections };
	mergeExtendedCollections(data, f.extensions);
	return data;
}

describe("resolveValueInCollection — values through the extension chain", () => {
	const data = merged();
	const at = (c: string, v: string, m: string) => resolveValueInCollection(data, c, v, m);

	it("returns an extension's own override, and says it is one", () => {
		expect(at("c-b", "v-bg", "b-light")).toEqual({ value: RED, overriddenIn: "c-b" });
	});

	it("inherits the parent's value for modes it does not override", () => {
		expect(at("c-b", "v-bg", "b-dark")).toEqual({ value: BLACK, overriddenIn: null });
	});

	it("treats 0 and false as real overrides — never as 'missing'", () => {
		expect(at("c-b", "v-pad", "b-dark")).toEqual({ value: 0, overriddenIn: "c-b" });
		expect(at("c-b", "v-flag", "b-light")).toEqual({ value: false, overriddenIn: "c-b" });
	});

	it("follows a two-level chain: own override, then parent's override, then root", () => {
		expect(at("c-bh", "v-pad", "h-light")).toEqual({ value: 24, overriddenIn: "c-bh" });
		expect(at("c-bh", "v-pad", "h-dark")).toEqual({ value: 0, overriddenIn: "c-b" });
		expect(at("c-bh", "v-bg", "h-light")).toEqual({ value: RED, overriddenIn: "c-b" });
		expect(at("c-bh", "v-bg", "h-dark")).toEqual({ value: BLACK, overriddenIn: null });
	});

	it("returns undefined for unknown modes rather than inventing a value", () => {
		expect(at("c-b", "v-bg", "no-such-mode")).toBeUndefined();
	});
});

describe("extendedCollectionView — variables as they appear in the extension", () => {
	it("keeps the real variable id, keys values by the extension's modes, and marks overrides", () => {
		const data = merged();
		const view = extendedCollectionView(data, data.variableCollections.find((c: any) => c.id === "c-bh"));
		const pad = view.find((v) => v.id === "v-pad")!;
		expect(pad).toMatchObject({
			id: "v-pad",
			variableCollectionId: "c-bh",
			definedInCollectionId: "c-brand",
			valuesByMode: { "h-light": 24, "h-dark": 0 },
			overriddenModeIds: ["h-light"], // h-dark is inherited (from Brand B)
		});
		expect(view.find((v) => v.id === "v-bg")!.overriddenModeIds).toEqual([]);
	});
});

describe("unwrapExtendedCollectionsResult", () => {
	it("unwraps the bridge's EXECUTE_CODE envelope(s)", () => {
		const arr = [{ id: "x" }];
		expect(unwrapExtendedCollectionsResult(arr)).toBe(arr);
		expect(unwrapExtendedCollectionsResult({ success: true, result: arr })).toBe(arr);
		expect(unwrapExtendedCollectionsResult({ success: true, result: { success: true, result: arr } })).toBe(arr);
		expect(unwrapExtendedCollectionsResult({ success: true, result: null })).toBeNull();
	});
});

describe("annotateVariableOverrides", () => {
	it("lists every extension's overrides on the variable, with mode names", () => {
		const data = merged();
		annotateVariableOverrides(data);
		const pad = data.variables.find((v: any) => v.id === "v-pad") as any;
		expect(pad.extendedCollectionOverrides).toEqual([
			{ collectionId: "c-b", collectionName: "Brand B", overrides: [{ modeId: "b-dark", modeName: "Dark", value: 0 }] },
			{ collectionId: "c-bh", collectionName: "Brand B Holiday", overrides: [{ modeId: "h-light", modeName: "Light", value: 24 }] },
		]);
		// the base value map is untouched — id-keyed consumers are unaffected
		expect(pad.valuesByMode).toEqual({ light: 8, dark: 8 });
	});
});

// --------------------------------------------------------------------------
// End to end through figma_get_variables — what an agent actually sees
// --------------------------------------------------------------------------

function setup(opts: { executeFails?: boolean } = {}) {
	const f = fixture();
	const tools: Record<string, any> = {};
	const server = { tool: (name: string, ...rest: any[]) => { tools[name] = rest[rest.length - 1]; } };
	const connector = {
		getTransportType: () => "websocket",
		getVariablesFromPluginUI: jest.fn(async () => ({ success: true, variables: JSON.parse(JSON.stringify(f.variables)), variableCollections: JSON.parse(JSON.stringify(f.variableCollections)) })),
		getVariables: jest.fn(),
		executeCodeViaUI: jest.fn(async () => {
			if (opts.executeFails) throw new Error("Plugin timed out");
			return { success: true, result: f.extensions };
		}),
	};
	registerFigmaAPITools(server as any, async () => ({}) as any, () => "https://www.figma.com/design/abc123/File", new Map(), undefined, async () => connector as any);
	const run = async (args: any) => {
		const res = await tools.figma_get_variables({ includePublished: false, enrich: false, ...args });
		const body = JSON.parse(res.content[0].text);
		return body.data ?? body;
	};
	return { run, connector };
}

describe("figma_get_variables — extended collections are visible", () => {
	it("summary names each extension, its parent, and how many values it overrides", async () => {
		const { run } = setup();
		const s = await run({ format: "summary" });
		const b = s.collections.find((c: any) => c.name === "Brand B");
		expect(b).toMatchObject({ isExtension: true, extends: "Brand", overridden_variables: 3, overridden_values: 3 });
		expect(s.collections.find((c: any) => c.name === "Brand B Holiday")).toMatchObject({ extends: "Brand B", overridden_values: 1 });
		expect(s.overview.extended_collections).toBe(2);
	});

	it("REPORTED BUG: filtering by the extended collection returns its variables and overrides (was: nothing)", async () => {
		const { run } = setup();
		const r = await run({ format: "filtered", collection: "Brand B Holiday", verbosity: "standard" });
		const pad = r.variables.find((v: any) => v.id === "v-pad");
		expect(pad.valuesByMode).toEqual({ "h-light": 24, "h-dark": 0 });
		expect(pad.overriddenModeIds).toEqual(["h-light"]);
		expect(pad.definedInCollectionId).toBe("c-brand");
		expect(r.variableCollections.map((c: any) => c.name)).toContain("Brand B Holiday");
	});

	it("the mode filter keeps variables whose value in that mode is 0 or false", async () => {
		const { run } = setup();
		const r = await run({ format: "filtered", collection: "c-b", mode: "Dark", verbosity: "standard" });
		const ids = r.variables.map((v: any) => v.id).sort();
		expect(ids).toEqual(["v-bg", "v-flag", "v-pad"]);
		expect(r.variables.find((v: any) => v.id === "v-pad").valuesByMode).toEqual({ "b-dark": 0 });
	});

	it("full format shows each variable's overrides where an agent looks for them", async () => {
		const { run } = setup();
		const r = await run({ format: "full" });
		const bg = r.variables.find((v: any) => v.id === "v-bg");
		expect(bg.extendedCollectionOverrides).toEqual([
			{ collectionId: "c-b", collectionName: "Brand B", overrides: [{ modeId: "b-light", modeName: "Light", value: RED }] },
		]);
		// base collection data is unchanged
		expect(bg.valuesByMode).toEqual({ light: WHITE, dark: BLACK });
		expect(r.variables).toHaveLength(3); // no duplicate "view" variables in the base data
	});

	it("says so when extension data could not be read, instead of implying there are no overrides", async () => {
		const { run } = setup({ executeFails: true });
		const s = await run({ format: "summary" });
		expect(s.warnings?.[0]).toMatch(/Could not read extended collections: .*Plugin timed out.*may be missing/);
	});

	it("a file without extensions is unchanged", async () => {
		const { run, connector } = setup();
		connector.executeCodeViaUI.mockResolvedValueOnce({ success: true, result: [] });
		const s = await run({ format: "summary" });
		expect(s.overview.extended_collections).toBeUndefined();
		expect(s.warnings).toBeUndefined();
	});
});

// --------------------------------------------------------------------------
// figma_export_tokens — explicit about extended collections
// --------------------------------------------------------------------------

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerExportTokensTool } from "../src/core/tokens-tools";

describe("figma_export_tokens — extended collections", () => {
	let tmp: string;
	let handler: (args: any) => Promise<any>;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "fcm-ext-export-"));
		const f = fixture();
		const connector = {
			getVariablesFromPluginUI: async () => ({ fileKey: "fileA", variables: JSON.parse(JSON.stringify(f.variables)), variableCollections: JSON.parse(JSON.stringify(f.variableCollections)) }),
			executeCodeViaUI: async () => ({ success: true, result: f.extensions }),
		};
		registerExportTokensTool({ tool: (_n: string, _d: string, _s: any, h: any) => { handler = h; } } as any, async () => connector);
	});
	afterEach(() => rmSync(tmp, { recursive: true, force: true }));
	const parse = (r: any) => JSON.parse(r.content[0].text);

	it("refuses to export an extended collection by id — with a message that points at the real answer", async () => {
		const target = join(tmp, "brand-b.tokens.json");
		const res = await handler({ collectionIds: ["c-b"], format: "dtcg", outputPath: target });
		expect(res.isError).toBe(true);
		const { error } = parse(res);
		expect(error).toContain('"Brand B" (c-b) is an extended collection');
		expect(error).toContain('figma_get_variables with collection="Brand B"');
		expect(error).not.toMatch(/0 tokens|active in Figma/); // not the misleading wrong-file diagnosis
		expect(existsSync(target)).toBe(false);
	});

	it("exports the base collection, leaves extensions out, and says so (no empty sets)", async () => {
		const body = parse(await handler({ format: "dtcg" }));
		expect(body.collections.map((c: any) => c.name)).toEqual(["Brand"]);
		expect(body.warnings.join("\n")).toContain('Extended collection "Brand B" was not exported (3 overridden values across 3 variables)');
		expect(body.warnings.join("\n")).toContain('Extended collection "Brand B Holiday" was not exported (1 overridden value across 1 variable)');
	});
});
