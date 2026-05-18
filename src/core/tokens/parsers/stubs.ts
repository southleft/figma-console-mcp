/**
 * Shared NotImplementedError for parser stubs.
 *
 * Only DTCG is implemented as a parser today — that's the canonical
 * round-trip format for `figma_import_tokens`. Other parsers are
 * scaffolding for potential future import-source support; the way to get
 * tokens INTO Figma now is via DTCG JSON (you can generate that JSON from
 * any source with your own tooling). The export side (Figma → code) is
 * fully covered for all 10 formats — see formatters/stubs.ts for that
 * surface.
 */

export class TokenFormatNotImplementedError extends Error {
  constructor(formatName: string, kind: "parser" | "formatter") {
    const guidance =
      kind === "parser"
        ? `Only the DTCG parser is implemented today. To import tokens into Figma from ${formatName}, convert to DTCG JSON first (or open an issue if you need direct ${formatName} import support).`
        : `Implemented formatters: dtcg, css-vars, tailwind-v4, tailwind-v3, scss, ts-module, json-flat, json-nested, style-dictionary-v3, tokens-studio. If you need ${formatName}, open an issue with your use case.`;
    super(`[figma-console-mcp] The ${formatName} ${kind} is not implemented. ${guidance}`);
    this.name = "TokenFormatNotImplementedError";
  }
}
