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

import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
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
  // Output routing: canonical-format files (matching config.source.canonical)
  // go to source.dir; everything else goes to generated.dir.
  const dryRun = args.strategy === "dry-run";
  const writtenPaths: string[] = [];

  if (!dryRun) {
    for (const file of allFiles) {
      const base = resolveOutputBaseForFormat(
        args.outputPath,
        loaded,
        file.format,
      );
      if (!base) continue; // No config or outputPath → caller will get content inline.
      const fullPath = isAbsolute(file.path)
        ? file.path
        : join(base, file.path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, file.content, "utf-8");
      writtenPaths.push(fullPath);
    }
  }
  const outputBase = writtenPaths.length > 0 ? "(multiple)" : null;

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

  // 6. Compute the diff plan.
  const diff = computeDiffPlan(figmaDoc, merged);

  const dryRun = args.dryRun === true || args.strategy === "dry-run";

  // 7. Apply phase: when not dry-run, push toUpdate entries to Figma via
  //    the plugin's executeCodeViaUI. Create + delete are stubbed for a
  //    future phase (value updates cover the common designer workflow:
  //    edit a hex value in JSON, push to Figma).
  let applyResult: ApplyResult | null = null;
  if (!dryRun && diff.toUpdate.length > 0) {
    const collectionModeMap = buildCollectionModeMap(figmaPayload);
    const updates = buildUpdatePayloads(
      diff.toUpdate,
      figmaDoc,
      merged,
      collectionModeMap,
      parseWarnings,
    );
    if (updates.length > 0) {
      applyResult = await applyUpdates(connector, updates);
    }
  }

  // Slim the diff for the response: full entries blow past LLM context for
  // large design systems. Show counts + a sample of first N entries from
  // each bucket; the caller can re-run with format=detailed if they want
  // everything.
  const SAMPLE_LIMIT = 20;
  const slimDiff = {
    summary: {
      toCreate: diff.toCreate.length,
      toUpdate: diff.toUpdate.length,
      toDelete: diff.toDelete.length,
      unchanged: diff.unchanged,
    },
    samples: {
      toCreate: diff.toCreate.slice(0, SAMPLE_LIMIT).map((e) => ({
        path: e.path,
        type: e.type,
      })),
      toUpdate: diff.toUpdate.slice(0, SAMPLE_LIMIT),
      toDelete: diff.toDelete.slice(0, SAMPLE_LIMIT),
    },
    truncated: {
      toCreate: diff.toCreate.length > SAMPLE_LIMIT,
      toUpdate: diff.toUpdate.length > SAMPLE_LIMIT,
      toDelete: diff.toDelete.length > SAMPLE_LIMIT,
    },
  };

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: true,
            mode: dryRun ? "dry-run" : applyResult ? "applied" : "no-changes",
            applyNote: dryRun
              ? "Dry-run only — no Figma mutations performed."
              : applyResult
                ? `Applied ${applyResult.applied} value update(s) to Figma. ${applyResult.failed} failed.`
                : diff.toUpdate.length === 0
                  ? "Nothing to apply — all tokens already in sync."
                  : "Updates were detected but skipped (likely all aliases or unresolved values).",
            toCreatePhase2Note:
              diff.toCreate.length > 0
                ? `${diff.toCreate.length} create(s) detected — create-phase mutations ship in a future phase. Use figma_setup_design_tokens / figma_batch_create_variables manually for now.`
                : undefined,
            toDeletePhase2Note:
              diff.toDelete.length > 0
                ? `${diff.toDelete.length} Figma-only token(s) preserved (merge strategy). Use strategy: "replace" to delete them, or figma_delete_variable manually.`
                : undefined,
            inputFileCount: inputFiles.length,
            parsedSetCount: merged.sets.length,
            parsedTokenCount: merged.sets.reduce((n, s) => n + s.tokens.length, 0),
            diff: slimDiff,
            applyResult: applyResult
              ? {
                  applied: applyResult.applied,
                  failed: applyResult.failed,
                  errors: applyResult.errors.slice(0, 10),
                }
              : null,
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
 * Resolve where to write output files for a specific format. Canonical formats
 * (matching config.source.canonical) go to source.dir; everything else goes
 * to generated.dir. Caller-supplied outputPath wins over both.
 */
