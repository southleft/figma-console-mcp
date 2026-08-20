/**
 * Token extraction: mine a codebase's de-facto styling decisions into the
 * canonical TokenDocument (src/core/tokens/types.ts), which the existing
 * formatter engine turns into DTCG / CSS vars / Tailwind / SCSS / TS outputs
 * and figma_import_tokens turns into Figma variables.
 *
 * Two confidence tiers:
 *  1. "declared" — explicit styling intent: :root / @theme custom properties,
 *     SCSS variables, tailwind.config theme values, shadcn HSL triples.
 *     These keep their names and always become tokens.
 *  2. "inferred" — raw values (hex colors, px sizes) that recur across the
 *     app. Promoted to tokens only above a frequency threshold; everything
 *     else lands in the report's belowThreshold list for human review.
 *
 * Naming stays structural here (--color-blue-500 → color/blue/500). Semantic
 * naming (color/primary etc.) is the skill's job — a judgment call made with
 * the user, layered on top as aliases.
 */

import type {
  Token,
  TokenDocument,
  TokenSet,
  TokenType,
  TokenValue,
} from "../tokens/types.js";
import {
  DS_EXTRACTION_EXTENSION_KEY,
  type DsTokenProvenance,
} from "./types.js";
import type { WalkedFile } from "./walker.js";
import { readTextFile } from "./walker.js";

const MAX_SOURCES_PER_TOKEN = 6;

// ---------------------------------------------------------------------------
// Color parsing (dependency-free; canonical form is hex)
// ---------------------------------------------------------------------------

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function toHex2(n: number): string {
  return clamp255(n).toString(16).padStart(2, "0");
}

export function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = light - c / 2;
  return `#${toHex2((r + m) * 255)}${toHex2((g + m) * 255)}${toHex2((b + m) * 255)}`;
}

/** shadcn convention: `--primary: 222.2 47.4% 11.2%;` (raw HSL components). */
const HSL_TRIPLE_RE =
  /^(-?\d+(?:\.\d+)?)(?:deg)?[,\s]+(\d+(?:\.\d+)?)%[,\s]+(\d+(?:\.\d+)?)%$/;

/**
 * Normalize a CSS color literal to canonical lowercase hex. Returns null when
 * the value isn't a recognizable color. oklch()/color() are passed through
 * verbatim (still typed as color) since quantizing them would lose intent.
 */
