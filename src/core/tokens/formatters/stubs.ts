/**
 * Shared NotImplementedError used by formatter stubs. Most formatters are
 * implemented end-to-end as of v1.28.0; this stub remains for niche targets
 * (e.g. Less) that haven't drawn enough demand to warrant implementation.
 */

export class FormatterNotImplementedError extends Error {
  constructor(formatName: string) {
    super(
      `[figma-console-mcp] The ${formatName} formatter is not implemented. ` +
        `Currently supported formatters: dtcg, css-vars, tailwind-v4, tailwind-v3, scss, ts-module, json-flat, json-nested, style-dictionary-v3, tokens-studio. ` +
        `If you need ${formatName} support, open an issue with your use case so we can prioritize it.`,
    );
    this.name = "FormatterNotImplementedError";
  }
}
