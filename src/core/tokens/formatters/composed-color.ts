/**
 * Rendering helpers for Figma composed colors (a color + an opacity percent,
 * at least one of them an alias — see ComposedColor in ../types.ts).
 *
 * Formats with a native way to express "this color at N%" keep the link to
 * the primitive. They fall back to the resolved literal when the expression
 * would not match what Figma renders:
 *   - the color part is semi-transparent (Figma then ignores the opacity),
 *   - a part points outside the file (library variable),
 *   - a reference can't be named in the output.
 */
import type { ComposedColor, Token, TokenValue } from "../types.js";

export type ComposedOpacity = { percent: number } | { ref: string };

export interface ComposedRenderer {
  /** Output name for a reference to another token, or null if unnameable. */
  ref: (reference: string) => string | null;
  /** How a hex color literal is written in this format. */
  colorLiteral: (hex: string) => string;
  /** Build the expression from a rendered color and opacity. */
  build: (color: string, opacity: ComposedOpacity) => string;
}

export type ComposedResult =
  | { kind: "expression"; text: string }
  | { kind: "fallback"; reason: string };

function isLibraryRef(reference: string): boolean {
  const bare = reference.replace(/^\{|\}$/g, "");
  return bare.startsWith("__library:") || bare === "unknown";
}

export function renderComposed(composed: ComposedColor, r: ComposedRenderer): ComposedResult {
  if (composed.colorOpaque === false) {
    return {
      kind: "fallback",
      reason: "its color is semi-transparent, and Figma keeps that color's own alpha instead of applying the opacity",
    };
  }
  let color: string | null;
  if ("reference" in composed.color) {
    if (isLibraryRef(composed.color.reference)) return { kind: "fallback", reason: "its color is a library variable" };
    color = r.ref(composed.color.reference);
  } else {
    color = r.colorLiteral(composed.color.literal);
  }
  if (!color) return { kind: "fallback", reason: "its color reference could not be named in this format" };

  let opacity: ComposedOpacity;
  if ("reference" in composed.opacity) {
    if (isLibraryRef(composed.opacity.reference)) return { kind: "fallback", reason: "its opacity is a library variable" };
    const name = r.ref(composed.opacity.reference);
    if (!name) return { kind: "fallback", reason: "its opacity reference could not be named in this format" };
    opacity = { ref: name };
  } else {
    opacity = { percent: composed.opacity.literal };
  }
  return { kind: "expression", text: r.build(color, opacity) };
}

/** Trim float noise: 50 → "50", 33.33333 → "33.333". */
export function num(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** The literal to emit when a composed color falls back (resolved color). */
export function composedFallbackNote(path: string[], formatName: string, reason: string, value: TokenValue): string {
  return value.literal !== undefined
    ? `${path.join(".")} in ${formatName}: exported as its resolved color because ${reason}.`
    : `Skipped ${path.join(".")} in ${formatName} — ${reason}, and no resolved color is available.`;
}

/**
 * True when a reference points at a token in THIS export. A composed color
 * whose primitive isn't exported (e.g. collectionIds scoped to the semantic
 * set) must fall back to its resolved color, not reference a variable that
 * is never declared.
 */
export function referenceInExport(reference: string, tokenIndex: Map<string, Token>): boolean {
  return tokenIndex.has(reference.replace(/^\{|\}$/g, ""));
}
