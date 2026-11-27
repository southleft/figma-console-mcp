#!/usr/bin/env node
/**
 * Calibration for the judges ("judge the judges"). Copies a generated
 * composition and plants ONE known defect per copy, so each judge's own
 * precision/recall can be measured on labelled cases:
 *
 *   clean        unchanged copy                      → judges should repeat their verdicts
 *   detach       an instance flattened to plain layers → that item: hand-built
 *   false-gap    an instance replaced by a GAP note   → that item: FALSE-GAP
 *   drop-gap     a gap note deleted                   → that item: silent omission
 *   misplace-gap a gap note moved to the far corner   → that note: placed = low
 *
 *   node scripts/evals/judges/mutate.mjs --file <fileKey> --root <nodeId> --case <case.json> --out <labels.json> [--item <id>] [--gap "<GAP: name>"]
 * Pick --item / --gap among things every judge rated correct on the original, so a defect is unambiguous.
 * Copies go beside the original on the same (temporary) page.
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const arg = (k) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : undefined;
};
const [fileKey, rootId, casePath, out] = [arg("file"), arg("root"), arg("case"), arg("out")];
const caseFile = JSON.parse(readFileSync(casePath, "utf8"));
// Files this script must never write to come from the local systems config (see ds-systems.example.json).
const cfgPath = arg("config") ?? ".notes/evals/ds-systems.json";
const OFF_LIMITS = new Set(existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")).offLimitsFileKeys ?? [] : []);
if (OFF_LIMITS.has(fileKey)) throw new Error("off-limits file");

const client = new Client({ name: "judge-calibration", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/local.js"], env: { ...process.env, LOG_LEVEL: "error" }, stderr: "ignore" }));
const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args }, undefined, { timeout: 240000 })).content?.[0]?.text ?? "{}");
for (let i = 0; i < 40; i++) {
	const s = await call("figma_list_open_files");
	if ((s.files ?? []).some((f) => f.fileKey === fileKey)) break;
	await new Promise((r) => setTimeout(r, 2000));
}

// Items with their aliases, so a planted defect can be tied to the item it affects.
const items = [];
for (const el of caseFile.elements) {
	items.push({ id: el.id, describe: el.describe ?? el.id, aliases: el.aliases });
	for (const p of el.parts ?? []) items.push({ id: `${el.id} → ${p.id}`, describe: p.describe, aliases: p.aliases, part: true });
}

const res = await call("figma_execute", {
	fileKey,
	timeout: 120000,
	code: `const root = await figma.getNodeByIdAsync(${JSON.stringify(rootId)});
if (!root) return { error: "root not found" };
const ITEMS = ${JSON.stringify(items.filter((i) => !i.part && (!arg("item") || i.id === arg("item"))))};
const GAP_NAME = ${JSON.stringify(arg("gap") ?? null)};
const words = (s) => " " + String(s).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
const hits = (s, aliases) => aliases.some(a => words(s).includes(" " + a + " ") || words(s).includes(" " + a + "s "));
async function compName(n) { try { const mc = await n.getMainComponentAsync(); return mc ? (mc.parent && mc.parent.type === "COMPONENT_SET" ? mc.parent.name : mc.name) : ""; } catch (e) { return ""; } }
async function topInstances(r) {
  const out = []; const q = [...r.children];
  while (q.length) { const n = q.shift(); if (n.type === "INSTANCE") { out.push(n); continue; } if (n.name && n.name.toUpperCase().startsWith("GAP:")) continue; if ("children" in n) q.push(...n.children); }
  return out;
}
// Pick an item built with a component (largest matching instance), and an item with a gap note.
const inst = await topInstances(root);
let target = null;
for (const it of ITEMS) { for (const n of inst) { const c = await compName(n); if (hits(c, it.aliases) && (!target || n.width * n.height > target.area)) target = { item: it.id, index: inst.indexOf(n), comp: c, area: n.width * n.height }; } if (target) break; }
const gaps = root.findAll(n => n.name && n.name.toUpperCase().startsWith("GAP:") && !(n.parent && n.parent.name && n.parent.name.toUpperCase().startsWith("GAP:")) && (!GAP_NAME || n.name === GAP_NAME));
const ALL = ${JSON.stringify(items.filter((i) => !i.part))};
const gapTarget = gaps.length ? { name: gaps[0].name, item: (ALL.find(it => hits(gaps[0].name, it.aliases)) || {}).id || null, index: 0 } : null;

const labels = [];
let x = root.x + root.width + 200;
async function copy(kind) { const c = root.clone(); c.name = root.name + " · calib " + kind; c.x = x; c.y = root.y; x += root.width + 200; root.parent.appendChild(c); return c; }

labels.push({ kind: "clean", root: (await copy("clean")).id });
if (target) {
  const c = await copy("detach"); const n = (await topInstances(c))[target.index]; const comp = await compName(n); n.detachInstance();
  labels.push({ kind: "detach", root: c.id, item: target.item, component: comp, expect: ["HAND-BUILT-INSTEAD-OF-COMPONENT", "INVENTED"] });
  const c2 = await copy("false-gap"); const n2 = (await topInstances(c2))[target.index];
  const g = figma.createFrame(); g.name = "GAP: " + target.item; g.resize(Math.max(40, n2.width), Math.max(24, n2.height)); g.fills = [];
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  const t = figma.createText(); t.fontName = { family: "Inter", style: "Regular" }; t.characters = target.item + ": the design system has no component for this. This is where it would go."; g.appendChild(t);
  const parent = n2.parent; const idx = parent.children.indexOf(n2); parent.insertChild(idx, g);
  try { g.layoutSizingHorizontal = n2.layoutSizingHorizontal; } catch (e) {}
  n2.remove();
  labels.push({ kind: "false-gap", root: c2.id, item: target.item, component: comp, expect: ["FALSE-GAP"] });
}
if (gapTarget) {
  const c = await copy("drop-gap"); const g = c.findAll(n => n.name === gapTarget.name)[0]; g.remove();
  labels.push({ kind: "drop-gap", root: c.id, item: gapTarget.item, gap: gapTarget.name, expect: ["SILENT-OMISSION", "MISSED"] });
  const c2 = await copy("misplace-gap"); const g2 = c2.findAll(n => n.name === gapTarget.name)[0];
  // Move it to the corner of the screen farthest from where it was.
  const gx = g2.absoluteTransform[0][2] - c2.absoluteTransform[0][2], gy = g2.absoluteTransform[1][2] - c2.absoluteTransform[1][2];
  c2.appendChild(g2);
  if (c2.layoutMode && c2.layoutMode !== "NONE") g2.layoutPositioning = "ABSOLUTE";
  g2.x = gx + g2.width / 2 < c2.width / 2 ? c2.width - g2.width - 8 : 8;
  g2.y = gy + g2.height / 2 < c2.height / 2 ? c2.height - g2.height - 8 : 8;
  labels.push({ kind: "misplace-gap", root: c2.id, gap: gapTarget.name, expect: ["placed<0.5"] });
}
return { original: root.id, labels };`,
});
const r = res.result ?? res;
if (!r?.labels) throw new Error(JSON.stringify(res).slice(0, 400));
writeFileSync(out, JSON.stringify({ fileKey, ...r }, null, 2));
console.log(JSON.stringify(r, null, 2));
await client.close();
process.exit(0);
