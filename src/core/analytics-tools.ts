/**
 * figma_get_library_analytics — how a published library is actually used:
 * instances/usages per component, style or variable (usages), and weekly
 * insertions and detachments (actions). Enterprise only; the token needs the
 * library_analytics:read scope.
 *
 * Results are summarized (totals + top rows) so a large library doesn't flood
 * the context; pass all: true for every row.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { extractFileKey } from "./figma-api.js";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "analytics-tools" });

const NUM = (r: any, ...keys: string[]) => keys.reduce((sum, k) => sum + (typeof r?.[k] === "number" ? r[k] : 0), 0);

/** Group rows by asset (actions come per week) and rank them. Exported for tests. */
/** A library's published asset: key, name, and its group (component set, or variable collection). */
export interface PublishedAsset {
	key: string;
	name: string;
	setName?: string;
}

/** "Button / Variant=Primary" for a variant, the plain name otherwise. */
const displayName = (name: string | undefined, setName: string | undefined) => (setName ? `${setName} / ${name}` : name);

/**
 * Group rows by asset (actions come per week) and rank them. Exported for tests.
 *
 * Figma returns usage rows only for assets that are in use, so unused assets
 * can only be found by comparing against what the library publishes: pass
 * `published` for that (and for component set names, which rows lack).
 */
export function summarizeAnalytics(asset: string, metric: string, groupBy: string, rows: any[], top: number, published?: PublishedAsset[]) {
	const nameKey = `${asset}_name`;
	const keyKey = `${asset}_key`;
	const idKey = groupBy === "team" ? "team_name" : groupBy === "file" ? "file_name" : keyKey;
	const byKey = new Map((published ?? []).map((p) => [p.key, p]));
	// Rows name a variant without its set ("State=Default" in many sets): add it.
	if (asset === "component" && byKey.size) {
		rows = rows.map((r) => {
			const setName = byKey.get(r?.[keyKey])?.setName;
			return setName ? { ...r, component_set_name: setName, name: displayName(r[nameKey], setName) } : { ...r, name: r[nameKey] };
		});
	}
	if (metric === "usages") {
		const usageKeys = ["num_instances", "usages", "num_layers", "num_files_using", "num_teams_using"];
		const primary = usageKeys.find((k) => rows.some((r) => typeof r?.[k] === "number")) ?? "num_instances";
		const ranked = [...rows].sort((a, b) => NUM(b, primary) - NUM(a, primary));
		// Keyed by asset: names repeat (variants, same-named variables in two collections)
		const unusedByKey = new Map<string, string>();
		if (groupBy === asset) {
			for (const r of rows) if (NUM(r, primary) === 0) unusedByKey.set(String(r[keyKey] ?? r[nameKey]), r.name ?? r[nameKey] ?? r[idKey]);
			if (published) {
				const used = new Set(rows.filter((r) => NUM(r, primary) > 0).map((r) => r[keyKey]));
				for (const p of published) if (!used.has(p.key)) unusedByKey.set(p.key, displayName(p.name, p.setName) as string);
			}
		}
		const unused = [...unusedByKey.values()];
		return {
			rows: rows.length,
			...(rows.length ? { rankedBy: primary } : {}),
			total: rows.reduce((s, r) => s + NUM(r, primary), 0),
			top: ranked.slice(0, top),
			...(published && groupBy === asset ? { published: published.length } : {}),
			...(unused.length ? { unused: unused.slice(0, 50), unusedCount: unused.length } : {}),
		};
	}
	// actions: weekly rows → totals per asset/team
	const totals = new Map<string, { name: string; insertions: number; detachments: number; weeks: number }>();
	for (const r of rows) {
		const k = String(r[idKey] ?? r[nameKey] ?? "?");
		const e = totals.get(k) ?? { name: r.name ?? r[nameKey] ?? r.team_name ?? k, insertions: 0, detachments: 0, weeks: 0 };
		e.insertions += NUM(r, "insertions");
		e.detachments += NUM(r, "detachments");
		e.weeks++;
		totals.set(k, e);
	}
	const list = [...totals.entries()].map(([key, v]) => ({ key, ...v, detachRate: v.insertions ? +(v.detachments / v.insertions).toFixed(3) : null }));
	return {
		rows: rows.length,
		totals: { insertions: list.reduce((s, x) => s + x.insertions, 0), detachments: list.reduce((s, x) => s + x.detachments, 0) },
		mostInserted: [...list].sort((a, b) => b.insertions - a.insertions).slice(0, top),
		...(asset === "component" ? { mostDetached: [...list].filter((x) => x.detachments > 0).sort((a, b) => b.detachments - a.detachments).slice(0, top) } : {}),
	};
}

/** What the library publishes, for unused assets and set names. Throws if unreadable. */
async function fetchPublished(api: any, fileKey: string, asset: string): Promise<PublishedAsset[]> {
	if (asset === "component") {
		const res = await api.getComponents(fileKey);
		return (res?.meta?.components ?? []).map((c: any) => ({ key: c.key, name: c.name, setName: c.containing_frame?.containingComponentSet?.name }));
	}
	if (asset === "style") {
		const res = await api.getStyles(fileKey);
		return (res?.meta?.styles ?? []).map((st: any) => ({ key: st.key, name: st.name }));
	}
	const res = await api.getPublishedVariables(fileKey);
	const collections: Record<string, any> = res?.variableCollections ?? {};
	return Object.values(res?.variables ?? {}).map((v: any) => ({ key: v.key, name: v.name, setName: collections[v.variableCollectionId]?.name }));
}

