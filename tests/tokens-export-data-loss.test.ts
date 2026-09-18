/**
 * figma_export_tokens must never silently destroy an existing token file.
 *
 * Reported against v1.40.1: with a different file focused in Figma Desktop
 * than the one owning the requested collection, the pull matched nothing, yet
 * the tool overwrote the real target file with a bare metadata stamp and
 * answered `success: true, warnings: []`. Investigating it also showed that
 * `strategy: "merge"` was documented as preserving code-only tokens but was
 * never implemented — every export was a blind overwrite.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	assertRequestedCollectionsFound,
	findUnmanagedTokenLoss,
	readSourceFileStamp,
	registerExportTokensTool,
	stampSourceFile,
} from "../src/core/tokens-tools";

// ---------------------------------------------------------------------------
// Two Figma files. "File A" owns Typography; "File B" is what's focused when
// things go wrong.
// ---------------------------------------------------------------------------
const FILE_A = {
	fileKey: "fileA",
	variableCollections: [
		{ id: "C:TYPO", name: "Typography", modes: [{ modeId: "m1", name: "Default" }], defaultModeId: "m1", variableIds: ["V:1", "V:2"] },
		{ id: "C:COLOR", name: "Color", modes: [{ modeId: "m1", name: "Default" }], defaultModeId: "m1", variableIds: ["V:3"] },
	],
	variables: [
		{ id: "V:1", name: "body", resolvedType: "FLOAT", variableCollectionId: "C:TYPO", valuesByMode: { m1: 16 } },
		{ id: "V:2", name: "caption", resolvedType: "FLOAT", variableCollectionId: "C:TYPO", valuesByMode: { m1: 12 } },
		{ id: "V:3", name: "gap", resolvedType: "FLOAT", variableCollectionId: "C:COLOR", valuesByMode: { m1: 4 } },
	],
};
const FILE_B = {
	fileKey: "fileB",
	variableCollections: [
		{ id: "C:OTHER", name: "Other", modes: [{ modeId: "m1", name: "Default" }], defaultModeId: "m1", variableIds: ["V:9"] },
	],
	variables: [
		{ id: "V:9", name: "x", resolvedType: "FLOAT", variableCollectionId: "C:OTHER", valuesByMode: { m1: 1 } },
	],
};
const FILE_NAMES: Record<string, string> = { fileA: "Design System", fileB: "Marketing Site" };

describe("figma_export_tokens — never silently destroys an existing file", () => {
	let tmp: string;
	let focused: any;
	let handler: (args: any) => Promise<any>;
	const parse = (res: any) => JSON.parse(res.content[0].text);

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "fcm-export-loss-"));
		focused = FILE_A;
		const server = { tool: (_n: string, _d: string, _s: any, h: any) => { handler = h; } };
		registerExportTokensTool(
			server as any,
			async () => ({ getVariablesFromPluginUI: async () => focused }),
			{ resolveFileName: (k) => FILE_NAMES[k] },
		);
	});
	afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

	/** Export Typography from File A into `target`, the way a healthy sync would. */
	async function seed(target: string, writtenFile: string = target) {
		focused = FILE_A;
		const res = await handler({ scope: "collection", collectionIds: ["C:TYPO"], format: "dtcg", outputPath: target });
		expect(res.isError).toBeFalsy();
		return readFileSync(writtenFile, "utf-8");
	}

	it("REPORTED BUG: wrong file focused → error, target byte-for-byte untouched (file target)", async () => {
		const target = join(tmp, "typography.tokens.json");
		const before = await seed(target);

		focused = FILE_B; // user switched tabs in Figma
		const res = await handler({ scope: "collection", collectionIds: ["C:TYPO"], format: "dtcg", outputPath: target, strategy: "merge" });

		expect(res.isError).toBe(true);
		const { error, hint } = parse(res);
		expect(error).toContain("not found in Figma file \"Marketing Site\" (fileB)");
		expect(error).toContain("C:TYPO");
		expect(error).toContain("Nothing was written");
		expect(error).toContain("Other [C:OTHER]"); // tells you what IS there
		expect(hint).toBeUndefined(); // no misleading "unsupported format" hint
		expect(readFileSync(target, "utf-8")).toBe(before);
	});

	it("same protection for a DIRECTORY target (this path predates 1.40.1)", async () => {
		const dir = join(tmp, "tokens");
		mkdirSync(dir);
		const file = join(dir, "tokens.tokens.json");
		const before = await seed(dir, file);

		focused = FILE_B;
		const res = await handler({ collectionIds: ["C:TYPO"], format: "dtcg", outputPath: dir });
		expect(res.isError).toBe(true);
		expect(readFileSync(file, "utf-8")).toBe(before);
	});

	it("a PARTIAL match is refused too — 1 of 2 collections is still data loss", async () => {
		const target = join(tmp, "all.tokens.json");
		focused = FILE_A;
		const res = await handler({ collectionIds: ["C:TYPO", "C:GONE"], format: "dtcg", outputPath: target });
		expect(res.isError).toBe(true);
		expect(parse(res).error).toContain("1 of 2 requested collection(s) not found");
	});

	it("wrong file focused with NO collectionIds → refuses to replace another file's tokens", async () => {
		const target = join(tmp, "tokens.tokens.json");
		focused = FILE_A;
		await handler({ format: "dtcg", outputPath: target });
		const before = readFileSync(target, "utf-8");

		focused = FILE_B;
		const res = await handler({ format: "dtcg", outputPath: target });
		expect(res.isError).toBe(true);
		expect(parse(res).error).toContain("was generated from Figma file fileA");
		expect(parse(res).error).toContain("\"Marketing Site\" (fileB)");
		expect(readFileSync(target, "utf-8")).toBe(before);
	});

	it("…and still refuses when the plugin can't report a file key (falls back to collection stamps)", async () => {
		const target = join(tmp, "tokens.tokens.json");
		const { fileKey: _a, ...anonA } = FILE_A;
		const { fileKey: _b, ...anonB } = FILE_B;
		focused = anonA;
		await handler({ format: "dtcg", outputPath: target });
		const before = readFileSync(target, "utf-8");

		focused = anonB;
		const res = await handler({ format: "dtcg", outputPath: target });
		expect(res.isError).toBe(true);
		expect(parse(res).error).toContain("from collections that are not part of this export");
		expect(parse(res).error).toContain("the file currently active in Figma");
		expect(readFileSync(target, "utf-8")).toBe(before);
	});

	it("refuses to wipe a hand-added token; strategy:'replace' is the explicit override", async () => {
		const target = join(tmp, "typography.tokens.json");
		const doc = JSON.parse(await seed(target));
		doc.typography.handAdded = { $value: 99, $type: "number" };
		const edited = JSON.stringify(doc, null, 2);
		writeFileSync(target, edited);

		const refused = await handler({ collectionIds: ["C:TYPO"], format: "dtcg", outputPath: target });
		expect(refused.isError).toBe(true);
		expect(parse(refused).error).toContain("typography.handAdded");
		expect(parse(refused).error).toContain("strategy: \"replace\"");
		expect(readFileSync(target, "utf-8")).toBe(edited);

		const forced = await handler({ collectionIds: ["C:TYPO"], format: "dtcg", outputPath: target, strategy: "replace" });
		expect(forced.isError).toBeFalsy();
		expect(readFileSync(target, "utf-8")).not.toContain("handAdded");
	});

	it("refuses a scoped export that would drop ANOTHER collection living in the same file", async () => {
		const target = join(tmp, "all.tokens.json");
		focused = FILE_A;
		await handler({ format: "dtcg", outputPath: target }); // Typography + Color
		const before = readFileSync(target, "utf-8");

		const res = await handler({ collectionIds: ["C:TYPO"], format: "dtcg", outputPath: target });
		expect(res.isError).toBe(true);
		expect(readFileSync(target, "utf-8")).toBe(before);
	});

	// --- found in review: the DTCG-only guard left every other format exposed ---

	for (const format of ["css-vars", "scss", "ts-module", "tailwind-v4", "tailwind-v3"]) {
		it(`REVIEW FINDING: ${format} output is not replaced by a different Figma file's tokens (no collectionIds)`, async () => {
			const dir = join(tmp, format);
			focused = FILE_A;
			const first = parse(await handler({ format, outputPath: dir }));
			const file = first.outputs[0].writtenTo;
			const before = readFileSync(file, "utf-8");
			expect(readSourceFileStamp(before)).toBe("fileA");

			focused = FILE_B; // wrong file, but NOT empty — plausible-looking garbage
			const res = await handler({ format, outputPath: dir });
			expect(res.isError).toBe(true);
			expect(parse(res).error).toContain("was generated from Figma file fileA");
			expect(parse(res).error).toContain("\"Marketing Site\" (fileB)");
			expect(readFileSync(file, "utf-8")).toBe(before);

			// the explicit override still works
			const forced = await handler({ format, outputPath: dir, strategy: "replace" });
			expect(forced.isError).toBeFalsy();
			expect(readSourceFileStamp(readFileSync(file, "utf-8"))).toBe("fileB");
		});
	}

	it("a multi-format run is all-or-nothing: one refused file blocks the unstampable JSON one too", async () => {
		const cfgDir = join(tmp, "proj");
		mkdirSync(cfgDir);
		const cfg = join(cfgDir, "tokens.config.json");
		writeFileSync(cfg, JSON.stringify({
			source: { dir: "tokens", canonical: "dtcg" },
			generated: { dir: "gen", formats: [{ format: "css-vars" }, { format: "json-flat" }] },
		}));
		focused = FILE_A;
		const ok = await handler({ configPath: cfg });
		expect(ok.isError).toBeFalsy();
		const flat = join(cfgDir, "gen", "tokens.flat.json");
		const before = readFileSync(flat, "utf-8");

		focused = FILE_B;
		const res = await handler({ configPath: cfg });
		expect(res.isError).toBe(true);
		expect(readFileSync(flat, "utf-8")).toBe(before);
	});

	it("an unstamped file from an older version is still overwritten (first run after upgrade)", async () => {
		const dir = join(tmp, "legacy");
		mkdirSync(dir);
		writeFileSync(join(dir, "tokens.css"), "/* Generated by figma-console-mcp — do not edit by hand */\n:root {\n  --old: 1;\n}\n");
		focused = FILE_A;
		const res = await handler({ format: "css-vars", outputPath: dir });
		expect(res.isError).toBeFalsy();
		expect(readSourceFileStamp(readFileSync(join(dir, "tokens.css"), "utf-8"))).toBe("fileA");
	});

	it("REVIEW FINDING: with splitByCollection, a token from another collection pasted into this file is protected", async () => {
		const dir = join(tmp, "split");
		focused = FILE_A;
		const first = parse(await handler({ format: "dtcg", outputPath: dir, splitByCollection: true }));
		const files: string[] = first.outputs.map((o: any) => o.writtenTo);
		expect(files.length).toBe(2);
		const typoFile = files.find((f) => /typo/i.test(f))!;
		const colorFile = files.find((f) => f !== typoFile)!;

		// hand-copy a Color-stamped token into the Typography file
		const typo = JSON.parse(readFileSync(typoFile, "utf-8"));
		const color = JSON.parse(readFileSync(colorFile, "utf-8"));
		const colorGroup = Object.keys(color).find((k) => !k.startsWith("$"))!;
		const typoGroup = Object.keys(typo).find((k) => !k.startsWith("$"))!;
		typo[typoGroup].borrowed = color[colorGroup].gap;
		const edited = JSON.stringify(typo, null, 2);
		writeFileSync(typoFile, edited);

		const res = await handler({ format: "dtcg", outputPath: dir, splitByCollection: true });
		expect(res.isError).toBe(true);
		expect(parse(res).error).toContain("borrowed");
		expect(readFileSync(typoFile, "utf-8")).toBe(edited);
	});

	it("deleting the LAST variable of a collection still syncs (its collection is exported, just empty)", async () => {
		const target = join(tmp, "all.tokens.json");
		focused = FILE_A;
		await handler({ format: "dtcg", outputPath: target });
		focused = { ...FILE_A, variables: FILE_A.variables.filter((v) => v.variableCollectionId !== "C:COLOR") };
		const res = await handler({ format: "dtcg", outputPath: target });
		expect(res.isError).toBeFalsy();
		expect(readFileSync(target, "utf-8")).not.toContain("\"gap\"");
	});

	// --- found in the SECOND review ------------------------------------------

	it("fails closed when the target records its source but the plugin can't report a file key", async () => {
		const dir = join(tmp, "css");
		focused = FILE_A;
		const first = parse(await handler({ format: "css-vars", outputPath: dir }));
		const file = first.outputs[0].writtenTo;
		const before = readFileSync(file, "utf-8");

		const { fileKey: _k, ...anonB } = FILE_B; // stale plugin: no fileKey
		focused = anonB;
		const res = await handler({ format: "css-vars", outputPath: dir });
		expect(res.isError).toBe(true);
		expect(parse(res).error).toContain("did not report which file");
		expect(readFileSync(file, "utf-8")).toBe(before);
	});

	it("a UTF-8 BOM on the existing file does not switch the guards off", async () => {
		const target = join(tmp, "typography.tokens.json");
		const withBom = "\uFEFF" + (await seed(target));
		writeFileSync(target, withBom);
		expect(readSourceFileStamp(withBom)).toBe("fileA");

		focused = FILE_B;
		const res = await handler({ format: "dtcg", outputPath: target });
		expect(res.isError).toBe(true);
		expect(readFileSync(target, "utf-8")).toBe(withBom);
	});

	it("refuses to bulldoze a DTCG file it cannot parse (merge-conflict markers)", async () => {
		const target = join(tmp, "typography.tokens.json");
		const conflicted = "<<<<<<< HEAD\n" + (await seed(target)) + "\n=======\n{}\n>>>>>>> theirs\n";
		writeFileSync(target, conflicted);

		const res = await handler({ collectionIds: ["C:TYPO"], format: "dtcg", outputPath: target });
		expect(res.isError).toBe(true);
		expect(parse(res).error).toContain("not valid JSON");
		expect(readFileSync(target, "utf-8")).toBe(conflicted);

		// an EMPTY placeholder file (touch typography.tokens.json) is fine to fill
		writeFileSync(target, "");
		expect((await handler({ collectionIds: ["C:TYPO"], format: "dtcg", outputPath: target })).isError).toBeFalsy();
	});

	it("splitByMode: a collection that LOSES a mode in Figma still syncs (no false refusal)", async () => {
		const dir = join(tmp, "modes");
		const twoModes = [{ modeId: "l", name: "Light" }, { modeId: "d", name: "Dark" }];
		const both = {
			fileKey: "fileA",
			variableCollections: [
				{ id: "C:X", name: "X", modes: twoModes, defaultModeId: "l", variableIds: ["V:x"] },
				{ id: "C:Y", name: "Y", modes: twoModes, defaultModeId: "l", variableIds: ["V:y"] },
			],
			variables: [
				{ id: "V:x", name: "x", resolvedType: "FLOAT", variableCollectionId: "C:X", valuesByMode: { l: 1, d: 2 } },
				{ id: "V:y", name: "y", resolvedType: "FLOAT", variableCollectionId: "C:Y", valuesByMode: { l: 3, d: 4 } },
			],
		};
		focused = both;
		const first = await handler({ format: "dtcg", outputPath: dir, splitByMode: true });
		expect(first.isError).toBeFalsy();

		// designer removes the Dark mode from collection X only
		focused = {
			...both,
			variableCollections: [
				{ ...both.variableCollections[0], modes: [twoModes[0]] },
				both.variableCollections[1],
			],
			variables: [
				{ ...both.variables[0], valuesByMode: { l: 1 } },
				both.variables[1],
			],
		};
		const res = await handler({ format: "dtcg", outputPath: dir, splitByMode: true });
		expect(res.isError).toBeFalsy();
	});

	it("never replaces a DTCG token file with a different KIND of output (css-vars → *.tokens.json)", async () => {
		const target = join(tmp, "typography.tokens.json");
		const before = await seed(target);

		const res = await handler({ collectionIds: ["C:TYPO"], format: "css-vars", outputPath: target });
		expect(res.isError).toBe(true);
		expect(parse(res).error).toContain("is a DTCG token file (2 tokens)");
		expect(readFileSync(target, "utf-8")).toBe(before);
	});

	// --- things that must KEEP working -------------------------------------

	it("still syncs normally: re-export is idempotent and a variable deleted in Figma is removed", async () => {
		const target = join(tmp, "typography.tokens.json");
		await seed(target);

		const again = await handler({ collectionIds: ["C:TYPO"], format: "dtcg", outputPath: target });
		expect(again.isError).toBeFalsy();

		focused = { ...FILE_A, variables: FILE_A.variables.filter((v) => v.id !== "V:2") }; // designer deleted "caption"
		const res = await handler({ collectionIds: ["C:TYPO"], format: "dtcg", outputPath: target });
		expect(res.isError).toBeFalsy();
		const after = readFileSync(target, "utf-8");
		expect(after).toContain("body");
		expect(after).not.toContain("caption");
	});

	it("reports the source file on every successful response", async () => {
		const body = parse(await handler({ format: "dtcg" }));
		expect(body.source).toEqual({ fileKey: "fileA", fileName: "Design System" });
	});

	it("an export with 0 tokens: refuses to write to disk, but only warns when returning inline", async () => {
		const target = join(tmp, "typography.tokens.json");
		const before = await seed(target);
		focused = { ...FILE_B, variables: [] }; // a file whose collections are empty

		const toDisk = await handler({ format: "dtcg", outputPath: target });
		expect(toDisk.isError).toBe(true);
		expect(parse(toDisk).error).toContain("contains 0 tokens");
		expect(readFileSync(target, "utf-8")).toBe(before);

		const inline = await handler({ format: "dtcg" });
		expect(inline.isError).toBeFalsy();
		expect(parse(inline).warnings.join(" ")).toContain("0 tokens");
	});

	it("dry-run surfaces the same refusal without touching disk", async () => {
		const target = join(tmp, "typography.tokens.json");
		const before = await seed(target);
		focused = FILE_B;
		const res = await handler({ collectionIds: ["C:TYPO"], format: "dtcg", outputPath: target, strategy: "dry-run" });
		expect(res.isError).toBe(true);
		expect(readFileSync(target, "utf-8")).toBe(before);
	});
});

