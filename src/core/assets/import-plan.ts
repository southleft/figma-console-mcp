/**
 * Pure planning for figma_import_svg (spec §2.2, §2.3, §2.6): argument
 * normalization and cross-field validation, per-item actions from the
 * preflight, the risk/confirmation decision, chunking, the layout plan and
 * the response envelope. No I/O, so every rule is unit-testable.
 */

import {
	CHUNK_HARD_MAX_BYTES,
	CHUNK_MAX_BYTES,
	CHUNK_MAX_EXPANDED,
	CHUNK_MAX_ITEMS,
	CLOUD_MAX_ITEMS_PER_CALL,
	DEFAULT_DIRECTORY_LIMIT,
	MAX_FULL_ITEMS,
	MAX_INLINE_TOTAL_BYTES,
	MAX_ITEMS_PER_CALL,
	MAX_NOTES_PER_ITEM,
	formatMB,
} from "./limits.js";
import { normalizeNodeId } from "../figma-api.js";
import type { SvgMeta } from "./svg-sanitize.js";
import { utf8Length } from "./svg-sanitize.js";

// ===========================================================================
// Arguments
// ===========================================================================

export type ColorApply = "auto" | "currentColor" | "all";
export type PaintTarget = "fills" | "strokes";

/** Raw arguments as the schema accepts them (every field optional). */
export interface ImportSvgArgs {
	svgs?: Array<{ markup: string; name?: string; description?: string }>;
	paths?: string[];
	directory?: string;
	recursive?: boolean;
	offset?: number;
	limit?: number;
	name?: string;
	namePrefix?: string;
	description?: string;
	parentId?: string;
	x?: number;
	y?: number;
	size?: number;
	width?: number;
	height?: number;
	scaleStrokes?: boolean;
	asComponent?: boolean;
	flatten?: boolean;
	variants?: { pattern: string; axes?: Array<{ name: string; values: string[] }> };
	color?: { variable?: string; variableKey?: string; value?: string; apply?: ColorApply; targets?: PaintTarget[] };
	onExisting?: "update" | "skip" | "duplicate";
	keepOverrides?: boolean;
	force?: boolean;
	matchScope?: "page" | "file";
	layout?: { container?: "auto" | "section" | "frame" | "none"; containerName?: string; columns?: number; gap?: number; padding?: number };
	focus?: boolean;
	dryRun?: boolean;
	resumeRunId?: string;
	verbose?: boolean;
	fileKey?: string;
}

export interface NormalizedImportArgs {
	svgs: Array<{ markup: string; name?: string; description?: string }>;
	paths: string[];
	directory?: string;
	recursive: boolean;
	offset: number;
	limit: number;
	/** recursive/offset/limit were passed (Cloud rejects them). */
	pagingGiven: boolean;
	name?: string;
	namePrefix: string;
	description?: string;
	parentId?: string;
	x?: number;
	y?: number;
	size?: number;
	width?: number;
	height?: number;
	scaleStrokes: boolean;
	asComponent: boolean;
	/** asComponent was passed explicitly (variants + asComponent:false is an error). */
	asComponentGiven?: boolean;
	flatten: boolean;
	variants?: { pattern: string; axes?: Array<{ name: string; values: string[] }> };
	color?: { variable?: string; variableKey?: string; value?: string; apply: ColorApply; targets: PaintTarget[] };
	onExisting: "update" | "skip" | "duplicate";
	explicitOnExisting: boolean;
	keepOverrides: boolean;
	force: boolean;
	matchScope: "page" | "file";
	layout: { container: "auto" | "section" | "frame" | "none"; containerName?: string; columns?: number; gap: number; padding: number };
	focus: boolean;
	dryRun: boolean;
	resumeRunId?: string;
	verbose: boolean;
	fileKey?: string;
}

