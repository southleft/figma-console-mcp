/**
 * Asset tools: figma_import_svg (SVG markup, files or folders → editable
 * vectors, icon components and variant sets) and, registered from their own
 * modules, figma_export_assets (./asset-export-tools.ts) and
 * figma_import_image (./image-import-tools.ts). Spec: .notes/parity/svg.md.
 *
 * This module only orchestrates; the rules live in ./assets/*:
 *   svg-sanitize (untrusted input), svg-naming (names, patterns, paging),
 *   import-plan (actions, risk, chunks, layout, response), run-control
 *   (bridge outcomes, budget), plugin-scripts (what runs in Figma).
 *
 * Every plugin step is a generated script run through EXECUTE_CODE, so the
 * Desktop Bridge plugin needs no change. Import never calls REST and never
 * touches the access token. Markup and file contents are never logged.
 *
 * Filesystem access is injected (options.fs): Local passes
 * createNodeAssetFs(), Cloud passes nothing and file features are rejected.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { confirmStep, confirmationsDisabled, fingerprint, notConfirmedResult, requestClientCapabilities, supportsForm } from "./confirm.js";
import { createChildLogger } from "./logger.js";
import { runAsTaskIfSupported } from "./tasks.js";
import { registerExportAssetsTool } from "./asset-export-tools.js";
import { registerImportImageTool } from "./image-import-tools.js";
import type { AssetToolsOptions } from "./assets/fs-types.js";
import {
	type Chunk,
	type ImportItem,
	type ImportSvgArgs,
	type NormalizedImportArgs,
	type PlanGroup,
	type PreflightResult,
	RESTORE_TITLE,
	allItems,
	assembleResponse,
	buildChunks,
	buildMatchQueries,
	confirmMessage,
	isRisky,
	normalizeImportArgs,
	planFromPreflight,
	planLayout,
	unsupportedSkipReason,
	validateImportArgs,
} from "./assets/import-plan.js";
import {
	BUDGET_CLOUD_MS,
	BUDGET_SYNC_MS,
	BUDGET_TASK_MS,
	BUSY_MARKER_STALE_MS,
	CHECKPOINT_TIMEOUT_MS,
	CONTAINER_TIMEOUT_MS,
	EDITOR_SUPPORT,
	MAX_COUNTED_TARGETS,
	MAX_DIR_DEPTH,
	MAX_DIR_SCAN,
	MAX_ITEMS_PER_CALL,
	MAX_READ_BYTES_PER_CALL,
	MAX_SVG_BYTES,
	MAX_VARIANTS_PER_SET,
	PREFLIGHT_LIBRARY_EXTRA_MS,
	PREFLIGHT_TIMEOUT_FILE_MS,
	PREFLIGHT_TIMEOUT_PAGE_MS,
	chunkTimeoutMs,
	formatMB,
	scaledTimeout,
} from "./assets/limits.js";
import { SVG_CHECKPOINT_BODY, SVG_CONTAINER_BODY, SVG_IMPORT_BODY, SVG_PREFLIGHT_BODY, assetScript } from "./assets/plugin-scripts.js";
import {
	Budget,
	type BridgeOutcome,
	WRITE_LOCK_MESSAGE,
	acquireWriteLock,
	classifyBridgeOutcome,
	runWritePhase,
	stopMessage,
	type WriteStep,
} from "./assets/run-control.js";
import { type CompiledPattern, type NameInput, artHashFor, compileVariantPattern, nameAndGroup, newRunId, pageDirectory } from "./assets/svg-naming.js";
import { sanitizeSvg } from "./assets/svg-sanitize.js";

const logger = createChildLogger({ component: "asset-tools" });

export type { AssetToolsOptions } from "./assets/fs-types.js";

export const IMPORT_SVG_DESCRIPTION = [
	"Import SVG markup as editable vector layers: one SVG or a batch (Local Mode can also read .svg files or a whole folder). Use it for icons, logos and illustrations, and to draw new ones: write the SVG yourself (give it a viewBox, use paths instead of <text>, and fill=\"currentColor\" or stroke=\"currentColor\" for single-color icons) and import it. This covers Figma's generate_vector_illustration without AI credits.",
	"- size: fit inside size×size (icons: 16, 20, 24). With asComponent, icons get an exact size×size frame with the art centered. width/height: fit within, keeping the aspect ratio.",
	'- asComponent: make each SVG an icon component whose artwork scales with the instance. variants.pattern builds component sets from names, e.g. "{name}-{Size}" or "{Size}/{Style}/{name}".',
	'- color: bind currentColor paints (or every paint of a single-color icon) to a COLOR variable, or set a color. Multi-color art is left alone unless color.apply is "all".',
	"- flatten: merge an icon into one vector, so later updates keep instance overrides.",
	"- A component with the same name is updated in place by default, so its instances get the new artwork. The person is asked first when it has instances or is published, and a restore version is saved first. onExisting and keepOverrides change this.",
	"Scripts, foreignObject and external links are removed. SVGs Figma can't read are reported with the reason; the rest of the batch still imports. dryRun previews names, sets and updates without changing Figma. Design files support everything; FigJam and Slides import plain vectors. Check the result with figma_capture_screenshot. Call this tool directly.",
].join("\n");

const SVG_INPUT = z.object({
	markup: z.string().min(1).max(5_242_880).describe("SVG markup, starting with <svg (an <?xml?> prolog is fine)."),
	name: z.string().max(200).optional().describe("Layer/component name. Default: the SVG's <title>, else 'SVG'."),
	description: z.string().max(2000).optional().describe("Component description (asComponent only)."),
});

export const IMPORT_SVG_SCHEMA = z.object({
	svgs: z.array(SVG_INPUT).max(200).optional().describe("SVGs given as markup (16 MB in total per call)."),
	paths: z.array(z.string().max(4096)).max(500).optional().describe("Local Mode only: absolute paths of .svg files."),
	directory: z.string().max(4096).optional().describe("Local Mode only: absolute path of a folder of .svg files."),
	recursive: z.boolean().optional().describe("Include subfolders of directory (up to 6 levels). Default false."),
	offset: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe("Paging through a big folder: start at this file index. Use remaining.nextOffset from the previous call. Default 0."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(500)
		.optional()
		.describe("Import about this many files of directory per call (variant sets are never split). Default 200."),

	name: z.string().max(200).optional().describe("Name for a single SVG (when exactly one is given)."),
	namePrefix: z.string().max(100).optional().describe("Prepended to every name, e.g. 'Icon/' to file components in a folder."),
	description: z.string().max(2000).optional().describe("Description for every component or component set created or updated."),

	parentId: z
		.string()
		.max(500)
		.optional()
		.describe("Frame, section, group, page or slide to put the result in. Default: current page (Slides: the focused slide)."),
	x: z
		.number()
		.min(-1e6)
		.max(1e6)
		.optional()
		.describe("X of the result (one SVG) or of the new container, relative to the parent. Default: clear space."),
	y: z.number().min(-1e6).max(1e6).optional(),

	size: z
		.number()
		.min(1)
		.max(4096)
		.optional()
		.describe("Fit inside a size×size box, keeping aspect ratio. With asComponent the component frame is exactly size×size, art centered."),
	width: z.number().min(1).max(8192).optional().describe("Fit within this width, keeping aspect ratio."),
	height: z.number().min(1).max(8192).optional().describe("Fit within this height, keeping aspect ratio."),
	scaleStrokes: z
		.boolean()
		.optional()
		.describe("Scale stroke widths with the artwork when fitting (default true). false keeps stroke widths."),

	asComponent: z.boolean().optional().describe("Make each SVG a component (Design files only). Default false; implied by variants."),
	flatten: z
		.boolean()
		.optional()
		.describe("Merge all layers into one vector named 'Vector' when they share the same paint and stroke. Default false."),
	variants: z
		.object({
			pattern: z
				.string()
				.min(1)
				.max(200)
				.describe(
					"Template over each name (or file path relative to directory, without .svg): {name} plus one {Axis} per variant property, e.g. '{name}-{Size}', '{name}_{Style}', '{Size}/{Style}/{name}'.",
				),
			axes: z
				.array(
					z.object({
						name: z.string().min(1).max(50),
						values: z
							.array(z.string().min(1).max(50))
							.min(1)
							.max(50)
							.describe("Allowed values in display order; the first value is the default variant."),
					}),
				)
				.max(6)
				.optional()
				.describe("Optional allowed values per axis, to disambiguate and order variants."),
		})
		.optional()
		.describe("Build component sets: SVGs whose names share {name} become variants of one set."),

	color: z
		.object({
			variable: z.string().max(300).optional().describe("Local COLOR variable by name ('icon/default' or 'Collection/icon/default') or id."),
			variableKey: z
				.string()
				.max(100)
				.optional()
				.describe("Key of a COLOR variable in a library this file uses (from figma_get_library_variables). Imported automatically."),
			value: z.string().max(100).optional().describe("Literal color instead of a variable (hex or CSS color)."),
			apply: z
				.enum(["auto", "currentColor", "all"])
				.optional()
				.describe("auto (default): currentColor paints, else every paint of a single-color SVG. currentColor: only currentColor paints. all: every solid paint."),
			targets: z.array(z.enum(["fills", "strokes"])).min(1).max(2).optional().describe("Which paints to recolor. Default both."),
		})
		.optional(),

	onExisting: z
		.enum(["update", "skip", "duplicate"])
		.optional()
		.describe("When a component or set with the same name exists: update its artwork in place (default; instances update), skip, or create a duplicate."),
	keepOverrides: z
		.boolean()
		.optional()
		.describe("Only update components whose layer structure is unchanged, so instance overrides survive; skip the rest. Default false."),
	force: z
		.boolean()
		.optional()
		.describe("Re-apply artwork even when it matches the last import (e.g. after manual edits in Figma). Default false."),
	matchScope: z.enum(["page", "file"]).optional().describe("Where to look for existing components with the same name. Default file."),

	layout: z
		.object({
			container: z
				.enum(["auto", "section", "frame", "none"])
				.optional()
				.describe("auto (default): a section for components, an auto-layout frame for vectors, none for a single SVG or an auto-layout parent."),
			containerName: z
				.string()
				.min(1)
				.max(200)
				.optional()
				.describe("Default 'Icons' for components, 'SVG import' for vectors. An existing section/frame with this name in the parent is reused."),
			columns: z.number().int().min(1).max(100).optional().describe("Default min(count, 12)."),
			gap: z.number().min(0).max(1000).optional().describe("Default 24."),
			padding: z.number().min(0).max(1000).optional().describe("Default 40."),
		})
		.optional(),

	focus: z.boolean().optional().describe("Select the result and scroll to it when it's on the current page. Default true."),
	dryRun: z.boolean().optional().describe("Report names, sets, updates and problems without changing Figma. Default false."),
	resumeRunId: z
		.string()
		.regex(/^[0-9a-f]{12}$/)
		.optional()
		.describe("After an interrupted import: the incomplete.runId it returned. SVGs that run already imported are reported, not imported twice."),
	verbose: z.boolean().optional().describe("Return full details for every item, not only problems and updates. Default false."),
	fileKey: z.string().max(100).optional().describe("Local Mode: run in this open file. Rejected in Cloud Mode."),
});

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function errorResult(error: string, hint?: string, extra?: Record<string, unknown>): ToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ error, ...(hint ? { hint } : {}), ...(extra ?? {}) }) }],
		isError: true,
	};
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
// Sources: inline svgs, paths, directory page (§2.5 step 2)
// ===========================================================================

interface Gathered {
	items: ImportItem[];
	raw: Map<string, string>;
	nameInputs: Map<string, NameInput>;
	remaining?: { count: number; nextOffset?: number; paths?: string[] };
	notes: string[];
	bytesRead: number;
}

async function gatherSources(n: NormalizedImportArgs, options: AssetToolsOptions, pattern: CompiledPattern | undefined): Promise<Gathered | { error: string; hint?: string }> {
	const items: ImportItem[] = [];
	const raw = new Map<string, string>();
	const nameInputs = new Map<string, NameInput>();
	const notes: string[] = [];
	let bytesRead = 0;
	let k = 0;
	const add = (it: Omit<ImportItem, "key" | "notes">, input: Omit<NameInput, "key" | "source" | "kind">, text?: string): ImportItem => {
		const key = `i${k++}`;
		const item: ImportItem = { ...it, key, notes: [] };
		items.push(item);
		nameInputs.set(key, { key, source: item.source, kind: item.kind, ...input });
		if (text !== undefined) raw.set(key, text);
		return item;
	};

	n.svgs.forEach((s, i) => {
		add({ source: `svgs[${i}]`, kind: "inline", description: s.description }, { itemName: s.name }, s.markup);
	});

	const fileBase = (p: string) => (p.split(/[\\/]/).pop() ?? p).replace(/\.svg$/i, "");
	let remainingPaths: string[] | undefined;
	const fs = options.fs;
	if (n.paths.length && fs) {
		for (let i = 0; i < n.paths.length; i++) {
			const p = n.paths[i];
			if (bytesRead >= MAX_READ_BYTES_PER_CALL) {
				remainingPaths = n.paths.slice(i);
				break;
			}
			try {
				const { text, size } = await fs.readSvgFile(p, MAX_SVG_BYTES);
				if (bytesRead > 0 && bytesRead + size > MAX_READ_BYTES_PER_CALL) {
					remainingPaths = n.paths.slice(i);
					break;
				}
				bytesRead += size;
				add({ source: p, kind: "path" }, { fileBase: fileBase(p) }, text);
			} catch (e) {
				const it = add({ source: p, kind: "path" }, { fileBase: fileBase(p) });
				Object.assign(it, { status: "failed", action: "fail", stage: "read", reason: errMessage(e) });
			}
		}
	}

	let remaining: Gathered["remaining"];
	if (n.directory && fs) {
		let listing;
		try {
			listing = await fs.listSvgFiles(n.directory, { recursive: n.recursive, maxDepth: MAX_DIR_DEPTH, maxScan: MAX_DIR_SCAN });
		} catch (e) {
			return { error: errMessage(e) };
		}
		if (!listing.files.length) {
			return { error: `No .svg files in ${n.directory}`, ...(listing.skippedSubfolders && !n.recursive ? { hint: "Pass recursive: true to include subfolders." } : {}) };
		}
		if (listing.truncated) notes.push(`Stopped listing after ${MAX_DIR_SCAN.toLocaleString("en-US")} entries (in the order the filesystem returns them); files beyond that weren't seen.`);
		const room = MAX_ITEMS_PER_CALL - n.svgs.length - n.paths.length;
		const limit = Math.min(n.limit, room);
		if (limit < n.limit) notes.push(`The directory page was limited to ${limit} files so the call stays within ${MAX_ITEMS_PER_CALL} SVGs.`);
		const page = pageDirectory(listing.files, { pattern, namePrefix: n.namePrefix, offset: n.offset, limit, components: n.asComponent, maxFiles: room });
		if (page.error) return { error: page.error };
		notes.push(...page.notes);
		const inputOf = (rel: string) => ({ fileBase: fileBase(rel), relNoExt: rel.replace(/\.svg$/i, "") });
		const failUnread = (rel: string, stage: "name" | "read", reason: string) => {
			const it = add({ source: rel, kind: "dir" }, inputOf(rel));
			Object.assign(it, { status: "failed", action: "fail", stage, reason });
		};
		const collided = new Map(page.collisions.map((c) => [c.index, c]));
		const sizeOf = (from: number, to: number) => page.files.slice(from, to).reduce((s, f, i) => s + (collided.has(from + i) ? 0 : f.size), 0);
		// end: files of this page that are read; consumed: where the next call starts.
		let end = page.files.length;
		let consumed = page.nextOffset ?? page.total;
		let tooBig: { from: number; to: number; size: number } | null = null;
		// Stop at the last whole group that fits in the read budget.
		for (let g = 0; g < page.groupStarts.length; g++) {
			const start = page.groupStarts[g];
			const stop = g + 1 < page.groupStarts.length ? page.groupStarts[g + 1] : page.files.length;
			const size = sizeOf(start, stop);
			if (bytesRead + size > MAX_READ_BYTES_PER_CALL) {
				// One file: readSvgFile refuses it by its size (5 MB cap) without reading it.
				if (bytesRead === 0 && stop - start === 1) continue;
				// Nothing read yet, so this set alone is more than a call reads: deferring it would stall
				// paging forever, so it fails as a whole, unread.
				if (bytesRead === 0) tooBig = { from: start, to: stop, size };
				end = start;
				const resumeAt = tooBig ? stop : start;
				consumed = resumeAt === page.files.length ? consumed : page.offset + resumeAt;
				break;
			}
			bytesRead += size;
		}
		for (const [i, f] of page.files.slice(0, end).entries()) {
			const rel = f.relPath;
			const clash = collided.get(i);
			if (clash) {
				failUnread(rel, "name", `Another SVG in this folder is also named "${clash.name}" (${clash.first}), on an earlier page of this import. Use variants.pattern (e.g. '{Size}/{name}') or namePrefix.`);
				continue;
			}
			try {
				const { text } = await fs.readSvgFile(f.path, MAX_SVG_BYTES);
				add({ source: rel, kind: "dir" }, inputOf(rel), text);
			} catch (e) {
				failUnread(rel, "read", errMessage(e));
			}
		}
		if (tooBig) {
			for (const f of page.files.slice(tooBig.from, tooBig.to)) {
				failUnread(f.relPath, "read", `This file's variant set is ${formatMB(tooBig.size)} of SVG files; one call reads at most ${formatMB(MAX_READ_BYTES_PER_CALL)}. Simplify the SVGs or split the set.`);
			}
		}
		// An oversized set's overflow is consumed only when the page ran to its end.
		if (consumed === (page.nextOffset ?? page.total)) {
			for (const o of page.overflow) {
				failUnread(o.file.relPath, "name", `The set "${o.setName}" has more than ${MAX_VARIANTS_PER_SET} variants; at most ${MAX_VARIANTS_PER_SET} go in one set.`);
			}
		}
		if (consumed < page.total) remaining = { count: page.total - consumed, nextOffset: consumed };
	}
	if (remainingPaths?.length) {
		remaining = {
			count: (remaining?.count ?? 0) + remainingPaths.length,
			...(remaining?.nextOffset !== undefined ? { nextOffset: remaining.nextOffset } : {}),
			paths: remainingPaths,
		};
	}
	return { items, raw, nameInputs, remaining, notes, bytesRead };
}

// ===========================================================================
// The handler
// ===========================================================================

interface HandlerDeps {
	server: McpServer;
	getDesktopConnector: () => Promise<unknown>;
	options: AssetToolsOptions;
}

export async function handleImportSvg(deps: HandlerDeps, rawArgs: ImportSvgArgs, ctx: unknown): Promise<unknown> {
	const { options } = deps;
	const n = normalizeImportArgs(rawArgs ?? {});
	const remote = options.isRemoteMode ?? !options.fs;
	const v = validateImportArgs(n, { hasFs: !!options.fs, remote });
	if (v.error) return errorResult(v.error, v.hint);
	const notes = [...v.notes];

	let pattern: CompiledPattern | undefined;
	if (n.variants) {
		const c = compileVariantPattern(n.variants.pattern, n.variants.axes);
		if (!c.ok) return errorResult(c.error);
		pattern = c.pattern;
	}

	const gathered = await gatherSources(n, options, pattern);
	if ("error" in gathered) return errorResult(gathered.error, gathered.hint);
	const { items, raw, nameInputs, remaining } = gathered;
	notes.push(...gathered.notes);

	// Sanitize every source; failures don't stop the batch.
	for (const it of items) {
		if (it.status) continue;
		const res = sanitizeSvg(raw.get(it.key) ?? "");
		raw.delete(it.key);
		if (!res.ok) {
			Object.assign(it, { status: "failed", action: "fail", stage: "sanitize", reason: res.error });
			continue;
		}
		it.markup = res.markup;
		it.sentinel = res.sentinel;
		it.meta = res.meta;
		it.notes.push(...res.notes);
		it.sanitized = { removedElements: res.removed.elements, removedAttributes: res.removed.attributes, externalRefs: res.removed.externalRefs };
		const ni = nameInputs.get(it.key);
		if (ni && res.meta.title) ni.title = res.meta.title;
	}

	// Names and groups.
	const live = items.filter((it) => !it.status);
	const naming = nameAndGroup(
		live.map((it) => nameInputs.get(it.key) as NameInput),
		{ topName: n.svgs.length + n.paths.length + (n.directory ? 2 : 0) === 1 ? n.name : undefined, namePrefix: n.namePrefix, pattern, components: n.asComponent },
	);
	const byKey = new Map(items.map((it) => [it.key, it]));
	for (const [key, reason] of naming.failures) Object.assign(byKey.get(key) as ImportItem, { status: "failed", action: "fail", stage: "name", reason });
	for (const [key, list] of naming.notes) (byKey.get(key) as ImportItem).notes.push(...list);
	for (const [key, named] of naming.items) {
		const it = byKey.get(key) as ImportItem;
		it.name = named.name;
		if (named.set) {
			it.setName = named.set.name;
			it.props = named.set.props;
		}
	}
	const box = n.size !== undefined ? { w: n.size, h: n.size } : n.width !== undefined || n.height !== undefined ? { ...(n.width !== undefined ? { w: n.width } : {}), ...(n.height !== undefined ? { h: n.height } : {}) } : null;
	const square = n.size !== undefined && n.asComponent;
	for (const it of items) {
		if (it.status || !it.markup) continue;
		it.artHash = artHashFor(it.markup, {
			box,
			square,
			scaleStrokes: n.scaleStrokes,
			flatten: n.flatten,
			asComponent: n.asComponent,
			color: n.color ? { apply: n.color.apply, targets: n.color.targets } : null,
		});
	}
	const groups: PlanGroup[] = naming.groups.map((g) =>
		g.kind === "single"
			? { kind: "single", item: byKey.get(g.key) as ImportItem }
			: { kind: "set", name: g.name, axes: g.axes, items: g.keys.map((key) => byKey.get(key) as ImportItem), action: "create" },
	);

	if (!groups.length) {
		const { body, isError } = assembleResponse({ n, items, sets: [], remaining, notes });
		return textResult(body, isError);
	}

	// A resumed run keeps its runId, so every node of the chain carries one id and a second resume
	// still recognizes what the first run placed.
	const runId = n.resumeRunId ?? newRunId();
	let connector: ExecConnector;
	try {
		connector = (await deps.getDesktopConnector()) as ExecConnector;
	} catch (e) {
		return errorResult(errMessage(e), "Make sure the Desktop Bridge plugin is running in Figma.");
	}
	// Routing: the preflight goes to fileKey (or the active file); every later step is pinned to the
	// file the preflight saw (Local Mode), so clicking into another open file mid-run can't move the
	// writes there. Cloud pairs with one plugin and rejects fileKey, so it is never passed there.
	let route: string | undefined = n.fileKey;
	const exec = (label: string, payload: unknown, body: string, timeoutMs: number) =>
		classifyBridgeOutcome(() => connector.executeCodeViaUI(assetScript(label, payload, body), timeoutMs, route));

	// Preflight (read-only).
	const wantsLibrary = !!(n.color?.variable || n.color?.variableKey);
	const preTimeout = scaledTimeout((n.matchScope === "file" ? PREFLIGHT_TIMEOUT_FILE_MS : PREFLIGHT_TIMEOUT_PAGE_MS) + (wantsLibrary ? PREFLIGHT_LIBRARY_EXTRA_MS : 0));
	const containerName = n.layout.containerName ?? (n.asComponent ? "Icons" : "SVG import");
	const preOutcome = await exec(
		"Import SVG: check target",
		{
			runId,
			parentId: n.parentId ?? null,
			wantsComponents: n.asComponent,
			color: n.color ? { variable: n.color.variable, variableKey: n.color.variableKey, value: n.color.value } : null,
			containerName: n.layout.container === "none" ? null : containerName,
			matchScope: n.matchScope,
			resumeRunId: n.resumeRunId ?? null,
			editorSupport: EDITOR_SUPPORT,
			busyStaleMs: BUSY_MARKER_STALE_MS,
			maxCounted: MAX_COUNTED_TARGETS,
			matches: buildMatchQueries(groups, n),
		},
		SVG_PREFLIGHT_BODY,
		preTimeout,
	);
	if (preOutcome.kind === "maybeRunning") {
		return errorResult(
			`Figma didn't answer the pre-import check in time (${preOutcome.error}). Nothing was changed.`,
			"Wait until Figma is idle (check with figma_capture_screenshot), then run the same call again. With matchScope \"file\" a large file takes longer; matchScope \"page\" is faster.",
		);
	}
	if (preOutcome.kind === "scriptError") return errorResult(`The pre-import check failed in Figma: ${preOutcome.error}. Nothing was changed.`);
	if (preOutcome.kind === "refused") return errorResult(`${preOutcome.error} Nothing was changed.`);
	const pre = preOutcome.result as PreflightResult;
	if (!pre || typeof pre !== "object") return errorResult("The pre-import check returned nothing. Nothing was changed.");
	if (pre.fatal) return errorResult(pre.fatal, undefined, pre.options?.length ? { options: pre.options } : undefined);
	if (!remote) route = n.fileKey ?? pre.fileKey ?? undefined;

	// Plan.
	notes.push(...planFromPreflight(groups, pre, n));
	const layout = planLayout(groups, pre, n);
	if (layout.error) return errorResult(layout.error);
	notes.push(...layout.notes);
	const finalizePlanned = () => {
		for (const it of allItems(groups)) {
			if (it.status) continue;
			if (it.action === "conflict") it.status = "conflict";
			else if (it.action === "skip") it.status = "skipped";
			else if (it.action === "fail") it.status = "failed";
			else if (it.action === "unchanged") it.status = "unchanged";
		}
	};
	let risky = allItems(groups).filter(isRisky);
	// The same decision confirmStep makes (confirm.ts): can this client be asked at all?
	const canAsk = !!(ctx as { mcpReq?: unknown } | undefined)?.mcpReq && !confirmationsDisabled() && supportsForm(requestClientCapabilities(deps.server, ctx as Parameters<typeof requestClientCapabilities>[1]));

	if (n.dryRun) {
		// Predict what the real run does with risky updates on this client: ask, proceed, or skip them.
		let wouldAsk = false;
		if (risky.length && canAsk) wouldAsk = true;
		else if (risky.length && !confirmationsDisabled() && !n.explicitOnExisting) {
			for (const it of risky) {
				it.action = "skip";
				it.reason = unsupportedSkipReason(it, true);
			}
		}
		// Surfaces set groups too large for one step, as the real run would.
		buildChunks(groups, n);
		// Statuses from the planned actions, so success reflects planned conflicts and failures.
		finalizePlanned();
		const { body, isError } = assembleResponse({
			n,
			items,
			pre,
			sets: groups
				.filter((g): g is Extract<PlanGroup, { kind: "set" }> => g.kind === "set")
				.map((g) => ({ name: g.name, action: g.action, ...(g.setId ? { existingId: g.setId } : {}), variants: g.items.length, untouched: g.untouched ?? 0 })),
			remaining,
			notes,
			confirmation: wouldAsk ? { wouldAsk: true, reason: confirmMessage(pre.fileName, risky) } : { wouldAsk: false },
		});
		return textResult(body, isError);
	}

	// Confirmation, before any write and before a task starts.
	let keepOverrides = n.keepOverrides;
	if (risky.length) {
		const step = confirmStep(
			deps.server,
			ctx as Parameters<typeof confirmStep>[1],
			`confirm_svg_update_${fingerprint(pre.fileKey, pre.fileName, risky.map((u) => `${u.targetId}:${u.artHash}:${u.published}`).sort().join(","))}`,
			{
				message: confirmMessage(pre.fileName, risky),
				fields: {
					choice: {
						type: "string",
						title: "Existing components",
						enum: ["update", "keep-overrides", "skip"],
						enumNames: ["Replace their artwork", "Only where instance overrides are kept", "Leave them; import only new SVGs"],
						default: n.keepOverrides ? "keep-overrides" : "update",
					},
				},
				required: ["choice"],
			},
		);
		if (step.status === "ask") return step.result;
		if (step.status === "declined" || step.status === "cancelled") return notConfirmedResult("the SVG import", step);
		if (step.status === "accepted") {
			const choice = step.content.choice;
			if (choice === "keep-overrides") keepOverrides = true;
			else if (choice === "skip") {
				for (const it of allItems(groups)) {
					if (it.action === "update") {
						it.action = "skip";
						it.reason = `"${it.name}" exists; left as is (you chose to import only new SVGs).`;
					}
				}
			}
		} else if (!confirmationsDisabled() && !n.explicitOnExisting) {
			for (const it of risky) {
				it.action = "skip";
				it.reason = unsupportedSkipReason(it);
			}
		}
		risky = allItems(groups).filter(isRisky);
	}
	finalizePlanned();

	// One write phase per file in this server: a parallel call that also passed its preflight would
	// otherwise interleave with this one (duplicate containers, overlapping cursors).
	const release = acquireWriteLock(pre.fileKey ?? n.fileKey ?? "active-file");
	if (!release) return errorResult(WRITE_LOCK_MESSAGE);
	const ctxDeps: WriteContext = { n, pre, groups, items, layout, runId, exec, risky, keepOverrides, remaining, notes, containerName, remote };
	try {
		if (remote) return await writePhase(ctxDeps, new AbortController().signal, BUDGET_CLOUD_MS).finally(release);
		const count = allItems(groups).filter((it) => it.action === "create" || it.action === "update" || it.action === "metadata").length;
		// runAsTaskIfSupported calls the work synchronously when it won't make a task,
		// and from a later microtask when it does: that tells the budget apart.
		let synchronous = true;
		const result = runAsTaskIfSupported(ctx, (signal) => writePhase(ctxDeps, signal, synchronous ? BUDGET_SYNC_MS : BUDGET_TASK_MS).finally(release), {
			statusMessage: `Importing ${count} SVG${count === 1 ? "" : "s"}…`,
		});
		synchronous = false;
		return await result;
	} catch (e) {
		release();
		throw e;
	}
}

interface WriteContext {
	n: NormalizedImportArgs;
	pre: PreflightResult;
	groups: PlanGroup[];
	items: ImportItem[];
	layout: ReturnType<typeof planLayout>;
	runId: string;
	exec: (label: string, payload: unknown, body: string, timeoutMs: number) => Promise<BridgeOutcome>;
	risky: ImportItem[];
	keepOverrides: boolean;
	remaining: Gathered["remaining"];
	notes: string[];
	containerName: string;
	remote: boolean;
}

interface ChunkResult {
	results?: Array<Record<string, unknown> & { key: string; status: ImportItem["status"]; notes?: string[] }>;
	sets?: Array<Record<string, unknown>>;
	cursor?: unknown;
	newTopLevelIds?: string[];
	notes?: string[];
}

async function writePhase(c: WriteContext, signal: AbortSignal, budgetMs: number): Promise<ToolResult> {
	const { n, pre, groups, items, layout, runId } = c;
	const budget = new Budget(budgetMs);
	const byKey = new Map(items.map((it) => [it.key, it]));
	const sets: Array<Record<string, unknown>> = [];
	// A resumed run whose first call already saved a restore version reuses it (no second version,
	// and not one that already contains the first call's updates).
	let restorePoint: { versionId: string; title: string } | undefined = pre.checkpoint?.versionId ? { versionId: pre.checkpoint.versionId, title: RESTORE_TITLE } : undefined;
	let container: { id: string; name: string; type: string; created: boolean } | undefined = layout.reuse
		? { id: layout.reuse.id, name: c.containerName, type: layout.reuse.type, created: false }
		: undefined;
	let mode = layout.mode;
	let cursor: unknown = null;
	const focusIds: string[] = [];

	// Variants appended to an existing set don't need a container; new top-level nodes do.
	const hasNewTopLevel = groups.some((g) => (g.kind === "single" ? g.item.action === "create" : g.action === "create" && g.items.some((it) => it.action === "create")));
	let checkpointDone = !c.risky.some((it) => it.action === "update") || !!restorePoint;
	let containerDone = !(layout.container !== "none" && !layout.reuse && hasNewTopLevel);
	let chunks: Chunk[] | null = null;
	let chunkIndex = 0;
	const sentKeys = new Set<string>();
	let inFlight: string[] = [];

	const editorMode = (EDITOR_SUPPORT as Record<string, { importMode: "frame" | "group" }>)[pre.editorType]?.importMode ?? "frame";
	const colorOpts = n.color
		? {
				...(pre.variable && !pre.variable.remote && pre.variable.id ? { variableId: pre.variable.id } : {}),
				...(pre.variable?.remote ? { variableKey: pre.variable.key } : {}),
				...(n.color.value ? { value: n.color.value } : {}),
				apply: n.color.apply,
				targets: n.color.targets,
				...(pre.variable ? { label: pre.variable.label ?? pre.variable.name } : {}),
			}
		: null;
	const box = n.size !== undefined ? { w: n.size, h: n.size } : n.width !== undefined || n.height !== undefined ? { ...(n.width !== undefined ? { w: n.width } : {}), ...(n.height !== undefined ? { h: n.height } : {}) } : null;

	const next = (): WriteStep | null => {
		if (!checkpointDone) {
			checkpointDone = true;
			const names = c.risky.filter((it) => it.action === "update").map((it) => it.setName ?? it.name ?? it.source);
			const unique = [...new Set(names)];
			const description = `Saved by Figma Console MCP before figma_import_svg updated: ${unique.slice(0, 10).join(", ")}${unique.length > 10 ? `, and ${unique.length - 10} more` : ""}.`;
			return {
				label: "checkpoint",
				setup: true,
				timeoutMs: scaledTimeout(CHECKPOINT_TIMEOUT_MS),
				run: () => c.exec("Import SVG: save a restore version", { title: RESTORE_TITLE, description, runId, fileKey: pre.fileKey }, SVG_CHECKPOINT_BODY, scaledTimeout(CHECKPOINT_TIMEOUT_MS)),
			};
		}
		if (!containerDone) {
			containerDone = true;
			return {
				label: "container",
				setup: true,
				timeoutMs: scaledTimeout(CONTAINER_TIMEOUT_MS),
				run: () =>
					c.exec(
						"Import SVG: container",
						{
							runId,
							fileKey: pre.fileKey,
							busyStaleMs: BUSY_MARKER_STALE_MS,
							parentId: pre.parent.id,
							type: layout.container,
							name: c.containerName,
							gap: layout.gap,
							padding: layout.padding,
							...(layout.frameWidth ? { width: layout.frameWidth } : {}),
							...(n.x !== undefined && n.y !== undefined ? { x: n.x, y: n.y } : {}),
						},
						SVG_CONTAINER_BODY,
						scaledTimeout(CONTAINER_TIMEOUT_MS),
					),
			};
		}
		if (!chunks) chunks = buildChunks(groups, n);
		if (chunkIndex >= chunks.length) return null;
		const chunk = chunks[chunkIndex];
		const final = chunkIndex === chunks.length - 1;
		chunkIndex++;
		const timeoutMs = chunkTimeoutMs(chunk.items, chunk.jsonBytes, chunk.expanded);
		return {
			label: "chunk",
			timeoutMs,
			run: () => {
				for (const k of chunk.keys) sentKeys.add(k);
				inFlight = chunk.keys;
				return c.exec(
					`Import SVG (${chunk.items} items)`,
					{
						runId,
						fileKey: pre.fileKey,
						busyStaleMs: BUSY_MARKER_STALE_MS,
						targetId: container?.id ?? pre.parent.id,
						final,
						focus: n.focus,
						focusIds: final ? focusIds : [],
						editorImportMode: editorMode,
						opts: {
							box,
							square: n.size !== undefined && n.asComponent,
							scaleStrokes: n.scaleStrokes,
							asComponent: n.asComponent,
							flatten: n.flatten,
							keepOverrides: c.keepOverrides,
							color: colorOpts,
							colorRef: pre.colorRef,
						},
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
						groups: chunk.groups,
					},
					SVG_IMPORT_BODY,
					timeoutMs,
				);
			},
		};
	};

	const onOutcome = (step: WriteStep, outcome: BridgeOutcome) => {
		if (step.label === "checkpoint") {
			const versionId = outcome.kind === "ok" ? (outcome.result as { versionId?: string | null } | null)?.versionId : null;
			if (versionId) {
				restorePoint = { versionId, title: RESTORE_TITLE };
				return;
			}
			// Both stop the run before any update is sent.
			if (outcome.kind === "maybeRunning" || outcome.kind === "refused") return;
			const why = outcome.kind === "scriptError" ? outcome.error : "Figma returned no version id";
			for (const it of c.risky) {
				if (it.action !== "update") continue;
				it.action = "skip";
				it.status = "skipped";
				it.reason = `Couldn't save a restore version first (${why}), so existing components weren't changed.`;
			}
			return;
		}
		if (step.label === "container") {
			if (outcome.kind === "ok") {
				const r = outcome.result as { id: string; type: string; name: string; created: boolean; autoLayout?: boolean; notes?: unknown };
				container = { id: r.id, name: r.name, type: r.type, created: r.created };
				mode = r.autoLayout ? "auto-layout" : mode;
				if (Array.isArray(r.notes)) c.notes.push(...r.notes.map(String));
				return;
			}
			if (outcome.kind === "scriptError") {
				c.notes.push(`Couldn't create the container (${outcome.error}); imported into the parent instead.`);
				if (mode === "auto-layout" && !pre.parent.autoLayout) mode = "shelf";
			}
			return;
		}
		// chunk
		const keys = inFlight;
		inFlight = [];
		if (outcome.kind === "refused") {
			// The chunk didn't start: its items were never attempted.
			for (const k of keys) sentKeys.delete(k);
			return;
		}
		if (outcome.kind === "ok") {
			const r = (outcome.result ?? {}) as ChunkResult;
			for (const res of r.results ?? []) {
				const it = byKey.get(res.key);
				if (!it) continue;
				const { key: _k, notes: resNotes, ...fields } = res;
				Object.assign(it, fields);
				if (resNotes?.length) it.notes.push(...resNotes);
			}
			for (const k of keys) {
				const it = byKey.get(k);
				if (it && (it.status === undefined || it.status === "unknown")) Object.assign(it, { status: "failed", stage: "process", reason: "Figma returned no result for this SVG." });
			}
			if (r.sets) sets.push(...r.sets);
			if (r.cursor !== undefined) cursor = r.cursor;
			if (r.newTopLevelIds) focusIds.push(...r.newTopLevelIds);
			if (r.notes) c.notes.push(...r.notes);
			return;
		}
		for (const k of keys) {
			const it = byKey.get(k);
			if (!it) continue;
			if (outcome.kind === "scriptError") Object.assign(it, { status: "failed", stage: "import", reason: `Figma reported an error for this batch: ${outcome.error}` });
			else Object.assign(it, { status: "unknown", stage: "import", reason: "Figma didn't answer in time; this SVG may still be importing." });
		}
	};

	const phase = await runWritePhase({ budget, signal, next, onOutcome });

	let incomplete: { reason: string; runId: string; notAttempted: string[]; inProgress?: string[] } | undefined;
	if (phase.stop) {
		const notAttempted = allItems(groups)
			.filter((it) => (it.action === "create" || it.action === "update" || it.action === "metadata") && !sentKeys.has(it.key) && !it.status)
			.map((it) => (it.setName ? `${it.setName} (${it.name})` : (it.name ?? it.source)));
		const inProgress = items.filter((it) => it.status === "unknown").map((it) => (it.setName ? `${it.setName} (${it.name})` : (it.name ?? it.source)));
		incomplete = {
			reason: stopMessage(phase.stop.reason, runId, phase.stop.elapsedMs, phase.stop.error),
			runId,
			notAttempted,
			...(inProgress.length ? { inProgress } : {}),
		};
	}

	logger.info(
		{ items: items.length, bytes: items.reduce((s, it) => s + (it.meta?.bytesOut ?? 0), 0), chunks: chunkIndex, mode: c.remote ? "cloud" : "local", runId },
		"figma_import_svg",
	);

	const { body, isError } = assembleResponse({
		n,
		items,
		runId,
		pre,
		...(container ? { container } : {}),
		...(restorePoint ? { restorePoint } : {}),
		sets,
		remaining: c.remaining,
		...(incomplete ? { incomplete } : {}),
		notes: c.notes,
	});
	return textResult(body, isError);
}

// ===========================================================================
// Registration
// ===========================================================================

/** Registers figma_import_svg, figma_export_assets (./asset-export-tools.ts) and figma_import_image (./image-import-tools.ts). */
export function registerAssetTools(server: McpServer, getDesktopConnector: () => Promise<any>, options: AssetToolsOptions = {}): void {
	registerExportAssetsTool(server, getDesktopConnector, options);
	registerImportImageTool(server, getDesktopConnector, options);
	server.registerTool(
		"figma_import_svg",
		{ description: IMPORT_SVG_DESCRIPTION, inputSchema: IMPORT_SVG_SCHEMA },
		async (args: z.infer<typeof IMPORT_SVG_SCHEMA>, ctx: unknown) => {
			try {
				return (await handleImportSvg({ server, getDesktopConnector, options }, args as ImportSvgArgs, ctx)) as any;
			} catch (error) {
				logger.error({ error: errMessage(error) }, "figma_import_svg failed");
				return errorResult(errMessage(error), "Make sure the Desktop Bridge plugin is running in Figma.") as any;
			}
		},
	);
}
