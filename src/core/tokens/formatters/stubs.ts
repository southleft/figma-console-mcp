/**
 * Shared NotImplementedError used by formatter stubs. The DTCG formatter is
 * the only fully-implemented path in Phase 1.
 */

export class FormatterNotImplementedError extends Error {
  constructor(formatName: string) {
    super(
      `[figma-console-mcp] The ${formatName} formatter is scaffolded but not yet implemented in this release. Phase 1 ships with full DTCG round-trip support. Export to 'dtcg' and consume the canonical JSON in your build pipeline for now — or open an issue with your styling stack to prioritize this format.`,
    );
    this.name = "FormatterNotImplementedError";
  }
}
