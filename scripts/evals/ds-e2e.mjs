#!/usr/bin/env node
/**
 * End-to-end evaluation of the design-system tools against REAL design systems
 * (a Figma library file + its code library), driven through a real MCP client
 * exactly as a user's agent would. Every check has an expected outcome and is
 * scored PASS / FAIL — "it ran" is not a pass.
 *
 * Writes only to a temporary page ("🧪 eval (temporary)") in each design-system
 * file, removed in a finally block. Never touches files not listed in the config.
 *
 * Usage:
 *   node scripts/evals/ds-e2e.mjs [--config systems.json] [--only <id>,<id>] [--out report.json]
 * Requires: `npm run build:local`, the Desktop Bridge open in each file, and the
 * code libraries checked out at the configured paths.
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Which design systems to evaluate lives in a config file, not here: the harness
// is library-agnostic. See scripts/evals/ds-systems.example.json for the shape.
const cfgArg = process.argv.indexOf("--config");
const cfgPath = cfgArg > 0 ? process.argv[cfgArg + 1] : join(process.cwd(), ".notes/evals/ds-systems.json");
if (!existsSync(cfgPath)) {
	console.error(`No systems config at ${cfgPath}. Copy scripts/evals/ds-systems.example.json and pass --config <path>.`);
	process.exit(2);
}
const expand = (v) => (typeof v === "string" && v.startsWith("~/") ? join(homedir(), v.slice(2)) : v);
const cfgFile = JSON.parse(readFileSync(cfgPath, "utf8"));
const SYSTEMS = (cfgFile.systems ?? []).map((sys) => {
	const out = Object.fromEntries(Object.entries(sys).map(([k, v]) => [k, expand(v)]));
	out.importName = (n) => `${sys.importPrefix ?? ""}${n}`;
	return out;
});
// Files the harness must never write to, even if listed (e.g. shared with another app).
const OFF_LIMITS = new Set(cfgFile.offLimitsFileKeys ?? []);
// Plausible-sounding UI that most systems lack. Each run keeps only the ones the
// system verifiably doesn't have (plain name check, independent of the matcher).
const DECOY_POOL = [
	// Domain-specific UI with no generic UI nouns (tile, grid, card, board, panel,
	// widget…), which are synonyms of real components and would test the decoy
	// list rather than the tool.
	"hologram projector", "kanban swimlane", "org chart", "gantt timeline", "signature capture",
	"color wheel", "code editor", "spreadsheet formula", "video conference stream", "music equalizer",
	"qr scanner", "weather forecast", "stock ticker", "heart rate monitor", "chess clock", "karaoke lyrics",
];
// This harness's OWN page. It is created fresh each run and removed by id only;
// a pre-existing page with this name is never touched (the run stops instead).
const TEMP_PAGE = `🧪 ds-e2e harness ${new Date().toISOString().slice(0, 19)}`;

const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1].split(",") : null;
const outFile = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : null;

const client = new Client({ name: "ds-e2e-eval", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/local.js"], env: { ...process.env, LOG_LEVEL: "error" }, stderr: "ignore" }));
async function call(name, args = {}) {
	const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 240000 });
	const text = r.content?.[0]?.text ?? "";
	try {
		return { ...JSON.parse(text), __isError: !!r.isError };
	} catch {
		return { raw: text, __isError: !!r.isError };
	}
}
const exec = (fileKey, code, timeout = 60000) => call("figma_execute", { fileKey, code, timeout }).then((r) => r.result ?? r);

const report = { startedAt: new Date().toISOString(), systems: [] };
const log = (...a) => console.log(...a);

function check(sys, id, pass, detail) {
	sys.checks.push({ id, pass: !!pass, ...detail });
	log(`  ${pass ? "PASS" : "FAIL"}  ${id}${detail?.summary ? ` — ${detail.summary}` : ""}`);
}

// Wait until the plugin in every configured file has connected to THIS server.
const wanted = SYSTEMS.filter((s) => !only || only.includes(s.id));
for (let i = 0; i < 60; i++) {
	const s = await call("figma_list_open_files");
	const keys = new Set((s.files ?? []).map((f) => f.fileKey));
	if (wanted.every((w) => keys.has(w.fileKey))) break;
	if (i === 59) {
		log("Not all files connected:", wanted.filter((w) => !keys.has(w.fileKey)).map((w) => w.name));
		process.exit(2);
	}
	await new Promise((r) => setTimeout(r, 2000));
}

for (const cfg of wanted) {
	if (OFF_LIMITS.has(cfg.fileKey)) throw new Error(`${cfg.name} is off-limits`);
	const sys = { id: cfg.id, name: cfg.name, checks: [], info: {} };
	report.systems.push(sys);
	log(`\n=== ${cfg.name}`);
	await call("figma_navigate", { url: `https://www.figma.com/design/${cfg.fileKey}/x`, lock: true });
	let pageId = null;
	try {
		// ---- Library parity (names + props) — also yields the gold set for resolve.
		const parity = await call("figma_check_library_parity", {
			componentsDir: cfg.componentsDir,
			...(cfg.manifestPath ? { manifestPath: cfg.manifestPath, classPrefixes: cfg.classPrefixes } : {}),
			...(cfg.contractsDir ? { contractsDir: cfg.contractsDir } : {}),
		});
		sys.info.parity = parity.summary;
		check(sys, "parity.runs", !parity.__isError && parity.summary?.paired > 0, {
			summary: parity.__isError ? parity.error : `${parity.summary.paired} paired, ${parity.summary.figmaOnly} Figma-only, ${parity.summary.codeOnly} code-only; props ${JSON.stringify(parity.summary.properties ?? "n/a")}`,
		});
		const unchecked = parity.summary?.properties?.unchecked ?? 0;
		check(sys, "parity.props-read", parity.summary?.properties && unchecked <= Math.ceil((parity.summary.paired ?? 0) * 0.2), {
			summary: parity.summary?.properties ? `${unchecked} of ${parity.summary.paired} pairs had unreadable props` : "no prop-level comparison",
		});
		sys.info.propertyDrift = (parity.propertyParity ?? []).map((p) => p.component);

		// ---- Resolve. Gold = every component present in BOTH the code library and
		// the Figma file under the same name (exact/normalised pairs from parity).
		// The need is the component's plain-language name; the expected answer is
		// that Figma component. Decoys are verified absent by plain name check.
		const gold = (parity.pairs ?? [])
			.filter((p) => p.matchedBy !== "concept")
			.map((p) => ({ need: p.figma.name.split("/").pop().trim().replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").toLowerCase(), expect: p.figma.name }));
		const allNames = [...(parity.pairs ?? []).map((p) => p.figma.name), ...(parity.figmaOnly ?? []).map((f) => f.name), ...(parity.codeOnly ?? [])]
			.map((n) => n.toLowerCase().replace(/[^a-z0-9]+/g, " "));
		// A decoy is valid only if NONE of its meaningful words appears in any component name.
		const decoys = DECOY_POOL.filter((d) => !d.split(" ").some((w) => allNames.some((n) => n.includes(w)))).slice(0, 8);
		// Room for every decoy first (the tool takes up to 40 needs per call).
		const goldUsed = gold.slice(0, 40 - decoys.length);
		const res = await call("figma_resolve_components", { needs: [...goldUsed.map((g) => g.need), ...decoys], askUser: false });
		const items = res.items ?? [];
		const m = { tp: 0, wrong: 0, deferred: 0, missed: 0, decoyMatched: 0, decoyDeferred: 0, decoyGap: 0 };
		const misses = [];
		for (const g of goldUsed) {
			const it = items.find((x) => x.need === g.need);
			const got = it?.component?.name;
			if (it?.status === "matched" && got === g.expect) m.tp++;
			else {
				if (it?.status === "matched") m.wrong++;
				else if (it?.status === "possible") m.deferred++;
				else m.missed++;
				misses.push(`${g.need} → ${it?.status}${got ? ` ${got}` : ""} (expected ${g.expect})${it?.candidates ? ` [${it.candidates.map((c) => c.name).join(", ")}]` : ""}`);
			}
		}
		for (const d of decoys) {
			const st = items.find((x) => x.need === d)?.status;
			if (!st) throw new Error(`decoy "${d}" missing from the resolve result`);
			const di = items.find((x) => x.need === d);
			if (st !== "gap") misses.push(`DECOY ${d} → ${st} [${(di?.candidates ?? []).map((c) => `${c.name} ${c.score} (${c.matchedOn?.join("+")})`).join(", ")}]`);
			if (st === "matched") m.decoyMatched++;
			else if (st === "possible") m.decoyDeferred++;
			else m.decoyGap++;
		}
		const goldN = m.tp + m.wrong + m.deferred + m.missed;
		const precision = m.tp + m.wrong + m.decoyMatched ? m.tp / (m.tp + m.wrong + m.decoyMatched) : 1;
		const recall = goldN ? m.tp / goldN : 0;
		sys.info.resolve = { ...m, gold: goldN, decoys: decoys.length, precision: +precision.toFixed(3), recall: +recall.toFixed(3), deferralRate: +(m.deferred / Math.max(1, goldN)).toFixed(3) };
		sys.info.resolveMisses = misses;
		check(sys, "resolve.precision", precision >= 0.95, { summary: `precision ${(precision * 100).toFixed(1)}% — ${m.wrong} wrong component(s), ${m.decoyMatched} decoy(s) matched` });
		check(sys, "resolve.recall", recall >= 0.8, { summary: `recall ${(recall * 100).toFixed(1)}% (${m.tp}/${goldN}); ${m.deferred} deferred to the person, ${m.missed} missed`, misses });
		check(sys, "resolve.decoys-are-gaps", m.decoyMatched === 0 && m.decoyDeferred === 0, { summary: `${m.decoyGap}/${decoys.length} decoys reported as gaps${m.decoyDeferred ? `, ${m.decoyDeferred} deferred` : ""}${m.decoyMatched ? `, ${m.decoyMatched} MATCHED` : ""}` });
		check(sys, "resolve.stop-instruction", !!res.ai_instruction === items.some((x) => x.action === "ask-user"), { summary: "undecided items carry a stop-and-report instruction" });

		// ---- Build good + bad compositions on a temporary page.
		const matched = items.filter((x) => x.status === "matched" && x.component).slice(0, 3);
		const build = await exec(
			cfg.fileKey,
			`await figma.loadAllPagesAsync();
if (figma.root.children.some(p => p.name === ${JSON.stringify(TEMP_PAGE)})) return { error: "a page named like this run's temporary page already exists; refusing to touch it" };
const page = figma.createPage(); page.name = ${JSON.stringify(TEMP_PAGE)};
const pick = ${JSON.stringify(matched.map((m) => ({ key: m.component.defaultVariant?.key ?? m.component.key, nodeId: m.component.defaultVariant?.nodeId ?? m.component.nodeId, name: m.component.name })))};
const good = figma.createFrame(); good.name = "Eval good"; good.fills = []; good.layoutMode = "VERTICAL"; page.appendChild(good);
const placed = [];
for (const c of pick) {
  let comp = null;
  try { comp = c.nodeId ? await figma.getNodeByIdAsync(c.nodeId) : null; } catch (e) {}
  if (comp && comp.type === "COMPONENT_SET") comp = comp.defaultVariant;
  if (comp && comp.type === "COMPONENT") { good.appendChild(comp.createInstance()); placed.push(c.name); }
}
const bad = figma.createFrame(); bad.name = "Eval bad"; bad.layoutMode = "VERTICAL"; bad.x = 600; page.appendChild(bad);
bad.fills = [{ type: "SOLID", color: { r: 0.98, g: 0.98, b: 0.99 } }]; bad.paddingLeft = bad.paddingTop = 24;
const fake = figma.createFrame(); fake.name = ${JSON.stringify(matched[0]?.component?.name?.split("/").pop() ?? "Button")};
fake.fills = [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 1 } }]; fake.cornerRadius = 8; fake.resize(120, 40); bad.appendChild(fake);
const v = figma.createVector(); v.vectorPaths = [{ windingRule: "NONZERO", data: "M 0 0 L 10 10 L 0 10 Z" }]; bad.appendChild(v);
const newComp = figma.createComponent(); newComp.name = "Eval Invented Widget"; newComp.resize(40, 40); bad.appendChild(newComp);
await figma.loadFontAsync({ family: "Inter", style: "Regular" }); const t = figma.createText(); t.fontName = { family: "Inter", style: "Regular" }; t.characters = "Hardcoded text"; bad.appendChild(t);
return { pageId: page.id, goodId: good.id, badId: bad.id, placed };`,
		);
		if (!build || build.error || !build.pageId) throw new Error(`build step failed: ${build?.error ?? JSON.stringify(build).slice(0, 300)}`);
		pageId = build.pageId;
		check(sys, "build.instances", (build.placed ?? []).length >= Math.min(2, matched.length), { summary: `placed ${build.placed?.length ?? 0} real instances: ${(build.placed ?? []).join(", ")}` });

		const good = await call("figma_audit_adherence", { nodeId: build.goodId, fileKey: cfg.fileKey });
		check(sys, "audit.good-passes", good.pass === true, { summary: `score ${good.score}, errors ${good.counts?.errors}, componentCoverage ${good.componentCoverage}`, byRule: good.counts?.byRule });
		const bad = await call("figma_audit_adherence", { nodeId: build.badId, fileKey: cfg.fileKey });
		const badRules = bad.counts?.byRule ?? {};
		// Planted violations → the rule that must catch each one.
		const planted = ["imitates-component", "new-component", "hand-drawn-vector", "hardcoded-color", "hardcoded-spacing", "hardcoded-radius", "hardcoded-typography"];
		const caught = planted.filter((r) => (badRules[r] ?? 0) >= 1);
		const falseFlags = good.counts?.errors ?? 0;
		sys.info.audit = { plantedRecall: +(caught.length / planted.length).toFixed(3), missed: planted.filter((r) => !caught.includes(r)), falseErrorsOnGood: falseFlags, goodWarnings: good.counts?.warnings ?? 0 };
		check(sys, "audit.bad-fails", bad.pass === false, { summary: `score ${bad.score}` });
		check(sys, "audit.planted-recall", caught.length === planted.length, { summary: `${caught.length}/${planted.length} planted violations caught${caught.length < planted.length ? ` — missed ${planted.filter((r) => !caught.includes(r)).join(", ")}` : ""}` });
		check(sys, "audit.no-false-errors", falseFlags === 0, { summary: `${falseFlags} error(s), ${good.counts?.warnings ?? 0} warning(s) on the clean build` });

		// ---- Token binding: a real spacing variable binds; an invented one is refused.
		const spacing = await exec(
			cfg.fileKey,
			`const vs = await figma.variables.getLocalVariablesAsync("FLOAT");
const v = vs.find(v => /(^|\\/)(spacing|space|gap|padding)(\\/|-|$)/i.test(v.name) && v.scopes.some(s => s === "ALL_SCOPES" || s === "GAP" || s === "WIDTH_HEIGHT")) || vs.find(v => /spac|space|gap|padding/i.test(v.name));
return v ? v.name : null;`,
		);
		if (spacing) {
			const ok = await call("figma_bind_tokens", { nodeId: build.badId, fileKey: cfg.fileKey, bindings: { gap: spacing } });
			check(sys, "bind.real-token", ok.success === true, { summary: `gap → ${spacing}: ${ok.success ? "bound" : JSON.stringify(ok.failed)}` });
		} else {
			check(sys, "bind.real-token", true, { summary: "no spacing variable in this file (skipped, not a failure)", skipped: true });
		}
		const nope = await call("figma_bind_tokens", { nodeId: build.badId, fileKey: cfg.fileKey, bindings: { gap: "spacing/definitely-not-real-42" } });
		check(sys, "bind.invented-refused", nope.success === false && (nope.failed?.[0]?.error ?? "").includes("No variable"), { summary: "invented token refused with suggestions" });

		// ---- Lint on the good composition: none of the fixed false-positive classes.
		const lint = await call("figma_lint_design", { nodeId: build.goodId, rules: ["wcag"] });
		const nodes = (lint.categories ?? []).flatMap((c) => c.nodes.map((n) => ({ ...n, rule: c.rule })));
		const fp = nodes.filter(
			(n) => (n.rule === "wcag-non-text-contrast" && n.component === "#000000" && /checkbox|radio/i.test(n.name)) || (n.rule === "wcag-target-size" && /__(footer|field-notes|label)$/.test(n.name)),
		);
		check(sys, "lint.no-known-false-positives", fp.length === 0, { summary: fp.length ? `${fp.length} known false-positive findings (plugin restart needed?)` : `${nodes.length} findings, none of the fixed classes` });

		// ---- Code adherence: synthetic good vs bad using this library's real names and tokens.
		const codeNames = (parity.pairs ?? []).slice(0, 2).map((p) => p.code);
		const tokenProbe = await call("figma_audit_code_adherence", { sources: [{ path: "probe.css", content: ":root{}" }], designSystem: { tokensPath: cfg.tokensPath } });
		const tokensOk = !tokenProbe.__isError;
		const firstToken = tokensOk ? await (async () => {
			const fs = await import("node:fs");
			const css = fs.readFileSync(cfg.tokensPath, "utf8");
			return (css.match(/--([A-Za-z0-9_-]+)\s*:/) ?? [])[1];
		})() : null;
		if (codeNames.length === 2 && firstToken) {
			const [A, B] = codeNames.map(cfg.importName);
			const goodSrc = `import { ${A}, ${B} } from "${cfg.package}";\nexport const Screen = () => (\n  <${A}>\n    <${B} />\n    <p style={{ color: "var(--${firstToken})" }}>ok</p>\n  </${A}>\n);`;
			const badSrc = `import { ${A} } from "${cfg.package}";\nfunction ${codeNames[1]}() { return <div className="p-[13px] bg-[#fafafa]" />; }\nexport const Screen = () => (\n  <${A}>\n    <${codeNames[1]} />\n    <span style={{ color: "var(--brand-invented-999)" }} />\n    <p style={{ color: "#3366ff", padding: 13 }}>x</p>\n  </${A}>\n);`;
			const ds = { packages: [cfg.package], componentsDir: cfg.componentsDir, tokensPath: cfg.tokensPath };
			const g = await call("figma_audit_code_adherence", { sources: [{ path: "Good.tsx", content: goodSrc }], designSystem: ds });
			check(sys, "code.good-passes", g.pass === true, { summary: `score ${g.score}, errors ${g.counts?.errors}, uses ${JSON.stringify(g.componentsUsed)}` });
			const b = await call("figma_audit_code_adherence", { sources: [{ path: "Bad.tsx", content: badSrc }], designSystem: ds });
			const br = b.counts?.byRule ?? {};
			const plantedCode = ["reimplements-component", "unknown-token", "tailwind-arbitrary-value", "hardcoded-color", "hardcoded-length"];
			const caughtCode = plantedCode.filter((r) => (br[r] ?? 0) >= 1);
			sys.info.code = { plantedRecall: +(caughtCode.length / plantedCode.length).toFixed(3), missed: plantedCode.filter((r) => !caughtCode.includes(r)), falseErrorsOnGood: g.counts?.errors ?? 0 };
			check(sys, "code.bad-fails", b.pass === false, { summary: `score ${b.score}` });
			check(sys, "code.planted-recall", caughtCode.length === plantedCode.length, { summary: `${caughtCode.length}/${plantedCode.length} planted violations caught${caughtCode.length < plantedCode.length ? ` — missed ${plantedCode.filter((r) => !caughtCode.includes(r)).join(", ")}` : ""}` });
		} else {
			check(sys, "code.good-passes", false, { summary: `couldn't build probe (pairs ${codeNames.length}, token ${firstToken})` });
		}
		if (cfg.appDir && existsSync(cfg.appDir)) {
			const fs = await import("node:fs");
			const files = fs.readdirSync(cfg.appDir, { recursive: true }).filter((f) => /\.(tsx|jsx|css)$/.test(f)).map((f) => join(cfg.appDir, f));
			const app = await call("figma_audit_code_adherence", { files, designSystem: { packages: [cfg.package], componentsDir: cfg.componentsDir, tokensPath: cfg.tokensPath } });
			sys.info.realApp = { files: files.length, score: app.score, pass: app.pass, byRule: app.counts?.byRule, componentsUsed: app.componentsUsed };
			check(sys, "code.real-app-runs", !app.__isError && typeof app.score === "number", { summary: `${files.length} files: score ${app.score}, ${JSON.stringify(app.counts?.byRule)}` });
		}
	} catch (err) {
		check(sys, "harness", false, { summary: String(err?.message ?? err) });
	} finally {
		const cleanup = await exec(
			cfg.fileKey,
			`await figma.loadAllPagesAsync();
// Remove ONLY the page this run created (by id, and only if it still has this run's name).
const p = ${JSON.stringify(pageId ?? null)} ? await figma.getNodeByIdAsync(${JSON.stringify(pageId ?? "")}) : null;
if (p && p.type === "PAGE" && p.name === ${JSON.stringify(TEMP_PAGE)} && figma.root.children.length > 1) {
  if (figma.currentPage === p) await figma.setCurrentPageAsync(figma.root.children.find(x => x !== p));
  p.remove();
}
return figma.root.children.filter(x => x.name === ${JSON.stringify(TEMP_PAGE)}).length;`,
		);
		check(sys, "cleanup", cleanup === 0, { summary: cleanup === 0 ? "temporary page removed" : "temporary page left behind!" });
		await call("figma_navigate", { url: `https://www.figma.com/design/${cfg.fileKey}/x`, lock: false });
	}
}

log("\n=== Precision / recall");
for (const s of report.systems) {
	const r = s.info.resolve, a = s.info.audit, c = s.info.code;
	log(`${s.name.padEnd(14)} resolve P ${r ? (r.precision * 100).toFixed(0) : "-"}% R ${r ? (r.recall * 100).toFixed(0) : "-"}% (deferred ${r ? (r.deferralRate * 100).toFixed(0) : "-"}%, gold ${r?.gold}, decoys ${r?.decoys}) | audit recall ${a ? (a.plantedRecall * 100).toFixed(0) : "-"}%, false errors ${a?.falseErrorsOnGood} | code recall ${c ? (c.plantedRecall * 100).toFixed(0) : "-"}%, false errors ${c?.falseErrorsOnGood}`);
}
const all = report.systems.flatMap((s) => s.checks);
report.summary = { pass: all.filter((c) => c.pass).length, fail: all.filter((c) => !c.pass).length };
log(`\n=== ${report.summary.pass} passed, ${report.summary.fail} failed`);
if (outFile) writeFileSync(outFile, JSON.stringify(report, null, 2));
await client.close();
process.exit(report.summary.fail ? 1 : 0);
