import type { ParseInput, ParseResult } from "./index.js";
import { TokenFormatNotImplementedError } from "./stubs.js";

export function parseJsonFlat(_input: ParseInput): ParseResult {
  throw new TokenFormatNotImplementedError("flat JSON", "parser");
}

export function parseJsonNested(_input: ParseInput): ParseResult {
  throw new TokenFormatNotImplementedError("nested JSON", "parser");
}
