#!/usr/bin/env node
// Spike: the opt-in local HTTP endpoint serves both protocol eras.
// Spawns dist/local.js with FIGMA_MCP_HTTP_PORT (+ a bearer token), then over
// HTTP: a v1 SDK client (2025-11-25 initialize, sessionful) and a v2 SDK client
// pinned to 2026-07-28 (server/discover, sessionless) each list tools and call
// figma_get_status; the v2 client also lists skills. No Figma needed.
//
// Usage: npm run build:local && node scripts/spike/http-eras-test.mjs [port]
import { spawn } from "node:child_process";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as V1Http } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client as V2Client, StreamableHTTPClientTransport as V2Http } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";

const port = process.argv[2] ?? String(38000 + Math.floor(Math.random() * 1000));
const token = "spike-token";
const child = spawn(process.execPath, ["dist/local.js"], {
	env: { ...process.env, LOG_LEVEL: "error", FIGMA_MCP_HTTP_PORT: port, FIGMA_MCP_HTTP_TOKEN: token },
	stdio: ["pipe", "ignore", "pipe"],
});
const url = await new Promise((resolve, reject) => {
	let buf = "";
	const timer = setTimeout(() => reject(new Error(`no HTTP URL on stderr:\n${buf}`)), 30000);
	child.stderr.on("data", (d) => {
		buf += d;
		const m = buf.match(/MCP over HTTP: (\S+)/);
		if (m) {
			clearTimeout(timer);
			resolve(m[1]);
		}
	});
	child.on("exit", (code) => reject(new Error(`server exited ${code}:\n${buf}`)));
});
console.log("endpoint", url);

const requestInit = { headers: { Authorization: `Bearer ${token}` } };
let failed = false;
const check = (label, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failed = true;
};

try {
	const v1Transport = new V1Http(new URL(url), { requestInit });
	const v1 = new V1Client({ name: "spike-v1", version: "0" });
	await v1.connect(v1Transport);
	const v2 = new V2Client({ name: "spike-v2", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
	await v2.connect(new V2Http(new URL(url), { requestInit }));

	check("v1 client protocol", v1Transport.protocolVersion === "2025-11-25", v1Transport.protocolVersion);
	check("v1 client has a session", typeof v1Transport.sessionId === "string");
	check("v2 client protocol", v2.getNegotiatedProtocolVersion() === "2026-07-28", v2.getNegotiatedProtocolVersion());

	for (const [label, client] of [["v1", v1], ["v2", v2]]) {
		const { tools } = await client.listTools();
		const status = tools.find((t) => t.name === "figma_get_status");
		check(`${label} tools/list`, tools.length > 50 && !!status, `${tools.length} tools`);
		check(`${label} annotations`, status?.annotations?.readOnlyHint === true);
		check(`${label} no propertyNames`, !JSON.stringify(tools).includes("propertyNames"));
		const r = await client.callTool({ name: "figma_get_status", arguments: {} });
		const body = JSON.parse(r.content[0].text);
		check(`${label} figma_get_status stamped`, body._mcp === "figma-console-mcp", `keys: ${Object.keys(body).slice(0, 5).join(",")}`);
	}

	const ext = Object.keys(v2.getServerCapabilities()?.extensions ?? {});
	check("v2 sees skills extension", ext.includes("io.modelcontextprotocol/skills"), ext.join(","));
	const skills = await new SkillsClient(v2).list();
	check("v2 skills/list", skills.skills.length > 0, skills.skills.map((s) => s.uri).join(","));

	const noAuth = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
	check("token enforced", noAuth.status === 401, String(noAuth.status));

	await v2.close();
	await v1.close();
} catch (error) {
	check("run", false, error?.stack ?? String(error));
} finally {
	child.kill("SIGTERM");
}
process.exit(failed ? 1 : 0);
