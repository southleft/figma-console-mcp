/**
 * Dimension/size value transforms. Convert px ↔ rem ↔ pt ↔ dp. Stub —
 * to be implemented when Tailwind v4 / SCSS / TS formatters ship.
 */

import type { Token, TokenValue } from "../types.js";
import type { Transform, TransformOptions } from "./index.js";

export const sizeToUnit: Transform = (
  value: TokenValue,
  _token: Token,
  _opts: TransformOptions,
) => {
  return value;
};
