/**
 * Convert Figma's variables API response into our canonical TokenDocument.
 *
 * Input: the shape produced by `formatVariables()` in src/core/figma-api.ts
 * (an object with `collections` and `variables` arrays, matching either the
 * REST API's response or the Desktop Bridge plugin's `getLocalVariablesAsync`
 * normalized payload).
 *
 * Output: a TokenDocument with one TokenSet per collection, paths derived
 * from Figma variable names (slash-separated → path arrays), values
 * normalized to our TokenValue shape, and Figma IDs preserved in
 * $extensions["figma-console-mcp"] for round-trip non-destructiveness.
 */

import type {
  Token,
  TokenDocument,
  TokenSet,
  TokenType,
  TokenValue,
} from "./types.js";
import { slugifySetName } from "./alias-resolver.js";

/**
 * Shape of Figma's variable collection as returned by formatVariables(). We
 * use a narrow structural type rather than importing the existing `any`
 * shape from figma-api.ts.
 */
interface FigmaCollection {
  id: string;
  name: string;
  key?: string;
  modes: Array<{ modeId: string; name: string }>;
  variableIds: string[];
}

interface FigmaVariable {
  id: string;
  name: string; // Slash-separated, e.g. "color/primary"
  key?: string;
  resolvedType: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN" | "TIMING" | "EASING";
  variableCollectionId: string;
  description?: string;
  scopes?: string[];
  /**
   * Per-mode values. Each value is either a literal or a `{ type: "VARIABLE_ALIAS", id }`
   * pointing at another variable.
   */
  valuesByMode: Record<string, FigmaValue>;
}

/**
 * Config-2026 EASING variable value shape. `bezierValues` is present for
 * bezier-based easings; spring easings carry `springValues` instead (and no
 * usable bezier).
 */
interface FigmaEasingValue {
  easingType?: string;
  bezierValues?: { p1x: number; p1y: number; p2x: number; p2y: number };
  springValues?: { mass?: number; stiffness?: number; damping?: number };
}

type FigmaValue =
  | { r: number; g: number; b: number; a?: number } // COLOR
  | number // FLOAT, TIMING (seconds)
  | string // STRING
  | boolean // BOOLEAN
  | FigmaEasingValue // EASING
  | VariableAlias;

interface VariableAlias {
  type: "VARIABLE_ALIAS";
  id: string;
}

export interface FigmaVariablesPayload {
  collections: FigmaCollection[];
  variables: FigmaVariable[];
}

export interface ConvertOptions {
  /** Figma file key. Stored in document metadata. */
  figmaFileKey?: string;
  /** ISO timestamp to stamp the exportedAt field. Defaults to now. */
  exportedAt?: string;
  /** MCP version string. */
  mcpVersion?: string;
  /** Filter to specific collection IDs. Undefined or empty means all. */
  collectionIds?: string[];
  /** Filter to specific mode names. Undefined means all. */
  modes?: string[] | "all";
  /** Optional prefix that gets stripped from variable names on conversion. */
  stripPrefix?: string;
}

export interface ConvertResult {
  document: TokenDocument;
  warnings: string[];
}

/**
 * Convert a Figma variables payload to our canonical TokenDocument.
 */
export function convertFigmaVariablesToDocument(
  payload: FigmaVariablesPayload,
  opts: ConvertOptions = {},
): ConvertResult {
  const warnings: string[] = [];

  // Build a variable index for alias resolution: variableId → variable
  const variableById = new Map<string, FigmaVariable>();
  for (const v of payload.variables) variableById.set(v.id, v);

  // Collection name lookup — alias references must carry the owning set so
  // same-path tokens across collections don't misresolve (and so emitted
  // DTCG references point at the actual set group in the output tree).
  // Built over ALL collections (not just the filtered ones) because an
  // alias can target a variable in a collection outside the export scope.
  const collectionNameById = new Map<string, string>();
  for (const c of payload.collections) collectionNameById.set(c.id, c.name);

  // Filter collections per scope.
  const wantedCollections = opts.collectionIds?.length
    ? payload.collections.filter((c) => opts.collectionIds!.includes(c.id))
    : payload.collections;

  const sets: TokenSet[] = wantedCollections.map((collection) =>
    convertCollection(
      collection,
      payload.variables,
      variableById,
      collectionNameById,
      opts,
      warnings,
    ),
  );

  return {
    document: {
      $schema:
        "https://figma-console-mcp.southleft.com/schemas/dtcg-extended-v1.json",
      sets,
      meta: {
        figmaFileKey: opts.figmaFileKey,
        exportedAt: opts.exportedAt ?? new Date().toISOString(),
        mcpVersion: opts.mcpVersion,
      },
    },
    warnings,
  };
}

