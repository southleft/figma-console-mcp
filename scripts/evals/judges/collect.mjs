#!/usr/bin/env node
/**
 * Collect evidence for one composition and run the Jev judge on it.
 *   node scripts/evals/judges/collect.mjs --file <fileKey> --root <nodeId> --case <case.json> --out <dir> [--no-jev]
 * Writes <dir>/evidence.json, screenshot.png, case.json, jev.json.
 * The Claude judge is run separately (a subagent reading <dir> with claude-judge.md).
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectEvidence } from "./evidence.mjs";
import { judgeWithJev } from "./jev.mjs";

const arg = (k) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : undefined;
};
const [fileKey, rootId, casePath, out] = [arg("file"), arg("root"), arg("case"), arg("out")];
if (!fileKey || !rootId || !casePath || !out) throw new Error("--file --root --case --out are required");
const caseFile = JSON.parse(readFileSync(casePath, "utf8"));

const client = new Client({ name: "judge-evidence", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/local.js"], env: { ...process.env, LOG_LEVEL: "error" }, stderr: "ignore" }));
const call = async (name, args = {}) => {
	const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 240000 });
	const t = r.content?.[0]?.text ?? "{}";
	try {
		return JSON.parse(t);
	} catch {
		return { raw: t };
	}
};
for (let i = 0; i < 40; i++) {
	const s = await call("figma_list_open_files");
	if ((s.files ?? []).some((f) => f.fileKey === fileKey)) break;
	await new Promise((r) => setTimeout(r, 2000));
}
const { evidence, pngBase64, pngNoGapsBase64 } = await collectEvidence(call, { fileKey, rootId, prompt: caseFile.prompt, outDir: out });
copyFileSync(casePath, join(out, "case.json"));
await client.close();
console.log(`evidence: ${evidence.composition.layers.length} layers, ${evidence.composition.gapNotes.length} gap notes, ${evidence.designSystem.components.length} components`);
if (!process.argv.includes("--no-jev")) {
	const v = await judgeWithJev({ evidence, pngBase64, pngNoGapsBase64, caseFile });
	writeFileSync(join(out, "jev.json"), JSON.stringify(v, null, 2));
	for (const x of v.verdicts) console.log(`  ${x.outcome.padEnd(32)} ${x.id}  (handled ${x.handled} ${x.handledConfidence?.toFixed?.(2)}, lacks ${x.systemLacksIt?.toFixed?.(2)})`);
	for (const g of v.gapNotes) console.log(`  gap ${g.name}: explanation ${g.explanation?.toFixed?.(1)}/3, placed ${g.placed?.toFixed?.(2)}, centre distance ${g.centreDistance}`);
	console.log(`  screen: ${JSON.stringify(v.screen)}`);
}
process.exit(0);
