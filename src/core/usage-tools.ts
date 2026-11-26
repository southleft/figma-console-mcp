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

export function buildUsageCode(kind: "style" | "variable" | "component", id: string, sample: number, maxNodes: number, budgetMs = 100000): string {
	return `const KIND = ${JSON.stringify(kind)}, ID = ${JSON.stringify(id)}, SAMPLE = ${sample}, MAX_NODES = ${maxNodes}, BUDGET_MS = ${budgetMs};
function pageOf(n) { let p = n; while (p && p.type !== "PAGE") p = p.parent; return p ? p.name : null; }
const hits = []; let total = 0; let orphaned = 0; let scanned = 0; let truncated = false; let aliasedBy = null;
const DEADLINE = Date.now() + BUDGET_MS;
// Nodes whose ancestry never reaches a page aren't in the document (e.g. frames a
// plugin created and never placed). Nobody sees them, so they're counted apart.
const seen = new Set();
function add(node, field) {
  // A paint binding appears both in node.boundVariables.fills/strokes and on the paint itself: count once.
  const key = node.id + "|" + field;
  if (seen.has(key)) return;
  seen.add(key);
  const page = pageOf(node);
  if (!page) { orphaned++; return; }
  total++;
  if (hits.length < SAMPLE) hits.push({ nodeId: node.id, name: node.name, type: node.type, page, field });
}
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
  // Variables that alias the target, directly or through a chain (primitive → semantic → …).
  // Layers bound to those use the target too.
  const all = await figma.variables.getLocalVariablesAsync();
  const via = new Map([[ID, null]]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const v of all) {
      if (via.has(v.id)) continue;
      for (const val of Object.values(v.valuesByMode || {})) {
        const ref = val && val.type === "VARIABLE_ALIAS" ? val.id : val && val.color && val.color.type === "VARIABLE_ALIAS" ? val.color.id : null;
        if (ref && via.has(ref)) { via.set(v.id, v.name); grew = true; break; }
      }
    }
  }
  aliasedBy = [...via.entries()].filter(([id]) => id !== ID).map(([id, name]) => ({ id, name }));
  const label = (id, field) => (id === ID ? field : field + " (via " + via.get(id) + ")");
  const hit = (v) => {
    if (!v) return null;
    if (v.id && via.has(v.id)) return v.id;
    if (Array.isArray(v)) { for (const x of v) if (x && via.has(x.id)) return x.id; }
    return null;
  };
  await figma.loadAllPagesAsync();
  outer: for (const page of figma.root.children) {
    const stack = [...page.children];
    while (stack.length) {
      const n = stack.pop();
      if (++scanned > MAX_NODES || Date.now() > DEADLINE) { truncated = true; break outer; }
      const bv = n.boundVariables || {};
      for (const [field, v] of Object.entries(bv)) {
        if (field === "componentProperties" && v && typeof v === "object" && !Array.isArray(v) && !v.id) {
          for (const [prop, alias] of Object.entries(v)) { const id = hit(alias); if (id) add(n, label(id, "componentProperties." + prop)); }
          continue;
        }
        const id = hit(v); if (id) add(n, label(id, field));
      }
      for (const prop of ["fills", "strokes"]) {
        const paints = n[prop];
        if (Array.isArray(paints)) for (const p of paints) { const id = p && p.boundVariables && hit(p.boundVariables.color); if (id) add(n, label(id, prop)); }
      }
      if ("children" in n) for (const c of n.children) stack.push(c);
    }
  }
}
const pages = {};
for (const h of hits) pages[h.page] = (pages[h.page] || 0) + 1;
return { target: { id: target.id, name: target.name, kind: KIND }, total, sample: hits, sampledByPage: pages, ...(orphaned ? { orphaned, orphanedNote: "Also used by " + orphaned + " node(s) that aren't on any page (left outside the document, e.g. by a plugin); not counted in total." } : {}), ...(KIND === "variable" ? { nodesScanned: scanned, truncated, aliasedBy, ...(aliasedBy && aliasedBy.length ? { aliasNote: aliasedBy.length + " variable(s) alias this one; layers bound to them are counted (field says 'via …'). Renaming or deleting this variable breaks those aliases too." } : {}) } : {}) };`;
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
				// The plugin loop stops itself before the outer timeout, so partial counts come back instead of an error.
				const res = await connector.executeCodeViaUI(buildUsageCode(kind, id, sample, maxNodes, 100000), 120000, fileKey);
				const raw = res && typeof res === "object" && "result" in res ? res.result : res;
				if (!raw || raw.error) return fail(raw?.error ?? res?.error ?? "The plugin didn't return a result.");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								...raw,
								...(raw.truncated ? { warning: `Stopped after ${raw.nodesScanned} nodes (node or time limit); the total is a lower bound. Raise maxNodes or scan a smaller file.` } : {}),
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