export function registerAnalyticsTools(
	server: McpServer,
	deps: { getFigmaAPI: () => Promise<any>; getCurrentUrl: () => string | null },
): void {
	server.registerTool(
		"figma_get_library_analytics",
		{
			description:
				"How a published library is used across the organization: instances per component/style/variable and which are unused (usages), or insertions and detachments over time — high detach rates point at components that don't meet teams' needs (actions). Enterprise only; the token needs library_analytics:read. Returns totals and top rows.",
			inputSchema: z.object({
				asset: z.enum(["component", "style", "variable"]),
				metric: z.enum(["usages", "actions"]),
				groupBy: z.enum(["asset", "team", "file"]).optional().describe("asset (default), team (actions) or file (usages)."),
				startDate: z.string().optional().describe("actions: ISO date, default one year ago."),
				endDate: z.string().optional().describe("actions: ISO date, default today."),
				fileKey: z.string().optional().describe("The library file (default: the active file)."),
				top: z.number().int().min(1).max(200).optional().describe("Rows to return per ranking (default 25)."),
				all: z.boolean().optional().describe("Return every row instead of a summary."),
			}),
		},
		async (args) => {
			const fail = (error: string, extra: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: JSON.stringify({ error, ...extra }) }], isError: true });
			try {
				const fileKey = args.fileKey ?? extractFileKey(deps.getCurrentUrl() ?? "") ?? undefined;
				if (!fileKey) return fail("No library file: pass fileKey or open the library file with the Desktop Bridge.");
				const g = args.groupBy ?? "asset";
				if (g === "team" && args.metric !== "actions") return fail("groupBy team is only available for actions.");
				if (g === "file" && args.metric !== "usages") return fail("groupBy file is only available for usages.");
				const groupBy = g === "asset" ? args.asset : g;
				const api = await deps.getFigmaAPI();
				// Unused assets and component set names need the published list. Only a
				// per-asset grouping can use it (team/file rows carry no asset key), and
				// it's fetched alongside the paging. Best effort: the analytics stand on
				// their own without it.
				const wantsPublished = !args.all && groupBy === args.asset;
				const publishedP: Promise<{ ok: PublishedAsset[] } | { err: unknown }> | null = wantsPublished
					? fetchPublished(api, fileKey, args.asset).then((ok) => ({ ok }), (err) => ({ err }))
					: null;
				const rows: any[] = [];
				let cursor: string | undefined;
				let pages = 0;
				do {
					const page = await api.getLibraryAnalytics(fileKey, args.asset, args.metric, {
						group_by: groupBy,
						start_date: args.metric === "actions" ? args.startDate : undefined,
						end_date: args.metric === "actions" ? args.endDate : undefined,
						cursor,
					});
					rows.push(...(page?.rows ?? []));
					cursor = page?.next_page ? page.cursor : undefined;
					pages++;
				} while (cursor && pages < 50);
				const notes: string[] = [];
				const wantsUnused = args.metric === "usages" && groupBy === args.asset;
				let published: PublishedAsset[] | undefined;
				const fetched = publishedP ? await publishedP : null;
				if (fetched && "ok" in fetched) published = fetched.ok;
				else if (fetched && wantsUnused) {
					const e = fetched.err;
					notes.push(`Unused ${args.asset}s couldn't be checked: reading the library's published ${args.asset}s failed (${e instanceof Error ? e.message : String(e)}). Figma only reports assets that are in use.`);
				}
				if (rows.length === 0) {
					if (published && published.length === 0) notes.push(`This file publishes no ${args.asset}s, so there is no ${args.asset} usage to report. Publish its ${args.asset}s to the library first.`);
					// No actions only means nothing was inserted or detached in the range;
					// existing instances can still be in use (check metric "usages").
					else if (args.metric === "actions") notes.push(`No insertions or detachments recorded in this date range${published ? ` for this library's ${published.length} published ${args.asset}s` : ""}. Existing uses don't count here: metric "usages" shows those.`);
					else if (published) notes.push(`No usage recorded for this library's ${published.length} published ${args.asset}s: nothing uses them yet.`);
					else notes.push(`No usage recorded: nothing uses this library's ${args.asset}s yet, or the file isn't a published library.`);
				}
				const body: any = args.all
					? { rows }
					: summarizeAnalytics(args.asset, args.metric, groupBy, rows, args.top ?? 25, published);
				// Paging stopped early: assets on unseen pages would wrongly look unused.
				if (cursor && body.unused) {
					delete body.unused;
					delete body.unusedCount;
					notes.push(`Unused ${args.asset}s are not listed: the results stop after the first 50 pages, and assets on later pages would wrongly look unused.`);
				}
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ success: true, fileKey, asset: args.asset, metric: args.metric, groupBy, ...(cursor ? { truncated: true } : {}), ...body, ...(notes.length ? { notes } : {}) }),
						},
					],
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logger.error({ err: msg }, "figma_get_library_analytics failed");
				if (/library_analytics|Invalid scope/i.test(msg)) {
					return fail("The Figma token doesn't have the library_analytics:read scope.", {
						fix: "Create a personal access token with 'Library analytics: read' ticked (Figma → Settings → Security → Personal access tokens), or use an OAuth app granted that scope. Library analytics is available on Enterprise plans.",
					});
				}
				if (/\(404\)/.test(msg)) {
					return fail(msg, { hint: "Figma can't find this file for this token: the token's account can't open it. Check the fileKey and which account the token belongs to." });
				}
				if (/\(403\)/.test(msg)) {
					return fail(msg, { hint: "Library analytics needs an Enterprise plan and access to the library file." });
				}
				return fail(msg);
			}
		},
	);
}
