/**
 * Plain JSON formatters — flat and nested.
 *
 * These are dumps without the DTCG `$type`/`$value` envelope, for custom
 * build scripts that just need a key-value map of resolved tokens.
 *
 * Flat shape:
 *
 *   {
 *     "ds-color-primary": "#4085F2",
 *     "ds-spacing-md": "16px",
 *     "ds-color-bg--dark": "#0A0A0A"
 *   }
 *
 * Multi-mode tokens flatten with `--<mode>` suffix (primary mode keeps
 * the bare name; other modes get suffixed).
 *
 * Nested shape:
 *
 *   {
 *     "color": {
 *       "primary": "#4085F2",
 *       "brand": { "primary": "#FF00AA" }
 *     },
 *     "spacing": { "md": "16px" }
 *   }
 *
 * Multi-mode tokens become objects: `{ Light: "...", Dark: "..." }`.
 *
 * Aliases resolve to the literal value where possible; cross-library
 * aliases get a `null` (caller can decide how to fill those in).
 */

import type { Token, TokenDocument, TokenSet, TokenValue } from "../types.js";
import type { FormatOptions, FormatResult } from "./index.js";

export function formatJsonFlat(
  doc: TokenDocument,
  opts: FormatOptions,
): FormatResult {
  const warnings: string[] = [];
  const files: FormatResult["files"] = [];

  const splitByCollection = opts.target.splitByCollection ?? false;
  const prefix = opts.target.prefix ?? "";

  if (splitByCollection) {
    for (const set of doc.sets) {
      files.push({
        path: filenameFor(opts, set, "flat"),
        content: renderFlat([set], prefix, warnings),
      });
    }
  } else {
    files.push({
      path: filenameFor(opts, undefined, "flat"),
      content: renderFlat(doc.sets, prefix, warnings),
    });
  }

  return { files, warnings };
}

export function formatJsonNested(
  doc: TokenDocument,
  opts: FormatOptions,
): FormatResult {
  const warnings: string[] = [];
  const files: FormatResult["files"] = [];

  const splitByCollection = opts.target.splitByCollection ?? false;

  if (splitByCollection) {
    for (const set of doc.sets) {
      files.push({
        path: filenameFor(opts, set, "nested"),
        content: renderNested([set], warnings),
      });
    }
  } else {
    files.push({
      path: filenameFor(opts, undefined, "nested"),
      content: renderNested(doc.sets, warnings),
    });
  }

  return { files, warnings };
}

function filenameFor(
  opts: FormatOptions,
  set: TokenSet | undefined,
  shape: "flat" | "nested",
): string {
  if (opts.target.filename) return opts.target.filename;
  const parts: string[] = [];
  if (set) parts.push(slugify(set.name));
  parts.push(`tokens.${shape}`);
  return `${parts.join(".")}.json`;
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function renderFlat(
  sets: TokenSet[],
  prefix: string,
  warnings: string[],
): string {
  const out: Record<string, unknown> = {};

  for (const set of sets) {
    const primaryMode = pickPrimaryMode(set.modes);
    for (const token of set.tokens) {
      const baseName = `${prefix}${token.path.map(slugify).join("-")}`;
      for (const [modeName, value] of Object.entries(token.values)) {
        const key =
          modeName === primaryMode
            ? baseName
            : `${baseName}--${slugify(modeName)}`;
        const resolved = resolveValue(value, token, warnings);
        if (resolved !== undefined) out[key] = resolved;
      }
    }
  }

  // Sort keys for deterministic output.
  const sorted = Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify(sorted, null, 2) + "\n";
}

function renderNested(sets: TokenSet[], warnings: string[]): string {
  const out: Record<string, unknown> = {};

  for (const set of sets) {
    const isMultiMode = set.modes.length > 1;
    for (const token of set.tokens) {
      let cursor: Record<string, unknown> = out;
      for (let i = 0; i < token.path.length - 1; i++) {
        const segment = token.path[i];
        if (
          !cursor[segment] ||
          typeof cursor[segment] !== "object" ||
          Array.isArray(cursor[segment])
        ) {
          cursor[segment] = {};
        }
        cursor = cursor[segment] as Record<string, unknown>;
      }
      const leafKey = token.path[token.path.length - 1];

      if (isMultiMode) {
        const modeValues: Record<string, unknown> = {};
        for (const [modeName, value] of Object.entries(token.values)) {
          const resolved = resolveValue(value, token, warnings);
          if (resolved !== undefined) modeValues[modeName] = resolved;
        }
        cursor[leafKey] = modeValues;
      } else {
        const onlyValue = Object.values(token.values)[0];
        if (onlyValue) {
          const resolved = resolveValue(onlyValue, token, warnings);
          if (resolved !== undefined) cursor[leafKey] = resolved;
        }
      }
    }
  }

  return JSON.stringify(sortKeys(out), null, 2) + "\n";
}

function pickPrimaryMode(modes: string[]): string {
  return modes.find((m) => /^(default|light|value)$/i.test(m)) ?? modes[0];
}

function resolveValue(
  value: TokenValue,
  token: Token,
  warnings: string[],
): unknown {
  if (value.reference) {
    const bare = value.reference.replace(/^\{|\}$/g, "");
    if (bare.startsWith("__library:") || bare === "unknown") {
      warnings.push(
        `Skipped ${token.path.join(".")} in JSON — cross-library alias unresolved.`,
      );
      return null;
    }
    // Local alias: emit as the reference path. Caller can resolve.
    return `{${bare}}`;
  }
  if (value.literal === undefined || value.literal === null) return undefined;
  if (typeof value.literal === "number") {
    if (token.type === "dimension") return `${value.literal}px`;
    return value.literal;
  }
  return value.literal as unknown;
}

function sortKeys<T>(obj: T): T {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  for (const k of keys) {
    sorted[k] = sortKeys((obj as Record<string, unknown>)[k] as unknown);
  }
  return sorted as T;
}
