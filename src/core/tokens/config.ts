/**
 * tokens.config.json schema, loader, and autodiscovery for the figma-console-mcp
 * token sync engine.
 *
 * Both figma_export_tokens and figma_import_tokens read this single config so
 * follow-up calls in a project are zero-arg. Autodiscovery walks up from the
 * current working directory looking for `tokens.config.json` at each level
 * — same convention as `tsconfig.json`, `package.json`, `.eslintrc`, etc.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import type { ConflictResolution, ExportFormat } from "./types.js";

/**
 * Schema for a single output target in `tokens.config.json`. Each entry
 * produces one or more files when figma_export_tokens runs.
 */
const OutputTargetSchema = z.object({
  format: z.enum([
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
  ] as const),
  /** Optional filename override. Default is derived from format + scope. */
  filename: z.string().optional(),
  /** Output prefix applied to every token name (e.g. "ds-", "al-"). */
  prefix: z.string().optional(),
  /** Emit one file per mode (e.g. tokens-light.css, tokens-dark.css). */
  splitByMode: z.boolean().optional(),
  /** Emit one file per token set / Figma collection. */
  splitByCollection: z.boolean().optional(),
  /**
   * If true, alias references are resolved to literal values in the output.
   * If false, aliases are preserved (default for JSON formats, forced true
   * for CSS/SCSS/Tailwind/etc. since they can't natively express aliases).
   */
  resolveAliases: z.boolean().optional(),
  /** Per-target transform options. Override the global defaults. */
  transforms: z
    .object({
      colorFormat: z.enum(["hex", "hex8", "rgba", "oklch", "hsl"]).optional(),
      sizeUnit: z.enum(["px", "rem", "pt", "dp"]).optional(),
      remBase: z.number().positive().optional(),
    })
    .optional(),
});

export type OutputTarget = z.infer<typeof OutputTargetSchema>;

/**
 * Full schema for `tokens.config.json`. Every field is optional so the
 * minimum-viable config is `{ "figmaFile": "..." }` — the rest gets sensible
 * defaults.
 */
export const TokensConfigSchema = z
  .object({
    /** Optional JSON Schema URL for editor autocompletion. */
    $schema: z.string().optional(),
    /**
     * Figma file URL or fileKey. When omitted, tools fall back to the
     * currently-connected Desktop Bridge plugin's file (Local Mode) or the
     * file context bound by figma_pair_plugin (Cloud Mode).
     */
    figmaFile: z.string().optional(),
    /** Where the canonical (committed) token sources live. */
    source: z
      .object({
        /** Directory holding the canonical token files. */
        dir: z.string(),
        /** Glob pattern within dir. Default: "*.tokens.json" */
        pattern: z.string().optional(),
        /**
         * Canonical format for source files. DTCG is the recommended default;
         * Tokens Studio is supported for users who already have a `$themes.json`
         * setup (e.g. Altitude).
         */
        canonical: z.enum(["dtcg", "tokens-studio"]).default("dtcg"),
      })
      .default({ dir: "src/styles/tokens", canonical: "dtcg" }),
    /** Where build outputs (CSS, Tailwind, etc.) get written. */
    generated: z
      .object({
        dir: z.string().default("src/styles/generated"),
        formats: z.array(OutputTargetSchema).default([]),
      })
      .optional(),
    /** Mode name mappings (Figma mode name → output mode name). */
    modes: z
      .object({
        /** e.g. { "Light": "light", "Dark": "dark" } */
        map: z.record(z.string()).optional(),
        /** Default mode if a token has no explicit mode (e.g. "Light"). */
        default: z.string().optional(),
      })
      .optional(),
    /** Default conflict-resolution strategy when not specified per-call. */
    conflictResolution: z
      .enum(["ask", "figma-wins", "code-wins", "skip"])
      .default("ask"),
    /** Behavior for tokens that exist on one side but not the other. */
    sync: z
      .object({
        onMissingInCode: z
          .enum(["preserve", "delete", "warn"])
          .default("preserve"),
        onMissingInFigma: z
          .enum(["preserve", "delete", "warn"])
          .default("preserve"),
      })
      .optional(),
  })
  .strict();

export type TokensConfig = z.infer<typeof TokensConfigSchema>;

/**
 * Result of running `loadTokensConfig`. Includes the resolved config plus
 * provenance info — where the file was found and the absolute project root.
 */
export interface LoadedTokensConfig {
  config: TokensConfig;
  /** Absolute path to the discovered `tokens.config.json`. */
  configPath: string;
  /** Directory containing the config file — used as the project root. */
  projectRoot: string;
}

/**
 * Walk up from `startDir` looking for `tokens.config.json`. Returns the first
 * match, or `null` if none found by the filesystem root.
 */
export function findTokensConfig(startDir: string): string | null {
  let dir = resolve(startDir);
  // Hard cap on directory traversal so a misconfigured startDir can't loop
  // forever (defense against symlinks/weird filesystems).
  const maxDepth = 32;
  for (let i = 0; i < maxDepth; i++) {
    const candidate = join(dir, "tokens.config.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      // Hit filesystem root, no config found.
      return null;
    }
    dir = parent;
  }
  return null;
}

