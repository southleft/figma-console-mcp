/**
 * Shared NotImplementedError for parsers/formatters that are scaffolded but
 * not yet implemented. DTCG round-trip is the canonical fully-implemented
 * path; CSS variables is also fully implemented as a formatter output.
 * Everything else returns a helpful error pointing the user at the canonical
 * format.
 */

export class TokenFormatNotImplementedError extends Error {
  constructor(formatName: string, kind: "parser" | "formatter") {
    super(
      `[figma-console-mcp] The ${formatName} ${kind} is scaffolded but not yet implemented. Fully implemented: DTCG JSON (parser + formatter) and CSS custom properties (formatter only). For now, export to 'dtcg' as the canonical format and either consume the JSON directly or convert downstream — or open an issue with your use case to prioritize this format.`,
    );
    this.name = "TokenFormatNotImplementedError";
  }
}
