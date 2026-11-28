/**
 * Pure planning for figma_import_image (spec §10): argument normalization and
 * cross-field rules, base64 handling, magic-byte format checks and pixel
 * sizes, the size of new layers, per-item actions from the preflight, layout,
 * chunking by bytes and the response envelope.
 *
 * No I/O and no Node APIs, so it runs in Workers and every rule is
 * unit-testable. Image bytes are untrusted: the format comes from magic
 * bytes only (never the extension or a declared MIME type), and nothing here
 * ever puts image data into a message.
 */

import { normalizeNodeId } from "../figma-api.js";
import { decodeBase64, rasterSize } from "./export-plan.js";
import { CLOUD_FILEKEY_MESSAGE, type LayoutPlan, unfinished, xyNotes } from "./import-plan.js";
import {
	CLOUD_MAX_IMAGES_PER_CALL,
	DEFAULT_IMAGE_DIRECTORY_LIMIT,
	IMAGE_CHUNK_MAX_B64,
	IMAGE_CHUNK_MAX_ITEMS,
	MAX_FILL_TARGETS_PER_CALL,
	MAX_FILL_TARGETS_PER_IMAGE,
	MAX_FULL_ITEMS,
	MAX_IMAGES_PER_CALL,
	MAX_IMAGE_SIDE,
	MAX_INLINE_IMAGE_TOTAL_B64,
	MAX_NOTES_PER_ITEM,
	MAX_PATH_LENGTH,
	formatMB,
} from "./limits.js";
import type { StopReason } from "./run-control.js";
import { cleanName, contentHash } from "./svg-naming.js";

// ===========================================================================
// Arguments
// ===========================================================================

export type ScaleMode = "FILL" | "FIT" | "CROP" | "TILE";
export type ImageFormat = "png" | "jpeg" | "gif";
export type FitMode = "contain" | "exact";
export type ContainerMode = "auto" | "section" | "frame" | "none";

export interface ImageInputArg {
	data?: string;
	path?: string;
	name?: string;
	nodeIds?: string[];
}

/** Raw arguments as the schema accepts them (every field optional). */
export interface ImportImageArgs {
	images?: ImageInputArg[];
	directory?: string;
	recursive?: boolean;
	offset?: number;
	limit?: number;
	nodeIds?: string[];
	parentId?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	fit?: FitMode;
	density?: number;
	scaleMode?: ScaleMode;
	nodeType?: "rectangle" | "frame";
	layout?: { container?: ContainerMode; containerName?: string; columns?: number; gap?: number; padding?: number };
	focus?: boolean;
	dryRun?: boolean;
	resumeRunId?: string;
	verbose?: boolean;
	fileKey?: string;
}

export interface NormalizedImageArgs {
	images: ImageInputArg[];
	directory?: string;
	recursive: boolean;
	offset: number;
	limit: number;
	/** recursive/offset/limit were passed (Cloud rejects them). */
	pagingGiven: boolean;
	/** Top-level shorthand for images[0].nodeIds. */
	nodeIds?: string[];
	parentId?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	fit: FitMode;
	density?: number;
	scaleMode: ScaleMode;
	nodeType: "rectangle" | "frame";
	layout: { container: ContainerMode; containerName: string; columns?: number; gap: number; padding: number };
	focus: boolean;
	dryRun: boolean;
	resumeRunId?: string;
	verbose: boolean;
	fileKey?: string;
}

const normIds = (ids: string[] | undefined): string[] | undefined => (ids ? [...new Set(ids.map(normalizeNodeId))] : undefined);

/** Every default applied in code: tests call handlers with raw arguments, so zod defaults can't be relied on. */
export function normalizeImageArgs(a: ImportImageArgs): NormalizedImageArgs {
	return {
		images: (a.images ?? []).map((img) => ({ data: img.data, path: img.path, name: img.name, nodeIds: normIds(img.nodeIds) })),
		directory: a.directory,
		recursive: a.recursive ?? false,
		offset: a.offset ?? 0,
		limit: a.limit ?? DEFAULT_IMAGE_DIRECTORY_LIMIT,
		pagingGiven: a.recursive !== undefined || a.offset !== undefined || a.limit !== undefined,
		nodeIds: normIds(a.nodeIds),
		parentId: a.parentId ? normalizeNodeId(a.parentId) : undefined,
		x: a.x,
		y: a.y,
		width: a.width,
		height: a.height,
		fit: a.fit ?? "contain",
		density: a.density,
		scaleMode: a.scaleMode ?? "FILL",
		nodeType: a.nodeType ?? "rectangle",
		layout: {
			container: a.layout?.container ?? "auto",
			containerName: a.layout?.containerName ?? "Images",
			columns: a.layout?.columns,
			gap: a.layout?.gap ?? 24,
			padding: a.layout?.padding ?? 40,
		},
		focus: a.focus ?? true,
		dryRun: a.dryRun ?? false,
		resumeRunId: a.resumeRunId,
		verbose: a.verbose ?? false,
		fileKey: a.fileKey,
	};
}

