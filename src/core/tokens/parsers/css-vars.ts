import type { ParseInput, ParseResult } from "./index.js";
import { TokenFormatNotImplementedError } from "./stubs.js";

export function parseCssVars(_input: ParseInput): ParseResult {
  throw new TokenFormatNotImplementedError("CSS custom properties", "parser");
}
