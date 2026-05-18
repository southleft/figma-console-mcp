/**
 * Style Dictionary v3 source-format JSON formatter.
 *
 * SD v3 uses bare `value` / `type` fields (no `$` prefix, that's the DTCG
 * convention SD v4 adopted). Output is structurally similar to DTCG but
 * without the dollar signs, and groups have no special meta — just
 * nested objects.
 *
 * Output shape:
 *
 *   {
 *     "color": {
 *       "primary": {
 *         "value": "#4085F2",
 *         "type": "color",
 *         "comment": "Primary brand color"
 *       },
 *       "brand": {
 *         "blue": { "value": "#0066FF", "type": "color" }
 *       }
 *     },
 *     "spacing": {
 *       "md": { "value": "16px", "type": "size" }
 *     }
 *   }
 *
 * SD v3 type names differ slightly from DTCG:
 *
 *   DTCG type    →  SD v3 type
 *   ----------------------------
 *   dimension    →  size (or spacing for spacing tokens)
 *   color        →  color
 *   fontFamily   →  string
 *   fontWeight   →  number
 *
 * Aliases use SD v3's `{path.to.token}` syntax (same as DTCG, which copied
 * it from SD).
 *
 * For back-compat with cbds-components / blocks / czi-edu / eddie-design-system
 * which still use SD v3's bare-key source format.
 */

import type { Token, TokenDocument, TokenSet, TokenValue } from "../types.js";
import type { FormatOptions, FormatResult } from "./index.js";

export function formatStyleDictionaryV3(
  doc: TokenDocument,
  opts: FormatOptions,
): FormatResult {
  const warnings: string[] = [];
  const files: FormatResult["files"] = [];

  const splitByMode = opts.target.splitByMode ?? false;
  const splitByCollection = opts.target.splitByCollection ?? false;

  if (splitByMode && splitByCollection) {
    for (const set of doc.sets) {
      for (const mode of set.modes) {
        files.push({
          path: filenameFor(opts, set, mode),
          content: renderSdJson([set], [mode], warnings),
        });
      }
    }
  } else if (splitByMode) {
    const allModes = new Set<string>();
    for (const set of doc.sets) for (const m of set.modes) allModes.add(m);
    for (const mode of allModes) {
      const sets = doc.sets.filter((s) => s.modes.includes(mode));
      files.push({
        path: filenameFor(opts, undefined, mode),
        content: renderSdJson(sets, [mode], warnings),
      });
    }
  } else if (splitByCollection) {
    for (const set of doc.sets) {
      files.push({
        path: filenameFor(opts, set),
        content: renderSdJson([set], set.modes, warnings),
      });
    }
  } else {
    const allModes = new Set<string>();
    for (const set of doc.sets) for (const m of set.modes) allModes.add(m);
    files.push({
      path: filenameFor(opts),
      content: renderSdJson(doc.sets, [...allModes], warnings),
    });
  }

  return { files, warnings };
}

function filenameFor(
  opts: FormatOptions,
  set?: TokenSet,
  mode?: string,
): string {
  if (opts.target.filename) return opts.target.filename;
  const parts: string[] = [];
  if (set) parts.push(slugify(set.name));
  if (mode) parts.push(slugify(mode));
  if (parts.length === 0) parts.push("tokens");
  return `${parts.join(".")}.sd.json`;
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Map DTCG type names to SD v3 conventions.
 */
function sdTypeFor(token: Token): string {
  const lower = token.path[0]?.toLowerCase() ?? "";
  if (token.type === "dimension") {
    if (lower.startsWith("spacing") || lower === "space") return "spacing";
    return "size";
  }
  if (token.type === "color") return "color";
  if (token.type === "fontFamily") return "string";
  if (token.type === "fontWeight") return "number";
  if (token.type === "duration") return "time";
  if (token.type === "number") return "number";
  if (token.type === "string") return "string";
  if (token.type === "boolean") return "boolean";
  // Composites / less-common types: pass through.
  return token.type;
}

function renderSdJson(
  sets: TokenSet[],
  modes: string[],
  warnings: string[],
): string {
  const tree: Record<string, unknown> = {};
  const primaryMode = pickPrimaryMode(modes);

  for (const set of sets) {
    for (const token of set.tokens) {
      // Filter to modes the file is supposed to cover.
      const usableModes = modes.filter((m) => token.values[m]);
      if (usableModes.length === 0) continue;

      // SD v3 has no native multi-mode encoding, so we pick the primary
      // mode's value. If splitByMode is being used (single mode in this
      // file), that primary will match the file's mode. Otherwise, the
      // chosen primary is the first available.
      const valueMode = usableModes.includes(primaryMode)
        ? primaryMode
        : usableModes[0];
      const tokenValue = token.values[valueMode];

      const sdValue = sdValueFor(tokenValue, token, warnings);
      if (sdValue === undefined) continue;

      // Walk the path, creating nested groups.
      let cursor = tree;
      for (let i = 0; i < token.path.length - 1; i++) {
        const segment = token.path[i];
        if (!cursor[segment] || typeof cursor[segment] !== "object") {
          cursor[segment] = {};
        }
        cursor = cursor[segment] as Record<string, unknown>;
      }
      const leafKey = token.path[token.path.length - 1];
      const leaf: Record<string, unknown> = {
        value: sdValue,
        type: sdTypeFor(token),
      };
      if (token.description) leaf.comment = token.description;
      cursor[leafKey] = leaf;
    }
  }

  return JSON.stringify(sortKeys(tree), null, 2) + "\n";
}

function pickPrimaryMode(modes: string[]): string {
  return modes.find((m) => /^(default|light|value)$/i.test(m)) ?? modes[0];
}

function sdValueFor(
  value: TokenValue,
  token: Token,
  warnings: string[],
): unknown {
  if (value.reference) {
    const bare = value.reference.replace(/^\{|\}$/g, "");
    if (bare.startsWith("__library:") || bare === "unknown") {
      warnings.push(
        `Skipped ${token.path.join(".")} in Style Dictionary v3 — cross-library alias unresolved.`,
      );
      return undefined;
    }
    // SD v3 uses the same `{path.to.token}` alias syntax as DTCG.
    return `{${bare}}`;
  }
  if (value.literal === undefined || value.literal === null) return undefined;

  if (typeof value.literal === "number" && token.type === "dimension") {
    return `${value.literal}px`;
  }
  return value.literal;
}

function sortKeys<T>(node: T): T {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return node;
  }
  const obj = node as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj).sort();
  for (const k of keys) sorted[k] = sortKeys(obj[k] as unknown);
  return sorted as T;
}
