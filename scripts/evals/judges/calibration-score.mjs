#!/usr/bin/env node
/**
 * Score each JUDGE on planted defects (see mutate.mjs).
 *   node scripts/evals/judges/calibration-score.mjs --labels <labels.json> --original <dir> --prefix <dir-prefix>
 * Directories: <prefix><kind> for each label kind (clean, detach, false-gap, drop-gap, misplace-gap).
 *
 * Per judge:
 *   caught       planted defect flagged on the targeted item (or the note's placement for misplace-gap)
 *   stable       on the clean copy, outcomes equal the judge's own verdicts on the original
 *   collateral   in defect copies, OTHER items whose ok/defect call flipped vs the original (noise)
 * recall = caught / planted; stability = unchanged items on clean / items.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OK, loadJudges } from "./panel.mjs";

const arg = (k) => process.argv[process.argv.indexOf(`--${k}`) + 1];
const labels = JSON.parse(readFileSync(arg("labels"), "utf8")).labels;
const original = loadJudges(arg("original"));
const prefix = arg("prefix");

const byJudge = {};
for (const j of original) byJudge[j.judge] = { caught: 0, planted: 0, misses: [], stableItems: 0, cleanItems: 0, collateral: 0, otherItems: 0 };

for (const l of labels) {
	const dir = `${prefix}${l.kind}`;
	if (!existsSync(dir)) continue;
	for (const j of loadJudges(dir)) {
		const s = byJudge[j.judge];
		if (!s) continue;
		const orig = original.find((o) => o.judge === j.judge);
		const same = (id) => {
			const a = orig.verdicts.find((v) => v.id === id)?.outcome;
			const b = j.verdicts.find((v) => v.id === id)?.outcome;
			return { a, b };
		};
		if (l.kind === "clean") {
			for (const v of orig.verdicts) {
				s.cleanItems++;
				if (same(v.id).b === v.outcome) s.stableItems++;
			}
			continue;
		}
		s.planted++;
		let hit = false;
		if (l.kind === "misplace-gap") {
			const g = (j.gapNotes ?? []).find((x) => x.name === l.gap);
			hit = typeof g?.placed === "number" && g.placed < 0.5;
		} else {
			const got = j.verdicts.find((v) => v.id === l.item)?.outcome;
			hit = l.expect.includes(got) || (!OK.has(got) && l.kind !== "false-gap" && got !== undefined);
		}
		if (hit) s.caught++;
		else s.misses.push(l.kind);
		for (const v of orig.verdicts) {
			if (v.id === l.item) continue;
			s.otherItems++;
			const { a, b } = same(v.id);
			if (a && b && OK.has(a) !== OK.has(b)) s.collateral++;
		}
	}
}
console.log("judge            recall   stability(clean)   collateral flips   misses");
for (const [name, s] of Object.entries(byJudge)) {
	console.log(
		`${name.padEnd(16)} ${`${s.caught}/${s.planted}`.padEnd(8)} ${`${((s.stableItems / Math.max(1, s.cleanItems)) * 100).toFixed(0)}%`.padEnd(18)} ${`${s.collateral}/${s.otherItems}`.padEnd(18)} ${s.misses.join(", ")}`,
	);
}
