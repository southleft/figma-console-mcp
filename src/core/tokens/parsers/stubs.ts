/**
 * Shared NotImplementedError for parsers/formatters/transforms that ship as
 * stubs in Phase 1. The DTCG round-trip is the only fully-implemented path;
 * everything else returns a helpful error pointing the user at the canonical
 * format.
 */

export class TokenFormatNotImplementedError extends Error {
  constructor(formatName: string, kind: "parser" | "formatter") {
    super(
      `[figma-console-mcp] The ${formatName} ${kind} is scaffolded but not yet implemented in this release. Phase 1 ships with full DTCG round-trip support. For now, export to 'dtcg' as the canonical format and use Style Dictionary downstream if you need other targets — or open an issue with your use case to prioritize this format.`,
    );
    this.name = "TokenFormatNotImplementedError";
  }
}
