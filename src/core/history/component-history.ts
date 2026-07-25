/**
 * Component design history — "what changed on this component, and when".
 *
 * Walks a Figma file's version history newest-first and diffs each consecutive
 * pair of versions SCOPED to one or more node IDs (typically a COMPONENT_SET).
 * The result is a per-version list of human-readable change bullets suitable
 * for a documentation changelog table.
 *
 * Reuses the existing diff machinery (`diffNode` from diff-engine) rather than
 * reimplementing comparison logic, so coverage matches figma_diff_versions
 * exactly — including its known gaps (see COVERAGE_NOTE below).
 *
 * Cost model: N history rows requires N+1 version snapshots of the scoped node.
 * Snapshots of past versions are immutable, so the module-scoped LRU cache makes
 * consecutive-pair walking cost N+1 node fetches rather than 2N — each snapshot
 * is the "to" side of one pair and the "from" side of the next.
 *
 * Everything here is best-effort: a missing OAuth scope, a pruned version, or a
 * node that didn't exist yet must degrade to a note, never an exception. Doc
 * generation should not fail because history is unavailable.
 */

import type { FigmaAPI } from "../figma-api.js";
import { createChildLogger } from "../logger.js";
import { VersionSnapshotCache } from "../diff/version-cache.js";
import { diffNode, type DiffMode, type NodeDiff } from "../diff/diff-engine.js";

const logger = createChildLogger({ component: "component-history" });

// Past-version snapshots are immutable, so this can live for the process
// lifetime. Sized a little larger than the version-tools cache because a
// history walk touches versions+1 snapshots in a single call.
const historySnapshotCache = new VersionSnapshotCache({ maxEntries: 60 });

/** Test-only: clears the module-scoped snapshot cache so unit tests see fresh state. */
export function _clearComponentHistoryCacheForTesting(): void {
	historySnapshotCache.clear();
}

export const DEFAULT_HISTORY_VERSIONS = 5;
export const MAX_HISTORY_VERSIONS = 20;

const FIGMA_PAGE_SIZE_MAX = 50;
const MAX_SCAN_PAGES = 10;

/**
 * Max change bullets per history row. They render into one markdown table cell,
 * so an unbounded list wrecks the table. Verified live against a 24-variant
 * Button whose single token-binding edit produced 44 raw bullets.
 */
const MAX_BULLETS_PER_ENTRY = 12;

/**
 * Figma REST version snapshots omit description and Dev Mode annotation edits,
 * and diffs run at depth=2. Surfacing this keeps generated docs honest rather
 * than implying "no rows" means "no changes".
 */
const COVERAGE_NOTE =
	"Design history covers structure (child layers added/removed), component property definitions, variable bindings, and node renames at depth 2. Figma's REST version snapshots omit description and Dev Mode annotation edits, raw layout/visual properties, and variable value changes — those changes will not appear as rows here.";

export interface DesignHistoryEntry {
	version_id: string;
	label: string | null;
	created_at: string;
	author: string | null;
	is_labeled: boolean;
	change_count: number;
	/** Human-readable one-line change descriptions. */
	changes: string[];
}

export interface DesignHistoryResult {
	entries: DesignHistoryEntry[];
	notes: string[];
	_meta: {
		node_ids: string[];
		versions_scanned: number;
		pairs_diffed: number;
		api_calls: number;
		cache_hits: number;
		/** True when no labeled versions existed and auto-saves were used instead. */
		used_autosave_fallback?: boolean;
	};
}

export interface DesignHistoryOptions {
	/** Number of history rows to attempt. Each row costs ~1 node fetch. */
	versions?: number;
	/** Include unlabeled auto-saves. Default false — autosaves are very noisy. */
	includeAutosaves?: boolean;
	/** Diff verbosity. "detailed" names individual properties/bindings. */
	mode?: DiffMode;
}

interface VersionListEntry {
	id: string;
	label: string;
	created_at: string;
	user_handle: string | null;
	is_labeled: boolean;
}

/**
 * Build a per-version change history for the given node IDs.
 *
 * Never throws — all failures land in `notes` with an empty/partial entry list.
 */
