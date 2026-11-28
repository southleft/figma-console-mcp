/**
 * Caps, defaults and timeouts for the asset tools (figma_import_svg,
 * figma_export_assets and figma_import_image each have a block here).
 *
 * Every number that bounds work on Figma's single, uncancellable plugin
 * thread or on the size of a response lives here, so the tests and the spec
 * (.notes/parity/svg.md §2.8) can be checked against one file.
 */

const KiB = 1024;
const MiB = 1024 * KiB;

// ---- Input size ----------------------------------------------------------

/**
 * Per SVG. Figma's own upload takes 10 MB, but createNodeFromSvg runs on the
 * plugin's single thread and can't be interrupted; the element and expansion
 * caps are the real guard, 5 MiB covers large Illustrator maps.
 */
export const MAX_SVG_BYTES = 5 * MiB;
export const MAX_INLINE_SVGS = 200;
export const MAX_INLINE_TOTAL_BYTES = 16 * MiB;
export const MAX_PATHS = 500;
/** svgs + paths + the directory page. */
export const MAX_ITEMS_PER_CALL = 500;
export const DEFAULT_DIRECTORY_LIMIT = 200;
export const CLOUD_MAX_ITEMS_PER_CALL = 100;
export const MAX_DIR_DEPTH = 6;
export const MAX_DIR_SCAN = 10_000;
export const MAX_READ_BYTES_PER_CALL = 64 * MiB;
export const MAX_PATH_LENGTH = 4096;

// ---- Sanitizer -----------------------------------------------------------

export const MAX_ELEMENTS = 20_000;
export const MAX_DEPTH = 64;
export const MAX_ATTRS = 256;
/**
 * Attributes in one SVG, all elements together. MAX_ELEMENTS × MAX_ATTRS
 * would allow 5 million, about 200 bytes of heap each: far past a Workers
 * isolate's 128 MB. Real files average 2–6 per element.
 */
export const MAX_TOTAL_ATTRS = 200_000;
export const MAX_ATTR_VALUE = 2 * MiB;
/** Elements after following <use> and url(#…) references (one SVG). */
export const MAX_EXPANDED_ELEMENTS = 50_000;
/**
 * Markup (tag and attribute names, attribute values, text) after following
 * <use> and url(#…) references: one 2 MiB path instanced 24,000 times stays
 * under MAX_EXPANDED_ELEMENTS but is 50 GB of path data for the plugin.
 */
export const MAX_EXPANDED_BYTES = 32 * MiB;
/** Nesting once <use> and url(#…) references are followed (MAX_DEPTH bounds literal nesting only). */
export const MAX_EXPANDED_DEPTH = 2 * MAX_DEPTH;
/**
 * Distinct paint servers (or markers) one element can inherit for one of
 * fill, stroke, marker-start, marker-end. Past this the counter treats the
 * value as over the cap: a real element has one or two candidates.
 */
export const MAX_REF_CANDIDATES = 16;
/**
 * Distinct inherited-value sets (and contexts and unions of them) the
 * expansion counter keeps for one SVG. Their number is chosen by the input
 * (every element matching a different mix of class rules, every <use>
 * passing different candidates down); a few hundred bytes each, so this
 * keeps one SVG well under a 128 MB Workers isolate. A real file needs a few
 * per distinct paint server; past this the file is over the expansion caps.
 */
export const MAX_INTERNED = 50_000;
/** Distinct notes one SVG can produce (the response shows MAX_NOTES_PER_ITEM). */
export const MAX_NOTES = 32;
/** Distinct element names in `removed.elements`; the rest count under "(other)". */
export const MAX_REMOVED_KINDS = 32;
export const MAX_STYLE_BYTES = 64 * KiB;
export const MAX_STYLE_TOTAL_BYTES = 256 * KiB;
export const MAX_ENTITIES = 64;
export const MAX_ENTITY_VALUE = 1 * KiB;
/**
 * Characters that declared DOCTYPE entities may add to one SVG, in total.
 * Values can't nest, but one 1 KiB entity referenced 400,000 times would still
 * expand a 1 MB file to 400 MB; real files only use short ones (Illustrator's
 * namespace entities), so 1 MiB is generous.
 */