/** Apply every default in code: tests call handlers with raw arguments, so zod defaults can't be relied on. */
export function normalizeImportArgs(a: ImportSvgArgs): NormalizedImportArgs {
	const asComponentGiven = a.asComponent !== undefined;
	return {
		svgs: a.svgs ?? [],
		paths: a.paths ?? [],
		directory: a.directory,
		recursive: a.recursive ?? false,
		offset: a.offset ?? 0,
		limit: a.limit ?? DEFAULT_DIRECTORY_LIMIT,
		pagingGiven: a.recursive !== undefined || a.offset !== undefined || a.limit !== undefined,
		name: a.name,
		namePrefix: a.namePrefix ?? "",
		description: a.description,
		parentId: a.parentId ? normalizeNodeId(a.parentId) : undefined,
		x: a.x,
		y: a.y,
		size: a.size,
		width: a.width,
		height: a.height,
		scaleStrokes: a.scaleStrokes ?? true,
		asComponent: a.asComponent ?? a.variants !== undefined,
		asComponentGiven,
		flatten: a.flatten ?? false,
		variants: a.variants,
		color: a.color
			? {
					variable: a.color.variable,
					variableKey: a.color.variableKey,
					value: a.color.value,
					apply: a.color.apply ?? "auto",
					targets: a.color.targets && a.color.targets.length ? [...new Set(a.color.targets)] : ["fills", "strokes"],
				}
			: undefined,
		onExisting: a.onExisting ?? "update",
		explicitOnExisting: a.onExisting !== undefined,
		keepOverrides: a.keepOverrides ?? false,
		force: a.force ?? false,
		matchScope: a.matchScope ?? "file",
		layout: {
			container: a.layout?.container ?? "auto",
			containerName: a.layout?.containerName,
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

export const CLOUD_FILES_MESSAGE =
	"paths and directory read files from disk, which only Local Mode can do. Cloud Mode has no filesystem: pass the SVG markup in svgs instead.";

/** The connectors' existing wording (cloud-websocket-connector.ts). */
export const CLOUD_FILEKEY_MESSAGE =
	"Per-file targeting (fileKey) is Local Mode only. Cloud Mode pairs with a single plugin instance, so there is no second file to route to. Omit fileKey to run against the paired file, or use Local Mode (NPX/Git) for multi-file work.";

const isAbsolutePath = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");

export interface ValidationContext {
	/** A filesystem was injected (Local Mode). */
	hasFs: boolean;
	remote: boolean;
}

export interface ValidationResult {
	error?: string;
	hint?: string;
	notes: string[];
}

/** Cross-field rules (§2.6.1). Fatal before contacting Figma. */
export function validateImportArgs(n: NormalizedImportArgs, ctx: ValidationContext): ValidationResult {
	const notes: string[] = [];
	const fail = (error: string, hint?: string): ValidationResult => ({ error, ...(hint ? { hint } : {}), notes });
	if (!n.svgs.length && !n.paths.length && !n.directory) return fail("Nothing to import: pass svgs (SVG markup), or in Local Mode paths or a directory.");
	if (!ctx.hasFs && (n.paths.length || n.directory || n.pagingGiven)) return fail(CLOUD_FILES_MESSAGE);
	if (ctx.remote && n.fileKey) return fail(CLOUD_FILEKEY_MESSAGE);
	if (ctx.remote && n.svgs.length > CLOUD_MAX_ITEMS_PER_CALL) {
		return fail(`Cloud Mode imports up to ${CLOUD_MAX_ITEMS_PER_CALL} SVGs per call. Split the batch into several calls.`);
	}
	let total = 0;
	for (const s of n.svgs) total += utf8Length(s.markup);
	if (total > MAX_INLINE_TOTAL_BYTES) {
		return fail(`The svgs total ${formatMB(total)}; the limit per call is ${formatMB(MAX_INLINE_TOTAL_BYTES)}. Split them into several calls.`);
	}
	if (n.svgs.length + n.paths.length > MAX_ITEMS_PER_CALL) {
		return fail(
			`Too many SVGs in one call: ${n.svgs.length} inline + ${n.paths.length} paths = ${n.svgs.length + n.paths.length}; the limit is ${MAX_ITEMS_PER_CALL}. Split the call.`,
		);
	}
	if (n.directory && n.svgs.length + n.paths.length >= MAX_ITEMS_PER_CALL) {
		return fail(
			`Too many SVGs in one call: ${n.svgs.length} inline + ${n.paths.length} paths leave no room for the directory; the limit is ${MAX_ITEMS_PER_CALL}. Split the call.`,
		);
	}
	if (n.size !== undefined && (n.width !== undefined || n.height !== undefined)) return fail("Use size, or width/height, not both.");
	if (n.variants && n.asComponentGiven && !n.asComponent) {
		return fail("variants builds component sets, so it needs components. Leave asComponent out or set it to true.");
	}
	if (n.color) {
		const given = [n.color.variable, n.color.variableKey, n.color.value].filter((v) => v !== undefined && v !== "").length;
		if (given > 1) return fail("Use one of color.variable, color.variableKey or color.value.");
		if (given === 0) return fail("color needs a variable, a variableKey or a value.");
	}
	if (n.keepOverrides && n.onExisting !== "update") return fail('keepOverrides only applies when updating existing components (onExisting "update").');
	for (const p of [...n.paths, ...(n.directory ? [n.directory] : [])]) {
		if (!isAbsolutePath(p)) return fail(`"${p.slice(0, 300)}" is a relative path. Pass an absolute path.`);
	}
	const inputs = n.svgs.length + n.paths.length + (n.directory ? 2 : 0);
	if (n.name !== undefined && inputs > 1) notes.push("name applies to a single SVG. For batches, names come from each SVG (use namePrefix).");
	return { notes };
}

// ===========================================================================
// Items and preflight shapes
// ===========================================================================

export type ItemStatus = "failed" | "conflict" | "skipped" | "updated" | "created" | "unchanged" | "unknown";
export type ItemAction = "create" | "update" | "unchanged" | "metadata" | "skip" | "conflict" | "fail";

export interface ImportItem {
	key: string;
	source: string;
	kind: "inline" | "path" | "dir";
	description?: string;
	markup?: string;
	sentinel?: string | null;
	meta?: SvgMeta;
	notes: string[];
	sanitized?: { removedElements: Record<string, number>; removedAttributes: number; externalRefs: number };
	name?: string;
	setName?: string;
	props?: Record<string, string>;
	artHash?: string;
	action?: ItemAction;
	status?: ItemStatus;
	stage?: "read" | "sanitize" | "name" | "plan" | "import" | "process";
	reason?: string;
	targetId?: string;
	instanceCount?: number | null;
	published?: string;
	firstInstance?: string | null;
	nodeId?: string;
	type?: string;
	width?: number;
	height?: number;
	componentSetId?: string;
	color?: Record<string, unknown>;
	update?: Record<string, unknown>;
	metadataUpdated?: boolean;
	matchedBy?: string;
}

export interface PreflightVariantMatch {
	key: string;
	matchedBy?: "exact" | "case-insensitive";
	matchedName?: string;
	existingId: string | null;
	eligible?: boolean;
	why?: string;
	unchanged?: boolean;
	descriptionDiffers?: boolean;
	instanceCount?: number | null;
	publish?: string;
	firstInstance?: string | null;
	width?: number;
	height?: number;
}

export interface PreflightMatch {
	key: string;
	status: "none" | "one" | "many" | "kind-mismatch";
	count?: number;
	ids?: string[];
	existingId?: string;
	existingKind?: "component" | "set";
	variantErrors?: boolean;
	eligible?: boolean;
	why?: string;
	unchanged?: boolean;
	descriptionDiffers?: boolean;
	width?: number;
	height?: number;
	instanceCount?: number | null;
	publish?: string;
	firstInstance?: string | null;
	axes?: string[];
	variants?: PreflightVariantMatch[];
	untouched?: number;
}

export interface PreflightResult {
	fatal?: string;
	options?: string[];
	editorType: string;
	fileKey: string | null;
	fileName: string;
	parent: { id: string; type: string; name: string; autoLayout: boolean; pageId: string | null; pageName?: string | null; onCurrentPage: boolean };
	variable?: { id?: string; key: string; name: string; collection: string; label?: string; remote: boolean };
	colorRef: string;
	container?: { id: string; type: string; name: string; autoLayout: boolean };
	resumed?: Array<{ source: string; artHash: string; nodeId: string; type?: string; width?: number; height?: number }>;
	/** The restore version an earlier call of the resumed run saved (resumeRunId only). */
	checkpoint?: { versionId: string };
	matches: PreflightMatch[];
}

export type PlanGroup =
	| { kind: "single"; item: ImportItem }
	| {
			kind: "set";
			name: string;
			axes: string[];
			items: ImportItem[];
			action: "create" | "update";
			setId?: string;
			untouched?: number;
			/** Set when the set's own description changes. */
			setDescription?: string;
			created?: boolean;
	  };

/** The `matches` payload for the preflight. */
export function buildMatchQueries(groups: PlanGroup[], n: NormalizedImportArgs): Array<Record<string, unknown>> {
	if (!n.asComponent) return [];
	return groups.map((g) =>
		g.kind === "single"
			? { key: g.item.key, kind: "component", name: g.item.name, artHash: g.item.artHash, description: g.item.description ?? n.description, force: n.force }
			: {
					key: `set:${g.name}`,
					kind: "set",
					name: g.name,
					artHash: "",
					description: n.description,
					force: n.force,
					// force rides on each variant too (the plugin also honors the set's flag).
					variants: g.items.map((i) => ({ key: i.key, props: i.props, artHash: i.artHash, description: i.description, force: n.force })),
				},
	);
}

const PUBLISH_RISK = new Set(["CURRENT", "CHANGED", "UNKNOWN"]);

/** An update that needs the person's go-ahead: instances in this file, or a (possibly) published library component. */
export function isRisky(it: ImportItem): boolean {
	if (it.action !== "update") return false;
	return it.instanceCount === null || it.instanceCount === undefined || it.instanceCount > 0 || PUBLISH_RISK.has(it.published ?? "UNKNOWN");
}

function setFail(it: ImportItem, action: "conflict" | "skip", reason: string): void {
	it.action = action;
	it.reason = reason;
}

/**
 * Per-item actions from the preflight (§2.6.4). Mutates the items; returns
 * notes for the whole call.
 */
export function planFromPreflight(groups: PlanGroup[], pre: PreflightResult, n: NormalizedImportArgs): string[] {
	const notes: string[] = [];
	const matches = new Map(pre.matches.map((m) => [m.key, m]));
	const resumed = new Map((pre.resumed ?? []).map((r) => [`${r.source}\u0000${r.artHash}`, r]));
	const resumedHit = (it: ImportItem) => {
		const r = resumed.get(`${it.source}\u0000${it.artHash}`);
		if (!r) return false;
		Object.assign(it, { action: "unchanged" as const, nodeId: r.nodeId, type: r.type, width: r.width, height: r.height });
		it.notes.push(`Imported by the interrupted run ${n.resumeRunId}; not imported again.`);
		return true;
	};
	const copyRisk = (it: ImportItem, m: { instanceCount?: number | null; publish?: string; firstInstance?: string | null }) => {
		it.instanceCount = m.instanceCount ?? null;
		it.published = m.publish ?? "UNKNOWN";
		it.firstInstance = m.firstInstance ?? null;
	};

	for (const g of groups) {
		if (g.kind === "single") {
			const it = g.item;
			if (resumedHit(it)) continue;
			if (!n.asComponent) {
				it.action = "create";
				continue;
			}
			const m = matches.get(it.key);
			const name = it.name as string;
			if (!m || m.status === "none") {
				it.action = "create";
				continue;
			}
			if (n.onExisting === "duplicate") {
				it.action = "create";
				it.notes.push(`A component named "${name}" already exists; this one is a duplicate.`);
				continue;
			}
			if (m.status === "many") {
				setFail(it, "conflict", `${m.count ?? 2} components are named "${name}" (ids ${(m.ids ?? []).join(", ")}). Rename them so one is left, or pass onExisting: "duplicate".`);
				continue;
			}
			if (n.onExisting === "skip") {
				setFail(it, "skip", `"${name}" already exists; left as is.`);
				it.targetId = m.existingId;
				continue;
			}
			if (m.status === "kind-mismatch") {
				setFail(it, "conflict", `"${name}" is a component set, but this import makes a single component. Rename one of them.`);
				continue;
			}
			it.targetId = m.existingId;
			if (m.variantErrors) {
				setFail(it, "conflict", `The existing component "${name}" has property errors; fix them in Figma first.`);
				continue;
			}
			if (!m.eligible) {
				setFail(it, "conflict", `"${name}" isn't plain vector artwork (${m.why ?? "unknown reason"}), so it wasn't replaced. Rename the import (namePrefix) or pass onExisting: "duplicate".`);
				continue;
			}
			if (m.unchanged) {
				it.action = m.descriptionDiffers ? "metadata" : "unchanged";
				it.nodeId = m.existingId;
				it.width = m.width;
				it.height = m.height;
				continue;
			}
			it.action = "update";
			copyRisk(it, m);
			continue;
		}

		// Set group
		const m = matches.get(`set:${g.name}`);
		const allFail = (action: "conflict" | "skip", reason: string) => {
			for (const it of g.items) setFail(it, action, reason);
		};
		g.action = "create";
		if (!m || m.status === "none") {
			for (const it of g.items) if (!resumedHit(it)) it.action = "create";
			continue;
		}
		if (n.onExisting === "duplicate") {
			for (const it of g.items) it.action = "create";
			notes.push(`A component set named "${g.name}" already exists; this one is a duplicate.`);
			continue;
		}
		if (m.status === "many") {
			allFail("conflict", `${m.count ?? 2} components are named "${g.name}" (ids ${(m.ids ?? []).join(", ")}). Rename them so one is left, or pass onExisting: "duplicate".`);
			continue;
		}
		if (n.onExisting === "skip") {
			allFail("skip", `"${g.name}" already exists; left as is.`);
			continue;
		}
		if (m.status === "kind-mismatch") {
			allFail("conflict", `"${g.name}" is a component, but this import makes a component set. Rename one of them.`);
			continue;
		}
		if (m.variantErrors) {
			allFail("conflict", `The existing set "${g.name}" has variant errors; fix them in Figma first.`);
			continue;
		}
		const have = [...(m.axes ?? [])].sort();
		const want = [...g.axes].sort();
		if (have.join("\u0000") !== want.join("\u0000")) {
			allFail("conflict", `The existing set "${g.name}" has properties [${(m.axes ?? []).join(", ")}]; this import has [${g.axes.join(", ")}].`);
			continue;
		}
		g.action = "update";
		g.setId = m.existingId;
		g.untouched = m.untouched ?? 0;
		if (m.descriptionDiffers && n.description !== undefined) g.setDescription = n.description;
		const vm = new Map((m.variants ?? []).map((v) => [v.key, v]));
		for (const it of g.items) {
			const v = vm.get(it.key);
			if (!v || !v.existingId) {
				it.action = "create";
				continue;
			}
			it.targetId = v.existingId;
			if (v.matchedBy === "case-insensitive" && v.matchedName) it.notes.push(`Matched variant "${it.name}" to existing "${v.matchedName}".`);
			if (v.eligible === false) {
				setFail(it, "conflict", `"${g.name}" (${it.name}) isn't plain vector artwork (${v.why ?? "unknown reason"}), so it wasn't replaced. Rename the import (namePrefix) or pass onExisting: "duplicate".`);
				continue;
			}
			if (v.unchanged) {
				it.action = v.descriptionDiffers ? "metadata" : "unchanged";
				it.nodeId = v.existingId;
				it.componentSetId = m.existingId;
				it.width = v.width;
				it.height = v.height;
				continue;
			}
			it.action = "update";
			copyRisk(it, v);
		}
	}
	return notes;
}

export function allItems(groups: PlanGroup[]): ImportItem[] {
	const out: ImportItem[] = [];
	for (const g of groups) {
		if (g.kind === "single") out.push(g.item);
		else out.push(...g.items);
	}
	return out;
}

// ===========================================================================
// Confirmation
// ===========================================================================

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The question shown to the person (§2.6.5). */
export function confirmMessage(fileName: string, risky: ImportItem[]): string {
	const n = risky.length;
	const known = risky.map((r) => r.instanceCount ?? 0).reduce((a, b) => a + b, 0);
	const uncounted = risky.some((r) => r.instanceCount === null || r.instanceCount === undefined);
	const first = risky.find((r) => r.firstInstance)?.firstInstance;
	const instancesPart =
		known > 0 || uncounted
			? ` (used by ${uncounted ? "at least " : ""}${plural(known, "instance")} in this file${first ? `, including "${first}"` : ""})`
			: "";
	const published = risky.filter((r) => r.published === "CURRENT" || r.published === "CHANGED").length;
	const maybe = risky.filter((r) => r.published === "UNKNOWN").length;
	let publishedPart = "";
	if (published > 0) publishedPart = ` ${published} of them ${published === 1 ? "is" : "are"} published: files using this library get the new artwork when they accept the library update.`;
	else if (maybe > 0) publishedPart = ` ${maybe} of them may be published: files using this library get the new artwork when they accept the library update.`;
	return `In "${fileName}", replace the artwork of ${plural(n, "existing component")}${instancesPart}?${publishedPart} Where the layer structure is unchanged, instance overrides are kept; where it changed, overrides on the old layers reset. A version named "Before SVG import (Figma Console MCP)" is saved first; restore it from version history if needed.`;
}

/** Why a risky update was skipped on a client that can't ask (preview: how a dry run words it). */
export function unsupportedSkipReason(it: ImportItem, preview = false): string {
	const parts: string[] = [];
	if (it.instanceCount === null || it.instanceCount === undefined) parts.push("may have instances");
	else if (it.instanceCount > 0) parts.push(`has ${plural(it.instanceCount, "instance")}`);
	if (it.published === "CURRENT" || it.published === "CHANGED") parts.push("is published");
	else if (it.published === "UNKNOWN") parts.push("may be published");
	return `"${it.name}" ${parts.join(" and ") || "is in use"}, and this client can't ask for confirmation, so ${preview ? "a real run would skip it" : "it wasn't updated"}. Pass onExisting: "update" to update it anyway.`;
}

export const RESTORE_TITLE = "Before SVG import (Figma Console MCP)";

// ===========================================================================
// Chunking (§2.6.7)
// ===========================================================================

export interface ItemPayload {
	key: string;
	name: string;
	markup?: string;
	sentinel: string | null;
	rootColor?: string;
	artHash: string;
	source: string;
	hasText: boolean;
	action: "create" | "update" | "metadata";
	targetId?: string;
	props?: Record<string, string>;
	description?: string;
}

export type GroupPayload =
	| { kind: "single"; item: ItemPayload }
	| { kind: "set"; name: string; action: "create" | "update"; setId?: string; axes: string[]; variants: ItemPayload[]; description?: string; untouched?: number };

export interface Chunk {
	groups: GroupPayload[];
	keys: string[];
	items: number;
	jsonBytes: number;
	expanded: number;
}

function itemPayload(it: ImportItem, descriptionFallback: string | undefined): ItemPayload {
	const action = it.action as "create" | "update" | "metadata";
	const p: ItemPayload = {
		key: it.key,
		name: it.name as string,
		sentinel: it.sentinel ?? null,
		artHash: it.artHash as string,
		source: it.source,
		hasText: !!it.meta?.hasText,
		action,
	};
	// metadata items travel without markup: only the description changes.
	if (action !== "metadata") p.markup = it.markup;
	if (it.meta?.rootColor) p.rootColor = it.meta.rootColor;
	if (it.targetId && action !== "create") p.targetId = it.targetId;
	if (it.props) p.props = it.props;
	const d = it.description ?? descriptionFallback;
	if (d !== undefined) p.description = d;
	return p;
}

const writable = (it: ImportItem) => it.action === "create" || it.action === "update" || it.action === "metadata";

/**
 * Pack the writable groups into chunks (≤ 50 items, ≤ 1.5 MiB of JSON, ≤ 100k
 * expanded elements). A set group is never split; anything over a soft cap is
 * its own chunk; a set group over 12 MiB fails as a whole.
 */
export function buildChunks(groups: PlanGroup[], n: NormalizedImportArgs): Chunk[] {
	const chunks: Chunk[] = [];
	let cur: Chunk | null = null;
	const flush = () => {
		if (cur && cur.groups.length) chunks.push(cur);
		cur = null;
	};
	for (const g of groups) {
		let payload: GroupPayload;
		let members: ImportItem[];
		if (g.kind === "single") {
			if (!writable(g.item)) continue;
			members = [g.item];
			payload = { kind: "single", item: itemPayload(g.item, n.description) };
		} else {
			members = g.items.filter(writable);
			if (!members.length && g.setDescription === undefined) continue;
			const setDescription = g.action === "create" ? n.description : g.setDescription;
			payload = {
				kind: "set",
				name: g.name,
				action: g.action,
				...(g.setId ? { setId: g.setId } : {}),
				axes: g.axes,
				variants: members.map((it) => itemPayload(it, undefined)),
				...(setDescription !== undefined ? { description: setDescription } : {}),
				...(g.untouched !== undefined ? { untouched: g.untouched } : {}),
			};
		}
		// UTF-8 bytes, as the message travels; .length would undercount non-ASCII markup up to 3x.
		const bytes = utf8Length(JSON.stringify(payload));
		const expanded = members.reduce((s, it) => s + (it.action === "metadata" ? 0 : (it.meta?.expandedCount ?? 0)), 0);
		if (bytes > CHUNK_HARD_MAX_BYTES) {
			const what = g.kind === "set" ? "variant group" : "SVG";
			for (const it of members) {
				it.action = "fail";
				it.status = "failed";
				it.stage = "plan";
				it.reason = `This ${what} is ${formatMB(bytes)} of SVG; one ${g.kind === "set" ? "set" : "call step"} can carry at most ${formatMB(CHUNK_HARD_MAX_BYTES)}. Simplify the SVGs or split the set.`;
			}
			continue;
		}
		const count = Math.max(1, members.length);
		const oversized = count > CHUNK_MAX_ITEMS || bytes > CHUNK_MAX_BYTES || expanded > CHUNK_MAX_EXPANDED;
		const c = cur as Chunk | null;
		if (oversized || (c && (c.items + count > CHUNK_MAX_ITEMS || c.jsonBytes + bytes > CHUNK_MAX_BYTES || c.expanded + expanded > CHUNK_MAX_EXPANDED))) flush();
		if (!cur) cur = { groups: [], keys: [], items: 0, jsonBytes: 0, expanded: 0 };
		const target = cur as Chunk;
		target.groups.push(payload);
		target.keys.push(...members.map((m) => m.key));
		target.items += count;
		target.jsonBytes += bytes;
		target.expanded += expanded;
		if (oversized) flush();
	}
	flush();
	return chunks;
}

// ===========================================================================
// Layout (§2.6.6)
// ===========================================================================

export interface LayoutPlan {
	container: "section" | "frame" | "none";
	containerName: string;
	reuse?: { id: string; type: string; autoLayout: boolean };
	mode: "grid" | "shelf" | "auto-layout" | "single";
	columns: number;
	gap: number;
	padding: number;
	cell?: { w: number; h: number };
	origin?: { x: number; y: number };
	frameWidth?: number;
	error?: string;
	notes: string[];
}

/** Size an item will have after fitting (from the sanitizer metadata). */
export function expectedSize(meta: SvgMeta | undefined, n: NormalizedImportArgs): { w: number; h: number } {
	const w0 = meta?.width ?? meta?.viewBox?.[2] ?? 100;
	const h0 = meta?.height ?? meta?.viewBox?.[3] ?? 100;
	if (n.size !== undefined && n.asComponent) return { w: n.size, h: n.size };
	const bw = n.size ?? n.width;
	const bh = n.size ?? n.height;
	let s = Infinity;
	if (bw !== undefined) s = Math.min(s, bw / w0);
	if (bh !== undefined) s = Math.min(s, bh / h0);
	if (!Number.isFinite(s)) s = 1;
	return { w: w0 * s, h: h0 * s };
}

/**
 * Notes for an x/y that won't be used, so a dropped coordinate is never silent:
 * one coordinate alone (placement needs both; mixing one with the clear spot
 * could land on existing layers), or an auto-layout target that positions
 * children itself. Reuse has its own note.
 */
export function xyNotes(n: { x?: number; y?: number }, plan: Pick<LayoutPlan, "reuse" | "mode" | "container">): string[] {
	if (plan.reuse || (n.x === undefined && n.y === undefined)) return [];
	if ((n.x === undefined) !== (n.y === undefined)) {
		return [`${n.x === undefined ? "y" : "x"} ignored: pass both x and y to place the result; it went to clear space.`];
	}
	if (plan.container === "none" && plan.mode === "auto-layout") return ["x/y ignored: the parent uses auto layout, which positions the result."];
	return [];
}

export function planLayout(groups: PlanGroup[], pre: PreflightResult, n: NormalizedImportArgs): LayoutPlan {
	const notes: string[] = [];
	const containerName = n.layout.containerName ?? (n.asComponent ? "Icons" : "SVG import");
	const creates = groups.filter((g) => (g.kind === "single" ? g.item.action === "create" : g.action === "create" && g.items.some((i) => i.action === "create")));
	const hasSetGroup = groups.some((g) => g.kind === "set");
	const newTopLevel = creates.length;
	let container: LayoutPlan["container"] = "none";
	if (n.layout.container === "auto") {
		if (groups.length <= 1 || pre.parent.autoLayout) container = "none";
		else if (pre.editorType === "figjam" || n.asComponent) container = "section";
		else container = "frame";
		// Sections only live on pages or inside sections.
		if (container === "section" && pre.parent.type !== "PAGE" && pre.parent.type !== "SECTION") container = "none";
	} else container = n.layout.container;

	const plan: LayoutPlan = {
		container,
		containerName,
		mode: "shelf",
		columns: n.layout.columns ?? Math.max(1, Math.min(newTopLevel || 1, 12)),
		gap: n.layout.gap,
		padding: n.layout.padding,
		notes,
	};
	if (container !== "none" && pre.container) {
		plan.reuse = { id: pre.container.id, type: pre.container.type, autoLayout: pre.container.autoLayout };
		if (n.x !== undefined || n.y !== undefined) notes.push(`x/y ignored: the existing "${containerName}" was reused.`);
	} else if (container === "section" && newTopLevel > 0 && pre.parent.type !== "PAGE" && pre.parent.type !== "SECTION") {
		plan.error = `A section can only go on a page or inside another section; the parent is a ${pre.parent.type}. Use layout.container "frame" or "none".`;
	}
	const targetAutoLayout = plan.reuse ? plan.reuse.autoLayout : container === "frame" ? true : container === "none" ? pre.parent.autoLayout : false;
	if (targetAutoLayout) plan.mode = "auto-layout";
	else if (container === "none" && newTopLevel <= 1) plan.mode = "single";
	else if (n.size !== undefined && !hasSetGroup) plan.mode = "grid";
	else plan.mode = "shelf";
	if (plan.mode === "grid" && n.size !== undefined) plan.cell = { w: n.size, h: n.size };
	if (container === "none" && n.x !== undefined && n.y !== undefined) plan.origin = { x: n.x, y: n.y };
	notes.push(...xyNotes(n, plan));
	if (container === "frame" && !plan.reuse) {
		let cellW = n.size;
		if (cellW === undefined) {
			cellW = 0;
			for (const it of allItems(groups)) cellW = Math.max(cellW, expectedSize(it.meta, n).w);
			if (!cellW) cellW = 100;
		}
		plan.frameWidth = Math.round(plan.columns * cellW + (plan.columns - 1) * plan.gap + 2 * plan.padding);
	}
	return plan;
}

// ===========================================================================
// Response (§2.3)
// ===========================================================================

const STATUS_ORDER: ItemStatus[] = ["failed", "conflict", "unknown", "skipped", "updated", "created", "unchanged"];

function capNotes(notes: string[]): string[] | undefined {
	const uniq = [...new Set(notes)];
	if (!uniq.length) return undefined;
	if (uniq.length <= MAX_NOTES_PER_ITEM) return uniq;
	return [...uniq.slice(0, MAX_NOTES_PER_ITEM), `…and ${uniq.length - MAX_NOTES_PER_ITEM} more`];
}

export function fullItem(it: ImportItem, dryRun: boolean): Record<string, unknown> {
	const out: Record<string, unknown> = { source: it.source, name: it.name ?? null };
	if (dryRun) {
		out.action = it.action;
		if (it.targetId) out.existingId = it.targetId;
		if (it.instanceCount !== undefined) out.instanceCount = it.instanceCount;
		if (it.published !== undefined) out.published = it.published;
		if (it.reason) out.reason = it.reason;
		if (it.stage) out.stage = it.stage;
	} else {
		out.status = it.status;
		if (it.stage && (it.status === "failed" || it.status === "unknown")) out.stage = it.stage;
		if (it.reason) out.reason = it.reason;
		if (it.nodeId) out.nodeId = it.nodeId;
		if (it.type) out.type = it.type;
		if (it.componentSetId) out.componentSetId = it.componentSetId;
		if (it.props && it.setName) out.variant = it.props;
		if (it.width !== undefined) out.width = Math.round(it.width * 100) / 100;
		if (it.height !== undefined) out.height = Math.round(it.height * 100) / 100;
		if (it.update) out.update = { ...it.update, ...(it.instanceCount !== undefined ? { instanceCount: it.instanceCount } : {}), ...(it.published ? { published: it.published } : {}) };
		if (it.color) out.color = it.color;
		if (it.metadataUpdated) out.metadataUpdated = true;
	}
	if (it.sanitized && (Object.keys(it.sanitized.removedElements).length || it.sanitized.removedAttributes || it.sanitized.externalRefs)) {
		out.sanitized = { removedElements: it.sanitized.removedElements, removedAttributes: it.sanitized.removedAttributes, externalRefs: it.sanitized.externalRefs };
	}
	const notes = capNotes(it.notes);
	if (notes) out.notes = notes;
	return out;
}

export interface ResponseInput {
	n: NormalizedImportArgs;
	items: ImportItem[];
	runId?: string;
	pre?: PreflightResult;
	container?: { id: string; name: string; type: string; created: boolean };
	restorePoint?: { versionId: string; title: string };
	sets: Array<Record<string, unknown>>;
	remaining?: { count: number; nextOffset?: number; paths?: string[] };
	incomplete?: { reason: string; runId: string; notAttempted: string[]; inProgress?: string[] };
	notes: string[];
	confirmation?: { wouldAsk: boolean; reason?: string };
}

/** An incomplete block that still has work outstanding (a cancel that came after the last chunk has none). */
export function unfinished(incomplete: { notAttempted: string[]; inProgress?: string[] } | undefined): boolean {
	return !!incomplete && (incomplete.notAttempted.length > 0 || (incomplete.inProgress?.length ?? 0) > 0);
}

export function assembleResponse(r: ResponseInput): { body: Record<string, unknown>; isError: boolean } {
	const { n, items } = r;
	const count = (s: ItemStatus) => items.filter((i) => i.status === s).length;
	const summary = {
		requested: items.length,
		created: count("created"),
		updated: count("updated"),
		unchanged: count("unchanged"),
		skipped: count("skipped"),
		conflicts: count("conflict"),
		failed: count("failed"),
		// Only sets that exist (a set whose variants all failed has no id).
		componentSets: r.sets.filter((s) => s.id).length,
	};
	const ordered = items.slice().sort((a, b) => STATUS_ORDER.indexOf(a.status ?? "failed") - STATUS_ORDER.indexOf(b.status ?? "failed"));
	const fullStatuses = new Set<ItemStatus>(["failed", "conflict", "unknown", "skipped", "updated"]);
	// Items never sent (a stopped run) have no status; incomplete.notAttempted lists them.
	const full = n.dryRun ? ordered : n.verbose ? ordered.filter((i) => i.status) : ordered.filter((i) => i.status && fullStatuses.has(i.status));
	const shown = full.slice(0, MAX_FULL_ITEMS);
	const rest = full.slice(MAX_FULL_ITEMS);
	const body: Record<string, unknown> = {
		// A stopped run with items not confirmed (unknown) or never sent isn't a success.
		success: summary.failed === 0 && summary.conflicts === 0 && !unfinished(r.incomplete),
		dryRun: n.dryRun,
	};
	if (!n.dryRun && r.runId) body.runId = r.runId;
	if (n.dryRun) {
		const actions: Record<string, number> = {};
		for (const it of items) actions[it.action ?? "fail"] = (actions[it.action ?? "fail"] ?? 0) + 1;
		body.summary = { requested: items.length, actions, componentSets: r.sets.length };
	} else body.summary = summary;
	if (r.pre) body.file = { name: r.pre.fileName, editorType: r.pre.editorType };
	if (r.container) body.container = r.container;
	if (r.restorePoint) body.restorePoint = r.restorePoint;
	if (r.confirmation) body.confirmation = r.confirmation;
	body.items = shown.map((i) => fullItem(i, n.dryRun));
	if (!n.verbose && !n.dryRun) {
		body.created = items
			.filter((i) => i.status === "created")
			.map((i) => (i.componentSetId ? [i.source, i.name, i.nodeId, i.componentSetId] : [i.source, i.name, i.nodeId]));
		body.unchanged = items
			.filter((i) => i.status === "unchanged")
			.map((i) => (i.metadataUpdated ? [i.source, i.name, i.nodeId ?? null, "metadata"] : [i.source, i.name, i.nodeId ?? null]));
	}
	const realSets = n.dryRun ? r.sets : r.sets.filter((s) => s.id);
	if (realSets.length) body.componentSets = realSets;
	if (r.remaining && (r.remaining.count > 0 || (r.remaining.paths && r.remaining.paths.length))) body.remaining = r.remaining;
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
		const target = r.container?.id ?? items.find((i) => i.componentSetId)?.componentSetId ?? items.find((i) => i.nodeId)?.nodeId;
		const hints: string[] = [];
		if (target) hints.push(`Check the result with figma_capture_screenshot({ nodeId: "${target}" }).`);
		if (items.some((i) => i.status === "updated" && (i.published === "CURRENT" || i.published === "CHANGED" || i.published === "UNKNOWN"))) {
			hints.push("Publish the library so other files get the updated icons.");
		}
		if (r.incomplete) hints.push(`Continue with resumeRunId: "${r.incomplete.runId}".`);
		if (hints.length) body.hint = hints.join(" ");
	}
	const imported = summary.created + summary.updated + summary.unchanged + summary.skipped;
	const isError = !n.dryRun && imported === 0 && !r.incomplete && summary.failed + summary.conflicts > 0;
	return { body, isError };
}
