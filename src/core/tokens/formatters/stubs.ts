/**
 * Shared NotImplementedError used by formatter stubs. DTCG JSON and CSS
 * custom properties are the fully-implemented formatters; everything else
 * is scaffolded and throws this error.
 */

export class FormatterNotImplementedError extends Error {
  constructor(formatName: string) {
    super(
      `[figma-console-mcp] The ${formatName} formatter is scaffolded but not yet implemented. Fully implemented formats: 'dtcg' (canonical W3C JSON) and 'css-vars' (CSS custom properties with mode-aware selectors). For other targets, export to 'dtcg' and either consume the canonical JSON directly or convert it via a downstream tool — or open an issue with your styling stack to prioritize the format.`,
    );
    this.name = "FormatterNotImplementedError";
  }
}
