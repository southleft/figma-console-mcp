#!/usr/bin/env node
// Spike: figma_bind_tokens binds real variables, refuses invented ones, and the audit credits the bindings.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const [DS] = process.argv.slice(2);
const client = new Client({ name: "spike-bind", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/local.js"], env: { ...process.env, LOG_LEVEL: "error" }, stderr: "ignore" }));
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 }); try { return JSON.parse(r.content[0].text); } catch { return r; } };
for (let i = 0; i < 45; i++) { const s = await call("figma_list_open_files", {}); if ((s.files ?? []).some(f => f.fileKey === DS)) break; await new Promise(r => setTimeout(r, 2000)); }
const prep = await call("figma_execute", { fileKey: DS, code: `
const vars = await figma.variables.getLocalVariablesAsync("FLOAT");
const cols = await figma.variables.getLocalVariableCollectionsAsync(); const cn = {}; for (const c of cols) cn[c.id] = c.name;
const pick = re => { const v = vars.find(v => re.test(v.name)); return v ? v.name : null; };
const f = figma.createFrame(); f.name = "Bind Tokens Test"; f.layoutMode = "VERTICAL"; f.x = -7000;
f.paddingLeft = f.paddingRight = f.paddingTop = f.paddingBottom = 16; f.itemSpacing = 8; f.cornerRadius = 6;
f.fills = []; f.appendChild(figma.createFrame());
return { id: f.id, space: pick(/(^|\\/)(spacing|space)\\/[^/]*(md|16|4|medium)/i) || pick(/spacing|space/i), gap: pick(/(^|\\/)(spacing|space)\\/[^/]*(sm|8|2|small)/i) || pick(/spacing|space/i), radius: pick(/radius|corner/i), sample: vars.slice(0, 8).map(v => v.name) };` });
const p = prep.result; console.log("PREP:", JSON.stringify(p));
const ok = await call("figma_bind_tokens", { nodeId: p.id, fileKey: DS, bindings: { padding: p.space, gap: p.gap, ...(p.radius ? { cornerRadius: p.radius } : {}) } });
console.log("BIND:", JSON.stringify({ success: ok.success, bound: ok.bound?.map(b => `${b.field}=${b.token}`), failed: ok.failed }).slice(0, 600));
const bad = await call("figma_bind_tokens", { nodeId: p.id, fileKey: DS, bindings: { gap: "spacing/gigantic-made-up" } });
console.log("INVENTED:", JSON.stringify(bad).slice(0, 400));
const a = await call("figma_audit_adherence", { nodeId: p.id, fileKey: DS });
console.log("AUDIT tokenCoverage:", a.tokenCoverage, "hardcoded:", JSON.stringify(a.stats?.hardcoded), "findings:", JSON.stringify((a.findings ?? []).map(f => f.rule)));
await call("figma_execute", { fileKey: DS, code: `const n = await figma.getNodeByIdAsync(${JSON.stringify(p.id)}); if (n) n.remove(); return true;` });
await client.close(); process.exit(0);
