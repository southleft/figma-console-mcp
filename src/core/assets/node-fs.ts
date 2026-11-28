/**
 * Node implementation of AssetFs (spec §2.12). Imported only by src/local.ts:
 * it uses node: builtins, which must stay out of the shared modules and the
 * Worker bundle.
 *
 * Reads are limited to absolute paths of .svg files (figma_import_svg) and
 * .png/.jpg/.jpeg/.gif files (figma_import_image). Error messages name the
 * path the person gave and never include file contents.
 *
 * Writes (spec §3.6) stay under realpath(outputDir): every existing path
 * component is lstat-checked, created folders are re-checked with realpath,
 * the output folder itself must still be the folder that was prepared, the
 * temp file's folder is re-checked with realpath right before it is linked
 * or renamed into place, new files are created with link() so a file that
 * appears mid-call is never replaced, and replacing (overwrite) is an atomic
 * rename. Callers resolve each path again right before writing it. Node has
 * no openat/RESOLVE_BENEATH, so a process that can swap folders under
 * outputDir still has a window of microseconds between the last check and
 * the link/rename; everything before that is checked.
 */

import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, opendir, realpath, rename, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { AssetFs, AssetFsListing, ResolvedPath } from "./fs-types.js";
import { formatMB } from "./limits.js";

function code(e: unknown): string | undefined {
	return (e as { code?: string } | null)?.code;
}

const ROOT_MESSAGE = "Pick a folder for the export, not the root of the drive.";

function isFsRoot(p: string): boolean {
	return parse(p).root === p;
}

/** Defense in depth: shared code sanitizes segments, but this layer never trusts it. */
function unsafeSegment(s: string): boolean {
	return s === "" || s === "." || s === ".." || /[\\/\u0000]/.test(s) || s.length > 255;
}

/** Errors keep their code so the handler can word them with the relative path. */
function rethrow(e: unknown, what: string): never {
	const err = new Error(`${what} (${code(e) ?? "error"}).`) as Error & { code?: string };
	err.code = code(e);
	throw err;
}

/** A folder on the way to a write turned into a symbolic link (or moved) after it was checked. */
function unsafePathError(path: string): Error {
	const err = new Error(`Won't write ${basename(path)}: a folder on its path changed while exporting.`) as Error & { code?: string };
	err.code = "EUNSAFEPATH";
	return err;
}

/**
 * `.<name>.<random>.tmp` next to the target, opened exclusively so nothing is
 * overwritten, then checked: its real folder must be the target's folder
 * (a real path from resolveInside), so a parent swapped for a symlink since
 * the check is caught before anything is linked or renamed into place.
 */
async function writeTemp(path: string, data: Uint8Array | string): Promise<string> {
	const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
	const fh = await open(tmp, "wx", 0o644);
	try {
		await fh.writeFile(data);
	} catch (e) {
		await fh.close().catch(() => {});
		await unlink(tmp).catch(() => {});
		throw e;
	}
	await fh.close();
	let realTmp: string | null = null;
	try {
		realTmp = await realpath(tmp);
	} catch {
		realTmp = null;
	}
	if (!realTmp || dirname(realTmp) !== dirname(path)) {
		await unlink(tmp).catch(() => {});
		throw unsafePathError(path);
	}
	return tmp;
}

/** After link/rename: the file's real folder must still be the checked one (reports a swap in the last window). */
async function checkLanded(path: string): Promise<void> {
	let real: string | null = null;
	try {
		real = await realpath(dirname(path));
	} catch {
		real = null;
	}
	if (real !== dirname(path)) throw unsafePathError(path);
}

/** link() isn't available on every filesystem (FAT, some network shares, cross-device temp dirs). */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EXDEV", "ENOSYS", "EOPNOTSUPP"]);

interface WalkOptions {
	recursive: boolean;
	maxDepth: number;
	maxScan: number;
}

/**
 * Files whose name matches `ext` under an absolute folder. Skips hidden
 * entries, symlinks inside the walk (they could point anywhere, or loop) and
 * nested node_modules. `singleHint` finishes the "is a file" message.
 */
