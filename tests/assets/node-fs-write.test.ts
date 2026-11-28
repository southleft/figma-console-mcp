/**
 * File writing for figma_export_assets (spec §3.6, §8.1 "assets-node-fs",
 * write half). Runs against real temp folders.
 */

import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, sep } from "path";
import { createNodeAssetFs } from "../../src/core/assets/node-fs";

describe("createNodeAssetFs (write)", () => {
	let dir: string;
	const fs = createNodeAssetFs();
	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "fcm-assetfs-w-")));
	});
	afterEach(() => {
		jest.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});
	const leftovers = (d: string) => readdirSync(d).filter((f) => f.endsWith(".tmp"));

	describe("prepareOutputDir", () => {
		it("creates a missing folder recursively and returns its realpath", async () => {
			const target = join(dir, "a", "b", "c");
			expect(await fs.prepareOutputDir(target)).toEqual({ root: target, created: true, temp: false });
			expect(statSync(target).isDirectory()).toBe(true);
			expect(await fs.prepareOutputDir(target)).toEqual({ root: target, created: false, temp: false });
			symlinkSync(target, join(dir, "alias"));
			expect((await fs.prepareOutputDir(join(dir, "alias"))).root).toBe(target);
		});

		it("defaults to a fresh private mkdtemp folder", async () => {
			const a = await fs.prepareOutputDir(undefined);
			const b = await fs.prepareOutputDir(undefined);
			try {
				expect(a.temp).toBe(true);
				expect(a.root).not.toBe(b.root);
				expect(a.root).toMatch(/figma-console-mcp-export-[^/\\]+$/);
				if (process.platform !== "win32") expect(statSync(a.root).mode & 0o777).toBe(0o700);
			} finally {
				rmSync(a.root, { recursive: true, force: true });
				rmSync(b.root, { recursive: true, force: true });
			}
		});

		it("refuses a filesystem root (also through a symlink), a relative path and a file", async () => {
			await expect(fs.prepareOutputDir("/")).rejects.toThrow("Pick a folder for the export, not the root of the drive.");
			symlinkSync("/", join(dir, "rootlink"));
			await expect(fs.prepareOutputDir(join(dir, "rootlink"))).rejects.toThrow("Pick a folder for the export, not the root of the drive.");
			await expect(fs.prepareOutputDir("out")).rejects.toThrow("Pass an absolute outputDir.");
			writeFileSync(join(dir, "f"), "x");
			await expect(fs.prepareOutputDir(join(dir, "f"))).rejects.toThrow(`${join(dir, "f")} is a file, not a folder.`);
		});
	});

	describe("resolveInside", () => {
		it("creates nested folders and always resolves inside realpath(root)", async () => {
			const r = await fs.resolveInside(dir, ["Icon", "arrow", "left.svg"]);
			expect(r).toEqual({ ok: true, path: join(dir, "Icon", "arrow", "left.svg"), existing: "missing" });
			expect(statSync(join(dir, "Icon", "arrow")).isDirectory()).toBe(true);
			if (r.ok) expect(r.path.startsWith(dir + sep)).toBe(true);
			writeFileSync(join(dir, "Icon", "arrow", "left.svg"), "x");
			expect(await fs.resolveInside(dir, ["Icon", "arrow", "left.svg"])).toMatchObject({ ok: true, existing: "file" });
		});

		it("refuses a symlinked subfolder pointing outside, a symlinked final target, a file in place of a folder, a folder as the target", async () => {
			const outside = mkdtempSync(join(tmpdir(), "fcm-out-"));
			try {
				symlinkSync(outside, join(dir, "linked"));
				expect(await fs.resolveInside(dir, ["linked", "x.svg"])).toEqual({ ok: false, reason: "Won't write through a symbolic link: linked." });
				writeFileSync(join(outside, "target.svg"), "x");
				symlinkSync(join(outside, "target.svg"), join(dir, "file.svg"));
				expect(await fs.resolveInside(dir, ["file.svg"])).toEqual({ ok: false, reason: "Won't write through a symbolic link: file.svg." });
				expect(readdirSync(outside)).toEqual(["target.svg"]);
			} finally {
				rmSync(outside, { recursive: true, force: true });
			}
			writeFileSync(join(dir, "plain"), "x");
			expect(await fs.resolveInside(dir, ["plain", "x.svg"])).toEqual({ ok: false, reason: '"plain" is a file, not a folder.' });
			mkdirSync(join(dir, "folder.svg"));
			expect(await fs.resolveInside(dir, ["folder.svg"])).toEqual({ ok: false, reason: '"folder.svg" is a folder.' });
		});

		it("refuses unsafe segments even though shared code sanitizes them", async () => {
			for (const segs of [[".."], ["a", "..", "b.svg"], ["a/b.svg"], ["a\\b.svg"], [""], []]) {
				expect(await fs.resolveInside(dir, segs)).toEqual({ ok: false, reason: "Unsafe file name." });
			}
		});
	});

	describe("writeNew", () => {
		it("writes a new file and never leaves temp files", async () => {
			const p = join(dir, "a.svg");
			expect(await fs.writeNew(p, "<svg/>")).toBe("written");
			expect(readFileSync(p, "utf8")).toBe("<svg/>");
			expect(await fs.writeNew(join(dir, "b.png"), new Uint8Array([1, 2, 3]))).toBe("written");
			expect([...readFileSync(join(dir, "b.png"))]).toEqual([1, 2, 3]);
			expect(leftovers(dir)).toEqual([]);
		});

		it('returns "exists" when the target appeared after resolveInside, leaving it untouched', async () => {
			const r = await fs.resolveInside(dir, ["race.svg"]);
			expect(r).toMatchObject({ ok: true, existing: "missing" });
			writeFileSync(join(dir, "race.svg"), "THEIRS");
			expect(await fs.writeNew(join(dir, "race.svg"), "OURS")).toBe("exists");
			expect(readFileSync(join(dir, "race.svg"), "utf8")).toBe("THEIRS");
			expect(leftovers(dir)).toEqual([]);
		});

		it("falls back to an exclusive open when link() fails with EPERM", async () => {
			const fsp = require("fs/promises");
			const spy = jest.spyOn(fsp, "link").mockRejectedValue(Object.assign(new Error("nope"), { code: "EPERM" }));
			expect(await fs.writeNew(join(dir, "fat.svg"), "DATA")).toBe("written");
			expect(spy).toHaveBeenCalled();
			expect(readFileSync(join(dir, "fat.svg"), "utf8")).toBe("DATA");
			writeFileSync(join(dir, "taken.svg"), "KEEP");
			expect(await fs.writeNew(join(dir, "taken.svg"), "DATA")).toBe("exists");
			expect(readFileSync(join(dir, "taken.svg"), "utf8")).toBe("KEEP");
			expect(leftovers(dir)).toEqual([]);
		});

		it("errors carry a code and never include the data", async () => {
			if (process.platform === "win32" || process.getuid?.() === 0) return;
			const ro = join(dir, "ro");
			mkdirSync(ro);
			chmodSync(ro, 0o500);
			try {
				const err = await fs.writeNew(join(ro, "x.svg"), "SECRET_CONTENT_42").catch((e: Error & { code?: string }) => e);
				expect(err).toBeInstanceOf(Error);
				expect((err as Error & { code?: string }).code).toBe("EACCES");
				expect((err as Error).message).not.toContain("SECRET_CONTENT_42");
			} finally {
				chmodSync(ro, 0o700);
			}
		});
	});

	describe("writeReplace", () => {
		it("replaces atomically and leaves no temp file", async () => {
			const p = join(dir, "logo.svg");
			writeFileSync(p, "OLD");
			const before = lstatSync(p).ino;
			await fs.writeReplace(p, "NEW");
			expect(readFileSync(p, "utf8")).toBe("NEW");
			// rename() swaps in a new inode: readers never see a half-written file.
			expect(lstatSync(p).ino).not.toBe(before);
			expect(leftovers(dir)).toEqual([]);
			await fs.writeReplace(join(dir, "fresh.svg"), new Uint8Array([60, 47, 62]));
			expect(readFileSync(join(dir, "fresh.svg"), "utf8")).toBe("</>");
		});
	});
});