export const CLOUD_IMAGE_FILES_MESSAGE =
	"path and directory read files from disk, which only Local Mode can do. Cloud Mode has no filesystem: pass the image as base64 in images[].data instead.";

const isAbsolutePath = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");

const MAX_ID_LENGTH = 500;
const inRange = (v: number | undefined, lo: number, hi: number, int = false) => v === undefined || (Number.isFinite(v) && v >= lo && v <= hi && (!int || Number.isInteger(v)));

/**
 * The schema's ranges and lengths, again: handlers are also called without
 * zod (tests, internal callers), and every input must stay bounded.
 */
function rangeProblem(n: NormalizedImageArgs): string | null {
	for (let i = 0; i < n.images.length; i++) {
		const ids = n.images[i].nodeIds;
		if (ids && ids.length > MAX_FILL_TARGETS_PER_IMAGE) return `images[${i}].nodeIds lists ${ids.length} layers; the limit per image is ${MAX_FILL_TARGETS_PER_IMAGE}.`;
		if ((n.images[i].path?.length ?? 0) > MAX_PATH_LENGTH) return `images[${i}].path is longer than ${MAX_PATH_LENGTH} characters.`;
	}
	if ((n.nodeIds?.length ?? 0) > MAX_FILL_TARGETS_PER_IMAGE) return `nodeIds lists ${n.nodeIds?.length} layers; the limit per image is ${MAX_FILL_TARGETS_PER_IMAGE}.`;
	const ids = [...n.images.flatMap((i) => i.nodeIds ?? []), ...(n.nodeIds ?? []), ...(n.parentId ? [n.parentId] : [])];
	if (ids.some((id) => !id || id.length > MAX_ID_LENGTH)) return `Node ids must be 1–${MAX_ID_LENGTH} characters.`;
	if ((n.directory?.length ?? 0) > MAX_PATH_LENGTH) return `directory is longer than ${MAX_PATH_LENGTH} characters.`;
	if ((n.fileKey?.length ?? 0) > 100) return "fileKey is longer than 100 characters.";
	if (n.layout.containerName.length < 1 || n.layout.containerName.length > 200) return "layout.containerName must be 1–200 characters.";
	if (!inRange(n.width, 1, 16_384) || !inRange(n.height, 1, 16_384)) return "width and height must be between 1 and 16384.";
	if (!inRange(n.density, 0.25, 8)) return "density must be between 0.25 and 8.";
	if (!inRange(n.x, -1e6, 1e6) || !inRange(n.y, -1e6, 1e6)) return "x and y must be between -1000000 and 1000000.";
	if (!inRange(n.offset, 0, Number.MAX_SAFE_INTEGER, true) || !inRange(n.limit, 1, MAX_IMAGES_PER_CALL, true)) return `offset must be a whole number ≥ 0 and limit a whole number from 1 to ${MAX_IMAGES_PER_CALL}.`;
	if (!inRange(n.layout.columns, 1, 100, true) || !inRange(n.layout.gap, 0, 1000) || !inRange(n.layout.padding, 0, 1000)) return "layout.columns must be 1–100 and layout.gap/padding 0–1000.";
	return null;
}

export interface ImageValidation {
	error?: string;
	hint?: string;
	notes: string[];
}

/**
 * Cross-field rules (spec §10.4). Fatal before contacting Figma. On success
 * the top-level nodeIds shorthand is moved onto images[0].
 */
