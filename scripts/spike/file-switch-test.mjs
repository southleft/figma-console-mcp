#!/usr/bin/env node
// Spike: the active Figma file changes WHILE the user answers a confirmation.
// The re-run must not act on the other file (delete: refuse; import: re-ask).
// Usage: node scripts/spike/file-switch-test.mjs <scratchFileKey> <otherFileKey>
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const [A, B] = process.argv.slice(2);
const log = (...a) => console.log(...a);
const client = new Client({ name: "spike-switch", version: "0" }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: "2026-07-28" } } });
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); try { return JSON.parse(r.content[0].text); } catch { return r; } };
const nav = (k, lock) => call("figma_navigate", { url: `https://www.figma.com/design/${k}/x`, lock });
let prompts = 0, onPrompt = async () => ({ action: "cancel" });
client.setRequestHandler("elicitation/create", async (req) => { prompts++; log("PROMPT:", req.params.message.slice(0, 160)); return onPrompt(req); });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/local.js"], env: { ...process.env, LOG_LEVEL: "error" }, stderr: "ignore" }));
for (let i = 0; i < 45; i++) { const s = await call("figma_list_open_files", {}); const ks = (s.files ?? []).map(f => f.fileKey); if (ks.includes(A) && ks.includes(B)) break; await new Promise(r => setTimeout(r, 2000)); }
await nav(A, true);
const id = (await call("figma_execute", { fileKey: A, code: `const c = figma.variables.createVariableCollection("Spike Switch Test"); figma.variables.createVariable("x", c, "FLOAT"); return c.id;` })).result;
// While the "user" is answering, the active file moves to B; then they approve.
onPrompt = async () => { await nav(B, true); return { action: "accept", content: { confirm: true } }; };
const del = await call("figma_delete_variable_collection", { collectionId: id });
log("delete result:", JSON.stringify(del).slice(0, 300));
const still = (await call("figma_execute", { fileKey: A, code: `const c = await figma.variables.getVariableCollectionByIdAsync(${JSON.stringify(id)}); return c ? c.variableIds.length : null;` })).result;
log("collection still in A:", still !== null, "prompts:", prompts);
// cleanup
await call("figma_execute", { fileKey: A, code: `const c = await figma.variables.getVariableCollectionByIdAsync(${JSON.stringify(id)}); if (c) c.remove(); return true;` });
await nav(A, false);
await client.close(); process.exit(0);
