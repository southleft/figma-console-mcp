/**
 * figma_import_image: PNG/JPEG/GIF images → new layers with an image fill,
 * or the fill of existing layers (spec .notes/parity/svg.md §10). With
 * figma_import_svg this covers both halves of Figma's upload_assets.
 *
 * Orchestration only; the rules live in ./assets/image-plan (arguments,
 * base64, magic bytes, sizes, layout, chunks, response), ./assets/image-scripts
 * (what runs in Figma) and ./assets/run-control (bridge outcomes, budget,
 * never interleaving with a script that may still be running).
 *
 * Every plugin step is a generated EXECUTE_CODE script, so the Desktop Bridge
 * needs no change; figma_set_image_fill's plugin approach is reused, not its
 * file. No REST call and no token. Image data is never logged or echoed.
 * Filesystem access is injected (options.fs), exactly as for the SVG import.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createChildLogger } from "./logger.js";
import { runAsTaskIfSupported } from "./tasks.js";
import { decodeBase64 } from "./assets/export-plan.js";
import type { AssetToolsOptions } from "./assets/fs-types.js";
import {
	HEAD_B64_CHARS,
	type ImageChunk,
	type ImageItem,
	type ImagePreflight,
	type ImportImageArgs,
	type NormalizedImageArgs,
	FORMAT_LABEL,
	assembleImageResponse,
	boxOf,
	buildImageChunks,
	dataHash,
	densityFromName,
	encodeBase64,
	failItem,
	fileStem,
	formatFromExtension,
	imageName,
	imageStopMessage,
	inspectImage,
	normalizeBase64,
	normalizeImageArgs,
	planImageLayout,
	planImages,
	targetIdsOf,
	validateImageArgs,
} from "./assets/image-plan.js";
import { IMAGE_CONTAINER_BODY, IMAGE_IMPORT_BODY, IMAGE_PREFLIGHT_BODY } from "./assets/image-scripts.js";
import type { LayoutPlan } from "./assets/import-plan.js";
import {
	BUDGET_CLOUD_MS,
	BUDGET_SYNC_MS,
	BUDGET_TASK_MS,
	BUSY_MARKER_STALE_MS,
	CONTAINER_TIMEOUT_MS,
	IMAGE_PREFLIGHT_TIMEOUT_MS,
	MAX_DIR_DEPTH,
	MAX_DIR_SCAN,
	MAX_IMAGES_PER_CALL,
	MAX_IMAGE_BYTES,
	MAX_IMAGE_DATA_CHARS,
	MAX_IMAGE_READ_BYTES_PER_CALL,
	formatMB,
	imageChunkTimeoutMs,
	scaledTimeout,
} from "./assets/limits.js";
import { assetScript } from "./assets/plugin-scripts.js";
import { Budget, type BridgeOutcome, WRITE_LOCK_MESSAGE, acquireWriteLock, classifyBridgeOutcome, runWritePhase, type WriteStep } from "./assets/run-control.js";
import { naturalCompare, newRunId } from "./assets/svg-naming.js";

const logger = createChildLogger({ component: "image-import-tools" });

export const IMPORT_IMAGE_DESCRIPTION =
	'Import raster images (PNG, JPEG, GIF) into Figma: as new layers with an image fill, or as the fill of existing layers (nodeIds). Pass base64 data (a data: URL is fine) or, in Local Mode, file paths or a whole folder. New layers are rectangles (nodeType "frame" for frames) at the image\'s pixel size (an @2x/@3x file name, or density, places it at 1x), or fitted to width/height; several images are laid out in a grid frame. scaleMode (FILL, FIT, CROP, TILE) sets how the image sits in its layer, as in Figma\'s fill panel. Up to 8 MB and 4096 px per side per image; WebP, HEIC and SVG aren\'t accepted (use figma_import_svg for SVG). Images Figma can\'t read are reported and the rest still import. dryRun checks everything without changing Figma. Check the result with figma_capture_screenshot.';

const NODE_ID = z.string().min(1).max(500);

const IMAGE_INPUT = z.object({
	data: z
		.string()
		.min(1)
		.max(MAX_IMAGE_DATA_CHARS)
		.optional()
		.describe("Base64 PNG, JPEG or GIF bytes; a data:image/...;base64, URL is fine. Up to 8 MB per image."),
	path: z.string().max(4096).optional().describe("Local Mode only: absolute path of a .png, .jpg, .jpeg or .gif file."),
	name: z.string().max(200).optional().describe("Layer name. Default: the file name without extension, else 'Image'."),
	nodeIds: z
		.array(NODE_ID)
		.min(1)
		.max(100)
		.optional()
		.describe("Put this image into the fills of these existing layers instead of creating a new layer."),
});

export const IMPORT_IMAGE_SCHEMA = z.object({
	images: z.array(IMAGE_INPUT).max(MAX_IMAGES_PER_CALL).optional().describe("Images, each as base64 data or (Local Mode) a file path. 32 MB of base64 in total per call."),
	directory: z.string().max(4096).optional().describe("Local Mode only: absolute path of a folder; imports its .png, .jpg, .jpeg and .gif files."),
	recursive: z.boolean().optional().describe("Include subfolders of directory (up to 6 levels). Default false."),
	offset: z.number().int().min(0).optional().describe("Paging through a big folder: start at this file index (remaining.nextOffset from the previous call). Default 0."),
	limit: z.number().int().min(1).max(MAX_IMAGES_PER_CALL).optional().describe("Files of directory per call. Default 50."),
	nodeIds: z.array(NODE_ID).min(1).max(100).optional().describe("With exactly one image: put it into the fills of these existing layers (same as images[0].nodeIds)."),

	parentId: z
		.string()
		.max(500)
		.optional()
		.describe("Frame, section, group, page or slide for new layers. Default: current page (Slides: the focused slide)."),
	x: z.number().min(-1e6).max(1e6).optional().describe("X of the new layer (one image) or of the new container, relative to the parent. Default: clear space."),
	y: z.number().min(-1e6).max(1e6).optional(),

	width: z.number().min(1).max(16_384).optional().describe("Width of new layers; with only width, the height follows the image's aspect ratio."),
	height: z.number().min(1).max(16_384).optional().describe("Height of new layers; with only height, the width follows the image's aspect ratio."),
	fit: z
		.enum(["contain", "exact"])
		.optional()
		.describe("With width and height: contain (default) keeps the aspect ratio inside width×height; exact makes the layer exactly width×height and scaleMode decides how the image sits."),
	density: z.number().min(0.25).max(8).optional().describe("Image pixels per layer unit: 2 places a 2x image at half its pixel size. Default: from an @2x/@3x name suffix, else 1."),
	scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional().describe("How the image sits in its layer, as in Figma's fill panel. Default FILL."),
	nodeType: z.enum(["rectangle", "frame"]).optional().describe("New layers are rectangles (default, as when you drop an image into Figma) or frames."),

	layout: z
		.object({
			container: z
				.enum(["auto", "section", "frame", "none"])
				.optional()
				.describe("auto (default): a wrapping frame for several new layers (a section in FigJam), none for one image or an auto-layout parent."),
			containerName: z.string().min(1).max(200).optional().describe("Default 'Images'. An existing section/frame with this name in the parent is reused."),
			columns: z.number().int().min(1).max(100).optional().describe("Default: a near-square grid, at most 12 columns."),
			gap: z.number().min(0).max(1000).optional().describe("Default 24."),
			padding: z.number().min(0).max(1000).optional().describe("Default 40."),
		})
		.optional(),

	focus: z.boolean().optional().describe("Select new layers and scroll to them when they're on the current page. Default true."),
	dryRun: z.boolean().optional().describe("Check formats, sizes and targets and report what would happen, without changing Figma. Default false."),
	resumeRunId: z
		.string()
		.regex(/^[0-9a-f]{12}$/)
		.optional()
		.describe("After an interrupted import: the incomplete.runId it returned. Images that run already placed are reported, not placed twice."),
	verbose: z.boolean().optional().describe("Return full details for every image, not only problems and fills. Default false."),
	fileKey: z.string().max(100).optional().describe("Local Mode: run in this open file. Rejected in Cloud Mode."),
});

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function errorResult(error: string, hint?: string): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify({ error, ...(hint ? { hint } : {}) }) }], isError: true };
}

function textResult(body: unknown, isError: boolean): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(body) }], ...(isError ? { isError: true } : {}) };
}

/** Connector surface this module uses (both Local and Cloud connectors provide it). */
interface ExecConnector {
	executeCodeViaUI(code: string, timeoutMs?: number, fileKey?: string): Promise<unknown>;
}

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ===========================================================================
// Sources: images[] (data or path) and a directory page
// ===========================================================================

