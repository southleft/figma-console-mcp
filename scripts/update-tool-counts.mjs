#!/usr/bin/env node
/**
 * Tool-count updater + self-audit for release docs.
 *
 * Replaces scripts/release.sh's sed-regex approach for tool counts, which
 * shipped wrong-mode counts in three consecutive releases (v1.33.0, v1.33.1,
 * v1.34.0). sed had no way to know which MODE a bare "N tools" belonged to,
 * so generic rules clobbered Remote/Local slots with the Cloud count and
 * anchored "corrective" rules never covered every spot.
 *
 * This script knows the mode of every count reference explicitly via MANIFEST:
 * each entry is { file, mode, pattern, expect } where pattern is LITERAL text
 * with a {{N}} placeholder for the count. No lookbehind games, no ordering
 * dependencies — each spot gets exactly its mode's number.
 *
 * Usage:
 *   node scripts/update-tool-counts.mjs                # apply + verify
 *   node scripts/update-tool-counts.mjs --dry-run      # show changes only
 *   node scripts/update-tool-counts.mjs --verify       # audit only (Phase 3.5 Block D); exit 1 on any inconsistency
 *   node scripts/update-tool-counts.mjs --local 107 --remote 9 --cloud 96   # override auto-detection
 *
 * Verify mode checks two things:
 *   1. Every MANIFEST entry matches exactly `expect` times and carries its
 *      mode's count.
 *   2. A sweep of every covered file for numeric tool-count shapes finds NO
 *      reference that isn't accounted for by the manifest or ALLOWLIST.
 *      A new doc sentence with a count fails verify until it's classified —
 *      that's the point.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Auto-detection (mirrors release.sh's auto_count_* functions) ────────────

const TOOL_NAME_RE = /"fig(?:ma|jam)_[a-z_]+"/g;

function tsFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFilesUnder(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function countUniqueToolNames(files, re = TOOL_NAME_RE) {
  const names = new Set();
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(re)) names.add(m[0]);
  }
  return names.size;
}

function detectLocal() {
  // Mirror release.sh auto_count_local: unique figma_*/figjam_* names in
  // core + local.ts, plus server.tool() names inside MCP App modules.
  const core = countNames([...tsFilesUnder(join(ROOT, "src/core")), join(ROOT, "src/local.ts")]);
  for (const f of tsFilesUnder(join(ROOT, "src/apps"))) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/server\.tool\(\s*\n?\s*("fig(?:ma|jam)_[a-z_]+")/g)) core.add(m[1]);
  }
  return core.size;
}

function countNames(files, re = TOOL_NAME_RE) {
  const names = new Set();
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(re)) names.add(m[0]);
  }
  return names;
}

function detectRemote() {
  // Remote/SSE mode (no plugin pairing): REST-backed read tools in figma-tools.ts
  return countUniqueToolNames([join(ROOT, "src/core/figma-tools.ts")], /"figma_[a-z_]+"/g);
}

function detectCloud() {
  // Cloud Mode after pairing: every registrar invoked by src/index.ts plus its
  // own direct registrations. Mirror the register*() calls in src/index.ts.
  const files = [
    "src/core/write-tools.ts",
    "src/core/figma-tools.ts",
    "src/core/design-system-tools.ts",
    "src/core/comment-tools.ts",
    "src/core/design-code-tools.ts",
    "src/core/figjam-tools.ts",
    "src/core/slides-tools.ts",
    "src/core/annotation-tools.ts",
    "src/core/deep-component-tools.ts",
    "src/core/version-tools.ts",
    "src/core/accessibility-tools.ts",
    "src/core/diagnose-tool.ts",
    "src/core/tokens-tools.ts",
    "src/core/slot-tools.ts",
    "src/index.ts",
  ].map((f) => join(ROOT, f));
  return countUniqueToolNames(files);
}

// ── Manifest ────────────────────────────────────────────────────────────────
// pattern: LITERAL text; {{N}} marks the count (digits, optionally followed by
// a literal + written in the pattern itself, e.g. "{{N}}+ tools").
// expect: exact number of occurrences in the file. When docs prose changes,
// verify fails loudly and this list must be updated — deliberate.

