/**
 * DTCG (Design Tokens Community Group) JSON formatter.
 *
 * Produces W3C-spec DTCG output (https://tr.designtokens.org/format/) with
 * three nuances:
 *
 *   1. Multi-mode tokens. The DTCG v1 spec doesn't natively express modes;
 *      we use a separate file per mode (driven by `splitByMode: true`) or a
 *      single file with values keyed by mode under a vendor extension when
 *      splitByMode is false. The split-file approach is the recommended
 *      pattern in the broader DTCG community and is what Style Dictionary
 *      v4, Tokens Studio, and Figma's announced native export all use.
 *
 *   2. $extensions["figma-console-mcp"]. We stash Figma variable IDs and
 *      last-synced values here for non-destructive round-trip. Other DTCG
 *      tools preserve $extensions verbatim.
 *
 *   3. Composite tokens (typography, shadow, gradient) emit DTCG's
 *      structured $value form. Aliases emit `"$value": "{path.to.target}"`.
 *
 * This formatter is the canonical output — the format every other
 * formatter (CSS variables today, Tailwind/SCSS/etc. in future minor
 * versions) ultimately derives from.
 */

import type {
  Token,
  TokenDocument,
  TokenSet,
  TokenValue,
} from "../types.js";
import { FIGMA_MCP_EXTENSION_KEY } from "../types.js";
import { formatDtcgReference } from "../alias-resolver.js";
import type { FormatOptions, FormatResult } from "./index.js";

/**
 * DTCG JSON output shape — what we serialize to disk. Closely follows the
 * W3C DTCG draft format module.
 */
interface DtcgGroup {
  $description?: string;
  $extensions?: Record<string, unknown>;
  // Recursive: nested groups under string keys, or leaf tokens.
  [key: string]: DtcgGroup | DtcgToken | string | Record<string, unknown> | undefined;
}

interface DtcgToken {
  $value: string | number | boolean | object;
  $type?: string;
  $description?: string;
  $extensions?: Record<string, unknown>;
}

export function formatDtcg(
  doc: TokenDocument,
  opts: FormatOptions,
): FormatResult {
  const warnings: string[] = [];
  const files: FormatResult["files"] = [];

  // Figure out which sets and modes to emit, and how they map to files.
  // Three layout strategies:
  //   1. splitByMode + splitByCollection → one file per (set, mode) pair
  //   2. splitByMode → one file per mode, all sets merged
  //   3. splitByCollection → one file per set, all modes in one tree
  //   4. neither → one file with everything

  const splitByMode = opts.target.splitByMode ?? false;
  const splitByCollection = opts.target.splitByCollection ?? false;

  if (splitByMode && splitByCollection) {
    for (const set of doc.sets) {
      for (const mode of set.modes) {
        const fileTokens = set.tokens
          .map((t) => projectTokenToMode(t, mode, warnings))
          .filter((t): t is Token => t !== null);
        files.push({
          path: filenameFor(opts, set, mode),
          content: serializeAsDtcg(
            { sets: [{ ...set, modes: [mode], tokens: fileTokens }], meta: doc.meta },
            warnings,
            mode,
          ),
        });
      }
    }
  } else if (splitByMode) {
    const allModes = new Set<string>();
    for (const set of doc.sets) for (const m of set.modes) allModes.add(m);
    for (const mode of allModes) {
      const fileSets: TokenSet[] = doc.sets
        .filter((s) => s.modes.includes(mode))
        .map((s) => ({
          ...s,
          modes: [mode],
          tokens: s.tokens
            .map((t) => projectTokenToMode(t, mode, warnings))
            .filter((t): t is Token => t !== null),
        }));
      files.push({
        path: filenameFor(opts, undefined, mode),
        content: serializeAsDtcg({ sets: fileSets, meta: doc.meta }, warnings, mode),
      });
    }
  } else if (splitByCollection) {
    for (const set of doc.sets) {
      files.push({
        path: filenameFor(opts, set),
        content: serializeAsDtcg({ sets: [set], meta: doc.meta }, warnings),
      });
    }
  } else {
    files.push({
      path: filenameFor(opts),
      content: serializeAsDtcg(doc, warnings),
    });
  }

  return { files, warnings };
}

