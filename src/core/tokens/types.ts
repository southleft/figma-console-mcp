/**
 * Canonical internal token model for figma-console-mcp's token sync engine.
 *
 * Every parser (DTCG, Tokens Studio, CSS vars, Tailwind, etc.) produces this
 * shape. Every formatter (DTCG, CSS vars, Tailwind v4, SCSS, TS, etc.) consumes
 * this shape. Keeps the engine fan-out clean: N parsers + M formatters means
 * N + M modules, not N * M conversion pairs.
 *
 * Aligned with the DTCG (Design Tokens Community Group) W3C spec where
 * possible — see https://tr.designtokens.org/format/ — but the internal model
 * is richer because it carries Figma metadata, multi-mode values per-token,
 * and our $extensions for round-trip ID preservation.
 */

/**
 * The DTCG-aligned set of token types. Maps directly to `$type` in DTCG output.
 * Composite types (typography, shadow, gradient, etc.) have structured `$value`
 * objects; primitive types have scalar values.
 */
export type TokenType =
  // Primitives
  | "color"
  | "dimension"
  | "fontFamily"
  | "fontWeight"
  | "duration"
  | "cubicBezier"
  | "number"
  | "string"
  | "boolean"
  // Composites
  | "shadow"
  | "typography"
  | "gradient"
  | "border"
  | "transition"
  | "strokeStyle";

/**
 * The DTCG composite token value shapes. Used inside TokenValue.literal when
 * the token type is composite.
 */
export interface TypographyValue {
  fontFamily: string | string[];
  fontSize: string | number;
  fontWeight: string | number;
  lineHeight?: string | number;
  letterSpacing?: string | number;
}

export interface ShadowValue {
  color: string;
  offsetX: string | number;
  offsetY: string | number;
  blur: string | number;
  spread?: string | number;
  inset?: boolean;
}

export interface GradientStop {
  color: string;
  position: number;
}

export interface GradientValue {
  type: "linear" | "radial" | "conic";
  angle?: number;
  stops: GradientStop[];
}

export interface BorderValue {
  color: string;
  width: string | number;
  style: string;
}

export interface TransitionValue {
  duration: string | number;
  timingFunction: string | number[];
  delay?: string | number;
}

/**
 * A single token value. Either a literal (primitive scalar or composite object)
 * or an alias reference to another token by its dot-path.
 *
 * Examples:
 *   { literal: "#4085F2" }                       // primitive color
 *   { reference: "color.primitive.blue.500" }    // alias
 *   { literal: { fontFamily: "Inter", ... } }    // composite typography
 */
export interface TokenValue {
  literal?:
    | string
    | number
    | boolean
    | TypographyValue
    | ShadowValue
    | ShadowValue[]
    | GradientValue
    | BorderValue
    | TransitionValue
    | Record<string, unknown>;
  reference?: string;
}

/**
 * Our vendor namespace inside DTCG $extensions. Survives round-trip through
 * any DTCG-compliant tool that preserves $extensions verbatim (Style
 * Dictionary v4, Tokens Studio, Figma's announced 2026 native export, etc).
 *
 * The presence of `variableId` is what makes diff-aware merge non-destructive:
 * renames on either side don't create duplicates because the ID is the
 * primary match key.
 */
export interface FigmaMcpExtensions {
  /** Figma variable ID (`VariableID:1234:5678`). Survives renames. */
  variableId?: string;
  /** Figma collection ID. Used to route the variable to the right collection. */
  collectionId?: string;
  /**
   * The value(s) that were synced to/from Figma the last time this tool ran.
   * Used to detect true two-sided conflicts: if BOTH the current Figma value
   * and the current code value differ from this, we don't have a clean winner.
   */
  lastSyncedValue?: Record<string, TokenValue>;
  /** ISO timestamp of the last successful sync for this token. */
  lastSyncedAt?: string;
}

/**
 * A single design token in our internal model. Carries enough information to
 * round-trip through Figma without losing identity, name, type, value, modes,
 * description, or vendor extensions.
 */
export interface Token {
  /**
   * Hierarchical path, e.g. ["color", "primary"] or
   * ["typography", "heading", "1"]. Joined with "/" for display and most
   * output formats. Joined with "." for DTCG alias references.
   */
  path: string[];
  /** DTCG-aligned token type. */
  type: TokenType;
  /** Optional human-readable description (DTCG `$description`). */
  description?: string;
  /**
   * Map of mode name → value. Single-mode tokens have one entry. Multi-mode
   * tokens (typically theme tokens) have one entry per mode.
   *
   * Mode names match the corresponding Figma collection's mode names by
   * default; can be remapped via tokens.config.json's modes.map.
   */
  values: Record<string, TokenValue>;
  /**
   * Vendor extensions. Our own metadata lives under
   * `extensions["figma-console-mcp"]`. We preserve other vendors' extensions
   * verbatim during round-trip (e.g. `studio.tokens` from Tokens Studio).
   */
  extensions?: Record<string, unknown> & {
    "figma-console-mcp"?: FigmaMcpExtensions;
  };
}

