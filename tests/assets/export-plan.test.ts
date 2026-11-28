/**
 * Pure planning for figma_export_assets (spec §3.2–§3.4, §8.1 "assets-export"):
 * validation, Export-settings precedence, file-name templates and collisions,
 * the raster pre-check, inline budgets, type sniffing and REST grouping.
 */

import {
	CLOUD_WRITE_MESSAGE,
	type ExportAssetsArgs,
	type ExportPreflight,
	FileNameRegistry,
	InlineBudget,
	type PlannedAsset,
	compileFileName,
	decodeBase64,
	expandFileName,
	groupForRest,
	normalizeExportArgs,
	planExport,
	rasterCheck,
	rasterSize,
	restOptionsFor,
	safeSegment,
	safeSuffix,
	sniffImage,
	validateExportArgs,
} from "../../src/core/assets/export-plan";
import { EXPORT_ASSETS_SCHEMA } from "../../src/core/asset-export-tools";
import { gifBytes, jpegBytes, pngBytes, webpBytes } from "./export-fake";

const local = { hasFs: true, remote: false };
const cloud = { hasFs: false, remote: true };
const validate = (a: ExportAssetsArgs, ctx = local) => validateExportArgs(normalizeExportArgs(a, { hasFs: ctx.hasFs }), ctx);

function pre(nodes: Array<Partial<ExportPreflight["nodes"][number]> & { id: string }>, extra: Partial<ExportPreflight> = {}): ExportPreflight {
	return {
		fileKey: "FILE",
		nodes: nodes.map((n) => ({ name: n.id, type: "FRAME", width: 100, height: 50, renderW: 100, renderH: 50, exportSettings: [], ...n })),
		missing: [],
		unsupported: [],
		vectors: [],
		vectorTotal: 0,
		images: [],
		imageTotal: 0,
		scanned: 0,
		scanTruncated: false,
		...extra,
	};
}
const parts = (t = "{name}") => {
	const c = compileFileName(t);
	if (!c.ok) throw new Error(c.error);
	return c.parts;
};
const plan = (a: ExportAssetsArgs, p: ExportPreflight, t?: string) => planExport(normalizeExportArgs({ fileName: t, ...a }, { hasFs: true }), p, parts(a.fileName ?? t));