export function validateImageArgs(n: NormalizedImageArgs, ctx: { hasFs: boolean; remote: boolean }): ImageValidation {
	const notes: string[] = [];
	const fail = (error: string, hint?: string): ImageValidation => ({ error, ...(hint ? { hint } : {}), notes });
	if (!n.images.length && !n.directory) {
		return fail("Nothing to import: pass images (base64 data, or in Local Mode a file path), or in Local Mode a directory.");
	}
	if (!ctx.hasFs && (n.images.some((i) => i.path !== undefined) || n.directory || n.pagingGiven)) return fail(CLOUD_IMAGE_FILES_MESSAGE);
	if (ctx.remote && n.fileKey) return fail(CLOUD_FILEKEY_MESSAGE);
	if (ctx.remote && n.images.length > CLOUD_MAX_IMAGES_PER_CALL) {
		return fail(`Cloud Mode imports up to ${CLOUD_MAX_IMAGES_PER_CALL} images per call. Split the batch into several calls.`);
	}
	for (let i = 0; i < n.images.length; i++) {
		const img = n.images[i];
		const hasData = img.data !== undefined;
		const hasPath = img.path !== undefined;
		if (hasData && hasPath) return fail(`images[${i}] needs data (base64) or path, not both.`);
		if (!hasData && !hasPath) return fail(`images[${i}] needs data (base64) or path.`);
	}
	let inline = 0;
	for (const img of n.images) inline += img.data?.length ?? 0;
	if (inline > MAX_INLINE_IMAGE_TOTAL_B64) {
		return fail(
			`The inline images total ${formatMB(inline)} of base64; the limit per call is ${formatMB(MAX_INLINE_IMAGE_TOTAL_B64)}. Split them into several calls (or, in Local Mode, pass file paths).`,
		);
	}
	if (n.images.length > MAX_IMAGES_PER_CALL) {
		return fail(`Too many images in one call: ${n.images.length}; the limit is ${MAX_IMAGES_PER_CALL}. Split the call.`);
	}
	if (n.directory && n.images.length >= MAX_IMAGES_PER_CALL) {
		return fail(`Too many images in one call: ${n.images.length} in images leave no room for the directory; the limit is ${MAX_IMAGES_PER_CALL}. Split the call.`);
	}
	if (n.nodeIds) {
		if (n.images.length !== 1 || n.directory) return fail("nodeIds applies to a single image. For several images, give each one its own images[i].nodeIds.");
		if (n.images[0].nodeIds) return fail("Use nodeIds or images[0].nodeIds, not both.");
	}
	const targets = n.images.reduce((s, img) => s + (img.nodeIds?.length ?? 0), 0) + (n.nodeIds?.length ?? 0);
	if (targets > MAX_FILL_TARGETS_PER_CALL) return fail(`Too many layers to fill in one call: ${targets}; the limit is ${MAX_FILL_TARGETS_PER_CALL}. Split the call.`);
	const range = rangeProblem(n);
	if (range) return fail(range);
	if (n.fit === "exact" && (n.width === undefined || n.height === undefined)) return fail('fit "exact" needs both width and height.');
	for (const p of [...n.images.map((i) => i.path).filter((p): p is string => p !== undefined), ...(n.directory ? [n.directory] : [])]) {
		if (!isAbsolutePath(p)) return fail(`"${p.slice(0, 300)}" is a relative path. Pass an absolute path.`);
	}
	if (n.nodeIds) {
		n.images[0].nodeIds = n.nodeIds;
		n.nodeIds = undefined;
	}
	const allFills = !n.directory && n.images.every((i) => i.nodeIds);
	if (allFills && (n.width !== undefined || n.height !== undefined || n.nodeType !== "rectangle")) {
		notes.push("width, height, fit and nodeType apply to new layers; layers given in nodeIds keep their size and type.");
	}
	return { notes };
}

// ===========================================================================
// Base64
// ===========================================================================

export type Base64Result = { ok: true; b64: string; bytes: number } | { ok: false; error: string };

/** A data: URL header is short; bounding it keeps the anchored match cheap on a 12 MB string. */
const DATA_URL = /^data:([^,]{0,256}),/i;
const B64_BODY = /^[A-Za-z0-9+/]+$/;

/**
 * Standard, padded base64 from what a caller may send: a data: URL, line
 * breaks, base64url, missing padding. Linear time; no regex that can
 * backtrack over the payload. Errors are fragments to append to the source
 * ("images[2].data …") and never quote the input.
 */
export function normalizeBase64(input: string): Base64Result {
	let s = input.trim();
	const m = DATA_URL.exec(s);
	if (m) {
		if (!/;base64$/i.test(m[1].trim())) return { ok: false, error: "is a data: URL without ;base64. Only base64 data: URLs are supported." };
		s = s.slice(m[0].length);
	}
	if (/\s/.test(s)) s = s.replace(/\s+/g, "");
	// base64url → base64 (harmless on standard input: neither character is in its alphabet).
	if (s.indexOf("-") >= 0 || s.indexOf("_") >= 0) s = s.replace(/-/g, "+").replace(/_/g, "/");
	let end = s.length;
	let pad = 0;
	while (end > 0 && s.charCodeAt(end - 1) === 61 && pad < 3) {
		end--;
		pad++;
	}
	if (pad > 2) return { ok: false, error: "isn't valid base64." };
	const body = end === s.length ? s : s.slice(0, end);
	if (!body.length) return { ok: false, error: "is empty." };
	if (!B64_BODY.test(body) || body.length % 4 === 1 || (pad > 0 && (body.length + pad) % 4 !== 0)) return { ok: false, error: "isn't valid base64." };
	const b64 = body + "==".slice(0, (4 - (body.length % 4)) % 4);
	return { ok: true, b64, bytes: Math.floor((body.length * 3) / 4) };
}

