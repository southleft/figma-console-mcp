import type { ParseInput, ParseResult } from "./index.js";
import { TokenFormatNotImplementedError } from "./stubs.js";

export function parseStyleDictionaryV3(_input: ParseInput): ParseResult {
  throw new TokenFormatNotImplementedError("Style Dictionary v3", "parser");
}
