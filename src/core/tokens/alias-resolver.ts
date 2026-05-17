/**
 * Alias reference resolution and validation.
 *
 * DTCG alias references look like `{color.primary}` or `{tier-1.color.blue.500}`.
 * They can chain (an alias can reference another alias), but cycles are an
 * error.
 *
 * This module:
 *   - Resolves an alias to its eventual literal value (for formatters that
 *     can't natively express references — CSS, SCSS, Tailwind).
 *   - Validates that every alias points to an existing token.
 *   - Detects cycles.
 */

import type { Token, TokenDocument, TokenValue } from "./types.js";

/**
 * Build a lookup map from dot-path strings (e.g. "color.primary") to Token
 * objects. Used as the index for resolveAliases().
 */
export function buildTokenIndex(doc: TokenDocument): Map<string, Token> {
  const index = new Map<string, Token>();
  for (const set of doc.sets) {
    for (const token of set.tokens) {
      const key = token.path.join(".");
      index.set(key, token);
    }
  }
  return index;
}

/**
 * Resolve a single alias reference. Returns the eventual literal value, or
 * throws if the reference is unresolvable or cyclic.
 */
export function resolveReference(
  reference: string,
  mode: string,
  index: Map<string, Token>,
  seen: Set<string> = new Set(),
): TokenValue {
  // Strip the curly braces if present: "{color.primary}" → "color.primary"
  const path = reference.replace(/^\{|\}$/g, "");

  if (seen.has(path)) {
    throw new Error(
      `[figma-console-mcp] Alias cycle detected: ${[...seen, path].join(" → ")}`,
    );
  }
  seen.add(path);

  const target = index.get(path);
  if (!target) {
    throw new Error(
      `[figma-console-mcp] Unresolvable alias reference: {${path}}`,
    );
  }

  // Find the value for the requested mode; fall back to the only mode if
  // there's just one (alias's target may be single-mode while the source
  // is multi-mode, or vice versa).
  const value =
    target.values[mode] ??
    (Object.keys(target.values).length === 1
      ? Object.values(target.values)[0]
      : undefined);

  if (!value) {
    throw new Error(
      `[figma-console-mcp] Alias {${path}} has no value for mode "${mode}"`,
    );
  }

  // Chain: if the target's value is itself an alias, recurse.
  if (value.reference) {
    return resolveReference(value.reference, mode, index, seen);
  }
  return value;
}

/**
 * Validate every alias in the document. Returns a list of error messages —
 * empty array means all aliases resolve cleanly.
 */
export function validateAliases(doc: TokenDocument): string[] {
  const index = buildTokenIndex(doc);
  const errors: string[] = [];
  for (const set of doc.sets) {
    for (const token of set.tokens) {
      for (const [mode, value] of Object.entries(token.values)) {
        if (value.reference) {
          try {
            resolveReference(value.reference, mode, index);
          } catch (err) {
            errors.push(
              `${token.path.join(".")} (mode "${mode}"): ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }
    }
  }
  return errors;
}

/**
 * Format an alias reference for DTCG output. DTCG uses `{path.to.token}`
 * syntax with curly braces.
 */
export function formatDtcgReference(referencePath: string[]): string {
  return `{${referencePath.join(".")}}`;
}

/**
 * Parse a DTCG alias string back into a path array. Returns null if the
 * string isn't an alias reference.
 */
export function parseDtcgReference(s: string): string[] | null {
  const match = s.match(/^\{([^}]+)\}$/);
  if (!match) return null;
  return match[1].split(".");
}