/** Base64 of file bytes (Local Mode). Buffer when present; a btoa loop otherwise. */
export function encodeBase64(b: Uint8Array): string {
	const g = globalThis as { Buffer?: { from(a: ArrayBufferLike, offset: number, length: number): { toString(enc: string): string } } };
	if (g.Buffer) return g.Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64");
	let bin = "";
	for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
	return btoa(bin);
}

/**
 * Content hash of an image's base64, for resume matching. Native SHA-256
 * (Web Crypto, in Node 20+ and Workers): a JS hash loop over 11 M characters
 * per image would cost seconds per call. cyrb53 only if Web Crypto is missing.
 */
export async function dataHash(b64: string): Promise<string> {
	const subtle = (globalThis as { crypto?: { subtle?: { digest(alg: string, data: Uint8Array): Promise<ArrayBuffer> } } }).crypto?.subtle;
	if (!subtle) return contentHash(b64);
	const digest = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(b64)));
	return Array.from(digest.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Base64 characters decoded for the header checks (≈ 64 KiB; a multiple of 4). */
export const HEAD_B64_CHARS = 87_384;

// ===========================================================================
// Format and pixel size
// ===========================================================================

export const FORMAT_LABEL: Readonly<Record<ImageFormat, string>> = { png: "PNG", jpeg: "JPEG", gif: "GIF" };

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/**
 * The image type from magic bytes. Only PNG, JPEG and GIF are accepted
 * (createImage's documented formats); the rest get a message naming what the
 * bytes are, so the caller knows what to convert.
 */
export function identifyImage(b: Uint8Array): { ok: true; format: ImageFormat } | { ok: false; error: string } {
	if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return { ok: true, format: "png" };
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ok: true, format: "jpeg" };
	if (b.length >= 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return { ok: true, format: "gif" };
	const not = (what: string) => ({ ok: false as const, error: `This is ${what}; Figma's plugin API takes PNG, JPEG or GIF. Convert it first.` });
	if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return not("a WebP image");
	if (b.length >= 12 && ascii(b, 4, 8) === "ftyp") {
		const brand = ascii(b, 8, 12);
		if (brand === "avif" || brand === "avis") return not("an AVIF image");
		if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return not("a HEIC image");
	}
	if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a))) return not("a TIFF image");
	if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return not("an ICO icon");
	if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return not("a BMP image");
	if (b.length >= 4 && ascii(b, 0, 4) === "%PDF") return not("a PDF");
	// SVG: text whose first tag is <svg (after a BOM, whitespace, an XML prolog or comments).
	const bom = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
	const head = ascii(b, bom, Math.min(b.length, bom + 1024));
	if (/^\s*</.test(head) && /<svg[\s>]/i.test(head)) return { ok: false, error: "This is SVG markup; import it with figma_import_svg." };
	return { ok: false, error: "This isn't a PNG, JPEG or GIF image (unrecognized file signature)." };
}

/** Pixel size from the header: PNG IHDR, GIF logical screen, JPEG SOF. null when it isn't there (truncated or damaged). */
export function imagePixelSize(b: Uint8Array, format: ImageFormat): { width: number; height: number } | null {
	if (format === "gif") return b.length >= 10 ? { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) } : null;
	return rasterSize(b);
}

export type Inspected = { ok: true; format: ImageFormat; width: number; height: number } | { ok: false; error: string };

/**
 * Format and pixel size, with the 4096 px check. `head` is enough for PNG and
 * GIF; a JPEG's SOF can sit behind large EXIF/ICC segments, so `all` is
 * consulted only when the head runs out first.
 */
export function inspectImage(head: Uint8Array, all?: () => Uint8Array): Inspected {
	const id = identifyImage(head);
	if (!id.ok) return id;
	let size = imagePixelSize(head, id.format);
	if (!size && id.format === "jpeg" && all) size = imagePixelSize(all(), id.format);
	if (!size) return { ok: false, error: `Couldn't read the image's pixel size from its ${FORMAT_LABEL[id.format]} header; the file may be truncated or damaged.` };
	if (size.width === 0 || size.height === 0) return { ok: false, error: `The image has no pixels (${size.width}×${size.height}).` };
	if (size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE) {
		return {
			ok: false,
			error: `This image is ${size.width}×${size.height} px; Figma's plugin API takes images up to ${MAX_IMAGE_SIDE} px on each side. Scale it down first.`,
		};
	}
	return { ok: true, format: id.format, width: size.width, height: size.height };
}