describe("validation (§3.2)", () => {
	it("scale/width/height are exclusive", () => {
		expect(validate({ scale: 2, width: 100 }).error).toBe("Use scale, width or height, not several.");
		expect(validate({ width: 100, height: 100 }).error).toBe("Use scale, width or height, not several.");
		expect(validate({ scale: 2 }).error).toBeUndefined();
	});

	it("Cloud rejects files, outputDir, overwrite and fileKey, and defaults to inline", () => {
		expect(validate({ output: "files" }, cloud).error).toBe(CLOUD_WRITE_MESSAGE);
		expect(validate({ outputDir: "/tmp/x" }, cloud).error).toBe(CLOUD_WRITE_MESSAGE);
		expect(validate({ overwrite: true }, cloud).error).toBe(CLOUD_WRITE_MESSAGE);
		expect(validate({ fileKey: "abc" }, cloud).error).toMatch(/^Per-file targeting \(fileKey\) is Local Mode only/);
		expect(normalizeExportArgs({}, { hasFs: false }).output).toBe("inline");
		expect(normalizeExportArgs({}, { hasFs: true }).output).toBe("files");
	});

	it("urls can't take width, height, colorProfile, svg rewrites or useAbsoluteBounds", () => {
		const urlsMsg = 'output "urls" renders through Figma\'s REST API, which takes a scale but not width, height or colorProfile.';
		expect(validate({ output: "urls", width: 10 }).error).toBe(urlsMsg);
		expect(validate({ output: "urls", colorProfile: "SRGB" }).error).toBe(urlsMsg);
		expect(validate({ output: "urls", svg: { currentColor: true } }).error).toMatch(/^svg\.currentColor and svg\.removeSize change the SVG text/);
		expect(validate({ output: "urls", svg: { removeSize: true } }).error).toMatch(/^svg\.currentColor and svg\.removeSize/);
		expect(validate({ output: "urls", useAbsoluteBounds: true }).error).toMatch(/without useAbsoluteBounds/);
		expect(validate({ output: "urls", scale: 2 }).error).toBeUndefined();
	});

	it("outputDir rules", () => {
		expect(validate({ output: "inline", outputDir: "/tmp/x" }).error).toBe('outputDir only applies to output "files".');
		expect(validate({ outputDir: "assets/icons" }).error).toBe("Pass an absolute outputDir.");
		for (const root of ["/", "//", "C:\\", "C:/"]) expect(validate({ outputDir: root }).error).toBe("Pick a folder for the export, not the root of the drive.");
		// "D:" is drive-relative on Windows, not absolute.
		expect(validate({ outputDir: "D:" }).error).toBe("Pass an absolute outputDir.");
		expect(validate({ outputDir: "/Users/me/app/src/icons" }).error).toBeUndefined();
	});

	it("unknown fileName tokens, node cap, imageHash format", () => {
		expect(validate({ fileName: "{name}-{foo}" }).error).toBe("Unknown token {foo} in fileName. Use {name}, {path}, {leaf}, {set}, {variant}, {id} or {page}.");
		expect(validate({ nodeIds: Array.from({ length: 51 }, (_, i) => `1:${i}`) }).error).toMatch(/^Export up to 50 nodes per call/);
		expect(validate({ imageHashes: ["xyz"] }).error).toMatch(/isn't an image hash/);
		expect(validate({ imageHashes: ["A".repeat(40)] }).error).toBeUndefined();
		// The zod schema enforces the same at the protocol edge.
		expect(EXPORT_ASSETS_SCHEMA.safeParse({ imageHashes: ["nothex"] }).success).toBe(false);
		expect(EXPORT_ASSETS_SCHEMA.safeParse({ nodeIds: Array.from({ length: 51 }, () => "1:1") }).success).toBe(false);
		expect(EXPORT_ASSETS_SCHEMA.safeParse({ scale: 5 }).success).toBe(false);
		// Direct callers (no zod) get the same bounds.
		expect(validate({ scale: 5 }).error).toBe("scale must be between 0.01 and 4.");
		expect(validate({ width: 20000 }).error).toMatch(/^width and height must be whole numbers/);
		expect(validate({ inlineSvgKB: 1 }).error).toBe("inlineSvgKB must be between 8 and 512.");
	});

	it("normalizes 123-456 ids and accepts a 300-char instance sublayer id", () => {
		const long = `I${Array.from({ length: 40 }, (_, i) => `${i + 100}:${i + 2000}`).join(";")}`.slice(0, 300);
		expect(EXPORT_ASSETS_SCHEMA.safeParse({ nodeIds: [long] }).success).toBe(true);
		const n = normalizeExportArgs({ nodeIds: ["123-456", "123:456", long] }, { hasFs: true });
		expect(n.nodeIds).toEqual(["123:456", long]);
	});

	it("notes when scale is passed for SVG/PDF", () => {
		expect(validate({ format: "SVG", scale: 2 }).notes).toEqual(["scale, width and height apply to PNG and JPG; ignored for SVG and PDF."]);
	});
});

describe("Export settings precedence (§3.4 step 3)", () => {
	const settings = [
		{ format: "PNG", suffix: "", constraint: { type: "SCALE", value: 1 } },
		{ format: "PNG", suffix: "@2x", constraint: { type: "SCALE", value: 2 } },
		{ format: "SVG", suffix: "/../evil" },
		{ format: "JPG", constraint: { type: "SCALE", value: 3 } },
	];

	it("format omitted → one asset per Export setting, suffixes sanitized, SVG mapped to SVG_STRING", () => {
		const p = plan({}, pre([{ id: "1:1", name: "hero", exportSettings: settings }]));
		expect(p.assets.map((a) => a.segments.join("/"))).toEqual(["hero.png", "hero@2x.png", "hero..evil.svg", "hero@3x.jpg"]);
		expect(p.assets[2].settings).toEqual({ format: "SVG_STRING", svgOutlineText: true, svgIdAttribute: false, svgSimplifyStroke: true, contentsOnly: true, useAbsoluteBounds: false });
		expect(p.assets[1].settings).toMatchObject({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
	});

	it("explicit format or scale overrides the Export settings", () => {
		const p = plan({ scale: 3 }, pre([{ id: "1:1", name: "hero", exportSettings: settings }]));
		expect(p.assets).toHaveLength(1);
		expect(p.assets[0]).toMatchObject({ format: "PNG", scale: 3, suffix: "@3x", segments: ["hero@3x.png"] });
		const svg = plan({ format: "SVG", svg: { outlineText: false } }, pre([{ id: "1:1", name: "hero", exportSettings: settings }]));
		expect(svg.assets.map((a) => a.settings)).toEqual([{ format: "SVG_STRING", svgOutlineText: false, svgIdAttribute: false, svgSimplifyStroke: true, contentsOnly: true, useAbsoluteBounds: false }]);
	});

	it("no Export settings → PNG 1x; given svg/bounds options override node settings field by field", () => {
		expect(plan({}, pre([{ id: "1:1", name: "a" }])).assets[0]).toMatchObject({ format: "PNG", scale: 1, suffix: "", segments: ["a.png"] });
		const p = plan({ contentsOnly: false, colorProfile: "SRGB" }, pre([{ id: "1:1", name: "a", exportSettings: [{ format: "PDF", contentsOnly: true, colorProfile: "DISPLAY_P3_V4" }] }]));
		expect(p.assets[0].settings).toEqual({ format: "PDF", contentsOnly: false, useAbsoluteBounds: false, colorProfile: "SRGB" });
	});

	it("width/height constraints map to WIDTH/HEIGHT", () => {
		const p = plan({ width: 320 }, pre([{ id: "1:1", name: "a" }]));
		expect(p.assets[0]).toMatchObject({ constraint: { type: "WIDTH", value: 320 }, estW: 320, estH: 160 });
		expect(p.assets[0].settings).toMatchObject({ constraint: { type: "WIDTH", value: 320 } });
	});

	it("caps settings per node and assets per call", () => {
		const many = Array.from({ length: 12 }, (_, i) => ({ format: "PNG", suffix: `-${i}` }));
		const p = plan({}, pre([{ id: "1:1", name: "a", exportSettings: many.slice(0, 10), settingsTotal: 12 }]));
		expect(p.assets).toHaveLength(10);
		expect(p.notes).toContain("a has 12 Export settings; used the first 10.");
		const nodes = Array.from({ length: 30 }, (_, i) => ({ id: `1:${i}`, name: `n${i}`, exportSettings: many.slice(0, 10) }));
		const big = plan({}, pre(nodes));
		expect(big.assets).toHaveLength(200);
		expect(big.skipped).toHaveLength(100);
		expect(big.skipped[0].reason).toMatch(/limit of 200 assets per call/);
	});
});

describe("file names (§3.4 step 3)", () => {
	const name = (t: string, src: Parameters<typeof expandFileName>[1]) => {
		const { dirs, stem } = expandFileName(parts(t), src);
		return [...dirs, stem].join("/");
	};

	it("{name} replaces '/', {path} makes subfolders, {leaf}, {id}, {page}", () => {
		const src = { id: "I12:60;4:12", name: "Icon/arrow left", page: "Icons / Core" };
		expect(name("{name}", src)).toBe("Icon-arrow-left");
		expect(name("{path}", src)).toBe("Icon/arrow-left");
		expect(name("{leaf}", src)).toBe("arrow-left");
		expect(name("{id}", src)).toBe("I12-60_4-12");
		expect(name("{page}/{leaf}", src)).toBe("Icons-Core/arrow-left");
	});

	it("variant naming, {set}/{variant}", () => {
		const v = { id: "1:2", name: "Size=24, Style=outline", setName: "Icon/arrow", variant: ["24", "outline"] };
		expect(name("{name}", v)).toBe("Icon-arrow-24-outline");
		expect(name("{set}/{variant}", v)).toBe("Icon-arrow/24-outline");
		expect(name("{leaf}", v)).toBe("arrow");
		expect(name("{path}", v)).toBe("Icon/arrow-24-outline");
		// A non-variant has an empty {variant}: the empty segment is dropped.
		expect(name("{set}/{variant}", { id: "1:3", name: "logo" })).toBe("logo");
	});

	it("collisions get -2, -3; Arrow and arrow collide case-insensitively", () => {
		const r = new FileNameRegistry();
		expect(r.claim([], "arrow", "", "svg")).toEqual(["arrow.svg"]);
		expect(r.claim([], "Arrow", "", "svg")).toEqual(["Arrow-2.svg"]);
		expect(r.claim([], "arrow", "", "svg")).toEqual(["arrow-3.svg"]);
		expect(r.claim(["Icons"], "arrow", "", "svg")).toEqual(["Icons", "arrow.svg"]);
		expect(r.claim(["icons"], "ARROW", "", "svg")).toEqual(["icons", "ARROW-2.svg"]);
		expect(r.claim([], "arrow", "", "png")).toEqual(["arrow.png"]);
		const p = plan({ format: "SVG" }, pre([{ id: "1:1", name: "Arrow" }, { id: "1:2", name: "arrow" }]));
		expect(p.assets.map((a) => a.segments.join("/"))).toEqual(["Arrow.svg", "arrow-2.svg"]);
	});

	it("neutralizes .., absolute paths, reserved names and odd characters", () => {
		expect(name("{path}", { id: "1:1", name: "../../etc/passwd" })).toBe("asset/asset/etc/passwd");
		expect(name("{path}", { id: "1:1", name: "/abs/olute" })).toBe("abs/olute");
		expect(name("{name}", { id: "1:1", name: "CON" })).toBe("CON_");
		expect(name("{name}", { id: "1:1", name: "lpt1.txt" })).toBe("lpt1_.txt");
		// Windows also reserves COM¹-³ and LPT¹-³ (superscript digits), which safeSegment keeps.
		expect(safeSegment("COM¹")).toBe("COM¹_");
		expect(safeSegment("lpt²")).toBe("lpt²_");
		expect(safeSegment("COM³.icon")).toBe("COM³_.icon");
		expect(name("{path}", { id: "1:1", name: "COM¹/arrow" })).toBe("COM¹_/arrow");
		expect(safeSegment("COM10")).toBe("COM10");
		expect(name("{name}", { id: "1:1", name: "a\\b c\u0000d<e>?" })).toBe("a-b-cde");
		expect(name("{name}", { id: "1:1", name: "...hidden" })).toBe("hidden");
		expect(name("{name}", { id: "1:1", name: "日本語 アイコン" })).toBe("日本語-アイコン");
		expect(name("{name}", { id: "1:1", name: "" })).toBe("asset");
		expect(name("{path}", { id: "1:1", name: "a/b/c/d/e/f/g/h/i/j" })).toBe("a/b/c/d/e/f/g/h-i-j");
		expect(safeSegment("x".repeat(500))).toHaveLength(120);
		expect(safeSegment("é".repeat(150)).length).toBeLessThanOrEqual(120);
	});

	it("a malicious suffix /../x is neutralized", () => {
		expect(safeSuffix("/../x")).toBe("..x");
		expect(safeSuffix("@2x")).toBe("@2x");
		expect(safeSuffix("a/b\\c:d*e")).toBe("abcde");
		const p = plan({}, pre([{ id: "1:1", name: "logo", exportSettings: [{ format: "PNG", suffix: "/../../x" }] }]));
		expect(p.assets[0].segments).toEqual(["logo....x.png"]);
		expect(p.assets[0].segments.every((s) => !s.includes("/"))).toBe(true);
	});
});

describe("raster pre-check", () => {
	it("uses render bounds (a shadowed node) and suggests a workable scale", () => {
		const p = plan({ scale: 2 }, pre([{ id: "1:1", name: "banner", width: 8000, height: 100, renderW: 8200, renderH: 140 }]));
		expect(p.assets).toHaveLength(0);
		expect(p.skipped[0]).toEqual({ nodeId: "1:1", reason: "A 2x PNG would be 16,400 px wide; the limit is 16,384. Use scale 1.99 or less." });
		// useAbsoluteBounds measures the node itself, which fits.
		expect(plan({ scale: 2, useAbsoluteBounds: true }, pre([{ id: "1:1", width: 8000, height: 100, renderW: 8200, renderH: 140 }])).assets).toHaveLength(1);
	});

	it("area limit and width constraints", () => {
		expect(rasterCheck("PNG", { type: "SCALE", value: 4 }, { w: 5000, h: 4000 }).error).toBe(
			"A 4x PNG would be 20,000 px wide; the limit is 16,384. Use scale 2.23 or less.",
		);
		expect(rasterCheck("JPG", { type: "SCALE", value: 1.5 }, { w: 10000, h: 9000 }).error).toBe(
			"A 1.5x JPG would be 15,000 × 13,500 px (203 MP); the limit is 100 MP. Use scale 1.05 or less.",
		);
		expect(rasterCheck("PNG", { type: "WIDTH", value: 16384 }, { w: 100, h: 10000 }).error).toMatch(/^A PNG 16,384 px wide would be 1,638,400 px tall.*Use a width of 163 px or less\.$/);
		expect(rasterCheck("PNG", { type: "SCALE", value: 1 }, { w: 0, h: 0 })).toEqual({ estW: 0, estH: 0 });
	});
});

describe("inline budgets", () => {
	it("counts base64 length per image and per call", () => {
		const b = new InlineBudget(96);
		expect(b.raster()).toEqual({ maxBase64: 1_048_576, maxBytes: 786_432 });
		b.takeB64(3.5 * 1024 * 1024);
		expect(b.raster().maxBase64).toBe(512 * 1024);
		expect(b.pdf().maxBytes).toBe(256 * 1024);
		expect(b.imageMessage("PNG", 2.3 * 1024 * 1024, true)).toBe('PNG is 2356 KB; inline images are limited to 768 KB of image data each (1 MB as base64). Use output "files" (Local Mode) or "urls", or a smaller scale.');
		// Just over the limit reads as over it (it used to say "0.8 MB; … limited to 1 MB").
		expect(b.imageMessage("PNG", 786_433, true)).toMatch(/^PNG is 769 KB; inline images are limited to 768 KB of image data each/);
		expect(b.imageMessage("PNG", 786_432, true)).toMatch(/^Inline image budget/);
		expect(b.imageMessage("PNG", 700 * 1024, true)).toMatch(/^Inline image budget \(4 MB per call\) reached/);
		expect(b.svgMessage()).toBe('Inline SVG budget (96 KB) reached. Raise inlineSvgKB (up to 512), or use output "files" or "urls".');
		expect(b.pdfMessage(300 * 1024)).toBe('PDFs over 256 KB can\'t be returned inline. Use output "files" or "urls".');
	});
});

describe("bytes", () => {
	it("sniffs PNG, JPEG, GIF, WebP and unknown", () => {
		expect(sniffImage(pngBytes(1, 1))).toMatchObject({ mimeType: "image/png", ext: "png", viewable: true });
		expect(sniffImage(jpegBytes(1, 1))).toMatchObject({ mimeType: "image/jpeg", ext: "jpg" });
		expect(sniffImage(gifBytes())).toMatchObject({ mimeType: "image/gif", ext: "gif" });
		expect(sniffImage(webpBytes())).toMatchObject({ mimeType: "image/webp", ext: "webp" });
		expect(sniffImage(new Uint8Array([1, 2, 3, 4]))).toEqual({ mimeType: "application/octet-stream", ext: "bin", viewable: false });
	});

	it("reads pixel sizes from PNG and JPEG headers; decodes base64 with and without Buffer", () => {
		expect(rasterSize(pngBytes(1440, 960))).toEqual({ width: 1440, height: 960 });
		expect(rasterSize(jpegBytes(3000, 2000))).toEqual({ width: 3000, height: 2000 });
		expect(rasterSize(gifBytes())).toBeNull();
		const raw = new Uint8Array([0, 1, 2, 250, 251, 252, 253]);
		const b64 = Buffer.from(raw).toString("base64");
		expect([...decodeBase64(b64)]).toEqual([...raw]);
		const saved = (globalThis as any).Buffer;
		(globalThis as any).Buffer = undefined;
		try {
			expect([...decodeBase64(b64)]).toEqual([...raw]);
			expect([...decodeBase64("")]).toEqual([]);
		} finally {
			(globalThis as any).Buffer = saved;
		}
	});
});

describe("REST grouping (output urls)", () => {
	const asset = (over: Partial<PlannedAsset>): PlannedAsset => ({
		key: "a",
		kind: "render",
		nodeId: "1:1",
		name: "n",
		format: "PNG",
		settings: { format: "PNG", constraint: { type: "SCALE", value: 2 }, contentsOnly: true, useAbsoluteBounds: false },
		suffix: "",
		ext: "png",
		mimeType: "image/png",
		width: 100,
		height: 50,
		segments: ["n.png"],
		...over,
	});

	it("groups by option set, ≤ 50 ids per request, ids deduped", () => {
		const notes: string[] = [];
		const items = Array.from({ length: 60 }, (_, i) => {
			const a = asset({ key: `a${i}`, nodeId: `1:${i}` });
			return { key: a.key, nodeId: a.nodeId, options: restOptionsFor(a, notes).options };
		});
		items.push({ ...items[0], key: "dup" });
		const svg = asset({ key: "s", format: "SVG", settings: { format: "SVG_STRING", svgOutlineText: true, svgIdAttribute: false, svgSimplifyStroke: true, contentsOnly: true, useAbsoluteBounds: false } });
		items.push({ key: "s", nodeId: "2:1", options: restOptionsFor(svg, notes).options });
		const groups = groupForRest(items);
		expect(groups.map((g) => [g.options.format, g.ids.length])).toEqual([
			["png", 50],
			["png", 10],
			["svg", 1],
		]);
		expect(groups[2].options).toEqual({ format: "svg", svg_outline_text: true, svg_include_id: false, svg_simplify_stroke: true, contents_only: true });
	});

	it("WIDTH constraints become a scale from the node size, clamped to 0.01–4", () => {
		const notes: string[] = [];
		const w = restOptionsFor(asset({ settings: { format: "PNG", constraint: { type: "WIDTH", value: 200 }, contentsOnly: true, useAbsoluteBounds: false } }), notes);
		expect(w.options).toEqual({ format: "png", scale: 2, contents_only: true });
		const huge = restOptionsFor(asset({ settings: { format: "JPG", constraint: { type: "HEIGHT", value: 1000 }, contentsOnly: false, useAbsoluteBounds: false } }), notes);
		expect(huge.options).toEqual({ format: "jpg", scale: 4, contents_only: false });
		expect(notes[0]).toBe("n: width 200 became scale 2 for Figma's REST render.");
		expect(notes).toHaveLength(2);
	});
});
