#!/usr/bin/env node
// Spike: figma_check_library_parity — a Figma library file vs a code component folder.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const [FIGMA, DIR] = process.argv.slice(2);
const client = new Client({ name: "spike-parity", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/local.js"], env: { ...process.env, LOG_LEVEL: "error" }, stderr: "ignore" }));
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 }); try { return JSON.parse(r.content[0].text); } catch { return r; } };
for (let i = 0; i < 45; i++) { const s = await call("figma_list_open_files", {}); if ((s.files ?? []).some(f => f.fileKey === FIGMA)) break; await new Promise(r => setTimeout(r, 2000)); }
await call("figma_navigate", { url: `https://www.figma.com/design/${FIGMA}/x`, lock: true });
const r = await call("figma_check_library_parity", { componentsDir: DIR });
console.log("SUMMARY:", JSON.stringify(r.summary), r.error ?? "");
console.log("PAIRS:", (r.pairs ?? []).map(p => `${p.figma.name}=${p.code}${p.matchedBy === "exact" ? "" : `(${p.matchedBy})`}`).join(", "));
console.log("FIGMA ONLY:", (r.figmaOnly ?? []).map(f => f.name).join(", "));
console.log("CODE ONLY:", (r.codeOnly ?? []).join(", "));
console.log("RETIRED:", (r.retiredInFigma ?? []).join(", "));
await call("figma_navigate", { url: `https://www.figma.com/design/${FIGMA}/x`, lock: false });
await client.close(); process.exit(0);
