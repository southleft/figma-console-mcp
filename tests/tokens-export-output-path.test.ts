/**
 * figma_export_tokens — outputPath handling.
 *
 * Reported against v1.40.0: outputPath was unconditionally treated as a
 * directory, so pointing it at an existing `typography.tokens.json` died with a
 * raw `EEXIST: mkdir`, and a fresh `foo.tokens.json` silently became a
 * DIRECTORY containing `tokens.tokens.json`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planExportWrites, registerExportTokensTool } from "../src/core/tokens-tools";

const one = [{ format: "dtcg", path: "tokens.tokens.json", content: "{\"a\":1}" }];
const many = [
	{ format: "dtcg", path: "typography.tokens.json", content: "{}" },
	{ format: "dtcg", path: "colors.tokens.json", content: "{}" },
];

describe("planExportWrites", () => {
	let tmp: string;
	beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "fcm-export-path-")); });
	afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

	it("writes a single-file export at exactly an existing file's path", () => {
		const target = join(tmp, "typography.tokens.json");
		writeFileSync(target, "old");
		const plan = planExportWrites(one, target, null);
		expect(plan.writes.map((w) => w.fullPath)).toEqual([target]);
		expect(plan.warnings).toEqual([]);
	});

	it("treats a fresh path with a token-file extension as a file, not a directory", () => {
		const target = join(tmp, "typography-test-fresh.tokens.json");
		const plan = planExportWrites(one, target, null);
		expect(plan.writes[0].fullPath).toBe(target);
	});

	it("rejects a file target for a multi-file export with an actionable message — before writing", () => {
		const target = join(tmp, "typography.tokens.json");
		writeFileSync(target, "old");
		expect(() => planExportWrites(many, target, null)).toThrow(/is an existing file, but this export produces 2 files/);
		expect(() => planExportWrites(many, target, null)).toThrow(/DIRECTORY/);
		expect(() => planExportWrites(many, join(tmp, "new.tokens.json"), null)).toThrow(/looks like a file path/);
		expect(readFileSync(target, "utf-8")).toBe("old");
	});

	it("keeps directory behavior for directories, extension-less paths, and trailing slashes", () => {
		const dir = join(tmp, "out");
		expect(planExportWrites(many, dir, null).writes.map((w) => w.fullPath)).toEqual([
			join(dir, "typography.tokens.json"),
			join(dir, "colors.tokens.json"),
		]);
		// an existing directory wins even when its name looks like a file
		const oddDir = join(tmp, "legacy.json");
		mkdirSync(oddDir);
		expect(planExportWrites(one, oddDir, null).writes[0].fullPath).toBe(join(oddDir, "tokens.tokens.json"));
		// explicit trailing separator forces directory handling
		const forced = join(tmp, "forced.json");
		expect(planExportWrites(one, `${forced}/`, null).writes[0].fullPath).toBe(join(forced, "tokens.tokens.json"));
	});

	it("warns when the requested extension doesn't match the format", () => {
		const css = [{ format: "css-vars", path: "tokens.css", content: ":root{}" }];
		const plan = planExportWrites(css, join(tmp, "typography.tokens.json"), null);
		expect(plan.warnings[0]).toMatch(/ends in \.json but the css-vars format produces \.css/);
	});

	it("returns no writes (inline mode) without outputPath or config", () => {
		expect(planExportWrites(one, undefined, null).writes).toEqual([]);
	});
});

describe("figma_export_tokens handler — end to end", () => {
	let tmp: string;
	let handler: (args: any) => Promise<any>;

	const connector = {
		getVariablesFromPluginUI: async () => ({
			variableCollections: [
				{ id: "C:1", name: "Typography", modes: [{ modeId: "m1", name: "Default" }], defaultModeId: "m1", variableIds: ["V:1"] },
			],
			variables: [
				{ id: "V:1", name: "font/size/body", resolvedType: "FLOAT", variableCollectionId: "C:1", valuesByMode: { m1: 16 } },
			],
		}),
	};

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "fcm-export-e2e-"));
		const server = { tool: (_n: string, _d: string, _s: any, h: any) => { handler = h; } };
		registerExportTokensTool(server as any, async () => connector);
	});
	afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

	const parse = (res: any) => JSON.parse(res.content[0].text);

	it("re-exports a collection into an existing per-topic token file", async () => {
		const target = join(tmp, "typography.tokens.json");
		writeFileSync(target, "{\"stale\":true}");

		const res = await handler({ scope: "collection", collectionIds: ["C:1"], format: "dtcg", outputPath: target });
		const body = parse(res);

		expect(res.isError).toBeFalsy();
		expect(body.outputs).toEqual([{ writtenTo: target }]);
		expect(statSync(target).isFile()).toBe(true);
		expect(readFileSync(target, "utf-8")).not.toContain("stale");
		expect(readFileSync(target, "utf-8")).toContain("body");
	});

	it("never turns a fresh *.tokens.json path into a directory", async () => {
		const target = join(tmp, "typography-test-fresh.tokens.json");
		await handler({ scope: "collection", collectionIds: ["C:1"], format: "dtcg", outputPath: target });
		expect(statSync(target).isFile()).toBe(true);
		expect(existsSync(join(target, "tokens.tokens.json"))).toBe(false);
	});

	it("previews the resolved destination on dry-run without writing", async () => {
		const target = join(tmp, "typography.tokens.json");
		const body = parse(await handler({ format: "dtcg", outputPath: target, strategy: "dry-run" }));
		expect(body.outputs[0].wouldWriteTo).toBe(target);
		expect(existsSync(target)).toBe(false);
	});
});