interface Gathered {
	items: ImageItem[];
	remaining?: { count: number; nextOffset?: number; images?: string[] };
	notes: string[];
	bytes: number;
}

/**
 * Density: the explicit option, else an @2x suffix on the file name (it
 * describes the pixels), else on the given layer name, else 1.
 */
function newItem(key: string, source: string, kind: ImageItem["kind"], name: string, n: NormalizedImageArgs, path?: string, nodeIds?: string[]): ImageItem {
	const density = n.density ?? (path !== undefined ? densityFromName(fileStem(path)) : undefined) ?? densityFromName(name) ?? 1;
	return { key, source, kind, name, density, nodeIds, notes: [] };
}

/** Format and pixel size from the bytes; the failure stage is "format". */
function acceptInspected(it: ImageItem, head: Uint8Array, all: () => Uint8Array, path?: string): boolean {
	const info = inspectImage(head, all);
	if (!info.ok) {
		failItem(it, "format", info.error);
		return false;
	}
	it.format = info.format;
	it.pixelWidth = info.width;
	it.pixelHeight = info.height;
	const claimed = path ? formatFromExtension(path) : null;
	if (claimed && claimed !== info.format) it.notes.push(`The file is a ${FORMAT_LABEL[info.format]} despite its extension.`);
	return true;
}

