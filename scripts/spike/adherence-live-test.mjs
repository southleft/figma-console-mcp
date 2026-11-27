#!/usr/bin/env node
// Spike: live test of figma_resolve_components + figma_audit_adherence.
// Usage: node scripts/spike/adherence-live-test.mjs <dsFileKey> <scratchFileKey>
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const [DS, SCRATCH] = process.argv.slice(2);
const log = (...a) => console.log(...a);
const client = new Client({ name: "spike-adherence", version: "0" }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: "2026-07-28" } } });
let lastPrompt = null;
client.setRequestHandler("elicitation/create", async (req) => {
	lastPrompt = req.params;
	log("PROMPT:", req.params.message);
	const content = {};
	for (const [k, f] of Object.entries(req.params.requestedSchema.properties)) {
		log(`  ${k}: ${f.title}  options=${JSON.stringify(f.enumNames)}`);
		content[k] = f.enum.includes("use_0") ? "use_0" : "placeholder";
	}
	return { action: "accept", content };
});
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/local.js"], env: { ...process.env, LOG_LEVEL: "error" }, stderr: "ignore" }));
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 }); try { return JSON.parse(r.content[0].text); } catch { return r; } };
for (let i = 0; i < 45; i++) { const s = await call("figma_list_open_files", {}); const ks = (s.files ?? []).map(f => f.fileKey); if (ks.includes(DS) && ks.includes(SCRATCH)) break; await new Promise(r => setTimeout(r, 2000)); }

// 1. Resolve needs against the design-system file.
await call("figma_navigate", { url: `https://www.figma.com/design/${DS}/x`, lock: true });
const needs = ["primary button", "checkbox", "text input", "avatar", "date picker", "data table", "toast notification", "dropdown"];
const r = await call("figma_resolve_components", { needs });
log("\nRESOLVE summary:", JSON.stringify(r.summary), "catalog:", r.catalogSize, "decisionsBy:", r.decisionsBy, r.error ?? "");
for (const it of r.items ?? []) log(`  ${it.status.padEnd(8)} ${it.need.padEnd(20)} → ${it.action}${it.component ? ` [${it.component.name} ${it.component.score}]` : ""}${it.candidates ? `  cands: ${it.candidates.map(c => `${c.name}(${c.score})`).join(", ")}` : ""}`);

// 2. Build a deliberately mixed composition in the scratch file and audit it.
await call("figma_navigate", { url: `https://www.figma.com/design/${SCRATCH}/x`, lock: true });
const built = await call("figma_execute", { fileKey: SCRATCH, timeout: 60000, code: `
await figma.loadAllPagesAsync();
const old = figma.currentPage.findAll(n => n.name === "Adherence Test");
for (const o of old) o.remove();
const root = figma.createFrame(); root.name = "Adherence Test"; root.layoutMode = "VERTICAL"; root.itemSpacing = 12; root.paddingLeft = root.paddingRight = root.paddingTop = root.paddingBottom = 24;
root.x = -4000; root.y = 0; root.fills = [{ type: "SOLID", color: { r: 0.98, g: 0.98, b: 0.99 } }];
// Hand-built "Button" (imitation)
const fakeBtn = figma.createFrame(); fakeBtn.name = "Button"; fakeBtn.layoutMode = "HORIZONTAL"; fakeBtn.paddingLeft = fakeBtn.paddingRight = 16; fakeBtn.cornerRadius = 8; fakeBtn.fills = [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 1 } }];
await figma.loadFontAsync({ family: "Inter", style: "Regular" });
const t = figma.createText(); t.characters = "Submit"; fakeBtn.appendChild(t); root.appendChild(fakeBtn);
// Hand-drawn icon
const v = figma.createVector(); v.vectorPaths = [{ windingRule: "NONZERO", data: "M 0 0 L 10 10 L 0 10 Z" }]; root.appendChild(v);
// A real instance of a local component, if the file has one
const comp = figma.root.findOne(n => n.type === "COMPONENT" && n.parent && n.parent.type !== "COMPONENT_SET") || figma.root.findOne(n => n.type === "COMPONENT");
let used = null;
if (comp) { const inst = comp.createInstance(); root.appendChild(inst); used = comp.name; }
// Declared gap
const gap = figma.createFrame(); gap.name = "GAP: date picker"; gap.resize(200, 40); gap.fills = []; root.appendChild(gap);
return { rootId: root.id, usedComponent: used };` });
log("\nBUILT:", JSON.stringify(built.result ?? built).slice(0, 200));
const rootId = built.result?.rootId;
const a = await call("figma_audit_adherence", { nodeId: rootId, fileKey: SCRATCH });
log("AUDIT pass:", a.pass, "score:", a.score, "componentCoverage:", a.componentCoverage, "tokenCoverage:", a.tokenCoverage, a.error ?? "");
log("  counts:", JSON.stringify(a.counts));
log("  used:", JSON.stringify((a.componentsUsed ?? []).map(u => `${u.name} x${u.count} (${u.source})`)));
log("  gaps:", JSON.stringify(a.declaredGaps));
for (const f of (a.findings ?? []).slice(0, 12)) log(`  [${f.severity}] ${f.rule} — ${f.name}: ${f.message}`);

// 3. Clean up.
await call("figma_execute", { fileKey: SCRATCH, code: `const n = await figma.getNodeByIdAsync(${JSON.stringify(rootId)}); if (n) n.remove(); return true;` });
await call("figma_navigate", { url: `https://www.figma.com/design/${SCRATCH}/x`, lock: false });
await client.close(); process.exit(0);
