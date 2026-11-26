/**
 * figma_find_usages — impact analysis before changing or retiring a design-system
 * asset: where a style, variable or component is used in the file.
 *
 *   style     → style.getStyleConsumersAsync() (Plugin API)
 *   component → component.getInstancesAsync() (all variants for a set)
 *   variable  → walk loaded pages for boundVariables / paint bindings
 *               (no consumers API exists for variables), capped
 *
 * Returns counts plus a capped sample of nodes (id, name, page, field), so the
 * result stays small on big files.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "usage-tools" });

export function buildUsageCode(kind: "style" | "variable" | "component", id: string, sample: number, maxNodes: number): string {
	return `const KIND = ${JSON.stringify(kind)}, ID = ${JSON.stringify(id)}, SAMPLE = ${sample}, MAX_NODES = ${maxNodes};
function pageOf(n) { let p = n; while (p && p.type !== "PAGE") p = p.parent; return p ? p.name : "(not on a page — inside another component or hidden)"; }
const hits = []; let total = 0; let scanned = 0; let truncated = false;
function add(node, field) { total++; if (hits.length < SAMPLE) hits.push({ nodeId: node.id, name: node.name, type: node.type, page: pageOf(node), field }); }
let target = null;
if (KIND === "style") {
  target = await figma.getStyleByIdAsync(ID);
  if (!target) return { error: "No style with id " + ID + " in this file." };
  const consumers = await target.getStyleConsumersAsync();
  for (const c of consumers) add(c.node, (c.fields || []).join(","));
} else if (KIND === "component") {
  target = await figma.getNodeByIdAsync(ID);
  if (!target || (target.type !== "COMPONENT" && target.type !== "COMPONENT_SET")) return { error: "No component or component set with id " + ID + "." };
  const comps = target.type === "COMPONENT_SET" ? target.children.filter(c => c.type === "COMPONENT") : [target];
  for (const c of comps) for (const inst of await c.getInstancesAsync()) add(inst, target.type === "COMPONENT_SET" ? c.name : "instance");
} else {
  target = await figma.variables.getVariableByIdAsync(ID);
  if (!target) return { error: "No variable with id " + ID + " in this file." };
  await figma.loadAllPagesAsync();
  const matches = (v) => v && (v.id === ID || (Array.isArray(v) && v.some(x => x && x.id === ID)));
  outer: for (const page of figma.root.children) {
    const stack = [...page.children];
    while (stack.length) {
      const n = stack.pop();
      if (++scanned > MAX_NODES) { truncated = true; break outer; }
      const bv = n.boundVariables || {};
      for (const [field, v] of Object.entries(bv)) if (matches(v)) add(n, field);
      for (const prop of ["fills", "strokes"]) {
        const paints = n[prop];
        if (Array.isArray(paints) && paints.some(p => p.boundVariables && p.boundVariables.color && p.boundVariables.color.id === ID)) add(n, prop);
      }
      if ("children" in n) for (const c of n.children) stack.push(c);
    }
  }
}
const pages = {};
for (const h of hits) pages[h.page] = (pages[h.page] || 0) + 1;
return { target: { id: target.id, name: target.name, kind: KIND }, total, sample: hits, sampledByPage: pages, ...(KIND === "variable" ? { nodesScanned: scanned, truncated } : {}) };`;
}

export function registerUsageTools(server: McpServer, getDesktopConnector: () => Promise<any>): void {
	server.registerTool(
		"figma_find_usages",
		{
			description:
				"Where is a style, variable or component used in this file? Use before renaming, changing or retiring a design-system asset. Returns the total and a sample of the nodes (with page and bound field).",
			inputSchema: z.object({
				kind: z.enum(["style", "variable", "component"]),
				id: z.string().describe("Style id, variable id (VariableID:…), or component / component set node id."),
				sample: z.number().int().min(0).max(200).optional().describe("Nodes to list (default 25)."),
				maxNodes: z.number().int().min(1000).max(500000).optional().describe("variable: nodes to scan before stopping (default 50000)."),
				fileKey: z.string().optional().describe("Local Mode: run in this open file without changing the active file."),
			}),
		},
		async ({ kind, id, sample = 25, maxNodes = 50000, fileKey }) => {
			const fail = (error: string) => ({ content: [{ type: "text" as const, text: JSON.stringify({ error }) }], isError: true });
			try {
				const connector = await getDesktopConnector();
				const res = await connector.executeCodeViaUI(buildUsageCode(kind, id, sample, maxNodes), 120000, fileKey);
				const raw = res && typeof res === "object" && "result" in res ? res.result : res;
				if (!raw || raw.error) return fail(raw?.error ?? res?.error ?? "The plugin didn't return a result.");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								...raw,
								...(raw.truncated ? { warning: `Stopped after ${raw.nodesScanned} nodes; the total is a lower bound. Raise maxNodes to scan further.` } : {}),
							}),
						},
					],
				};
			} catch (err) {
				logger.error({ err }, "figma_find_usages failed");
				return fail(err instanceof Error ? err.message : String(err));
			}
		},
	);
}
