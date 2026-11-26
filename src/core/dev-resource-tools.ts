/**
 * figma_manage_dev_resources: the links on a component that point at its code,
 * Storybook page or docs (shown in Dev Mode). List, add, edit and delete them in
 * bulk — e.g. after figma_check_library_parity pairs Figma components with code.
 *
 * Plugin API: node.getDevResourcesAsync / addDevResourceAsync /
 * editDevResourceAsync / deleteDevResourceAsync. These can hang while the
 * file's window isn't focused, so every call has a time budget and the run
 * reports what timed out instead of blocking.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { confirmStep, fingerprint, notConfirmedResult } from "./confirm.js";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "dev-resource-tools" });

const MAX_ITEMS = 200;

export interface DevResourceItem {
	nodeId: string;
	url: string;
	name?: string;
	newUrl?: string;
}

const isHttpUrl = (u: string) => {
	try {
		const p = new URL(u);
		return p.protocol === "https:" || p.protocol === "http:";
	} catch {
		return false;
	}
};

/** Plugin-side script. Exported for tests. */
export function buildDevResourceCode(action: "list" | "add" | "edit" | "delete", args: { nodeIds?: string[]; items?: DevResourceItem[] }): string {
	return `const ACTION = ${JSON.stringify(action)};
const NODE_IDS = ${JSON.stringify(args.nodeIds ?? [])};
const ITEMS = ${JSON.stringify(args.items ?? [])};
const BUDGET = 4000;
let timedOut = 0;
function within(p) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), BUDGET))]);
}
async function list(node) {
  try { return (await within(node.getDevResourcesAsync())).map(r => ({ name: r.name, url: r.url })); }
  catch (e) { if (String(e).includes("timeout")) timedOut++; return null; }
}
const results = [];
if (ACTION === "list") {
  let nodes = [];
  if (NODE_IDS.length) { for (const id of NODE_IDS) nodes.push(await figma.getNodeByIdAsync(id)); }
  else nodes = figma.currentPage.selection.slice();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n) { results.push({ nodeId: NODE_IDS[i], error: "not found" }); continue; }
    const r = await list(n);
    results.push(r === null ? { nodeId: n.id, name: n.name, error: "couldn't read (timed out or unsupported)" } : { nodeId: n.id, name: n.name, resources: r });
    if (timedOut >= 2) { results.push({ note: "Stopped: Figma isn't answering dev-resource requests. Focus the file's window in Figma Desktop and retry." }); break; }
  }
  return { results, timedOut };
}
for (const it of ITEMS) {
  const n = await figma.getNodeByIdAsync(it.nodeId);
  if (!n) { results.push({ ...it, ok: false, error: "node not found" }); continue; }
  try {
    if (ACTION === "add") {
      const existing = await list(n);
      if (existing && existing.some(r => r.url === it.url)) { results.push({ ...it, ok: true, skipped: "already linked" }); continue; }
      await within(n.addDevResourceAsync(it.url, it.name));
    } else if (ACTION === "edit") {
      const patch = {};
      if (it.name !== undefined) patch.name = it.name;
      if (it.newUrl !== undefined) patch.url = it.newUrl;
      await within(n.editDevResourceAsync(it.url, patch));
    } else if (ACTION === "delete") {
      await within(n.deleteDevResourceAsync(it.url));
    }
    results.push({ ...it, ok: true, node: n.name });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (msg.includes("timeout")) timedOut++;
    results.push({ ...it, ok: false, error: msg.slice(0, 200) });
    if (timedOut >= 2) { results.push({ note: "Stopped: Figma isn't answering dev-resource requests. Focus the file's window in Figma Desktop and retry." }); break; }
  }
}
return { results, timedOut };`;
}

export function registerDevResourceTools(server: McpServer, getDesktopConnector: () => Promise<any>): void {
	server.registerTool(
		"figma_manage_dev_resources",
		{
			description:
				"List, add, edit or delete the dev resources on components: the links to their code, Storybook or docs that Dev Mode shows. Works in bulk (e.g. link every component figma_check_library_parity paired with code). add skips links that already exist; delete asks for confirmation.",
			inputSchema: z.object({
				action: z.enum(["list", "add", "edit", "delete"]),
				nodeIds: z.array(z.string()).max(MAX_ITEMS).optional().describe("list: nodes to read (default: the selection)."),
				items: z
					.array(
						z.object({
							nodeId: z.string(),
							url: z.string().describe("The link (for edit/delete: its current URL)."),
							name: z.string().optional().describe("Label shown in Dev Mode, e.g. 'Storybook'."),
							newUrl: z.string().optional().describe("edit: the replacement URL."),
						}),
					)
					.max(MAX_ITEMS)
					.optional()
					.describe("add / edit / delete: one entry per link."),
				fileKey: z.string().optional().describe("Local Mode: run in this open file without changing the active file."),
			}),
		},
		async (args, ctx) => {
			const fail = (error: string) => ({ content: [{ type: "text" as const, text: JSON.stringify({ error }) }], isError: true });
			try {
				const items = args.items ?? [];
				if (args.action !== "list") {
					if (items.length === 0) return fail(`${args.action} needs items.`);
					const bad = items.filter((i) => !isHttpUrl(i.url) || (i.newUrl !== undefined && !isHttpUrl(i.newUrl)));
					if (bad.length) return fail(`Not http(s) URLs: ${bad.map((b) => b.newUrl ?? b.url).join(", ")}. Nothing was changed.`);
					if (args.action === "edit" && items.some((i) => i.name === undefined && i.newUrl === undefined)) {
						return fail("edit needs name and/or newUrl for every item.");
					}
				}
				if (args.action === "delete") {
					const step = confirmStep(server, ctx, `confirm_delete_dev_resources_${fingerprint(args.fileKey, ...items.map((i) => `${i.nodeId}|${i.url}`))}`, {
						message: `Remove ${items.length} dev resource link${items.length === 1 ? "" : "s"} from ${new Set(items.map((i) => i.nodeId)).size} node(s)? Developers lose these links in Dev Mode.`,
						fields: { confirm: { type: "boolean", title: "Remove the links", default: false } },
						required: ["confirm"],
					});
					if (step.status === "ask") return step.result as any;
					if (step.status === "declined" || step.status === "cancelled") return notConfirmedResult("removing dev resources", step);
					if (step.status === "accepted" && step.content.confirm !== true) return notConfirmedResult("removing dev resources", { status: "declined" });
				}
				const connector = await getDesktopConnector();
				const res = await connector.executeCodeViaUI(
					buildDevResourceCode(args.action, { nodeIds: args.nodeIds, items }),
					Math.min(300000, 15000 + items.length * 4500 + (args.nodeIds?.length ?? 0) * 4500),
					args.fileKey,
				);
				const raw = res && typeof res === "object" && "result" in res ? res.result : res;
				if (!raw || raw.error) return fail(raw?.error ?? res?.error ?? "The plugin didn't return a result.");
				const results: any[] = raw.results ?? [];
				const failed = results.filter((r) => r.ok === false);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: failed.length === 0 && !raw.timedOut,
								action: args.action,
								...(args.action === "list" ? { nodes: results } : { done: results.filter((r) => r.ok).length, failed, results }),
								...(raw.timedOut ? { warning: "Some requests timed out. Figma answers dev-resource calls only while the file's window is focused in Figma Desktop." } : {}),
							}),
						},
					],
					...(failed.length ? { isError: failed.length === results.length } : {}),
				};
			} catch (err) {
				logger.error({ err }, "figma_manage_dev_resources failed");
				return fail(err instanceof Error ? err.message : String(err));
			}
		},
	);
}
