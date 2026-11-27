#!/usr/bin/env node
// Spike: a client WITHOUT elicitation must see today's behavior (no prompt, no error).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const fileKey = process.argv[2];
const client = new Client({ name: "spike-no-elicit", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/local.js"], env: { ...process.env, LOG_LEVEL: "error" }, stderr: "ignore" }));
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
for (let i = 0; i < 45; i++) {
	const s = await call("figma_list_open_files", {});
	if ((s.files ?? []).some((f) => f.fileKey === fileKey)) break;
	await new Promise((r) => setTimeout(r, 2000));
}
const c = await call("figma_execute", { fileKey, code: `const c = figma.variables.createVariableCollection("Spike NoElicit"); figma.variables.createVariable("x", c, "FLOAT"); return c.id;` });
const del = await call("figma_delete_variable_collection", { collectionId: c.result });
console.log(JSON.stringify({ created: c.result, delete: del }));
await client.close();
process.exit(0);