export async function buildDesignHistory(
	api: FigmaAPI,
	fileKey: string,
	nodeIds: string[],
	options: DesignHistoryOptions = {},
): Promise<DesignHistoryResult> {
	const versionsWanted = clamp(
		options.versions ?? DEFAULT_HISTORY_VERSIONS,
		1,
		MAX_HISTORY_VERSIONS,
	);
	const includeAutosaves = options.includeAutosaves ?? false;
	const mode: DiffMode = options.mode ?? "standard";

	const scopedIds = [...new Set(nodeIds.filter((id) => id && id.trim() !== ""))];

	const result: DesignHistoryResult = {
		entries: [],
		notes: [],
		_meta: {
			node_ids: scopedIds,
			versions_scanned: 0,
			pairs_diffed: 0,
			api_calls: 0,
			cache_hits: 0,
		},
	};

	if (scopedIds.length === 0) {
		result.notes.push("No node IDs to scope design history to.");
		return result;
	}

	// N rows needs N+1 snapshots: each row is a diff between adjacent versions.
	let listed = await listVersions(api, fileKey, {
		limit: versionsWanted + 1,
		includeAutosaves,
	});
	result._meta.api_calls += listed.apiCalls;

	if (listed.error) {
		result._meta.versions_scanned = listed.versions.length;
		result.notes.push(listed.error);
		return result;
	}

	// Labeled versions are better changelog material when a team curates them,
	// but plenty of real design-system files have none at all (verified: a mature
	// file with 72 auto-saves and 0 labeled versions). Rather than silently
	// emitting nothing there, fall back to auto-saves and say so. Autosave noise
	// is largely absorbed downstream anyway — a version only becomes a row if it
	// actually changed the scoped component.
	if (!includeAutosaves && listed.versions.length < 2) {
		const fallback = await listVersions(api, fileKey, {
			limit: versionsWanted + 1,
			includeAutosaves: true,
		});
		result._meta.api_calls += fallback.apiCalls;
		if (!fallback.error && fallback.versions.length >= 2) {
			listed = fallback;
			result._meta.used_autosave_fallback = true;
			result.notes.push(
				"This file has no labeled versions, so history was built from Figma auto-saves. Name versions in Figma (right-click a version → Add label) for a more curated changelog.",
			);
		}
	}

	result._meta.versions_scanned = listed.versions.length;

	if (listed.versions.length < 2) {
		result.notes.push(
			"Not enough version history to build a changelog (need at least 2 saved versions).",
		);
		return result;
	}

	// listVersions returns newest-first. Row i describes what changed when
	// versions[i] was saved, i.e. the diff from versions[i + 1] to versions[i].
	for (let i = 0; i < listed.versions.length - 1; i++) {
		const newer = listed.versions[i];
		const older = listed.versions[i + 1];

		const changes: string[] = [];
		let changeCount = 0;

		for (const nodeId of scopedIds) {
			try {
				const [fromResp, toResp] = await Promise.all([
					fetchNodeAtVersion(api, fileKey, nodeId, older.id),
					fetchNodeAtVersion(api, fileKey, nodeId, newer.id),
				]);
				for (const r of [fromResp, toResp]) {
					if (r.cached) result._meta.cache_hits++;
					else result._meta.api_calls++;
				}

				const fromNode = fromResp.data?.nodes?.[nodeId]?.document ?? null;
				const toNode = toResp.data?.nodes?.[nodeId]?.document ?? null;

				// Node existed in neither snapshot — nothing meaningful to say.
				if (!fromNode && !toNode) continue;

				const nodeDiff = diffNode(fromNode, toNode, mode);
				if (nodeDiff.change_count === 0) continue;

				changeCount += nodeDiff.change_count;
				const prefix = scopedIds.length > 1 ? `${nodeDiff.node_name || nodeId}: ` : "";
				for (const bullet of summarizeNodeDiff(nodeDiff, mode)) {
					changes.push(prefix + bullet);
				}
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				logger.warn(
					{ err: message, nodeId, from: older.id, to: newer.id },
					"Scoped history diff failed for a version pair",
				);
				result.notes.push(
					`Could not diff \`${nodeId}\` between ${older.id} and ${newer.id}: ${message}`,
				);
			}
		}

		result._meta.pairs_diffed++;

		if (changeCount > 0) {
			result.entries.push({
				version_id: newer.id,
				label: newer.label || null,
				created_at: newer.created_at,
				author: newer.user_handle,
				is_labeled: newer.is_labeled,
				change_count: changeCount,
				changes,
			});
		}
	}

	if (result.entries.length === 0) {
		result.notes.push(
			`No tracked changes to this component across the last ${result._meta.pairs_diffed} version${result._meta.pairs_diffed === 1 ? "" : "s"}.`,
		);
	}
	result.notes.push(COVERAGE_NOTE);

	logger.info(
		{
			fileKey,
			nodeIds: scopedIds,
			entries: result.entries.length,
			apiCalls: result._meta.api_calls,
			cacheHits: result._meta.cache_hits,
		},
		"Built design history",
	);

	return result;
}

