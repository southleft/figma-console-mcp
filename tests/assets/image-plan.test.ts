/**
 * figma_import_image planning (spec §10.4–§10.6): base64, magic bytes, pixel
 * sizes, display sizes, cross-field rules, the plan, layout, chunks and the
 * response envelope. Pure functions only.
 */

import {
	assembleImageResponse,
	buildImageChunks,
	dataHash,
	defaultImageColumns,
	densityFromName,
	displaySize,
	encodeBase64,
	fileStem,
	identifyImage,
	imageName,
	imagePixelSize,
	imageStopMessage,
	inspectImage,
	normalizeBase64,
	normalizeImageArgs,
	planImageLayout,
	planImages,
	validateImageArgs,
	type ImageItem,
	type ImagePreflight,
} from "../../src/core/assets/image-plan";
import { decodeBase64 } from "../../src/core/assets/export-plan";
import { imageChunkTimeoutMs } from "../../src/core/assets/limits";
import { b64, ftyp, gif, jpeg, png, webp } from "./image-fixtures";

const MiB = 1024 * 1024;

describe("normalizeBase64", () => {
	it("accepts plain, padded, unpadded, wrapped, base64url and data: URL input", () => {
		const bytes = png(3, 2);
		const std = b64(bytes);
		expect(normalizeBase64(std)).toEqual({ ok: true, b64: std, bytes: bytes.length });
		const wrapped = std.replace(/(.{20})/g, "$1\r\n");
		expect(normalizeBase64(`  ${wrapped}\n`)).toMatchObject({ ok: true, b64: std });
		expect(normalizeBase64(`data:image/png;base64,${std}`)).toMatchObject({ ok: true, b64: std });
		expect(normalizeBase64(`DATA:image/png; charset=binary;BASE64,${std}`)).toMatchObject({ ok: true, b64: std });
		const url = Buffer.from([0xfb, 0xff, 0xfe, 0x01]).toString("base64url");
		expect(normalizeBase64(url)).toEqual({ ok: true, b64: "+//+AQ==", bytes: 4 });
		expect(normalizeBase64("AQID")).toEqual({ ok: true, b64: "AQID", bytes: 3 });
		expect(normalizeBase64("AQ")).toEqual({ ok: true, b64: "AQ==", bytes: 1 });
		expect(normalizeBase64("AQI")).toEqual({ ok: true, b64: "AQI=", bytes: 2 });
	});

	it("rejects bad input without quoting it", () => {
		expect(normalizeBase64("")).toEqual({ ok: false, error: "is empty." });
		expect(normalizeBase64("===")).toEqual({ ok: false, error: "isn't valid base64." });
		expect(normalizeBase64("abc$def")).toEqual({ ok: false, error: "isn't valid base64." });
		expect(normalizeBase64("A")).toEqual({ ok: false, error: "isn't valid base64." });
		expect(normalizeBase64("AQ=")).toEqual({ ok: false, error: "isn't valid base64." });
		expect(normalizeBase64("AQ==AQ==")).toEqual({ ok: false, error: "isn't valid base64." });
		expect(normalizeBase64("data:image/png,rawbytes")).toEqual({ ok: false, error: "is a data: URL without ;base64. Only base64 data: URLs are supported." });
	});

	it("stays linear on hostile input", () => {
		// ~10 ms; a quadratic scan of 5 M characters takes hours. The bound is far above anything
		// parallel jest workers or a slow CI runner (publish.yml runs `npm test`) can cause, and a
		// slow run is measured once more, so one GC pause or descheduling can't fail the suite.
		const run = () => {
			const t0 = performance.now();
			expect(normalizeBase64(`${"=".repeat(5_000_000)}a`).ok).toBe(false);
			expect(normalizeBase64(`${"A".repeat(5_000_000)}$`).ok).toBe(false);
			expect(normalizeBase64(`data:${"x".repeat(5_000_000)}`).ok).toBe(false);
			return performance.now() - t0;
		};
		let took = run();
		if (took >= 5000) took = Math.min(took, run());
		expect(took).toBeLessThan(5000);
	});

	it("dataHash is a stable native SHA-256 prefix and fast on a full-size image", async () => {
		const h = await dataHash("AAAA");
		expect(h).toMatch(/^[0-9a-f]{16}$/);
		expect(await dataHash("AAAA")).toBe(h);
		expect(await dataHash("AAAB")).not.toBe(h);
		// What makes it fast is the native digest, so check that directly; the time bound is only a
		// loose backstop (~8 ms native), far above anything CI load can cause.
		const big = "A".repeat(11_000_000);
		const digest = jest.spyOn(globalThis.crypto.subtle, "digest");
		try {
			const t0 = performance.now();
			await dataHash(big);
			expect(performance.now() - t0).toBeLessThan(5000);
			expect(digest).toHaveBeenCalledTimes(1);
			expect(digest.mock.calls[0][0]).toBe("SHA-256");
			expect((digest.mock.calls[0][1] as Uint8Array).byteLength).toBe(11_000_000);
		} finally {
			digest.mockRestore();
		}
	});

	it("encodeBase64 round-trips with and without Buffer", () => {
		const bytes = png(40, 30, { seed: 7 });
		expect(encodeBase64(bytes)).toBe(b64(bytes));
		const sub = bytes.subarray(5, 50);
		expect(encodeBase64(sub)).toBe(Buffer.from(sub).toString("base64"));
		const g = globalThis as { Buffer?: unknown };
		const saved = g.Buffer;
		const big = new Uint8Array(100_000).map((_, i) => i * 7);
		const expected = Buffer.from(big).toString("base64");
		try {
			g.Buffer = undefined;
			expect(encodeBase64(big)).toBe(expected);
			expect(Array.from(decodeBase64(expected).subarray(0, 10))).toEqual(Array.from(big.subarray(0, 10)));
		} finally {
			g.Buffer = saved;
		}
	});
});