const MANIFEST = [
  // README.md
  { file: "README.md", mode: "remote", pattern: "read-only** with {{N}} tools", expect: 1 },
  { file: "README.md", mode: "cloud", pattern: "write access ({{N}} tools)", expect: 1 },
  { file: "README.md", mode: "local", pattern: "full {{N}} tools", expect: 2 }, // bottom-line + key-insight blockquotes
  { file: "README.md", mode: "local", pattern: "All {{N}} tools including", expect: 1 },
  { file: "README.md", mode: "local", pattern: "All {{N}} tools work through", expect: 1 },
  { file: "README.md", mode: "local", pattern: "Same {{N}} tools as NPX", expect: 1 },
  { file: "README.md", mode: "cloud", pattern: "{{N}} tools including full write", expect: 1 },
  { file: "README.md", mode: "remote", pattern: "{{N}} read-only tools", expect: 1 },
  { file: "README.md", mode: "local", pattern: "**{{N}} tools** (Local)", expect: 1 }, // roadmap Current Status
  { file: "README.md", mode: "cloud", pattern: "**{{N}} tools** (Cloud)", expect: 1 },
  { file: "README.md", mode: "remote", pattern: "**{{N}} tools** (Remote read-only)", expect: 1 },

  // docs/architecture.md
  { file: "docs/architecture.md", mode: "local", pattern: "All {{N}} tools work through", expect: 2 },
  { file: "docs/architecture.md", mode: "local", pattern: "({{N}} tools in Local Mode", expect: 1 },
  { file: "docs/architecture.md", mode: "remote", pattern: ", {{N}} in Remote Mode", expect: 1 },

  // docs/mode-comparison.md
  { file: "docs/mode-comparison.md", mode: "remote", pattern: "read-only ({{N}} tools)", expect: 1 },
  { file: "docs/mode-comparison.md", mode: "cloud", pattern: "write access ({{N}} tools)", expect: 1 },
  { file: "docs/mode-comparison.md", mode: "local", pattern: "everything ({{N}} tools)", expect: 1 },
  { file: "docs/mode-comparison.md", mode: "local", pattern: "**All {{N}} tools** including design creation", expect: 2 },
  { file: "docs/mode-comparison.md", mode: "local", pattern: "All {{N}} tools including design creation", expect: 1 }, // plain (summary bullet)
  { file: "docs/mode-comparison.md", mode: "cloud", pattern: "**{{N}} tools** — full write access", expect: 1 },
  { file: "docs/mode-comparison.md", mode: "remote", pattern: "Only {{N}} tools", expect: 1 },
  { file: "docs/mode-comparison.md", mode: "remote", pattern: "{{N}} read-only tools", expect: 1 },
  { file: "docs/mode-comparison.md", mode: "cloud", pattern: "{{N}} tools available after pairing", expect: 1 },
  { file: "docs/mode-comparison.md", mode: "local", pattern: "All {{N}} tools work through", expect: 2 }, // WebSocket + WebSocket transport
  { file: "docs/mode-comparison.md", mode: "cloud", pattern: "{{N}} tools with full write access", expect: 1 },
  { file: "docs/mode-comparison.md", mode: "local", pattern: "Full {{N}} tools including real-time", expect: 1 },
  { file: "docs/mode-comparison.md", mode: "cloud", pattern: "{{N}} tools are available", expect: 1 },
  { file: "docs/mode-comparison.md", mode: "remote", pattern: "**Remote (read-only):** {{N}} tools", expect: 1 },
  { file: "docs/mode-comparison.md", mode: "cloud", pattern: "**Cloud Mode:** {{N}} tools", expect: 1 },
  { file: "docs/mode-comparison.md", mode: "local", pattern: "**Local Mode (NPX/Git):** {{N}} tools", expect: 1 },

  // docs/introduction.md
  { file: "docs/introduction.md", mode: "local", pattern: "Get all {{N}} tools", expect: 1 },
  { file: "docs/introduction.md", mode: "cloud", pattern: "write access ({{N}} tools)", expect: 1 },
  { file: "docs/introduction.md", mode: "remote", pattern: "read-only ({{N}} tools)", expect: 1 },
  { file: "docs/introduction.md", mode: "remote", pattern: "read-only** ({{N}} tools)", expect: 1 }, // wrote Cloud's count here in v1.34.0
  { file: "docs/introduction.md", mode: "local", pattern: "Complete reference for {{N}} tools", expect: 1 },

  // docs/setup.md
  { file: "docs/setup.md", mode: "remote", pattern: "read-only** with {{N}} tools", expect: 1 },
  { file: "docs/setup.md", mode: "cloud", pattern: "write access** ({{N}} tools)", expect: 1 },
  { file: "docs/setup.md", mode: "local", pattern: "everything** ({{N}} tools)", expect: 1 }, // wrote Cloud's count here in v1.34.0
  { file: "docs/setup.md", mode: "local", pattern: "All {{N}} tools including", expect: 1 },
  { file: "docs/setup.md", mode: "local", pattern: "Same {{N}} tools as NPX", expect: 1 },
  { file: "docs/setup.md", mode: "cloud", pattern: "{{N}} tools — full write access", expect: 1 },
  { file: "docs/setup.md", mode: "remote", pattern: "{{N}} read-only tools", expect: 1 },

  // docs/use-cases.md
  { file: "docs/use-cases.md", mode: "local", pattern: "all {{N}} tools", expect: 1 },

  // docs/index.mdx (setup cards + tools card)
  { file: "docs/index.mdx", mode: "local", pattern: "Full capabilities — {{N}} tools", expect: 1 },
  { file: "docs/index.mdx", mode: "cloud", pattern: "Web AI clients — {{N}} tools", expect: 1 },
  { file: "docs/index.mdx", mode: "remote", pattern: "Quick exploration — {{N}} tools", expect: 1 },
  { file: "docs/index.mdx", mode: "local", pattern: "Complete reference for {{N}} tools", expect: 1 },

  // docs/tools.md (top note covers all three modes in one sentence)
  { file: "docs/tools.md", mode: "local", pattern: "**{{N}} tools** with full read/write", expect: 1 },
  { file: "docs/tools.md", mode: "remote", pattern: "**{{N}} read-only tools**", expect: 1 },
  { file: "docs/tools.md", mode: "cloud", pattern: "**{{N}} tools** (including full write access)", expect: 1 },

  // docs/mint.json (og:description)
  { file: "docs/mint.json", mode: "local", pattern: "{{N}} tools give AI assistants", expect: 1 },

  // docs/figma-mcp-vs-figma-console-mcp.md
  { file: "docs/figma-mcp-vs-figma-console-mcp.md", mode: "local", pattern: "{{N}} tools. Plugin API + REST API", expect: 1 },
  { file: "docs/figma-mcp-vs-figma-console-mcp.md", mode: "cloud", pattern: "Yes ({{N}} tools)", expect: 1 },
  { file: "docs/figma-mcp-vs-figma-console-mcp.md", mode: "local", pattern: "Full {{N}} tool access", expect: 1 }, // shipped stale (106) in v1.34.0

  // src/index.ts (landing page HTML + meta descriptions — Local count with +)
  { file: "src/index.ts", mode: "local", pattern: "{{N}}+ tools give AI assistants", expect: 3 },
  { file: "src/index.ts", mode: "local", pattern: '"number">{{N}}+<', expect: 1 },
];