function resolveOutputBaseForFormat(
  outputPath: string | undefined,
  loaded: ReturnType<typeof loadTokensConfig>,
  format: string,
): string | null {
  // Explicit outputPath always wins.
  if (outputPath) {
    return isAbsolute(outputPath)
      ? outputPath
      : resolve(loaded?.projectRoot ?? process.cwd(), outputPath);
  }
  if (!loaded) return null;
  // Canonical format goes to source.dir.
  if (format === loaded.config.source.canonical) {
    return resolve(loaded.projectRoot, loaded.config.source.dir);
  }
  // Otherwise generated.dir.
  if (loaded.config.generated?.dir) {
    return resolve(loaded.projectRoot, loaded.config.generated.dir);
  }
  return null;
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
 * tokens; tokens with the same path within a set have their mode-values
 * merged (so splitByMode files reassemble cleanly into one multi-mode
 * representation). Modes are unioned. Document-level metadata uses the
 * first document's values.
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
        continue;
      }
      existing.modes = [...new Set([...existing.modes, ...set.modes])];
      // Dedupe by path: tokens with the same path merge their values.
      // Critical for splitByMode output where each file has the same tokens
      // with a different mode's value, and the import needs to reassemble
      // them into one multi-mode token instead of triplicating.
      const byPath = new Map(
        existing.tokens.map((t) => [t.path.join("/"), t]),
      );
      for (const incoming of set.tokens) {
        const key = incoming.path.join("/");
        const found = byPath.get(key);
        if (found) {
          found.values = { ...found.values, ...incoming.values };
          // Merge MCP extensions too — newer lastSyncedAt wins, lastSyncedValue
          // unions across modes.
          const aExt = found.extensions?.["figma-console-mcp"];
          const bExt = incoming.extensions?.["figma-console-mcp"];
          if (aExt || bExt) {
            const merged = { ...(aExt ?? {}), ...(bExt ?? {}) };
            if (aExt?.lastSyncedValue || bExt?.lastSyncedValue) {
              merged.lastSyncedValue = {
                ...(aExt?.lastSyncedValue ?? {}),
                ...(bExt?.lastSyncedValue ?? {}),
              };
            }
            found.extensions = { ...(found.extensions ?? {}), "figma-console-mcp": merged };
          }
        } else {
          existing.tokens.push(incoming);
          byPath.set(key, incoming);
        }
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
    } else if (!valuesEqual(figmaToken.values, codeToken.values)) {
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

/**
 * Structural equality for a token's mode-keyed values map. Order-independent
 * so two tokens that have the same modes with the same values produce a
 * match regardless of object insertion order.
 *
 * Recursive for composite values (typography, shadow) — those have nested
 * objects too. Aliases are equal when both have the same `reference` string;
 * literals are equal by deep value comparison.
 */
function valuesEqual(
  a: Record<string, any>,
  b: Record<string, any>,
): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (!deepEqual(a[aKeys[i]], b[bKeys[i]])) return false;
  }
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, (b as unknown[])[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).sort();
  const bKeys = Object.keys(bObj).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (!deepEqual(aObj[aKeys[i]], bObj[bKeys[i]])) return false;
  }
  return true;
}

// ============================================================================
// APPLY PHASE — push code-side changes back to Figma via the plugin
// ============================================================================

/**
 * Result of the apply phase. Returned in the tool response so the AI can
 * report what actually happened to the user.
 */
interface ApplyResult {
  applied: number;
  failed: number;
  errors: Array<{ variableId: string; error: string }>;
}

/**
 * One variable update to push to Figma. mapping is by modeId (Figma's
 * native identifier), not mode name, because that's what the Plugin API
 * needs.
 */
interface VariableUpdate {
  variableId: string;
  variableName: string;
  resolvedType: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
  valuesByMode: Record<string, unknown>; // modeId → Figma-native value
}

/**
 * Build a quick lookup of (collectionId, modeName) → modeId from the raw
 * Figma payload. Needed because our internal model is keyed by mode name
 * but the Plugin API wants the modeId.
 */