/**
 * A grouping of related tokens. Maps 1:1 to a Figma variable collection.
 *
 * Examples: a "Primitives" set with raw color/spacing primitives; a "Semantic"
 * set with aliases to primitives; a "Theme" set with light/dark mode values.
 */
export interface TokenSet {
  /** Display name. Maps to the Figma collection name. */
  name: string;
  description?: string;
  /**
   * Mode names in this set. Single-mode sets use a single mode (typically
   * "Default" or "Value"). Multi-mode sets list each mode (e.g.
   * ["Light", "Dark"]).
   */
  modes: string[];
  tokens: Token[];
  /** Set-level metadata. */
  meta?: {
    /** Figma collection ID. Set on first sync, used as primary match key. */
    figmaCollectionId?: string;
    /**
     * Source files that contributed tokens to this set. Used by formatters
     * that emit one-file-per-set to derive output filenames, and by parsers
     * to track provenance for conflict reporting.
     */
    sourceFiles?: string[];
  };
}

/**
 * The top-level container that export produces and import consumes. Holds
 * one or more TokenSets plus file-level metadata.
 */
export interface TokenDocument {
  /**
   * Format identifier. Helps consumers detect our extended DTCG output
   * (where we stash Figma IDs in $extensions) vs vanilla DTCG.
   */
  $schema?:
    | "https://tr.designtokens.org/format/"
    | "https://figma-console-mcp.southleft.com/schemas/dtcg-extended-v1.json";
  sets: TokenSet[];
  meta?: {
    /** Figma file key the document was exported from. */
    figmaFileKey?: string;
    /** ISO timestamp the document was generated/parsed. */
    exportedAt?: string;
    /** MCP version that produced/parsed the document. */
    mcpVersion?: string;
  };
}

/**
 * The strategies both tools accept. Mirrored on export and import sides for
 * predictability — same name, same semantic, opposite direction.
 */
export type SyncStrategy = "merge" | "replace" | "dry-run";

/**
 * How to resolve true two-sided conflicts (both Figma and code changed the
 * same token since last sync).
 */
export type ConflictResolution =
  /** Surface the conflict to the AI/user, write nothing. */
  | "ask"
  /** Figma's value wins, code gets overwritten. */
  | "figma-wins"
  /** Code's value wins, Figma gets overwritten. */
  | "code-wins"
  /** Skip the conflicted token, continue with the rest. */
  | "skip";

/**
 * Diff result for a single token. Produced by the matcher, consumed by the
 * applier and the dry-run reporter.
 */
export interface TokenDiff {
  path: string[];
  /** How the match was made — used for diagnostics and conflict explanation. */
  matchedBy: "id" | "path" | "none";
  /** What action the merge engine recommends. */
  action:
    | "create"
    | "update"
    | "rename"
    | "delete"
    | "no-op"
    | "conflict"
    | "preserve-other-side";
  /** The token from the "left" side of the diff (typically Figma on export). */
  before?: Token;
  /** The token from the "right" side of the diff (typically code on export). */
  after?: Token;
  /** For conflicts: the last-synced value that diverged. */
  lastSynced?: Record<string, TokenValue>;
  /** Human-readable reason for the action, used in dry-run output. */
  reason?: string;
}

/**
 * Output formats supported by figma_export_tokens. Listed in priority order
 * — earlier formats are the canonical/primary outputs.
 */
export type ExportFormat =
  // Canonical
  | "dtcg"
  | "tokens-studio"
  // Turnkey CSS family
  | "css-vars"
  | "tailwind-v4"
  | "tailwind-v3"
  | "scss"
  | "less"
  // Code modules
  | "ts-module"
  | "json-flat"
  | "json-nested"
  // Back-compat
  | "style-dictionary-v3";

/**
 * Input formats supported by figma_import_tokens. `auto` triggers detection
 * from payload structure or file extension.
 */
export type ImportFormat =
  | "auto"
  | "dtcg"
  | "tokens-studio"
  | "css-vars"
  | "tailwind-v4"
  | "tailwind-v3-config"
  | "scss"
  | "style-dictionary-v3"
  | "json-flat"
  | "json-nested";

/**
 * Identifier returned in MCP-tagged responses so callers know which vendor
 * extensions namespace to read.
 */
export const FIGMA_MCP_EXTENSION_KEY = "figma-console-mcp" as const;
