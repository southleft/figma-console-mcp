/**
 * Races the filesystem layer must catch (code review of PR #182):
 *  - a file that grows or shrinks between the size check and the read (an editor still saving it)
 *    must not be imported cut short;
 *  - on filesystems without hard links (exFAT, FAT, some network shares) the fallback write must
 *    re-check where the file landed, like the link path does.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// link() fails with EPERM on filesystems without hard links; the rest of fs/promises is real.
const linkMock = jest.fn(async () => {
	const err = new Error("operation not permitted, link") as Error & { code?: string };
	err.code = "EPERM";
	throw err;
});
jest.mock("node:fs/promises", () => ({ ...jest.requireActual("node:fs/promises"), link: (...a: unknown[]) => linkMock(...(a as [])) }));

import { createNodeAssetFs, readCapped } from "../../src/core/assets/node-fs";

let dir: string;
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "fcm-races-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readCapped: the file must still be the size that was checked", () => {
	it("reads a file of exactly the checked size", async () => {
		const p = join(dir, "a.svg");
		writeFileSync(p, "0123456789");
		expect((await readCapped(p, 10, 100)).toString()).toBe("0123456789");
	});

	it("refuses a file that grew after the size check instead of importing its first bytes", async () => {
		const p = join(dir, "grew.svg");
		writeFileSync(p, "0123456789");
		await expect(readCapped(p, 5, 100)).rejects.toThrow("changed while it was being read");
	});

	it("refuses a file that shrank after the size check", async () => {
		const p = join(dir, "shrank.svg");
		writeFileSync(p, "0123");
		await expect(readCapped(p, 10, 100)).rejects.toThrow("changed while it was being read");
	});

	it("still reports the size limit first", async () => {
		const p = join(dir, "big.svg");
		writeFileSync(p, "x".repeat(50));
		await expect(readCapped(p, 50, 10)).rejects.toThrow("larger than");
	});
});

describe("writeNew without hard links", () => {
	it("falls back to an exclusive write and lands the file", async () => {
		const target = join(dir, "icon.svg");
		await expect(createNodeAssetFs().writeNew(target, "<svg/>")).resolves.toBe("written");
		expect(linkMock).toHaveBeenCalled();
		expect(readFileSync(target, "utf8")).toBe("<svg/>");
	});

	it("never replaces a file that already exists", async () => {
		const target = join(dir, "icon.svg");
		writeFileSync(target, "OLD");
		await expect(createNodeAssetFs().writeNew(target, "<svg/>")).resolves.toBe("exists");
		expect(readFileSync(target, "utf8")).toBe("OLD");
	});

	it("refuses and removes a file whose folder turned into a link after the temp file was checked (the landing check)", async () => {
		const elsewhere = join(dir, "elsewhere");
		mkdirSync(elsewhere);
		const out = join(dir, "out");
		mkdirSync(out);
		// The temp file is written and checked in the real folder; then, at the moment link() fails
		// (no hard links), the folder is swapped for a link to somewhere else.
		linkMock.mockImplementationOnce(async () => {
			const { renameSync } = jest.requireActual("fs");
			renameSync(out, join(dir, "out-moved"));
			symlinkSync(elsewhere, out);
			const err = new Error("operation not permitted, link") as Error & { code?: string };
			err.code = "EPERM";
			throw err;
		});
		const err = await createNodeAssetFs()
			.writeNew(join(out, "icon.svg"), "<svg/>")
			.then(() => null, (e: Error & { code?: string }) => e);
		expect(err?.code).toBe("EUNSAFEPATH");
		// Written through the swapped link, then taken back.
		expect(existsSync(join(elsewhere, "icon.svg"))).toBe(false);
	});
});
