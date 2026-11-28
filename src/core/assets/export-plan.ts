/**
 * Pure planning for figma_export_assets (spec .notes/parity/svg.md §3.2–§3.4):
 * argument normalization and validation, what to render with which export
 * settings, the raster size pre-check, file names as path SEGMENTS (never
 * joined into a path here: containment lives only in AssetFs, so this module
 * stays free of node:path and runs in Workers), collision keys, inline
 * budgets, image type sniffing and REST grouping for output "urls".
 */

import { normalizeNodeId } from "../figma-api.js";
import { CLOUD_FILEKEY_MESSAGE } from "./import-plan.js";
import {
	DEFAULT_INLINE_SVG_KB,
	MAX_EXPLICIT_IMAGE_HASHES,
	MAX_EXPORT_ASSETS,
	MAX_EXPORT_IMAGES,
	MAX_EXPORT_NODES,
	MAX_INLINE_IMAGE_B64,
	MAX_INLINE_PDF_BYTES,
	MAX_INLINE_SVG_KB,
	MAX_INLINE_TOTAL_B64,
	MAX_RASTER_AREA,
	MAX_RASTER_SIDE,
	MAX_SCAN_NODES,
	MAX_SETTINGS_PER_NODE,
	REST_IDS_PER_REQUEST,
	base64Length,
	formatMB,
} from "./limits.js";
import { utf8Length } from "./svg-sanitize.js";

// ===========================================================================
// Arguments
// ===========================================================================

export type ExportFormat = "PNG" | "JPG" | "SVG" | "PDF";
export type ScanMode = "none" | "include" | "only";
export type OutputMode = "files" | "inline" | "urls";
export type ColorProfile = "DOCUMENT" | "SRGB" | "DISPLAY_P3_V4";

export interface ExportAssetsArgs {
	nodeIds?: string[];
	format?: ExportFormat;
	scale?: number;
	width?: number;
	height?: number;
	svg?: { outlineText?: boolean; includeIds?: boolean; simplifyStroke?: boolean; currentColor?: boolean; removeSize?: boolean };
	contentsOnly?: boolean;
	useAbsoluteBounds?: boolean;
	colorProfile?: ColorProfile;
	vectors?: ScanMode;
	images?: ScanMode;
	imageHashes?: string[];
	output?: OutputMode;
	outputDir?: string;
	fileName?: string;
	overwrite?: boolean;
	inlineSvgKB?: number;
	fileKey?: string;
}

export interface NormalizedExportArgs {
	/** null = the current selection. */
	nodeIds: string[] | null;
	format?: ExportFormat;
	scale?: number;
	width?: number;
	height?: number;
	/** format, scale, width or height was given: one render per node with these, ignoring Export settings. */
	explicit: boolean;
	svg: { outlineText: boolean; includeIds: boolean; simplifyStroke: boolean; currentColor: boolean; removeSize: boolean };
	/** Which svg/bounds options were passed (they then override the node's Export settings too). */
	given: { outlineText: boolean; includeIds: boolean; simplifyStroke: boolean; contentsOnly: boolean; useAbsoluteBounds: boolean };
	contentsOnly: boolean;
	useAbsoluteBounds: boolean;
	colorProfile?: ColorProfile;
	vectors: ScanMode;
	images: ScanMode;
	imageHashes: string[];
	output: OutputMode;
	outputGiven: boolean;
	outputDir?: string;
	fileName: string;
	overwrite: boolean;
	overwriteGiven: boolean;
	inlineSvgKB: number;
	fileKey?: string;
	/** Node renders are produced (neither vectors nor images is "only"). */
	renders: boolean;
}

export function normalizeExportArgs(a: ExportAssetsArgs, ctx: { hasFs: boolean }): NormalizedExportArgs {
	const ids = (a.nodeIds ?? []).map((s) => normalizeNodeId(String(s).trim())).filter((s) => s.length > 0);
	const hashes = (a.imageHashes ?? []).map((h) => String(h).trim().toLowerCase());
	const vectors = a.vectors ?? "none";
	const images = a.images ?? "none";
	return {
		nodeIds: ids.length ? [...new Set(ids)] : null,
		format: a.format,
		scale: a.scale,
		width: a.width,
		height: a.height,
		explicit: a.format !== undefined || a.scale !== undefined || a.width !== undefined || a.height !== undefined,
		svg: {
			outlineText: a.svg?.outlineText ?? true,
			includeIds: a.svg?.includeIds ?? false,
			simplifyStroke: a.svg?.simplifyStroke ?? true,
			currentColor: a.svg?.currentColor ?? false,
			removeSize: a.svg?.removeSize ?? false,
		},
		given: {
			outlineText: a.svg?.outlineText !== undefined,
			includeIds: a.svg?.includeIds !== undefined,
			simplifyStroke: a.svg?.simplifyStroke !== undefined,
			contentsOnly: a.contentsOnly !== undefined,
			useAbsoluteBounds: a.useAbsoluteBounds !== undefined,
		},
		contentsOnly: a.contentsOnly ?? true,
		useAbsoluteBounds: a.useAbsoluteBounds ?? false,
		colorProfile: a.colorProfile,
		vectors,
		images,
		imageHashes: [...new Set(hashes)],
		output: a.output ?? (ctx.hasFs ? "files" : "inline"),
		outputGiven: a.output !== undefined,
		outputDir: a.outputDir,
		fileName: a.fileName ?? "{name}",
		overwrite: a.overwrite ?? false,
		overwriteGiven: a.overwrite !== undefined,
		inlineSvgKB: a.inlineSvgKB ?? DEFAULT_INLINE_SVG_KB,
		fileKey: a.fileKey,
		renders: vectors !== "only" && images !== "only",
	};
}