export function normalizeColor(raw: string): string | null {
  const value = raw.trim();

  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(value);
  if (hex) {
    let h = hex[1].toLowerCase();
    if (h.length === 3 || h.length === 4)
      h = [...h].map((c) => c + c).join("");
    return `#${h}`;
  }

  const rgb =
    /^rgba?\(\s*(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)(?:[,\s/]+(\d*(?:\.\d+)?%?))?\s*\)$/.exec(
      value,
    );
  if (rgb) {
    const base = `#${toHex2(+rgb[1])}${toHex2(+rgb[2])}${toHex2(+rgb[3])}`;
    if (rgb[4] !== undefined && rgb[4] !== "" && rgb[4] !== "1") {
      const alpha = rgb[4].endsWith("%") ? +rgb[4].slice(0, -1) / 100 : +rgb[4];
      if (!Number.isNaN(alpha) && alpha < 1)
        return `${base}${toHex2(alpha * 255)}`;
    }
    return base;
  }

  const hsl =
    /^hsla?\(\s*(-?\d+(?:\.\d+)?)(?:deg)?[,\s]+(\d+(?:\.\d+)?)%[,\s]+(\d+(?:\.\d+)?)%(?:[,\s/]+[\d.]+%?)?\s*\)$/.exec(
      value,
    );
  if (hsl) return hslToHex(+hsl[1], +hsl[2], +hsl[3]);

  const triple = HSL_TRIPLE_RE.exec(value);
  if (triple) return hslToHex(+triple[1], +triple[2], +triple[3]);

  if (/^(oklch|oklab|lab|lch|color)\(/.test(value)) return value;

  return null;
}

export function isShadcnHslTriple(value: string): boolean {
  return HSL_TRIPLE_RE.test(value.trim());
}

// ---------------------------------------------------------------------------
// Type inference
// ---------------------------------------------------------------------------

const COLORISH_NAME =
  /(color|colour|bg|background|foreground|border|ring|fill|stroke|accent|primary|secondary|muted|destructive|success|warning|danger|info|brand)/i;

export function inferTokenType(
  name: string,
  value: string,
): { type: TokenType; literal: string | number } | null {
  const v = value.trim();

  const color = normalizeColor(v);
  if (color) return { type: "color", literal: color };

  if (/^-?\d*\.?\d+(px|rem|em|%|vh|vw|pt|ch)$/.test(v)) {
    return { type: "dimension", literal: v };
  }
  if (/^-?\d*\.?\d+(ms|s)$/.test(v)) {
    return { type: "duration", literal: v };
  }
  if (/^-?\d*\.?\d+$/.test(v)) {
    // Bare numbers: font-weight-ish names → number; line-height → number.
    return { type: "number", literal: +v };
  }
  if (
    /(font-family|font-sans|font-serif|font-mono|typeface)/i.test(name) ||
    // --font-display / --sl-font-body style names holding a font stack.
    (/(^|-)font(-|$)/i.test(name) && /,|\bsans\b|\bserif\b|\bmono(space)?\b/i.test(v))
  ) {
    return { type: "fontFamily", literal: v };
  }
  if (/^\d+(px)?\s+\d+(px)?/.test(v) && /shadow/i.test(name)) {
    return { type: "shadow", literal: v };
  }
  // Colorish name but unparseable value (gradients, var chains handled
  // elsewhere): keep as string so nothing silently disappears.
  if (COLORISH_NAME.test(name)) return { type: "string", literal: v };
  return { type: "string", literal: v };
}

// ---------------------------------------------------------------------------
// Miners
// ---------------------------------------------------------------------------

export interface MinedVar {
  /** Custom-property or variable name without leading -- or $. */
  name: string;
  value: string;
  /**
   * Which theme mode the declaration belongs to. "light" is the base mode
   * (:root, @theme, un-themed blocks); any other string is a named mode
   * ("dark", "high-contrast", a brand name, ...) taken from the selector.
   */
  mode: string;
  source: string; // "path:line"
  origin: DsTokenProvenance["note"];
  /** True for de-facto (usage-mined) values — provenance reads "inferred". */
  inferred?: boolean;
  /** Occurrence count for usage-mined values. */
  frequency?: number;
}

/**
 * Map a theme-block selector/header to a mode name. Covers the conventions
 * production apps actually use, across frameworks:
 *   :root, @theme                                → light (base)
 *   [data-theme='X'] / [data-mode='X'] /
 *   [data-color-scheme='X']                      → X   (Astro, next-themes, custom)
 *   .dark, .dark-mode, :root.dark, html.dark     → dark (Tailwind, Nuxt color-mode)
 *   .light, .light-mode                          → light
 *   .theme-X                                     → X
 *   @media (prefers-color-scheme: X)             → X
 */
export function classifyThemeHeader(header: string): string {
  const attr =
    /\[data-(?:theme|mode|color-scheme)=["']?([\w-]+)["']?\]/.exec(header);
  if (attr) return attr[1].toLowerCase();
  const media = /prefers-color-scheme:\s*(\w+)/.exec(header);
  if (media) return media[1].toLowerCase();
  const themeClass = /\.theme-([\w-]+)/.exec(header);
  if (themeClass) return themeClass[1].toLowerCase();
  const modeClass = /\.([\w-]+?)(?:-mode)?\s*(?:[,{[:\s]|$)/.exec(header);
  if (modeClass && /^(dark|light)$/.test(modeClass[1])) return modeClass[1];
  return "light";
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/**
 * Mine custom properties from CSS/SCSS. Recognizes light blocks (:root,
 * @theme) and dark blocks (.dark, [data-theme="dark"], prefers-color-scheme:
 * dark) so themed values become multi-mode tokens.
 */
export function mineCssCustomProps(text: string, relPath: string): MinedVar[] {
  const out: MinedVar[] = [];
  // Find theme-scoped selector blocks, then scan declarations inside. The
  // alternation covers base blocks plus every mode convention
  // classifyThemeHeader understands (attribute themes with ANY mode name,
  // dark/light classes incl. Nuxt's -mode suffix, .theme-X, media queries).
  const blockRe =
    /(:root[^{]*|@theme[^{]*|html[^{]*|\.(?:dark|light)(?:-mode)?[^{]*|\.theme-[\w-]+[^{]*|\[data-(?:theme|mode|color-scheme)=[^\]]+\][^{]*|@media[^{]*prefers-color-scheme[^{]*)\{/g;
  let m: RegExpExecArray | null;
  // Ranges already consumed by an outer themed block. A `:root` nested inside
  // `@media (prefers-color-scheme: dark) { :root { … } }` must NOT be re-mined
  // as a light block — that corrupted base light values (review finding).
  const consumed: Array<[number, number]> = [];
  while ((m = blockRe.exec(text)) !== null) {
    if (consumed.some(([s, e]) => m!.index >= s && m!.index < e)) continue;
    const header = m[1];
    const mode = classifyThemeHeader(header);
    const isTheme = header.startsWith("@theme");
    // Balanced scan (media queries nest a block inside).
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    consumed.push([m.index, i]);
    const body = text.slice(start, i - 1);
    const declRe = /--([\w-]+)\s*:\s*([^;]+);/g;
    let d: RegExpExecArray | null;
    while ((d = declRe.exec(body)) !== null) {
      const value = d[2].trim();
      out.push({
        name: d[1],
        value,
        mode,
        source: `${relPath}:${lineOf(text, m.index + m[0].length + d.index)}`,
        origin: isTheme
          ? "tailwind v4 @theme"
          : isShadcnHslTriple(value)
            ? "shadcn HSL triple"
            : undefined,
      });
    }
  }
  return out;
}

/** Mine top-level SCSS variables: `$name: value;` (skips maps and mixins). */
export function mineScssVars(text: string, relPath: string): MinedVar[] {
  const out: MinedVar[] = [];
  // Value may contain parens (rgba(), calc()) — stop only at ";" (review finding).
  const re = /^\$([\w-]+)\s*:\s*([^;]+?)\s*(?:!default)?\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({
      name: m[1],
      value: m[2].trim(),
      mode: "light",
      source: `${relPath}:${lineOf(text, m.index)}`,
      origin: "scss variable",
    });
  }
  return out;
}

/**
 * Mine tailwind.config theme values WITHOUT executing user code. The theme
 * (or theme.extend) object literal is sliced out brace-balanced and evaluated
 * only if it is plugin/require/import-free; otherwise we fall back to mining
 * quoted color literals from the slice.
 */
export function mineTailwindConfig(
  text: string,
  relPath: string,
): MinedVar[] {
  const themeIdx = text.search(/\btheme\s*:/);
  if (themeIdx === -1) return [];
  const braceStart = text.indexOf("{", themeIdx);
  if (braceStart === -1) return [];
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return [];
  const slice = text.slice(braceStart, end);

  const out: MinedVar[] = [];
  const push = (path: string[], value: unknown) => {
    if (typeof value === "string" || typeof value === "number") {
      out.push({
        name: path.join("-"),
        value: String(value),
        mode: "light",
        source: `${relPath}:${lineOf(text, themeIdx)}`,
        origin: "tailwind theme",
      });
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (path.length < 5) push([...path, k], v);
      }
    }
  };

  // Parse, don't eval. An earlier version Function-evaluated the theme
  // object literal behind a keyword screen; review showed the screen was
  // bypassable (getters, IIFEs, busy-loops) and unbounded — an "analysis"
  // tool must never execute the analyzed repo's code. Literal mining covers
  // the overwhelmingly common quoted key/value theme entries; exotic
  // computed configs simply yield fewer declared tokens.
  // Keys may be quoted ("brand-dark") or bare (brand) — both are idiomatic.
  const litRe = /['"]?([\w-]+)['"]?\s*:\s*['"](#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|-?\d*\.?\d+(?:px|rem|em|%)?)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = litRe.exec(slice)) !== null) {
    out.push({
      name: m[1],
      value: m[2],
      mode: "light",
      source: `${relPath}:${lineOf(text, braceStart + m.index)}`,
      origin: "tailwind theme (literal mining)",
    });
  }
  return out;
}

/** `<style>` block contents of an .astro / .vue / .svelte single-file component. */
export function extractStyleBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) blocks.push(m[1]);
  return blocks;
}

/** Type-relevant CSS properties captured for the Typography showcase. */
const TYPO_PROPS = new Set([
  "font-size",
  "font-family",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-transform",
  "font-style",
  "text-decoration",
]);

const TYPO_SELECTOR_RE =
  /(^|[\s,.:>~+([])h[1-6]\b|head(ing|line)|display|title|lead|eyebrow|caption|prose|subtitle|overline|body-|text-|blockquote/i;

export interface MinedTypographyRule {
  selector: string;
  properties: Record<string, string>;
  source: string;
}

/**
 * Mine typographic rules (heading hierarchy, display/lead/prose classes) from
 * CSS text. Only rules whose selector reads typographic AND that declare at
 * least one font-related property are kept.
 */
export function mineTypographyStyles(
  text: string,
  relPath: string,
): MinedTypographyRule[] {
  const out: MinedTypographyRule[] = [];
  // Flat rule scan; nested at-rule bodies still surface their inner rules.
  const ruleRe = /([^{}@]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(text)) !== null && out.length < 120) {
    const selector = m[1].trim().replace(/\s+/g, " ");
    if (selector.length > 80 || !TYPO_SELECTOR_RE.test(selector)) continue;
    const properties: Record<string, string> = {};
    const declRe = /([a-z-]+)\s*:\s*([^;]+);/g;
    let d: RegExpExecArray | null;
    while ((d = declRe.exec(m[2])) !== null) {
      if (TYPO_PROPS.has(d[1])) properties[d[1]] = d[2].trim();
    }
    if (Object.keys(properties).length > 0) {
      out.push({
        selector,
        properties,
        source: `${relPath}:${lineOf(text, m.index)}`,
      });
    }
  }
  return out;
}

export interface RawFrequencyEntry {
  value: string;
  type: TokenType;
  frequency: number;
  sources: string[];
}

/**
 * Frequency scan for raw values: hex/rgb/hsl colors anywhere, px dimensions
 * in CSS declarations. Near-duplicates cluster via normalizeColor.
 */
export function scanRawValues(
  text: string,
  relPath: string,
  isStyleFile: boolean,
  acc: Map<string, RawFrequencyEntry>,
): void {
  const bump = (key: string, type: TokenType, source: string) => {
    const entry = acc.get(key) ?? { value: key, type, frequency: 0, sources: [] };
    entry.frequency++;
    if (entry.sources.length < MAX_SOURCES_PER_TOKEN) entry.sources.push(source);
    acc.set(key, entry);
  };

  const colorRe =
    /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]{1,50}\)|hsla?\([^)]{1,50}\)/g;
  let m: RegExpExecArray | null;
  while ((m = colorRe.exec(text)) !== null) {
    const norm = normalizeColor(m[0]);
    if (norm) bump(norm, "color", `${relPath}:${lineOf(text, m.index)}`);
  }

  if (isStyleFile) {
    const dimRe =
      /(margin|padding|gap|top|right|bottom|left|width|height|border-radius|font-size|line-height|letter-spacing)[^:;{}]*:\s*([^;{}]+);/g;
    while ((m = dimRe.exec(text)) !== null) {
      const prop = m[1];
      const source = `${relPath}:${lineOf(text, m.index)}`;
      const valueRe = /-?\d*\.?\d+(?:px|rem|em)\b/g;
      let vm: RegExpExecArray | null;
      while ((vm = valueRe.exec(m[2])) !== null) {
        const kind: TokenType = "dimension";
        bump(`${prop.includes("radius") ? "radius" : prop.includes("font") ? "font" : "space"}:${vm[0]}`, kind, source);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tailwind utility-class frequency mining
// ---------------------------------------------------------------------------

/** Parse a Tailwind v4 theme.css (or any @theme css) into var-name → value. */
export function parseTailwindTheme(css: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /--([\w-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) map.set(m[1], m[2].trim());
  return map;
}

/** Tally design-encoding utilities from class/className attributes. */
export function scanUtilityClasses(
  text: string,
  acc: Map<string, number>,
): void {
  const attrRe = /class(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(text)) !== null) {
    for (const raw of (m[1] ?? m[2] ?? m[3] ?? "").split(/\s+/)) {
      // Strip variant prefixes (hover:, md:, dark:, group-hover:, ...).
      const cls = raw.replace(/^(?:[\w-]+:)+/, "");
      if (cls) acc.set(cls, (acc.get(cls) ?? 0) + 1);
    }
  }
}

/**
 * Translate one counted utility class into a mined token, valued from the
 * app's OWN tailwind theme (node_modules/tailwindcss/theme.css — version-
 * exact, never a shipped palette). Returns null for non-design utilities.
 */
export function utilityToMinedVar(
  cls: string,
  count: number,
  theme: Map<string, string>,
): Omit<MinedVar, "source"> | null {
  const make = (
    name: string,
    value: string,
  ): Omit<MinedVar, "source"> => ({
    name,
    value,
    mode: "light",
    origin: `tailwind utility "${cls}" ×${count} (de-facto usage)`,
    inferred: true,
    frequency: count,
  });

  // Colors: bg-zinc-900, text-red-500, border-slate-200, from/via/to-...
  const color =
    /^(?:bg|text|border|ring|fill|stroke|from|via|to|divide|outline|accent|caret|decoration)-([a-z]+)-(\d{2,3})$/.exec(
      cls,
    );
  if (color) {
    const value = theme.get(`color-${color[1]}-${color[2]}`);
    return value ? make(`color-${color[1]}-${color[2]}`, value) : null;
  }
  // Named single colors: bg-white, text-black.
  const namedColor = /^(?:bg|text|border|ring|fill|stroke)-(white|black)$/.exec(cls);
  if (namedColor) {
    return make(`color-${namedColor[1]}`, namedColor[1] === "white" ? "#ffffff" : "#000000");
  }
  // Spacing scale: p-4, mx-6, gap-2, w-8, size-10 → n × 0.25rem.
  const spacing =
    /^(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y|size)-(\d+(?:\.\d+)?)$/.exec(
      cls,
    );
  if (spacing) {
    const n = Number(spacing[1]);
    if (n > 0 && n <= 96) return make(`spacing-${spacing[1]}`, `${n * 0.25}rem`);
    return null;
  }
  // Radii: rounded-lg → --radius-lg.
  const radius = /^rounded-(xs|sm|md|lg|xl|2xl|3xl|4xl|full)$/.exec(cls);
  if (radius) {
    const value =
      theme.get(`radius-${radius[1]}`) ??
      (radius[1] === "full" ? "9999px" : undefined);
    return value ? make(`radius-${radius[1]}`, value) : null;
  }
  // Type scale: text-lg → --text-lg.
  const textSize = /^text-(xs|sm|base|lg|xl|\dxl)$/.exec(cls);
  if (textSize) {
    const value = theme.get(`text-${textSize[1]}`);
    return value ? make(`font-size-${textSize[1]}`, value) : null;
  }
  // Weights: font-semibold → --font-weight-semibold.
  const weight =
    /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/.exec(
      cls,
    );
  if (weight) {
    const value = theme.get(`font-weight-${weight[1]}`);
    return value ? make(`font-weight-${weight[1]}`, value) : null;
  }
  // Shadows: shadow-md → --shadow-md.
  const shadow = /^shadow-(2xs|xs|sm|md|lg|xl|2xl)$/.exec(cls);
  if (shadow) {
    const value = theme.get(`shadow-${shadow[1]}`);
    return value ? make(`shadow-${shadow[1]}`, value) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Assembly into TokenDocument
// ---------------------------------------------------------------------------

/**
 * Split a mined variable name into a token path. Handles the common
 * separators: `color-blue-500`, `colorBlue500` stays whole-word, `spacing.4`.
 */
export function nameToPath(name: string): string[] {
  return name
    .replace(/\./g, "-")
    .split("-")
    .filter((s) => s.length > 0);
}

/** Names that read semantic (role-based), not structural (scale-based). */
const SEMANTIC_NAME_RE =
  /^(?:color-|bg-|text-|border-)?(primary|secondary|accent|muted|destructive|success|warning|danger|info|background|foreground|bg|fg|card|popover|border|input|ring|surface|on[A-Z-]|link|brand|chart-\d+|sidebar)\b/i;

/**
 * Semantic = role-named, or (definitionally) any variable whose value is an
 * alias — in a tiered system, tier 2 is exactly the vars that reference
 * tier 1. Brand prefixes (--sl-bg → "bg") are stripped before the name test.
 */
function isSemanticToken(name: string, value: TokenValue): boolean {
  if (value.reference !== undefined) return true;
  if (SEMANTIC_NAME_RE.test(name)) return true;
  const stripped = name.replace(/^[a-z]{1,5}-/i, "");
  return stripped !== name && SEMANTIC_NAME_RE.test(stripped);
}

export interface ExtractTokensOptions {
  /** Raw values must appear at least this often to be promoted. */
  minFrequency?: number;
  /** Cap promoted inferred tokens per type. */
  maxInferredPerType?: number;
  /**
   * App roots — enables Tailwind utility-class frequency mining, valued from
   * each root's own node_modules/tailwindcss/theme.css. Without it, apps
   * styled purely with stock utilities (bg-zinc-900 everywhere, no custom
   * properties) yield almost no tokens.
   */
  targetRoots?: string[];
}

export interface ExtractTokensResult {
  document: TokenDocument;
  warnings: string[];
  belowThreshold: Array<{ value: string; type: string; frequency: number }>;
  counts: Record<string, number>;
}

const STYLE_EXTS = new Set([".css", ".scss", ".sass", ".less"]);
const CODE_EXTS = new Set([".tsx", ".jsx", ".ts", ".js"]);

export function extractTokens(
  files: WalkedFile[],
  opts: ExtractTokensOptions = {},
): ExtractTokensResult {
  const minFrequency = opts.minFrequency ?? 4;
  const maxInferredPerType = opts.maxInferredPerType ?? 60;
  const warnings: string[] = [];

  const mined: MinedVar[] = [];
  const rawAcc = new Map<string, RawFrequencyEntry>();
  const utilityAcc = new Map<string, number>();

  for (const file of files) {
    const isStyle = STYLE_EXTS.has(file.ext);
    const isSfc = file.ext === ".astro" || file.ext === ".vue" || file.ext === ".svelte";
    const isCode = CODE_EXTS.has(file.ext);
    if (!isStyle && !isCode && !isSfc) continue;
    const text = readTextFile(file.path);
    if (!text) continue;

    if (isStyle) {
      mined.push(...mineCssCustomProps(text, file.relPath));
      if (file.ext === ".scss" || file.ext === ".sass")
        mined.push(...mineScssVars(text, file.relPath));
    }
    let markupText = text;
    if (isSfc) {
      // Single-file components: their <style> blocks are stylesheets. The
      // remainder (frontmatter + template) is scanned separately below so
      // style-block values aren't double-counted.
      for (const block of extractStyleBlocks(text)) {
        mined.push(...mineCssCustomProps(block, file.relPath));
        scanRawValues(block, file.relPath, true, rawAcc);
      }
      markupText = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    }
    if (/tailwind\.config\.(js|cjs|mjs|ts)$/.test(file.relPath)) {
      mined.push(...mineTailwindConfig(text, file.relPath));
    }
    scanRawValues(markupText, file.relPath, isStyle, rawAcc);
    if (isCode || isSfc) scanUtilityClasses(markupText, utilityAcc);
  }

  // ---- Tailwind utility mining (de-facto palette/scale usage) --------------
  if (opts.targetRoots && utilityAcc.size > 0) {
    let theme: Map<string, string> | null = null;
    for (const root of opts.targetRoots) {
      const themeText = readTextFile(
        `${root}/node_modules/tailwindcss/theme.css`,
      );
      if (themeText) {
        theme = parseTailwindTheme(themeText);
        break;
      }
    }
    if (theme) {
      let promoted = 0;
      for (const [cls, count] of utilityAcc) {
        if (count < minFrequency) continue;
        const entry = utilityToMinedVar(cls, count, theme);
        // Declared custom properties win over usage mining for the same name.
        if (entry && !mined.some((v) => v.name === entry.name)) {
          mined.push({ ...entry, source: "tailwind utility usage" });
          promoted++;
        }
      }
      if (promoted > 0)
        warnings.push(
          `Promoted ${promoted} Tailwind utility value(s) (frequency >= ${minFrequency}) from the app's own theme.css — de-facto palette/scale; review names before shipping.`,
        );
    }
  }

  // ---- Declared tokens -----------------------------------------------------
  // Group by name; merge per-mode declarations into multi-mode values. Mode
  // names come from the theme selectors (classifyThemeHeader) — any number of
  // modes, any names, across framework conventions.
  const byName = new Map<string, MinedVar[]>();
  const modeOrder: string[] = ["light"];
  for (const v of mined) {
    const list = byName.get(v.name) ?? [];
    list.push(v);
    byName.set(v.name, list);
    if (!modeOrder.includes(v.mode)) modeOrder.push(v.mode);
  }
  const multiMode = modeOrder.length > 1;
  const modeLabel = (mode: string): string =>
    multiMode
      ? mode.charAt(0).toUpperCase() + mode.slice(1)
      : "Default";
  const modeLabels = multiMode ? modeOrder.map(modeLabel) : ["Default"];

  const primitives: Token[] = [];
  const semantic: Token[] = [];
  const declaredColorValues = new Set<string>();

  for (const [name, vars] of byName) {
    const base = vars.find((v) => v.mode === "light") ?? vars[0];

    const makeValue = (v: MinedVar): TokenValue => {
      // var() references become aliases when the target is also mined.
      const ref = /^var\(\s*--([\w-]+)\s*(?:,[^)]*)?\)$/.exec(v.value.trim());
      if (ref && byName.has(ref[1])) {
        return { reference: nameToPath(ref[1]).join(".") };
      }
      // hsl(var(--x)) wrapper (shadcn usage sites) → alias too.
      const wrapped = /^hsla?\(\s*var\(\s*--([\w-]+)\s*\)\s*(?:[,/][^)]*)?\)$/.exec(
        v.value.trim(),
      );
      if (wrapped && byName.has(wrapped[1])) {
        return { reference: nameToPath(wrapped[1]).join(".") };
      }
      const inferred = inferTokenType(v.name, v.value);
      return { literal: inferred?.literal ?? v.value };
    };

    const baseValue = makeValue(base);
    // Aliases take their TARGET's type (followed through the chain) — a
    // radius alias is a dimension, not a color (the old "color" default
    // rendered every @theme radius/shadow/font alias as an empty swatch).
    let typeSource = base;
    for (let depth = 0; depth < 6; depth++) {
      const ref =
        /^var\(\s*--([\w-]+)\s*(?:,[^)]*)?\)$/.exec(typeSource.value.trim()) ??
        /^hsla?\(\s*var\(\s*--([\w-]+)\s*\)\s*(?:[,/][^)]*)?\)$/.exec(
          typeSource.value.trim(),
        );
      if (!ref) break;
      const target = byName.get(ref[1]);
      const targetBase =
        target?.find((v) => v.mode === "light") ?? target?.[0];
      if (!targetBase) break;
      typeSource = targetBase;
    }
    const type: TokenType =
      inferTokenType(typeSource.name, typeSource.value)?.type ?? "color";

    if (type === "color" && typeof baseValue.literal === "string")
      declaredColorValues.add(baseValue.literal);

    const provenance: DsTokenProvenance = {
      confidence: base.inferred ? "inferred" : "declared",
      sources: vars.slice(0, MAX_SOURCES_PER_TOKEN).map((v) => v.source),
      frequency: base.frequency,
      note: base.origin,
    };

    // Every token carries every mode; modes it doesn't declare fall back to
    // the base value (matches the cascade: an un-overridden var keeps its
    // :root value in every theme).
    const values: Record<string, TokenValue> = {};
    for (const mode of multiMode ? modeOrder : ["light"]) {
      const declared = vars.find((v) => v.mode === mode);
      values[modeLabel(mode)] = declared ? makeValue(declared) : baseValue;
    }

    const path = nameToPath(name);
    if (path.length === 0) continue; // e.g. a var literally named "--" (review finding)
    const token: Token = {
      path,
      type,
      values,
      extensions: { [DS_EXTRACTION_EXTENSION_KEY]: provenance },
    };

    (isSemanticToken(name, baseValue) ? semantic : primitives).push(token);
  }

  // ---- Inferred (frequency-promoted) tokens --------------------------------
  const belowThreshold: ExtractTokensResult["belowThreshold"] = [];
  const inferredByType = new Map<string, RawFrequencyEntry[]>();
  for (const entry of rawAcc.values()) {
    // Colors already declared as tokens don't need promotion.
    if (entry.type === "color" && declaredColorValues.has(entry.value)) continue;
    if (entry.frequency < minFrequency) {
      if (entry.frequency > 1)
        belowThreshold.push({
          value: entry.value,
          type: entry.type,
          frequency: entry.frequency,
        });
      continue;
    }
    const list = inferredByType.get(entry.type) ?? [];
    list.push(entry);
    inferredByType.set(entry.type, list);
  }
  belowThreshold.sort((a, b) => b.frequency - a.frequency);

  const modeShape = (literal: string | number): Record<string, TokenValue> =>
    Object.fromEntries(modeLabels.map((label) => [label, { literal }]));

  for (const [type, entries] of inferredByType) {
    entries.sort((a, b) => b.frequency - a.frequency);
    const kept = entries.slice(0, maxInferredPerType);
    if (entries.length > kept.length) {
      warnings.push(
        `${entries.length - kept.length} inferred ${type} values over the per-type cap were left in belowThreshold.`,
      );
      for (const e of entries.slice(maxInferredPerType))
        belowThreshold.push({
          value: e.value,
          type: e.type,
          frequency: e.frequency,
        });
    }
    let i = 0;
    const seenPaths = new Set(
      [...primitives, ...semantic].map((t) => t.path.join("/")),
    );
    for (const entry of kept) {
      i++;
      let path: string[];
      let literal: string | number = entry.value;
      if (type === "color") {
        path = ["color", "extracted", entry.value.replace(/^#/, "hex-")];
      } else {
        // dimension keys are "space:8px" / "radius:4px" / "font:16px"
        const [group, value] = entry.value.split(":");
        literal = value ?? entry.value;
        // Sign must survive sanitization: "-1px" and "1px" are different
        // tokens and would otherwise collide on the same path.
        path = [
          group === "space" ? "spacing" : group === "font" ? "fontSize" : group,
          String(literal)
            .replace(/^-/, "neg-")
            .replace(/[^\w.-]/g, ""),
        ];
      }
      if (seenPaths.has(path.join("/"))) {
        warnings.push(
          `Skipped inferred ${type} "${entry.value}" — path ${path.join("/")} already exists.`,
        );
        continue;
      }
      seenPaths.add(path.join("/"));
      primitives.push({
        path,
        type: type as TokenType,
        values: modeShape(literal),
        extensions: {
          [DS_EXTRACTION_EXTENSION_KEY]: {
            confidence: "inferred",
            frequency: entry.frequency,
            sources: entry.sources,
            note: "frequency-promoted raw value — rename semantically before shipping",
          } satisfies DsTokenProvenance,
        },
      });
    }
    if (i > 0)
      warnings.push(
        `Promoted ${i} inferred ${type} value(s) (frequency >= ${minFrequency}). Review names before shipping.`,
      );
  }

  // ---- Document ------------------------------------------------------------
  const modes = modeLabels;
  const sets: TokenSet[] = [];
  if (primitives.length > 0)
    sets.push({
      name: "Primitives",
      description:
        "Structural tokens extracted from the codebase (declared variables + frequency-promoted raw values).",
      modes,
      tokens: primitives,
    });
  if (semantic.length > 0)
    sets.push({
      name: "Semantic",
      description:
        "Role-named tokens extracted from the codebase (primary, background, border, ...).",
      modes,
      tokens: semantic,
    });

  if (sets.length === 0)
    warnings.push(
      "No tokens found. The app may inline all styling — try lowering minFrequency or check include/exclude filters.",
    );

  const counts: Record<string, number> = {};
  for (const set of sets) {
    for (const t of set.tokens) {
      counts[t.type] = (counts[t.type] ?? 0) + 1;
    }
  }

  return {
    document: {
      $schema: "https://tr.designtokens.org/format/",
      sets,
      meta: { exportedAt: new Date().toISOString() },
    },
    warnings,
    belowThreshold: belowThreshold.slice(0, 100),
    counts,
  };
}