describe("createNodeAssetFs (write): review fixes", () => {
	let dir: string;
	let outside: string;
	const fs = createNodeAssetFs();
	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "fcm-assetfs-w2-")));
		outside = realpathSync(mkdtempSync(join(tmpdir(), "fcm-assetfs-out-")));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("refuses when the prepared output folder was moved or replaced with a link", async () => {
		const root = (await fs.prepareOutputDir(join(dir, "out"))).root;
		require("fs").renameSync(root, join(dir, "out-moved"));
		symlinkSync(outside, root);
		expect(await fs.resolveInside(root, ["a.svg"])).toEqual({
			ok: false,
			reason: "The output folder changed while exporting (it was moved or replaced with a link), so nothing more is written into it.",
		});
	});

	it("a parent folder swapped for a link after resolveInside is caught before the file is linked into place", async () => {
		const root = (await fs.prepareOutputDir(join(dir, "out"))).root;
		const res = await fs.resolveInside(root, ["icons", "a.svg"]);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		require("fs").renameSync(join(root, "icons"), join(root, "icons-moved"));
		symlinkSync(outside, join(root, "icons"));
		await expect(fs.writeNew(res.path, "<svg/>")).rejects.toMatchObject({ code: "EUNSAFEPATH" });
		await expect(fs.writeReplace(res.path, "<svg/>")).rejects.toMatchObject({ code: "EUNSAFEPATH" });
		expect(readdirSync(outside)).toEqual([]);
	});
});
