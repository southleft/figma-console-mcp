/**
 * Zod schemas for the figma_export_tokens and figma_import_tokens MCP tools.
 *
 * Kept in a dedicated file because they're the AI-facing surface of the token
 * sync engine — the descriptions matter for prompt comprehension, and they
 * need to stay in sync with `src/core/tokens/types.ts` (the internal model).
 */

import { z } from "zod";

/**
 * Output format enum mirrors `ExportFormat` from `./types.ts`. Listed in the
 * same priority order — DTCG and Tokens Studio first as the canonical JSON
 * outputs, then CSS-family formats, then code modules, then back-compat.
 */
export const ExportFormatSchema = z.enum([
  "dtcg",
  "tokens-studio",
  "css-vars",
  "tailwind-v4",
  "tailwind-v3",
  "scss",
  "less",
  "ts-module",
  "json-flat",
  "json-nested",
  "style-dictionary-v3",
]);

export const ImportFormatSchema = z.enum([
  "auto",
  "dtcg",
  "tokens-studio",
  "css-vars",
  "tailwind-v4",
  "tailwind-v3-config",
  "scss",
  "style-dictionary-v3",
  "json-flat",
  "json-nested",
]);

export const SyncStrategySchema = z.enum(["merge", "replace", "dry-run"]);

export const ConflictResolutionSchema = z.enum([
  "ask",
  "figma-wins",
  "code-wins",
  "skip",
]);

const ColorFormatSchema = z.enum(["hex", "hex8", "rgba", "oklch", "hsl"]);
const SizeUnitSchema = z.enum(["px", "rem", "pt", "dp"]);

/**
 * Schema for figma_export_tokens. Most fields are optional — the typical call
 * is zero-arg, picking everything up from `tokens.config.json` autodiscovery.
 */
export const ExportTokensInputSchema = z.object({
  scope: z
    .enum(["file", "collection"])
    .optional()
    .describe(
      "Whether to export the entire file's variables ('file', default) or just specific collections via collectionIds.",
    ),
  collectionIds: z
    .array(z.string())
    .optional()
    .describe(
      "Specific Figma collection IDs to export. Required when scope is 'collection'. Use figma_get_variables to enumerate available collections.",
    ),
  modes: z
    .union([z.array(z.string()), z.literal("all")])
    .optional()
    .describe(
      "Modes to include in the output. 'all' (default) exports every mode in every collection. Pass an array like ['Light', 'Dark'] to filter.",
    ),
  format: ExportFormatSchema.optional().describe(
    "Specific output format to emit. When omitted, formats come from tokens.config.json's generated.formats list. Common starting choices: 'dtcg' for the canonical JSON, 'css-vars' for runtime CSS custom properties, 'tailwind-v4' for Tailwind v4 @theme blocks.",
  ),
  outputPath: z
    .string()
    .optional()
    .describe(
      "Filesystem path to write the output file(s) to. Relative paths resolve against the project root (the directory containing tokens.config.json) or cwd if no config. When omitted, the output is returned inline in the response (suitable for the AI to inspect or write via its own file tools).",
    ),
  configPath: z
    .string()
    .optional()
    .describe(
      "Explicit path to a tokens.config.json file. When omitted, the tool walks up from cwd looking for one — typical case is zero-arg.",
    ),
  strategy: SyncStrategySchema.optional().describe(
    "How to handle existing output files. 'merge' (default) diffs against current contents and writes only changed tokens, preserving code-only additions. 'replace' wipes and rewrites. 'dry-run' computes the diff and reports what would change without writing.",
  ),
  prefix: z
    .string()
    .optional()
    .describe(
      "Prefix prepended to every output token name (e.g. 'ds-', 'al-'). Only affects formatters that emit named tokens — DTCG and JSON outputs use unmodified paths.",
    ),
  resolveAliases: z
    .boolean()
    .optional()
    .describe(
      "If true, alias references are resolved to literal values in the output. Default is false for JSON formats (preserves alias semantics) and true for CSS/SCSS/Tailwind/etc. (which can't natively express aliases).",
    ),
  splitByMode: z
    .boolean()
    .optional()
    .describe(
      "Emit one file per mode (e.g. tokens-light.css, tokens-dark.css). Default false (single file with all modes).",
    ),
  splitByCollection: z
    .boolean()
    .optional()
    .describe(
      "Emit one file per Figma collection. Default false. Useful when collections map to different runtime themes.",
    ),
  colorFormat: ColorFormatSchema.optional().describe(
    "Color value format in the output. Default: 'hex'. Use 'oklch' for modern Tailwind v4 charts.",
  ),
  sizeUnit: SizeUnitSchema.optional().describe(
    "Unit for dimension tokens. Default: 'rem' for web outputs, 'pt' for iOS, 'dp' for Android.",
  ),
  remBase: z
    .number()
    .positive()
    .optional()
    .describe(
      "Base font size in pixels for px→rem conversion. Default: 16.",
    ),
});

