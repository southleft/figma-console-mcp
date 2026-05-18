/**
 * Tokens Studio for Figma JSON formatter.
 *
 * Tokens Studio uses a multi-file layout:
 *
 *   $themes.json      — array of theme definitions with selectedTokenSets
 *   $metadata.json    — list of token set names + tokenSetOrder
 *   primitives.json   — one file per token set
 *   semantic.json
 *   theme/light.json
 *   theme/dark.json
 *
 * Each per-set file holds tokens with the Tokens Studio shape:
 *
 *   {
 *     "color": {
 *       "primary": {
 *         "value": "#4085F2",
 *         "type": "color",
 *         "description": "Primary brand color"
 *       }
 *     }
 *   }
 *
 * Tokens Studio uses bare `value` / `type` (no `$` prefix — same as
 * Style Dictionary v3, which the plugin's format is based on). Aliases
 * use `{path.to.token}` syntax.
 *
 * `$themes.json` carries the Figma collection/mode bindings that make
 * Tokens Studio's "send to Figma" feature work — preserved here for
 * round-trip with Tokens Studio plugin users (notably Altitude).
 *
 * Output strategy:
 *   - One file per TokenSet, named after the set (slugified).
 *   - Multi-mode sets emit one file per (set, mode) pair (Tokens Studio
 *     convention).
 *   - `$metadata.json` enumerates the token set names in order.
 *   - `$themes.json` builds a theme entry per mode with selectedTokenSets
 *     and the figma-console-mcp metadata stamped onto it.
 */

import type { Token, TokenDocument, TokenSet, TokenValue } from "../types.js";
import { FIGMA_MCP_EXTENSION_KEY } from "../types.js";
import type { FormatOptions, FormatResult } from "./index.js";

export function formatTokensStudio(
  doc: TokenDocument,
  opts: FormatOptions,
): FormatResult {
  const warnings: string[] = [];
  const files: FormatResult["files"] = [];

  // Track which (setName, mode) → filename pairs exist so $metadata + $themes
  // can reference them.
  const setNamesByMode: Array<{ setName: string; mode: string; filename: string }> = [];

  // 1. Per-set per-mode token files.
  for (const set of doc.sets) {
    for (const mode of set.modes) {
      const fileSetName =
        set.modes.length > 1 ? `${slugify(set.name)}/${slugify(mode)}` : slugify(set.name);
      const filename = `${fileSetName}.json`;
      setNamesByMode.push({ setName: fileSetName, mode, filename });

      files.push({
        path: filename,
        content: renderSetFile(set, mode, warnings),
      });
    }
  }

  // 2. $metadata.json — ordered list of token sets.
  const tokenSetOrder = setNamesByMode.map((e) => e.setName);
  files.push({
    path: "$metadata.json",
    content: JSON.stringify({ tokenSetOrder }, null, 2) + "\n",
  });

  // 3. $themes.json — one theme entry per mode, with figma-console-mcp
  //    metadata so the Tokens Studio plugin's Figma sync features know
  //    which Figma collection/mode each theme maps to.
  const themes = buildThemes(doc, setNamesByMode);
  files.push({
    path: "$themes.json",
    content: JSON.stringify(themes, null, 2) + "\n",
  });

  return { files, warnings };
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Render a single set's tokens for a specific mode in Tokens Studio's
 * bare-key JSON format.
 */
function renderSetFile(
  set: TokenSet,
  mode: string,
  warnings: string[],
): string {
  const tree: Record<string, unknown> = {};

  for (const token of set.tokens) {
    const value = token.values[mode];
    if (!value) continue;

    const tsValue = tsValueFor(value, token, warnings);
    if (tsValue === undefined) continue;

    // Walk path creating nested groups.
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
      value: tsValue,
      type: tsTypeFor(token),
    };
    if (token.description) leaf.description = token.description;
    cursor[leafKey] = leaf;
  }

  return JSON.stringify(sortKeys(tree), null, 2) + "\n";
}

/**
 * Build the $themes.json structure. One theme entry per (set, mode) tuple.
 * For multi-mode sets, the theme name combines set + mode.
 */
