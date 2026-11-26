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
export function summarizeAnalytics(asset: string, metric: string, groupBy: string, rows: any[], top: number) {
	const nameKey = `${asset}_name`;
	const idKey = groupBy === "team" ? "team_name" : groupBy === "file" ? "file_name" : `${asset}_key`;
	if (metric === "usages") {
		const usageKeys = ["num_instances", "usages", "num_layers", "num_files_using", "num_teams_using"];
		const primary = usageKeys.find((k) => rows.some((r) => typeof r?.[k] === "number")) ?? "num_instances";
		const ranked = [...rows].sort((a, b) => NUM(b, primary) - NUM(a, primary));
		const unused = groupBy === asset ? rows.filter((r) => NUM(r, primary) === 0).map((r) => r[nameKey] ?? r[idKey]) : [];
		return {
			rows: rows.length,
			rankedBy: primary,
			total: rows.reduce((s, r) => s + NUM(r, primary), 0),
			top: ranked.slice(0, top),
			...(unused.length ? { unused: unused.slice(0, 50), unusedCount: unused.length } : {}),
		};
	}
	// actions: weekly rows → totals per asset/team
	const byKey = new Map<string, { name: string; insertions: number; detachments: number; weeks: number }>();
	for (const r of rows) {
		const k = String(r[idKey] ?? r[nameKey] ?? "?");
		const e = byKey.get(k) ?? { name: r[nameKey] ?? r.team_name ?? k, insertions: 0, detachments: 0, weeks: 0 };
		e.insertions += NUM(r, "insertions");
		e.detachments += NUM(r, "detachments");
		e.weeks++;
		byKey.set(k, e);
	}
	const list = [...byKey.entries()].map(([key, v]) => ({ key, ...v, detachRate: v.insertions ? +(v.detachments / v.insertions).toFixed(3) : null }));
	return {
		rows: rows.length,
		totals: { insertions: list.reduce((s, x) => s + x.insertions, 0), detachments: list.reduce((s, x) => s + x.detachments, 0) },
		mostInserted: [...list].sort((a, b) => b.insertions - a.insertions).slice(0, top),
		...(asset === "component" ? { mostDetached: [...list].filter((x) => x.detachments > 0).sort((a, b) => b.detachments - a.detachments).slice(0, top) } : {}),
	};
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
				const body = args.all
					? { rows }
					: summarizeAnalytics(args.asset, args.metric, groupBy, rows, args.top ?? 25);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ success: true, fileKey, asset: args.asset, metric: args.metric, groupBy, ...(cursor ? { truncated: true } : {}), ...body }),
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
				if (/40[34]/.test(msg)) {
					return fail(msg, { hint: "Library analytics needs an Enterprise plan and a published library file you can access." });
				}
				return fail(msg);
			}
		},
	);
}
