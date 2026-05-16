/**
 * DTCG (Design Tokens Community Group) JSON parser.
 *
 * Reads DTCG-spec JSON (https://tr.designtokens.org/format/) and produces our
 * canonical internal TokenDocument. Designed for non-destructive round-trip:
 * a document serialized by `formatDtcg` then parsed back through this module
 * is equal to the original (modulo key ordering, which the formatter sorts
 * for stable diffs).
 *
 * Handles:
 *   - Group nesting with arbitrary depth
 *   - $value / $type / $description / $extensions on leaf tokens
 *   - Alias references: `"$value": "{path.to.token}"`
 *   - Group-level $type inheritance per the DTCG spec (tokens without their
 *     own $type inherit from their nearest ancestor group that has one)
 *   - Our $extensions["figma-console-mcp"] metadata for round-trip ID preservation
 *   - Multi-mode tokens stashed in $extensions.modes by our formatter
 */

import type {
  Token,
  TokenDocument,
  TokenSet,
  TokenType,
  TokenValue,
} from "../types.js";
import { FIGMA_MCP_EXTENSION_KEY } from "../types.js";
import { parseDtcgReference } from "../alias-resolver.js";
import type { ParseInput, ParseResult } from "./index.js";

interface DtcgGroup {
  $description?: string;
  $extensions?: Record<string, unknown>;
  $type?: string;
  [key: string]: unknown;
}

const DTCG_TYPES = new Set<TokenType>([
  "color",
  "dimension",
  "fontFamily",
  "fontWeight",
  "duration",
  "cubicBezier",
  "number",
  "string",
  "boolean",
  "shadow",
  "typography",
  "gradient",
  "border",
  "transition",
  "strokeStyle",
]);

export function parseDtcg(input: ParseInput): ParseResult {
  const warnings: string[] = [];
  const root = parseJson(input);

  // Document-level $extensions: pull out our MCP metadata if present.
  // `fileMode` is the critical piece for splitByMode round-trip — when set,
  // every token in the file represents that mode's value, so we label them
  // accordingly instead of falling back to "Default".
  const meta: TokenDocument["meta"] = {};
  let fileMode: string | undefined;
  const rootExt = (root as DtcgGroup).$extensions;
  if (rootExt && typeof rootExt === "object") {
    const mcpMeta = (rootExt as Record<string, unknown>)[FIGMA_MCP_EXTENSION_KEY];
    if (mcpMeta && typeof mcpMeta === "object") {
      const m = mcpMeta as Record<string, unknown>;
      if (typeof m.figmaFileKey === "string") meta.figmaFileKey = m.figmaFileKey;
      if (typeof m.exportedAt === "string") meta.exportedAt = m.exportedAt;
      if (typeof m.mcpVersion === "string") meta.mcpVersion = m.mcpVersion;
      if (typeof m.fileMode === "string") fileMode = m.fileMode;
    }
  }

  // Each top-level group is a TokenSet. Walk it to extract its tokens.
  const sets: TokenSet[] = [];
  for (const [setKey, setNode] of Object.entries(root as DtcgGroup)) {
    if (setKey.startsWith("$")) continue; // $extensions etc.
    if (!setNode || typeof setNode !== "object") {
      warnings.push(
        `Top-level entry "${setKey}" is not a group; skipping. Expected object.`,
      );
      continue;
    }
    sets.push(extractSet(setKey, setNode as DtcgGroup, warnings, fileMode));
  }

  return {
    document: {
      $schema:
        "https://figma-console-mcp.southleft.com/schemas/dtcg-extended-v1.json",
      sets,
      meta: Object.keys(meta).length > 0 ? meta : undefined,
    },
    detectedFormat: "dtcg",
    warnings,
  };
}

