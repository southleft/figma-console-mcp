import type { ParseInput, ParseResult } from "./index.js";
import { TokenFormatNotImplementedError } from "./stubs.js";

export function parseScss(_input: ParseInput): ParseResult {
  throw new TokenFormatNotImplementedError("SCSS variables", "parser");
}
