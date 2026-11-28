/**
 * figma_export_assets: PNG/JPG/SVG/PDF renders of up to 50 nodes, the SVGs of
 * vector layers inside them, and the original files behind image fills, as
 * files (Local Mode), inline content blocks, or Figma-hosted URLs.
 * Spec: .notes/parity/svg.md §3.
 *
 * Orchestration only; the rules live in ./assets/export-plan (arguments,
 * settings, names, budgets), ./assets/svg-code (code-ready SVG),
 * ./assets/plugin-scripts (what runs in Figma) and ./assets/run-control
 * (bridge outcomes, budget, never interleaving with a running script).
 *
 * Renders come from the live file through EXECUTE_CODE (exportAsync: any
 * plan, no token). REST is used only for output "urls", through FigmaAPI,
 * which never logs the token; the token-missing message never echoes why
 * getFigmaAPI failed. Asset bytes and SVG text are never logged.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { FigmaAPI } from "./figma-api.js";
import { createChildLogger } from "./logger.js";
import { runAsTaskIfSupported } from "./tasks.js";
import type { AssetToolsOptions } from "./assets/fs-types.js";
import {
	type ExportAssetsArgs,
	type ExportPlan,
	type ExportPreflight,
	InlineBudget,
	NOTHING_MESSAGE,
	NO_FILE_KEY_MESSAGE,
	type NormalizedExportArgs,
	type PlannedAsset,
	type PlannedImage,
	type SkipEntry,
	TOKEN_MESSAGE,
	base64Prefix,
	compileFileName,
	decodeBase64,
	groupForRest,
	imageSegments,
	normalizeExportArgs,
	planExport,
	rasterSize,
	restOptionsFor,
	sniffImage,
	validateExportArgs,
} from "./assets/export-plan.js";
import {
	BUDGET_CLOUD_MS,
	BUDGET_SYNC_MS,
	BUDGET_TASK_MS,
	EXPORT_IMAGE_TIMEOUT_MS,
	EXPORT_NODE_TIMEOUT_MS,
	EXPORT_PREFLIGHT_SCAN_TIMEOUT_MS,
	EXPORT_PREFLIGHT_TIMEOUT_MS,
	MAX_ASSET_BYTES_FILES,
	MAX_EXPORT_IMAGES,
	MAX_EXPORT_NODES,
	MAX_INLINE_IMAGE_B64,
	MAX_SCAN_NODES,
	MAX_SETTINGS_PER_NODE,
	MAX_VECTOR_ASSETS,
	MAX_WRITE_BYTES_PER_CALL,
	formatMB,
	scaledTimeout,
} from "./assets/limits.js";
import { EXPORT_IMAGE_BODY, EXPORT_NODE_BODY, EXPORT_PREFLIGHT_BODY, assetScript } from "./assets/plugin-scripts.js";
import { Budget, type BridgeOutcome, type StopReason, type WriteStep, classifyBridgeOutcome, runWritePhase } from "./assets/run-control.js";
import { toCodeSvg } from "./assets/svg-code.js";
import { utf8Length } from "./assets/svg-sanitize.js";

const logger = createChildLogger({ component: "asset-export-tools" });

export const EXPORT_ASSETS_DESCRIPTION =
	'Export layers for code: PNG, JPG, SVG or PDF renders of up to 50 nodes, the SVGs of icon and logo layers found inside them (vectors), and the original image files behind image fills (images). Renders come from the live file through the Desktop Bridge (any plan, no token, includes unsaved changes). With no format or scale, each node uses its own Export panel settings, or PNG at 1x. Local Mode writes files to outputDir (default: a new temp folder) and returns their paths; existing files are kept unless overwrite is true. output "inline" returns PNG/JPG as images you can see, SVG as text (96 KB per call by default) and small PDFs; output "urls" returns Figma-hosted links (needs a Figma token; renders the last saved version; render and vector links expire after 30 days, image-file links within 14). Cloud Mode: inline or urls. svg.currentColor makes single-color icons recolorable in code. To just look at a design, use figma_capture_screenshot. Call this tool directly.';

export const EXPORT_ASSETS_SCHEMA = z.object({
	nodeIds: z
		.array(z.string().min(1).max(500))
		.min(1)
		.max(50)
		.optional()
		.describe("Nodes to export ('123:456' or '123-456'). Default: the current selection."),
	format: z.enum(["PNG", "JPG", "SVG", "PDF"]).optional().describe("Overrides each node's Export settings. Omit to use them (PNG 1x when a node has none)."),
	scale: z.number().min(0.01).max(4).optional().describe("PNG/JPG scale; overrides Export settings."),
	width: z.number().int().min(1).max(16384).optional().describe("PNG/JPG: exact output width in px."),
	height: z.number().int().min(1).max(16384).optional().describe("PNG/JPG: exact output height in px."),
	svg: z
		.object({
			outlineText: z.boolean().optional().describe("Text as outlines (default true) or <text>."),
			includeIds: z.boolean().optional().describe("Layer names as id attributes (default false)."),
			simplifyStroke: z.boolean().optional().describe("Approximate inside/outside strokes (default true)."),
			currentColor: z
				.boolean()
				.optional()
				.describe("Single-color SVGs: replace the color with currentColor so code can recolor them (default false)."),
			removeSize: z.boolean().optional().describe("Drop the root width/height and keep the viewBox, so CSS sets the size (default false)."),
		})
		.optional(),
	contentsOnly: z.boolean().optional().describe("Only the node, not overlapping layers (default true)."),
	useAbsoluteBounds: z.boolean().optional().describe("Full node bounds even if cropped or empty (default false)."),
	colorProfile: z.enum(["DOCUMENT", "SRGB", "DISPLAY_P3_V4"]).optional(),
	vectors: z
		.enum(["none", "include", "only"])
		.optional()
		.describe("Also export the vector layers inside these nodes that are best kept as SVG (icons, logos), as SVG files (include), or only those (only). Default none."),
	images: z
		.enum(["none", "include", "only"])
		.optional()
		.describe("Also export the original image files used as image fills inside these nodes (include), or only those (only). Default none."),
	imageHashes: z
		.array(z.string().regex(/^[0-9a-f]{40}$/i))
		.max(20)
		.optional()
		.describe("Export these original images directly (imageHash from a node's fills)."),
	output: z
		.enum(["files", "inline", "urls"])
		.optional()
		.describe("files (Local Mode default), inline (Cloud Mode default), or urls (Figma-hosted links; needs a token)."),
	outputDir: z.string().max(4096).optional().describe("Local Mode only: absolute folder to write into. Default: a new folder in the OS temp directory."),
	fileName: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.describe("File name template without extension. Tokens: {name}, {path}, {leaf}, {set}, {variant}, {id}, {page}. '/' in the template makes subfolders. Default '{name}'."),
	overwrite: z.boolean().optional().describe("Replace existing files (default false)."),
	inlineSvgKB: z.number().int().min(8).max(512).optional().describe("output inline: SVG text budget per call in KB (default 96)."),
	fileKey: z.string().max(100).optional().describe("Local Mode: export from this open file. Rejected in Cloud Mode."),
});

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string };
type ResourceBlock = { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };
export type ExportContentBlock = TextBlock | ImageBlock | ResourceBlock;
export interface ExportToolResult {
	content: ExportContentBlock[];
	isError?: boolean;
}

function errorResult(error: string, hint?: string, extra?: Record<string, unknown>): ExportToolResult {
	return { content: [{ type: "text", text: JSON.stringify({ error, ...(hint ? { hint } : {}), ...(extra ?? {}) }) }], isError: true };
}

/** Connector surface this module uses (both Local and Cloud connectors provide it). */
interface ExecConnector {
	executeCodeViaUI(code: string, timeoutMs?: number, fileKey?: string): Promise<unknown>;
}

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errCode = (e: unknown) => (e as { code?: unknown } | null)?.code;
const MAX_NOTES = 20;