export const CLOUD_WRITE_MESSAGE =
	'Writing files is Local Mode only. In Cloud Mode use output "inline" (to look at assets) or "urls" (Figma-hosted links to download).';
/** Never includes any part of the token or the reason getFigmaAPI failed (CVE-2026-39125 lesson). */
export const TOKEN_MESSAGE = 'output "urls" needs a Figma access token (FIGMA_ACCESS_TOKEN in Local Mode). Use output "files" or "inline".';
export const NO_FILE_KEY_MESSAGE = 'The file key isn\'t available, so output "urls" can\'t be used here.';
export const NOTHING_MESSAGE = "Nothing to export: select layers in Figma or pass nodeIds.";

const HASH = /^[0-9a-f]{40}$/;
const isAbsolutePath = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
/** "/", "//", "C:\", "C:/": the textual check; node-fs checks the realpath too. */
const isRootPath = (p: string) => /^[\\/]+$/.test(p) || /^[A-Za-z]:[\\/]*$/.test(p) || /^\\\\[^\\/]+[\\/][^\\/]+[\\/]*$/.test(p);

export interface ExportValidation {
	error?: string;
	hint?: string;
	notes: string[];
}

/** Cross-field rules (spec §3.2). Fatal before contacting Figma. */
export function validateExportArgs(n: NormalizedExportArgs, ctx: { hasFs: boolean; remote: boolean }): ExportValidation {
	const notes: string[] = [];
	const fail = (error: string, hint?: string): ExportValidation => ({ error, ...(hint ? { hint } : {}), notes });
	if (ctx.remote && n.fileKey) return fail(CLOUD_FILEKEY_MESSAGE);
	if (!ctx.hasFs && (n.output === "files" || n.outputDir !== undefined || n.overwrite)) return fail(CLOUD_WRITE_MESSAGE);
	const sized = [n.scale, n.width, n.height].filter((v) => v !== undefined).length;
	if (sized > 1) return fail("Use scale, width or height, not several.");
	if (n.nodeIds && n.nodeIds.length > MAX_EXPORT_NODES) return fail(`Export up to ${MAX_EXPORT_NODES} nodes per call. Split the list into several calls.`);
	if (n.nodeIds?.some((id) => id.length > 500)) return fail("Node ids are at most 500 characters.");
	if (n.fileName.length > 200 || (n.outputDir?.length ?? 0) > 4096 || (n.fileKey?.length ?? 0) > 100) {
		return fail("fileName is limited to 200 characters, outputDir to 4096 and fileKey to 100.");
	}
	if (n.imageHashes.length > MAX_EXPLICIT_IMAGE_HASHES) return fail(`Pass up to ${MAX_EXPLICIT_IMAGE_HASHES} imageHashes per call.`);
	for (const h of n.imageHashes) {
		if (!HASH.test(h)) return fail(`"${h.slice(0, 60)}" isn't an image hash (40 hexadecimal characters, the imageHash in a node's fills).`);
	}
	if (n.outputDir !== undefined && n.output !== "files") return fail('outputDir only applies to output "files".');
	if (n.output === "urls") {
		if (n.width !== undefined || n.height !== undefined || n.colorProfile !== undefined) {
			return fail('output "urls" renders through Figma\'s REST API, which takes a scale but not width, height or colorProfile.');
		}
		if (n.svg.currentColor || n.svg.removeSize) {
			return fail('svg.currentColor and svg.removeSize change the SVG text, which output "urls" doesn\'t return. Use output "files" or "inline".');
		}
		// FigmaAPI.getImages has no use_absolute_bounds parameter, so it would be silently ignored.
		if (n.useAbsoluteBounds) return fail('output "urls" renders through Figma\'s REST API, which this server calls without useAbsoluteBounds. Use output "files" or "inline".');
	}
	if (n.outputDir !== undefined) {
		if (!isAbsolutePath(n.outputDir)) return fail("Pass an absolute outputDir.");
		if (isRootPath(n.outputDir)) return fail("Pick a folder for the export, not the root of the drive.");
	}
	const t = compileFileName(n.fileName);
	if (!t.ok) return fail(t.error);
	if (n.explicit && (n.format === "SVG" || n.format === "PDF") && (n.scale !== undefined || n.width !== undefined || n.height !== undefined)) {
		notes.push("scale, width and height apply to PNG and JPG; ignored for SVG and PDF.");
	}
	if (!n.renders && n.explicit) notes.push('format, scale, width and height apply to node renders, which aren\'t made when vectors or images is "only".');
	// The zod schema enforces these at the protocol edge; repeated for direct callers.
	if (n.inlineSvgKB < 8 || n.inlineSvgKB > MAX_INLINE_SVG_KB) return fail(`inlineSvgKB must be between 8 and ${MAX_INLINE_SVG_KB}.`);
	if (n.scale !== undefined && !(n.scale >= 0.01 && n.scale <= 4)) return fail("scale must be between 0.01 and 4.");
	for (const v of [n.width, n.height]) {
		if (v !== undefined && !(Number.isInteger(v) && v >= 1 && v <= MAX_RASTER_SIDE)) return fail(`width and height must be whole numbers from 1 to ${MAX_RASTER_SIDE}.`);
	}
	return { notes };
}