/** The format a file extension claims, for the "despite its extension" note. */
export function formatFromExtension(path: string): ImageFormat | null {
	const m = /\.(png|jpe?g|gif)$/i.exec(path);
	if (!m) return null;
	const e = m[1].toLowerCase();
	return e === "png" ? "png" : e === "gif" ? "gif" : "jpeg";
}

// ===========================================================================
// Names and sizes
// ===========================================================================

/** "photo.png" → "photo"; works on / and \ paths. */
export function fileStem(path: string): string {
	const base = path.split(/[\\/]/).pop() ?? path;
	return base.replace(/\.(png|jpe?g|gif)$/i, "");
}

/** Layer name: images[i].name, else the file name without extension, else "Image". */
export function imageName(given: string | undefined, path: string | undefined): string {
	const raw = given !== undefined ? given : path !== undefined ? fileStem(path) : "";
	return cleanName(raw) || "Image";
}

/**
 * Pixels per layer unit from an "@2x"-style suffix (Figma's own convention
 * for retina exports), so a hero@2x.png lands at its 1x size.
 */
export function densityFromName(name: string): number | undefined {
	const m = /@(\d{1,2}(?:\.\d{1,2})?)x$/i.exec(name);
	if (!m) return undefined;
	const d = Number(m[1]);
	return d >= 0.25 && d <= 8 ? d : undefined;
}

/**
 * Size of a new layer (spec §10.4). The plugin body has the same function
 * (image-scripts.ts) and recomputes from Figma's own pixel size; a test keeps
 * the two in step.
 */
export function displaySize(pw: number, ph: number, density: number, box: { w?: number; h?: number } | null, fit: FitMode): { w: number; h: number } {
	let w = pw / density;
	let h = ph / density;
	if (box && box.w !== undefined && box.h !== undefined) {
		if (fit === "exact") {
			w = box.w;
			h = box.h;
		} else {
			const s = Math.min(box.w / w, box.h / h);
			w *= s;
			h *= s;
		}
	} else if (box && box.w !== undefined) {
		h = (h * box.w) / w;
		w = box.w;
	} else if (box && box.h !== undefined) {
		w = (w * box.h) / h;
		h = box.h;
	}
	const r = (v: number) => Math.max(0.01, Math.round(v * 100) / 100);
	return { w: r(w), h: r(h) };
}

export function boxOf(n: NormalizedImageArgs): { w?: number; h?: number } | null {
	if (n.width === undefined && n.height === undefined) return null;
	return { ...(n.width !== undefined ? { w: n.width } : {}), ...(n.height !== undefined ? { h: n.height } : {}) };
}

// ===========================================================================
// Items and preflight
// ===========================================================================

export type ImageStatus = "failed" | "unknown" | "updated" | "created" | "unchanged";
export type ImageAction = "create" | "fill" | "unchanged" | "fail";

export interface ImageItem {
	key: string;
	/** "images[2]" for inline data, the path for images[i].path, the relative path for directory files. */
	source: string;
	kind: "inline" | "path" | "dir";
	name: string;
	/** Normalized base64, sent to the plugin; never logged or returned. */
	data?: string;
	bytes?: number;
	format?: ImageFormat;
	pixelWidth?: number;
	pixelHeight?: number;
	density: number;
	/** Content hash of `data`, for resume matching. */
	hash?: string;
	nodeIds?: string[];
	targetIds?: string[];
	targets?: Array<{ id: string; name?: string; type?: string }>;
	planned?: { w: number; h: number };
	action?: ImageAction;
	status?: ImageStatus;
	stage?: "read" | "decode" | "format" | "plan" | "import" | "process";
	reason?: string;
	notes: string[];
	nodeId?: string;
	type?: string;
	width?: number;
	height?: number;
	imageHash?: string;
	filled?: Array<{ id: string; name: string }>;
}

export function failItem(it: ImageItem, stage: NonNullable<ImageItem["stage"]>, reason: string): void {
	it.action = "fail";
	it.status = "failed";
	it.stage = stage;
	it.reason = reason;
}

export interface ImagePreflight {
	fatal?: string;
	editorType: string;
	fileKey: string | null;
	fileName: string;
	parent?: { id: string; type: string; name: string; autoLayout: boolean; pageId: string | null; pageName?: string | null; onCurrentPage: boolean };
	container?: { id: string; type: string; name: string; autoLayout: boolean };
	resumed?: Array<{ source: string; hash: string; nodeId: string; type?: string; width?: number; height?: number; imageHash?: string }>;
	targets: Array<{ id: string; found: boolean; type?: string; name?: string; fillable?: boolean; why?: string; width?: number; height?: number }>;
}

/** Unique fill-target ids of the items still in play, for the preflight. */
export function targetIdsOf(items: ImageItem[]): string[] {
	const out = new Set<string>();
	for (const it of items) if (!it.status && it.nodeIds) for (const id of it.nodeIds) out.add(id);
	return [...out];
}