describe("assertRequestedCollectionsFound", () => {
	const source = { fileKey: "k", fileName: "File" };
	it("passes when nothing specific was requested, or everything was found", () => {
		expect(() => assertRequestedCollectionsFound(undefined, [], source)).not.toThrow();
		expect(() => assertRequestedCollectionsFound([], [], source)).not.toThrow();
		expect(() => assertRequestedCollectionsFound(["a"], [{ id: "a", name: "A" }], source)).not.toThrow();
	});
	it("says so plainly when the file has no collections at all", () => {
		expect(() => assertRequestedCollectionsFound(["a"], [], source)).toThrow(/has no variable collections/);
	});
});

describe("findUnmanagedTokenLoss", () => {
	const stamp = (variableId: string, collectionId: string) => ({ "figma-console-mcp": { variableId, collectionId } });
	const tok = (ext?: any) => ({ $value: 1, $type: "number", ...(ext ? { $extensions: ext } : {}) });
	const J = (o: any) => JSON.stringify(o);

	it("allows dropping a managed token (deleted in Figma)", () => {
		const before = J({ g: { a: tok(stamp("V:1", "C:1")), b: tok(stamp("V:2", "C:1")) } });
		const after = J({ g: { a: tok(stamp("V:1", "C:1")) } });
		expect(findUnmanagedTokenLoss(before, after, new Set(["C:1"]))).toBeNull();
	});

	it("flags code-only tokens and other collections separately", () => {
		const before = J({ g: { a: tok(stamp("V:1", "C:1")), mine: tok(), theirs: tok(stamp("V:7", "C:2")) } });
		const after = J({ g: { a: tok(stamp("V:1", "C:1")) } });
		expect(findUnmanagedTokenLoss(before, after, new Set(["C:1"]))).toEqual({
			codeOnly: ["g.mine"],
			otherCollections: ["g.theirs"],
		});
	});

	it("ignores files that are not DTCG JSON (generated CSS etc.) and files with no tokens", () => {
		expect(findUnmanagedTokenLoss(":root{--a:1}", ":root{}", new Set())).toBeNull();
		expect(findUnmanagedTokenLoss(J({ stale: true }), J({}), new Set())).toBeNull();
	});

	it("keeps a preserved token out of the loss list", () => {
		const before = J({ g: { mine: tok() } });
		expect(findUnmanagedTokenLoss(before, before, new Set())).toBeNull();
	});
});

describe("source-file stamps", () => {
	it("round-trips through every comment style and leaves unknown content alone", () => {
		const css = "/* Generated by figma-console-mcp — do not edit by hand */\n:root {}";
		const scss = "// Generated by figma-console-mcp — do not edit by hand\n$a: 1;";
		const ts = "/**\n * Generated by figma-console-mcp — do not edit by hand.\n */\nexport const t = {};";
		for (const src of [css, scss, ts]) {
			const out = stampSourceFile(src, "abc123");
			expect(readSourceFileStamp(out)).toBe("abc123");
			expect(out.split("\n").length).toBe(src.split("\n").length + 1);
		}
		expect(stampSourceFile("{\"a\":1}", "abc123")).toBe("{\"a\":1}"); // JSON stays valid
		expect(stampSourceFile(css, null)).toBe(css);
	});

	it("reads the DTCG root stamp, and never trusts a 'Source:' line outside our header", () => {
		expect(readSourceFileStamp(JSON.stringify({ $extensions: { "figma-console-mcp": { figmaFileKey: "k1" } } }))).toBe("k1");
		expect(readSourceFileStamp("/* my file */\n/* Source: Figma file zzz */")).toBeNull();
		expect(readSourceFileStamp(":root{}")).toBeNull();
	});
});