async function acceptBase64(it: ImageItem, data: string): Promise<void> {
	const r = normalizeBase64(data);
	if (!r.ok) return failItem(it, "decode", `${it.source}.data ${r.error}`);
	if (r.bytes > MAX_IMAGE_BYTES) return failItem(it, "decode", `${it.source} is ${formatMB(r.bytes)}; the limit per image is ${formatMB(MAX_IMAGE_BYTES)}.`);
	const head = decodeBase64(r.b64.slice(0, HEAD_B64_CHARS));
	if (!acceptInspected(it, head, () => decodeBase64(r.b64))) return;
	it.data = r.b64;
	it.bytes = r.bytes;
	it.hash = await dataHash(r.b64);
}

async function acceptBytes(it: ImageItem, bytes: Uint8Array, path: string): Promise<void> {
	if (!acceptInspected(it, bytes, () => bytes, path)) return;
	it.data = encodeBase64(bytes);
	it.bytes = bytes.length;
	it.hash = await dataHash(it.data);
}

async function gatherImages(n: NormalizedImageArgs, options: AssetToolsOptions): Promise<Gathered | { error: string; hint?: string }> {
	const items: ImageItem[] = [];
	const notes: string[] = [];
	const fs = options.fs;
	let bytesRead = 0;
	let k = 0;
	const unread: string[] = [];

	for (let i = 0; i < n.images.length; i++) {
		const img = n.images[i];
		if (img.data !== undefined) {
			const it = newItem(`i${k++}`, `images[${i}]`, "inline", imageName(img.name, undefined), n, undefined, img.nodeIds);
			items.push(it);
			await acceptBase64(it, img.data);
			continue;
		}
		const path = img.path as string;
		if (!fs) continue; // validation rejects paths without a filesystem
		if (bytesRead >= MAX_IMAGE_READ_BYTES_PER_CALL) {
			unread.push(`images[${i}]`);
			continue;
		}
		const name = imageName(img.name, path);
		try {
			const { bytes } = await fs.readImageFile(path, MAX_IMAGE_BYTES);
			// The size is known only after the read (readImageFile caps it), so one file may go over the budget; it's left for the next call.
			if (bytesRead > 0 && bytesRead + bytes.length > MAX_IMAGE_READ_BYTES_PER_CALL) {
				unread.push(`images[${i}]`);
				continue;
			}
			bytesRead += bytes.length;
			const it = newItem(`i${k++}`, path, "path", name, n, path, img.nodeIds);
			items.push(it);
			await acceptBytes(it, bytes, path);
		} catch (e) {
			const it = newItem(`i${k++}`, path, "path", name, n, path, img.nodeIds);
			items.push(it);
			failItem(it, "read", errMessage(e));
		}
	}

	let remaining: Gathered["remaining"];
	if (n.directory && fs) {
		let listing;
		try {
			listing = await fs.listImageFiles(n.directory, { recursive: n.recursive, maxDepth: MAX_DIR_DEPTH, maxScan: MAX_DIR_SCAN });
		} catch (e) {
			return { error: errMessage(e) };
		}
		if (!listing.files.length) {
			return { error: `No PNG, JPEG or GIF files in ${n.directory}`, ...(listing.skippedSubfolders && !n.recursive ? { hint: "Pass recursive: true to include subfolders." } : {}) };
		}
		if (listing.truncated) notes.push(`Stopped listing after ${MAX_DIR_SCAN.toLocaleString("en-US")} entries (in the order the filesystem returns them); files beyond that weren't seen.`);
		const files = listing.files.slice().sort((a, b) => naturalCompare(a.relPath, b.relPath));
		if (n.offset >= files.length) return { error: `offset ${n.offset} is past the end of ${n.directory} (${files.length} image files).` };
		const room = MAX_IMAGES_PER_CALL - n.images.length;
		const limit = Math.min(n.limit, room);
		if (limit < n.limit) notes.push(`The directory page was limited to ${limit} files so the call stays within ${MAX_IMAGES_PER_CALL} images.`);
		let consumed = n.offset;
		for (const f of files.slice(n.offset, n.offset + limit)) {
			// The listing has sizes, so the read budget is checked before reading.
			if (bytesRead > 0 && bytesRead + f.size > MAX_IMAGE_READ_BYTES_PER_CALL) break;
			consumed++;
			const it = newItem(`i${k++}`, f.relPath, "dir", imageName(undefined, f.relPath), n, f.relPath);
			items.push(it);
			try {
				const { bytes } = await fs.readImageFile(f.path, MAX_IMAGE_BYTES);
				bytesRead += bytes.length;
				await acceptBytes(it, bytes, f.relPath);
			} catch (e) {
				failItem(it, "read", errMessage(e));
			}
		}
		if (consumed < files.length) remaining = { count: files.length - consumed, nextOffset: consumed };
	}
	if (unread.length) {
		remaining = { count: (remaining?.count ?? 0) + unread.length, ...(remaining?.nextOffset !== undefined ? { nextOffset: remaining.nextOffset } : {}), images: unread };
		notes.push(`Stopped reading files after ${formatMB(MAX_IMAGE_READ_BYTES_PER_CALL)}; the images in remaining.images weren't read. Import them in another call.`);
	}
	return { items, remaining, notes, bytes: bytesRead };
}