const listShort = (parts: string[], max = 5) => (parts.length <= max ? parts.join("; ") : `${parts.slice(0, max).join("; ")}; and ${parts.length - max} more`);

/**
 * Actions from the preflight: fills keep only the layers that can take an
 * image fill (and fail when none can); layers an interrupted run already
 * placed become "unchanged"; everything else is created.
 */
export function planImages(items: ImageItem[], pre: ImagePreflight, n: NormalizedImageArgs): void {
	const targets = new Map(pre.targets.map((t) => [t.id, t]));
	const resumed = new Map((pre.resumed ?? []).map((r) => [`${r.source}\u0000${r.hash}`, r]));
	const box = boxOf(n);
	for (const it of items) {
		if (it.status) continue;
		if (it.nodeIds) {
			const usable: string[] = [];
			const problems: string[] = [];
			it.targets = [];
			for (const id of it.nodeIds) {
				const t = targets.get(id);
				if (!t || !t.found) {
					problems.push(`${id} wasn't found`);
					continue;
				}
				if (!t.fillable) {
					problems.push(`"${t.name ?? id}" (${id}) ${t.why ?? "can't take fills"}`);
					continue;
				}
				usable.push(id);
				it.targets.push({ id, name: t.name, type: t.type });
			}
			if (!usable.length) {
				failItem(it, "plan", `None of the layers can take an image fill: ${listShort(problems)}. Node ids change between sessions; get fresh ones from the file.`);
				continue;
			}
			it.targetIds = usable;
			it.action = "fill";
			if (problems.length) it.notes.push(`Not filled: ${listShort(problems)}.`);
			continue;
		}
		const r = resumed.get(`${it.source}\u0000${it.hash}`);
		if (r) {
			Object.assign(it, { action: "unchanged" as const, nodeId: r.nodeId, type: r.type, width: r.width, height: r.height, imageHash: r.imageHash });
			it.notes.push(`Placed by the interrupted run ${n.resumeRunId}; not placed again.`);
			continue;
		}
		it.action = "create";
		if (it.pixelWidth && it.pixelHeight) it.planned = displaySize(it.pixelWidth, it.pixelHeight, it.density, box, n.fit);
	}
}

// ===========================================================================
// Layout (spec §10.4: §2.6.6's rules, a near-square default grid)
// ===========================================================================

export function defaultImageColumns(count: number): number {
	return Math.max(1, Math.min(12, Math.ceil(Math.sqrt(Math.max(1, count)))));
}

export function planImageLayout(items: ImageItem[], pre: ImagePreflight, n: NormalizedImageArgs): LayoutPlan {
	const creates = items.filter((it) => it.action === "create");
	const plan: LayoutPlan = {
		container: "none",
		containerName: n.layout.containerName,
		mode: "single",
		columns: n.layout.columns ?? defaultImageColumns(creates.length),
		gap: n.layout.gap,
		padding: n.layout.padding,
		notes: [],
	};
	const parent = pre.parent;
	if (!creates.length || !parent) return plan;
	let container: LayoutPlan["container"];
	if (n.layout.container === "auto") {
		if (creates.length <= 1 || parent.autoLayout) container = "none";
		else if (pre.editorType === "figjam") container = "section";
		else container = "frame";
		// Sections only live on pages or inside sections.
		if (container === "section" && parent.type !== "PAGE" && parent.type !== "SECTION") container = "none";
	} else container = n.layout.container;
	plan.container = container;
	if (container !== "none" && pre.container) {
		plan.reuse = { id: pre.container.id, type: pre.container.type, autoLayout: pre.container.autoLayout };
		if (n.x !== undefined || n.y !== undefined) plan.notes.push(`x/y ignored: the existing "${n.layout.containerName}" was reused.`);
	} else if (container === "section" && parent.type !== "PAGE" && parent.type !== "SECTION") {
		plan.error = `A section can only go on a page or inside another section; the parent is a ${parent.type}. Use layout.container "frame" or "none".`;
	}
	const targetAutoLayout = plan.reuse ? plan.reuse.autoLayout : container === "frame" ? true : container === "none" ? parent.autoLayout : false;
	const uniform = n.width !== undefined && n.height !== undefined;
	if (targetAutoLayout) plan.mode = "auto-layout";
	else if (container === "none" && creates.length <= 1) plan.mode = "single";
	else if (uniform) plan.mode = "grid";
	else plan.mode = "shelf";
	if (plan.mode === "grid" && uniform) plan.cell = { w: n.width as number, h: n.height as number };
	if (container === "none" && n.x !== undefined && n.y !== undefined) plan.origin = { x: n.x, y: n.y };
	plan.notes.push(...xyNotes(n, plan));
	if (container === "frame" && !plan.reuse) {
		let cellW = uniform ? (n.width as number) : 0;
		if (!cellW) for (const it of creates) cellW = Math.max(cellW, it.planned?.w ?? 0);
		if (!cellW) cellW = 100;
		plan.frameWidth = Math.round(plan.columns * cellW + (plan.columns - 1) * plan.gap + 2 * plan.padding);
	}
	return plan;
}

