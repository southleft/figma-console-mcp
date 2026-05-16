import type { ParseInput, ParseResult } from "./index.js";
import { TokenFormatNotImplementedError } from "./stubs.js";

export function parseTokensStudio(_input: ParseInput): ParseResult {
  throw new TokenFormatNotImplementedError("Tokens Studio", "parser");
}