describe("magic bytes and pixel sizes", () => {
	it("identifies PNG, JPEG and GIF by their bytes", () => {
		expect(identifyImage(png(1, 1))).toEqual({ ok: true, format: "png" });
		expect(identifyImage(jpeg(1, 1))).toEqual({ ok: true, format: "jpeg" });
		expect(identifyImage(gif(1, 1, "87a"))).toEqual({ ok: true, format: "gif" });
		expect(identifyImage(gif(1, 1, "89a"))).toEqual({ ok: true, format: "gif" });
	});

	it("names the formats Figma's plugin API doesn't take", () => {
		const msg = (b: Uint8Array) => (identifyImage(b) as { error: string }).error;
		const conv = (what: string) => `This is ${what}; Figma's plugin API takes PNG, JPEG or GIF. Convert it first.`;
		expect(msg(webp())).toBe(conv("a WebP image"));
		expect(msg(ftyp("avif"))).toBe(conv("an AVIF image"));
		expect(msg(ftyp("heic"))).toBe(conv("a HEIC image"));
		expect(msg(ftyp("mif1"))).toBe(conv("a HEIC image"));
		expect(msg(new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0]))).toBe(conv("a TIFF image"));
		expect(msg(new Uint8Array([0x4d, 0x4d, 0, 0x2a, 0, 0]))).toBe(conv("a TIFF image"));
		expect(msg(new Uint8Array([0, 0, 1, 0, 1, 0]))).toBe(conv("an ICO icon"));
		expect(msg(Buffer.from("BM6\u0000\u0000"))).toBe(conv("a BMP image"));
		expect(msg(Buffer.from("%PDF-1.7"))).toBe(conv("a PDF"));
		const svgMsg = "This is SVG markup; import it with figma_import_svg.";
		expect(msg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(svgMsg);
		expect(msg(Buffer.from('\uFEFF<?xml version="1.0"?>\n<!-- c --><svg viewBox="0 0 1 1"></svg>'))).toBe(svgMsg);
		expect(msg(Buffer.from("hello world"))).toBe("This isn't a PNG, JPEG or GIF image (unrecognized file signature).");
		expect(msg(new Uint8Array([0x89, 0x50]))).toBe("This isn't a PNG, JPEG or GIF image (unrecognized file signature).");
		// A PNG signature with a damaged byte isn't accepted.
		const bad = png(1, 1);
		bad[5] = 0;
		expect(identifyImage(bad).ok).toBe(false);
	});

	it("reads PNG, GIF and JPEG sizes, including a JPEG whose SOF sits behind 150 KB of EXIF", () => {
		expect(imagePixelSize(png(640, 480, { headerOnly: true }), "png")).toEqual({ width: 640, height: 480 });
		expect(imagePixelSize(gif(300, 2), "gif")).toEqual({ width: 300, height: 2 });
		expect(imagePixelSize(jpeg(1024, 768), "jpeg")).toEqual({ width: 1024, height: 768 });
		const deep = jpeg(800, 600, { appBytes: 150_000 });
		const head = deep.subarray(0, 64 * 1024);
		expect(imagePixelSize(head, "jpeg")).toBeNull();
		let used = false;
		expect(
			inspectImage(head, () => {
				used = true;
				return deep;
			}),
		).toEqual({ ok: true, format: "jpeg", width: 800, height: 600 });
		expect(used).toBe(true);
		// PNG and GIF never need the full bytes.
		expect(inspectImage(png(5, 6), () => { throw new Error("not needed"); })).toEqual({ ok: true, format: "png", width: 5, height: 6 });
	});

	it("rejects truncated headers, empty images and images over 4096 px", () => {
		expect(inspectImage(png(10, 10).subarray(0, 20))).toEqual({ ok: false, error: "Couldn't read the image's pixel size from its PNG header; the file may be truncated or damaged." });
		expect(inspectImage(gif(1, 1).subarray(0, 8))).toEqual({ ok: false, error: "Couldn't read the image's pixel size from its GIF header; the file may be truncated or damaged." });
		expect(inspectImage(jpeg(10, 10).subarray(0, 24))).toMatchObject({ ok: false, error: expect.stringContaining("JPEG header") });
		expect(inspectImage(gif(0, 12))).toEqual({ ok: false, error: "The image has no pixels (0×12)." });
		expect(inspectImage(png(6000, 4000, { headerOnly: true }))).toEqual({
			ok: false,
			error: "This image is 6000×4000 px; Figma's plugin API takes images up to 4096 px on each side. Scale it down first.",
		});
		expect(inspectImage(png(4096, 4096, { headerOnly: true }))).toMatchObject({ ok: true, width: 4096, height: 4096 });
	});
});