export const MAX_ENTITY_EXPANSION = 1 * MiB;
export const MAX_DATA_URI_BYTES = 4 * MiB;
/** Subjects longer than this never match variants.pattern (keeps matching cheap). */
export const MAX_PATTERN_SUBJECT = 300;

// ---- Chunking and planning -----------------------------------------------

export const CHUNK_MAX_ITEMS = 50;
export const CHUNK_MAX_BYTES = 1.5 * MiB;
export const CHUNK_MAX_EXPANDED = 100_000;
/** A whole set group travels in one chunk, so it has a hard ceiling. */
export const CHUNK_HARD_MAX_BYTES = 12 * MiB;
/** Same cap as CREATE_COMPONENT_SET in the bridge. */
export const MAX_VARIANTS_PER_SET = 100;
export const MAX_NAME_LENGTH = 200;
export const MAX_TITLE_LENGTH = 100;
/** Instance counts and publish status are read for at most this many targets. */
export const MAX_COUNTED_TARGETS = 200;
export const MAX_FULL_ITEMS = 150;
export const MAX_NOTES_PER_ITEM = 3;

// ---- Time ----------------------------------------------------------------

/** Wall-clock budget of one call's write phase. */
export const BUDGET_SYNC_MS = 240_000;
export const BUDGET_TASK_MS = 900_000;
export const BUDGET_CLOUD_MS = 120_000;
/** A busy marker older than this is assumed to be left over from a crash. */
export const BUSY_MARKER_STALE_MS = 900_000;

export const PREFLIGHT_TIMEOUT_FILE_MS = 60_000;
export const PREFLIGHT_TIMEOUT_PAGE_MS = 20_000;
export const PREFLIGHT_LIBRARY_EXTRA_MS = 15_000;
export const CHECKPOINT_TIMEOUT_MS = 30_000;
export const CONTAINER_TIMEOUT_MS = 15_000;

/**
 * FIGMA_CONSOLE_ASSET_TIMEOUT_SCALE multiplies every plugin timeout: slow
 * machines raise it, live tests force timeouts with 0.05. Read per call so a
 * changed environment takes effect without a restart.
 */
export function timeoutScale(): number {
	// `process` may be absent in Cloudflare Workers without nodejs_compat.
	const raw = typeof process !== "undefined" ? process.env?.FIGMA_CONSOLE_ASSET_TIMEOUT_SCALE : undefined;
	const n = raw === undefined || raw === "" ? 1 : Number(raw);
	if (!Number.isFinite(n)) return 1;
	return Math.min(10, Math.max(0.05, n));
}

export function scaledTimeout(ms: number): number {
	return Math.round(ms * timeoutScale());
}

/** One import chunk: grows with items, payload size and expanded elements. */
export function chunkTimeoutMs(items: number, jsonBytes: number, expanded: number): number {
	const raw = 10_000 + 400 * items + 4_000 * Math.ceil(jsonBytes / 102_400) + 0.4 * expanded;
	return scaledTimeout(Math.min(120_000, Math.max(15_000, raw)));
}

// ---- Editors -------------------------------------------------------------

export interface EditorSupport {
	vectors: boolean;
	components: boolean;
	variableBinding: boolean;
	/** "group" = FigJam fallback when a frame can't be placed (P0.1). */
	importMode: "frame" | "group";
}

/**
 * What each editor supports, from the live gate P0 (spec §0) run on
 * 2026-11-27 (.notes/parity/live-results.md):
 *   P0.1 FigJam: createNodeFromSvg returns a FRAME that a section accepts → vectors, "frame".
 *   P0.2 FigJam: figma.variables is undefined → no variable binding (the scripts
 *        also never touch figma.variables there).
 *   P0.3/P0.4 Slides: vectors on a slide, and variable binding, both work.
 * Components and sets are Design-only (figma.createComponent is undefined in
 * FigJam and Slides). The plugin scripts only look these up.
 */
export const EDITOR_SUPPORT: Readonly<Record<"figma" | "figjam" | "slides", EditorSupport>> = {
	figma: { vectors: true, components: true, variableBinding: true, importMode: "frame" },
	figjam: { vectors: true, components: false, variableBinding: false, importMode: "frame" },
	slides: { vectors: true, components: false, variableBinding: true, importMode: "frame" },
};

// ---- Export (figma_export_assets, spec §3.8) -------------------------------

