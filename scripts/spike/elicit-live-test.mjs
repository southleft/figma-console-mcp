#!/usr/bin/env node
// Spike: live test of elicitation confirmations against a real Figma file.
// Spawns dist/local.js (falls back to a free port 9224+), declares form
// elicitation, answers prompts from a scripted queue, and logs everything.
// Requires the Desktop Bridge in the target file to (re)scan ports — reload
// the plugin after starting this script.
//
// Usage: node scripts/spike/elicit-live-test.mjs <fileKey> [v1|v2]
//   v1 — 2025-era client (old SDK): exercises the server's legacy shim
//   v2 — 2026-07-28 client (new SDK): exercises input_required round trips
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as V1Stdio } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client as V2Client } from "@modelcontextprotocol/client";
import { StdioClientTransport as V2Stdio } from "@modelcontextprotocol/client/stdio";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";

const fileKey = process.argv[2];
const era = process.argv[3] ?? "v1";
if (!fileKey) throw new Error("fileKey required");
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const spawn = { command: process.execPath, args: ["dist/local.js"], env: { ...process.env, LOG_LEVEL: "error" }, stderr: "ignore" };
const transport = era === "v2" ? new V2Stdio(spawn) : new V1Stdio(spawn);
const client =
	era === "v2"
		? new V2Client(
				{ name: "spike-elicit-test", version: "0.0.0" },
				{ capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: "2026-07-28" } } },
			)
		: new V1Client({ name: "spike-elicit-test", version: "0.0.0" }, { capabilities: { elicitation: { form: {} } } });

const answers = []; // queue of { action, content }
const prompts = [];
client.setRequestHandler(era === "v2" ? "elicitation/create" : ElicitRequestSchema, async (req) => {
	prompts.push(req.params);
	const a = answers.shift() ?? { action: "cancel" };
	log("ELICIT ←", JSON.stringify(req.params.message).slice(0, 400));
	log("  schema:", JSON.stringify(req.params.requestedSchema));
	log("  answer →", JSON.stringify(a));
	return a;
});

await client.connect(transport);
log("era", era, "protocol", client.getNegotiatedProtocolVersion?.() ?? "2025 (v1 client)");
if (era === "v2") {
	const sk = await new SkillsClient(client).list();
	log("skills:", JSON.stringify(sk.skills.map((x) => x.uri)));
	const r = await client.readResource({ uri: sk.skills[0].uri });
	log("skill read:", JSON.stringify(r.contents[0].text.slice(0, 120)));
}
const call = async (name, args) => {
	const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
	const text = r.content?.[0]?.text ?? "";
	try {
		return JSON.parse(text);
	} catch {
		return { raw: text, isError: r.isError };
	}
};

// Wait for the plugin in fileKey to connect to THIS server.
log("waiting for Desktop Bridge connection (reload the plugin now)…");
let connected = false;
for (let i = 0; i < 90 && !connected; i++) {
	const s = await call("figma_list_open_files", {});
	connected = (s.files ?? []).some((f) => f.fileKey === fileKey);
	if (!connected) await new Promise((r) => setTimeout(r, 2000));
}
if (!connected) {
	log("FAIL: plugin never connected");
	process.exit(1);
}
log("connected");
await call("figma_navigate", { url: `https://www.figma.com/design/${fileKey}/x`, lock: true });

const exec = (code) => call("figma_execute", { code, fileKey });
const results = {};
const COLL = "Spike Confirm Test";

// a. Create a throwaway collection with 3 variables.
const created = await exec(`
const old = (await figma.variables.getLocalVariableCollectionsAsync()).filter(c => c.name === ${JSON.stringify(COLL)});
for (const c of old) c.remove();
const c = figma.variables.createVariableCollection(${JSON.stringify(COLL)});
for (const [n, v] of [["alpha",{r:1,g:0,b:0,a:1}],["beta",{r:0,g:1,b:0,a:1}],["gamma",{r:0,g:0,b:1,a:1}]]) {
  const x = figma.variables.createVariable(n, c, "COLOR"); x.setValueForMode(c.modes[0].modeId, v);
}
return { id: c.id };`);
const collId = created.result?.id ?? created.id;
log("created collection", collId, JSON.stringify(created).slice(0, 200));
const countVars = async () => {
	const r = await exec(`const c = await figma.variables.getVariableCollectionByIdAsync(${JSON.stringify(collId)});
return c ? (await Promise.all(c.variableIds.map(id => figma.variables.getVariableByIdAsync(id)))).map(v => v.name) : null;`);
	return r.result ?? r;
};

// b. Delete collection → user declines.
answers.push({ action: "decline" });
results.b_declineDelete = await call("figma_delete_variable_collection", { collectionId: collId });
results.b_afterDecline = await countVars();

// b2. Delete collection → user accepts the form but leaves confirm unchecked.
answers.push({ action: "accept", content: { confirm: false } });
results.b2_uncheckedDelete = await call("figma_delete_variable_collection", { collectionId: collId });
results.b2_after = await countVars();

// c. Export the collection, drop "gamma", import with replace → user picks keep.
const exported = await call("figma_export_tokens", { format: "dtcg", collectionIds: [collId] });
results.exportKeys = Object.keys(exported);
const files = exported.files ?? exported.outputs ?? null;
let content = null;
if (Array.isArray(files) && files[0]?.content) content = files[0].content;
else if (typeof exported.content === "string") content = exported.content;
if (!content) {
	log("could not find exported content; keys:", Object.keys(exported), JSON.stringify(exported).slice(0, 800));
} else {
	const doc = JSON.parse(content);
	const strip = (o) => {
		for (const k of Object.keys(o)) {
			if (k === "gamma") delete o[k];
			else if (o[k] && typeof o[k] === "object") strip(o[k]);
		}
	};
	strip(doc);
	const payload = JSON.stringify(doc);

	answers.push({ action: "accept", content: { action: "keep" } });
	results.c_importKeep = await call("figma_import_tokens", { format: "dtcg", payload, strategy: "replace" });
	results.c_after = await countVars();

	// d. Same import → user confirms delete.
	answers.push({ action: "accept", content: { action: "delete" } });
	results.d_importDelete = await call("figma_import_tokens", { format: "dtcg", payload, strategy: "replace" });
	results.d_after = await countVars();

	// d2. Merge import never prompts.
	const before = prompts.length;
	results.d2_merge = await call("figma_import_tokens", { format: "dtcg", payload, strategy: "merge" });
	results.d2_prompted = prompts.length > before;
}

// e. Delete collection → user confirms.
answers.push({ action: "accept", content: { confirm: true } });
results.e_confirmDelete = await call("figma_delete_variable_collection", { collectionId: collId });
results.e_after = await countVars();

await call("figma_navigate", { url: `https://www.figma.com/design/${fileKey}/x`, lock: false });
const slim = (o) => JSON.stringify(o).slice(0, 600);
for (const [k, v] of Object.entries(results)) log(k, "=", slim(v));
log("prompts shown:", prompts.length);
await client.close();
process.exit(0);
