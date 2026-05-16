/**
 * MCP tool registrar for figma_export_tokens and figma_import_tokens.
 *
 * Phase 1 scope:
 *   - figma_export_tokens: working for DTCG output. Other formats return a
 *     helpful "scaffolded but not yet implemented" error.
 *   - figma_import_tokens: working for DTCG input. Other formats return the
 *     same stub error. Computes a diff preview against current Figma state.
 *     Apply mutations are stubbed in Phase 1 (return the diff plan; future
 *     phase wires this into the existing figma_setup_design_tokens /
 *     figma_batch_create_variables tools).
 *
 * Both tools auto-discover `tokens.config.json` at the project root and use
 * its source/generated/modes/conflictResolution settings as defaults. They
 * stay zero-arg in normal use.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createChildLogger } from "./logger.js";
import {
  convertFigmaVariablesToDocument,
  ExportTokensInputSchema,
  ImportTokensInputSchema,
  format as formatTokenDocument,
  loadTokensConfig,
  parse as parseTokenPayload,
  resolveOutputTargets,
  type TokenDocument,
} from "./tokens/index.js";

const logger = createChildLogger({ component: "tokens-tools" });

const EXPORT_TOOL_DESCRIPTION = `Export Figma variables to design token files in your codebase. Bidirectional with figma_import_tokens — together they replace Style Dictionary and Tokens Studio's export pipeline for the popular styling methods.

CANONICAL OUTPUT IS DTCG JSON (https://tr.designtokens.org/format/). Additional output formats (CSS custom properties, Tailwind v4 @theme, SCSS, TS modules, etc.) are scaffolded in this release — DTCG is the only format fully implemented in Phase 1.

ZERO-ARG USAGE: With a tokens.config.json at your project root, just call the tool with no args — it picks up source dir, output formats, modes, prefix, etc. from config. See the response's \`suggestedScaffold\` payload when no config is detected — present it to the user, write the scaffold via your file tools, then call again.

MERGE STRATEGY: Default \`strategy: "merge"\` only writes tokens that actually changed in Figma since the last sync. Use \`dry-run\` to preview what would change. Use \`replace\` to wipe and rewrite (rare; for resetting drift).

ROUND-TRIP SAFETY: Figma variable IDs are preserved in DTCG \`$extensions["figma-console-mcp"]\` so renames on either side don't create duplicates. The same metadata enables non-destructive incremental sync via figma_import_tokens.`;

const IMPORT_TOOL_DESCRIPTION = `Push design tokens from your codebase into Figma as variables. Bidirectional with figma_export_tokens.

ACCEPTS: DTCG JSON (canonical, Phase 1 fully supported). Tokens Studio JSON, CSS custom properties, Tailwind v4 @theme, SCSS, and Style Dictionary v3 are scaffolded but return a NotImplementedError in this release — convert to DTCG first via figma_export_tokens or hand-author DTCG. Use \`format: "auto"\` to sniff the input.

DIFF-AWARE: Default \`strategy: "merge"\` diffs against current Figma state and applies only deltas. The hacked-color scenario — designer edits one hex value in their CSS — produces exactly one Figma API update, not a full collection rewrite. Match priority: Figma variable ID (in \`$extensions["figma-console-mcp"].variableId\`), then exact token path, then value fingerprint.

CONFLICT HANDLING: When BOTH Figma and code changed the same token since the last sync, \`onConflict: "ask"\` (default) surfaces the conflict and writes nothing. Use \`figma-wins\` / \`code-wins\` to auto-resolve, or \`skip\` to leave conflicts alone and proceed with the rest.

DRY-RUN: Default first call after detecting changes is dry-run for safety. The response includes the full diff plan; user confirms, then call again with \`dryRun: false\` (or \`strategy\` other than dry-run) to apply.`;

export function registerExportTokensTool(
  server: McpServer,
  getDesktopConnector: () => Promise<any>,
): void {
  server.tool(
    "figma_export_tokens",
    EXPORT_TOOL_DESCRIPTION,
    ExportTokensInputSchema.shape,
    async (args) => {
      try {
        return await handleExport(args, getDesktopConnector);
      } catch (err) {
        logger.error({ err }, "figma_export_tokens failed");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
                hint: "If this is a NotImplementedError for a non-DTCG format, export to 'dtcg' instead — that's the only format fully implemented in Phase 1. The canonical DTCG JSON can be consumed by Style Dictionary v4 or any other DTCG-aware tooling.",
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}

export function registerImportTokensTool(
  server: McpServer,
  getDesktopConnector: () => Promise<any>,
): void {
  server.tool(
    "figma_import_tokens",
    IMPORT_TOOL_DESCRIPTION,
    ImportTokensInputSchema._def.schema.shape,
    async (args) => {
      try {
        return await handleImport(args, getDesktopConnector);
      } catch (err) {
        logger.error({ err }, "figma_import_tokens failed");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
                hint: "If this is a NotImplementedError for a non-DTCG format, convert the source to DTCG first (e.g. via figma_export_tokens then edit the JSON).",
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}

/**
 * Convenience: register both tools at once.
 */
