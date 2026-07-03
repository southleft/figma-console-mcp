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
 * Slugify a set/collection name into the key used for the top-level set
 * group in DTCG output AND the set-qualifier prefix in alias references
 * (`{<set-slug>.<path.to.token>}`). Must stay in sync with the DTCG
 * formatter's group keys so emitted references resolve inside the file.
 */
export function slugifySetName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build a lookup map for alias resolution. Every token is indexed under its
 * set-qualified key (`<set-slug>.<dot.path>` — the same shape the converter
 * emits in references), and additionally under its bare dot-path
 * (`color.primary`) when that bare path is unambiguous across sets.
 *
 * When two collections both contain the same bare path (e.g. two collections
 * each defining `color/primary`), the bare key is NOT indexed — resolving a
 * bare reference to "whichever set was indexed last" is exactly the
 * cross-collection misresolution bug this guards against. Callers that pass
 * a `warnings` array get one warning per ambiguous bare path.
 */
export function buildTokenIndex(
  doc: TokenDocument,
  warnings?: string[],
): Map<string, Token> {
  const index = new Map<string, Token>();
  for (const [key, entry] of buildTokenLookup(doc, warnings)) {
    index.set(key, entry.token);
  }
  return index;
}

/**
 * A token plus its owning set. The set name is what the import apply phase
 * needs to build `<set-name>::<dot.path>` diff keys from a resolved alias
 * target (variable creation and alias-target updates).
 */
export interface TokenLookupEntry {
  setName: string;
  token: Token;
}

/**
 * Set-aware variant of buildTokenIndex — identical key scheme and ambiguity
 * rules (set-qualified keys always; bare-path fallback only when unambiguous
 * across sets), but each entry carries the owning set's name alongside the
 * token. buildTokenIndex delegates to this so the two can never drift.
 */
export function buildTokenLookup(
  doc: TokenDocument,
  warnings?: string[],
): Map<string, TokenLookupEntry> {
  const index = new Map<string, TokenLookupEntry>();
  // barePath → owning entries, used to detect cross-set ambiguity.
  const bareOwners = new Map<string, TokenLookupEntry[]>();

  for (const set of doc.sets) {
    const setKey = slugifySetName(set.name);
    for (const token of set.tokens) {
      const bare = token.path.join(".");
      index.set(`${setKey}.${bare}`, { setName: set.name, token });
      const owners = bareOwners.get(bare) ?? [];
      owners.push({ setName: set.name, token });
      bareOwners.set(bare, owners);
    }
  }

  // Bare-path fallback: only when a path exists in exactly one set, and only
  // when it doesn't shadow a set-qualified key that's already indexed.
  for (const [bare, owners] of bareOwners) {
    if (owners.length === 1) {
      if (!index.has(bare)) index.set(bare, owners[0]);
    } else if (warnings) {
      warnings.push(
        `Token path "${bare}" exists in multiple collections (${owners
          .map((o) => `"${o.setName}"`)
          .join(", ")}) — bare alias references to it are ambiguous and will not resolve. Use a set-qualified reference like {${slugifySetName(owners[0].setName)}.${bare}}.`,
      );
    }
  }

  return index;
}

/**
 * Resolve a reference to the path segments of its TARGET token — for
 * formatters that name-ify aliases (CSS `var(--...)`, SCSS `$...`,
 * Tokens Studio / SD v3 `{...}` refs). Set-qualified references
 * (`{set-slug.path.to.token}`) resolve to the target token's own path
 * (WITHOUT the set qualifier), matching how those formatters name the
 * target's declaration. Falls back to the raw reference path when the
 * target isn't in the index (e.g. hand-written bare refs to tokens that
 * weren't exported).
 */
export function referenceTargetPath(
  reference: string,
  index: Map<string, Token>,
): string[] {
  const bare = reference.replace(/^\{|\}$/g, "");
  const target = index.get(bare);
  if (target) return target.path;
  return bare.split(".");
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
 * Resolve an alias chain to its final literal value, walking through
 * intermediate alias hops. Returns the final TokenValue (with `literal` set
 * if resolution succeeded) or `null` if the chain ends at a cross-library
 * reference / unresolvable target / cycle.
 *
 * Used by formatters that can't natively express alias references in their
 * output (Tailwind v3, TypeScript modules, plain JSON) — those need literal
 * values at export time.
 *
 * Safer counterpart of `resolveReference` because it swallows errors
 * (unresolvable / cycle) into `null` rather than throwing; formatters can
 * then emit a comment or skip the token instead of failing the whole export.
 */
export function resolveAliasChain(
  value: TokenValue,
  mode: string,
  index: Map<string, Token>,
): TokenValue | null {
  if (!value.reference) return value;

  // Cross-library aliases are not resolvable — formatters should skip with a comment.
  const bare = value.reference.replace(/^\{|\}$/g, "");
  if (bare.startsWith("__library:") || bare === "unknown") return null;

  try {
    const resolved = resolveReference(value.reference, mode, index);
    // resolveReference throws on cycles / unresolvable, so a returned value
    // is either a literal or another reference. If still a reference,
    // recurse (defensive — resolveReference already chases chains, but the
    // top-level call may return a value with `reference` if mode-fallback
    // routes through an aliased entry).
    if (resolved.reference) {
      return resolveAliasChain(resolved, mode, index);
    }
    return resolved;
  } catch {
    return null;
  }
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
