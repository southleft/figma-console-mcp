/**
 * Scaffolds the design-system/ package: package skeleton, token files (via the
 * shared formatter engine), a token-showcase docs page, and CSF3 story
 * scaffolds. Storybook itself is installed by the agent running
 * `npm create storybook@latest` inside the package — its CLI detects the
 * renderer/builder and always produces current-version config, so we never
 * bake version-pinned Storybook templates that rot.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { TokenDocument, Token } from "../tokens/types.js";
import { format } from "../tokens/formatters/index.js";
import type { OutputTarget } from "../tokens/config.js";
import type {
  DsAnalysis,
  DsComponentEntry,
  DsFramework,
  DsIconEntry,
  DsTypographyRule,
} from "./types.js";

export interface ScaffoldOptions {
  outDir: string;
  packageName: string;
  framework: DsFramework;
  /** Token output formats beyond canonical DTCG. */
  formats: Array<OutputTarget["format"]>;
  dtcgDialect?: "legacy" | "2025";
  /** Overwrite files that already exist (default: false — additive only). */
  force?: boolean;
}

export interface ScaffoldResult {
  filesWritten: string[];
  filesSkipped: string[];
  warnings: string[];
  nextSteps: string[];
}

function write(
  outDir: string,
  relPath: string,
  content: string,
  result: ScaffoldResult,
  force: boolean,
): void {
  const abs = join(outDir, relPath);
  if (existsSync(abs) && !force) {
    result.filesSkipped.push(relPath);
    return;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  result.filesWritten.push(relPath);
}

const FRAMEWORK_PEERS: Record<DsFramework, Record<string, string>> = {
  react: { react: ">=18", "react-dom": ">=18" },
  next: { react: ">=18", "react-dom": ">=18" },
  // Storybook has no .astro renderer — the workshop runs on react-vite and
  // stories mirror the component markup; sources stay documented as .astro.
  astro: {},
  angular: { "@angular/core": ">=17", "@angular/common": ">=17" },
  "web-components": { lit: ">=3" },
  vue: { vue: ">=3" },
  svelte: { svelte: ">=4" },
  unknown: {},
};

/**
 * Dev dependencies the scaffold pre-installs so `npm create storybook@latest`
 * can auto-detect the renderer AND the builder. Without a bundler in the
 * package, the Storybook CLI stalls on an interactive "select your builder"
 * prompt even with --yes (learned from the first live run).
 */
const FRAMEWORK_DEV_DEPS: Record<DsFramework, Record<string, string>> = {
  react: { react: "^18.3.0", "react-dom": "^18.3.0", vite: "^7.0.0" },
  next: { react: "^18.3.0", "react-dom": "^18.3.0", vite: "^7.0.0" },
  astro: { react: "^18.3.0", "react-dom": "^18.3.0", vite: "^7.0.0" },
  angular: {}, // Angular needs its own workspace tooling — CLI handles it
  "web-components": { lit: "^3.0.0", vite: "^7.0.0" },
  vue: { vue: "^3.4.0", vite: "^7.0.0" },
  svelte: { svelte: "^4.0.0", vite: "^7.0.0" },
  unknown: { vite: "^7.0.0" },
};

export function scaffoldDesignSystem(
  analysis: DsAnalysis,
  document: TokenDocument,
  opts: ScaffoldOptions,
): ScaffoldResult {
  const result: ScaffoldResult = {
    filesWritten: [],
    filesSkipped: [],
    warnings: [],
    nextSteps: [],
  };
  const force = opts.force ?? false;

  // ---- package.json --------------------------------------------------------
  const pkg = {
    name: opts.packageName,
    version: "0.1.0",
    private: true,
    type: "module",
    description:
      "Design system extracted from production application(s) by figma-console-mcp. Components live in src/components; design tokens in tokens/.",
    files: ["dist", "tokens"],
    peerDependencies: FRAMEWORK_PEERS[opts.framework],
    devDependencies: {
      ...FRAMEWORK_DEV_DEPS[opts.framework],
      // Tailwind apps: the workshop preset injects the @tailwindcss/vite
      // plugin into .storybook/main.js — the packages must exist (found
      // live: ERR_MODULE_NOT_FOUND killed the build without them).
      ...(analysis.targets.some((t) =>
        t.stylingMethods.some((s) => s.startsWith("tailwind")),
      )
        ? { tailwindcss: "^4.0.0", "@tailwindcss/vite": "^4.0.0" }
        : {}),
    },
    scripts: {
      // storybook/build scripts are added by `npm create storybook@latest`.
    },
  };
  write(opts.outDir, "package.json", `${JSON.stringify(pkg, null, 2)}\n`, result, force);

  // ---- token files via the shared formatter engine -------------------------
  const targets: OutputTarget[] = [
    { format: "dtcg", filename: "tokens/tokens.json", dtcgDialect: opts.dtcgDialect },
    ...opts.formats
      .filter((f) => f !== "dtcg")
      .map((f): OutputTarget => ({
        format: f,
        filename: TOKEN_FILENAMES[f],
        dtcgDialect: opts.dtcgDialect,
      })),
  ];
  for (const target of targets) {
    try {
      const formatted = format(document, { target, projectRoot: opts.outDir });
      result.warnings.push(...formatted.warnings);
      for (const file of formatted.files) {
        write(opts.outDir, file.path, file.content, result, true); // tokens always refresh
      }
    } catch (e) {
      result.warnings.push(
        `Format ${target.format} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ---- aggregate CSS entry (imported by .storybook/preview after init) -----
  if (opts.formats.includes("css-vars") || opts.formats.includes("tailwind-v4")) {
    const imports = [
      opts.formats.includes("css-vars") ? '@import "./tokens.css";' : null,
      opts.formats.includes("tailwind-v4") ? '@import "./theme.css";' : null,
    ]
      .filter(Boolean)
      .join("\n");
    write(opts.outDir, "tokens/index.css", `${imports}\n`, result, force);
  }

  // ---- src layout ----------------------------------------------------------
  write(
    opts.outDir,
    "src/components/README.md",
    "# Components\n\nOne directory per component: `ComponentName/ComponentName.{ext}`, `ComponentName.stories.{ext}`, `index.{ext}`.\n\nPorted from the source application(s) by the design-system-extraction workflow — see `.extraction/analysis.json` for the inventory and `.extraction/status.json` for progress.\n",
    result,
    force,
  );

  // ---- showcases (framework-neutral MDX docs pages) ------------------------
  // Regenerated on every scaffold run so they track the latest extraction.
  write(
    opts.outDir,
    "src/docs/Tokens.mdx",
    generateTokenShowcaseMdx(document),
    result,
    true,
  );
  const typographyRules = analysis.targets.flatMap((t) => t.typography ?? []);
  write(
    opts.outDir,
    "src/docs/Typography.mdx",
    generateTypographyShowcaseMdx(document, typographyRules),
    result,
    true,
  );
  const iconEntries = analysis.targets.flatMap((t, i) =>
    (t.icons ?? []).map((icon) => ({ icon, root: analysis.targets[i].root })),
  );
  if (iconEntries.length > 0) {
    write(
      opts.outDir,
      "src/docs/Icons.mdx",
      generateIconShowcaseMdx(iconEntries),
      result,
      true,
    );
  }

  // ---- README --------------------------------------------------------------
  write(opts.outDir, "README.md", generateReadme(analysis, opts), result, force);

  result.nextSteps.push(
    `cd ${opts.outDir} && npm install && npm create storybook@latest -- --yes --no-dev  (CLI auto-detects ${opts.framework} + vite from the pre-installed devDependencies)`,
    'After init, import "../tokens/index.css" (or tokens.css) in .storybook/preview to load tokens in every story.',
    "Ensure .storybook/main includes src/**/*.mdx in its stories globs so the token showcase appears.",
    "Port components in ranked order — use figma_ds_extract_component per component, then figma_ds_status to record progress.",
  );

  return result;
}

const TOKEN_FILENAMES: Partial<Record<OutputTarget["format"], string>> = {
  "css-vars": "tokens/tokens.css",
  "tailwind-v4": "tokens/theme.css",
  "tailwind-v3": "tokens/tailwind.tokens.js",
  scss: "tokens/_tokens.scss",
  "ts-module": "tokens/tokens.ts",
  "json-nested": "tokens/tokens.nested.json",
  "json-flat": "tokens/tokens.flat.json",
  "tokens-studio": "tokens/tokens-studio.json",
  "style-dictionary-v3": "tokens/style-dictionary.json",
};

// ---------------------------------------------------------------------------
// Token showcase MDX
// ---------------------------------------------------------------------------

function firstLiteral(token: Token): string {
  const value = Object.values(token.values)[0];
  if (!value) return "";
  if (value.reference) return `{${value.reference}}`;
  return typeof value.literal === "object"
    ? JSON.stringify(value.literal)
    : String(value.literal ?? "");
}

function mdxEscape(s: string): string {
  return s.replace(/[{<]/g, (c) => (c === "{" ? "&#123;" : "&lt;"));
}

/**
 * Resolve a token's display value, following alias chains across every set
 * (max depth 6). Returns both the resolved literal and the immediate
 * reference (for "→ target" captions on aliases).
 */
function makeResolver(document: TokenDocument) {
  const byPath = new Map<string, Token>();
  for (const set of document.sets) {
    for (const t of set.tokens) byPath.set(t.path.join("."), t);
  }
  return (token: Token): { resolved: string; via?: string } => {
    let current: Token | undefined = token;
    let via: string | undefined;
    for (let depth = 0; depth < 6 && current; depth++) {
      const value = Object.values(current.values)[0];
      if (!value) break;
      if (value.reference !== undefined) {
        // References parsed back from DTCG carry braces ("{a.b.c}"); fresh
        // in-memory documents don't. Normalize before the map lookup.
        const ref = value.reference.replace(/^\{|\}$/g, "");
        via = via ?? ref;
        current = byPath.get(ref);
        continue;
      }
      const literal =
        typeof value.literal === "object"
          ? JSON.stringify(value.literal)
          : String(value.literal ?? "");
      return { resolved: literal, via };
    }
    return { resolved: via ? `{${via}}` : "", via };
  };
}

/** Parse "12px" / "0.5rem" / "16" into approximate px for proportional bars. */
function approxPx(value: string): number | null {
  const m = /^(-?\d*\.?\d+)(px|rem|em)?$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "rem" || m[2] === "em" ? n * 16 : n;
}

/** Tiny SVG easing-curve preview for cubic-bezier(x1, y1, x2, y2) values. */
function easingCurveSvg(value: string): string | null {
  const m =
    /^cubic-bezier\(\s*(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s]+(-?[\d.]+)\s*\)$/.exec(
      value.trim(),
    );
  if (!m) return null;
  const [x1, y1, x2, y2] = [m[1], m[2], m[3], m[4]].map(Number);
  const S = 40;
  const px = (x: number) => (x * S).toFixed(1);
  const py = (y: number) => (S - y * S).toFixed(1);
  return (
    `<svg width={${S}} height={${S}} viewBox="0 0 ${S} ${S}" style={{ overflow: "visible" }}>` +
    `<rect width={${S}} height={${S}} fill="none" stroke="#8886" rx={4} />` +
    `<path d="M 0 ${S} C ${px(x1)} ${py(y1)}, ${px(x2)} ${py(y2)}, ${S} 0" fill="none" stroke="var(--sl-accent, #f05735)" strokeWidth={2} />` +
    `</svg>`
  );
}

const ROW_STYLE =
  '{ display: "flex", alignItems: "center", gap: 14, padding: "4px 0", fontSize: 12, fontFamily: "monospace" }';
const NAME_STYLE = '{ minWidth: 250, flexShrink: 0 }';
const VALUE_STYLE = '{ opacity: 0.7, marginLeft: "auto", textAlign: "right" }';

/**
 * Static MDX docs page: values are baked in (no runtime JSON import to
 * configure) and the file is regenerated whenever tokens are re-extracted.
 * Every token type renders VISUALLY — resolved swatches for colors (aliases
 * follow their chain), proportional bars for dimensions/durations, live
 * radius/shadow tiles, easing curves — never a bare name/value table.
 */
export function generateTokenShowcaseMdx(document: TokenDocument): string {
  const resolve = makeResolver(document);
  const lines: string[] = [
    "{/* Generated by figma_ds_scaffold — regenerate via the tool; do not hand-edit. */}",
    "",
    "import { Meta } from '@storybook/addon-docs/blocks';",
    "",
    '<Meta title="Design Tokens/Overview" />',
    "",
    "# Design Tokens",
    "",
    "Extracted from the production codebase. Structural names are as-mined; semantic names were layered on during review. Provenance for every token lives in `tokens/tokens.json` under `$extensions`.",
    "",
  ];

  const pushRow = (t: Token, middle: string, valueText: string) => {
    lines.push(
      `<div style={${ROW_STYLE}}><code style={${NAME_STYLE}}>${mdxEscape(t.path.join("/"))}</code>${middle}<span style={${VALUE_STYLE}}>${mdxEscape(valueText)}</span></div>`,
    );
  };

  for (const set of document.sets) {
    lines.push(`## ${set.name}`, "");
    if (set.description) lines.push(set.description, "");

    const byType = new Map<string, Token[]>();
    for (const t of set.tokens) {
      const list = byType.get(t.type) ?? [];
      list.push(t);
      byType.set(t.type, list);
    }

    for (const [type, tokens] of byType) {
      lines.push(`### ${type} (${tokens.length})`, "");

      if (type === "color") {
        lines.push(
          '<div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>',
        );
        for (const t of tokens) {
          const { resolved, via } = resolve(t);
          const caption = via ? `→ ${via}` : resolved;
          lines.push(
            `  <div style={{ width: 150 }}>`,
            `    <div style={{ height: 48, borderRadius: 6, border: "1px solid #8886", background: ${JSON.stringify(resolved || "transparent")} }} />`,
            `    <code style={{ fontSize: 11 }}>${mdxEscape(t.path.join("/"))}</code><br />`,
            `    <span style={{ fontSize: 11, opacity: 0.7 }}>${mdxEscape(caption)}</span>`,
            `  </div>`,
          );
        }
        lines.push("</div>", "");
        continue;
      }

      for (const t of tokens) {
        const { resolved, via } = resolve(t);
        const valueText = via ? `${resolved}  (→ ${via})` : resolved;
        const path = t.path.join("/");
        const px = approxPx(resolved);

        if (type === "dimension" && /radius/i.test(path) && px !== null) {
          // Radius: a tile with the real corner radius applied.
          pushRow(
            t,
            `<div style={{ width: 44, height: 32, borderRadius: ${JSON.stringify(resolved)}, background: "color-mix(in srgb, var(--sl-accent, #f05735) 30%, transparent)", border: "1.5px solid var(--sl-accent, #f05735)", flexShrink: 0 }} />`,
            valueText,
          );
        } else if (type === "dimension" && px !== null) {
          // Spacing/size: proportional bar (log-ish cap so 1360px fits).
          const bar = Math.max(3, Math.min(240, px));
          pushRow(
            t,
            `<div style={{ width: ${bar.toFixed(0)}, height: 10, borderRadius: 2, background: "var(--sl-accent, #f05735)", opacity: 0.75, flexShrink: 0 }} />`,
            valueText,
          );
        } else if (type === "shadow") {
          pushRow(
            t,
            `<div style={{ width: 44, height: 32, borderRadius: 6, background: "var(--sl-bg-raised, #fff)", boxShadow: ${JSON.stringify(resolved)}, flexShrink: 0 }} />`,
            valueText,
          );
        } else if (type === "duration") {
          const ms = /^(\d*\.?\d+)ms$/.exec(resolved.trim());
          const s = /^(\d*\.?\d+)s$/.exec(resolved.trim());
          const dur = ms ? Number(ms[1]) : s ? Number(s[1]) * 1000 : null;
          const bar = dur === null ? 3 : Math.max(4, Math.min(240, dur / 4));
          pushRow(
            t,
            `<div style={{ width: ${bar.toFixed(0)}, height: 10, borderRadius: 2, background: "var(--sl-link, #2e8bbd)", opacity: 0.75, flexShrink: 0 }} />`,
            valueText,
          );
        } else if (easingCurveSvg(resolved)) {
          pushRow(t, easingCurveSvg(resolved)!, valueText);
        } else if (type === "fontFamily") {
          pushRow(
            t,
            `<span style={{ fontFamily: ${JSON.stringify(resolved)}, fontSize: 22, lineHeight: 1, flexShrink: 0 }}>Ag</span>`,
            valueText,
          );
        } else if (/^clamp\(|^calc\(/.test(resolved) && /text|font|size/i.test(path)) {
          // Fluid type sizes: render a live specimen at the clamped size.
          pushRow(
            t,
            `<span style={{ fontSize: ${JSON.stringify(resolved)}, lineHeight: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 380 }}>Ag</span>`,
            valueText,
          );
        } else {
          pushRow(t, "", valueText);
        }
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Typography showcase MDX
// ---------------------------------------------------------------------------

function cssPropsToJsxStyle(props: Record<string, string>): string {
  const entries = Object.entries(props).map(([k, v]) => {
    const camel = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return `${camel}: ${JSON.stringify(v)}`;
  });
  return `{ ${entries.join(", ")} }`;
}

/** Rank heading-ish selectors so the hierarchy reads top-down. */
function typographyRank(selector: string): number {
  const h = /h([1-6])\b/.exec(selector);
  if (/display/i.test(selector)) return 0;
  if (h) return Number(h[1]);
  if (/lead|subtitle/i.test(selector)) return 7;
  if (/body|prose|text/i.test(selector)) return 8;
  if (/caption|eyebrow|overline/i.test(selector)) return 9;
  return 10;
}

export function generateTypographyShowcaseMdx(
  document: TokenDocument,
  rules: DsTypographyRule[],
): string {
  const lines: string[] = [
    "{/* Generated by figma_ds_scaffold — regenerate via the tool; do not hand-edit. */}",
    "",
    "import { Meta } from '@storybook/addon-docs/blocks';",
    "",
    '<Meta title="Design Tokens/Typography" />',
    "",
    "# Typography",
    "",
    "Type scale, families, and the heading hierarchy as actually applied in the source codebase.",
    "",
  ];

  // ---- Font tokens ---------------------------------------------------------
  const fontTokens: Token[] = [];
  for (const set of document.sets) {
    for (const t of set.tokens) {
      const p = t.path.join("/");
      if (
        t.type === "fontFamily" ||
        /(^|\/)(font|text|type)(\/|-)/.test(p) ||
        /font|text-/.test(p)
      ) {
        fontTokens.push(t);
      }
    }
  }
  if (fontTokens.length > 0) {
    lines.push("## Type tokens", "");
    const families = fontTokens.filter((t) => t.type === "fontFamily");
    for (const fam of families) {
      const value = firstLiteral(fam);
      lines.push(
        `<div style={{ margin: "12px 0" }}>`,
        `  <code style={{ fontSize: 12 }}>${mdxEscape(fam.path.join("/"))}</code>`,
        `  <div style={{ fontFamily: ${JSON.stringify(value)}, fontSize: 28 }}>Aa Bb Cc — ${mdxEscape(value)}</div>`,
        `</div>`,
      );
    }
    const sizes = fontTokens.filter(
      (t) => t.type !== "fontFamily" && /text|size|display|h\d|lead|caption/i.test(t.path.join("/")),
    );
    if (sizes.length > 0) {
      lines.push("", "### Scale", "");
      for (const t of sizes) {
        const value = firstLiteral(t);
        if (!value || value.startsWith("{")) continue;
        lines.push(
          `<div style={{ display: "flex", alignItems: "baseline", gap: 16, margin: "8px 0" }}>`,
          `  <code style={{ fontSize: 11, minWidth: 220 }}>${mdxEscape(t.path.join("/"))}</code>`,
          `  <span style={{ fontSize: ${JSON.stringify(value)}, lineHeight: 1.1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>The quick brown fox</span>`,
          `</div>`,
        );
      }
    }
    lines.push("");
  }

  // ---- Applied hierarchy ---------------------------------------------------
  if (rules.length > 0) {
    const sorted = [...rules].sort(
      (a, b) => typographyRank(a.selector) - typographyRank(b.selector),
    );
    lines.push(
      "## Applied hierarchy & classes",
      "",
      "Selectors mined from the app's stylesheets, rendered with their real declarations:",
      "",
    );
    for (const rule of sorted.slice(0, 40)) {
      const decls = Object.entries(rule.properties)
        .map(([k, v]) => `${k}: ${v}`)
        .join("; ");
      lines.push(
        `<div style={{ margin: "14px 0", borderBottom: "1px solid #8884", paddingBottom: 10 }}>`,
        `  <code style={{ fontSize: 11 }}>${mdxEscape(rule.selector)}</code>`,
        `  <span style={{ fontSize: 10, opacity: 0.6 }}> — ${mdxEscape(rule.source)}</span>`,
        `  <div style={${cssPropsToJsxStyle(rule.properties)}}>The quick brown fox jumps over the lazy dog</div>`,
        `  <div style={{ fontSize: 10, fontFamily: "monospace", opacity: 0.7, marginTop: 4 }}>${mdxEscape(decls)}</div>`,
        `</div>`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Icon showcase MDX
// ---------------------------------------------------------------------------

const MAX_INLINE_SVG_BYTES = 8 * 1024;
const MAX_ICONS_RENDERED = 80;

function extractFirstSvg(text: string): string | null {
  const m = /<svg[\s\S]*?<\/svg>/i.exec(text);
  if (!m) return null;
  if (m[0].length > MAX_INLINE_SVG_BYTES) return null;
  // Astro/JSX templates interpolate expressions — those svgs aren't static
  // markup and can't be inlined safely.
  if (m[0].includes("{")) return null;
  return m[0];
}

export function generateIconShowcaseMdx(
  entries: Array<{ icon: DsIconEntry; root: string }>,
): string {
  const lines: string[] = [
    "{/* Generated by figma_ds_scaffold — regenerate via the tool; do not hand-edit. */}",
    "",
    "import { Meta } from '@storybook/addon-docs/blocks';",
    "",
    '<Meta title="Design Tokens/Iconography" />',
    "",
    "# Iconography",
    "",
    "SVG assets and components with inline SVG found in the source codebase.",
    "",
    '<div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>',
  ];

  let rendered = 0;
  const unrenderable: Array<{ icon: DsIconEntry }> = [];
  const seenSvgs = new Map<string, string>(); // markup → first file shown
  for (const { icon, root } of entries) {
    if (rendered >= MAX_ICONS_RENDERED) break;
    let svg: string | null = null;
    try {
      const raw = readFileSync(join(root, icon.file), "utf-8");
      svg = extractFirstSvg(raw);
    } catch {
      svg = null;
    }
    if (!svg) {
      unrenderable.push({ icon });
      continue;
    }
    // The same asset often exists in both public/ and src/assets — one tile.
    const dupeKey = svg.replace(/\s+/g, " ");
    if (seenSvgs.has(dupeKey)) continue;
    seenSvgs.set(dupeKey, icon.file);
    rendered++;
    // Constrain the svg itself (style wins over width/height attributes).
    // Each icon renders TWICE — on a dark and a light panel — because themed
    // sites ship both paper-on-ink and ink-on-paper assets, and any single
    // background makes one of them invisible (found live: white wordmarks
    // vanished on a light checkerboard).
    const sized = svg.replace(
      /<svg/i,
      '<svg style="width:100%;height:100%" preserveAspectRatio="xMidYMid meet"',
    );
    const panel = (bg: string) =>
      `      <div style={{ flex: 1, background: ${JSON.stringify(bg)}, padding: 6, height: "100%", boxSizing: "border-box" }} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(sized)} }} />`;
    lines.push(
      `  <div style={{ width: 170, textAlign: "center" }}>`,
      `    <div style={{ height: 56, border: "1px solid #8884", borderRadius: 6, overflow: "hidden", display: "flex" }}>`,
      panel("#181714"),
      panel("#f3f1eb"),
      `    </div>`,
      `    <code style={{ fontSize: 10 }}>${mdxEscape(icon.name)}</code>`,
      `  </div>`,
    );
  }
  lines.push("</div>", "");

  if (unrenderable.length > 0) {
    lines.push("## Not rendered (dynamic or oversized)", "");
    for (const { icon } of unrenderable.slice(0, 60)) {
      lines.push(
        `- ${mdxEscape(icon.name)} — \`${mdxEscape(icon.file)}\` (${icon.source})`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// CSF3 story scaffold
// ---------------------------------------------------------------------------

/** Best-effort CSF3 story scaffold from an inventory entry. */
export function generateStoryScaffold(component: DsComponentEntry): string {
  const name = component.name;
  const variantProp = component.observedProps
    ? Object.entries(component.observedProps).find(
        ([key, values]) =>
          values.length > 1 &&
          /^(variant|kind|type|appearance|intent|color|size)$/i.test(key),
      )
    : undefined;

  if (component.framework === "web-components") {
    const tag = /* elementTag isn't persisted on the entry; use kebab name */ name
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .toLowerCase();
    return [
      `import type { Meta, StoryObj } from '@storybook/web-components-vite';`,
      `import { html } from 'lit';`,
      `import './${name}';`,
      ``,
      `const meta: Meta = {`,
      `  title: 'Components/${name}',`,
      `  component: '${tag}',`,
      `  tags: ['autodocs'],`,
      `};`,
      `export default meta;`,
      `type Story = StoryObj;`,
      ``,
      `export const Default: Story = {`,
      `  render: () => html\`<${tag}></${tag}>\`,`,
      `};`,
      ``,
    ].join("\n");
  }

  if (component.framework === "angular") {
    return [
      `import type { Meta, StoryObj } from '@storybook/angular';`,
      `import { ${name} } from './${name.toLowerCase()}.component';`,
      ``,
      `const meta: Meta<${name}> = {`,
      `  title: 'Components/${name}',`,
      `  component: ${name},`,
      `  tags: ['autodocs'],`,
      `};`,
      `export default meta;`,
      `type Story = StoryObj<${name}>;`,
      ``,
      `export const Default: Story = {};`,
      ``,
    ].join("\n");
  }

  if (component.framework === "astro") {
    // No .astro renderer in Storybook: the story mirrors the component's
    // rendered markup as a react-vite story. The ported component in the
    // design system is a plain function returning that markup, so the .astro
    // source (kept alongside) and the story stay in lockstep.
    return [
      `// Ported from ${component.file ?? "an .astro component"} — markup mirrored as JSX.`,
      `import type { Meta, StoryObj } from '@storybook/react-vite';`,
      `import { ${name} } from './${name}';`,
      ``,
      `const meta = {`,
      `  title: 'Components/${name}',`,
      `  component: ${name},`,
      `  tags: ['autodocs'],`,
      `} satisfies Meta<typeof ${name}>;`,
      `export default meta;`,
      `type Story = StoryObj<typeof meta>;`,
      ``,
      `export const Default: Story = { args: {} };`,
      ``,
    ].join("\n");
  }

  // React (default)
  const lines = [
    `import type { Meta, StoryObj } from '@storybook/react-vite';`,
    `import { ${name} } from './${name}';`,
    ``,
    `const meta = {`,
    `  title: 'Components/${name}',`,
    `  component: ${name},`,
    `  tags: ['autodocs'],`,
    `} satisfies Meta<typeof ${name}>;`,
    `export default meta;`,
    `type Story = StoryObj<typeof meta>;`,
    ``,
    `export const Default: Story = { args: {} };`,
  ];

  if (variantProp) {
    const [prop, values] = variantProp;
    // Identifiers must be valid AND unique JS: observed values like "2xl"
    // (digit lead) or "default" (collides with the Default story) previously
    // emitted uncompilable scaffolds (review finding).
    const used = new Set(["Default"]);
    for (const value of values.slice(0, 8)) {
      let storyName = value
        .replace(/[^\w]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .replace(/\s+/g, "");
      if (!storyName || /^\d/.test(storyName)) storyName = `Variant${storyName}`;
      while (used.has(storyName)) storyName = `${storyName}Variant`;
      used.add(storyName);
      lines.push(
        ``,
        `export const ${storyName}: Story = {`,
        `  args: { ${prop}: ${JSON.stringify(value)} },`,
        `};`,
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}

function generateReadme(analysis: DsAnalysis, opts: ScaffoldOptions): string {
  const targets = analysis.targets
    .map((t) => `- \`${t.root}\` (${t.frameworks.join(", ")}; ${t.stylingMethods.join(", ") || "no styling method detected"})`)
    .join("\n");
  const portable = analysis.components.filter(
    (c) => c.classification !== "pure-vendor",
  ).length;
  return `# ${opts.packageName}

Design system extracted from production application(s) using the
[figma-console-mcp](https://github.com/southleft/figma-console-mcp) design
system extraction workflow.

## Source applications

${targets}

## What's here

- \`tokens/\` — design tokens. \`tokens.json\` is canonical DTCG (with per-token
  provenance in \`$extensions\`); the other files are generated projections
  (${opts.formats.join(", ")}). Import into Figma with \`figma_import_tokens\`.
- \`src/components/\` — components ported from the source apps (${portable} in
  the inventory; see \`.extraction/analysis.json\` for ranking and
  \`.extraction/status.json\` for progress).
- \`src/docs/Tokens.mdx\` — the token showcase (bird's-eye view in Storybook).

## Getting started

\`\`\`bash
npm create storybook@latest   # auto-detects ${opts.framework}, installs latest Storybook
\`\`\`

Then import \`tokens/index.css\` (or \`tokens/tokens.css\`) in \`.storybook/preview\`
so every story renders with the extracted tokens.

## Workflow

This package is the source of truth for UI going forward:

1. **Code-led**: iterate on components here, version + publish this package,
   and consume it from the product apps.
2. **Design-led**: additionally sync \`tokens/tokens.json\` into Figma variables
   (\`figma_import_tokens\`) and rebuild key components as Figma component sets.
`;
}
