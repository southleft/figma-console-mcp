/**
 * Figma Version History MCP Tools
 *
 *   - figma_get_file_versions: list a file's version history with
 *     auto-pagination, labeled-only filtering by default, and a hard cap.
 *   - figma_get_file_at_version: snapshot a file (or selected nodes) at a
 *     specific version_id. Thin wrapper over getFile/getNodes which already
 *     accept the `version` query param.
 *   - figma_diff_versions: compare two versions. Always returns a page-structure
 *     diff (cheap, 2 API calls). When component_ids are passed, also returns
 *     per-node diffs at depth=2 (added/removed children, name/description
 *     changes, componentPropertyDefinitions changes, boundVariables deltas).
 *   - figma_get_changes_since_version: convenience wrapper for diff against HEAD.
 *   - figma_generate_changelog: human-readable markdown changelog on top of
 *     the diff, with author enrichment via figma_get_file_versions lookback.
 *
 * All tools work in local and Cloudflare Workers modes. Required scope is
 * file_versions:read on OAuth, or "Versions" Read on a Personal Access Token,
 * plus the standard file_content:read for fetching file snapshots.
 *
 * Design notes at .notes/VERSION-HISTORY-DIFF-DESIGN.md.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FigmaAPI } from "./figma-api.js";
import { extractFileKey } from "./figma-api.js";
import { createChildLogger } from "./logger.js";
import { VersionSnapshotCache } from "./diff/version-cache.js";
import {
	diffNode,
	diffPageStructure,
	type DiffMode,
	type NodeDiff,
	type PageStructureDiff,
} from "./diff/diff-engine.js";
import {
	formatChangelogMarkdown,
	type VersionAuthorMeta,
} from "./diff/changelog-formatter.js";

const logger = createChildLogger({ component: "version-tools" });

// Module-scoped cache shared across all tool calls within a process.
// Past versions are immutable so the cache can live indefinitely.
const versionSnapshotCache = new VersionSnapshotCache({ maxEntries: 50 });

/** Test-only: clears the module-scoped snapshot cache so unit tests see fresh state. */
export function _clearVersionSnapshotCacheForTesting(): void {
	versionSnapshotCache.clear();
}

// Sentinel for "use HEAD instead of a specific version_id"
const CURRENT_VERSION_SENTINEL = "current";

function isCurrentSentinel(versionId: string): boolean {
	return versionId === CURRENT_VERSION_SENTINEL;
}

interface FetchResult<T> {
	data: T;
	cached: boolean;
}

/**
 * Fetch the document at depth=1 for either a specific version_id or HEAD.
 * HEAD responses are not cached (they're mutable). Past versions are cached.
 * Returns { data, cached } so callers can report accurate live-call counts.
 */
async function fetchDocumentAtVersion(
	api: FigmaAPI,
	fileKey: string,
	versionId: string,
): Promise<FetchResult<any>> {
	const isHead = isCurrentSentinel(versionId);
	const cacheKey = isHead ? null : versionSnapshotCache.makeKey(fileKey, versionId, 1);
	const cached = versionSnapshotCache.get<any>(cacheKey);
	if (cached) return { data: cached, cached: true };
	const opts = isHead ? { depth: 1 } : { version: versionId, depth: 1 };
	const data = await api.getFile(fileKey, opts);
	if (cacheKey) versionSnapshotCache.set(cacheKey, data);
	return { data, cached: false };
}

/**
 * Fetch a single node at depth=2 for either a specific version_id or HEAD.
 * Same caching policy and return contract as above.
 */
async function fetchNodeAtVersion(
	api: FigmaAPI,
	fileKey: string,
	nodeId: string,
	versionId: string,
): Promise<FetchResult<any>> {
	const isHead = isCurrentSentinel(versionId);
	const cacheKey = isHead ? null : versionSnapshotCache.makeKey(fileKey, versionId, 2, [nodeId]);
	const cached = versionSnapshotCache.get<any>(cacheKey);
	if (cached) return { data: cached, cached: true };
	const opts = isHead ? { depth: 2 } : { version: versionId, depth: 2 };
	const data = await api.getNodes(fileKey, [nodeId], opts);
	if (cacheKey) versionSnapshotCache.set(cacheKey, data);
	return { data, cached: false };
}

// ============================================================================
// Internal types
// ============================================================================

interface VersionUser {
	id: string;
	handle: string;
	img_url: string;
}

interface VersionEntry {
	id: string;
	label: string;
	description: string;
	created_at: string;
	user: VersionUser;
	is_labeled: boolean;
}

// Hard safety cap — 20 pages × 50 page_size = 1000 versions scanned worst-case.
// Prevents an infinite loop if Figma returns inconsistent pagination metadata.
const MAX_SCAN_PAGES = 20;

// Figma's documented page_size max
const FIGMA_PAGE_SIZE_MAX = 50;

// Tool-level cap on max_versions; design brief §4.
const MAX_VERSIONS_HARD_CAP = 200;

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * v1.25.0: a description/annotation change captured by the Desktop Bridge
 * plugin's documentchange listener. The diff engine queries this buffer to
 * surface metadata changes that Figma REST omits from version snapshots.
 *
 * Filtered by file key, time window (Unix ms), and optionally node IDs.
 */
export interface MetadataChangeBufferEntry {
	node_id: string;
	node_name: string | null;
	node_type: string | null;
	field: "description" | "annotations";
	new_value: any;
	timestamp: number;
}

export type GetMetadataChanges = (options: {
	fileKey?: string;
	since?: number;
	until?: number;
	nodeIds?: string[];
}) => MetadataChangeBufferEntry[];

