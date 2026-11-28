/**
 * Filesystem access for the asset tools, injected by the entry point
 * (the registerAdherenceTools({ readFile, listDir }) precedent).
 *
 * Local Mode passes createNodeAssetFs() from ./node-fs.ts; Cloud passes
 * nothing, and the tools then reject file features with the Cloud message, so
 * Cloud can't half-work. Type-only: safe to import from the Worker bundle.
 *
 * Path joining and containment live only in implementations of this
 * interface; shared modules handle relative paths as string segments.
 */

import type { FigmaAPI } from "../figma-api.js";

export interface AssetFsListing {
	/** realpath of the folder that was listed. */
	root: string;
	files: Array<{ path: string; relPath: string; size: number }>;
	/** Directory entries looked at (files and folders). */
	scanned: number;
	/** The scan cap was reached; the listing is partial. */
	truncated: boolean;
	/** Subfolders exist that weren't walked (recursive was false or depth ran out). */
	skippedSubfolders: boolean;
}

export interface AssetFs {
	/**
	 * .svg files under an absolute folder: no hidden entries, no symlinks inside
	 * the walk, no nested node_modules. Throws with a message naming `dir` only.
	 */
	listSvgFiles(dir: string, o: { recursive: boolean; maxDepth: number; maxScan: number }): Promise<AssetFsListing>;
	/**
	 * Read one absolute .svg file (size checked before reading; UTF-8, or UTF-16
	 * by BOM). Throws with a message naming `path` only, never file contents.
	 */
	readSvgFile(path: string, maxBytes: number): Promise<{ text: string; size: number }>;

	// ---- Raster images (figma_import_image, spec §10.7) ----

	/** .png/.jpg/.jpeg/.gif files under an absolute folder, with listSvgFiles' walk rules. */
	listImageFiles(dir: string, o: { recursive: boolean; maxDepth: number; maxScan: number }): Promise<AssetFsListing>;
	/**
	 * Read one absolute .png/.jpg/.jpeg/.gif file (size checked before reading).
	 * The bytes aren't validated here: the shared code checks magic bytes, so a
	 * mislabelled file never reaches Figma. Throws naming `path` only.
	 */
	readImageFile(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; size: number }>;

	// ---- Export half (figma_export_assets, spec §3.6) ----

	/**
	 * realpath of an absolute folder, created recursively when missing; refuses a
	 * filesystem root. `undefined` makes a fresh private temp folder.
	 * Throws with a message that names the folder only.
	 */
	prepareOutputDir(dir: string | undefined): Promise<{ root: string; created: boolean; temp: boolean }>;
	/**
	 * Join already-sanitized segments under `root`, creating missing folders.
	 * Never follows a symbolic link and never resolves outside realpath(root);
	 * reasons name the path relative to root.
	 */
	resolveInside(root: string, segments: string[]): Promise<ResolvedPath>;
	/** No-clobber write: temp file + link(). "exists" when the target appeared meanwhile (left untouched). */
	writeNew(path: string, data: Uint8Array | string): Promise<"written" | "exists">;
	/** Atomic replace: temp file + rename(). Only with overwrite: true. */
	writeReplace(path: string, data: Uint8Array | string): Promise<void>;
}

export type ResolvedPath = { ok: true; path: string; existing: "missing" | "file" } | { ok: false; reason: string };

export interface AssetToolsOptions {
	/** Cloud Mode: fileKey is rejected and batches are capped lower. Defaults to `!fs`. */
	isRemoteMode?: boolean;
	/** Local Mode filesystem; absent in Cloud Mode. */
	fs?: AssetFs;
	/**
	 * REST access for figma_export_assets output "urls" (unused by the import
	 * tool, which never calls REST). Local passes () => this.getFigmaAPI(), which
	 * throws without FIGMA_ACCESS_TOKEN; Cloud passes its session API.
	 */
	getFigmaAPI?: () => Promise<FigmaAPI>;
}
