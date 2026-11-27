#!/usr/bin/env node
/**
 * Combine independent judges' verdicts for one composition.
 *   node scripts/evals/judges/panel.mjs <dir> [<dir> …]
 * Reads <dir>/jev.json and every <dir>/claude-*.json. Per item:
 *   unanimous            all judges give the same outcome
 *   majority             most agree; the dissent is shown
 *   split → person       no majority on pass/fail; a person decides
 * Nothing is averaged away. "ok" outcomes: built-with-component, gap-noted.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OK = new Set(["built-with-component", "gap-noted"]);
const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

export function loadJudges(dir) {
	return readdirSync(dir)
		.filter((f) => f === "jev.json" || /^claude-.+\.json$/.test(f))
		.map((f) => read(join(dir, f)))
		.filter(Boolean);
}

export function combine(judges) {
	const ids = [...new Set(judges.flatMap((j) => j.verdicts.map((v) => v.id)))];
	const rows = ids.map((id) => {
		const votes = Object.fromEntries(judges.map((j) => [j.judge, j.verdicts.find((v) => v.id === id)?.outcome ?? "—"]));
		const outcomes = Object.values(votes);
		const counts = {};
		for (const o of outcomes) counts[o] = (counts[o] ?? 0) + 1;
		const [top, topN] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
		const okVotes = outcomes.filter((o) => OK.has(o)).length;
		const passFail = okVotes * 2 > outcomes.length ? "ok" : okVotes * 2 < outcomes.length ? "defect" : "split";
		const status = topN === outcomes.length ? "unanimous" : passFail === "split" ? "split→person" : "majority";
		const reasons = judges.map((j) => j.verdicts.find((v) => v.id === id)?.reason).filter(Boolean);
		return { id, verdict: passFail === "split" ? "for a person" : top, passFail, status, votes, reasons };
	});
	return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	for (const dir of process.argv.slice(2)) {
		const judges = loadJudges(dir);
		if (judges.length < 2) {
			console.log(`${dir}: need at least two judges (have ${judges.length})`);
			continue;
		}
		const rows = combine(judges);
		const report = {
			dir,
			judges: judges.map((j) => j.judge),
			unanimous: rows.filter((r) => r.status === "unanimous").length,
			items: rows.length,
			defects: rows.filter((r) => r.passFail === "defect").map((r) => `${r.id}: ${r.verdict}`),
			forPerson: rows.filter((r) => r.status === "split→person").map((r) => r.id),
			rows,
			gapNotes: (judges[0].gapNotes ?? []).map((g, i) => ({
				name: g.name,
				explanation: judges.map((j) => j.gapNotes?.[i]?.explanation),
				placed: judges.map((j) => j.gapNotes?.[i]?.placed),
			})),
			screen: Object.fromEntries(judges.map((j) => [j.judge, j.screen])),
			otherFindings: judges.flatMap((j) => (j.otherFindings ?? []).map((f) => `[${j.judge}] ${f}`)),
		};
		writeFileSync(join(dir, "panel.json"), JSON.stringify(report, null, 2));
		const names = report.judges;
		console.log(`\n== ${dir}\n${report.unanimous}/${report.items} unanimous; judges: ${names.join(", ")}`);
		for (const r of rows) console.log(`  ${r.status.padEnd(13)} ${r.id.padEnd(34)} ${names.map((n) => String(r.votes[n]).padEnd(32)).join("")}`);
		for (const g of report.gapNotes) console.log(`  gap ${g.name}: explanation ${g.explanation.join(" / ")}, placed ${g.placed.map((x) => (typeof x === "number" ? x.toFixed(2) : x)).join(" / ")}`);
	}
}