function convertCollection(
  collection: FigmaCollection,
  allVariables: FigmaVariable[],
  variableById: Map<string, FigmaVariable>,
  collectionNameById: Map<string, string>,
  opts: ConvertOptions,
  warnings: string[],
): TokenSet {
  // Mode filter: keep only modes the caller wants, intersected with what
  // the collection actually has.
  const wantedModes =
    !opts.modes || opts.modes === "all"
      ? collection.modes
      : collection.modes.filter((m) => (opts.modes as string[]).includes(m.name));

  // Variables in this collection.
  const collectionVars = allVariables.filter(
    (v) => v.variableCollectionId === collection.id,
  );

  const tokens: Token[] = collectionVars.map((variable) =>
    convertVariable(
      variable,
      wantedModes,
      variableById,
      collectionNameById,
      opts,
      warnings,
    ),
  );

  return {
    name: collection.name,
    modes: wantedModes.map((m) => m.name),
    tokens,
    meta: {
      figmaCollectionId: collection.id,
    },
  };
}

/**
 * Derive a variable's token path from its Figma name. Strips the configured
 * prefix, splits on "/", and for TIMING/EASING variables drops the trailing
 * type segment Figma appends to Config-2026 motion variables (e.g.
 * "motion/duration/quick/Timing" → ["motion", "duration", "quick"]).
 */
function variableTokenPath(
  variable: FigmaVariable,
  opts: ConvertOptions,
): { path: string[]; strippedTypeSuffix: boolean } {
  let name = variable.name;
  if (opts.stripPrefix && name.startsWith(opts.stripPrefix)) {
    name = name.slice(opts.stripPrefix.length);
  }
  const segments = name.split("/").filter(Boolean);
  let strippedTypeSuffix = false;
  if (
    (variable.resolvedType === "TIMING" || variable.resolvedType === "EASING") &&
    segments.length > 1 &&
    /^(timing|easing)$/i.test(segments[segments.length - 1])
  ) {
    segments.pop();
    strippedTypeSuffix = true;
  }
  return { path: segments, strippedTypeSuffix };
}

function convertVariable(
  variable: FigmaVariable,
  wantedModes: Array<{ modeId: string; name: string }>,
  variableById: Map<string, FigmaVariable>,
  collectionNameById: Map<string, string>,
  opts: ConvertOptions,
  warnings: string[],
): Token {
  // Derive the hierarchical path from the Figma variable name. Figma uses
  // slashes to indicate grouping: "color/brand/primary" → ["color", "brand", "primary"].
  const { path, strippedTypeSuffix } = variableTokenPath(variable, opts);

  // Map resolvedType to TokenType.
  const type = mapResolvedType(variable.resolvedType, variable.name, warnings);

  // Convert each (mode → value) pair to our TokenValue shape, filtered by
  // the wanted modes. Spring easings can't be expressed in DTCG — their
  // parameters get stashed per-mode in the token's extensions.
  const values: Record<string, TokenValue> = {};
  const springByMode: Record<string, unknown> = {};
  for (const mode of wantedModes) {
    const rawValue = variable.valuesByMode[mode.modeId];
    if (rawValue === undefined) {
      warnings.push(
        `Variable "${variable.name}" has no value for mode "${mode.name}" (${mode.modeId}); skipping that mode.`,
      );
      continue;
    }
    values[mode.name] = convertValue(
      rawValue,
      variable,
      mode.name,
      variableById,
      collectionNameById,
      opts,
      warnings,
      (spring) => {
        springByMode[mode.name] = spring;
      },
    );
  }

  return {
    path,
    type,
    description: variable.description || undefined,
    values,
    extensions: {
      "figma-console-mcp": {
        variableId: variable.id,
        collectionId: variable.variableCollectionId,
        // The Figma-native type is what import needs to decide writability
        // — TIMING/EASING variables cannot be written via the Plugin API,
        // and FLOAT variables whose token type is "duration" (name-inferred)
        // must NOT be mistaken for TIMING.
        figmaResolvedType: variable.resolvedType,
        // Preserve the original variable name when the token path dropped
        // the trailing "Timing"/"Easing" segment, so round-trip can
        // reconstruct it.
        ...(strippedTypeSuffix ? { figmaName: variable.name } : {}),
        ...(Object.keys(springByMode).length > 0 ? { spring: springByMode } : {}),
        lastSyncedAt: new Date().toISOString(),
        // We snapshot the synced value so future merge calls can detect
        // two-sided conflicts.
        lastSyncedValue: { ...values },
      },
    },
  };
}