// ===========================================================================
// Chunks (spec §10.4)
// ===========================================================================

export interface ImagePayloadItem {
	key: string;
	name: string;
	source: string;
	data: string;
	hash: string;
	pixelWidth: number;
	pixelHeight: number;
	density: number;
	action: "create" | "fill";
	targetIds?: string[];
}

export interface ImageChunk {
	items: ImagePayloadItem[];
	keys: string[];
	b64Chars: number;
	fillTargets: number;
}

/**
 * ≤ IMAGE_CHUNK_MAX_ITEMS images and ≤ IMAGE_CHUNK_MAX_B64 of base64 per
 * call, in order; an image over the soft byte cap travels alone (the per-image
 * cap keeps that under the 12 MiB message ceiling).
 */
export function buildImageChunks(items: ImageItem[]): ImageChunk[] {
	const chunks: ImageChunk[] = [];
	let cur: ImageChunk | null = null;
	for (const it of items) {
		if ((it.action !== "create" && it.action !== "fill") || !it.data) continue;
		const p: ImagePayloadItem = {
			key: it.key,
			name: it.name,
			source: it.source,
			data: it.data,
			hash: it.hash ?? "",
			pixelWidth: it.pixelWidth ?? 0,
			pixelHeight: it.pixelHeight ?? 0,
			density: it.density,
			action: it.action,
			...(it.action === "fill" ? { targetIds: it.targetIds ?? [] } : {}),
		};
		const chars = it.data.length;
		const targets = p.targetIds?.length ?? 0;
		if (cur && (cur.items.length + 1 > IMAGE_CHUNK_MAX_ITEMS || cur.b64Chars + chars > IMAGE_CHUNK_MAX_B64)) {
			chunks.push(cur);
			cur = null;
		}
		if (!cur) cur = { items: [], keys: [], b64Chars: 0, fillTargets: 0 };
		cur.items.push(p);
		cur.keys.push(it.key);
		cur.b64Chars += chars;
		cur.fillTargets += targets;
	}
	if (cur) chunks.push(cur);
	return chunks;
}

// ===========================================================================
// Stops and the response (spec §10.5)
// ===========================================================================

/** The `incomplete.reason` text (§2.5 step 10.5, image wording). */
export function imageStopMessage(reason: StopReason, runId: string, elapsedMs: number, error?: string): string {
	if (reason === "refused") {
		return `${error ?? "Figma declined the next step."} Nothing more was sent. When that's sorted out, run the same call again with resumeRunId: "${runId}" to continue.`;
	}
	if (reason === "maybeRunning") {
		return `Figma didn't answer in time (or the connection dropped) and may still be importing images. Nothing more was sent. Wait until Figma is idle (check with figma_capture_screenshot), then run the same call again with resumeRunId: "${runId}": images this run already placed are recognized instead of placed twice.`;
	}
	if (reason === "budget") {
		return `Stopped after ${Math.round(elapsedMs / 1000)} s to stay within the time limit for one call. Run the same call again with resumeRunId: "${runId}" to continue.`;
	}
	return `Cancelled. The batch Figma was working on may still finish. Run the same call again with resumeRunId: "${runId}" to continue.`;
}

const STATUS_ORDER: ImageStatus[] = ["failed", "unknown", "updated", "created", "unchanged"];

