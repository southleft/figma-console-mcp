/**
 * Local file reading for figma_import_svg (spec §2.12, §8.1
 * "assets-node-fs", read half). Runs against real temp folders.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createNodeAssetFs, decodeSvgBytes } from "../../src/core/assets/node-fs";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1"/></svg>';

describe("createNodeAssetFs (read)", () => {
	let dir: string;
	const fs = createNodeAssetFs();

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fcm-assetfs-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const write = (rel: string, text: string | Buffer = SVG) => {
		const p = join(dir, rel);
		mkdirSync(join(p, ".."), { recursive: true });
		writeFileSync(p, text);
		return p;
	};

	it("listSvgFiles skips hidden entries, nested symlinks, non-.svg files and nested node_modules", async () => {
		write("a.svg");
		write("B.SVG");
		write("notes.txt", "x");
		write(".hidden.svg");
		write(".git/x.svg");
		write("node_modules/pkg/icon.svg");
		write("sub/c.svg");
		const outside = mkdtempSync(join(tmpdir(), "fcm-assetfs-out-"));
		writeFileSync(join(outside, "evil.svg"), SVG);
		symlinkSync(outside, join(dir, "linked"));
		symlinkSync(join(outside, "evil.svg"), join(dir, "link.svg"));
		try {
			const flat = await fs.listSvgFiles(dir, { recursive: false, maxDepth: 6, maxScan: 10_000 });
			expect(flat.files.map((f) => f.relPath).sort()).toEqual(["B.SVG", "a.svg"]);
			expect(flat.skippedSubfolders).toBe(true);
			const deep = await fs.listSvgFiles(dir, { recursive: true, maxDepth: 6, maxScan: 10_000 });
			expect(deep.files.map((f) => f.relPath).sort()).toEqual(["B.SVG", "a.svg", "sub/c.svg"]);
			expect(deep.files.find((f) => f.relPath === "a.svg")?.size).toBe(SVG.length);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("respects depth and scan caps", async () => {
		write("1/2/3/deep.svg");
		write("1/top.svg");
		const shallow = await fs.listSvgFiles(dir, { recursive: true, maxDepth: 1, maxScan: 10_000 });
		expect(shallow.files.map((f) => f.relPath)).toEqual(["1/top.svg"]);
		for (let i = 0; i < 20; i++) write(`many/f${i}.svg`);
		const capped = await fs.listSvgFiles(join(dir, "many"), { recursive: false, maxDepth: 6, maxScan: 5 });
		expect(capped.truncated).toBe(true);
		expect(capped.files.length).toBeLessThanOrEqual(5);
	});

	it("works when the root itself is a symlink", async () => {
		write("real/x.svg");
		symlinkSync(join(dir, "real"), join(dir, "alias"));
		const r = await fs.listSvgFiles(join(dir, "alias"), { recursive: false, maxDepth: 6, maxScan: 100 });
		expect(r.files.map((f) => f.relPath)).toEqual(["x.svg"]);
	});

	it("listSvgFiles errors name the folder", async () => {
		await expect(fs.listSvgFiles("relative/dir", { recursive: false, maxDepth: 6, maxScan: 10 })).rejects.toThrow('"relative/dir" is a relative path. Pass an absolute path.');
		await expect(fs.listSvgFiles(join(dir, "nope"), { recursive: false, maxDepth: 6, maxScan: 10 })).rejects.toThrow(`Folder not found: ${join(dir, "nope")}`);
		const f = write("file.svg");
		await expect(fs.listSvgFiles(f, { recursive: false, maxDepth: 6, maxScan: 10 })).rejects.toThrow(`${f} is a file, not a folder. Use paths for single files.`);
	});

	it("readSvgFile rejects relative paths, non-.svg, .svgz, folders, oversized and non-UTF-8 files", async () => {
		await expect(fs.readSvgFile("icons/a.svg", 1000)).rejects.toThrow('"icons/a.svg" is a relative path. Pass an absolute path.');
		await expect(fs.readSvgFile(write("a.txt", "x"), 1000)).rejects.toThrow(/isn't an \.svg file/);
		await expect(fs.readSvgFile(write("a.svgz", "x"), 1000)).rejects.toThrow(/compressed \.svgz files aren't supported; unzip it first/);
		mkdirSync(join(dir, "folder.svg"));
		await expect(fs.readSvgFile(join(dir, "folder.svg"), 1000)).rejects.toThrow(/is a folder/);
		const big = write("big.svg", "x".repeat(5000));
		await expect(fs.readSvgFile(big, 1000)).rejects.toThrow(`${big} is 0.0 MB; the limit is 0.0 MB.`);
		await expect(fs.readSvgFile(write("latin1.svg", Buffer.from([0x3c, 0x73, 0xe9, 0xff, 0x3e])), 1000)).rejects.toThrow(/isn't UTF-8 text\./);
		await expect(fs.readSvgFile(join(dir, "missing.svg"), 1000)).rejects.toThrow(`File not found: ${join(dir, "missing.svg")}`);
	});

	it("checks the size before reading", async () => {
		const p = write("huge.svg", "x".repeat(64 * 1024));
		const spy = jest.spyOn(require("fs/promises"), "open");
		await expect(fs.readSvgFile(p, 1024)).rejects.toThrow(/the limit is/);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("decodes UTF-16 by BOM, strips the UTF-8 BOM and follows an explicitly named symlink to a regular .svg", async () => {
		const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SVG, "utf16le")]);
		expect((await fs.readSvgFile(write("le.svg", le), 10_000)).text).toBe(SVG);
		const beBody = Buffer.from(SVG, "utf16le");
		for (let i = 0; i < beBody.length; i += 2) [beBody[i], beBody[i + 1]] = [beBody[i + 1], beBody[i]];
		expect((await fs.readSvgFile(write("be.svg", Buffer.concat([Buffer.from([0xfe, 0xff]), beBody])), 10_000)).text).toBe(SVG);
		expect((await fs.readSvgFile(write("bom.svg", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SVG)])), 10_000)).text).toBe(SVG);
		const target = write("real.svg");
		symlinkSync(target, join(dir, "named.svg"));
		expect((await fs.readSvgFile(join(dir, "named.svg"), 10_000)).text).toBe(SVG);
		symlinkSync(write("secret.txt", "TOP SECRET"), join(dir, "sneaky.svg"));
		await expect(fs.readSvgFile(join(dir, "sneaky.svg"), 10_000)).rejects.toThrow(/links to a file that isn't an \.svg file/);
	});

	it("error messages never include file contents", async () => {
		const secret = "SECRET_CONTENT_42";
		const p = write("bad.svg", Buffer.concat([Buffer.from(secret), Buffer.from([0xff, 0xfe, 0xfd])]));
		const err = await fs.readSvgFile(p, 10_000).catch((e: Error) => e.message);
		expect(err).not.toContain(secret);
		expect(() => decodeSvgBytes(Buffer.from([0xc3, 0x28]), "/x.svg")).toThrow("/x.svg isn't UTF-8 text.");
	});
});

describe("listing: review fix", () => {
	it("stops reading a huge folder at the scan budget instead of reading and sorting all of it", async () => {
		const fsp = require("fs/promises");
		const { mkdtempSync: mk, writeFileSync: wf, rmSync: rm, realpathSync: rp } = require("fs");
		const { join: j } = require("path");
		const { tmpdir: td } = require("os");
		const big = rp(mk(j(td(), "fcm-big-")));
		try {
			for (let i = 0; i < 400; i++) wf(j(big, `f${i}.svg`), "<svg/>");
			const realOpendir = fsp.opendir;
			let yielded = 0;
			const spy = jest.spyOn(fsp, "opendir").mockImplementation(async (...a: unknown[]) => {
				const d = await realOpendir(...a);
				return {
					close: () => d.close(),
					async *[Symbol.asyncIterator]() {
						for await (const e of d) {
							yielded++;
							yield e;
						}
					},
				};
			});
			const { createNodeAssetFs: make } = require("../../src/core/assets/node-fs");
			const r = await make().listSvgFiles(big, { recursive: false, maxDepth: 6, maxScan: 10 });
			spy.mockRestore();
			expect(r.truncated).toBe(true);
			expect(r.files).toHaveLength(10);
			expect(yielded).toBeGreaterThan(0);
			expect(yielded).toBeLessThanOrEqual(11);
		} finally {
			rm(big, { recursive: true, force: true });
		}
	});
});
