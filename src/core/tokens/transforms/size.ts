/**
 * Dimension/size value transforms. Convert px ↔ rem ↔ pt ↔ dp. Phase 1 stub.
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
