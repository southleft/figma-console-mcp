#!/usr/bin/env node
// Spike: a composition built correctly (instances + bound tokens) must PASS figma_audit_adherence.
// Usage: node scripts/spike/adherence-clean-test.mjs <dsFileKey>
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const [DS] = process.argv.slice(2);
const client = new Client({ name: "spike-clean", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/local.js"], env: { ...process.env, LOG_LEVEL: "error" }, stderr: "ignore" }));
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 }); try { return JSON.parse(r.content[0].text); } catch { return r; } };
for (let i = 0; i < 45; i++) { const s = await call("figma_list_open_files", {}); if ((s.files ?? []).some(f => f.fileKey === DS)) break; await new Promise(r => setTimeout(r, 2000)); }
const built = await call("figma_execute", { fileKey: DS, timeout: 60000, code: `
await figma.loadAllPagesAsync();
const vars = await figma.variables.getLocalVariablesAsync();
const color = vars.find(v => v.resolvedType === "COLOR" && /(surface|background|bg)/i.test(v.name)) || vars.find(v => v.resolvedType === "COLOR");
const space = vars.find(v => v.resolvedType === "FLOAT" && /(spac|gap|padding|space)/i.test(v.name));
const sets = figma.root.findAll(n => n.type === "COMPONENT_SET" && /^(button|checkbox)$/i.test(n.name.split("/").pop().trim()));
const f = figma.createFrame(); f.name = "Adherence Clean Test"; f.layoutMode = "VERTICAL"; f.x = -6000; f.y = 0;
f.fills = [figma.variables.setBoundVariableForPaint({ type: "SOLID", color: { r: 1, g: 1, b: 1 } }, "color", color)];
if (space) for (const k of ["paddingLeft","paddingRight","paddingTop","paddingBottom","itemSpacing"]) f.setBoundVariable(k, space);
for (const s of sets) f.appendChild((s.defaultVariant || s.children[0]).createInstance());
figma.currentPage.appendChild(f);
return { id: f.id, color: color && color.name, space: space && space.name, instances: sets.map(s => s.name) };` });
console.log("BUILT:", JSON.stringify(built.result ?? built).slice(0, 300));
const a = await call("figma_audit_adherence", { nodeId: built.result.id, fileKey: DS });
console.log("AUDIT pass:", a.pass, "score:", a.score, "componentCoverage:", a.componentCoverage, "tokenCoverage:", a.tokenCoverage, JSON.stringify(a.counts));
console.log("  used:", JSON.stringify((a.componentsUsed ?? []).map(u => `${u.name} x${u.count} (${u.source})`)));
for (const f of (a.findings ?? []).slice(0, 8)) console.log(`  [${f.severity}] ${f.rule} — ${f.name}: ${f.message}`);
await call("figma_execute", { fileKey: DS, code: `const n = await figma.getNodeByIdAsync(${JSON.stringify(built.result.id)}); if (n) n.remove(); return true;` });
await client.close(); process.exit(0);