interface HandlerDeps {
	getDesktopConnector: () => Promise<unknown>;
	options: AssetToolsOptions;
}

/** getFigmaAPI may throw with config details; the caller only learns "no token". */
async function restApi(options: AssetToolsOptions): Promise<FigmaAPI | null> {
	if (!options.getFigmaAPI) return null;
	try {
		return (await options.getFigmaAPI()) ?? null;
	} catch {
		return null;
	}
}

export async function handleExportAssets(deps: HandlerDeps, rawArgs: ExportAssetsArgs, ctx: unknown): Promise<unknown> {
	const { options } = deps;
	const fs = options.fs;
	const remote = options.isRemoteMode ?? !fs;
	const n = normalizeExportArgs(rawArgs ?? {}, { hasFs: !!fs });
	const v = validateExportArgs(n, { hasFs: !!fs, remote });
	if (v.error) return errorResult(v.error, v.hint);
	const tpl = compileFileName(n.fileName);
	if (!tpl.ok) return errorResult(tpl.error);
	const notes = [...v.notes];

	// Before contacting Figma: a urls call without a token can't do anything useful.
	let api: FigmaAPI | null = null;
	if (n.output === "urls") {
		api = await restApi(options);
		if (!api) return errorResult(TOKEN_MESSAGE);
	}

	let connector: ExecConnector;
	try {
		connector = (await deps.getDesktopConnector()) as ExecConnector;
	} catch (e) {
		return errorResult(errMessage(e), "Make sure the Desktop Bridge plugin is running in Figma.");
	}
	// Routing: renders are pinned to the file the preflight resolved (Local Mode). Node ids like 1:2
	// exist in every file, so a render sent to another file that became active would write that
	// file's layer under this file's name. Cloud never takes a fileKey.
	let route: string | undefined = n.fileKey;
	const exec = (label: string, payload: unknown, body: string, timeoutMs: number) =>
		classifyBridgeOutcome(() => connector.executeCodeViaUI(assetScript(label, payload, body), timeoutMs, route));

	const scanning = n.vectors !== "none" || n.images !== "none";
	// imageHashes on their own export just those images; the selection is used whenever nodes matter.
	const useSelection = !n.nodeIds && (n.imageHashes.length === 0 || scanning);
	const preOutcome = await exec(
		"Export assets: resolve nodes",
		{
			nodeIds: n.nodeIds,
			useSelection,
			maxNodes: MAX_EXPORT_NODES,
			maxSettings: MAX_SETTINGS_PER_NODE,
			scanImages: n.images !== "none",
			scanVectors: n.vectors !== "none",
			maxScan: MAX_SCAN_NODES,
			maxVectors: MAX_VECTOR_ASSETS,
			maxImages: MAX_EXPORT_IMAGES,
		},
		EXPORT_PREFLIGHT_BODY,
		scaledTimeout(scanning ? EXPORT_PREFLIGHT_SCAN_TIMEOUT_MS : EXPORT_PREFLIGHT_TIMEOUT_MS),
	);
	if (preOutcome.kind === "maybeRunning") {
		return errorResult(
			`Figma didn't answer the export check in time (${preOutcome.error}). Nothing was exported.`,
			"Wait until Figma is idle (check with figma_capture_screenshot), then run the same call again. Fewer nodes, or vectors/images \"none\", make the check faster.",
		);
	}
	if (preOutcome.kind === "scriptError") return errorResult(`The export check failed in Figma: ${preOutcome.error}`);
	if (preOutcome.kind === "refused") return errorResult(preOutcome.error);
	const pre = preOutcome.result as ExportPreflight;
	if (!pre || typeof pre !== "object" || !Array.isArray(pre.nodes)) return errorResult("The export check returned nothing.");
	if (!remote) route = n.fileKey ?? pre.fileKey ?? undefined;

	const plan = planExport(n, pre, tpl.parts);
	notes.push(...plan.notes);
	if (!pre.nodes.length && !plan.images.length) {
		if (n.nodeIds) return errorResult("None of the nodes could be exported.", undefined, { skipped: plan.skipped });
		if (!n.imageHashes.length) return errorResult(NOTHING_MESSAGE);
	}

	const c: ExportContext = { n, pre, plan, notes, exec, remote, fs: options.fs };
	if (n.output === "urls") return urlsPhase(c, api as FigmaAPI);

	if (n.output === "files") {
		const afs = options.fs;
		if (!afs) return errorResult("Writing files is Local Mode only.");
		try {
			c.root = (await afs.prepareOutputDir(n.outputDir)).root;
		} catch (e) {
			return errorResult(errMessage(e));
		}
		// Check every path before rendering, so a skipped file costs no render (writeFile resolves it
		// again right before writing).
		const keep: PlannedAsset[] = [];
		for (const a of plan.assets) {
			const rel = a.segments.join("/");
			let res;
			try {
				res = await afs.resolveInside(c.root, a.segments);
			} catch (e) {
				res = { ok: false as const, reason: `Can't use "${rel}" (${String(errCode(e) ?? "error")}).` };
			}
			if (!res.ok) {
				plan.skipped.push({ nodeId: a.nodeId, file: rel, reason: res.reason });
				continue;
			}
			if (res.existing === "file" && !n.overwrite) {
				plan.skipped.push({ nodeId: a.nodeId, file: rel, reason: `"${rel}" already exists. Pass overwrite: true to replace it.`, exists: true });
				continue;
			}
			keep.push(a);
		}
		plan.assets = keep;
	}

	if (remote) return exportPhase(c, new AbortController().signal, BUDGET_CLOUD_MS);
	const count = plan.assets.length + plan.images.length;
	// runAsTaskIfSupported calls the work synchronously when it won't make a task,
	// and from a later microtask when it does: that tells the budget apart.
	let synchronous = true;
	const result = runAsTaskIfSupported(ctx, (signal) => exportPhase(c, signal, synchronous ? BUDGET_SYNC_MS : BUDGET_TASK_MS), {
		statusMessage: `Exporting ${count} asset${count === 1 ? "" : "s"}…`,
	});
	synchronous = false;
	return result;
}