export const MAX_EXPORT_NODES = 50;
/** Renders (nodes × settings) plus vectors in one call. */
export const MAX_EXPORT_ASSETS = 200;
/** Figma's Export panel allows more, but ten covers every real setup and bounds renders per node. */
export const MAX_SETTINGS_PER_NODE = 10;
export const MAX_VECTOR_ASSETS = 50;
/** Explicit imageHashes plus images found by the scan. */
export const MAX_EXPORT_IMAGES = 50;
export const MAX_EXPLICIT_IMAGE_HASHES = 20;
/** Layers visited by the vector and image scans together, per call. */
export const MAX_SCAN_NODES = 5_000;
/** Figma's own render limits; bigger requests fail inside exportAsync after minutes of work. */
export const MAX_RASTER_SIDE = 16_384;
export const MAX_RASTER_AREA = 100_000_000;
export const MAX_ASSET_BYTES_FILES = 32 * MiB;
export const MAX_WRITE_BYTES_PER_CALL = 512 * MiB;
/** Base64 characters: one image block, and all image and PDF blocks of one call. */
export const MAX_INLINE_IMAGE_B64 = 1 * MiB;
export const MAX_INLINE_TOTAL_B64 = 4 * MiB;
export const DEFAULT_INLINE_SVG_KB = 96;
export const MAX_INLINE_SVG_KB = 512;
export const MAX_INLINE_PDF_BYTES = 256 * KiB;
export const REST_IDS_PER_REQUEST = 50;

export const EXPORT_PREFLIGHT_TIMEOUT_MS = 30_000;
export const EXPORT_PREFLIGHT_SCAN_TIMEOUT_MS = 45_000;
export const EXPORT_NODE_TIMEOUT_MS = 60_000;
export const EXPORT_IMAGE_TIMEOUT_MS = 30_000;

// ---- Raster import (figma_import_image, spec §10.6) -------------------------

/**
 * Decoded bytes per image. Figma's upload_assets takes 10 MB; 8 MiB keeps one
 * image's base64 (≈ 10.7 MiB) under the 12 MiB per-message ceiling that both
 * the Local WebSocket and the Cloud relay path are held to (§2.8).
 */
export const MAX_IMAGE_BYTES = 8 * MiB;
/** The Plugin API documents 4096 px per side as createImage's maximum. */
export const MAX_IMAGE_SIDE = 4096;
export const MAX_IMAGES_PER_CALL = 100;
export const CLOUD_MAX_IMAGES_PER_CALL = 50;
/** Base64 characters across every images[].data of one call. */
export const MAX_INLINE_IMAGE_TOTAL_B64 = 32 * MiB;
/** Schema cap for one images[].data string: base64 of MAX_IMAGE_BYTES plus line breaks and a data: prefix. */
export const MAX_IMAGE_DATA_CHARS = 12_000_000;
export const MAX_IMAGE_READ_BYTES_PER_CALL = 64 * MiB;
export const DEFAULT_IMAGE_DIRECTORY_LIMIT = 50;
export const MAX_FILL_TARGETS_PER_IMAGE = 100;
export const MAX_FILL_TARGETS_PER_CALL = 500;
export const IMAGE_CHUNK_MAX_ITEMS = 20;
/** Soft cap per EXECUTE_CODE call; one bigger image travels alone (MAX_IMAGE_BYTES bounds it). */
export const IMAGE_CHUNK_MAX_B64 = 4 * MiB;
export const IMAGE_PREFLIGHT_TIMEOUT_MS = 20_000;

/** One image chunk: decoding and uploading dominate, so it grows with base64 size. */
export function imageChunkTimeoutMs(items: number, b64Chars: number, fillTargets: number): number {
	const raw = 10_000 + 1_500 * items + 6_000 * Math.ceil(b64Chars / MiB) + 100 * fillTargets;
	return scaledTimeout(Math.min(120_000, Math.max(15_000, raw)));
}

/** Base64 length of n raw bytes. Used by the server and inlined in the plugin scripts. */
export function base64Length(n: number): number {
	return Math.ceil(n / 3) * 4;
}

/** "21.3 MB" style sizes for messages (MiB, one decimal, no trailing .0 for whole limits). */
export function formatMB(bytes: number): string {
	const v = bytes / MiB;
	return `${Number.isInteger(v) ? v : v.toFixed(1)} MB`;
}