describe("names, density and display size", () => {
	it("names layers from the given name, else the file name, else Image", () => {
		expect(imageName("Hero", "/a/b/photo.png")).toBe("Hero");
		expect(imageName(undefined, "/a/b/photo.final.JPEG")).toBe("photo.final");
		expect(imageName(undefined, "C:\\pics\\cat.gif")).toBe("cat");
		expect(imageName(undefined, undefined)).toBe("Image");
		expect(imageName("  \u0000 ", undefined)).toBe("Image");
		expect(fileStem("sub/dir/hero@2x.png")).toBe("hero@2x");
	});

	it("reads density from @Nx suffixes", () => {
		expect(densityFromName("hero@2x")).toBe(2);
		expect(densityFromName("icon@3X")).toBe(3);
		expect(densityFromName("a@1.5x")).toBe(1.5);
		expect(densityFromName("a@10x")).toBeUndefined();
		expect(densityFromName("a@0x")).toBeUndefined();
		expect(densityFromName("a2x")).toBeUndefined();
		expect(densityFromName("a@2x.copy")).toBeUndefined();
	});

	it("sizes new layers for every width/height/fit/density case", () => {
		expect(displaySize(400, 200, 1, null, "contain")).toEqual({ w: 400, h: 200 });
		expect(displaySize(400, 200, 2, null, "contain")).toEqual({ w: 200, h: 100 });
		expect(displaySize(400, 200, 1, { w: 100 }, "contain")).toEqual({ w: 100, h: 50 });
		expect(displaySize(400, 200, 1, { h: 100 }, "contain")).toEqual({ w: 200, h: 100 });
		expect(displaySize(400, 200, 1, { w: 100, h: 100 }, "contain")).toEqual({ w: 100, h: 50 });
		expect(displaySize(200, 400, 1, { w: 100, h: 100 }, "contain")).toEqual({ w: 50, h: 100 });
		expect(displaySize(400, 200, 1, { w: 100, h: 100 }, "exact")).toEqual({ w: 100, h: 100 });
		// Density doesn't change a fitted size; rounding to 0.01.
		expect(displaySize(400, 200, 2, { w: 100 }, "contain")).toEqual({ w: 100, h: 50 });
		expect(displaySize(3, 1, 1, { w: 1 }, "contain")).toEqual({ w: 1, h: 0.33 });
		expect(displaySize(1, 1, 8, null, "contain")).toEqual({ w: 0.13, h: 0.13 });
		expect(displaySize(4096, 1, 1, { w: 1 }, "contain")).toEqual({ w: 1, h: 0.01 });
	});
});

