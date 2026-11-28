/**
 * Local file reading for figma_import_image (spec §10.7): listImageFiles and
 * readImageFile, with §2.12's rules. Runs against real temp folders.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createNodeAssetFs } from "../../src/core/assets/node-fs";
import { gif, jpeg, png } from "./image-fixtures";

describe("createNodeAssetFs (images)", () => {
	let dir: string;
	const fs = createNodeAssetFs();
	const PNG = Buffer.from(png(4, 3));

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fcm-imagefs-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const write = (rel: string, data: string | Buffer = PNG) => {
		const p = join(dir, rel);
		mkdirSync(join(p, ".."), { recursive: true });
		writeFileSync(p, data);
		return p;
	};

	it("listImageFiles takes .png/.jpg/.jpeg/.gif in any case and skips everything else listSvgFiles skips", async () => {
		write("a.png");
		write("B.JPG", Buffer.from(jpeg(2, 2)));
		write("c.jpeg", Buffer.from(jpeg(2, 2)));
		write("d.GIF", Buffer.from(gif(2, 2)));
		write("e.webp", "x");
		write("f.svg", "<svg/>");
		write("notes.txt", "x");
		write(".hidden.png");
		write("node_modules/pkg/x.png");
		write("sub/g.png");
		const outside = mkdtempSync(join(tmpdir(), "fcm-imagefs-out-"));
		writeFileSync(join(outside, "evil.png"), PNG);
		symlinkSync(outside, join(dir, "linked"));
		symlinkSync(join(outside, "evil.png"), join(dir, "link.png"));
		try {
			const flat = await fs.listImageFiles(dir, { recursive: false, maxDepth: 6, maxScan: 10_000 });
			expect(flat.files.map((f) => f.relPath).sort()).toEqual(["B.JPG", "a.png", "c.jpeg", "d.GIF"]);
			expect(flat.skippedSubfolders).toBe(true);
			expect(flat.files.find((f) => f.relPath === "a.png")!.size).toBe(PNG.length);
			const deep = await fs.listImageFiles(dir, { recursive: true, maxDepth: 6, maxScan: 10_000 });
			expect(deep.files.map((f) => f.relPath).sort()).toEqual(["B.JPG", "a.png", "c.jpeg", "d.GIF", "sub/g.png"]);
			// The SVG listing is unchanged by the shared walk.
			expect((await fs.listSvgFiles(dir, { recursive: true, maxDepth: 6, maxScan: 10_000 })).files.map((f) => f.relPath)).toEqual(["f.svg"]);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("listImageFiles errors name the folder and point single files at images[].path", async () => {
		await expect(fs.listImageFiles("pics", { recursive: false, maxDepth: 6, maxScan: 10 })).rejects.toThrow('"pics" is a relative path. Pass an absolute path.');
		await expect(fs.listImageFiles(join(dir, "nope"), { recursive: false, maxDepth: 6, maxScan: 10 })).rejects.toThrow(`Folder not found: ${join(dir, "nope")}`);
		const f = write("a.png");
		await expect(fs.listImageFiles(f, { recursive: false, maxDepth: 6, maxScan: 10 })).rejects.toThrow(`${f} is a file, not a folder. Use images[].path for single files.`);
		// The SVG wording is kept.
		await expect(fs.listSvgFiles(f, { recursive: false, maxDepth: 6, maxScan: 10 })).rejects.toThrow(`${f} is a file, not a folder. Use paths for single files.`);
	});

	it("readImageFile returns the exact bytes of a named image file", async () => {
		const p = write("photo.png");
		const r = await fs.readImageFile(p, 1000);
		expect(r.size).toBe(PNG.length);
		expect(Buffer.from(r.bytes).equals(PNG)).toBe(true);
	});

	it("readImageFile rejects relative paths, SVG, WebP and other extensions, folders, missing and oversized files", async () => {
		await expect(fs.readImageFile("pics/a.png", 1000)).rejects.toThrow('"pics/a.png" is a relative path. Pass an absolute path.');
		await expect(fs.readImageFile(write("a.svg", "<svg/>"), 1000)).rejects.toThrow(/a\.svg is an SVG file; import it with figma_import_svg\.$/);
		await expect(fs.readImageFile(write("a.webp", "x"), 1000)).rejects.toThrow(/a\.webp: WebP isn't supported by Figma's plugin image API; convert it to PNG or JPEG first\.$/);
		await expect(fs.readImageFile(write("a.bmp", "x"), 1000)).rejects.toThrow(/a\.bmp isn't a \.png, \.jpg, \.jpeg or \.gif file\.$/);
		mkdirSync(join(dir, "folder.png"));
		await expect(fs.readImageFile(join(dir, "folder.png"), 1000)).rejects.toThrow(/folder\.png is a folder\. Use directory for folders\./);
		await expect(fs.readImageFile(join(dir, "missing.png"), 1000)).rejects.toThrow(`File not found: ${join(dir, "missing.png")}`);
		const big = write("big.png", Buffer.alloc(5000));
		await expect(fs.readImageFile(big, 1000)).rejects.toThrow(`${big} is 0.0 MB; the limit is 0.0 MB.`);
	});

	it("follows a symlink only when named, and only to an image file; errors never include contents", async () => {
		const target = write("real.png");
		symlinkSync(target, join(dir, "named.png"));
		expect(Buffer.from((await fs.readImageFile(join(dir, "named.png"), 1000)).bytes).equals(PNG)).toBe(true);
		const secret = write("secret.txt", "TOP-SECRET-CONTENTS");
		symlinkSync(secret, join(dir, "sneaky.png"));
		const err = await fs.readImageFile(join(dir, "sneaky.png"), 1000).catch((e: Error) => e.message);
		expect(err).toMatch(/links to a file that isn't a \.png, \.jpg, \.jpeg or \.gif file\.$/);
		expect(err).not.toContain("TOP-SECRET");
		symlinkSync(join(dir, "gone.png"), join(dir, "broken.png"));
		await expect(fs.readImageFile(join(dir, "broken.png"), 1000)).rejects.toThrow(/broken\.png is a broken symbolic link\./);
	});
});