function parseJson(input: ParseInput): unknown {
  try {
    return JSON.parse(input.payload);
  } catch (err) {
    throw new Error(
      `[figma-console-mcp] Failed to parse DTCG JSON${
        input.sourcePath ? ` at ${input.sourcePath}` : ""
      }: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function extractSet(
  setKey: string,
  setNode: DtcgGroup,
  warnings: string[],
  fileMode?: string,
): TokenSet {
  const tokens: Token[] = [];
  const modes = new Set<string>();

  // Set-level metadata pulled from $extensions["figma-console-mcp"]. We
  // recover the original (un-slugified) set name from `originalName` so
  // round-trip matching works even after slugification.
  const setExt = setNode.$extensions;
  let figmaCollectionId: string | undefined;
  let originalName: string | undefined;
  if (setExt && typeof setExt === "object") {
    const mcp = (setExt as Record<string, unknown>)[FIGMA_MCP_EXTENSION_KEY];
    if (mcp && typeof mcp === "object") {
      const m = mcp as Record<string, unknown>;
      if (typeof m.figmaCollectionId === "string") {
        figmaCollectionId = m.figmaCollectionId;
      }
      if (typeof m.originalName === "string") {
        originalName = m.originalName;
      }
    }
  }

  // Walk the set's tree, collecting tokens.
  walkGroup(setNode, [], undefined, tokens, modes, warnings, fileMode);

  return {
    name: originalName ?? setKey,
    description:
      typeof setNode.$description === "string" ? setNode.$description : undefined,
    modes: modes.size > 0 ? [...modes] : ["Default"],
    tokens,
    meta: figmaCollectionId ? { figmaCollectionId } : undefined,
  };
}

function walkGroup(
  node: DtcgGroup,
  path: string[],
  inheritedType: TokenType | undefined,
  tokens: Token[],
  modes: Set<string>,
  warnings: string[],
  fileMode?: string,
): void {
  // Group-level $type provides inheritance for descendant tokens that lack
  // their own $type, per the DTCG spec.
  const groupType =
    typeof node.$type === "string" && DTCG_TYPES.has(node.$type as TokenType)
      ? (node.$type as TokenType)
      : inheritedType;

  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    if (!value || typeof value !== "object") {
      warnings.push(
        `Non-group, non-token entry at ${[...path, key].join(".")}; skipping.`,
      );
      continue;
    }

    const childPath = [...path, key];
    if (isLeafToken(value as DtcgGroup)) {
      const token = extractToken(
        childPath,
        value as Record<string, unknown>,
        groupType,
        warnings,
        fileMode,
      );
      tokens.push(token);
      for (const mode of Object.keys(token.values)) modes.add(mode);
    } else {
      walkGroup(
        value as DtcgGroup,
        childPath,
        groupType,
        tokens,
        modes,
        warnings,
        fileMode,
      );
    }
  }
}

function isLeafToken(node: DtcgGroup): boolean {
  return "$value" in node;
}

function extractToken(
  path: string[],
  node: Record<string, unknown>,
  inheritedType: TokenType | undefined,
  warnings: string[],
  fileMode?: string,
): Token {
  const rawType = node.$type;
  let type: TokenType;
  if (typeof rawType === "string" && DTCG_TYPES.has(rawType as TokenType)) {
    type = rawType as TokenType;
  } else if (inheritedType) {
    type = inheritedType;
  } else {
    type = inferType(node.$value);
    warnings.push(
      `Token ${path.join(".")} has no $type and no group $type inherited; inferred "${type}".`,
    );
  }

  const description =
    typeof node.$description === "string" ? node.$description : undefined;

  // Detect multi-mode stashed in $extensions.{FIGMA_MCP_EXTENSION_KEY}.modes
  // (placed there by our own formatter for one-file-multi-mode output).
  const values: Record<string, TokenValue> = {};
  const ext = node.$extensions;
  const mcpExt =
    ext && typeof ext === "object"
      ? ((ext as Record<string, unknown>)[FIGMA_MCP_EXTENSION_KEY] as
          | Record<string, unknown>
          | undefined)
      : undefined;
  const stashedModes = mcpExt?.modes as Record<string, unknown> | undefined;

  // Decide which mode name to assign to the primary $value.
  //   1. If the file declares a fileMode (splitByMode output), use that.
  //   2. Otherwise fall back to "Default" — the parser can't know the
  //      mode without that hint.
  // Then absorb any stashedModes (one-file-multi-mode output) verbatim.
  const primaryMode = fileMode ?? "Default";
  values[primaryMode] = decodeValue(node.$value);

  if (stashedModes) {
    for (const [modeName, modeValue] of Object.entries(stashedModes)) {
      // Don't overwrite the primary if a stashed entry collides with it.
      if (modeName !== primaryMode) {
        values[modeName] = decodeValue(modeValue);
      }
    }
  }

  // Preserve all other vendor extensions verbatim.
  let extensions: Token["extensions"];
  if (ext && typeof ext === "object") {
    extensions = {};
    for (const [vendor, payload] of Object.entries(ext as object)) {
      if (
        vendor === FIGMA_MCP_EXTENSION_KEY &&
        payload &&
        typeof payload === "object"
      ) {
        // Strip the "modes" we already absorbed into values.
        const cleaned: Record<string, unknown> = { ...(payload as object) };
        delete cleaned.modes;
        if (Object.keys(cleaned).length > 0) {
          (extensions as Record<string, unknown>)[vendor] = cleaned;
        }
      } else {
        (extensions as Record<string, unknown>)[vendor] = payload;
      }
    }
    if (Object.keys(extensions).length === 0) extensions = undefined;
  }

  return {
    path,
    type,
    description,
    values,
    extensions,
  };
}

/**
 * Convert a DTCG $value to our internal TokenValue. Detects alias references
 * (strings of the form `{path.to.token}`) and unwraps them into TokenValue.reference.
 */
function decodeValue(rawValue: unknown): TokenValue {
  if (typeof rawValue === "string") {
    const refPath = parseDtcgReference(rawValue);
    if (refPath) {
      return { reference: rawValue };
    }
    return { literal: rawValue };
  }
  if (
    rawValue === null ||
    typeof rawValue === "number" ||
    typeof rawValue === "boolean"
  ) {
    return { literal: rawValue ?? "" };
  }
  // Composite values (typography, shadow, etc.) — preserve verbatim.
  return { literal: rawValue as Record<string, unknown> };
}

function inferType(rawValue: unknown): TokenType {
  if (typeof rawValue === "string") {
    // Heuristics: color-ish strings → color; px/rem/em → dimension; else string.
    if (/^#[0-9a-f]{3,8}$/i.test(rawValue)) return "color";
    if (/^(rgb|hsl|oklch)/i.test(rawValue)) return "color";
    if (/^[\d.]+(px|rem|em|pt|dp)$/i.test(rawValue)) return "dimension";
    return "string";
  }
  if (typeof rawValue === "number") return "number";
  if (typeof rawValue === "boolean") return "boolean";
  return "string";
}