function mapResolvedType(
  resolvedType: FigmaVariable["resolvedType"],
  variableName: string,
  warnings: string[],
): TokenType {
  switch (resolvedType) {
    case "COLOR":
      return "color";
    case "FLOAT":
      // Figma FLOAT covers both pure numbers and dimensions. We default to
      // "dimension" because the typical FLOAT variable represents spacing,
      // sizing, or radius — all dimensions. A future enhancement could
      // sniff the variable name (e.g. "opacity/*" → "number") for better
      // type fidelity.
      return inferFloatType(variableName);
    case "STRING":
      return inferStringType(variableName);
    case "BOOLEAN":
      return "boolean";
    case "TIMING":
      // Config-2026 motion duration variables — plain numbers in SECONDS.
      return "duration";
    case "EASING":
      // Config-2026 easing variables — bezier (or spring) curve objects.
      return "cubicBezier";
    default: {
      const _exhaustive: never = resolvedType;
      warnings.push(
        `Unknown resolvedType "${_exhaustive}" for variable "${variableName}"; treating as string.`,
      );
      return "string";
    }
  }
}

function inferFloatType(variableName: string): TokenType {
  const lower = variableName.toLowerCase();
  if (lower.includes("opacity") || lower.includes("alpha")) return "number";
  if (lower.includes("font-weight") || lower.includes("weight"))
    return "fontWeight";
  if (lower.includes("duration") || lower.includes("delay"))
    return "duration";
  // Default: treat numeric variables as dimensions (px values).
  return "dimension";
}

function inferStringType(variableName: string): TokenType {
  const lower = variableName.toLowerCase();
  if (lower.includes("font-family") || lower.includes("font/family"))
    return "fontFamily";
  return "string";
}