// ===========================================================================
// File names (segments only)
// ===========================================================================

export const FILE_NAME_TOKENS = ["name", "path", "leaf", "set", "variant", "id", "page"] as const;
type FileToken = (typeof FILE_NAME_TOKENS)[number];
type TemplatePart = { lit: string } | { token: FileToken };

export function compileFileName(template: string): { ok: true; parts: TemplatePart[] } | { ok: false; error: string } {
	const parts: TemplatePart[] = [];
	let i = 0;
	while (i < template.length) {
		const open = template.indexOf("{", i);
		if (open < 0) {
			parts.push({ lit: template.slice(i) });
			break;
		}
		const close = template.indexOf("}", open + 1);
		// An unclosed brace is literal text (safeSegment drops the brace itself).
		if (close < 0) {
			parts.push({ lit: template.slice(i) });
			break;
		}
		if (open > i) parts.push({ lit: template.slice(i, open) });
		const name = template.slice(open + 1, close);
		if (!(FILE_NAME_TOKENS as readonly string[]).includes(name)) {
			return { ok: false, error: `Unknown token {${name.slice(0, 40)}} in fileName. Use {name}, {path}, {leaf}, {set}, {variant}, {id} or {page}.` };
		}
		parts.push({ token: name as FileToken });
		i = close + 1;
	}
	return { ok: true, parts };
}

/** Windows device names, with or without an extension; Windows also treats the superscript digits ¹²³ as COM/LPT numbers. */
const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?=\.|$)/i;
const SEGMENT_MAX_CHARS = 120;
/** Most filesystems cap a name at 255 bytes; room is left for the suffix, the collision counter and the extension. */
const SEGMENT_MAX_BYTES = 180;
/** macOS paths stop at 1024 bytes; a node name full of slashes must not build a folder tower. */
const MAX_SEGMENTS = 8;

const ASCII_KEEP = /[A-Za-z0-9._-]/;
const UNICODE_KEEP = /[\p{L}\p{N}\p{M}]/u;
const trimDotsDashes = (s: string) => s.replace(/^[.-]+/, "").replace(/[.-]+$/, "");

/** One path segment that is safe on macOS, Linux and Windows (spec §3.4 step 3). */
export function safeSegment(raw: string): string {
	let s = raw.normalize("NFC").replace(/[\\\s]+/gu, "-");
	let kept = "";
	for (const ch of s) {
		if (ASCII_KEEP.test(ch) || ((ch.codePointAt(0) ?? 0) > 0x7f && UNICODE_KEEP.test(ch))) kept += ch;
	}
	s = trimDotsDashes(kept.replace(/-{2,}/g, "-"));
	let chars = Array.from(s);
	if (chars.length > SEGMENT_MAX_CHARS) chars = chars.slice(0, SEGMENT_MAX_CHARS);
	while (chars.length && utf8Length(chars.join("")) > SEGMENT_MAX_BYTES) chars.pop();
	s = trimDotsDashes(chars.join(""));
	if (s === "") return "asset";
	return RESERVED_WINDOWS.test(s) ? s.replace(RESERVED_WINDOWS, "$1_") : s;
}

/** Export-panel suffixes such as "@2x"; anything else (slashes, dots-only tricks) is dropped. */
export function safeSuffix(raw: string | undefined): string {
	return (raw ?? "").replace(/[^A-Za-z0-9@._+-]/g, "").slice(0, 32);
}

export interface NameSource {
	id: string;
	name: string;
	page?: string;
	setName?: string;
	variant?: string[];
}

