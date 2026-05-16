import type { TokenDocument } from "../types.js";
import type { FormatOptions, FormatResult } from "./index.js";
import { FormatterNotImplementedError } from "./stubs.js";

export function formatTailwindV4(
  _doc: TokenDocument,
  _opts: FormatOptions,
): FormatResult {
  throw new FormatterNotImplementedError("Tailwind v4 @theme");
}