// ============================================================================
// Version listing
// ============================================================================

/**
 * Page through version history newest-first until `limit` qualifying versions
 * are collected. Mirrors figma_get_file_versions' pagination semantics: in a
 * newest-first list, `after=X` returns versions OLDER than X.
 */
async function listVersions(
	api: FigmaAPI,
	fileKey: string,
	opts: { limit: number; includeAutosaves: boolean },
): Promise<{ versions: VersionListEntry[]; apiCalls: number; error?: string }> {
	const collected: VersionListEntry[] = [];
	let apiCalls = 0;
	let cursor: string | undefined;
	let pages = 0;
	let hasMore = true;

	try {
		while (pages < MAX_SCAN_PAGES && hasMore && collected.length < opts.limit) {
			const response = await api.getFileVersions(fileKey, {
				page_size: FIGMA_PAGE_SIZE_MAX,
				after: cursor,
			});
			pages++;
			apiCalls++;

			const versions = response.versions || [];
			if (versions.length === 0) break;

			for (const v of versions) {
				const isLabeled = v.label != null && v.label !== "";
				if (!opts.includeAutosaves && !isLabeled) continue;
				if (collected.length >= opts.limit) break;
				collected.push({
					id: v.id,
					label: v.label || "",
					created_at: v.created_at,
					user_handle: v.user?.handle ?? null,
					is_labeled: isLabeled,
				});
			}

			hasMore = !!response.pagination?.next_page;
			const lastReceivedId = versions[versions.length - 1]?.id;
			// Defensive: stop if the cursor didn't advance (would loop forever).
			if (!lastReceivedId || lastReceivedId === cursor) break;
			cursor = lastReceivedId;
		}
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		const hint = message.includes("403")
			? " This endpoint requires the 'file_versions:read' OAuth scope, or the 'Versions' Read permission on a Personal Access Token."
			: "";
		return {
			versions: collected,
			apiCalls,
			error: `Could not read Figma version history: ${message}${hint}`,
		};
	}

	return { versions: collected, apiCalls };
}

// ============================================================================
// Node snapshot fetching
// ============================================================================

async function fetchNodeAtVersion(
	api: FigmaAPI,
	fileKey: string,
	nodeId: string,
	versionId: string,
): Promise<{ data: any; cached: boolean }> {
	const cacheKey = historySnapshotCache.makeKey(fileKey, versionId, 2, [nodeId]);
	const cached = historySnapshotCache.get<any>(cacheKey);
	if (cached) return { data: cached, cached: true };
	const data = await api.getNodes(fileKey, [nodeId], { version: versionId, depth: 2 });
	historySnapshotCache.set(cacheKey, data);
	return { data, cached: false };
}

// ============================================================================
// Diff → prose
// ============================================================================

/**
 * Flatten a NodeDiff into one-line change descriptions for a changelog row.
 *
 * Deliberately flat (no sub-headings) — these land in a markdown table cell,
 * unlike changelog-formatter's block layout which targets a full release-notes
 * document.
 */
