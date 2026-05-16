import type { ParseInput, ParseResult } from "./index.js";
import { TokenFormatNotImplementedError } from "./stubs.js";

export function parseTailwindV4(_input: ParseInput): ParseResult {
  throw new TokenFormatNotImplementedError("Tailwind v4 @theme", "parser");
}
