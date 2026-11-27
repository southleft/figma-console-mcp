#!/usr/bin/env node
/**
 * Score a model's tool choices against tasks.json.
 *   node scripts/evals/tool-choice/score.mjs <answers.json> [<answers.json> …]
 * answers.json: [{ "i": <task index>, "tool": "...", "arguments": {...} }]
 * A task passes when the tool is one of `expect` and every listed arg matches
 * (arrays: every expected value present).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const tasks = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "tasks.json"), "utf8"));
for (const f of process.argv.slice(2)) {
	const answers = JSON.parse(readFileSync(f, "utf8"));
	let toolOk = 0, allOk = 0;
	const misses = [];
	tasks.forEach((t, i) => {
		const a = answers.find((x) => x.i === i) ?? {};
		const okTool = t.expect.includes(a.tool);
		const argMiss = Object.entries(t.argsFor && t.argsFor !== a.tool ? {} : t.args ?? {}).filter(([k, v]) => {
			const got = a.arguments?.[k];
			return Array.isArray(v) ? !(Array.isArray(got) && v.every((x) => got.includes(x))) : got !== v;
		});
		if (okTool) toolOk++;
		if (okTool && argMiss.length === 0) allOk++;
		else misses.push(`#${i} ${t.task.slice(0, 60)}… → ${a.tool ?? "none"}${argMiss.length ? ` (args: ${argMiss.map(([k]) => k).join(", ")})` : ""}`);
	});
	console.log(`${f.split("/").pop()}: tool ${toolOk}/${tasks.length}, tool+args ${allOk}/${tasks.length}`);
	for (const m of misses) console.log("   ", m);
}
