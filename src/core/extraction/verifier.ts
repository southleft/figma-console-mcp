/**
 * Deterministic fidelity evals for an extracted design system. Every check
 * encodes a failure class found during real extraction runs — this is the
 * governance gate that says "this Storybook is an exact, importable mirror
 * of the source app's design decisions", run before handing the package to
 * the client or pushing tokens into Figma.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DsAnalysis, DsStatusManifest } from "./types.js";

export interface VerifyCheck {
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  details: string[];
}

export interface VerifyReport {
  passed: boolean;
  checks: VerifyCheck[];
  figmaRoundTrip: {
    ready: boolean;
    how: string[];
  };
}

function stripCssComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "");
}

export async function verifyExtraction(
  outDir: string,
  analysis: DsAnalysis | null,
  status: DsStatusManifest | null,
): Promise<VerifyReport> {
  const checks: VerifyCheck[] = [];
  const add = (
    name: string,
    ok: boolean | "warn" | "skip",
    details: string[] = [],
  ) =>
    checks.push({
      name,
      status: ok === true ? "pass" : ok === false ? "fail" : ok,
      details: details.slice(0, 20),
    });

  // ---- 1. Canonical DTCG parses + alias integrity --------------------------
  const tokensPath = join(outDir, "tokens", "tokens.json");
  let doc = null;
  if (existsSync(tokensPath)) {
    try {
      const { parseDtcg } = await import("../tokens/parsers/dtcg.js");
      doc = parseDtcg({
        payload: readFileSync(tokensPath, "utf-8"),
        sourcePath: tokensPath,
      }).document;
      add("tokens.json parses as DTCG (figma_import_tokens compatible)", true, [
        `${doc.sets.length} collection(s), ${doc.sets.reduce((n, s) => n + s.tokens.length, 0)} tokens, modes: ${doc.sets[0]?.modes.join("/") ?? "-"}`,
      ]);
      const { validateAliases } = await import("../tokens/alias-resolver.js");
      const problems = validateAliases(doc);
      add(
        "alias references all resolve (no dangling {refs})",
        problems.length === 0,
        problems,
      );
    } catch (e) {
      add("tokens.json parses as DTCG", false, [String(e)]);
    }
  } else {
    add("tokens.json exists", false, ["Run figma_ds_extract_tokens."]);
  }

  // ---- 2. No quoted CSS expressions in generated outputs -------------------
  const cssTargets = ["tokens/tokens.css", "tokens/theme.css", "tokens/_tokens.scss"]
    .map((f) => join(outDir, f))
    .filter(existsSync);
  const quoted: string[] = [];
  for (const f of cssTargets) {
    for (const m of readFileSync(f, "utf-8").matchAll(
      /--[\w-]+:\s*["'][a-zA-Z-]+\(/g,
    )) {
      quoted.push(`${f.split("/").pop()}: ${m[0]}…`);
    }
  }
  add(
    "no quoted CSS functional expressions in generated token files",
    quoted.length === 0,
    quoted,
  );

  // ---- 3. Every var() consumed in the workshop resolves --------------------
  const componentsDir = join(outDir, "src", "components");
  const cssFiles: string[] = [];
  const collect = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) collect(p);
      else if (e.name.endsWith(".css")) cssFiles.push(p);
    }
  };
  collect(componentsDir);
  const previewCss = join(outDir, ".storybook", "preview.css");
  if (existsSync(previewCss)) cssFiles.push(previewCss);

  const defined = new Set<string>();
  for (const f of [...cssTargets, ...cssFiles]) {
    for (const m of stripCssComments(readFileSync(f, "utf-8")).matchAll(
      /--([\w-]+)\s*:/g,
    ))
      defined.add(m[1]);
  }
  const unresolved: string[] = [];
  for (const f of cssFiles) {
    for (const m of stripCssComments(readFileSync(f, "utf-8")).matchAll(
      /var\(\s*--([\w-]+)\s*\)/g,
    )) {
      if (!defined.has(m[1]))
        unresolved.push(`--${m[1]} (${f.slice(outDir.length + 1)})`);
    }
  }
  add(
    "every var() without a fallback resolves in the workshop",
    unresolved.length === 0,
    [...new Set(unresolved)],
  );

  // ---- 4. Component structure: stories + index per component --------------
  const structureGaps: string[] = [];
  let componentDirs = 0;
  if (existsSync(componentsDir)) {
    for (const e of readdirSync(componentsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      componentDirs++;
      const files = readdirSync(join(componentsDir, e.name));
      if (!files.some((f) => f.includes(".stories.")))
        structureGaps.push(`${e.name}: no stories file`);
      if (!files.some((f) => /^index\.(js|jsx|ts|tsx)$/.test(f)))
        structureGaps.push(`${e.name}: no index barrel`);
    }
  }
  add(
    `component structure (${componentDirs} dirs: stories + index barrel)`,
    componentDirs === 0 ? "skip" : structureGaps.length === 0,
    structureGaps,
  );

  // ---- 5. Porting coverage vs inventory ------------------------------------
  if (analysis && status) {
    const unaccounted = analysis.components
      .filter((c) => c.classification !== "pure-vendor")
      .filter((c) => !status.components[c.name])
      .map((c) => c.name);
    const counts: Record<string, number> = {};
    for (const e of Object.values(status.components))
      counts[e.status] = (counts[e.status] ?? 0) + 1;
    add(
      "every portable inventory component has a porting status",
      unaccounted.length === 0 ? true : "warn",
      [
        `status: ${JSON.stringify(counts)}`,
        ...unaccounted.map((n) => `unaccounted: ${n}`),
      ],
    );
  } else {
    add("porting coverage", "skip", ["analysis or status manifest missing"]);
  }

  const passed = checks.every((c) => c.status !== "fail");
  const pending =
    status &&
    Object.values(status.components).some(
      (e) => e.status === "pending" || e.status === "in-progress",
    );

  return {
    passed,
    checks,
    figmaRoundTrip: {
      ready: passed && existsSync(tokensPath),
      how: [
        "Ask the user: code-led (stop at this Storybook package) or design-led (mirror into Figma)?",
        `Design-led step 1 — tokens → Figma variables: figma_import_tokens { files: ["${tokensPath}"], strategy: "dry-run" } to preview, then "merge" to apply. Collections + modes come across as-is.`,
        "Design-led step 2 — components → Figma component sets: use the figma-generate-library / prototype-to-figma workflows with figma_create_component_set + figma_execute, binding fills/strokes/radii to the imported variables.",
        ...(pending
          ? ["Note: some components are still pending/in-progress — finish or skip them before the Figma leg so the canvas mirrors a complete set."]
          : []),
      ],
    },
  };
}