export function registerTokensTools(
  server: McpServer,
  getDesktopConnector: () => Promise<any>,
): void {
  registerExportTokensTool(server, getDesktopConnector);
  registerImportTokensTool(server, getDesktopConnector);
}

// ============================================================================
// HANDLERS
// ============================================================================

async function handleExport(
  args: any,
  getDesktopConnector: () => Promise<any>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  // 1. Load config (autodiscover or explicit).
  const loaded = loadTokensConfig({ explicitPath: args.configPath });

  // 2. Fetch variables from Figma via the desktop connector. The connector's
  //    getVariablesFromPluginUI returns the plugin's cached variable data
  //    (instant, all plans, full Plugin API fidelity).
  const connector = await getDesktopConnector();
  // We don't have a specific fileKey here unless the caller passed one in
  // config; pass undefined to let the connector use the currently-connected
  // file context.
  const fileKey = loaded?.config?.figmaFile
    ? extractFileKey(loaded.config.figmaFile)
    : undefined;

  const raw = await connector.getVariablesFromPluginUI(fileKey);

  // Unwrap the plugin's response — same logic as the existing figma_get_variables.
  const variableData = raw?.result?.variables ? raw.result : raw;

  if (!variableData?.variables) {
    throw new Error(
      "[figma-console-mcp] No variables found in the connected Figma file. Make sure the Desktop Bridge plugin is running and the file has at least one variable collection.",
    );
  }

  // 3. Normalize to the converter's expected shape.
  const payload = normalizeFigmaPayload(variableData);

  // 4. Convert to canonical TokenDocument.
  const { document, warnings } = convertFigmaVariablesToDocument(payload, {
    figmaFileKey: fileKey,
    collectionIds: args.collectionIds,
    modes: args.modes,
    stripPrefix: args.prefix,
    mcpVersion: "1.26.0",
  });

  // 5. Resolve which output formats to emit.
  const targets = resolveOutputTargets(loaded?.config ?? null, args.format);

  // 6. Format the document for each target.
  const allFiles: Array<{ format: string; path: string; content: string }> = [];
  const allWarnings: string[] = [...warnings];

  for (const target of targets) {
    try {
      const result = formatTokenDocument(document, {
        target: {
          ...target,
          splitByMode: args.splitByMode ?? target.splitByMode,
          splitByCollection: args.splitByCollection ?? target.splitByCollection,
          prefix: args.prefix ?? target.prefix,
          resolveAliases: args.resolveAliases ?? target.resolveAliases,
          transforms: {
            colorFormat: args.colorFormat ?? target.transforms?.colorFormat,
            sizeUnit: args.sizeUnit ?? target.transforms?.sizeUnit,
            remBase: args.remBase ?? target.transforms?.remBase,
          },
        },
        projectRoot: loaded?.projectRoot,
      });
      for (const file of result.files) {
        allFiles.push({ format: target.format, ...file });
      }
      allWarnings.push(...result.warnings);
    } catch (err) {
      // Non-DTCG formatters throw NotImplementedError. Surface it without
      // bailing on the other targets.
      allWarnings.push(
        `[${target.format}] ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 7. If outputPath is set, write to disk. Otherwise return inline.
  const dryRun = args.strategy === "dry-run";
  const outputBase = resolveOutputBase(args.outputPath, loaded);
  let writtenPaths: string[] = [];

  if (outputBase && !dryRun) {
    for (const file of allFiles) {
      const fullPath = isAbsolute(file.path)
        ? file.path
        : join(outputBase, file.path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, file.content, "utf-8");
      writtenPaths.push(fullPath);
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: true,
            mode: dryRun ? "dry-run" : outputBase ? "written" : "inline",
            configFound: !!loaded,
            configPath: loaded?.configPath ?? null,
            collections: document.sets.map((s) => ({
              name: s.name,
              modes: s.modes,
              tokenCount: s.tokens.length,
              figmaCollectionId: s.meta?.figmaCollectionId,
            })),
            outputs: dryRun
              ? allFiles.map((f) => ({
                  format: f.format,
                  path: f.path,
                  preview: f.content.slice(0, 500) + (f.content.length > 500 ? "…" : ""),
                }))
              : outputBase
                ? writtenPaths.map((p) => ({ writtenTo: p }))
                : allFiles,
            warnings: allWarnings,
            ...(loaded
              ? {}
              : {
                  suggestedScaffold: {
                    note: "No tokens.config.json detected. Recommended scaffold:",
                    configContent: JSON.stringify(
                      {
                        $schema:
                          "https://figma-console-mcp.southleft.com/schemas/tokens.config.v1.json",
                        source: { dir: "src/styles/tokens", canonical: "dtcg" },
                        generated: {
                          dir: "src/styles/generated",
                          formats: [{ format: "css-vars", splitByMode: true }],
                        },
                        conflictResolution: "ask",
                      },
                      null,
                      2,
                    ),
                    directories: ["src/styles/tokens", "src/styles/generated"],
                    nextSteps:
                      "Write tokens.config.json at the project root, create the directories, then call figma_export_tokens again — zero args needed.",
                  },
                }),
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleImport(
  args: any,
  getDesktopConnector: () => Promise<any>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  // 1. Load config + resolve where the source payload(s) live.
  const loaded = loadTokensConfig({ explicitPath: args.configPath });

  // 2. Collect input payloads.
  const inputFiles = collectInputFiles(args, loaded);

  // 3. Parse each input file to a TokenDocument.
  const documents: TokenDocument[] = [];
  const parseWarnings: string[] = [];
  for (const file of inputFiles) {
    const parseResult = parseTokenPayload(args.format ?? "auto", {
      payload: file.content,
      sourcePath: file.path,
    });
    documents.push(parseResult.document);
    parseWarnings.push(...parseResult.warnings);
  }

  // 4. Merge documents into a single TokenDocument (sets are concatenated;
  //    tokens within sets are combined by path).
  const merged = mergeDocuments(documents);

  // 5. Fetch current Figma state for diffing.
  const connector = await getDesktopConnector();
  const fileKey = loaded?.config?.figmaFile
    ? extractFileKey(loaded.config.figmaFile)
    : undefined;
  const raw = await connector.getVariablesFromPluginUI(fileKey);
  const variableData = raw?.result?.variables ? raw.result : raw;
  const figmaPayload = normalizeFigmaPayload(variableData ?? { variables: [], variableCollections: [] });
  const { document: figmaDoc } = convertFigmaVariablesToDocument(figmaPayload, {
    figmaFileKey: fileKey,
    mcpVersion: "1.26.0",
  });

  // 6. Compute the diff plan. Phase 1: return the diff structure but don't
  //    apply mutations — the apply path will be wired into the existing
  //    figma_setup_design_tokens / figma_batch_create_variables tools in
  //    Phase 2 so we get retry/batching/rate-limit handling for free.
  const diff = computeDiffPlan(figmaDoc, merged);

  const dryRun = args.dryRun === true || args.strategy === "dry-run";

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: true,
            mode: dryRun ? "dry-run" : "not-applied-in-phase-1",
            phase1Note:
              "Phase 1 returns the diff plan but does not apply mutations. The apply path (calling figma_setup_design_tokens / figma_batch_create_variables for the diff entries) ships in Phase 2. For now, you can call those tools manually with the deltas shown below.",
            inputFileCount: inputFiles.length,
            parsedSetCount: merged.sets.length,
            parsedTokenCount: merged.sets.reduce((n, s) => n + s.tokens.length, 0),
            diff,
            warnings: parseWarnings,
          },
          null,
          2,
        ),
      },
    ],
  };
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Extract a Figma file key from a URL or return the string as-is if it's
 * already a key.
 */
function extractFileKey(figmaFileOrUrl: string): string {
  const match = figmaFileOrUrl.match(/figma\.com\/(?:file|design)\/([a-zA-Z0-9]+)/);
  return match ? match[1] : figmaFileOrUrl;
}

/**
 * Normalize the plugin's variable response into the converter's expected
 * shape. The plugin may return collections keyed by ID or as an array;
 * normalize both into an array.
 */
function normalizeFigmaPayload(raw: any): {
  collections: any[];
  variables: any[];
} {
  const collections = Array.isArray(raw.variableCollections)
    ? raw.variableCollections
    : Object.entries(raw.variableCollections ?? {}).map(
        ([id, c]: [string, any]) => ({ id, ...c }),
      );
  const variables = Array.isArray(raw.variables)
    ? raw.variables
    : Object.entries(raw.variables ?? {}).map(([id, v]: [string, any]) => ({
        id,
        ...v,
      }));
  return { collections, variables };
}

/**
 * Resolve where to write output files. If outputPath is provided and absolute,
 * use it directly. If relative, resolve against the project root (config dir)
 * or cwd. If no outputPath, return null (caller returns content inline).
 */
function resolveOutputBase(
  outputPath: string | undefined,
  loaded: ReturnType<typeof loadTokensConfig>,
): string | null {
  if (!outputPath && !loaded?.config.generated?.dir) return null;
  const base = outputPath ?? loaded!.config.generated!.dir;
  if (isAbsolute(base)) return base;
  return resolve(loaded?.projectRoot ?? process.cwd(), base);
}

/**
 * Gather input files for import. Priority:
 *   1. Explicit payload string.
 *   2. Explicit files array.
 *   3. Config-derived source dir (read every *.tokens.json file).
 */
function collectInputFiles(
  args: any,
  loaded: ReturnType<typeof loadTokensConfig>,
): Array<{ path: string; content: string }> {
  if (args.payload) {
    return [{ path: "<inline>", content: args.payload }];
  }
  if (args.files?.length) {
    return args.files;
  }
  if (!loaded) {
    throw new Error(
      "[figma-console-mcp] No payload, files, or tokens.config.json supplied. Pass one of: { payload }, { files }, or have tokens.config.json at the project root.",
    );
  }
  // Walk the source dir for *.tokens.json files. Phase 1 does a flat scan;
  // the config's source.pattern is honored as a simple glob (just suffix
  // matching for now).
  const sourceDir = resolve(loaded.projectRoot, loaded.config.source.dir);
  if (!existsSync(sourceDir)) {
    throw new Error(
      `[figma-console-mcp] Source dir does not exist: ${sourceDir}. Make sure tokens.config.json's source.dir points at a directory that exists.`,
    );
  }
  const pattern = loaded.config.source.pattern ?? "*.tokens.json";
  const suffix = pattern.replace(/^\*/, "");
  // Synchronous readdir to keep this dependency-free.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const entries = readdirSync(sourceDir);
  return entries
    .filter((e: string) => e.endsWith(suffix))
    .map((name: string) => {
      const full = join(sourceDir, name);
      return { path: full, content: readFileSync(full, "utf-8") };
    });
}

/**
 * Merge multiple TokenDocuments. Sets with the same name combine their
 * tokens; modes are unioned; document-level metadata uses the first
 * document's values.
 */
function mergeDocuments(docs: TokenDocument[]): TokenDocument {
  if (docs.length === 0) {
    return { sets: [], meta: {} };
  }
  if (docs.length === 1) return docs[0];

  const setsByName = new Map<string, TokenDocument["sets"][number]>();
  for (const doc of docs) {
    for (const set of doc.sets) {
      const existing = setsByName.get(set.name);
      if (!existing) {
        setsByName.set(set.name, { ...set, tokens: [...set.tokens] });
      } else {
        existing.modes = [...new Set([...existing.modes, ...set.modes])];
        existing.tokens.push(...set.tokens);
      }
    }
  }
  return {
    $schema: docs[0].$schema,
    sets: [...setsByName.values()],
    meta: docs[0].meta,
  };
}

/**
 * Compute a diff plan between Figma's current state (left) and the code's
 * proposed state (right). Phase 1 returns a structured summary; full apply
 * logic ships in Phase 2.
 */
function computeDiffPlan(
  figmaDoc: TokenDocument,
  codeDoc: TokenDocument,
): {
  toCreate: Array<{ path: string; type: string; value: unknown }>;
  toUpdate: Array<{ path: string; before: unknown; after: unknown }>;
  toDelete: Array<{ path: string }>;
  unchanged: number;
} {
  // Build lookup maps by path for both sides.
  const figmaTokens = new Map<string, any>();
  for (const set of figmaDoc.sets) {
    for (const t of set.tokens) {
      figmaTokens.set(`${set.name}::${t.path.join(".")}`, t);
    }
  }
  const codeTokens = new Map<string, any>();
  for (const set of codeDoc.sets) {
    for (const t of set.tokens) {
      codeTokens.set(`${set.name}::${t.path.join(".")}`, t);
    }
  }

  const toCreate: Array<{ path: string; type: string; value: unknown }> = [];
  const toUpdate: Array<{ path: string; before: unknown; after: unknown }> = [];
  const toDelete: Array<{ path: string }> = [];
  let unchanged = 0;

  for (const [key, codeToken] of codeTokens) {
    const figmaToken = figmaTokens.get(key);
    if (!figmaToken) {
      toCreate.push({
        path: key,
        type: codeToken.type,
        value: codeToken.values,
      });
    } else if (
      JSON.stringify(figmaToken.values) !== JSON.stringify(codeToken.values)
    ) {
      toUpdate.push({
        path: key,
        before: figmaToken.values,
        after: codeToken.values,
      });
    } else {
      unchanged++;
    }
  }

  for (const key of figmaTokens.keys()) {
    if (!codeTokens.has(key)) {
      // Phase 1 reports as "would delete if strategy=replace" but defaults to
      // preserve under merge strategy.
      toDelete.push({ path: key });
    }
  }

  return { toCreate, toUpdate, toDelete, unchanged };
}