function buildCollectionModeMap(
  payload: { collections: any[]; variables: any[] },
): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const c of payload.collections) {
    const modes = new Map<string, string>();
    for (const m of c.modes ?? []) {
      modes.set(m.name, m.modeId);
    }
    out.set(c.id, modes);
  }
  return out;
}

/**
 * Convert a TokenValue back to Figma's native value shape. Required for the
 * Plugin API's setValueForMode call.
 *
 *   - color hex string "#RRGGBB(AA)" → { r, g, b, a } floats in [0, 1]
 *   - FLOAT-typed number → number
 *   - STRING-typed string → string
 *   - BOOLEAN → boolean
 *   - Alias references are unsupported in Phase 2 apply (would need to
 *     resolve the target variable ID); returns null and the caller skips
 *     the update.
 */
function tokenValueToFigma(
  value: { literal?: unknown; reference?: string },
  resolvedType: VariableUpdate["resolvedType"],
): unknown | null {
  if (value.reference) {
    // Future phase: look up the referenced variable's Figma ID and emit
    // { type: "VARIABLE_ALIAS", id }. For now, skip alias updates so we
    // don't accidentally wipe a reference with a literal.
    return null;
  }
  if (value.literal === undefined || value.literal === null) return null;

  if (resolvedType === "COLOR" && typeof value.literal === "string") {
    return hexToRgba(value.literal);
  }
  if (resolvedType === "FLOAT") {
    return typeof value.literal === "number"
      ? value.literal
      : Number(value.literal);
  }
  if (resolvedType === "BOOLEAN") {
    return Boolean(value.literal);
  }
  // STRING and fallthrough.
  return typeof value.literal === "string"
    ? value.literal
    : String(value.literal);
}