export type ExportTokensInput = z.infer<typeof ExportTokensInputSchema>;

/**
 * Schema for figma_import_tokens. Mirrors export's shape on the inverse
 * direction: instead of producing files, this consumes payloads or files and
 * pushes the diff to Figma.
 */
export const ImportTokensInputSchema = z
  .object({
    format: ImportFormatSchema.optional().describe(
      "Format of the input payload. 'auto' (default) detects from payload shape or file extension. Pass an explicit format if auto-detection misfires.",
    ),
    payload: z
      .string()
      .optional()
      .describe(
        "Single-file content to import. Use this for one-shot imports without setting up tokens.config.json. Mutually exclusive with `files` and `configPath`.",
      ),
    files: z
      .array(
        z.object({
          path: z.string().describe("Relative or absolute filesystem path."),
          content: z.string().describe("File contents."),
        }),
      )
      .optional()
      .describe(
        "Multi-file import (used for Tokens Studio's split-set format, or for projects with many DTCG source files). Mutually exclusive with `payload` and `configPath`.",
      ),
    configPath: z
      .string()
      .optional()
      .describe(
        "Explicit path to tokens.config.json. When omitted, the tool autodiscovers and uses the config's source.dir to find files. Mutually exclusive with `payload` and `files`.",
      ),
    strategy: SyncStrategySchema.optional().describe(
      "How to apply changes. 'merge' (default) diffs against current Figma state and applies only deltas, preserving Figma-only variables. 'replace' wipes the target collections and rewrites. 'dry-run' computes the diff and reports without touching Figma.",
    ),
    collectionMapping: z
      .record(z.string())
      .optional()
      .describe(
        "Map input token set names to Figma collection names. Example: {'primitives': 'Primitive Tokens'}. When omitted, set names map 1:1 to collection names.",
      ),
    modeMapping: z
      .record(z.string())
      .optional()
      .describe(
        "Map input mode names to Figma mode names. Useful when source uses 'light'/'dark' and Figma uses 'Light'/'Dark'. Defaults to 1:1 mapping with case preservation.",
      ),
    prefix: z
      .string()
      .optional()
      .describe(
        "Prefix to strip from input token names on import. E.g. with prefix 'ds-', a token named '--ds-color-primary' becomes 'color/primary'.",
      ),
    onConflict: ConflictResolutionSchema.optional().describe(
      "How to resolve true two-sided conflicts (both Figma and code changed the same token since last sync). 'ask' (default) surfaces the conflict and writes nothing. 'figma-wins' / 'code-wins' apply the corresponding side. 'skip' leaves conflicted tokens alone but proceeds with the rest.",
    ),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "Shorthand for strategy: 'dry-run'. Computes the diff and returns a preview without applying any changes to Figma.",
      ),
  })
  .refine(
    (data) => {
      // Exactly one of payload / files / configPath should be set (or none,
      // which triggers tokens.config.json autodiscovery).
      const sources = [data.payload, data.files, data.configPath].filter(
        (x) => x !== undefined,
      );
      return sources.length <= 1;
    },
    {
      message:
        "Pass at most one of: payload, files, configPath. (Or none, to autodiscover tokens.config.json.)",
    },
  );

export type ImportTokensInput = z.infer<typeof ImportTokensInputSchema>;