function capNotes(notes: string[]): string[] | undefined {
	const uniq = [...new Set(notes)];
	if (!uniq.length) return undefined;
	if (uniq.length <= MAX_NOTES_PER_ITEM) return uniq;
	return [...uniq.slice(0, MAX_NOTES_PER_ITEM), `…and ${uniq.length - MAX_NOTES_PER_ITEM} more`];
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function fullImageItem(it: ImageItem, dryRun: boolean): Record<string, unknown> {
	const out: Record<string, unknown> = { source: it.source, name: it.name };
	if (dryRun) {
		out.action = it.action;
		if (it.reason) out.reason = it.reason;
		if (it.stage) out.stage = it.stage;
		if (it.planned) {
			out.width = it.planned.w;
			out.height = it.planned.h;
		}
		if (it.targets?.length) out.targets = it.targets;
		if (it.nodeId) out.existingId = it.nodeId;
	} else {
		out.status = it.status;
		if (it.stage && (it.status === "failed" || it.status === "unknown")) out.stage = it.stage;
		if (it.reason) out.reason = it.reason;
		if (it.nodeId) out.nodeId = it.nodeId;
		if (it.type) out.type = it.type;
		if (it.width !== undefined) out.width = round2(it.width);
		if (it.height !== undefined) out.height = round2(it.height);
		if (it.imageHash) out.imageHash = it.imageHash;
		if (it.filled?.length) out.filled = it.filled;
	}
	if (it.format) out.format = FORMAT_LABEL[it.format];
	if (it.pixelWidth !== undefined) out.pixelWidth = it.pixelWidth;
	if (it.pixelHeight !== undefined) out.pixelHeight = it.pixelHeight;
	const notes = capNotes(it.notes);
	if (notes) out.notes = notes;
	return out;
}

export interface ImageResponseInput {
	n: NormalizedImageArgs;
	items: ImageItem[];
	runId?: string;
	pre?: ImagePreflight;
	container?: { id: string; name: string; type: string; created: boolean };
	remaining?: { count: number; nextOffset?: number; images?: string[] };
	incomplete?: { reason: string; runId: string; notAttempted: string[]; inProgress?: string[] };
	notes: string[];
}

/** The figma_import_svg envelope minus its component-only fields (conflicts, skipped, componentSets). */
export function assembleImageResponse(r: ImageResponseInput): { body: Record<string, unknown>; isError: boolean } {
	const { n, items } = r;
	const count = (s: ImageStatus) => items.filter((i) => i.status === s).length;
	const summary = { requested: items.length, created: count("created"), updated: count("updated"), unchanged: count("unchanged"), failed: count("failed") };
	const ordered = items.slice().sort((a, b) => STATUS_ORDER.indexOf(a.status ?? "failed") - STATUS_ORDER.indexOf(b.status ?? "failed"));
	const fullStatuses = new Set<ImageStatus>(["failed", "unknown", "updated"]);
	// Items never sent (a stopped run) have no status; incomplete.notAttempted lists them.
	const full = n.dryRun ? ordered : n.verbose ? ordered.filter((i) => i.status) : ordered.filter((i) => i.status && fullStatuses.has(i.status));
	const shown = full.slice(0, MAX_FULL_ITEMS);
	const rest = full.slice(MAX_FULL_ITEMS);
	// A stopped run with images not confirmed (unknown) or never sent isn't a success.
	const body: Record<string, unknown> = { success: summary.failed === 0 && !unfinished(r.incomplete), dryRun: n.dryRun };
	if (!n.dryRun && r.runId) body.runId = r.runId;
	if (n.dryRun) {
		const actions: Record<string, number> = {};
		for (const it of items) actions[it.action ?? "fail"] = (actions[it.action ?? "fail"] ?? 0) + 1;
		body.summary = { requested: items.length, actions };
	} else body.summary = summary;
	if (r.pre) body.file = { name: r.pre.fileName, editorType: r.pre.editorType };
	if (r.container) body.container = r.container;
	body.items = shown.map((i) => fullImageItem(i, n.dryRun));
	if (!n.verbose && !n.dryRun) {
		body.created = items.filter((i) => i.status === "created").map((i) => [i.source, i.name, i.nodeId ?? null, i.imageHash ?? null]);
		body.unchanged = items.filter((i) => i.status === "unchanged").map((i) => [i.source, i.name, i.nodeId ?? null]);
	}
	if (r.remaining && (r.remaining.count > 0 || r.remaining.images?.length)) body.remaining = r.remaining;
	if (r.incomplete) body.incomplete = r.incomplete;
	if (rest.length) {
		const byStatus: Record<string, number> = {};
		for (const i of rest) {
			const k = (n.dryRun ? i.action : i.status) ?? "failed";
			byStatus[k] = (byStatus[k] ?? 0) + 1;
		}
		body.moreItems = { count: rest.length, byStatus };
	}
	const notes = [...new Set(r.notes)];
	if (notes.length) body.notes = notes;
	if (!n.dryRun) {
		const target = r.container?.id ?? items.find((i) => i.status === "created" && i.nodeId)?.nodeId ?? items.find((i) => i.filled?.length)?.filled?.[0]?.id;
		const hints: string[] = [];
		if (target) hints.push(`Check the result with figma_capture_screenshot({ nodeId: "${target}" }).`);
		if (r.incomplete) hints.push(`Continue with resumeRunId: "${r.incomplete.runId}".`);
		if (hints.length) body.hint = hints.join(" ");
	}
	const imported = summary.created + summary.updated + summary.unchanged;
	const isError = !n.dryRun && imported === 0 && !r.incomplete && summary.failed > 0;
	return { body, isError };
}