// ===========================================================================
// The handler
// ===========================================================================

interface HandlerDeps {
	getDesktopConnector: () => Promise<unknown>;
	options: AssetToolsOptions;
}

export async function handleImportImage(deps: HandlerDeps, rawArgs: ImportImageArgs, ctx: unknown): Promise<unknown> {
	const { options } = deps;
	const n = normalizeImageArgs(rawArgs ?? {});
	const remote = options.isRemoteMode ?? !options.fs;
	const v = validateImageArgs(n, { hasFs: !!options.fs, remote });
	if (v.error) return errorResult(v.error, v.hint);
	const notes = [...v.notes];

	const gathered = await gatherImages(n, options);
	if ("error" in gathered) return errorResult(gathered.error, gathered.hint);
	const { items, remaining } = gathered;
	notes.push(...gathered.notes);

	if (!items.some((it) => !it.status)) {
		const { body, isError } = assembleImageResponse({ n, items, remaining, notes });
		return textResult(body, isError);
	}

	// A resumed run keeps its runId, so a second resume still recognizes what the first run placed.
	const runId = n.resumeRunId ?? newRunId();
	let connector: ExecConnector;
	try {
		connector = (await deps.getDesktopConnector()) as ExecConnector;
	} catch (e) {
		return errorResult(errMessage(e), "Make sure the Desktop Bridge plugin is running in Figma.");
	}
	// Routing: after the preflight, every step is pinned to the file it saw (Local Mode), so another
	// open file becoming active mid-run can't receive the writes. Cloud never takes a fileKey.
	let route: string | undefined = n.fileKey;
	const exec = (label: string, payload: unknown, body: string, timeoutMs: number) =>
		classifyBridgeOutcome(() => connector.executeCodeViaUI(assetScript(label, payload, body), timeoutMs, route));

	// Preflight (read-only).
	const creates = items.filter((it) => !it.status && !it.nodeIds).length;
	const preOutcome = await exec(
		"Import images: check target",
		{
			runId,
			creates,
			parentId: n.parentId ?? null,
			containerName: n.layout.container === "none" ? null : n.layout.containerName,
			resumeRunId: n.resumeRunId ?? null,
			busyStaleMs: BUSY_MARKER_STALE_MS,
			targetIds: targetIdsOf(items),
		},
		IMAGE_PREFLIGHT_BODY,
		scaledTimeout(IMAGE_PREFLIGHT_TIMEOUT_MS),
	);
	if (preOutcome.kind === "maybeRunning") {
		return errorResult(
			`Figma didn't answer the pre-import check in time (${preOutcome.error}). Nothing was changed.`,
			"Wait until Figma is idle (check with figma_capture_screenshot), then run the same call again.",
		);
	}
	if (preOutcome.kind === "scriptError") return errorResult(`The pre-import check failed in Figma: ${preOutcome.error}. Nothing was changed.`);
	if (preOutcome.kind === "refused") return errorResult(`${preOutcome.error} Nothing was changed.`);
	const pre = preOutcome.result as ImagePreflight;
	if (!pre || typeof pre !== "object") return errorResult("The pre-import check returned nothing. Nothing was changed.");
	if (pre.fatal) return errorResult(pre.fatal);
	if (!remote) route = n.fileKey ?? pre.fileKey ?? undefined;
	if (!Array.isArray(pre.targets)) pre.targets = [];

	planImages(items, pre, n);
	const layout = planImageLayout(items, pre, n);
	if (layout.error) return errorResult(layout.error);
	notes.push(...layout.notes);

	if (n.dryRun) {
		const { body, isError } = assembleImageResponse({ n, items, pre, remaining, notes });
		return textResult(body, isError);
	}
	for (const it of items) if (it.action === "unchanged") it.status = "unchanged";

	// One write phase per file in this server (shared with figma_import_svg).
	const release = acquireWriteLock(pre.fileKey ?? n.fileKey ?? "active-file");
	if (!release) return errorResult(WRITE_LOCK_MESSAGE);
	const c: WriteContext = { n, pre, items, layout, runId, exec, remaining, notes, remote, bytes: gathered.bytes };
	try {
		if (remote) return await writePhase(c, new AbortController().signal, BUDGET_CLOUD_MS).finally(release);
		const count = items.filter((it) => it.action === "create" || it.action === "fill").length;
		// runAsTaskIfSupported calls the work synchronously when it won't make a task,
		// and from a later microtask when it does: that tells the budget apart.
		let synchronous = true;
		const result = runAsTaskIfSupported(ctx, (signal) => writePhase(c, signal, synchronous ? BUDGET_SYNC_MS : BUDGET_TASK_MS).finally(release), {
			statusMessage: `Importing ${count} image${count === 1 ? "" : "s"}…`,
		});
		synchronous = false;
		return await result;
	} catch (e) {
		release();
		throw e;
	}
}