function convertValue(
  rawValue: FigmaValue,
  variable: FigmaVariable,
  modeName: string,
  variableById: Map<string, FigmaVariable>,
  collectionNameById: Map<string, string>,
  opts: ConvertOptions,
  warnings: string[],
  onSpring: (spring: Record<string, unknown>) => void,
): TokenValue {
  const resolvedType = variable.resolvedType;

  // Alias references: convert variable ID → path-based reference for DTCG.
  if (isVariableAlias(rawValue)) {
    const target = variableById.get(rawValue.id);
    if (!target) {
      // Cross-library alias — target is in a published library this file
      // consumes, not in the local variable set. Preserve the original
      // Figma variable ID in the reference syntax so round-trip can
      // recover it AND formatters can detect this is unresolvable (vs a
      // genuine local-path alias).
      warnings.push(
        `Alias to unknown variable ID ${rawValue.id} (likely a cross-library reference). Original ID preserved in reference for round-trip.`,
      );
      return { reference: `{__library:${rawValue.id}}` };
    }
    // The DTCG alias path uses dots, QUALIFIED by the target's set group
    // (`{<set-slug>.color.brand.primary}`). The set qualifier does two
    // jobs: (1) same-path tokens in different collections resolve to the
    // right target instead of "whichever set was indexed last", and
    // (2) the emitted DTCG reference points at the actual location in the
    // output tree (tokens nest under the slugified set group), so
    // external DTCG tools like Style Dictionary v4 can resolve it.
    const targetPath = variableTokenPath(target, opts).path;
    const dotPath = targetPath.join(".");
    const targetCollectionName = collectionNameById.get(
      target.variableCollectionId,
    );
    if (!targetCollectionName) {
      warnings.push(
        `Alias target "${target.name}" belongs to unknown collection ${target.variableCollectionId} — emitting an unqualified reference.`,
      );
      return { reference: `{${dotPath}}` };
    }
    return { reference: `{${slugifySetName(targetCollectionName)}.${dotPath}}` };
  }

  // Literal values per type.
  if (resolvedType === "COLOR") {
    if (typeof rawValue === "object" && rawValue !== null && "r" in rawValue) {
      return { literal: rgbaToHex(rawValue) };
    }
    warnings.push(`COLOR value isn't an RGB object: ${JSON.stringify(rawValue)}`);
    return { literal: String(rawValue) };
  }
  if (resolvedType === "FLOAT") {
    return { literal: typeof rawValue === "number" ? rawValue : Number(rawValue) };
  }
  if (resolvedType === "BOOLEAN") {
    return { literal: Boolean(rawValue) };
  }
  if (resolvedType === "TIMING") {
    // Figma TIMING values are plain numbers in SECONDS. DTCG duration uses
    // the structured `{ value, unit }` form — emit milliseconds.
    if (typeof rawValue === "number") {
      return { literal: { value: rawValue * 1000, unit: "ms" } };
    }
    warnings.push(
      `TIMING value for "${variable.name}" (mode "${modeName}") isn't a number: ${JSON.stringify(rawValue)} — emitting as string.`,
    );
    return { literal: String(rawValue) };
  }
  if (resolvedType === "EASING") {
    const easing = rawValue as FigmaEasingValue;
    const b = easing?.bezierValues;
    if (
      b &&
      typeof b.p1x === "number" &&
      typeof b.p1y === "number" &&
      typeof b.p2x === "number" &&
      typeof b.p2y === "number"
    ) {
      // DTCG cubicBezier: [p1x, p1y, p2x, p2y].
      return { literal: [b.p1x, b.p1y, b.p2x, b.p2y] };
    }
    if (easing && typeof easing === "object" && easing.springValues) {
      // Spring easings have no bezier representation — DTCG cannot express
      // springs. Emit a standard "ease" bezier as a usable approximation
      // and preserve the spring parameters in the token's
      // figma-console-mcp extensions for round-trip.
      warnings.push(
        `EASING variable "${variable.name}" (mode "${modeName}") is a spring (${easing.easingType ?? "unknown type"}) — DTCG cannot represent springs. Emitted a fallback cubicBezier; spring parameters preserved in $extensions["figma-console-mcp"].spring.`,
      );
      onSpring({
        easingType: easing.easingType,
        springValues: easing.springValues,
      });
      return { literal: [0.25, 0.1, 0.25, 1.0] };
    }
    warnings.push(
      `EASING value for "${variable.name}" (mode "${modeName}") has no usable bezierValues or springValues: ${JSON.stringify(rawValue)} — emitting as string.`,
    );
    return { literal: String(rawValue) };
  }
  // STRING and fallthrough.
  return { literal: typeof rawValue === "string" ? rawValue : String(rawValue) };
}

function isVariableAlias(value: unknown): value is VariableAlias {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type: string }).type === "VARIABLE_ALIAS"
  );
}

/**
 * Convert Figma's `{r, g, b, a}` floats (0–1 range) to a hex string. Returns
 * `#RRGGBB` when alpha is 1 (or absent), `#RRGGBBAA` when alpha < 1.
 */
function rgbaToHex(rgba: { r: number; g: number; b: number; a?: number }): string {
  const r = clampByte(rgba.r);
  const g = clampByte(rgba.g);
  const b = clampByte(rgba.b);
  const a = rgba.a ?? 1;

  const hex = `#${byteToHex(r)}${byteToHex(g)}${byteToHex(b)}`;
  if (a >= 1) return hex;
  return `${hex}${byteToHex(clampByte(a))}`;
}

function clampByte(f: number): number {
  return Math.max(0, Math.min(255, Math.round(f * 255)));
}

function byteToHex(byte: number): string {
  return byte.toString(16).padStart(2, "0").toUpperCase();
}