// Intentional counts the sweep must NOT flag (historical or third-party).
// Same {file, pattern-literal} shape, without {{N}}.
const ALLOWLIST = [
  { file: "README.md", pattern: "15 tools for managing presentations" }, // v1.17.0 roadmap entry (historical)
  { file: "README.md", pattern: "9 tools for creating and reading FigJam boards" }, // v1.16.0 roadmap entry (historical)
  { file: "docs/figma-mcp-vs-figma-console-mcp.md", pattern: "16 tools. REST API" }, // Figma's NATIVE MCP tool count, not ours
  { file: "docs/figma-mcp-vs-figma-console-mcp.md", pattern: "7 tools, Local Mode" }, // v1.40.0 DS-extraction feature-specific count (not a mode count)
];

// Sweep shapes: any numeric tool-count reference in a covered file must be
// classified by MANIFEST or ALLOWLIST, or verify fails.
const SWEEP_RES = [
  /\d{1,3}\+? ?(?:read-only )?tools?\b/g,
  /"number">\d{1,3}\+?</g,
  /\d{1,3} in Remote\b/g,
];

// ── Helpers ─────────────────────────────────────────────────────────────────

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function entryRegex(pattern) {
  return new RegExp(pattern.split("{{N}}").map(escapeRe).join("(\\d{1,3})"), "g");
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? Number(args[i + 1]) : null;
};
const VERIFY_ONLY = args.includes("--verify");
const DRY_RUN = args.includes("--dry-run");