export function summarizeNodeDiff(n: NodeDiff, mode: DiffMode = "standard"): string[] {
	const out: string[] = [];

	// Added/removed wholesale — diffNode signals this via notes with no field deltas.
	for (const note of n.notes) {
		const lower = note.toLowerCase();
		if (lower.includes("added in the target version")) out.push("Component introduced");
		else if (lower.includes("removed in the target version")) out.push("Component removed");
	}

	if (n.name_changed) {
		out.push(`Renamed \`${n.name_changed.from}\` → \`${n.name_changed.to}\``);
	}
	if (n.description_changed) {
		const from = n.description_changed.from.length;
		const to = n.description_changed.to.length;
		out.push(
			from === 0
				? "Description added"
				: to === 0
					? "Description removed"
					: `Description updated (${from} → ${to} chars)`,
		);
	}
	if (n.children_added.length > 0) {
		out.push(
			`Added ${n.children_added.length} layer${n.children_added.length === 1 ? "" : "s"}: ${listNames(n.children_added)}`,
		);
	}
	if (n.children_removed.length > 0) {
		out.push(
			`Removed ${n.children_removed.length} layer${n.children_removed.length === 1 ? "" : "s"}: ${listNames(n.children_removed)}`,
		);
	}

	const props = n.component_properties;
	if (props) {
		if (mode === "detailed") {
			for (const p of props.added) out.push(`Property \`${p.name}\` added (${p.type})`);
			for (const p of props.removed) out.push(`Property \`${p.name}\` removed (${p.type})`);
			for (const t of props.type_changed) {
				out.push(`Property \`${t.name}\` type changed: ${t.from_type} → ${t.to_type}`);
			}
			for (const d of props.default_changed) {
				out.push(`Property \`${d.name}\` default changed`);
			}
		} else {
			const s = props.summary;
			const parts: string[] = [];
			if (s.added > 0) parts.push(`${s.added} added`);
			if (s.removed > 0) parts.push(`${s.removed} removed`);
			if (s.type_changed > 0) parts.push(`${s.type_changed} retyped`);
			if (s.default_changed > 0) parts.push(`${s.default_changed} default changed`);
			if (parts.length > 0) out.push(`Component properties: ${parts.join(", ")}`);
		}
	}

	if (n.binding_changes.length > 0) {
		if (mode === "detailed") {
			// Group by property + kind rather than listing every affected node.
			// Binding one token across a component set fans out to one entry per
			// variant — on a 24-variant Button that is ~44 near-identical lines,
			// which is unreadable in a table cell. The property is the signal;
			// the per-variant repetition is not.
			const groups = new Map<
				string,
				{ kind: string; property: string; count: number; sample: string }
			>();
			for (const b of n.binding_changes) {
				const key = `${b.change_kind} ${b.property}`;
				const existing = groups.get(key);
				if (existing) {
					existing.count++;
				} else {
					groups.set(key, {
						kind: b.change_kind,
						property: b.property,
						count: 1,
						sample: b.node_name || b.node_id,
					});
				}
			}
			for (const g of groups.values()) {
				const verb =
					g.kind === "added"
						? "Variable bound"
						: g.kind === "removed"
							? "Variable unbound"
							: "Variable rebound";
				out.push(
					g.count === 1
						? `${verb}: ${g.sample} \`${g.property}\``
						: `${verb}: \`${g.property}\` on ${g.count} layers`,
				);
			}
		} else {
			const counts = { added: 0, removed: 0, rebound: 0 };
			for (const b of n.binding_changes) counts[b.change_kind]++;
			const parts: string[] = [];
			if (counts.added > 0) parts.push(`${counts.added} added`);
			if (counts.removed > 0) parts.push(`${counts.removed} removed`);
			if (counts.rebound > 0) parts.push(`${counts.rebound} rebound`);
			out.push(`Variable bindings: ${parts.join(", ")}`);
		}
	}

	// v1.25.0 plugin-buffer metadata changes, when the caller wired a buffer.
	if (n.metadata_changes && n.metadata_changes.length > 0) {
		const fields = [...new Set(n.metadata_changes.map((m) => m.field))];
		out.push(`Metadata updated (${fields.join(", ")})`);
	}

	// Backstop: these bullets render into a single markdown table cell, so an
	// unbounded list destroys the table regardless of how well each line reads.
	// Truncation is stated rather than silent.
	if (out.length > MAX_BULLETS_PER_ENTRY) {
		const dropped = out.length - MAX_BULLETS_PER_ENTRY;
		return [
			...out.slice(0, MAX_BULLETS_PER_ENTRY),
			`…and ${dropped} more change${dropped === 1 ? "" : "s"}`,
		];
	}

	return out;
}

// ============================================================================
// Helpers
// ============================================================================

function listNames(children: Array<{ id: string; name?: string }>, max = 5): string {
	const names = children.slice(0, max).map((c) => `\`${c.name || c.id}\``);
	const overflow = children.length - names.length;
	return names.join(", ") + (overflow > 0 ? `, +${overflow} more` : "");
}

function clamp(n: number, min: number, max: number): number {
	return Math.min(Math.max(n, min), max);
}