interface ExportContext {
	n: NormalizedExportArgs;
	pre: ExportPreflight;
	plan: ExportPlan;
	notes: string[];
	exec: (label: string, payload: unknown, body: string, timeoutMs: number) => Promise<BridgeOutcome>;
	remote: boolean;
	fs?: AssetToolsOptions["fs"];
	root?: string;
}

interface RenderResult {
	error?: string;
	tooLarge?: boolean;
	bytes?: number;
	svg?: string;
	base64?: string;
	width?: number;
	height?: number;
}

function exportStopMessage(reason: StopReason, elapsedMs: number, error?: string): string {
	if (reason === "refused") return `${error ?? "Figma declined the next export."} Nothing more was sent. Export the rest (incomplete.notAttempted) in another call.`;
	if (reason === "maybeRunning") {
		return "Figma didn't answer in time and may still be exporting. Nothing more was sent. Wait until Figma is idle (check with figma_capture_screenshot), then export the rest (incomplete.notAttempted) in another call.";
	}
	if (reason === "budget") {
		return `Stopped after ${Math.round(elapsedMs / 1000)} s to stay within the time limit for one call. Export the rest (incomplete.notAttempted) in another call.`;
	}
	return "Cancelled. Export the rest (incomplete.notAttempted) in another call.";
}

