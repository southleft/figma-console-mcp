/**
 * Token-value transforms. Each transform is a pure function that takes a
 * TokenValue (and an options bag) and returns a transformed TokenValue.
 *
 * Transforms are composable — formatters call them in a pipeline appropriate
 * for the output format (e.g. CSS variables need px→rem and string color
 * normalization; DTCG output skips transforms entirely since it preserves the
 * source representation).
 *
 * Currently ships stubs that pass values through unchanged. The DTCG and
 * CSS variables formatters don't need transforms because they handle their
 * own value formatting inline. Transforms will be implemented when the
 * Tailwind v4 / SCSS / TS module formatters land.
 */

import type { Token, TokenValue } from "../types.js";

export interface TransformOptions {
  /** Desired color output format. Defaults to "hex". */
  colorFormat?: "hex" | "hex8" | "rgba" | "oklch" | "hsl";
  /** Desired dimension unit. Defaults to "rem" for web. */
  sizeUnit?: "px" | "rem" | "pt" | "dp";
  /** Base font size for px↔rem conversion. Defaults to 16. */
  remBase?: number;
}

export interface Transform {
  /**
   * Apply the transform to a single token value. Returns a new value
   * (transforms are pure).
   */
  (value: TokenValue, token: Token, opts: TransformOptions): TokenValue;
}

/**
 * Run a pipeline of transforms on a token's value(s). Iterates every mode
 * and applies each transform in order.
 */
export function runTransforms(
  token: Token,
  transforms: Transform[],
  opts: TransformOptions,
): Token {
  const newValues: Token["values"] = {};
  for (const [mode, value] of Object.entries(token.values)) {
    let result = value;
    for (const transform of transforms) {
      result = transform(result, token, opts);
    }
    newValues[mode] = result;
  }
  return { ...token, values: newValues };
}