describe("validateImageArgs", () => {
	const v = (a: Record<string, unknown>, ctx = { hasFs: true, remote: false }) => validateImageArgs(normalizeImageArgs(a), ctx);
	const D = b64(png(1, 1));

	it("returns each fatal message", () => {
		const cases: Array<[Record<string, unknown>, string | RegExp, { hasFs: boolean; remote: boolean }?]> = [
			[{}, "Nothing to import: pass images (base64 data, or in Local Mode a file path), or in Local Mode a directory."],
			[{ images: [{ path: "/a.png" }] }, /^path and directory read files from disk/, { hasFs: false, remote: true }],
			[{ directory: "/x" }, /^path and directory read files from disk/, { hasFs: false, remote: true }],
			[{ images: [{ data: D }], limit: 3 }, /^path and directory read files from disk/, { hasFs: false, remote: true }],
			[{ images: [{ data: D }], fileKey: "k" }, /^Per-file targeting \(fileKey\) is Local Mode only/, { hasFs: false, remote: true }],
			[{ images: Array.from({ length: 51 }, () => ({ data: D })) }, "Cloud Mode imports up to 50 images per call. Split the batch into several calls.", { hasFs: false, remote: true }],
			[{ images: [{ data: D }, { data: D, path: "/a.png" }] }, "images[1] needs data (base64) or path, not both."],
			[{ images: [{ name: "x" }] }, "images[0] needs data (base64) or path."],
			[{ images: Array.from({ length: 101 }, () => ({ data: D })) }, "Too many images in one call: 101; the limit is 100. Split the call."],
			[{ images: Array.from({ length: 100 }, () => ({ data: D })), directory: "/x" }, /leave no room for the directory/],
			[{ images: [{ data: D }, { data: D }], nodeIds: ["1:2"] }, "nodeIds applies to a single image. For several images, give each one its own images[i].nodeIds."],
			[{ images: [{ data: D }], directory: "/x", nodeIds: ["1:2"] }, /^nodeIds applies to a single image/],
			[{ images: [{ data: D, nodeIds: ["1:3"] }], nodeIds: ["1:2"] }, "Use nodeIds or images[0].nodeIds, not both."],
			[
				{ images: Array.from({ length: 6 }, () => ({ data: D, nodeIds: Array.from({ length: 100 }, (_, i) => `1:${i}`) })) },
				"Too many layers to fill in one call: 600; the limit is 500. Split the call.",
			],
			[{ images: [{ data: D }], fit: "exact", width: 10 }, 'fit "exact" needs both width and height.'],
			[{ images: [{ path: "pics/a.png" }] }, '"pics/a.png" is a relative path. Pass an absolute path.'],
			[{ directory: "pics" }, '"pics" is a relative path. Pass an absolute path.'],
		];
		for (const [args, want, ctx] of cases) {
			const r = v(args, ctx);
			if (typeof want === "string") expect(r.error).toBe(want);
			else expect(r.error).toMatch(want);
		}
	});

	it("re-checks the schema's ranges and lengths for callers that skip zod", () => {
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ images: [{ data: D, nodeIds: Array.from({ length: 101 }, (_, i) => `1:${i}`) }] }, "images[0].nodeIds lists 101 layers; the limit per image is 100."],
			[{ images: [{ data: D }], nodeIds: Array.from({ length: 101 }, (_, i) => `1:${i}`) }, "nodeIds lists 101 layers; the limit per image is 100."],
			[{ images: [{ data: D, nodeIds: ["x".repeat(501)] }] }, "Node ids must be 1–500 characters."],
			[{ images: [{ data: D }], parentId: "1".repeat(501) }, "Node ids must be 1–500 characters."],
			[{ images: [{ path: `/${"a".repeat(4100)}.png` }] }, "images[0].path is longer than 4096 characters."],
			[{ images: [{ data: D }], width: 0 }, "width and height must be between 1 and 16384."],
			[{ images: [{ data: D }], height: Number.NaN }, "width and height must be between 1 and 16384."],
			[{ images: [{ data: D }], density: 100 }, "density must be between 0.25 and 8."],
			[{ images: [{ data: D }], x: Infinity, y: 0 }, "x and y must be between -1000000 and 1000000."],
			[{ directory: "/d", offset: -1 }, "offset must be a whole number ≥ 0 and limit a whole number from 1 to 100."],
			[{ directory: "/d", limit: 2.5 }, "offset must be a whole number ≥ 0 and limit a whole number from 1 to 100."],
			[{ images: [{ data: D }], layout: { columns: 0 } }, "layout.columns must be 1–100 and layout.gap/padding 0–1000."],
			[{ images: [{ data: D }], layout: { containerName: "" } }, "layout.containerName must be 1–200 characters."],
			[{ images: [{ data: D }], fileKey: "k".repeat(101) }, "fileKey is longer than 100 characters."],
		];
		for (const [args, want] of cases) expect(v(args).error).toBe(want);
	});

	it("counts the inline total in base64 characters", () => {
		const big = "A".repeat(11 * MiB);
		expect(v({ images: [{ data: big }, { data: big }, { data: big }] }).error).toBe(
			"The inline images total 33 MB of base64; the limit per call is 32 MB. Split them into several calls (or, in Local Mode, pass file paths).",
		);
	});

	it("moves the top-level nodeIds shorthand onto images[0] and notes ignored layer options", () => {
		const n = normalizeImageArgs({ images: [{ data: D }], nodeIds: ["1-2", "1:2", "3:4"], width: 10 });
		const r = validateImageArgs(n, { hasFs: true, remote: false });
		expect(r.error).toBeUndefined();
		expect(n.images[0].nodeIds).toEqual(["1:2", "3:4"]);
		expect(n.nodeIds).toBeUndefined();
		expect(r.notes).toEqual(["width, height, fit and nodeType apply to new layers; layers given in nodeIds keep their size and type."]);
		expect(normalizeImageArgs({ parentId: "12-3" }).parentId).toBe("12:3");
	});

	it("applies every default in code", () => {
		expect(normalizeImageArgs({})).toMatchObject({
			images: [],
			recursive: false,
			offset: 0,
			limit: 50,
			pagingGiven: false,
			fit: "contain",
			scaleMode: "FILL",
			nodeType: "rectangle",
			layout: { container: "auto", containerName: "Images", gap: 24, padding: 40 },
			focus: true,
			dryRun: false,
			verbose: false,
		});
	});
});