/** Template → folder segments + file stem (no suffix or extension yet). */
export function expandFileName(parts: TemplatePart[], src: NameSource): { dirs: string[]; stem: string } {
	const isVariant = !!(src.setName && src.variant && src.variant.length);
	const variant = isVariant ? (src.variant as string[]).join("-") : "";
	const full = isVariant ? `${src.setName} ${variant}` : src.name;
	const base = isVariant ? (src.setName as string) : src.name;
	const flat = (s: string) => s.replace(/\//g, "-");
	const values: Record<FileToken, string> = {
		name: flat(full),
		path: full,
		leaf: flat(base.slice(base.lastIndexOf("/") + 1)),
		set: flat(src.setName ?? src.name),
		variant: flat(variant),
		id: src.id.replace(/:/g, "-").replace(/;/g, "_"),
		page: flat(src.page ?? ""),
	};
	const text = parts.map((p) => ("lit" in p ? p.lit : values[p.token])).join("");
	// Empty raw segments ("a//b", a trailing "/", an empty {variant}) are dropped rather than named "asset".
	let raw = text.split("/").map((s) => s.trim()).filter((s) => s.length > 0);
	if (raw.length > MAX_SEGMENTS) raw = [...raw.slice(0, MAX_SEGMENTS - 1), raw.slice(MAX_SEGMENTS - 1).join("-")];
	const segs = raw.length ? raw.map(safeSegment) : ["asset"];
	return { dirs: segs.slice(0, -1), stem: segs[segs.length - 1] };
}

/**
 * Collision-free relative paths within one call. Keys are NFC + lowercase
 * because macOS and Windows filesystems are case-insensitive: "Arrow" and
 * "arrow" are the same file there.
 */
export class FileNameRegistry {
	private readonly used = new Set<string>();

	claim(dirs: string[], stem: string, suffix: string, ext: string): string[] {
		for (let k = 1; ; k++) {
			const file = `${stem}${suffix}${k > 1 ? `-${k}` : ""}.${ext}`;
			const segs = [...dirs, file];
			const key = segs.join("/").normalize("NFC").toLowerCase();
			if (!this.used.has(key)) {
				this.used.add(key);
				return segs;
			}
		}
	}
}

// ===========================================================================
// Preflight shapes (returned by EXPORT_PREFLIGHT_BODY)
// ===========================================================================

/** An Export panel setting as the plugin returns it (JSON-cloned, so untyped at the edge). */
export interface NodeExportSetting {
	format?: string;
	suffix?: string;
	contentsOnly?: boolean;
	useAbsoluteBounds?: boolean;
	constraint?: { type?: string; value?: number };
	colorProfile?: string;
	svgOutlineText?: boolean;
	svgIdAttribute?: boolean;
	svgSimplifyStroke?: boolean;
}

export interface PreflightExportNode {
	id: string;
	name: string;
	type: string;
	page?: string;
	width: number;
	height: number;
	renderW: number;
	renderH: number;
	setName?: string;
	variant?: string[];
	exportSettings: NodeExportSetting[];
	settingsTotal?: number;
}

export interface PreflightVector {
	nodeId: string;
	name: string;
	type: string;
	mainComponentName?: string;
	componentKey?: string;
	foundIn: string;
	width: number;
	height: number;
	page?: string;
	setName?: string;
	variant?: string[];
}

export interface PreflightImage {
	hash: string;
	usedBy: Array<{ nodeId: string; name: string }>;
	usedByCount?: number;
}

export interface ExportPreflight {
	editorType?: string;
	fileKey: string | null;
	nodes: PreflightExportNode[];
	missing: string[];
	unsupported: Array<{ id: string; type: string }>;
	vectors: PreflightVector[];
	vectorTotal: number;
	images: PreflightImage[];
	imageTotal: number;
	scanned: number;
	scanTruncated: boolean;
	selectionCount?: number;
	notes?: string[];
}

// ===========================================================================
// Render plan
// ===========================================================================

export type PluginExportSettings =
	| { format: "PNG" | "JPG"; constraint: { type: "SCALE" | "WIDTH" | "HEIGHT"; value: number }; contentsOnly: boolean; useAbsoluteBounds: boolean; colorProfile?: ColorProfile }
	| {
			format: "SVG_STRING";
			svgOutlineText: boolean;
			svgIdAttribute: boolean;
			svgSimplifyStroke: boolean;
			contentsOnly: boolean;
			useAbsoluteBounds: boolean;
			colorProfile?: ColorProfile;
	  }
	| { format: "PDF"; contentsOnly: boolean; useAbsoluteBounds: boolean; colorProfile?: ColorProfile };

export const EXT: Record<ExportFormat, string> = { PNG: "png", JPG: "jpg", SVG: "svg", PDF: "pdf" };
export const MIME: Record<ExportFormat, string> = { PNG: "image/png", JPG: "image/jpeg", SVG: "image/svg+xml", PDF: "application/pdf" };

export interface PlannedAsset {
	key: string;
	kind: "render" | "vector";
	nodeId: string;
	name: string;
	format: ExportFormat;
	settings: PluginExportSettings;
	/** SCALE constraint value (raster). */
	scale?: number;
	/** WIDTH/HEIGHT constraint (raster). */
	constraint?: { type: "WIDTH" | "HEIGHT"; value: number };
	suffix: string;
	ext: string;
	mimeType: string;
	/** Node size in Figma units (SVG/PDF dimensions; raster fallback). */
	width: number;
	height: number;
	/** Estimated raster output size in px. */
	estW?: number;
	estH?: number;
	/** Relative path segments (folders + file name). */
	segments: string[];
	vector?: PreflightVector;
}

export interface PlannedImage {
	hash: string;
	usedBy: Array<{ nodeId: string; name: string }>;
	usedByCount: number;
}

export interface SkipEntry {
	nodeId?: string;
	imageHash?: string;
	file?: string;
	reason: string;
}

export interface ExportPlan {
	assets: PlannedAsset[];
	images: PlannedImage[];
	skipped: SkipEntry[];
	notes: string[];
	registry: FileNameRegistry;
}

const COLOR_PROFILES = new Set<string>(["DOCUMENT", "SRGB", "DISPLAY_P3_V4"]);
const fmtNum = (v: number) => String(Math.round(v * 100) / 100);
const fmtInt = (v: number) => Math.round(v).toLocaleString("en-US");
const floor2 = (v: number) => Math.floor(v * 100 + 1e-9) / 100;

interface SettingInput {
	format: ExportFormat;
	constraint?: { type: "SCALE" | "WIDTH" | "HEIGHT"; value: number };
	suffix?: string;
	contentsOnly: boolean;
	useAbsoluteBounds: boolean;
	colorProfile?: ColorProfile;
	svgOutlineText: boolean;
	svgIdAttribute: boolean;
	svgSimplifyStroke: boolean;
}

/** Explicit arguments win over a node's Export settings, field by field (as in Figma's download_assets). */
function fromNodeSetting(s: NodeExportSetting, n: NormalizedExportArgs): SettingInput | null {
	const f = String(s.format ?? "").toUpperCase();
	const format: ExportFormat | null = f === "PNG" || f === "JPG" || f === "PDF" ? f : f === "SVG" || f === "SVG_STRING" ? "SVG" : null;
	if (!format) return null;
	const ct = s.constraint?.type;
	const cv = s.constraint?.value;
	const type: "SCALE" | "WIDTH" | "HEIGHT" | null = ct === "SCALE" || ct === "WIDTH" || ct === "HEIGHT" ? ct : null;
	const constraint = type && typeof cv === "number" && Number.isFinite(cv) && cv > 0 ? { type, value: cv } : undefined;
	const profile = n.colorProfile ?? (s.colorProfile && COLOR_PROFILES.has(s.colorProfile) ? (s.colorProfile as ColorProfile) : undefined);
	return {
		format,
		constraint,
		suffix: s.suffix,
		contentsOnly: n.given.contentsOnly ? n.contentsOnly : (s.contentsOnly ?? true),
		useAbsoluteBounds: n.given.useAbsoluteBounds ? n.useAbsoluteBounds : (s.useAbsoluteBounds ?? false),
		colorProfile: profile,
		svgOutlineText: n.given.outlineText ? n.svg.outlineText : (s.svgOutlineText ?? true),
		svgIdAttribute: n.given.includeIds ? n.svg.includeIds : (s.svgIdAttribute ?? false),
		svgSimplifyStroke: n.given.simplifyStroke ? n.svg.simplifyStroke : (s.svgSimplifyStroke ?? true),
	};
}

function explicitSetting(n: NormalizedExportArgs): SettingInput {
	const constraint =
		n.width !== undefined
			? { type: "WIDTH" as const, value: n.width }
			: n.height !== undefined
				? { type: "HEIGHT" as const, value: n.height }
				: { type: "SCALE" as const, value: n.scale ?? 1 };
	return {
		format: n.format ?? "PNG",
		constraint,
		contentsOnly: n.contentsOnly,
		useAbsoluteBounds: n.useAbsoluteBounds,
		colorProfile: n.colorProfile,
		svgOutlineText: n.svg.outlineText,
		svgIdAttribute: n.svg.includeIds,
		svgSimplifyStroke: n.svg.simplifyStroke,
	};
}

function defaultSetting(n: NormalizedExportArgs): SettingInput {
	return { ...explicitSetting({ ...n, width: undefined, height: undefined, scale: 1 }), format: "PNG" };
}

function toPluginSettings(s: SettingInput): PluginExportSettings {
	const base = { contentsOnly: s.contentsOnly, useAbsoluteBounds: s.useAbsoluteBounds, ...(s.colorProfile ? { colorProfile: s.colorProfile } : {}) };
	if (s.format === "SVG") {
		return { format: "SVG_STRING", svgOutlineText: s.svgOutlineText, svgIdAttribute: s.svgIdAttribute, svgSimplifyStroke: s.svgSimplifyStroke, ...base };
	}
	if (s.format === "PDF") return { format: "PDF", ...base };
	return { format: s.format, constraint: s.constraint ?? { type: "SCALE", value: 1 }, ...base };
}

/**
 * Raster pre-check (spec §3.4 step 3): Figma's renderer refuses very large
 * bitmaps only after doing the work, on its single thread. The estimate uses
 * the render bounds (shadows, thick strokes) unless useAbsoluteBounds.
 */
export function rasterCheck(
	format: "PNG" | "JPG",
	constraint: { type: "SCALE" | "WIDTH" | "HEIGHT"; value: number },
	base: { w: number; h: number },
): { estW: number; estH: number; error?: string } {
	const { w, h } = base;
	if (!(w > 0) || !(h > 0)) return { estW: 0, estH: 0 };
	const s = constraint.type === "SCALE" ? constraint.value : constraint.type === "WIDTH" ? constraint.value / w : constraint.value / h;
	const estW = Math.round(w * s);
	const estH = Math.round(h * s);
	const tooLong = Math.max(estW, estH) > MAX_RASTER_SIDE;
	const tooBig = estW * estH > MAX_RASTER_AREA;
	if (!tooLong && !tooBig) return { estW, estH };
	const maxScale = floor2(Math.min(MAX_RASTER_SIDE / Math.max(w, h), Math.sqrt(MAX_RASTER_AREA / (w * h))));
	const what = constraint.type === "SCALE" ? `A ${fmtNum(s)}x ${format}` : `A ${format} ${fmtInt(constraint.value)} px ${constraint.type === "WIDTH" ? "wide" : "tall"}`;
	const fix =
		maxScale < 0.01
			? "This layer is too large for PNG or JPG; export it as SVG or PDF."
			: constraint.type === "SCALE"
				? `Use scale ${maxScale} or less.`
				: constraint.type === "WIDTH"
					? `Use a width of ${fmtInt(Math.floor(w * maxScale))} px or less.`
					: `Use a height of ${fmtInt(Math.floor(h * maxScale))} px or less.`;
	if (tooLong) {
		const side = estW >= estH ? `${fmtInt(estW)} px wide` : `${fmtInt(estH)} px tall`;
		return { estW, estH, error: `${what} would be ${side}; the limit is ${fmtInt(MAX_RASTER_SIDE)}. ${fix}` };
	}
	return {
		estW,
		estH,
		error: `${what} would be ${fmtInt(estW)} × ${fmtInt(estH)} px (${fmtInt((estW * estH) / 1e6)} MP); the limit is ${fmtInt(MAX_RASTER_AREA / 1e6)} MP. ${fix}`,
	};
}

/** Raster files exported at a scale other than 1 get Figma's "@2x" style suffix when the setting has none. */
function defaultSuffix(s: SettingInput): string {
	if ((s.format === "PNG" || s.format === "JPG") && s.constraint?.type === "SCALE" && s.constraint.value !== 1) return `@${fmtNum(s.constraint.value)}x`;
	return "";
}

export function planExport(n: NormalizedExportArgs, pre: ExportPreflight, parts: TemplatePart[]): ExportPlan {
	const assets: PlannedAsset[] = [];
	const skipped: SkipEntry[] = [];
	const notes: string[] = [];
	const registry = new FileNameRegistry();
	let k = 0;

	for (const id of pre.missing ?? []) skipped.push({ nodeId: id, reason: `Node ${id} not found.` });
	for (const u of pre.unsupported ?? []) skipped.push({ nodeId: u.id, reason: `${u.type} layers can't be exported.` });
	if (!n.nodeIds && (pre.selectionCount ?? 0) > MAX_EXPORT_NODES) {
		notes.push(`Exported the first ${MAX_EXPORT_NODES} of the ${pre.selectionCount} selected layers. Pass nodeIds to export the rest.`);
	}
	if (pre.scanTruncated) {
		notes.push(
			`Stopped scanning after ${MAX_SCAN_NODES.toLocaleString("en-US")} layers; vectors and images beyond that weren't checked. Export smaller parts of the file by id.`,
		);
	}

	const candidates: Array<Omit<PlannedAsset, "segments" | "key">> = [];
	const addCandidate = (a: Omit<PlannedAsset, "segments" | "key">) => candidates.push(a);

	if (n.renders) {
		for (const node of pre.nodes) {
			let inputs: SettingInput[];
			if (n.explicit) inputs = [explicitSetting(n)];
			else if (node.exportSettings.length) {
				inputs = [];
				for (const s of node.exportSettings.slice(0, MAX_SETTINGS_PER_NODE)) {
					const si = fromNodeSetting(s, n);
					if (si) inputs.push(si);
					else notes.push(`${node.name}: an Export setting in format ${String(s.format).slice(0, 20)} isn't supported here; skipped it.`);
				}
				if ((node.settingsTotal ?? node.exportSettings.length) > MAX_SETTINGS_PER_NODE) {
					notes.push(`${node.name} has ${node.settingsTotal} Export settings; used the first ${MAX_SETTINGS_PER_NODE}.`);
				}
				if (!inputs.length) inputs = [defaultSetting(n)];
			} else inputs = [defaultSetting(n)];

			for (const si of inputs) {
				const settings = toPluginSettings(si);
				const raster = si.format === "PNG" || si.format === "JPG";
				const suffix = safeSuffix(si.suffix) || defaultSuffix(si);
				const asset: Omit<PlannedAsset, "segments" | "key"> = {
					kind: "render",
					nodeId: node.id,
					name: node.name,
					format: si.format,
					settings,
					suffix,
					ext: EXT[si.format],
					mimeType: MIME[si.format],
					width: node.width,
					height: node.height,
				};
				if (raster) {
					const c = si.constraint ?? { type: "SCALE" as const, value: 1 };
					if (c.type === "SCALE") asset.scale = c.value;
					else asset.constraint = { type: c.type, value: c.value };
					const base = si.useAbsoluteBounds ? { w: node.width, h: node.height } : { w: node.renderW || node.width, h: node.renderH || node.height };
					const check = rasterCheck(si.format as "PNG" | "JPG", c, base);
					if (check.error) {
						skipped.push({ nodeId: node.id, reason: check.error });
						continue;
					}
					if (check.estW) {
						asset.estW = check.estW;
						asset.estH = check.estH;
					}
				}
				addCandidate(asset);
			}
		}
	}

	if (n.vectors !== "none") {
		const vecSettings = toPluginSettings({ ...explicitSetting(n), format: "SVG" });
		for (const v of pre.vectors) {
			addCandidate({
				kind: "vector",
				nodeId: v.nodeId,
				name: v.name,
				format: "SVG",
				settings: vecSettings,
				suffix: "",
				ext: "svg",
				mimeType: MIME.SVG,
				width: v.width,
				height: v.height,
				vector: v,
			});
		}
		if (pre.vectorTotal > pre.vectors.length) {
			notes.push(`Found ${pre.vectorTotal} vector layers; exported the first ${pre.vectors.length}. Export the rest by id.`);
		}
		if (pre.vectorTotal === 0 && !pre.scanTruncated) notes.push("No vector layers (icons, logos) found inside these nodes.");
	}

	for (const c of candidates) {
		if (assets.length >= MAX_EXPORT_ASSETS) {
			skipped.push({ nodeId: c.nodeId, reason: `Over the limit of ${MAX_EXPORT_ASSETS} assets per call; export this one in another call.` });
			continue;
		}
		const src: NameSource = c.vector
			? { id: c.vector.nodeId, name: c.vector.name, page: c.vector.page, setName: c.vector.setName, variant: c.vector.variant }
			: (() => {
					const node = pre.nodes.find((x) => x.id === c.nodeId) as PreflightExportNode;
					return { id: node.id, name: node.name, page: node.page, setName: node.setName, variant: node.variant };
				})();
		const { dirs, stem } = expandFileName(parts, src);
		assets.push({ ...c, key: `a${k++}`, segments: registry.claim(dirs, stem, c.suffix, c.ext) });
	}

	// Images: explicit hashes first, then what the scan found; one list, one cap.
	const images: PlannedImage[] = [];
	const seen = new Set<string>();
	const scanned = new Map((pre.images ?? []).map((im) => [im.hash.toLowerCase(), im]));
	const wanted: string[] = [...n.imageHashes, ...(n.images !== "none" ? (pre.images ?? []).map((im) => im.hash.toLowerCase()) : [])];
	let imageTotal = 0;
	for (const h of wanted) {
		if (seen.has(h)) continue;
		seen.add(h);
		imageTotal++;
		if (images.length >= MAX_EXPORT_IMAGES) continue;
		const s = scanned.get(h);
		images.push({ hash: h, usedBy: s?.usedBy ?? [], usedByCount: s?.usedByCount ?? s?.usedBy.length ?? 0 });
	}
	const moreScanned = Math.max(0, (pre.imageTotal ?? 0) - (pre.images ?? []).length);
	if (imageTotal + moreScanned > images.length) {
		notes.push(`Found ${imageTotal + moreScanned} images; exported the first ${images.length}. Export the rest with imageHashes.`);
	}
	if (n.images !== "none" && (pre.imageTotal ?? 0) === 0 && !pre.scanTruncated) notes.push("No image fills found inside these nodes.");

	return { assets, images, skipped, notes, registry };
}

/** The image file name: image-<first 12 hex of the hash>.<ext>, through the same collision registry. */
export function imageSegments(registry: FileNameRegistry, hash: string, ext: string): string[] {
	return registry.claim([], `image-${hash.slice(0, 12)}`, "", ext);
}

// ===========================================================================
// Inline budgets (spec §3.4 step 8)
// ===========================================================================

export class InlineBudget {
	svgRemaining: number;
	b64Remaining = MAX_INLINE_TOTAL_B64;
	inlineBytes = 0;
	constructor(readonly svgKB: number) {
		this.svgRemaining = svgKB * 1024;
	}
	/** Plugin limits for one raster block: base64 length and the raw bytes that encode within it. */
	raster(): { maxBase64: number; maxBytes: number } {
		const maxBase64 = Math.min(MAX_INLINE_IMAGE_B64, this.b64Remaining);
		return { maxBase64, maxBytes: Math.floor(maxBase64 / 4) * 3 };
	}
	pdf(): { maxBase64: number; maxBytes: number } {
		const maxBytes = Math.min(MAX_INLINE_PDF_BYTES, Math.floor(this.b64Remaining / 4) * 3);
		return { maxBase64: base64Length(maxBytes), maxBytes };
	}
	takeB64(len: number): void {
		this.b64Remaining -= len;
		this.inlineBytes += len;
	}
	takeSvg(bytes: number): void {
		this.svgRemaining -= bytes;
		this.inlineBytes += bytes;
	}
	svgMessage(): string {
		return `Inline SVG budget (${this.svgKB} KB) reached. Raise inlineSvgKB (up to ${MAX_INLINE_SVG_KB}), or use output "files" or "urls".`;
	}
	/**
	 * Why a raster or image of `bytes` raw bytes can't be inlined. The cap is on
	 * base64 (1 MB), i.e. 768 KB of image data; size and limit are both stated in
	 * image-data KB, rounded so an image over the limit never reads as at or under it.
	 */
	imageMessage(label: string, bytes: number, smallerScale: boolean): string {
		if (base64Length(bytes) <= MAX_INLINE_IMAGE_B64) {
			return `Inline image budget (${formatMB(MAX_INLINE_TOTAL_B64)} per call) reached. Use output "files" (Local Mode) or "urls", or export fewer assets per call.`;
		}
		const limitKB = (Math.floor(MAX_INLINE_IMAGE_B64 / 4) * 3) / 1024;
		return `${label} is ${Math.ceil(bytes / 1024)} KB; inline images are limited to ${limitKB} KB of image data each (${formatMB(MAX_INLINE_IMAGE_B64)} as base64). Use output "files" (Local Mode) or "urls"${smallerScale ? ", or a smaller scale" : ""}.`;
	}
	pdfMessage(bytes: number): string {
		if (bytes <= MAX_INLINE_PDF_BYTES) {
			return `Inline image budget (${formatMB(MAX_INLINE_TOTAL_B64)} per call) reached. Use output "files" (Local Mode) or "urls", or export fewer assets per call.`;
		}
		return `PDFs over ${MAX_INLINE_PDF_BYTES / 1024} KB can't be returned inline. Use output "files" or "urls".`;
	}
}

// ===========================================================================
// Bytes: base64, image type, pixel size
// ===========================================================================

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = (() => {
	const t = new Int16Array(128).fill(-1);
	for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
	return t;
})();

/** Decode standard base64 (figma.base64Encode output). Buffer when present (Node), otherwise a plain loop (Workers). */
export function decodeBase64(b64: string): Uint8Array {
	const g = globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } };
	if (g.Buffer) return new Uint8Array(g.Buffer.from(b64, "base64"));
	const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
	const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
	let o = 0;
	for (let i = 0; i + 1 < clean.length; i += 4) {
		const a = B64_INDEX[clean.charCodeAt(i)];
		const b = B64_INDEX[clean.charCodeAt(i + 1)];
		const c = i + 2 < clean.length ? B64_INDEX[clean.charCodeAt(i + 2)] : -1;
		const d = i + 3 < clean.length ? B64_INDEX[clean.charCodeAt(i + 3)] : -1;
		out[o++] = (a << 2) | (b >> 4);
		if (c >= 0) out[o++] = ((b & 15) << 4) | (c >> 2);
		if (d >= 0) out[o++] = ((c & 3) << 6) | d;
	}
	return out.subarray(0, o);
}