interface WriteContext {
	n: NormalizedImageArgs;
	pre: ImagePreflight;
	items: ImageItem[];
	layout: LayoutPlan;
	runId: string;
	exec: (label: string, payload: unknown, body: string, timeoutMs: number) => Promise<BridgeOutcome>;
	remaining: Gathered["remaining"];
	notes: string[];
	remote: boolean;
	bytes: number;
}

interface ChunkResult {
	results?: Array<Record<string, unknown> & { key: string; status?: ImageItem["status"]; notes?: string[] }>;
	cursor?: unknown;
	newTopLevelIds?: string[];
	notes?: string[];
}

/** Fields a chunk result may set on an item (the plugin's reply is data, so it's copied field by field). */
const RESULT_FIELDS = ["status", "stage", "reason", "nodeId", "type", "width", "height", "imageHash", "pixelWidth", "pixelHeight", "filled"] as const;

async function writePhase(c: WriteContext, signal: AbortSignal, budgetMs: number): Promise<ToolResult> {
	const { n, pre, items, layout, runId } = c;
	const budget = new Budget(budgetMs);
	const byKey = new Map(items.map((it) => [it.key, it]));
	const creates = items.some((it) => it.action === "create");
	let container: { id: string; name: string; type: string; created: boolean } | undefined = layout.reuse
		? { id: layout.reuse.id, name: layout.containerName, type: layout.reuse.type, created: false }
		: undefined;
	let mode = layout.mode;
	let cursor: unknown = null;
	const focusIds: string[] = [];
	let containerDone = !(creates && layout.container !== "none" && !layout.reuse);
	const chunks: ImageChunk[] = buildImageChunks(items);
	let chunkIndex = 0;
	const sentKeys = new Set<string>();
	let inFlight: string[] = [];

	const next = (): WriteStep | null => {
		if (!containerDone) {
			containerDone = true;
			return {
				label: "container",
				setup: true,
				timeoutMs: scaledTimeout(CONTAINER_TIMEOUT_MS),
				run: () =>
					c.exec(
						"Import images: container",
						{
							runId,
							fileKey: pre.fileKey,
							busyStaleMs: BUSY_MARKER_STALE_MS,
							parentId: pre.parent?.id,
							type: layout.container,
							name: layout.containerName,
							gap: layout.gap,
							padding: layout.padding,
							...(layout.frameWidth ? { width: layout.frameWidth } : {}),
							...(n.x !== undefined && n.y !== undefined ? { x: n.x, y: n.y } : {}),
						},
						IMAGE_CONTAINER_BODY,
						scaledTimeout(CONTAINER_TIMEOUT_MS),
					),
			};
		}
		if (chunkIndex >= chunks.length) return null;
		const chunk = chunks[chunkIndex];
		const final = chunkIndex === chunks.length - 1;
		chunkIndex++;
		const timeoutMs = imageChunkTimeoutMs(chunk.items.length, chunk.b64Chars, chunk.fillTargets);
		return {
			label: "chunk",
			timeoutMs,
			run: () => {
				for (const key of chunk.keys) sentKeys.add(key);
				inFlight = chunk.keys;
				return c.exec(
					`Import images (${chunk.items.length} items)`,
					{
						runId,
						fileKey: pre.fileKey,
						busyStaleMs: BUSY_MARKER_STALE_MS,
						// New layers go into the container (or parent); a fills-only run has no target.
						targetId: creates ? (container?.id ?? pre.parent?.id ?? null) : null,
						final,
						focus: n.focus,
						focusIds: final ? focusIds : [],
						opts: { nodeType: n.nodeType, scaleMode: n.scaleMode, box: boxOf(n), fit: n.fit },
						layout: {
							mode,
							columns: layout.columns,
							gap: layout.gap,
							padding: layout.padding,
							...(layout.cell ? { cell: layout.cell } : {}),
							...(layout.origin ? { origin: layout.origin } : {}),
							pinned: n.x !== undefined && n.y !== undefined,
							cursor,
							container: container ? { id: container.id, created: container.created } : null,
						},
						items: chunk.items,
					},
					IMAGE_IMPORT_BODY,
					timeoutMs,
				);
			},
		};
	};

	const onOutcome = (step: WriteStep, outcome: BridgeOutcome) => {
		if (step.label === "container") {
			if (outcome.kind === "ok") {
				const r = outcome.result as { id: string; type: string; name: string; created: boolean; autoLayout?: boolean; notes?: unknown };
				container = { id: r.id, name: r.name, type: r.type, created: r.created };
				if (r.autoLayout) mode = "auto-layout";
				if (Array.isArray(r.notes)) c.notes.push(...r.notes.map(String));
				return;
			}
			if (outcome.kind === "scriptError") {
				c.notes.push(`Couldn't create the container (${outcome.error}); imported into the parent instead.`);
				if (mode === "auto-layout" && !pre.parent?.autoLayout) mode = "shelf";
			}
			return;
		}
		const keys = inFlight;
		inFlight = [];
		if (outcome.kind === "refused") {
			// The chunk didn't start: its images were never attempted.
			for (const key of keys) sentKeys.delete(key);
			return;
		}
		if (outcome.kind === "ok") {
			const r = (outcome.result ?? {}) as ChunkResult;
			for (const res of r.results ?? []) {
				const it = byKey.get(String(res.key));
				if (!it) continue;
				for (const f of RESULT_FIELDS) if (res[f] !== undefined) (it as unknown as Record<string, unknown>)[f] = res[f];
				if (Array.isArray(res.notes)) it.notes.push(...res.notes.map(String));
			}
			for (const key of keys) {
				const it = byKey.get(key);
				if (it && (it.status === undefined || it.status === "unknown")) Object.assign(it, { status: "failed", stage: "process", reason: "Figma returned no result for this image." });
			}
			if (r.cursor !== undefined) cursor = r.cursor;
			if (Array.isArray(r.newTopLevelIds)) focusIds.push(...r.newTopLevelIds);
			if (Array.isArray(r.notes)) c.notes.push(...r.notes.map(String));
			return;
		}
		for (const key of keys) {
			const it = byKey.get(key);
			if (!it) continue;
			if (outcome.kind === "scriptError") Object.assign(it, { status: "failed", stage: "import", reason: `Figma reported an error for this batch: ${outcome.error}` });
			else Object.assign(it, { status: "unknown", stage: "import", reason: "Figma didn't answer in time; this image may still be importing." });
		}
	};

	const phase = await runWritePhase({ budget, signal, next, onOutcome });

	let incomplete: { reason: string; runId: string; notAttempted: string[]; inProgress?: string[] } | undefined;
	if (phase.stop) {
		const notAttempted = items.filter((it) => (it.action === "create" || it.action === "fill") && !sentKeys.has(it.key) && !it.status).map((it) => it.name);
		const inProgress = items.filter((it) => it.status === "unknown").map((it) => it.name);
		incomplete = { reason: imageStopMessage(phase.stop.reason, runId, phase.stop.elapsedMs, phase.stop.error), runId, notAttempted, ...(inProgress.length ? { inProgress } : {}) };
	}

	logger.info({ items: items.length, bytes: c.bytes, chunks: chunkIndex, mode: c.remote ? "cloud" : "local", runId }, "figma_import_image");

	// The base64 isn't needed any more; drop it so a retained result can't hold megabytes.
	for (const it of items) delete it.data;
	const { body, isError } = assembleImageResponse({ n, items, runId, pre, ...(container ? { container } : {}), remaining: c.remaining, ...(incomplete ? { incomplete } : {}), notes: c.notes });
	return textResult(body, isError);
}

// ===========================================================================
// Registration
// ===========================================================================

/** Registers figma_import_image. registerAssetTools (./asset-tools.ts) calls this, so one call covers every asset tool. */
export function registerImportImageTool(server: McpServer, getDesktopConnector: () => Promise<any>, options: AssetToolsOptions = {}): void {
	server.registerTool(
		"figma_import_image",
		{ description: IMPORT_IMAGE_DESCRIPTION, inputSchema: IMPORT_IMAGE_SCHEMA },
		async (args: z.infer<typeof IMPORT_IMAGE_SCHEMA>, ctx: unknown) => {
			try {
				return (await handleImportImage({ getDesktopConnector, options }, args as ImportImageArgs, ctx)) as any;
			} catch (error) {
				logger.error({ error: errMessage(error) }, "figma_import_image failed");
				return errorResult(errMessage(error), "Make sure the Desktop Bridge plugin is running in Figma.") as any;
			}
		},
	);
}