async function listFiles(dir: string, o: WalkOptions, ext: RegExp, singleHint: string): Promise<AssetFsListing> {
	if (!isAbsolute(dir)) throw new Error(`"${dir}" is a relative path. Pass an absolute path.`);
	let root: string;
	try {
		// realpath first, so a symlinked folder (pnpm's node_modules/<pkg>) works.
		root = await realpath(dir);
	} catch (e) {
		if (code(e) === "ENOENT" || code(e) === "ENOTDIR") throw new Error(`Folder not found: ${dir}`);
		if (code(e) === "EACCES") throw new Error(`Can't read ${dir} (permission denied).`);
		throw new Error(`Can't open ${dir}.`);
	}
	const st = await stat(root);
	if (!st.isDirectory()) throw new Error(`${dir} is a file, not a folder. ${singleHint}`);

	const files: AssetFsListing["files"] = [];
	let scanned = 0;
	let truncated = false;
	let skippedSubfolders = false;
	const stack: Array<{ abs: string; depth: number }> = [{ abs: root, depth: 0 }];
	while (stack.length > 0 && !truncated) {
		const { abs, depth } = stack.pop() as { abs: string; depth: number };
		// Streamed and stopped at the scan budget (+1 to notice truncation), so a folder with
		// millions of entries is never read or sorted whole. A truncated listing therefore holds
		// the first entries in the order the filesystem returns them (stable for an unchanged folder).
		const room = o.maxScan - scanned + 1;
		const entries: Dirent[] = [];
		let handle;
		try {
			handle = await opendir(abs);
		} catch {
			continue; // unreadable subfolder: skip it rather than fail the listing
		}
		try {
			for await (const ent of handle) {
				entries.push(ent);
				if (entries.length >= room) break;
			}
		} catch {
			// Unreadable partway: keep what was read.
		} finally {
			await handle.close().catch(() => {});
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const ent of entries) {
			if (++scanned > o.maxScan) {
				truncated = true;
				break;
			}
			if (ent.name.startsWith(".")) continue;
			if (ent.isSymbolicLink()) continue;
			const p = join(abs, ent.name);
			if (ent.isDirectory()) {
				if (ent.name === "node_modules") continue;
				if (o.recursive && depth < o.maxDepth) stack.push({ abs: p, depth: depth + 1 });
				else skippedSubfolders = true;
				continue;
			}
			if (!ent.isFile() || !ext.test(ent.name)) continue;
			let size = 0;
			try {
				size = (await lstat(p)).size;
			} catch {
				continue;
			}
			files.push({ path: p, relPath: relative(root, p).split(sep).join("/"), size });
		}
	}
	return { root, files, scanned: Math.min(scanned, o.maxScan), truncated, skippedSubfolders };
}

/**
 * lstat an explicitly named file: a regular file, or a symlink the person
 * named whose target is a regular file matching `ext`. Size checked here,
 * before anything is read.
 */
async function statNamedFile(path: string, maxBytes: number, ext: RegExp, kind: string): Promise<number> {
	let info;
	try {
		info = await lstat(path);
	} catch (e) {
		if (code(e) === "ENOENT" || code(e) === "ENOTDIR") throw new Error(`File not found: ${path}`);
		if (code(e) === "EACCES") throw new Error(`Can't read ${path} (permission denied).`);
		throw new Error(`Can't read ${path}.`);
	}
	if (info.isSymbolicLink()) {
		let target: string;
		try {
			target = await realpath(path);
			info = await stat(target);
		} catch {
			throw new Error(`${path} is a broken symbolic link.`);
		}
		if (!ext.test(target)) throw new Error(`${path} links to a file that isn't ${kind}.`);
	}
	if (info.isDirectory()) throw new Error(`${path} is a folder. Use directory for folders.`);
	if (!info.isFile()) throw new Error(`${path} isn't a regular file.`);
	if (info.size > maxBytes) throw new Error(`${path} is ${formatMB(info.size)}; the limit is ${formatMB(maxBytes)}.`);
	return info.size;
}

/** Read at most maxBytes + 1, so a file that grew after the size check is still caught. */
async function readCapped(path: string, size: number, maxBytes: number): Promise<Buffer> {
	const fh = await open(path, "r");
	try {
		const chunk = Buffer.alloc(Math.min(maxBytes + 1, Math.max(size, 0) + 1));
		let filled = 0;
		for (;;) {
			const { bytesRead } = await fh.read(chunk, filled, chunk.length - filled, filled);
			if (bytesRead === 0) break;
			filled += bytesRead;
			if (filled >= chunk.length) break;
		}
		const buf = chunk.subarray(0, filled);
		if (buf.length > maxBytes) throw new Error(`${path} is larger than ${formatMB(maxBytes)}.`);
		return buf;
	} finally {
		await fh.close();
	}
}