/** The first `n` bytes of a base64 string, without decoding all of it. */
export function base64Prefix(b64: string, n: number): Uint8Array {
	return decodeBase64(b64.slice(0, Math.ceil(n / 3) * 4));
}

export interface SniffedType {
	mimeType: string;
	ext: string;
	/** An MCP client can show it as an image block. */
	viewable: boolean;
}

/** Image type from magic bytes (spec §3.5): PNG, JPEG, GIF, WebP, else octet-stream. */
export function sniffImage(b: Uint8Array): SniffedType {
	if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mimeType: "image/png", ext: "png", viewable: true };
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mimeType: "image/jpeg", ext: "jpg", viewable: true };
	if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { mimeType: "image/gif", ext: "gif", viewable: true };
	if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
		return { mimeType: "image/webp", ext: "webp", viewable: true };
	}
	return { mimeType: "application/octet-stream", ext: "bin", viewable: false };
}

/** Pixel size from a PNG IHDR or a JPEG SOF marker; null when the header isn't one of those. */
export function rasterSize(b: Uint8Array): { width: number; height: number } | null {
	if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52) {
		const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
		return { width: u32(16), height: u32(20) };
	}
	if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
		let i = 2;
		while (i + 9 < b.length) {
			if (b[i] !== 0xff) return null;
			const m = b[i + 1];
			if (m === 0xff) {
				i++;
				continue;
			}
			if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
				return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
			}
			if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
				i += 2;
				continue;
			}
			i += 2 + ((b[i + 2] << 8) | b[i + 3]);
		}
	}
	return null;
}