function item(over: Partial<ImageItem> = {}): ImageItem {
	return { key: "i0", source: "images[0]", kind: "inline", name: "Image", density: 1, notes: [], data: "AAAA", hash: "h0", pixelWidth: 200, pixelHeight: 100, format: "png", ...over };
}

const PAGE: ImagePreflight["parent"] = { id: "0:1", type: "PAGE", name: "Page 1", autoLayout: false, pageId: "0:1", onCurrentPage: true };
const pre = (over: Partial<ImagePreflight> = {}): ImagePreflight => ({ editorType: "figma", fileKey: "F", fileName: "File", parent: PAGE, targets: [], ...over });

describe("planImages", () => {
	it("keeps the fillable targets, notes the rest, and fails when none can be filled", () => {
		const n = normalizeImageArgs({ images: [{ data: "x" }] });
		const a = item({ key: "a", nodeIds: ["1:1", "1:2", "1:3"] });
		const b = item({ key: "b", nodeIds: ["9:9"] });
		const p = pre({
			targets: [
				{ id: "1:1", found: true, type: "RECTANGLE", name: "Hero", fillable: true },
				{ id: "1:2", found: true, type: "GROUP", name: "Group 1", fillable: false, why: "is a GROUP, which has no fills" },
				{ id: "1:3", found: false },
				{ id: "9:9", found: false },
			],
		});
		planImages([a, b], p, n);
		expect(a).toMatchObject({ action: "fill", targetIds: ["1:1"], targets: [{ id: "1:1", name: "Hero", type: "RECTANGLE" }] });
		expect(a.notes).toEqual(['Not filled: "Group 1" (1:2) is a GROUP, which has no fills; 1:3 wasn\'t found.']);
		expect(b).toMatchObject({ action: "fail", status: "failed", stage: "plan" });
		expect(b.reason).toBe("None of the layers can take an image fill: 9:9 wasn't found. Node ids change between sessions; get fresh ones from the file.");
	});

	it("recognizes what an interrupted run placed and plans sizes for the rest", () => {
		const n = normalizeImageArgs({ images: [], width: 100, resumeRunId: "abcdefabcdef" });
		const done = item({ key: "a", source: "images[0]", hash: "H1" });
		const fresh = item({ key: "b", source: "images[1]", hash: "H2" });
		const failed = item({ key: "c", status: "failed", action: "fail" });
		planImages([done, fresh, failed], pre({ resumed: [{ source: "images[0]", hash: "H1", nodeId: "5:5", type: "RECTANGLE", width: 100, height: 50, imageHash: "IH" }] }), n);
		expect(done).toMatchObject({ action: "unchanged", nodeId: "5:5", imageHash: "IH" });
		expect(done.notes).toEqual(["Placed by the interrupted run abcdefabcdef; not placed again."]);
		expect(fresh).toMatchObject({ action: "create", planned: { w: 100, h: 50 } });
		expect(failed.action).toBe("fail");
	});
});