/** files/inline: one plugin call per asset and per image, never more after a possible timeout. */
async function exportPhase(c: ExportContext, signal: AbortSignal, budgetMs: number): Promise<ExportToolResult> {
	const { n, plan } = c;
	const budget = new Budget(budgetMs);
	const inline = new InlineBudget(n.inlineSvgKB);
	const blocks: Array<ImageBlock | ResourceBlock> = [];
	const assets: Array<Record<string, unknown>> = [];
	const vectors: Array<Record<string, unknown>> = [];
	const images: Array<Record<string, unknown>> = [];
	const skipped: SkipEntry[] = plan.skipped;
	let written = 0;
	let bytesTotal = 0;
	const sent = new Set<string>();
	const done = new Set<string>();
	const skip = (e: SkipEntry, key?: string) => {
		skipped.push(e);
		if (key) done.add(key);
	};
	const writeLimitReason = `Reached the ${formatMB(MAX_WRITE_BYTES_PER_CALL)} limit for files written in one call. Export the rest in another call.`;
	const writeRoom = () => Math.max(0, MAX_WRITE_BYTES_PER_CALL - written);

	/**
	 * Write one file; its path, or null (with a skip entry) when it wasn't written. The path is
	 * resolved again right here, after the render: a folder swapped for a symbolic link while Figma
	 * was rendering (which can take minutes into a run) is caught instead of followed.
	 */
	const writeFile = async (segments: string[], data: Uint8Array | string, bytes: number, who: Omit<SkipEntry, "reason">): Promise<string | null> => {
		const afs = c.fs;
		const rel = segments.join("/");
		if (!afs || !c.root) return null;
		if (bytes > writeRoom()) {
			skipped.push({ ...who, file: rel, reason: writeLimitReason });
			return null;
		}
		let res;
		try {
			res = await afs.resolveInside(c.root, segments);
		} catch (e) {
			res = { ok: false as const, reason: `Can't use "${rel}" (${String(errCode(e) ?? "error")}).` };
		}
		if (!res.ok) {
			skipped.push({ ...who, file: rel, reason: res.reason });
			return null;
		}
		if (res.existing === "file" && !n.overwrite) {
			skipped.push({ ...who, file: rel, reason: `"${rel}" appeared while exporting; left as is.` });
			return null;
		}
		try {
			if (n.overwrite) await afs.writeReplace(res.path, data);
			else if ((await afs.writeNew(res.path, data)) === "exists") {
				skipped.push({ ...who, file: rel, reason: `"${rel}" appeared while exporting; left as is.` });
				return null;
			}
		} catch (e) {
			const reason = errCode(e) === "EUNSAFEPATH" ? `Won't write "${rel}": a folder on its path changed into a link or moved while exporting.` : `Couldn't write "${rel}" (${String(errCode(e) ?? "error")}).`;
			skipped.push({ ...who, file: rel, reason });
			return null;
		}
		written += bytes;
		return res.path;
	};

	const limitsFor = (a: PlannedAsset): Record<string, unknown> => {
		if (n.output === "files") return { maxBytes: Math.min(MAX_ASSET_BYTES_FILES, writeRoom()), inlineBase64: false };
		if (a.format === "SVG") return { maxBytes: Math.max(0, inline.svgRemaining), inlineBase64: false };
		if (a.format === "PDF") return { maxBytes: inline.pdf().maxBytes, inlineBase64: false };
		return { ...inline.raster(), inlineBase64: true };
	};

	/** Assets that can't fit any more are skipped without asking Figma to render them. */
	const preSkip = (a: PlannedAsset): string | null => {
		if (n.output === "files") return writeRoom() <= 0 ? writeLimitReason : null;
		if (a.format === "SVG") return inline.svgRemaining <= 0 ? inline.svgMessage() : null;
		if (inline.b64Remaining < 4) return inline.imageMessage(a.format, 0, false);
		return null;
	};

	const tooLargeReason = (a: PlannedAsset, bytes: number): string => {
		if (n.output === "files") {
			if (bytes <= MAX_ASSET_BYTES_FILES) return writeLimitReason;
			return `${a.format} is ${formatMB(bytes)}; files are limited to ${formatMB(MAX_ASSET_BYTES_FILES)} each. ${a.format === "PNG" || a.format === "JPG" ? "Use a smaller scale, or" : "Use"} output "urls".`;
		}
		if (a.format === "SVG") return inline.svgMessage();
		if (a.format === "PDF") return inline.pdfMessage(bytes);
		return inline.imageMessage(a.format, bytes, true);
	};

	const handleRender = async (a: PlannedAsset, r: RenderResult): Promise<void> => {
		const who = { nodeId: a.nodeId };
		const rel = a.segments.join("/");
		if (!r || typeof r !== "object") return skip({ ...who, reason: "Figma returned no result for this export." }, a.key);
		if (r.error) return skip({ ...who, reason: r.error }, a.key);
		if (r.tooLarge) return skip({ ...who, reason: tooLargeReason(a, r.bytes ?? 0) }, a.key);
		done.add(a.key);
		const entry: Record<string, unknown> = { nodeId: a.nodeId, name: a.name };
		if (a.kind === "render") {
			entry.format = a.format;
			if (a.scale !== undefined) entry.scale = a.scale;
			if (a.constraint) entry.constraint = a.constraint;
			if (a.suffix) entry.suffix = a.suffix;
		} else if (a.vector) {
			const vv = a.vector;
			entry.type = vv.type;
			if (vv.mainComponentName) entry.mainComponentName = vv.mainComponentName;
			if (vv.componentKey) entry.componentKey = vv.componentKey;
			entry.foundIn = vv.foundIn;
		}
		let width = a.estW ?? a.width;
		let height = a.estH ?? a.height;
		let bytes = 0;
		if (typeof r.svg === "string") {
			let svg = r.svg;
			if (n.svg.currentColor || n.svg.removeSize) {
				const code = toCodeSvg(svg, { currentColor: n.svg.currentColor, removeSize: n.svg.removeSize });
				svg = code.svg;
				for (const note of code.notes) c.notes.push(`${a.name}: ${note}`);
			}
			bytes = utf8Length(svg);
			width = a.width;
			height = a.height;
			if (n.output === "files") {
				const path = await writeFile(a.segments, svg, bytes, who);
				if (!path) return;
				entry.path = path;
			} else {
				// currentColor can make the text longer than what the plugin measured.
				if (bytes > inline.svgRemaining) return skip({ ...who, reason: inline.svgMessage() });
				inline.takeSvg(bytes);
				entry.svg = svg;
			}
		} else if (typeof r.base64 === "string") {
			bytes = r.bytes ?? Math.floor((r.base64.length * 3) / 4);
			if (n.output === "files") {
				const data = decodeBase64(r.base64);
				bytes = data.length;
				const px = a.format === "PNG" || a.format === "JPG" ? rasterSize(data) : null;
				if (px) ({ width, height } = px);
				const path = await writeFile(a.segments, data, bytes, who);
				if (!path) return;
				entry.path = path;
			} else {
				const len = r.base64.length;
				if (a.format === "PDF") {
					if (len > inline.b64Remaining) return skip({ ...who, reason: inline.pdfMessage(bytes) });
					inline.takeB64(len);
					blocks.push({ type: "resource", resource: { uri: pdfUri(a.nodeId, rel), mimeType: "application/pdf", blob: r.base64 } });
				} else {
					if (len > Math.min(MAX_INLINE_IMAGE_B64, inline.b64Remaining)) return skip({ ...who, reason: inline.imageMessage(a.format, bytes, true) });
					const px = rasterSize(base64Prefix(r.base64, 64 * 1024));
					if (px) ({ width, height } = px);
					inline.takeB64(len);
					blocks.push({ type: "image", data: r.base64, mimeType: a.mimeType });
				}
				// 1-based index among the result's content blocks; block 1 is this JSON.
				entry.block = blocks.length + 1;
			}
		} else {
			return skip({ ...who, reason: "Figma returned no data for this export." });
		}
		Object.assign(entry, { width, height, bytes, mimeType: a.mimeType });
		if (n.output !== "files") entry.file = rel;
		bytesTotal += bytes;
		(a.kind === "vector" ? vectors : assets).push(entry);
	};

	const handleImage = async (im: PlannedImage, r: RenderResult): Promise<void> => {
		const who = { imageHash: im.hash };
		if (!r || typeof r !== "object") return skip({ ...who, reason: "Figma returned no result for this image." });
		if (r.error === "missing") return skip({ ...who, reason: `Image ${im.hash} isn't in this file.` });
		if (r.error) return skip({ ...who, reason: r.error });
		if (r.tooLarge) {
			const b = r.bytes ?? 0;
			if (n.output === "files") {
				return skip({
					...who,
					reason: b <= MAX_ASSET_BYTES_FILES ? writeLimitReason : `Image is ${formatMB(b)}; files are limited to ${formatMB(MAX_ASSET_BYTES_FILES)} each. Use output "urls".`,
				});
			}
			return skip({ ...who, reason: inline.imageMessage("Image", b, false) });
		}
		if (typeof r.base64 !== "string") return skip({ ...who, reason: "Figma returned no data for this image." });
		const type = sniffImage(base64Prefix(r.base64, 16));
		const entry: Record<string, unknown> = { imageHash: im.hash, mimeType: type.mimeType, width: r.width ?? 0, height: r.height ?? 0, bytes: r.bytes ?? 0 };
		if (n.output === "files") {
			const afs = c.fs;
			if (!afs || !c.root) return;
			const segs = imageSegments(plan.registry, im.hash, type.ext);
			const rel = segs.join("/");
			let res;
			try {
				res = await afs.resolveInside(c.root, segs);
			} catch (e) {
				res = { ok: false as const, reason: `Can't use "${rel}" (${String(errCode(e) ?? "error")}).` };
			}
			if (!res.ok) return skip({ ...who, file: rel, reason: res.reason });
			if (res.existing === "file" && !n.overwrite) return skip({ ...who, file: rel, reason: `"${rel}" already exists. Pass overwrite: true to replace it.`, exists: true });
			const data = decodeBase64(r.base64);
			entry.bytes = data.length;
			const path = await writeFile(segs, data, data.length, who);
			if (!path) return;
			entry.path = path;
		} else {
			if (!type.viewable) {
				return skip({ ...who, reason: `Image ${im.hash} isn't PNG, JPEG, GIF or WebP, so it can't be shown inline. Use output "files" (Local Mode) or "urls".` });
			}
			const len = r.base64.length;
			if (len > Math.min(MAX_INLINE_IMAGE_B64, inline.b64Remaining)) return skip({ ...who, reason: inline.imageMessage("Image", r.bytes ?? 0, false) });
			inline.takeB64(len);
			blocks.push({ type: "image", data: r.base64, mimeType: type.mimeType });
			entry.block = blocks.length + 1;
		}
		entry.usedBy = im.usedBy;
		if (im.usedByCount > im.usedBy.length) entry.usedByCount = im.usedByCount;
		bytesTotal += (entry.bytes as number) ?? 0;
		images.push(entry);
	};

	let ai = 0;
	let ii = 0;
	const sentImages = new Set<string>();
	const next = (): WriteStep | null => {
		while (ai < plan.assets.length) {
			const a = plan.assets[ai++];
			const why = preSkip(a);
			if (why) {
				skip({ nodeId: a.nodeId, reason: why }, a.key);
				continue;
			}
			const timeoutMs = scaledTimeout(EXPORT_NODE_TIMEOUT_MS);
			return {
				label: "render",
				timeoutMs,
				run: async () => {
					sent.add(a.key);
					const o = await c.exec("Export assets: render", { id: a.nodeId, settings: a.settings, fileKey: c.pre.fileKey, ...limitsFor(a) }, EXPORT_NODE_BODY, timeoutMs);
					if (o.kind === "ok") await handleRender(a, o.result as RenderResult);
					else if (o.kind === "scriptError") skip({ nodeId: a.nodeId, reason: `Figma reported an error: ${o.error}` }, a.key);
					// Refused: nothing was rendered; it stays in incomplete.notAttempted.
					else if (o.kind === "refused") sent.delete(a.key);
					else skip({ nodeId: a.nodeId, reason: "Figma didn't answer in time; this export may still be running." }, a.key);
					return o;
				},
			};
		}
		while (ii < plan.images.length) {
			const im = plan.images[ii++];
			if (n.output === "files" ? writeRoom() <= 0 : inline.b64Remaining < 4) {
				skip({ imageHash: im.hash, reason: n.output === "files" ? writeLimitReason : inline.imageMessage("Image", 0, false) });
				continue;
			}
			const timeoutMs = scaledTimeout(EXPORT_IMAGE_TIMEOUT_MS);
			const lim = n.output === "files" ? { maxBytes: Math.min(MAX_ASSET_BYTES_FILES, writeRoom()), inlineBase64: false } : { ...inline.raster(), inlineBase64: true };
			return {
				label: "image",
				timeoutMs,
				run: async () => {
					sentImages.add(im.hash);
					const o = await c.exec("Export assets: original image", { hash: im.hash, fileKey: c.pre.fileKey, ...lim }, EXPORT_IMAGE_BODY, timeoutMs);
					if (o.kind === "ok") await handleImage(im, o.result as RenderResult);
					else if (o.kind === "scriptError") skip({ imageHash: im.hash, reason: `Figma reported an error: ${o.error}` });
					else if (o.kind === "refused") sentImages.delete(im.hash);
					else skip({ imageHash: im.hash, reason: "Figma didn't answer in time; this image may still be loading." });
					return o;
				},
			};
		}
		return null;
	};

	const phase = await runWritePhase({ budget, signal, next, onOutcome: () => {} });

	let incomplete: Record<string, unknown> | undefined;
	if (phase.stop) {
		const notAttempted = [...new Set(plan.assets.filter((a) => !sent.has(a.key) && !done.has(a.key)).map((a) => a.nodeId))];
		const notAttemptedImages = plan.images.filter((im) => !sentImages.has(im.hash)).map((im) => im.hash);
		incomplete = {
			reason: exportStopMessage(phase.stop.reason, phase.stop.elapsedMs, phase.stop.error),
			notAttempted,
			...(notAttemptedImages.length ? { notAttemptedImages } : {}),
		};
	}

	logger.info(
		{ output: n.output, assets: assets.length, vectors: vectors.length, images: images.length, skipped: skipped.length, bytes: bytesTotal, mode: c.remote ? "cloud" : "local" },
		"figma_export_assets",
	);

	const body = respond(c, { assets, vectors, images, skipped, incomplete, bytes: bytesTotal, inlineBytes: inline.inlineBytes });
	return { content: [{ type: "text", text: JSON.stringify(body.json) }, ...blocks], ...(body.isError ? { isError: true } : {}) };
}