// ===========================================================================
// output "urls" (REST)
// ===========================================================================

export interface RestRenderOptions {
	format: "png" | "jpg" | "svg" | "pdf";
	scale?: number;
	svg_outline_text?: boolean;
	svg_include_id?: boolean;
	svg_simplify_stroke?: boolean;
	contents_only?: boolean;
}

/**
 * The REST render options for one planned asset. REST takes a scale only, so
 * an Export-setting WIDTH/HEIGHT constraint becomes a scale from the node size
 * (clamped to 0.01–4, with a note).
 */
export function restOptionsFor(a: PlannedAsset, notes: string[]): { options: RestRenderOptions; scale?: number } {
	const s = a.settings;
	if (s.format === "SVG_STRING") {
		return {
			options: { format: "svg", svg_outline_text: s.svgOutlineText, svg_include_id: s.svgIdAttribute, svg_simplify_stroke: s.svgSimplifyStroke, contents_only: s.contentsOnly },
		};
	}
	if (s.format === "PDF") return { options: { format: "pdf", contents_only: s.contentsOnly } };
	let scale = s.constraint.value;
	if (s.constraint.type !== "SCALE") {
		const side = s.constraint.type === "WIDTH" ? a.width : a.height;
		const raw = side > 0 ? s.constraint.value / side : 1;
		scale = Math.round(raw * 100) / 100;
		notes.push(`${a.name}: ${s.constraint.type.toLowerCase()} ${fmtNum(s.constraint.value)} became scale ${fmtNum(Math.min(4, Math.max(0.01, scale)))} for Figma's REST render.`);
	}
	if (scale > 4 || scale < 0.01) {
		const clamped = Math.min(4, Math.max(0.01, scale));
		if (s.constraint.type === "SCALE") notes.push(`${a.name}: scale ${fmtNum(scale)} is outside 0.01–4 for Figma's REST render; used ${fmtNum(clamped)}.`);
		scale = clamped;
	}
	return { options: { format: s.format === "JPG" ? "jpg" : "png", scale, contents_only: s.contentsOnly }, scale };
}

/** One request per option set and ≤ REST_IDS_PER_REQUEST distinct ids. */
export function groupForRest(items: Array<{ key: string; nodeId: string; options: RestRenderOptions }>): Array<{ options: RestRenderOptions; ids: string[] }> {
	const byKey = new Map<string, { options: RestRenderOptions; ids: string[] }>();
	for (const it of items) {
		const k = JSON.stringify(it.options);
		let g = byKey.get(k);
		if (!g) {
			g = { options: it.options, ids: [] };
			byKey.set(k, g);
		}
		if (!g.ids.includes(it.nodeId)) g.ids.push(it.nodeId);
	}
	const out: Array<{ options: RestRenderOptions; ids: string[] }> = [];
	for (const g of byKey.values()) {
		for (let i = 0; i < g.ids.length; i += REST_IDS_PER_REQUEST) out.push({ options: g.options, ids: g.ids.slice(i, i + REST_IDS_PER_REQUEST) });
	}
	return out;
}