describe("planImageLayout", () => {
	const creates = (k: number, over: Partial<ImageItem> = {}) => Array.from({ length: k }, (_, i) => item({ key: `i${i}`, action: "create", planned: { w: 200 + i, h: 100 }, ...over }));
	const n = (a: Record<string, unknown> = {}) => normalizeImageArgs({ images: [], ...a });

	it("one new layer: no container, single placement, x/y as origin", () => {
		expect(planImageLayout(creates(1), pre(), n({ x: 5, y: 6 }))).toMatchObject({ container: "none", mode: "single", origin: { x: 5, y: 6 } });
		expect(planImageLayout([item({ action: "fill" })], pre(), n())).toMatchObject({ container: "none", mode: "single" });
	});

	it("a batch gets a wrapping frame sized from the near-square grid; FigJam gets a section; an auto-layout parent gets none", () => {
		const frame = planImageLayout(creates(5), pre(), n());
		expect(frame).toMatchObject({ container: "frame", mode: "auto-layout", columns: 3 });
		expect(frame.frameWidth).toBe(3 * 204 + 2 * 24 + 2 * 40);
		expect(planImageLayout(creates(5), pre({ editorType: "figjam" }), n())).toMatchObject({ container: "section", mode: "shelf" });
		expect(planImageLayout(creates(5), pre({ editorType: "figjam" }), n({ width: 50, height: 40 }))).toMatchObject({ container: "section", mode: "grid", cell: { w: 50, h: 40 } });
		expect(planImageLayout(creates(5), pre({ parent: { ...PAGE, type: "FRAME", autoLayout: true } }), n())).toMatchObject({ container: "none", mode: "auto-layout" });
		expect(planImageLayout(creates(5), pre({ parent: { ...PAGE, type: "FRAME" }, editorType: "figjam" }), n())).toMatchObject({ container: "none", mode: "shelf" });
		expect(planImageLayout(creates(5), pre(), n({ width: 64, height: 64 })).frameWidth).toBe(3 * 64 + 2 * 24 + 2 * 40);
	});

	it("reuses a container by name, rejects an explicit section in a frame, and honors columns", () => {
		const reused = planImageLayout(creates(3), pre({ container: { id: "7:7", type: "SECTION", name: "Images", autoLayout: false } }), n({ x: 1, y: 2 }));
		expect(reused).toMatchObject({ reuse: { id: "7:7", type: "SECTION" }, mode: "shelf" });
		expect(reused.notes).toEqual(['x/y ignored: the existing "Images" was reused.']);
		expect(planImageLayout(creates(3), pre({ parent: { ...PAGE, type: "FRAME" } }), n({ layout: { container: "section" } })).error).toBe(
			'A section can only go on a page or inside another section; the parent is a FRAME. Use layout.container "frame" or "none".',
		);
		expect(planImageLayout(creates(9), pre(), n({ layout: { container: "none", columns: 2 } }))).toMatchObject({ container: "none", mode: "shelf", columns: 2 });
	});

	it("default columns form a near-square grid, at most 12", () => {
		expect([1, 2, 4, 5, 10, 100, 1000].map(defaultImageColumns)).toEqual([1, 2, 2, 3, 4, 10, 12]);
	});
});