const SVG_EXT = /\.svg$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif)$/i;

export function createNodeAssetFs(): AssetFs {
	return {
		listSvgFiles(dir, o) {
			return listFiles(dir, o, SVG_EXT, "Use paths for single files.");
		},

		listImageFiles(dir, o) {
			return listFiles(dir, o, IMAGE_EXT, "Use images[].path for single files.");
		},

		async readImageFile(path, maxBytes) {
			if (!isAbsolute(path)) throw new Error(`"${path}" is a relative path. Pass an absolute path.`);
			const name = basename(path);
			if (/\.svgz?$/i.test(name)) throw new Error(`${path} is an SVG file; import it with figma_import_svg.`);
			if (/\.webp$/i.test(name)) throw new Error(`${path}: WebP isn't supported by Figma's plugin image API; convert it to PNG or JPEG first.`);
			if (!IMAGE_EXT.test(name)) throw new Error(`${path} isn't a .png, .jpg, .jpeg or .gif file.`);
			const size = await statNamedFile(path, maxBytes, IMAGE_EXT, "a .png, .jpg, .jpeg or .gif file");
			const buf = await readCapped(path, size, maxBytes);
			return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.length), size: buf.length };
		},

		async readSvgFile(path, maxBytes) {
			if (!isAbsolute(path)) throw new Error(`"${path}" is a relative path. Pass an absolute path.`);
			const name = basename(path);
			if (/\.svgz$/i.test(name)) throw new Error(`${path}: compressed .svgz files aren't supported; unzip it first.`);
			if (!SVG_EXT.test(name)) throw new Error(`${path} isn't an .svg file.`);
			// A symlink is followed only because the person named it, and only to a regular .svg file.
			const size = await statNamedFile(path, maxBytes, SVG_EXT, "an .svg file");
			const buf = await readCapped(path, size, maxBytes);
			return { text: decodeSvgBytes(buf, path), size: buf.length };
		},

		async prepareOutputDir(dir) {
			if (dir === undefined) {
				// Random suffix, mode 0700: other local users can't predict or read it.
				const made = await mkdtemp(join(tmpdir(), "figma-console-mcp-export-"));
				return { root: await realpath(made), created: true, temp: true };
			}
			if (!isAbsolute(dir)) throw new Error("Pass an absolute outputDir.");
			const wanted = resolve(dir);
			if (isFsRoot(wanted)) throw new Error(ROOT_MESSAGE);
			let created = false;
			try {
				const st = await stat(wanted);
				if (!st.isDirectory()) throw new Error(`${dir} is a file, not a folder.`);
			} catch (e) {
				if (code(e) !== "ENOENT") {
					if (e instanceof Error && !code(e)) throw e;
					if (code(e) === "EACCES") throw new Error(`Can't open ${dir} (permission denied).`);
					throw new Error(`Can't open ${dir}.`);
				}
				try {
					await mkdir(wanted, { recursive: true });
					created = true;
				} catch (e2) {
					if (code(e2) === "EACCES") throw new Error(`Can't create ${dir} (permission denied).`);
					throw new Error(`Can't create ${dir}.`);
				}
			}
			const root = await realpath(wanted);
			// A symlink named as outputDir could still point at "/".
			if (isFsRoot(root)) throw new Error(ROOT_MESSAGE);
			return { root, created, temp: false };
		},

		async resolveInside(root, segments): Promise<ResolvedPath> {
			if (!segments.length || segments.some(unsafeSegment)) return { ok: false, reason: "Unsafe file name." };
			const realRoot = await realpath(root);
			// root is the real path prepareOutputDir returned: if it resolves elsewhere now, the folder was
			// moved or replaced with a link, and every path under it would land somewhere else.
			if (realRoot !== resolve(root)) return { ok: false, reason: "The output folder changed while exporting (it was moved or replaced with a link), so nothing more is written into it." };
			const inside = (p: string) => p.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
			let dir = realRoot;
			for (let i = 0; i < segments.length - 1; i++) {
				const rel = segments.slice(0, i + 1).join("/");
				const p = join(dir, segments[i]);
				let st = null;
				try {
					st = await lstat(p);
				} catch (e) {
					if (code(e) !== "ENOENT") return { ok: false, reason: `Can't use "${rel}" (${code(e) ?? "error"}).` };
				}
				if (st?.isSymbolicLink()) return { ok: false, reason: `Won't write through a symbolic link: ${rel}.` };
				if (st && !st.isDirectory()) return { ok: false, reason: `"${rel}" is a file, not a folder.` };
				if (!st) {
					try {
						await mkdir(p, { mode: 0o755 });
					} catch (e) {
						if (code(e) !== "EEXIST") return { ok: false, reason: `Can't create the folder "${rel}" (${code(e) ?? "error"}).` };
						// Created meanwhile: check what it is now.
						const again = await lstat(p);
						if (again.isSymbolicLink()) return { ok: false, reason: `Won't write through a symbolic link: ${rel}.` };
						if (!again.isDirectory()) return { ok: false, reason: `"${rel}" is a file, not a folder.` };
					}
				}
				// Catches a symlink swapped in between the lstat and here.
				const real = await realpath(p);
				if (!inside(real)) return { ok: false, reason: `Won't write through a symbolic link: ${rel}.` };
				dir = real;
			}
			const rel = segments.join("/");
			const target = join(dir, segments[segments.length - 1]);
			try {
				const st = await lstat(target);
				if (st.isSymbolicLink()) return { ok: false, reason: `Won't write through a symbolic link: ${rel}.` };
				if (st.isDirectory()) return { ok: false, reason: `"${rel}" is a folder.` };
				if (!st.isFile()) return { ok: false, reason: `"${rel}" isn't a regular file.` };
				return { ok: true, path: target, existing: "file" };
			} catch (e) {
				if (code(e) !== "ENOENT") return { ok: false, reason: `Can't use "${rel}" (${code(e) ?? "error"}).` };
				return { ok: true, path: target, existing: "missing" };
			}
		},

		async writeNew(path, data) {
			let tmp: string;
			try {
				tmp = await writeTemp(path, data);
			} catch (e) {
				rethrow(e, `Couldn't write ${basename(path)}`);
			}
			try {
				// link() fails with EEXIST instead of replacing, so a file that
				// appeared after resolveInside is never clobbered.
				await link(tmp, path);
				await checkLanded(path);
				return "written";
			} catch (e) {
				if (code(e) === "EEXIST") return "exists";
				if (!NO_HARD_LINKS.has(code(e) ?? "")) rethrow(e, `Couldn't write ${basename(path)}`);
				let fh;
				try {
					fh = await open(path, "wx", 0o644);
				} catch (e2) {
					if (code(e2) === "EEXIST") return "exists";
					rethrow(e2, `Couldn't write ${basename(path)}`);
				}
				try {
					await fh.writeFile(data);
				} finally {
					await fh.close();
				}
				return "written";
			} finally {
				await unlink(tmp).catch(() => {});
			}
		},

		async writeReplace(path, data) {
			let tmp: string;
			try {
				tmp = await writeTemp(path, data);
			} catch (e) {
				rethrow(e, `Couldn't write ${basename(path)}`);
			}
			try {
				// rename() replaces atomically: readers see the old file or the new one, never half of it.
				await rename(tmp, path);
			} catch (e) {
				await unlink(tmp).catch(() => {});
				rethrow(e, `Couldn't replace ${basename(path)}`);
			}
			await checkLanded(path);
		},
	};
}

/** UTF-8 (BOM stripped), or UTF-16 LE/BE by BOM; anything else must be valid UTF-8. */
export function decodeSvgBytes(buf: Uint8Array, path: string): string {
	if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return utf8(buf.subarray(3), path);
	if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
	if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
		const body = buf.subarray(2);
		const swapped = new Uint8Array(body.length - (body.length % 2));
		for (let i = 0; i + 1 < body.length; i += 2) {
			swapped[i] = body[i + 1];
			swapped[i + 1] = body[i];
		}
		return new TextDecoder("utf-16le").decode(swapped);
	}
	return utf8(buf, path);
}

function utf8(buf: Uint8Array, path: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buf);
	} catch {
		throw new Error(`${path} isn't UTF-8 text.`);
	}
}
