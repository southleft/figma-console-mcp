import type { ParseInput, ParseResult } from "./index.js";
import { TokenFormatNotImplementedError } from "./stubs.js";

export function parseTailwindV3Config(_input: ParseInput): ParseResult {
  throw new TokenFormatNotImplementedError("Tailwind v3 config", "parser");
}