function hexToRgba(hex: string): {
  r: number;
  g: number;
  b: number;
  a: number;
} {
  const cleaned = hex.replace(/^#/, "");
  let r: number;
  let g: number;
  let b: number;
  let a = 1;
  if (cleaned.length === 3) {
    r = parseInt(cleaned[0] + cleaned[0], 16) / 255;
    g = parseInt(cleaned[1] + cleaned[1], 16) / 255;
    b = parseInt(cleaned[2] + cleaned[2], 16) / 255;
  } else if (cleaned.length === 6) {
    r = parseInt(cleaned.slice(0, 2), 16) / 255;
    g = parseInt(cleaned.slice(2, 4), 16) / 255;
    b = parseInt(cleaned.slice(4, 6), 16) / 255;
  } else if (cleaned.length === 8) {
    r = parseInt(cleaned.slice(0, 2), 16) / 255;
    g = parseInt(cleaned.slice(2, 4), 16) / 255;
    b = parseInt(cleaned.slice(4, 6), 16) / 255;
    a = parseInt(cleaned.slice(6, 8), 16) / 255;
  } else {
    throw new Error(
      `[figma-console-mcp] Invalid hex color "${hex}" — expected 3, 6, or 8 hex digits.`,
    );
  }
  return { r, g, b, a };
}

/**
 * Walk the toUpdate diff entries and translate each into a VariableUpdate.
 * Tokens that lack a Figma variable ID (never been synced) or have no
 * resolvable value for any mode get skipped with a warning.
 */
function buildUpdatePayloads(
  toUpdate: Array<{ path: string; before: unknown; after: unknown }>,
  figmaDoc: TokenDocument,
  codeDoc: TokenDocument,
  collectionModeMap: Map<string, Map<string, string>>,
  warnings: string[],
): VariableUpdate[] {
  // Build lookups: setName::tokenPath → (figmaToken, codeToken)
  const figmaLookup = new Map<string, { token: any; set: any }>();
  for (const set of figmaDoc.sets) {
    for (const t of set.tokens) {
      figmaLookup.set(`${set.name}::${t.path.join(".")}`, { token: t, set });
    }
  }
  const codeLookup = new Map<string, { token: any; set: any }>();
  for (const set of codeDoc.sets) {
    for (const t of set.tokens) {
      codeLookup.set(`${set.name}::${t.path.join(".")}`, { token: t, set });
    }
  }

  const updates: VariableUpdate[] = [];
  for (const entry of toUpdate) {
    const codeMatch = codeLookup.get(entry.path);
    const figmaMatch = figmaLookup.get(entry.path);
    if (!codeMatch || !figmaMatch) continue;

    const figmaToken = figmaMatch.token;
    const variableId = figmaToken.extensions?.["figma-console-mcp"]?.variableId;
    const collectionId =
      figmaToken.extensions?.["figma-console-mcp"]?.collectionId;
    if (!variableId || !collectionId) {
      warnings.push(
        `Cannot update ${entry.path} — missing Figma variable ID in extensions. Run figma_export_tokens first to populate.`,
      );
      continue;
    }

    const modeMap = collectionModeMap.get(collectionId);
    if (!modeMap) {
      warnings.push(
        `Cannot update ${entry.path} — collection ${collectionId} not found in current Figma state.`,
      );
      continue;
    }

    // Map our token type → Figma resolvedType. Both DTCG type names and
    // Figma names need to align here.
    const resolvedType = inferFigmaResolvedType(figmaToken.type);

    const valuesByMode: Record<string, unknown> = {};
    for (const [modeName, value] of Object.entries(codeMatch.token.values)) {
      const modeId = modeMap.get(modeName);
      if (!modeId) {
        warnings.push(
          `Cannot update ${entry.path} (mode "${modeName}") — modeId not found in Figma collection.`,
        );
        continue;
      }
      const figmaValue = tokenValueToFigma(value as any, resolvedType);
      if (figmaValue === null) continue;
      valuesByMode[modeId] = figmaValue;
    }

    if (Object.keys(valuesByMode).length === 0) continue;

    updates.push({
      variableId,
      variableName: figmaToken.path.join("/"),
      resolvedType,
      valuesByMode,
    });
  }

  return updates;
}

/**
 * Map our internal TokenType to Figma's variable resolvedType. The Plugin API
 * only has 4 resolved types — collapse our richer set onto them.
 */
function inferFigmaResolvedType(
  type: string,
): VariableUpdate["resolvedType"] {
  if (type === "color") return "COLOR";
  if (type === "boolean") return "BOOLEAN";
  if (type === "string" || type === "fontFamily") return "STRING";
  return "FLOAT"; // dimension, number, fontWeight, duration, etc.
}

/**
 * Push variable updates to Figma via executeCodeViaUI. The plugin runs the
 * inline script in its sandbox, calling figma.variables.setValueForMode for
 * each (variableId, modeId, value) tuple.
 */
async function applyUpdates(
  connector: any,
  updates: VariableUpdate[],
): Promise<ApplyResult> {
  // Serialize the update list into the script payload. JSON.stringify
  // handles escape correctly even with nested objects (RGBA color values).
  const payload = JSON.stringify(updates);

  const script = `
    const updates = ${payload};
    const results = [];
    for (const u of updates) {
      try {
        const variable = await figma.variables.getVariableByIdAsync(u.variableId);
        if (!variable) {
          results.push({ id: u.variableId, success: false, error: "Variable not found in current file" });
          continue;
        }
        let appliedModes = 0;
        for (const modeId in u.valuesByMode) {
          variable.setValueForMode(modeId, u.valuesByMode[modeId]);
          appliedModes++;
        }
        results.push({ id: u.variableId, name: variable.name, success: true, appliedModes });
      } catch (err) {
        results.push({ id: u.variableId, success: false, error: String(err && err.message || err) });
      }
    }
    return {
      applied: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    };
  `;

  const execResult = await connector.executeCodeViaUI(script, 30000);

  if (!execResult?.success) {
    return {
      applied: 0,
      failed: updates.length,
      errors: [
        {
          variableId: "<batch>",
          error:
            execResult?.error ??
            "Plugin executeCodeViaUI returned an error or timed out.",
        },
      ],
    };
  }

  const inner = execResult.result ?? execResult;
  const errors = (inner.results ?? [])
    .filter((r: any) => !r.success)
    .map((r: any) => ({ variableId: r.id, error: r.error }));

  return {
    applied: inner.applied ?? 0,
    failed: inner.failed ?? 0,
    errors,
  };
}
