/**
 * Color value transforms. Convert between hex, hex8 (with alpha), rgba, oklch,
 * and hsl representations. Phase 1 stub — DTCG output preserves source values.
 */

import type { Token, TokenValue } from "../types.js";
import type { Transform, TransformOptions } from "./index.js";

export const colorToFormat: Transform = (
  value: TokenValue,
  _token: Token,
  _opts: TransformOptions,
) => {
  // Phase 1: pass through. The DTCG formatter doesn't need transforms — it
  // preserves source values. Future phases will implement hex↔oklch↔rgba etc.
  return value;
};