/**
 * Load and validate `tokens.config.json`. If `explicitPath` is provided, uses
 * that; otherwise autodiscovers by walking up from `cwd` (default
 * `process.cwd()`).
 *
 * Returns `null` if no config is found AND no explicit path was given. Throws
 * if an explicit path doesn't exist, or if the discovered file fails schema
 * validation.
 */
export function loadTokensConfig(opts: {
  cwd?: string;
  explicitPath?: string;
} = {}): LoadedTokensConfig | null {
  const cwd = opts.cwd ?? process.cwd();
  const configPath = opts.explicitPath
    ? resolve(opts.explicitPath)
    : findTokensConfig(cwd);

  if (!configPath) return null;
  if (!existsSync(configPath)) {
    throw new Error(
      `[figma-console-mcp] tokens.config.json not found at ${configPath}`,
    );
  }

  const raw = readFileSync(configPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[figma-console-mcp] tokens.config.json at ${configPath} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const result = TokensConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `[figma-console-mcp] tokens.config.json at ${configPath} failed validation:\n${issues}`,
    );
  }

  return {
    config: result.data,
    configPath,
    projectRoot: dirname(configPath),
  };
}

/**
 * Default config used when none is found. Drives the "no-config detected"
 * response shape from figma_export_tokens — the AI uses this to propose a
 * scaffold to the user.
 */
export const DEFAULT_TOKENS_CONFIG: TokensConfig = {
  source: { dir: "src/styles/tokens", canonical: "dtcg" },
  generated: {
    dir: "src/styles/generated",
    formats: [
      { format: "css-vars", splitByMode: true },
    ],
  },
  conflictResolution: "ask",
};

/**
 * Build a `suggestedScaffold` payload returned when a tool is called and no
 * `tokens.config.json` exists. The AI presents this scaffold to the user,
 * writes the files via its native edit/write tools, then calls the original
 * tool again.
 */
export function buildSuggestedScaffold(opts: {
  projectRoot: string;
  detectedFramework?: "tailwind-v4" | "tailwind-v3" | "css" | "scss" | "ts";
}): {
  configContent: string;
  directories: string[];
  stylesheetImport: string;
  nextSteps: string;
} {
  const config: TokensConfig = {
    $schema:
      "https://figma-console-mcp.southleft.com/schemas/tokens.config.v1.json",
    source: { dir: "src/styles/tokens", canonical: "dtcg" },
    generated: {
      dir: "src/styles/generated",
      formats: pickStartingFormats(opts.detectedFramework),
    },
    conflictResolution: "ask",
  };

  const stylesheetImport = pickStylesheetImport(opts.detectedFramework);

  return {
    configContent: JSON.stringify(config, null, 2),
    directories: [config.source.dir, config.generated?.dir ?? "src/styles/generated"],
    stylesheetImport,
    nextSteps: [
      "1. Write `tokens.config.json` at the project root using `configContent`.",
      `2. Create the directories: ${config.source.dir} and ${config.generated?.dir}.`,
      `3. Add this line to your main stylesheet:\n     ${stylesheetImport}`,
      "4. Run `figma_export_tokens` again — it'll pick up the new config and populate the source dir.",
    ].join("\n"),
  };
}

function pickStartingFormats(
  framework?: "tailwind-v4" | "tailwind-v3" | "css" | "scss" | "ts",
): OutputTarget[] {
  // Always emit DTCG as the canonical committed source; layer the
  // framework-appropriate runtime format on top.
  const base: OutputTarget[] = [];
  switch (framework) {
    case "tailwind-v4":
      base.push({ format: "tailwind-v4", splitByMode: true });
      break;
    case "tailwind-v3":
      base.push({ format: "tailwind-v3" });
      break;
    case "scss":
      base.push({ format: "scss", splitByMode: true });
      break;
    case "ts":
      base.push({ format: "ts-module" });
      base.push({ format: "css-vars", splitByMode: true });
      break;
    case "css":
    default:
      base.push({ format: "css-vars", splitByMode: true });
      break;
  }
  return base;
}

function pickStylesheetImport(
  framework?: "tailwind-v4" | "tailwind-v3" | "css" | "scss" | "ts",
): string {
  switch (framework) {
    case "tailwind-v4":
      return "@import './styles/generated/tailwind.theme.css';";
    case "scss":
      return "@use './styles/generated/tokens.scss' as *;";
    case "ts":
    case "css":
    default:
      return "@import './styles/generated/tokens.css';";
  }
}

/**
 * Pick the export formats from a loaded config that map to a given runtime
 * format. Used by figma_export_tokens to decide which generated files to
 * write. Returns the list verbatim if the caller passed an explicit format.
 */
export function resolveOutputTargets(
  config: TokensConfig | null,
  explicitFormat: ExportFormat | undefined,
): OutputTarget[] {
  if (explicitFormat) {
    // Caller specified a format directly; ignore config's generated list.
    return [{ format: explicitFormat }];
  }
  if (!config?.generated?.formats?.length) {
    // No formats configured. Default to DTCG only — produces the canonical
    // source files but no derived runtime outputs.
    return [{ format: "dtcg" }];
  }
  return config.generated.formats;
}

/**
 * Resolve the conflict-resolution strategy. Per-call argument wins over config
 * default, which wins over the global default ("ask").
 */
export function resolveConflictStrategy(
  config: TokensConfig | null,
  perCall: ConflictResolution | undefined,
): ConflictResolution {
  return perCall ?? config?.conflictResolution ?? "ask";
}
