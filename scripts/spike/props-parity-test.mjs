#!/usr/bin/env node
// Spike: property-level parity — Figma library file vs a Custom Elements Manifest.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { writeFileSync } from "node:fs";
const [FIGMA, MANIFEST, DIR, OUT] = process.argv.slice(2);
const client = new Client({ name: "spike-props", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/local.js"], env: { ...process.env, LOG_LEVEL: "error" }, stderr: "ignore" }));
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 }); try { return JSON.parse(r.content[0].text); } catch { return r; } };
for (let i = 0; i < 45; i++) { const s = await call("figma_list_open_files", {}); if ((s.files ?? []).some(f => f.fileKey === FIGMA)) break; await new Promise(r => setTimeout(r, 2000)); }
await call("figma_navigate", { url: `https://www.figma.com/design/${FIGMA}/x`, lock: true });
const r = await call("figma_check_library_parity", { manifestPath: MANIFEST, componentsDir: DIR, classPrefixes: ["AL"], ...(process.env.CONTRACTS ? { contractsDir: process.env.CONTRACTS } : {}) });
if (OUT) writeFileSync(OUT, JSON.stringify(r, null, 2));
console.log("SUMMARY:", JSON.stringify(r.summary), r.error ?? "");
console.log("IN SYNC:", (r.inSyncComponents ?? []).join(", "));
for (const p of r.propertyParity ?? []) {
	const bits = [];
	for (const a of p.axes ?? []) {
		if (a.mappedBy === "none") bits.push(`axis ${a.figmaAxis} has no code prop`);
		if (a.figmaOnlyValues?.length) bits.push(`${a.figmaAxis}: Figma-only ${a.figmaOnlyValues.join("/")}${a.codeProp ? ` (vs ${a.codeProp})` : ""}`);
		if (a.codeOnlyValues?.length) bits.push(`${a.figmaAxis}↔${a.codeProp}: code-only ${a.codeOnlyValues.join("/")}`);
	}
	if (p.codeOnlyProps?.length) bits.push(`code-only props ${p.codeOnlyProps.map(x => x.name).join(", ")}`);
	if (p.figmaOnlyProperties?.length) bits.push(`Figma-only properties ${p.figmaOnlyProperties.join(", ")}`);
	console.log(`- ${p.component} [${p.status}] ${p.note ?? ""} ${bits.join("; ")}`);
}
await call("figma_navigate", { url: `https://www.figma.com/design/${FIGMA}/x`, lock: false });
await client.close(); process.exit(0);