function pdfUri(nodeId: string, rel: string): string {
	return `figma-export://${encodeURIComponent(nodeId)}/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

function respond(
	c: ExportContext,
	r: {
		assets: Array<Record<string, unknown>>;
		vectors: Array<Record<string, unknown>>;
		images: Array<Record<string, unknown>>;
		skipped: SkipEntry[];
		incomplete?: Record<string, unknown>;
		bytes: number;
		inlineBytes: number;
	},
): { json: Record<string, unknown>; isError: boolean } {
	const exported = r.assets.length + r.vectors.length + r.images.length;
	const notes = [...new Set(c.notes)];
	const shown = notes.length > MAX_NOTES ? [...notes.slice(0, MAX_NOTES), `…and ${notes.length - MAX_NOTES} more notes.`] : notes;
	const json: Record<string, unknown> = {
		// Files left alone only because they already exist don't make a sync export unsuccessful.
		success: r.skipped.every((sk) => sk.exists) && !r.incomplete && exported > 0,
		output: c.n.output,
		...(c.root ? { outputDir: c.root } : {}),
		assets: r.assets,
		vectors: r.vectors,
		images: r.images,
		skipped: r.skipped,
		...(r.incomplete ? { incomplete: r.incomplete } : {}),
		...(shown.length ? { notes: shown } : {}),
		totals: { assets: r.assets.length, vectors: r.vectors.length, images: r.images.length, bytes: r.bytes, inlineBytes: r.inlineBytes },
	};
	// Re-running an export into the same folder is the normal way to sync assets, so files that
	// were only left alone because they already exist aren't a failure: say how to refresh them.
	const existing = r.skipped.filter((s) => s.exists).length;
	if (existing > 0) {
		json.hint = `${existing === 1 ? "1 file already exists and was" : `${existing} files already exist and were`} left as is. To refresh ${existing === 1 ? "it" : "them"} from Figma, run again with overwrite: true (unchanged files stay byte-identical).`;
	}
	const onlyExisting = existing > 0 && existing === r.skipped.length && !r.incomplete;
	return { json, isError: exported === 0 && !onlyExisting };
}

/**
 * output "urls": no plugin renders. Renders and vectors are grouped by REST
 * options (≤ 50 ids per request); images come from one getImageFills call.
 * These render the last saved version of the file.
 */
async function urlsPhase(c: ExportContext, api: FigmaAPI): Promise<ExportToolResult> {
	const { n, pre, plan } = c;
	const fileKey = pre.fileKey ?? n.fileKey;
	if (!fileKey) return errorResult(NO_FILE_KEY_MESSAGE);
	const assets: Array<Record<string, unknown>> = [];
	const vectors: Array<Record<string, unknown>> = [];
	const images: Array<Record<string, unknown>> = [];
	const skipped = plan.skipped;
	const short = (e: unknown) => errMessage(e).slice(0, 300);

	const items = plan.assets.map((a) => {
		const r = restOptionsFor(a, c.notes);
		return { a, key: a.key, nodeId: a.nodeId, options: r.options, scale: r.scale };
	});
	const resultKey = (options: unknown, id: string) => `${JSON.stringify(options)}|${id}`;
	const urls = new Map<string, string | null>();
	const failures = new Map<string, string>();
	for (const g of groupForRest(items)) {
		try {
			const res = await api.getImages(fileKey, g.ids, g.options);
			for (const id of g.ids) urls.set(resultKey(g.options, id), res?.images?.[id] ?? null);
		} catch (e) {
			for (const id of g.ids) failures.set(resultKey(g.options, id), short(e));
		}
	}
	for (const it of items) {
		const { a } = it;
		const k = resultKey(it.options, it.nodeId);
		const failure = failures.get(k);
		if (failure) {
			skipped.push({ nodeId: a.nodeId, reason: `Figma's REST API failed for ${a.name}: ${failure}` });
			continue;
		}
		const url = urls.get(k);
		if (!url) {
			skipped.push({ nodeId: a.nodeId, reason: `Figma's REST API couldn't render ${a.name}.` });
			continue;
		}
		const entry: Record<string, unknown> = { nodeId: a.nodeId, name: a.name };
		if (a.kind === "render") {
			entry.format = a.format;
			if (it.scale !== undefined) entry.scale = it.scale;
			if (a.suffix) entry.suffix = a.suffix;
		} else if (a.vector) {
			entry.type = a.vector.type;
			if (a.vector.mainComponentName) entry.mainComponentName = a.vector.mainComponentName;
			if (a.vector.componentKey) entry.componentKey = a.vector.componentKey;
			entry.foundIn = a.vector.foundIn;
			entry.width = a.vector.width;
			entry.height = a.vector.height;
		}
		Object.assign(entry, { mimeType: a.mimeType, file: a.segments.join("/"), url, expiresInDays: 30, renderedFrom: "saved version" });
		(a.kind === "vector" ? vectors : assets).push(entry);
	}

	if (plan.images.length) {
		let fills: Record<string, string> = {};
		let failure: string | null = null;
		try {
			const res = await api.getImageFills(fileKey);
			fills = res?.meta?.images ?? {};
		} catch (e) {
			failure = short(e);
		}
		const lower = new Map(Object.entries(fills).map(([k, u]) => [k.toLowerCase(), u]));
		for (const im of plan.images) {
			if (failure) {
				skipped.push({ imageHash: im.hash, reason: `Figma's REST API failed for the image fills: ${failure}` });
				continue;
			}
			const url = lower.get(im.hash);
			if (!url) {
				skipped.push({ imageHash: im.hash, reason: `Image ${im.hash} isn't in this file.` });
				continue;
			}
			// Figma documents image-fill URLs as expiring after at most 14 days (render URLs: 30).
			images.push({ imageHash: im.hash, usedBy: im.usedBy, ...(im.usedByCount > im.usedBy.length ? { usedByCount: im.usedByCount } : {}), url, expiresInDays: 14 });
		}
	}

	logger.info({ output: "urls", assets: assets.length, vectors: vectors.length, images: images.length, skipped: skipped.length, mode: c.remote ? "cloud" : "local" }, "figma_export_assets");
	const body = respond(c, { assets, vectors, images, skipped, bytes: 0, inlineBytes: 0 });
	return { content: [{ type: "text", text: JSON.stringify(body.json) }], ...(body.isError ? { isError: true } : {}) };
}

export function registerExportAssetsTool(server: McpServer, getDesktopConnector: () => Promise<any>, options: AssetToolsOptions = {}): void {
	server.registerTool(
		"figma_export_assets",
		{ description: EXPORT_ASSETS_DESCRIPTION, inputSchema: EXPORT_ASSETS_SCHEMA },
		async (args: z.infer<typeof EXPORT_ASSETS_SCHEMA>, ctx: unknown) => {
			try {
				return (await handleExportAssets({ getDesktopConnector, options }, args as ExportAssetsArgs, ctx)) as any;
			} catch (error) {
				logger.error({ error: errMessage(error) }, "figma_export_assets failed");
				return errorResult(errMessage(error), "Make sure the Desktop Bridge plugin is running in Figma.") as any;
			}
		},
	);
}
