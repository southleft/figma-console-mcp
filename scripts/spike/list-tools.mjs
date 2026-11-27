#!/usr/bin/env node
// Spike helper: spawn the local server over stdio, list its tools, print JSON.
// Usage: node scripts/spike/list-tools.mjs [outFile]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";

const transport = new StdioClientTransport({
	command: process.execPath,
	args: ["dist/local.js"],
	env: { ...process.env, ENABLE_MCP_APPS: "true", LOG_LEVEL: "error" },
	stderr: "ignore",
});
const client = new Client({ name: "spike-list-tools", version: "0.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
const out = tools.map((t) => ({
	name: t.name,
	description: t.description,
	annotations: t.annotations,
	_meta: t._meta,
	inputSchema: t.inputSchema,
}));
const json = JSON.stringify(out, null, 2);
if (process.argv[2]) writeFileSync(process.argv[2], json);
else console.log(json);
console.error(`${tools.length} tools`);
await client.close();
process.exit(0);