function buildThemes(
  doc: TokenDocument,
  setNamesByMode: Array<{ setName: string; mode: string; filename: string }>,
): Array<Record<string, unknown>> {
  const themes: Array<Record<string, unknown>> = [];

  // Group by mode so each mode gets one theme entry pulling in the
  // appropriate set files.
  const allModes = new Set<string>();
  for (const e of setNamesByMode) allModes.add(e.mode);

  for (const mode of allModes) {
    const selectedTokenSets: Record<string, "source" | "enabled"> = {};
    for (const e of setNamesByMode) {
      if (e.mode === mode) {
        selectedTokenSets[e.setName] = "enabled";
      } else {
        // Other-mode sets are disabled in this theme (Tokens Studio
        // convention: only one mode of each set is "enabled" per theme).
        selectedTokenSets[e.setName] = "source";
      }
    }

    // Find the Figma collection + mode IDs for this mode (preserved
    // from the export converter's $extensions metadata).
    const figmaCollectionId = findCollectionIdForMode(doc, mode);
    const figmaModeId = findModeId(doc, mode);

    const theme: Record<string, unknown> = {
      id: `${slugify(mode)}-${Math.random().toString(36).slice(2, 10)}`,
      name: mode,
      selectedTokenSets,
    };

    // Stash Figma metadata for round-trip with Tokens Studio plugin.
    if (figmaCollectionId) theme.$figmaCollectionId = figmaCollectionId;
    if (figmaModeId) theme.$figmaModeId = figmaModeId;

    // Also stash our own extension namespace for tools that read it.
    if (figmaCollectionId || figmaModeId) {
      theme.$extensions = {
        [FIGMA_MCP_EXTENSION_KEY]: {
          ...(figmaCollectionId ? { figmaCollectionId } : {}),
          ...(figmaModeId ? { figmaModeId } : {}),
        },
      };
    }

    themes.push(theme);
  }

  return themes;
}

function findCollectionIdForMode(doc: TokenDocument, _mode: string): string | undefined {
  // The mode-to-collection mapping requires knowing which set the mode
  // belongs to. For simplicity, return the first collection ID we find;
  // multi-collection support requires per-set theme entries which the
  // Tokens Studio plugin does support.
  for (const set of doc.sets) {
    if (set.meta?.figmaCollectionId) return set.meta.figmaCollectionId;
  }
  return undefined;
}

function findModeId(_doc: TokenDocument, _mode: string): string | undefined {
  // We don't carry Figma's modeId through the internal model in this
  // version — it's computed lazily during apply via the
  // (collectionId, modeName) lookup map. Future enhancement: stash the
  // modeId in TokenSet.meta during export so it round-trips through
  // Tokens Studio.
  return undefined;
}

/**
 * Map DTCG types to Tokens Studio's type names. Tokens Studio uses SD-style
 * type names with some additions (e.g. "sizing", "borderRadius",
 * "boxShadow", "typography", "opacity", "fontFamilies", "fontWeights").
 */
function tsTypeFor(token: Token): string {
  if (token.type === "color") return "color";
  if (token.type === "fontFamily") return "fontFamilies";
  if (token.type === "fontWeight") return "fontWeights";
  if (token.type === "typography") return "typography";
  if (token.type === "shadow") return "boxShadow";
  if (token.type === "duration") return "time";
  if (token.type === "dimension") {
    const lower = token.path[0]?.toLowerCase() ?? "";
    if (lower.includes("border") || lower.includes("radius")) return "borderRadius";
    if (lower.startsWith("space") || lower.startsWith("spacing")) return "spacing";
    if (lower.includes("size") || lower.includes("width") || lower.includes("height"))
      return "sizing";
    return "sizing";
  }
  return token.type;
}

function tsValueFor(
  value: TokenValue,
  token: Token,
  warnings: string[],
): unknown {
  if (value.reference) {
    const bare = value.reference.replace(/^\{|\}$/g, "");
    if (bare.startsWith("__library:") || bare === "unknown") {
      warnings.push(
        `Skipped ${token.path.join(".")} in Tokens Studio — cross-library alias unresolved.`,
      );
      return undefined;
    }
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
  // $-prefixed keys first (matches Tokens Studio convention), then alphabetical.
  const keys = Object.keys(obj).sort((a, b) => {
    const aDollar = a.startsWith("$");
    const bDollar = b.startsWith("$");
    if (aDollar && !bDollar) return -1;
    if (!aDollar && bDollar) return 1;
    return a.localeCompare(b);
  });
  for (const k of keys) sorted[k] = sortKeys(obj[k] as unknown);
  return sorted as T;
}