const counts = {
  local: flag("--local") ?? detectLocal(),
  remote: flag("--remote") ?? detectRemote(),
  cloud: flag("--cloud") ?? detectCloud(),
};

console.log(`Tool counts: local=${counts.local} cloud=${counts.cloud} remote=${counts.remote}`);

const files = [...new Set(MANIFEST.map((e) => e.file))];
const contents = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));

// ── Apply ───────────────────────────────────────────────────────────────────

if (!VERIFY_ONLY) {
  let replaced = 0;
  for (const entry of MANIFEST) {
    const re = entryRegex(entry.pattern);
    const want = String(counts[entry.mode]);
    let changed = 0;
    const next = contents.get(entry.file).replace(re, (whole, num) => {
      if (num === want) return whole;
      changed++;
      return entry.pattern.replace("{{N}}", want);
    });
    if (changed > 0) {
      contents.set(entry.file, next);
      replaced += changed;
      console.log(`  ${DRY_RUN ? "WOULD" : "DONE"} ${entry.file} — "${entry.pattern}" → ${want} (${changed})`);
    }
  }
  if (!DRY_RUN) {
    for (const [f, text] of contents) writeFileSync(join(ROOT, f), text);
  }
  console.log(`${DRY_RUN ? "Dry run:" : "Applied:"} ${replaced} replacement(s)`);
}

// ── Verify (runs after apply too, against the updated content) ─────────────

const errors = [];
// Ranges accounted for, per file: [start, end)
const covered = new Map(files.map((f) => [f, []]));

for (const entry of MANIFEST) {
  const text = contents.get(entry.file);
  const matches = [...text.matchAll(entryRegex(entry.pattern))];
  for (const m of matches) {
    covered.get(entry.file).push([m.index, m.index + m[0].length]);
    if (Number(m[1]) !== counts[entry.mode]) {
      errors.push(
        `${entry.file}: "${m[0]}" — has ${m[1]}, expected ${counts[entry.mode]} (${entry.mode})`
      );
    }
  }
  if (matches.length !== entry.expect) {
    errors.push(
      `${entry.file}: pattern "${entry.pattern}" matched ${matches.length}x, expected ${entry.expect}x — ` +
        `doc prose changed; update MANIFEST in scripts/update-tool-counts.mjs`
    );
  }
}

for (const allow of ALLOWLIST) {
  const text = contents.get(allow.file);
  if (!text) continue;
  const re = new RegExp(escapeRe(allow.pattern), "g");
  for (const m of text.matchAll(re)) {
    covered.get(allow.file).push([m.index, m.index + m[0].length]);
  }
}

for (const f of files) {
  const text = contents.get(f);
  const ranges = covered.get(f);
  for (const sweepRe of SWEEP_RES) {
    for (const m of text.matchAll(new RegExp(sweepRe.source, "g"))) {
      const [s, e] = [m.index, m.index + m[0].length];
      const accounted = ranges.some(([cs, ce]) => s < ce && e > cs);
      if (!accounted) {
        const line = text.slice(0, s).split("\n").length;
        errors.push(
          `${f}:${line}: unclassified tool-count reference "${m[0]}" — ` +
            `add it to MANIFEST (with its mode) or ALLOWLIST in scripts/update-tool-counts.mjs`
        );
      }
    }
  }
}

if (errors.length > 0) {
  console.error(`\nVERIFY FAILED — ${errors.length} inconsistency(ies):`);
  for (const err of errors) console.error(`  ✗ ${err}`);
  process.exit(1);
}
console.log(`Verify passed: ${MANIFEST.length} manifest entries consistent, no unclassified counts.`);