describe("buildImageChunks", () => {
	it("packs by count and by base64 size; a big image travels alone; only creates and fills are sent", () => {
		const small = Array.from({ length: 45 }, (_, i) => item({ key: `s${i}`, action: "create" }));
		expect(buildImageChunks(small).map((c) => c.items.length)).toEqual([20, 20, 5]);
		const mb = (k: number) => "A".repeat(Math.round(k * MiB));
		const sized = [
			item({ key: "a", action: "create", data: mb(1.5) }),
			item({ key: "b", action: "fill", data: mb(1.5), targetIds: ["1:1", "1:2"] }),
			item({ key: "c", action: "create", data: mb(1.5) }),
			item({ key: "big", action: "create", data: mb(9) }),
			item({ key: "d", action: "create", data: mb(0.5) }),
			item({ key: "u", action: "unchanged" }),
			item({ key: "f", action: "fail" }),
		];
		const chunks = buildImageChunks(sized);
		expect(chunks.map((c) => c.keys)).toEqual([["a", "b"], ["c"], ["big"], ["d"]]);
		expect(chunks[0].fillTargets).toBe(2);
		expect(chunks[0].items[1]).toMatchObject({ action: "fill", targetIds: ["1:1", "1:2"] });
		expect(chunks[0].items[0].targetIds).toBeUndefined();
		expect(chunks[2].b64Chars).toBe(9 * MiB);
	});

	it("chunk timeouts grow with size and are clamped", () => {
		expect(imageChunkTimeoutMs(1, 100, 0)).toBe(17_500);
		expect(imageChunkTimeoutMs(1, 0, 0)).toBe(15_000);
		expect(imageChunkTimeoutMs(20, 4 * MiB, 50)).toBe(10_000 + 30_000 + 24_000 + 5_000);
		expect(imageChunkTimeoutMs(100, 100 * MiB, 500)).toBe(120_000);
	});
});

