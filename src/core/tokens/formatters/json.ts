import type { TokenDocument } from "../types.js";
import type { FormatOptions, FormatResult } from "./index.js";
import { FormatterNotImplementedError } from "./stubs.js";

export function formatJsonFlat(
  _doc: TokenDocument,
  _opts: FormatOptions,
): FormatResult {
  throw new FormatterNotImplementedError("flat JSON");
}

export function formatJsonNested(
  _doc: TokenDocument,
  _opts: FormatOptions,
): FormatResult {
  throw new FormatterNotImplementedError("nested JSON");
}