export function registerVersionTools(
	server: McpServer,
	getFigmaAPI: () => Promise<FigmaAPI>,
	getCurrentUrl: () => string | null,
	_options?: { isRemoteMode?: boolean },
	getCurrentSelectedNodeIds?: () => string[] | null,
	/**
	 * v1.25.0: optional metadata-change buffer reader. When wired (local mode),
	 * the diff engine consults this to surface description/annotation edits
	 * that Figma REST doesn't expose. In cloud mode (no plugin buffer
	 * available), this stays undefined and the diff just doesn't surface
	 * those edits — but scope_coverage still tells callers about the gap.
	 */
	getMetadataChanges?: GetMetadataChanges,
): void {
	// Helper: read the current Figma selection as a list of node IDs, or null
	// if no selection getter is wired (cloud mode) or selection is empty.
	const readSelection = (): string[] | null => {
		if (!getCurrentSelectedNodeIds) return null;
		const ids = getCurrentSelectedNodeIds();
		return ids && ids.length > 0 ? ids : null;
	};

	// v1.25.0: convert an ISO8601 timestamp to Unix ms. Tolerates missing input.
	const toUnixMs = (iso: string | null | undefined): number | null => {
		if (!iso) return null;
		const t = Date.parse(iso);
		return Number.isFinite(t) ? t : null;
	};
	// -----------------------------------------------------------------------
	// Tool: figma_get_file_versions
	// -----------------------------------------------------------------------
	server.tool(
		"figma_get_file_versions",
		"List a Figma file's version history with metadata (label, description, author, timestamp). Auto-paginates up to max_versions. By default returns only labeled versions (skips auto-saves). Pass include_autosaves=true to see every saved state. Use the returned pagination.next_cursor to continue paging. Required scope: file_versions:read (OAuth) or 'Versions' Read (PAT).",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe("Figma file URL. Uses current URL if omitted."),
			include_autosaves: z
				.boolean()
				.optional()
				.default(false)
				.describe("Include auto-saved versions (those without a label). Default: false."),
			max_versions: z
				.number()
				.int()
				.min(1)
				.max(MAX_VERSIONS_HARD_CAP)
				.optional()
				.default(50)
				.describe("Hard cap on returned versions. Default 50, max 200."),
			cursor: z
				.string()
				.optional()
				.describe("Version ID returned as pagination.next_cursor on a previous call. Pass to continue from where the last call stopped."),
		},
		async ({ fileUrl, include_autosaves = false, max_versions = 50, cursor }) => {
			try {
				const url = fileUrl || getCurrentUrl();
				if (!url) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: "no_file_url",
									message:
										"No Figma file URL available. Pass the fileUrl parameter or ensure the Desktop Bridge plugin is open in Figma.",
								}),
							},
						],
						isError: true,
					};
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: "invalid_url",
									message: `Invalid Figma URL: ${url}`,
								}),
							},
						],
						isError: true,
					};
				}

				const cap = Math.min(Math.max(1, max_versions), MAX_VERSIONS_HARD_CAP);
				logger.info({ fileKey, cap, include_autosaves, cursor }, "Fetching file versions");

				const api = await getFigmaAPI();

				const collected: VersionEntry[] = [];
				let totalFiltered = 0;
				let cursorForNextPage = cursor;
				let figmaSaysMore = true;
				let lastReceivedId: string | null = null;
				let pages = 0;
				let apiCalls = 0;

				while (pages < MAX_SCAN_PAGES && figmaSaysMore && collected.length < cap) {
					// Figma's pagination semantics: in a newest-first list, `after=X`
					// returns versions that come AFTER X in list order, i.e. OLDER in time.
					// (Empirically verified — `before=X` returns newer items, which is the
					// opposite of what we want when paging into history.)
					const response = await api.getFileVersions(fileKey, {
						page_size: FIGMA_PAGE_SIZE_MAX,
						after: cursorForNextPage,
					});
					pages++;
					apiCalls++;

					const versions = response.versions || [];
					if (versions.length === 0) {
						figmaSaysMore = false;
						break;
					}

					lastReceivedId = versions[versions.length - 1].id;

					for (const v of versions) {
						const isLabeled = v.label != null && v.label !== "";
						if (!include_autosaves && !isLabeled) {
							totalFiltered++;
							continue;
						}
						if (collected.length >= cap) break;
						collected.push({
							id: v.id,
							label: v.label || "",
							description: v.description || "",
							created_at: v.created_at,
							user: v.user,
							is_labeled: isLabeled,
						});
					}

					figmaSaysMore = !!response.pagination?.next_page;

					// Defensive: stop if cursor didn't advance (would otherwise loop forever)
					if (lastReceivedId === cursorForNextPage) break;
					cursorForNextPage = lastReceivedId;
				}

				// next_cursor must be the LAST DISPLAYED item, not the last RECEIVED.
				// If the user paged forward with the last-received id, they would skip the
				// items between their last visible row and the page boundary.
				// Edge case: if labeled-only mode collected zero items but Figma has more
				// data to scan, expose lastReceivedId so the caller can keep scanning past
				// the autosave-only stretch.
				const lastCollectedId = collected.length > 0 ? collected[collected.length - 1].id : null;
				const hasMore = collected.length >= cap || figmaSaysMore;
				const nextCursor = hasMore
					? (lastCollectedId ?? lastReceivedId)
					: null;

				const result = {
					file_key: fileKey,
					versions: collected,
					pagination: {
						has_more: hasMore,
						next_cursor: nextCursor,
						returned: collected.length,
						filtered_out_autosaves: totalFiltered,
					},
					_meta: {
						api_calls_made: apiCalls,
						pages_scanned: pages,
					},
				};

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(result),
						},
					],
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error({ error }, "Failed to get file versions");

				const hint = message.includes("403")
					? " Hint: this endpoint requires the 'file_versions:read' OAuth scope, or the 'Versions' Read permission on a Personal Access Token. Add it at figma.com/developers/api#access-tokens and reissue your token."
					: "";

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: "get_file_versions_failed",
								message: message + hint,
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_get_file_at_version
	// -----------------------------------------------------------------------
	server.tool(
		"figma_get_file_at_version",
		"Fetch a Figma file (or specific nodes) as it existed at a past version_id. Thin snapshot tool — same shape as figma_get_file_data but bound to a historical version. Use figma_get_file_versions to discover version IDs. Combine with depth and node_ids to keep payloads small. Required scope: file_content:read (already standard).",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe("Figma file URL. Uses current URL if omitted."),
			version_id: z
				.string()
				.describe("The version ID to snapshot (from figma_get_file_versions)."),
			node_ids: z
				.array(z.string())
				.optional()
				.describe("Optional: snapshot only these node IDs instead of the full file. Reduces payload significantly for targeted inspection."),
			depth: z
				.number()
				.int()
				.min(1)
				.max(10)
				.optional()
				.describe("How deep into the document tree to recurse. Lower is cheaper. Default: full depth (no limit)."),
		},
		async ({ fileUrl, version_id, node_ids, depth }) => {
			try {
				const url = fileUrl || getCurrentUrl();
				if (!url) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: "no_file_url",
									message:
										"No Figma file URL available. Pass the fileUrl parameter or ensure the Desktop Bridge plugin is open in Figma.",
								}),
							},
						],
						isError: true,
					};
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: "invalid_url",
									message: `Invalid Figma URL: ${url}`,
								}),
							},
						],
						isError: true,
					};
				}

				logger.info({ fileKey, version_id, node_ids, depth }, "Snapshotting file at version");

				const api = await getFigmaAPI();
				const fileData =
					node_ids && node_ids.length > 0
						? await api.getNodes(fileKey, node_ids, { version: version_id, depth })
						: await api.getFile(fileKey, { version: version_id, depth });

				const result = {
					_version: {
						id: version_id,
						fetched_at: new Date().toISOString(),
						fileKey,
						scope: node_ids && node_ids.length > 0 ? "nodes" : "file",
					},
					...fileData,
				};

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(result),
						},
					],
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error({ error }, "Failed to snapshot file at version");

				const hint = message.includes("404")
					? " Hint: the version_id may have been pruned by Figma's plan-tier retention policy, or it may not belong to this file. Use figma_get_file_versions to list valid version IDs."
					: "";

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: "get_file_at_version_failed",
								message: message + hint,
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// Core diff computation. Returns the structured result so other tools
	// (changelog, blame, etc.) can compose without re-parsing JSON. The thin
	// MCP-wrapper handlers below format this for tool responses.
	const computeDiff = async (args: {
		fileUrl?: string;
		from_version: string;
		to_version: string;
		component_ids?: string[];
		mode?: DiffMode;
	}): Promise<
		| {
				ok: true;
				data: any;
				fileKey: string;
				fileName: string;
				fromFile: any;
				toFile: any;
				usedSelection: boolean;
		  }
		| { ok: false; error: string; message: string }
	> => {
		const { fileUrl, from_version, to_version } = args;
		const mode: DiffMode = args.mode ?? "standard";

		// Selection fallback: if caller didn't pass component_ids, use the
		// current Figma selection (if any). Empty array is treated as "no
		// scope" (intentional opt-out), undefined triggers the fallback.
		let component_ids = args.component_ids;
		let usedSelection = false;
		if (component_ids === undefined) {
			const selectedIds = readSelection();
			if (selectedIds) {
				component_ids = selectedIds;
				usedSelection = true;
			}
		}
		try {
			const url = fileUrl || getCurrentUrl();
			if (!url) {
				return {
					ok: false,
					error: "no_file_url",
					message:
						"No Figma file URL available. Pass the fileUrl parameter or ensure the Desktop Bridge plugin is open in Figma.",
				};
			}
			const fileKey = extractFileKey(url);
			if (!fileKey) {
				return { ok: false, error: "invalid_url", message: `Invalid Figma URL: ${url}` };
			}
			if (from_version === to_version) {
				return {
					ok: false,
					error: "same_version",
					message: "from_version and to_version are identical — nothing to diff.",
				};
			}

			logger.info(
				{ fileKey, from_version, to_version, mode, scoped: !!component_ids?.length },
				"Diffing versions",
			);
			const api = await getFigmaAPI();

			// Phase A: cheap orientation, parallel fetch
			let apiCalls = 0;
			let cacheHits = 0;
			const [fromFile, toFile] = await Promise.all([
				fetchDocumentAtVersion(api, fileKey, from_version),
				fetchDocumentAtVersion(api, fileKey, to_version),
			]);
			for (const r of [fromFile, toFile]) {
				if (r.cached) cacheHits++;
				else apiCalls++;
			}
			const pageDiff: PageStructureDiff = diffPageStructure(
				fromFile.data.document,
				toFile.data.document,
			);

			// Phase B: scoped node diffs (only if user provided component_ids)
			const scoped: NodeDiff[] = [];
			const fetchErrors: Array<{ node_id: string; error: string }> = [];
			if (component_ids && component_ids.length > 0) {
				for (const nodeId of component_ids) {
					try {
						const [fromResp, toResp] = await Promise.all([
							fetchNodeAtVersion(api, fileKey, nodeId, from_version),
							fetchNodeAtVersion(api, fileKey, nodeId, to_version),
						]);
						for (const r of [fromResp, toResp]) {
							if (r.cached) cacheHits++;
							else apiCalls++;
						}
						const fromNode = fromResp.data?.nodes?.[nodeId]?.document ?? null;
						const toNode = toResp.data?.nodes?.[nodeId]?.document ?? null;
						scoped.push(diffNode(fromNode, toNode, mode));
					} catch (e) {
						fetchErrors.push({
							node_id: nodeId,
							error: e instanceof Error ? e.message : String(e),
						});
					}
				}
			}

			const fromMeta = extractFileMeta(fromFile.data, from_version);
			const toMeta = extractFileMeta(toFile.data, to_version);

			// v1.25.0: query the plugin metadata buffer for description/annotation
			// changes within the diff's time window. The buffer is only populated
			// when the Desktop Bridge plugin was connected during the edit — so
			// edits made offline (or before this MCP session started) won't appear.
			// That limit is surfaced in scope_coverage + notes.
			const fromMs = toUnixMs(fromMeta.last_modified) ?? undefined;
			const toMs = toUnixMs(toMeta.last_modified) ?? Date.now();
			let bufferedMetadata: MetadataChangeBufferEntry[] = [];
			let metadataBufferAvailable = false;
			let unscopedMetadataChanges: MetadataChangeBufferEntry[] = [];
			if (getMetadataChanges) {
				metadataBufferAvailable = true;
				try {
					bufferedMetadata = getMetadataChanges({
						fileKey,
						since: fromMs,
						until: toMs,
					});
				} catch (e) {
					logger.warn({ err: e }, "Metadata buffer lookup failed; continuing without metadata changes");
					bufferedMetadata = [];
				}
			}

			// Attach buffer entries to the scoped node diffs whose id matches.
			// Entries that don't match any scoped id surface separately so the
			// caller can still see "the buffer has 3 description edits on nodes
			// you didn't ask about" instead of dropping them on the floor.
			if (bufferedMetadata.length > 0) {
				const scopedById = new Map(scoped.map((n) => [n.node_id, n]));
				const consumed = new Set<MetadataChangeBufferEntry>();
				for (const entry of bufferedMetadata) {
					const target = scopedById.get(entry.node_id);
					if (target) {
						target.metadata_changes ??= [];
						target.metadata_changes.push({
							field: entry.field,
							new_value: entry.new_value,
							timestamp: entry.timestamp,
							source: "plugin_buffer",
						});
						target.change_count += 1;
						consumed.add(entry);
					}
				}
				unscopedMetadataChanges = bufferedMetadata.filter((e) => !consumed.has(e));
			}

			const notes: string[] = [];
			const hasScopedNodes = !!(component_ids && component_ids.length > 0);
			if (!hasScopedNodes) {
				notes.push(
					"Only page-structure diff returned. Pass component_ids to get per-component analysis (added/removed children, property changes, binding changes), or have a node selected in Figma when you call.",
				);
			}
			if (usedSelection) {
				notes.push(
					`Auto-scoped to ${component_ids?.length ?? 0} node(s) from the current Figma selection. Pass component_ids explicitly to override.`,
				);
			}
			// Always-on coverage warnings — the failure mode we're guarding against is
			// the user (or an AI client) believing "no changes found" means "nothing
			// changed," when in fact the change is in a category this tool doesn't
			// track. Better to be loud about limits than silently miss real edits.
			if (hasScopedNodes) {
				notes.push(
					"Component-scoped diff covers the canonical components only. INSTANCES of these components placed elsewhere on the canvas (documentation examples, hero frames, mockups) are NOT diffed. For forensic per-session edits including instance changes, use figma_get_design_changes. To diff a specific instance, pass its node ID explicitly.",
				);
			}
			notes.push(
				"Raw layout/visual properties are NOT tracked. This includes layoutSizingHorizontal/Vertical (hug vs. fill), primaryAxisSizingMode/counterAxisSizingMode, raw paddings/widths/cornerRadius when not bound to a variable, and unbound fills/strokes/effects. This tool surfaces structural deltas (children, property defs, name, description) and variable-BINDING deltas only.",
			);
			notes.push(
				"Variable VALUE history is not retrievable from Figma REST API. Variable definition value changes between these versions are not represented; only binding-reference changes on scoped nodes are detected.",
			);
			// v1.25.0: surface metadata-buffer state. Either "tracked via plugin buffer"
			// (and any limits) or "not tracked at all" (cloud mode / plugin absent).
			if (metadataBufferAvailable) {
				notes.push(
					"Description and annotation changes ARE tracked when the Desktop Bridge plugin was connected during the edit. They appear under each node's metadata_changes[]. Edits made while the plugin was disconnected (or before this MCP session started) WON'T appear in the buffer — the diff will silently miss them.",
				);
				if (bufferedMetadata.length === 0) {
					notes.push(
						"No description or annotation changes were captured by the plugin buffer in this version window. Either no such edits happened, or they occurred while the plugin was disconnected.",
					);
				}
			} else {
				notes.push(
					"Description and annotation changes are NOT being tracked — no metadata buffer is wired (typically cloud mode without an active Desktop Bridge connection). For description/annotation visibility, use local mode with the plugin running.",
				);
			}
			if (fetchErrors.length > 0) {
				notes.push(
					`Failed to fetch ${fetchErrors.length} of ${component_ids?.length ?? 0} requested nodes — see _fetch_errors.`,
				);
			}

			const scopedChanged = scoped.filter((n) => n.change_count > 0).length;

			const data = {
				file_key: fileKey,
				from: fromMeta,
				to: toMeta,
				page_structure: pageDiff,
				scoped_nodes: hasScopedNodes ? scoped : undefined,
				summary: {
					page_changes:
						pageDiff.summary.added + pageDiff.summary.removed + pageDiff.summary.renamed,
					scoped_nodes_requested: component_ids?.length ?? 0,
					scoped_nodes_returned: scoped.length,
					scoped_nodes_with_changes: scopedChanged,
					used_selection: usedSelection,
					api_calls_made: apiCalls,
					cache_hits: cacheHits,
				},
				// scope_coverage is an always-on, machine-readable summary of what the
				// diff DID and DID NOT examine. AI clients should check this before
				// concluding "nothing else changed." See notes[] for prose warnings.
				scope_coverage: {
					page_structure_diffed: true,
					component_ids_diffed: component_ids ?? [],
					max_depth: 2,
					/**
					 * v1.25.0: metadata-buffer state. When the plugin is connected
					 * during edits, description/annotation changes ARE tracked.
					 * `metadata_buffer.available: false` means the diff is REST-only
					 * and description/annotation edits are invisible.
					 */
					metadata_buffer: {
						available: metadataBufferAvailable,
						entries_in_window: bufferedMetadata.length,
						entries_matched_to_scoped_nodes:
							bufferedMetadata.length - unscopedMetadataChanges.length,
						entries_outside_scope: unscopedMetadataChanges.length,
					},
					tracks: [
						"page structure (added/removed/renamed pages)",
						"component children (added/removed)",
						"componentPropertyDefinitions (added/removed/type/default)",
						"name and description changes on scoped nodes",
						"variable binding references on scoped nodes",
						...(metadataBufferAvailable
							? [
									"component descriptions via plugin session buffer (when plugin connected during edit)",
									"Dev Mode annotations via plugin session buffer (when plugin connected during edit)",
								]
							: []),
					],
					does_not_track: [
						"instances of components on the canvas (unless passed as component_ids)",
						"raw layout properties (layoutSizingHorizontal/Vertical, unbound paddings/widths)",
						"raw visual properties (cornerRadius, unbound fills/strokes/effects, opacity)",
						"variable VALUE changes (Figma REST does not expose this)",
						"style content changes (only style add/remove via component reachability)",
						...(metadataBufferAvailable
							? [
									"description/annotation edits made while the Desktop Bridge plugin was disconnected",
								]
							: [
									"component descriptions (Figma REST omits them; no plugin buffer wired in this mode)",
									"Dev Mode annotations (Figma REST omits them; no plugin buffer wired in this mode)",
								]),
						"canvas frame edits outside scoped components",
					],
					complementary_tools: [
						"figma_get_design_changes — forensic per-session edits including raw property changes on instances",
						"figma_get_variables — current variable state (no history available)",
						"figma_get_styles — current style state",
						"figma_get_component — live description and annotation state for a single node",
					],
				},
				unscoped_metadata_changes:
					unscopedMetadataChanges.length > 0
						? unscopedMetadataChanges.map((e) => ({
								node_id: e.node_id,
								node_name: e.node_name,
								node_type: e.node_type,
								field: e.field,
								new_value: e.new_value,
								timestamp: e.timestamp,
								source: "plugin_buffer" as const,
							}))
						: undefined,
				notes,
				_fetch_errors: fetchErrors.length > 0 ? fetchErrors : undefined,
			};

			return {
				ok: true,
				data,
				fileKey,
				fileName: fromFile.data?.name ?? toFile.data?.name ?? "",
				fromFile: fromFile.data,
				toFile: toFile.data,
				usedSelection,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error({ error }, "Failed to diff versions");
			const hint = message.includes("403")
				? " Hint: ensure your token has both file_content:read and file_versions:read scopes."
				: message.includes("404")
					? " Hint: a version_id may have been pruned or may not belong to this file. Use figma_get_file_versions to list valid IDs."
					: "";
			return { ok: false, error: "diff_versions_failed", message: message + hint };
		}
	};

	// Thin wrapper: call computeDiff and format the response for the MCP tool
	// surface. Used by figma_diff_versions and figma_get_changes_since_version.
	const runDiff = async (args: {
		fileUrl?: string;
		from_version: string;
		to_version: string;
		component_ids?: string[];
		mode?: DiffMode;
	}) => {
		const result = await computeDiff(args);
		if (!result.ok) {
			return errorResponse(result.error, result.message);
		}
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result.data) }],
		};
	};

	// Author/label/timestamp lookup for specific version IDs. Paginates
	// figma_get_file_versions until both targets are found OR a hard lookback
	// cap is hit. Returns null entries for any versions not found within
	// the cap. Never throws — enrichment is best-effort.
	const findVersionAuthorMetadata = async (
		api: FigmaAPI,
		fileKey: string,
		versionIds: string[],
	): Promise<Map<string, VersionAuthorMeta | null>> => {
		const result = new Map<string, VersionAuthorMeta | null>();
		for (const id of versionIds) result.set(id, null);
		const wanted = new Set(versionIds.filter((id) => !isCurrentSentinel(id)));
		if (wanted.size === 0) return result;

		const MAX_PAGES = 4; // 4 × 50 = 200 versions of lookback
		let cursor: string | undefined;
		for (let page = 0; page < MAX_PAGES && wanted.size > 0; page++) {
			let response: any;
			try {
				response = await api.getFileVersions(fileKey, {
					page_size: 50,
					after: cursor,
				});
			} catch (e) {
				logger.warn({ err: e }, "Author enrichment lookup failed; continuing without it");
				break;
			}
			const versions = response?.versions || [];
			if (versions.length === 0) break;
			for (const v of versions) {
				if (wanted.has(v.id)) {
					result.set(v.id, {
						version_id: v.id,
						label: v.label || null,
						created_at: v.created_at || null,
						user_handle: v.user?.handle || null,
					});
					wanted.delete(v.id);
				}
			}
			if (wanted.size === 0) break;
			if (!response?.pagination?.next_page) break;
			const last = versions[versions.length - 1];
			if (!last?.id || last.id === cursor) break;
			cursor = last.id;
		}
		return result;
	};

	// -----------------------------------------------------------------------
	// Tool: figma_diff_versions
	// -----------------------------------------------------------------------
	server.tool(
		"figma_diff_versions",
		"Diff two versions of a Figma file. Always returns a cheap page-structure diff (added/removed/renamed pages, 2 API calls). Pass component_ids to additionally get per-node deep diffs at depth=2 (added/removed children, name/description changes, componentPropertyDefinitions changes for COMPONENT_SETs, boundVariables deltas) — costs 2 API calls per scoped node. Use 'current' for to_version to diff against HEAD. v1.25.0: when the Desktop Bridge plugin is connected, description and Dev Mode annotation changes are ALSO tracked via a session buffer and surfaced under `scoped_nodes[].metadata_changes[]` and `unscoped_metadata_changes[]` — Figma REST omits these from version snapshots so they're otherwise invisible. STILL NOT tracked: instances of components on the canvas, raw layout properties (layoutSizingHorizontal/Vertical, unbound paddings/widths), raw visual properties (cornerRadius, unbound fills), variable VALUE changes, style content, and metadata edits made while the plugin was disconnected. See `scope_coverage` and `notes[]` for the full coverage map and complementary tools.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe("Figma file URL. Uses current URL if omitted."),
			from_version: z
				.string()
				.describe("The earlier version_id to compare from. Get from figma_get_file_versions."),
			to_version: z
				.string()
				.describe("The later version_id to compare to. Use 'current' for HEAD."),
			component_ids: z
				.array(z.string())
				.optional()
				.describe("Optional. Node IDs (typically COMPONENT_SETs) to diff in detail. If omitted, falls back to the current Figma selection. If neither is available, only the page-structure diff is returned. Use figma_get_design_system_kit or figma_search_components to discover IDs explicitly."),
			mode: z
				.enum(["summary", "standard", "detailed"])
				.optional()
				.default("standard")
				.describe("Output verbosity. summary=counts only, standard=names+counts (default), detailed=full property/binding details."),
		},
		async (args) => runDiff(args as any),
	);

	// -----------------------------------------------------------------------
	// Tool: figma_get_changes_since_version
	// -----------------------------------------------------------------------
	server.tool(
		"figma_get_changes_since_version",
		"Convenience wrapper for figma_diff_versions: compares a given version against the current HEAD. Same output shape as figma_diff_versions, with to_version implicitly 'current'. Useful for 'what's changed since the last code-sync' workflows.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe("Figma file URL. Uses current URL if omitted."),
			since_version: z
				.string()
				.describe("The version_id to compare against the current HEAD."),
			component_ids: z
				.array(z.string())
				.optional()
				.describe("Optional. Node IDs to diff in detail. If omitted, falls back to the current Figma selection. Same semantics as figma_diff_versions otherwise."),
			mode: z
				.enum(["summary", "standard", "detailed"])
				.optional()
				.default("standard"),
		},
		async ({ fileUrl, since_version, component_ids, mode }) =>
			runDiff({
				fileUrl,
				from_version: since_version,
				to_version: CURRENT_VERSION_SENTINEL,
				component_ids,
				mode: mode as DiffMode | undefined,
			}),
	);

	// -----------------------------------------------------------------------
	// Tool: figma_generate_changelog
	// -----------------------------------------------------------------------
	server.tool(
		"figma_generate_changelog",
		"Generate a human-readable markdown changelog between two versions. Wraps figma_diff_versions and enriches the output with author labels and timestamps via figma_get_file_versions lookback (one extra cheap API call). Returns BOTH a `markdown` string (paste into release notes / PRs / Storybook MDX) and the structured diff data. Same component_ids and mode semantics as figma_diff_versions. Use 'current' for to_version to changelog against HEAD.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe("Figma file URL. Uses current URL if omitted."),
			from_version: z
				.string()
				.describe("The earlier version_id. Get from figma_get_file_versions."),
			to_version: z
				.string()
				.describe("The later version_id. Use 'current' for HEAD."),
			component_ids: z
				.array(z.string())
				.optional()
				.describe("Optional. Node IDs to include in the per-component changelog section. If omitted, falls back to the current Figma selection."),
			mode: z
				.enum(["summary", "standard", "detailed"])
				.optional()
				.default("standard")
				.describe("Output verbosity. summary=one-liner, standard=sectioned with counts (default), detailed=full per-property/per-binding bullets."),
		},
		async ({ fileUrl, from_version, to_version, component_ids, mode }) => {
			const effectiveMode: DiffMode = (mode as DiffMode | undefined) ?? "standard";
			try {
				const result = await computeDiff({
					fileUrl,
					from_version,
					to_version,
					component_ids,
					mode: effectiveMode,
				});
				if (!result.ok) {
					return errorResponse(result.error, result.message);
				}

				// Best-effort author enrichment. If lookup fails or comes up empty,
				// the formatter degrades gracefully.
				const api = await getFigmaAPI();
				const idsToLookup = [from_version, to_version].filter(
					(id) => !isCurrentSentinel(id),
				);
				const authorMap = idsToLookup.length > 0
					? await findVersionAuthorMetadata(api, result.fileKey, idsToLookup)
					: new Map<string, VersionAuthorMeta | null>();

				const fromMeta: VersionAuthorMeta | null = isCurrentSentinel(from_version)
					? buildHeadMeta(result.fromFile)
					: authorMap.get(from_version) ?? null;
				const toMeta: VersionAuthorMeta | null = isCurrentSentinel(to_version)
					? buildHeadMeta(result.toFile)
					: authorMap.get(to_version) ?? null;

				const markdown = formatChangelogMarkdown(
					{
						file_key: result.fileKey,
						file_name: result.fileName || null,
						from_version_id: from_version,
						to_version_id: to_version,
						from_meta: fromMeta,
						to_meta: toMeta,
						page_structure: result.data.page_structure,
						scoped_nodes: result.data.scoped_nodes,
						notes: result.data.notes,
					},
					effectiveMode,
				);

				const response = {
					markdown,
					structured: result.data,
					_meta: {
						authors_enriched: idsToLookup.length > 0,
						from_author_found: !!fromMeta && !fromMeta.is_head,
						to_author_found: !!toMeta && !toMeta.is_head,
					},
				};

				return {
					content: [{ type: "text" as const, text: JSON.stringify(response) }],
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error({ error }, "Failed to generate changelog");
				return errorResponse("generate_changelog_failed", message);
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_blame_node
	// -----------------------------------------------------------------------
	server.tool(
		"figma_blame_node",
		"Find the version that introduced a specific change to a node — answers 'who/when added this'. Walks version history backward via binary search (~log2(N) API calls instead of N) to localize the introduction point. Returns the version's metadata (label/author/timestamp). Default includes autosaves for finer attribution; system 'Figma' user appears occasionally for scheduled snapshots and is flagged via attribution_certainty='system_attributed'. Specify EXACTLY ONE of target_component_property or target_child_node_id. node_id is optional — if omitted, falls back to the first node in the current Figma selection.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe("Figma file URL. Uses current URL if omitted."),
			node_id: z
				.string()
				.optional()
				.describe("The parent node ID to inspect (typically a COMPONENT_SET). If omitted, falls back to the first node in the current Figma selection."),
			target_component_property: z
				.string()
				.optional()
				.describe("A componentPropertyDefinitions key (e.g. 'Disabled#1:2') — find when this property was first added to the node."),
			target_child_node_id: z
				.string()
				.optional()
				.describe("A descendant node ID — find when this child was first added under node_id."),
			start_version: z
				.string()
				.optional()
				.default("current")
				.describe("Version to walk backward from. Default 'current' (HEAD)."),
			max_versions_to_walk: z
				.number()
				.int()
				.min(2)
				.max(500)
				.optional()
				.default(200)
				.describe("Lookback cap. Binary search probes ~log2(N) of these. Default 200, max 500."),
			include_autosaves: z
				.boolean()
				.optional()
				.default(true)
				.describe("Include auto-saved versions in the search range. Default true (better attribution accuracy; most autosaves carry the real human user)."),
		},
		async ({
			fileUrl,
			node_id,
			target_component_property,
			target_child_node_id,
			start_version,
			max_versions_to_walk,
			include_autosaves,
		}) => {
			const lookback = max_versions_to_walk ?? 200;
			const includeAuto = include_autosaves ?? true;
			const startVer = start_version ?? CURRENT_VERSION_SENTINEL;
			try {
				// Selection fallback: if node_id is omitted, use the first selected node.
				let resolvedNodeId = node_id;
				let usedSelection = false;
				if (!resolvedNodeId) {
					const selectedIds = readSelection();
					if (selectedIds && selectedIds.length > 0) {
						resolvedNodeId = selectedIds[0];
						usedSelection = true;
					} else {
						return errorResponse(
							"no_node_id",
							"No node_id provided and no node is currently selected in Figma. Pass node_id explicitly or select a node first.",
						);
					}
				}

				// Validate exactly one target type
				const targets = [target_component_property, target_child_node_id].filter(
					(t) => t !== undefined && t !== null,
				);
				if (targets.length !== 1) {
					return errorResponse(
						"invalid_target",
						"Specify exactly one of target_component_property or target_child_node_id.",
					);
				}

				const url = fileUrl || getCurrentUrl();
				if (!url) {
					return errorResponse(
						"no_file_url",
						"No Figma file URL available. Pass the fileUrl parameter or ensure the Desktop Bridge plugin is open in Figma.",
					);
				}
				const fileKey = extractFileKey(url);
				if (!fileKey) {
					return errorResponse("invalid_url", `Invalid Figma URL: ${url}`);
				}

				logger.info(
					{
						fileKey,
						node_id: resolvedNodeId,
						usedSelection,
						target_component_property,
						target_child_node_id,
						startVer,
						lookback,
						includeAuto,
					},
					"Blaming node",
				);

				const api = await getFigmaAPI();
				let apiCalls = 0;
				let cacheHits = 0;

				// Step 1: Confirm target exists at start_version
				const startResp = await fetchNodeAtVersion(api, fileKey, resolvedNodeId, startVer);
				if (startResp.cached) cacheHits++;
				else apiCalls++;
				const startNode = startResp.data?.nodes?.[resolvedNodeId]?.document ?? null;
				if (!startNode) {
					return errorResponse(
						"node_not_at_start",
						`Node ${resolvedNodeId} not found at start_version. Verify the node_id and start_version.`,
					);
				}
				if (!targetExists(startNode, { target_component_property, target_child_node_id })) {
					return errorResponse(
						"target_not_at_start",
						`Target was not found at start_version. The blame walker requires the target to exist at start_version (you're asking 'when was this introduced'). If you're tracking something that was REMOVED, you want to look in the opposite direction — pick a start_version where it still existed.`,
					);
				}

				// Step 2: Build the candidate version list — versions strictly OLDER than start.
				// Use the file's resolved version id (not the 'current' sentinel) so the
				// collector can correctly skip past start to begin collecting older versions.
				const resolvedStartVer: string = isCurrentSentinel(startVer)
					? (startResp.data as any)?.version || startVer
					: startVer;
				const candidates = await collectCandidateVersions(
					api,
					fileKey,
					resolvedStartVer,
					lookback,
					includeAuto,
				);
				apiCalls += candidates.apiCalls;
				cacheHits += candidates.cacheHits;
				const versions = candidates.versions; // newest-first, all OLDER than start

				// Step 3: Binary search for the LARGEST index (oldest version) where target exists.
				// Existence is assumed monotonic: if target exists at an OLDER version (larger
				// index), it must also exist at all NEWER versions up to start. We search for
				// the OLDEST version that still has the target — that's the introduction point.
				// Empty range is fine (handled below).
				let lo = 0;
				let hi = versions.length - 1;
				const probedExists = new Map<number, boolean>();
				let oldestExistsIdx = -1;

				while (lo <= hi) {
					const mid = Math.floor((lo + hi) / 2);
					const midVer = versions[mid].id;
					const resp = await fetchNodeAtVersion(api, fileKey, resolvedNodeId, midVer);
					if (resp.cached) cacheHits++;
					else apiCalls++;
					const midNode = resp.data?.nodes?.[resolvedNodeId]?.document ?? null;
					const exists = midNode
						? targetExists(midNode, {
								target_component_property,
								target_child_node_id,
							})
						: false;
					probedExists.set(mid, exists);
					if (exists) {
						if (mid > oldestExistsIdx) oldestExistsIdx = mid;
						lo = mid + 1; // search older
					} else {
						hi = mid - 1; // search newer
					}
				}

				// Three outcomes:
				//   oldestExistsIdx === -1            -> target introduced AT start_version itself
				//   oldestExistsIdx === versions.len-1 -> introduction is OLDER than our lookback
				//   otherwise                          -> oldestExistsIdx is the introduction point
				const notes: string[] = [];
				let introducedVersionMeta: {
					version_id: string;
					label: string | null;
					created_at: string | null;
					user_handle: string | null;
					is_labeled: boolean;
				};
				let certainty: string;

				if (oldestExistsIdx === -1) {
					// Target was introduced at start_version itself. Look up start's metadata.
					const lookupId = isCurrentSentinel(startVer) ? resolvedStartVer : startVer;
					const authorMap = await findVersionAuthorMetadata(api, fileKey, [lookupId]);
					apiCalls += 1; // helper makes 1-4 paginated calls; conservative under-count
					const meta = authorMap.get(lookupId);
					introducedVersionMeta = {
						version_id: lookupId,
						label: meta?.label ?? null,
						created_at:
							meta?.created_at ?? (startResp.data as any)?.lastModified ?? null,
						user_handle: meta?.user_handle ?? null,
						is_labeled: !!(meta?.label && meta.label !== ""),
					};
					certainty =
						introducedVersionMeta.user_handle === "Figma"
							? "system_attributed"
							: introducedVersionMeta.user_handle
								? "exact"
								: "metadata_unavailable";
					if (certainty === "metadata_unavailable") {
						notes.push(
							"Target was introduced at start_version itself, but author metadata for that version was not found within the version-list lookback. The introduction is real; the user is just not attributable from REST data alone.",
						);
					}
				} else {
					const introducedVersion = versions[oldestExistsIdx];
					introducedVersionMeta = {
						version_id: introducedVersion.id,
						label: introducedVersion.label || null,
						created_at: introducedVersion.created_at,
						user_handle: introducedVersion.user?.handle ?? null,
						is_labeled: !!(introducedVersion.label && introducedVersion.label !== ""),
					};
					if (oldestExistsIdx === versions.length - 1) {
						certainty = "exists_at_lookback_horizon";
						notes.push(
							`Target also exists at the oldest scanned version (${introducedVersion.id}). The actual introduction is older than the search range. Increase max_versions_to_walk (currently ${lookback}) to keep searching.`,
						);
					} else if (introducedVersionMeta.user_handle === "Figma") {
						certainty = "system_attributed";
						notes.push(
							"The introduction version was a system-triggered autosave (user='Figma'). For a human author, set include_autosaves=false and re-run — that finds the nearest LABELED version that includes the change.",
						);
					} else {
						certainty = "exact";
					}
				}

				notes.push(
					"Binary search assumes the target's existence is monotonic (added once, never removed). If the target was added, removed, then re-added, this tool may report a different introduction point than the original.",
				);

				if (usedSelection) {
					notes.push(
						`Auto-scoped to node ${resolvedNodeId} from the current Figma selection. Pass node_id explicitly to override.`,
					);
				}

				const result = {
					file_key: fileKey,
					node_id: resolvedNodeId,
					target: target_component_property
						? { type: "component_property", name: target_component_property }
						: { type: "child_node", node_id: target_child_node_id },
					introduced_at: introducedVersionMeta,
					attribution_certainty: certainty,
					summary: {
						versions_in_search_range: versions.length,
						probes_made: probedExists.size,
						used_selection: usedSelection,
						api_calls_made: apiCalls,
						cache_hits: cacheHits,
					},
					notes,
				};

				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error({ error }, "Blame walker failed");
				const hint = message.includes("403")
					? " Hint: ensure your token has both file_content:read and file_versions:read scopes."
					: message.includes("404")
						? " Hint: a node or version may not exist. Verify node_id and start_version."
						: "";
				return errorResponse("blame_node_failed", message + hint);
			}
		},
	);

	// Build the candidate version list for binary search. Returns versions
	// strictly OLDER than start_version (so the search range doesn't include
	// the version we already confirmed at), capped at lookback. Newest-first.
	const collectCandidateVersions = async (
		api: FigmaAPI,
		fileKey: string,
		startVer: string,
		lookback: number,
		includeAutosaves: boolean,
	): Promise<{
		versions: Array<{
			id: string;
			label: string;
			created_at: string;
			user: { id: string; handle: string; img_url: string };
		}>;
		apiCalls: number;
		cacheHits: number;
	}> => {
		const collected: Array<any> = [];
		let cursor: string | undefined;
		let apiCalls = 0;
		const cacheHits = 0; // version-list pagination is not snapshot-cached
		// Once we hit start_version's id in the list, switch to "collecting older" mode
		let foundStart = isCurrentSentinel(startVer);
		const MAX_PAGES = 10; // 10 × 50 = 500 versions hard cap on scan
		for (let page = 0; page < MAX_PAGES && collected.length < lookback; page++) {
			let response: any;
			try {
				response = await api.getFileVersions(fileKey, {
					page_size: 50,
					after: cursor,
				});
				apiCalls++;
			} catch (e) {
				logger.warn({ err: e }, "Version list fetch failed during blame walk");
				break;
			}
			const versions = response?.versions || [];
			if (versions.length === 0) break;
			for (const v of versions) {
				if (!foundStart) {
					if (v.id === startVer) foundStart = true;
					continue;
				}
				const isLabeled = v.label && v.label !== "";
				if (!includeAutosaves && !isLabeled) continue;
				collected.push(v);
				if (collected.length >= lookback) break;
			}
			if (collected.length >= lookback) break;
			if (!response?.pagination?.next_page) break;
			const last = versions[versions.length - 1];
			if (!last?.id || last.id === cursor) break;
			cursor = last.id;
		}
		return { versions: collected, apiCalls, cacheHits };
	};
}

// Returns true if the target is present in the given node tree.
function targetExists(
	node: any,
	target: { target_component_property?: string; target_child_node_id?: string },
): boolean {
	if (target.target_component_property) {
		return !!node?.componentPropertyDefinitions?.[target.target_component_property];
	}
	if (target.target_child_node_id) {
		return findChildById(node, target.target_child_node_id);
	}
	return false;
}

function findChildById(node: any, targetId: string): boolean {
	if (!node) return false;
	if (node.id === targetId) return true;
	if (Array.isArray(node.children)) {
		for (const c of node.children) {
			if (findChildById(c, targetId)) return true;
		}
	}
	return false;
}

function buildHeadMeta(fileData: any): VersionAuthorMeta {
	return {
		version_id: fileData?.version ?? "current",
		label: null,
		created_at: fileData?.lastModified ?? null,
		user_handle: null,
		is_head: true,
	};
}

// ============================================================================
// Helpers
// ============================================================================

function errorResponse(code: string, message: string) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({ error: code, message }),
			},
		],
		isError: true,
	};
}

function extractFileMeta(fileData: any, requestedVersionId: string) {
	return {
		version_id: requestedVersionId,
		resolved_version_id: fileData?.version ?? null,
		last_modified: fileData?.lastModified ?? null,
		thumbnail_url: fileData?.thumbnailUrl ?? null,
	};
}