describe("assembleImageResponse", () => {
	it("puts problems and fills first, compacts created and unchanged, and gives a hint", () => {
		const n = normalizeImageArgs({ images: [] });
		const items = [
			item({ key: "c", source: "images[0]", name: "A", status: "created", nodeId: "1:1", type: "RECTANGLE", width: 200, height: 100, imageHash: "IH1" }),
			item({ key: "f", source: "images[1]", name: "B", status: "failed", stage: "format", reason: "nope", format: undefined, pixelWidth: undefined, pixelHeight: undefined }),
			item({ key: "u", source: "images[2]", name: "C", status: "updated", filled: [{ id: "2:2", name: "Hero" }], imageHash: "IH2" }),
			item({ key: "s", source: "images[3]", name: "D", status: "unchanged", nodeId: "3:3" }),
		];
		const { body, isError } = assembleImageResponse({ n, items, runId: "abcdefabcdef", pre: pre(), notes: ["n1", "n1"] });
		expect(isError).toBe(false);
		expect(body).toMatchObject({
			success: false,
			dryRun: false,
			runId: "abcdefabcdef",
			summary: { requested: 4, created: 1, updated: 1, unchanged: 1, failed: 1 },
			file: { name: "File", editorType: "figma" },
			created: [["images[0]", "A", "1:1", "IH1"]],
			unchanged: [["images[3]", "D", "3:3"]],
			notes: ["n1"],
			hint: 'Check the result with figma_capture_screenshot({ nodeId: "1:1" }).',
		});
		expect(body.items).toEqual([
			{ source: "images[1]", name: "B", status: "failed", stage: "format", reason: "nope" },
			{ source: "images[2]", name: "C", status: "updated", imageHash: "IH2", filled: [{ id: "2:2", name: "Hero" }], format: "PNG", pixelWidth: 200, pixelHeight: 100 },
		]);
		expect(JSON.stringify(body)).not.toContain("AAAA");
	});

	it("isError only when nothing was placed and something failed; moreItems beyond 150; dryRun counts actions", () => {
		const n = normalizeImageArgs({ images: [] });
		const failedOnly = [item({ status: "failed", stage: "decode", reason: "x" })];
		expect(assembleImageResponse({ n, items: failedOnly, notes: [] }).isError).toBe(true);
		const stopped = assembleImageResponse({ n, items: failedOnly, notes: [], incomplete: { reason: "r", runId: "abcdefabcdef", notAttempted: [] } });
		expect(stopped.isError).toBe(false);
		expect(stopped.body.hint).toBe('Continue with resumeRunId: "abcdefabcdef".');
		const many = Array.from({ length: 160 }, (_, i) => item({ key: `k${i}`, status: "failed", reason: "x" }));
		const r = assembleImageResponse({ n, items: many, notes: [] });
		expect((r.body.items as unknown[]).length).toBe(150);
		expect(r.body.moreItems).toEqual({ count: 10, byStatus: { failed: 10 } });
		const dry = normalizeImageArgs({ images: [], dryRun: true });
		const d = assembleImageResponse({ n: dry, items: [item({ action: "create", planned: { w: 10, h: 5 } }), item({ action: "fill", targets: [{ id: "1:1" }] })], notes: [] });
		expect(d.body.summary).toEqual({ requested: 2, actions: { create: 1, fill: 1 } });
		expect(d.body.items).toEqual([
			{ source: "images[0]", name: "Image", action: "create", width: 10, height: 5, format: "PNG", pixelWidth: 200, pixelHeight: 100 },
			{ source: "images[0]", name: "Image", action: "fill", targets: [{ id: "1:1" }], format: "PNG", pixelWidth: 200, pixelHeight: 100 },
		]);
		expect(d.body.runId).toBeUndefined();
	});

	it("stop messages use image wording", () => {
		expect(imageStopMessage("maybeRunning", "abcdefabcdef", 0)).toMatch(/^Figma didn't answer in time \(or the connection dropped\) and may still be importing images\. Nothing more was sent\..*resumeRunId: "abcdefabcdef": images this run already placed are recognized instead of placed twice\.$/);
		expect(imageStopMessage("refused", "abcdefabcdef", 0, "Another SVG import is still writing in Figma.")).toBe(
			'Another SVG import is still writing in Figma. Nothing more was sent. When that\'s sorted out, run the same call again with resumeRunId: "abcdefabcdef" to continue.',
		);
		expect(imageStopMessage("budget", "abcdefabcdef", 241_000)).toBe('Stopped after 241 s to stay within the time limit for one call. Run the same call again with resumeRunId: "abcdefabcdef" to continue.');
		expect(imageStopMessage("cancelled", "abcdefabcdef", 0)).toMatch(/^Cancelled\./);
	});
});