/**
 * Project a token's values down to a single mode. Returns null if the token
 * has no value for the requested mode (skip rather than emit a blank).
 */
function projectTokenToMode(
  token: Token,
  mode: string,
  warnings: string[],
): Token | null {
  const value = token.values[mode];
  if (!value) {
    // Token wasn't defined for this mode. Could happen when sets share tokens
    // but only some have multi-mode values. Skip silently — not an error.
    return null;
  }
  return { ...token, values: { [mode]: value } };
}

/**
 * Compute the output filename for a given (set?, mode?) tuple based on the
 * target options.
 */
function filenameFor(
  opts: FormatOptions,
  set?: TokenSet,
  mode?: string,
): string {
  // Caller-specified filename wins.
  if (opts.target.filename) return opts.target.filename;

  const parts: string[] = [];
  if (set) parts.push(slugify(set.name));
  if (mode) parts.push(slugify(mode));
  if (parts.length === 0) parts.push("tokens");
  return `${parts.join(".")}.tokens.json`;
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Serialize a TokenDocument as DTCG JSON. Returns a pretty-printed JSON string
 * with stable key order so git diffs stay minimal across runs.
 *
 * When `fileMode` is provided (splitByMode output), it's stamped into
 * document-level $extensions so the parser can recover which mode this
 * file represents — otherwise the parser sees only `$value` literals and
 * labels them "Default", which breaks round-trip diffs on multi-mode files.
 */
function serializeAsDtcg(
  doc: TokenDocument,
  warnings: string[],
  fileMode?: string,
): string {
  // Build the nested DTCG group tree by walking every token's path and
  // building groups along the way.
  const tree: DtcgGroup = {};

  // Document-level $extensions: stash file-level metadata (Figma file key,
  // export timestamp, MCP version, optionally the file's mode for
  // splitByMode output) so round-trip preserves it.
  const mcpDocMeta: Record<string, unknown> = {};
  if (doc.meta?.figmaFileKey) mcpDocMeta.figmaFileKey = doc.meta.figmaFileKey;
  if (doc.meta?.exportedAt) mcpDocMeta.exportedAt = doc.meta.exportedAt;
  if (doc.meta?.mcpVersion) mcpDocMeta.mcpVersion = doc.meta.mcpVersion;
  if (fileMode) mcpDocMeta.fileMode = fileMode;
  if (Object.keys(mcpDocMeta).length > 0) {
    tree.$extensions = { [FIGMA_MCP_EXTENSION_KEY]: mcpDocMeta };
  }

  for (const set of doc.sets) {
    // Each set lives under a top-level group named after the set. Set-level
    // metadata (Figma collection ID, original name, etc.) goes in that
    // group's $extensions so round-trip recovers the original name even
    // after we slugify it for the JSON key.
    const setKey = setKeyFor(set);
    let setGroup = tree[setKey] as DtcgGroup | undefined;
    if (!setGroup) {
      setGroup = {};
      if (set.description) setGroup.$description = set.description;
      const mcpMeta: Record<string, unknown> = {};
      if (set.meta?.figmaCollectionId) {
        mcpMeta.figmaCollectionId = set.meta.figmaCollectionId;
      }
      // Always stash the original name when it differs from the slug — this
      // is what makes diff matching work after round-trip.
      if (set.name !== setKey) {
        mcpMeta.originalName = set.name;
      }
      if (Object.keys(mcpMeta).length > 0) {
        setGroup.$extensions = { [FIGMA_MCP_EXTENSION_KEY]: mcpMeta };
      }
      tree[setKey] = setGroup;
    }

    for (const token of set.tokens) {
      writeTokenIntoTree(setGroup, token, set.modes, warnings);
    }
  }

  return JSON.stringify(sortKeys(tree), null, 2) + "\n";
}

/**
 * Key used for the top-level set group in DTCG. We slugify the set name to
 * keep it a valid JSON key under any consumer's expectations. The original
 * (un-slugged) name is preserved in the set's $extensions so round-trip
 * recovers it.
 */
function setKeyFor(set: TokenSet): string {
  return slugify(set.name);
}

/**
 * Insert a token into the DTCG group tree at the right nested path.
 * Creates intermediate groups as needed.
 */
function writeTokenIntoTree(
  root: DtcgGroup,
  token: Token,
  setModes: string[],
  warnings: string[],
): void {
  let cursor: DtcgGroup = root;
  for (let i = 0; i < token.path.length - 1; i++) {
    const segment = token.path[i];
    let next = cursor[segment] as DtcgGroup | undefined;
    if (!next || isToken(next)) {
      next = {};
      cursor[segment] = next;
    }
    cursor = next;
  }

  const leafKey = token.path[token.path.length - 1];
  cursor[leafKey] = renderToken(token, setModes, warnings);
}

function isToken(node: DtcgGroup | DtcgToken): node is DtcgToken {
  return "$value" in node;
}

/**
 * Convert an internal Token to its DTCG-encoded leaf form.
 *
 * Single-mode token: emits `{ $value, $type, ... }`.
 * Multi-mode token: emits one extension stash with all mode values, because
 * vanilla DTCG doesn't have a native multi-mode encoding. Callers who want
 * one-file-per-mode should set splitByMode at the formatter level.
 */
function renderToken(
  token: Token,
  setModes: string[],
  warnings: string[],
): DtcgToken {
  const result: DtcgToken = {
    $value: "" as string | number | boolean | object,
    $type: token.type,
  };
  if (token.description) result.$description = token.description;

  const modeKeys = Object.keys(token.values);
  const isSingleMode = modeKeys.length === 1;

  if (isSingleMode) {
    const onlyValue = token.values[modeKeys[0]];
    result.$value = encodeValue(onlyValue, token, warnings);
  } else {
    // Multi-mode in a single file: pick the first mode as the canonical
    // $value, stash the rest in $extensions for round-trip.
    const primaryMode = setModes[0] in token.values ? setModes[0] : modeKeys[0];
    result.$value = encodeValue(token.values[primaryMode], token, warnings);

    const otherModes: Record<string, unknown> = {};
    for (const m of modeKeys) {
      if (m === primaryMode) continue;
      otherModes[m] = encodeValue(token.values[m], token, warnings);
    }
    if (Object.keys(otherModes).length > 0) {
      mergeExtension(result, "modes", otherModes);
    }
  }

  // Preserve any pre-existing extensions (e.g. studio.tokens, our own metadata).
  if (token.extensions) {
    for (const [vendor, payload] of Object.entries(token.extensions)) {
      if (vendor === FIGMA_MCP_EXTENSION_KEY) {
        mergeExtension(result, vendor, payload as Record<string, unknown>);
      } else {
        mergeExtension(result, vendor, payload);
      }
    }
  }

  return result;
}

function encodeValue(
  value: TokenValue,
  token: Token,
  warnings: string[],
): string | number | boolean | object {
  if (value.reference) {
    return formatDtcgReference(value.reference.replace(/^\{|\}$/g, "").split("."));
  }
  if (value.literal === undefined) {
    warnings.push(
      `Token ${token.path.join(".")} has neither literal nor reference — emitting empty string.`,
    );
    return "";
  }
  return value.literal as string | number | boolean | object;
}

function mergeExtension(
  token: DtcgToken,
  key: string,
  payload: unknown,
): void {
  token.$extensions ??= {};
  token.$extensions[key] = payload;
}

/**
 * Recursively sort object keys for stable serialization (so git diffs only
 * show meaningful changes). $-prefixed keys come first (DTCG convention),
 * then alphabetical.
 */
function sortKeys<T>(node: T): T {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return node;
  }
  const obj = node as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
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
