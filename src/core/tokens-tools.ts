/**
 * MCP tool registrar for figma_export_tokens and figma_import_tokens.
 *
 * Current scope (v1.27.0):
 *   - figma_export_tokens: working for DTCG JSON (canonical) and CSS
 *     custom properties output. Other formats (Tailwind v4, SCSS, TS
 *     module, Tokens Studio, Style Dictionary v3) are scaffolded and
 *     return TokenFormatNotImplementedError with a helpful message
 *     directing users to DTCG.
 *   - figma_import_tokens: working for DTCG JSON input with full
 *     diff-aware merge and a complete apply phase:
 *       • toUpdate — value updates batched via the plugin bridge,
 *         including alias-target updates ({ type: "VARIABLE_ALIAS", id })
 *         when the reference resolves to an existing or just-created
 *         variable.
 *       • toCreate — missing collections (created with the token file's
 *         full mode list) and missing variables in one batched script;
 *         literal values first, alias values in a second pass so
 *         within-batch alias targets exist. TIMING/EASING cannot be
 *         created via the Plugin API and are skipped with a warning.
 *       • toDelete — STRICTLY gated behind strategy: "replace". Merge
 *         (default) preserves Figma-only variables and only reports them.
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
  buildTokenLookup,
  canonicalizeTokenValueForComparison,
  clamp01,
  convertFigmaVariablesToDocument,
  ExportTokensInputSchema,
  ImportTokensInputSchema,
  format as formatTokenDocument,
  hexToRawRgba,
  loadTokensConfig,
  parse as parseTokenPayload,
  resolveOutputTargets,
  stripRawColorFromValues,
  type TokenDocument,
} from "./tokens/index.js";

const logger = createChildLogger({ component: "tokens-tools" });

/**
 * MCP version stamp embedded in DTCG `$extensions["figma-console-mcp"].mcpVersion`
 * on every exported token document. Kept in sync with package.json by
 * scripts/release.sh — see step 3 of the release flow.
 */
const MCP_VERSION = "1.35.0";

const EXPORT_TOOL_DESCRIPTION = `Export Figma variables to design token files in your codebase. Bidirectional with figma_import_tokens — together they replace Style Dictionary and Tokens Studio's export pipeline for the popular styling methods.

FULLY-IMPLEMENTED OUTPUT FORMATS:
  • dtcg — W3C DTCG JSON. Canonical pivot format. Round-trip safe via \`$extensions["figma-console-mcp"]\`.
  • css-vars — CSS custom properties with mode-aware selectors (\`:root\`, \`.dark\`, \`[data-theme=...]\`).
  • tailwind-v4 — Tailwind v4 \`@theme inline\` block. Token-to-namespace mapping (color/*, spacing/*, radius/*, etc.) generates Tailwind utility classes.
  • tailwind-v3 — \`tailwind.config.js\` theme.extend object grouped under Tailwind's theme keys (colors, spacing, fontFamily, etc.).
  • scss — \`$var: value;\` declarations. Multi-mode emits a primary variable + a mode-keyed SCSS map for runtime access.
  • ts-module — \`export const tokens = { ... } as const\` with derived \`Tokens\` type. Multi-mode tokens emit as \`{ Light: ..., Dark: ... }\` objects.
  • json-flat — flat key-value JSON (\`{"ds-color-primary": "#4085F2"}\`) for custom build scripts.
  • json-nested — nested object JSON mirroring the token path tree.
  • style-dictionary-v3 — SD v3 source format with bare \`value\`/\`type\` keys (back-compat for existing SD users).
  • tokens-studio — Tokens Studio multi-file layout (\`$themes.json\` + \`$metadata.json\` + per-set files). Preserves Figma collection/mode bindings for round-trip with the TS plugin.

ZERO-ARG USAGE: With a tokens.config.json at your project root, just call the tool with no args — it picks up source dir, output formats, modes, prefix, etc. from config. See the response's \`suggestedScaffold\` payload when no config is detected — present it to the user, write the scaffold via your file tools, then call again.

MERGE STRATEGY: Default \`strategy: "merge"\` only writes tokens that actually changed in Figma since the last sync. Use \`dry-run\` to preview what would change. Use \`replace\` to wipe and rewrite (rare; for resetting drift).

DTCG DIALECT (\`dtcgDialect\`, applies to dtcg/json-flat/json-nested outputs): legacy (default): hex-string colors, maximum compatibility (Style Dictionary v4, Tokens Studio). 2025: DTCG 2025.10 object colors/dimensions (Style Dictionary v5+). figma_import_tokens accepts BOTH dialects regardless of this setting.

ROUND-TRIP SAFETY: Figma variable IDs are preserved in DTCG \`$extensions["figma-console-mcp"]\` so renames on either side don't create duplicates. The same metadata enables non-destructive incremental sync via figma_import_tokens. Variable scopes (when non-default) and per-platform codeSyntax (when set) are stashed there too and round-trip through import.`;

const IMPORT_TOOL_DESCRIPTION = `Push design tokens from your codebase into Figma as variables. Bidirectional with figma_export_tokens.

ACCEPTS: DTCG JSON (canonical, fully supported including round-trip metadata preservation). Tokens Studio JSON, CSS custom properties, Tailwind v4 @theme, SCSS, and Style Dictionary v3 are scaffolded but return a NotImplementedError — convert to DTCG first via figma_export_tokens or hand-author DTCG. Use \`format: "auto"\` to sniff the input.

APPLY PHASE (full bidirectional sync): toCreate entries create missing collections (with the token file's full mode list) and missing variables in one batched plugin round-trip — literal values first, alias values in a second pass so aliases between newly-created variables resolve. toUpdate entries push value updates in a batched round-trip, INCLUDING alias-target updates: when a token's value is a reference, it's written as a Figma variable alias if the reference resolves to an existing or just-created variable (unresolvable references skip with a warning). toDelete entries are STRICTLY gated behind \`strategy: "replace"\` — in replace mode, Figma variables absent from the token file are permanently deleted (a loud warning lists the count); merge (default) preserves them and only reports. TIMING/EASING variables cannot be created or written via the Plugin API and are skipped with a warning. Variable scopes and per-platform codeSyntax (from \`$extensions["figma-console-mcp"].scopes/.codeSyntax\`) are diffed and applied too — absent fields mean "no opinion" (Figma-side metadata is preserved), an explicit value is authoritative. Partial-success semantics: per-item errors surface in applyResult.errors[] without failing the batch.

DIFF-AWARE: Default \`strategy: "merge"\` diffs against current Figma state and applies only deltas. The hacked-color scenario — designer edits one hex value in their CSS — produces exactly one Figma API update, not a full collection rewrite. Match priority: Figma variable ID (in \`$extensions["figma-console-mcp"].variableId\`), then exact token path, then value fingerprint.

CONFLICT HANDLING: When BOTH Figma and code changed the same token since the last sync, \`onConflict: "ask"\` (default) surfaces the conflict and writes nothing. Use \`figma-wins\` / \`code-wins\` to auto-resolve, or \`skip\` to leave conflicts alone and proceed with the rest.

DRY-RUN: Default first call after detecting changes is dry-run for safety. The response includes the full diff plan; user confirms, then call again with \`dryRun: false\` (or \`strategy\` other than dry-run) to apply.`;

export interface RegisterTokensToolsOptions {
  /**
   * True when registering in Cloud Mode (Cloudflare Workers). In Cloud Mode
   * the MCP server has no local filesystem access, so the tools surface a
   * clear "inline payload required" error instead of letting an fs ENOENT
   * bubble up cryptically. Export still works with explicit content return;
   * import still works with inline payload/files. tokens.config.json
   * autodiscovery, outputPath disk writes, and config-source file reads
   * are all Local Mode only.
   */
  isRemoteMode?: boolean;
}

export function registerExportTokensTool(
  server: McpServer,
  getDesktopConnector: () => Promise<any>,
  opts: RegisterTokensToolsOptions = {},
): void {
  server.tool(
    "figma_export_tokens",
    EXPORT_TOOL_DESCRIPTION,
    ExportTokensInputSchema.shape,
    async (args) => {
      try {
        return await handleExport(args, getDesktopConnector, opts);
      } catch (err) {
        logger.error({ err }, "figma_export_tokens failed");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
                hint: "If this is a TokenFormatNotImplementedError for a non-DTCG/non-CSS format, export to 'dtcg' or 'css-vars' instead — those are the fully-implemented formats. The canonical DTCG JSON can be consumed by Style Dictionary v4 or any other DTCG-aware tooling.",
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
  opts: RegisterTokensToolsOptions = {},
): void {
  server.tool(
    "figma_import_tokens",
    IMPORT_TOOL_DESCRIPTION,
    ImportTokensInputSchema._def.schema.shape,
    async (args) => {
      try {
        return await handleImport(args, getDesktopConnector, opts);
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
  opts: RegisterTokensToolsOptions = {},
): void {
  registerExportTokensTool(server, getDesktopConnector, opts);
  registerImportTokensTool(server, getDesktopConnector, opts);
}

/**
 * Standardized error for fs-dependent paths called in Cloud Mode.
 */
function cloudModeFsError(operation: string): Error {
  return new Error(
    `[figma-console-mcp] ${operation} is a Local Mode operation — Cloud Mode (Cloudflare Workers) has no local filesystem access. ` +
      "Use one of these alternatives:\n" +
      "  • Export: omit `configPath` and `outputPath` — the tool will return token content inline in the response. Have your AI client write the files via its own Edit/Write tools.\n" +
      "  • Import: pass token data inline via the `payload` argument (single file) or `files` argument (multi-file). Omit `configPath`.\n" +
      "For full filesystem support (tokens.config.json autodiscovery, automatic writes to source/generated dirs), run the MCP in Local Mode via NPX.",
  );
}

// ============================================================================
// HANDLERS
// ============================================================================

async function handleExport(
  args: any,
  getDesktopConnector: () => Promise<any>,
  opts: RegisterTokensToolsOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  // Cloud Mode guard. Any filesystem operation needs to bail with a clear
  // message before the fs call actually throws something cryptic.
  if (opts.isRemoteMode) {
    if (args.configPath) {
      throw cloudModeFsError("`configPath` (tokens.config.json autodiscovery)");
    }
    if (args.outputPath) {
      throw cloudModeFsError("`outputPath` (writing token files to disk)");
    }
  }

  // 1. Load config (autodiscover or explicit). Skip entirely in Cloud Mode
  //    — tokens.config.json lookup requires a filesystem.
  const loaded = opts.isRemoteMode
    ? null
    : loadTokensConfig({ explicitPath: args.configPath });

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
    mcpVersion: MCP_VERSION,
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
          dtcgDialect: args.dtcgDialect ?? target.dtcgDialect,
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
  opts: RegisterTokensToolsOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  // Cloud Mode guard: filesystem operations are unavailable. Inline
  // `payload` / `files` arguments still work and are the supported path.
  if (opts.isRemoteMode) {
    if (args.configPath) {
      throw cloudModeFsError("`configPath` (tokens.config.json autodiscovery)");
    }
    if (!args.payload && !args.files) {
      throw cloudModeFsError(
        "Implicit source-dir reads (when neither `payload` nor `files` is provided)",
      );
    }
  }

  // 1. Load config + resolve where the source payload(s) live.
  const loaded = opts.isRemoteMode
    ? null
    : loadTokensConfig({ explicitPath: args.configPath });

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
    mcpVersion: MCP_VERSION,
  });

  // 6. Compute the diff plan.
  const diff = computeDiffPlan(figmaDoc, merged);

  const dryRun = args.dryRun === true || args.strategy === "dry-run";
  const strategy: "merge" | "replace" =
    args.strategy === "replace" ? "replace" : "merge";

  // 7. Apply phase: when not dry-run, mutate Figma via the plugin bridge in
  //    three ordered sub-phases. Order matters: creates run FIRST so that
  //    alias-target updates in the update phase can point at just-created
  //    variables; deletes run LAST (and only under strategy "replace").
  let applyResult: ApplyResult | null = null;
  let deleteWarning: string | undefined;
  if (!dryRun) {
    const acc: ApplyResult = {
      applied: 0,
      created: 0,
      createdCollections: 0,
      renamed: 0,
      deleted: 0,
      failed: 0,
      errors: [],
    };
    let anyPhaseRan = false;

    const collectionModeMap = buildCollectionModeMap(figmaPayload);
    const toCreateKeys = new Set(diff.toCreate.map((e) => e.path));
    // Mutable map the alias resolver closes over — populated by the create
    // phase so later alias resolutions see freshly-created variable IDs.
    const createdIdByKey = new Map<string, string>();
    const resolveAliasId = makeAliasIdResolver(
      figmaDoc,
      merged,
      toCreateKeys,
      createdIdByKey,
    );

    // 7a. CREATE phase — missing collections (with the token file's full
    //     mode list) and missing variables. Literal values are set at
    //     creation; alias values apply in a second in-script pass after ALL
    //     variables exist, so aliases among created variables resolve.
    if (diff.toCreate.length > 0) {
      const createPlan = buildCreatePlan(
        diff.toCreate,
        merged,
        figmaPayload,
        resolveAliasId,
        parseWarnings,
      );
      if (
        createPlan.newCollections.length > 0 ||
        createPlan.existingCollections.length > 0
      ) {
        anyPhaseRan = true;
        const createResult = await applyCreates(connector, createPlan);
        acc.created += createResult.created;
        acc.createdCollections += createResult.createdCollections;
        acc.failed += createResult.failed;
        acc.errors.push(...createResult.errors);
        for (const [key, id] of createResult.createdIdByKey) {
          createdIdByKey.set(key, id);
        }
      }
    }

    // 7b. UPDATE phase — value updates including alias-target updates
    //     (references resolved to { type: "VARIABLE_ALIAS", id }) AND
    //     renames (ID-matched tokens whose path moved: variable.name is set
    //     to the new '/'-joined path instead of create+delete).
    if (diff.toUpdate.length > 0 || diff.toRename.length > 0) {
      const renameEntries = diff.toRename.map((r) => ({
        path: r.from, // Figma-side lookup (old key)
        codePath: r.path, // code-side lookup (new key)
        newName: r.newName,
        before: undefined,
        after: undefined,
        changes: r.changes,
      }));
      const updates = buildUpdatePayloads(
        [...renameEntries, ...diff.toUpdate],
        figmaDoc,
        merged,
        collectionModeMap,
        parseWarnings,
        resolveAliasId,
      );
      if (updates.length > 0) {
        anyPhaseRan = true;
        const renameIds = new Set(
          updates.filter((u) => u.newName !== undefined).map((u) => u.variableId),
        );
        const updateResult = await applyUpdates(connector, updates);
        const renamedFailed = updateResult.errors.filter((e) =>
          renameIds.has(e.variableId),
        ).length;
        const renamedOk = renameIds.size - renamedFailed;
        acc.renamed += renamedOk;
        // `applied` counts successful non-rename update entries; a rename
        // entry (even one that also carried value changes) counts once,
        // under `renamed`.
        acc.applied += updateResult.applied - renamedOk;
        acc.failed += updateResult.failed;
        acc.errors.push(...updateResult.errors);
      }
    }

    // 7c. DELETE phase — STRICTLY gated behind strategy "replace". Merge
    //     (the default) never deletes; it only reports Figma-only tokens.
    if (strategy === "replace" && diff.toDelete.length > 0) {
      anyPhaseRan = true;
      const deleteResult = await applyDeletes(
        connector,
        diff.toDelete,
        figmaDoc,
      );
      acc.deleted += deleteResult.deleted;
      acc.failed += deleteResult.failed;
      acc.errors.push(...deleteResult.errors);
      if (deleteResult.deleted > 0) {
        deleteWarning = `⚠️ REPLACE STRATEGY: permanently deleted ${deleteResult.deleted} Figma variable(s) that were not present in the token file. Recover via Figma's version history / Edit > Undo if this was unintended.`;
        parseWarnings.push(deleteWarning);
      }
    }

    if (anyPhaseRan) applyResult = acc;
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
      toRename: diff.toRename.length,
      toDelete: diff.toDelete.length,
      unchanged: diff.unchanged,
    },
    samples: {
      toCreate: diff.toCreate.slice(0, SAMPLE_LIMIT).map((e) => ({
        path: e.path,
        type: e.type,
      })),
      toUpdate: diff.toUpdate.slice(0, SAMPLE_LIMIT),
      toRename: diff.toRename.slice(0, SAMPLE_LIMIT).map((e) => ({
        from: e.from,
        to: e.path,
        variableId: e.variableId,
      })),
      toDelete: diff.toDelete.slice(0, SAMPLE_LIMIT),
    },
    truncated: {
      toCreate: diff.toCreate.length > SAMPLE_LIMIT,
      toUpdate: diff.toUpdate.length > SAMPLE_LIMIT,
      toRename: diff.toRename.length > SAMPLE_LIMIT,
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
                ? [
                    applyResult.createdCollections > 0
                      ? `Created ${applyResult.createdCollections} collection(s).`
                      : null,
                    applyResult.created > 0
                      ? `Created ${applyResult.created} variable(s).`
                      : null,
                    applyResult.renamed > 0
                      ? `Renamed ${applyResult.renamed} variable(s).`
                      : null,
                    `Applied ${applyResult.applied} value update(s).`,
                    applyResult.deleted > 0
                      ? `Deleted ${applyResult.deleted} variable(s) (replace strategy).`
                      : null,
                    `${applyResult.failed} failed.`,
                  ]
                    .filter(Boolean)
                    .join(" ")
                : diff.toUpdate.length === 0 &&
                    diff.toCreate.length === 0 &&
                    diff.toRename.length === 0
                  ? "Nothing to apply — all tokens already in sync."
                  : "Changes were detected but skipped (likely all unresolvable aliases or non-writable TIMING/EASING types — see warnings).",
            deleteNote: deleteWarning
              ? deleteWarning
              : diff.toDelete.length > 0
                ? strategy === "replace" && dryRun
                  ? `${diff.toDelete.length} Figma-only token(s) would be PERMANENTLY DELETED on apply (replace strategy + dry-run).`
                  : strategy === "replace"
                    ? `${diff.toDelete.length} Figma-only token(s) targeted for deletion (replace strategy) — see applyResult for outcome.`
                    : `${diff.toDelete.length} Figma-only token(s) preserved (merge strategy). Use strategy: "replace" to delete them, or figma_delete_variable manually.`
                : undefined,
            inputFileCount: inputFiles.length,
            parsedSetCount: merged.sets.length,
            parsedTokenCount: merged.sets.reduce((n, s) => n + s.tokens.length, 0),
            diff: slimDiff,
            applyResult: applyResult
              ? {
                  applied: applyResult.applied,
                  created: applyResult.created,
                  createdCollections: applyResult.createdCollections,
                  renamed: applyResult.renamed,
                  deleted: applyResult.deleted,
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
  // Walk the source dir for *.tokens.json files. Currently a flat scan;
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
 * proposed state (right). Returns a structured diff plan; value-update
 * mutations are applied via the plugin bridge below.
 *
 * MATCH PRIORITY (as the tool description promises): Figma variable ID
 * first, then exact set::path. A code-side token whose path has no Figma
 * counterpart but whose $extensions["figma-console-mcp"].variableId matches
 * a live variable is a RENAME — routed to toRename (name change + any
 * value/meta changes), and its Figma-side counterpart is EXCLUDED from
 * toDelete. Without this, a path rename in the code file would create a
 * duplicate variable under merge, and under replace would permanently
 * delete the original (detaching all its bindings).
 *
 * Exported for test coverage of the dialect-normalized comparison
 * (round-trip exports in both DTCG dialects must diff as unchanged) and
 * rename classification.
 */
export function computeDiffPlan(
  figmaDoc: TokenDocument,
  codeDoc: TokenDocument,
): {
  toCreate: Array<{ path: string; type: string; value: unknown }>;
  toUpdate: Array<{
    path: string;
    before: unknown;
    after: unknown;
    /**
     * Present when variable metadata (scopes/codeSyntax) changed. Absent for
     * plain value-only updates (the historical entry shape). `values: false`
     * tells the apply phase to skip setValueForMode entirely and only write
     * the metadata.
     */
    changes?: { values: boolean; scopes: boolean; codeSyntax: boolean };
  }>;
  toRename: Array<{
    /** New (code-side) diff key. */
    path: string;
    /** Old (Figma-side) diff key the variableId matched. */
    from: string;
    variableId: string;
    /** New Figma variable name — the '/'-joined code-side token path. */
    newName: string;
    /** Value/meta changes to apply alongside the rename. */
    changes: { values: boolean; scopes: boolean; codeSyntax: boolean };
  }>;
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
  // ID-first index: live Figma variableId → its diff key + token.
  const figmaByVariableId = new Map<string, { key: string; token: any }>();
  for (const [key, token] of figmaTokens) {
    const id = token.extensions?.["figma-console-mcp"]?.variableId;
    if (typeof id === "string") figmaByVariableId.set(id, { key, token });
  }

  const toCreate: Array<{ path: string; type: string; value: unknown }> = [];
  const toUpdate: Array<{
    path: string;
    before: unknown;
    after: unknown;
    changes?: { values: boolean; scopes: boolean; codeSyntax: boolean };
  }> = [];
  const toRename: Array<{
    path: string;
    from: string;
    variableId: string;
    newName: string;
    changes: { values: boolean; scopes: boolean; codeSyntax: boolean };
  }> = [];
  // Figma-side keys consumed by a rename — excluded from toDelete.
  const renamedFigmaKeys = new Set<string>();
  const toDelete: Array<{ path: string }> = [];
  let unchanged = 0;

  for (const [key, codeToken] of codeTokens) {
    const figmaToken = figmaTokens.get(key);
    if (!figmaToken) {
      // No path match — try the ID-first match before classifying as a
      // create. Guards: the matched Figma path must not ALSO exist in the
      // code doc (then the ID was copy-pasted, not renamed), and each Figma
      // variable can be claimed by at most one rename.
      const extId = codeToken.extensions?.["figma-console-mcp"]?.variableId;
      const idMatch =
        typeof extId === "string" ? figmaByVariableId.get(extId) : undefined;
      if (
        idMatch &&
        !codeTokens.has(idMatch.key) &&
        !renamedFigmaKeys.has(idMatch.key)
      ) {
        renamedFigmaKeys.add(idMatch.key);
        const valuesChanged = !valuesEqual(
          idMatch.token.values,
          codeToken.values,
        );
        const meta = diffVariableMeta(idMatch.token, codeToken);
        toRename.push({
          path: key,
          from: idMatch.key,
          variableId: extId as string,
          newName: codeToken.path.join("/"),
          changes: {
            values: valuesChanged,
            scopes: meta.scopesChanged,
            codeSyntax: meta.codeSyntaxChanged,
          },
        });
        continue;
      }
      toCreate.push({
        path: key,
        type: codeToken.type,
        value: codeToken.values,
      });
      continue;
    }

    const valuesChanged = !valuesEqual(figmaToken.values, codeToken.values);
    const meta = diffVariableMeta(figmaToken, codeToken);

    if (valuesChanged || meta.scopesChanged || meta.codeSyntaxChanged) {
      if (valuesChanged && !meta.scopesChanged && !meta.codeSyntaxChanged) {
        // Value-only update — historical entry shape, no `changes` field, so
        // pre-existing consumers/tests see exactly what they always saw.
        toUpdate.push({
          path: key,
          // Figma-side values carry the transient rawColor floats — strip
          // them so diff samples in the tool response stay shaped as before.
          before: stripRawColorFromValues(figmaToken.values),
          after: codeToken.values,
        });
      } else {
        toUpdate.push({
          path: key,
          before: valuesChanged
            ? stripRawColorFromValues(figmaToken.values)
            : meta.before,
          after: valuesChanged ? codeToken.values : meta.after,
          changes: {
            values: valuesChanged,
            scopes: meta.scopesChanged,
            codeSyntax: meta.codeSyntaxChanged,
          },
        });
      }
    } else {
      unchanged++;
    }
  }

  for (const key of figmaTokens.keys()) {
    if (!codeTokens.has(key) && !renamedFigmaKeys.has(key)) {
      // Reports as "would delete if strategy=replace" but defaults to
      // preserve under merge strategy. Keys consumed by a rename are NOT
      // deletions — the variable lives on under its new name.
      toDelete.push({ path: key });
    }
  }

  return { toCreate, toUpdate, toRename, toDelete, unchanged };
}

/**
 * Structural equality for a token's mode-keyed values map. Order-independent
 * so two tokens that have the same modes with the same values produce a
 * match regardless of object insertion order.
 *
 * Recursive for composite values (typography, shadow) — those have nested
 * objects too. Aliases are equal when both have the same `reference` string;
 * literals are equal by deep value comparison.
 *
 * Each side is canonicalized to a dialect-agnostic form before comparing
 * (see canonicalizeTokenValueForComparison): a DTCG 2025.10 color object
 * equals the same color's legacy hex string (both quantized to 1/255 per
 * channel), `{ value: 16, unit: "px" }` equals bare 16, and the transient
 * rawColor field is ignored. Without this, importing a 2025-dialect file
 * would report EVERY color as toUpdate on EVERY import, forever.
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
    if (
      !deepEqual(
        canonicalizeTokenValueForComparison(a[aKeys[i]]),
        canonicalizeTokenValueForComparison(b[bKeys[i]]),
      )
    ) {
      return false;
    }
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

/**
 * Compare variable metadata (scopes + codeSyntax) between the Figma-side and
 * code-side tokens.
 *
 * Semantics (deliberately merge-friendly):
 *   - Code-side ABSENT field = "no opinion" — never a change, so token files
 *     that predate this feature (or hand-authored files without extensions)
 *     can't silently reset Figma-side scopes/codeSyntax.
 *   - Scopes compare order-insensitively; []/["ALL_SCOPES"]/absent all
 *     normalize to the default (export omits the default, so a round-trip of
 *     an ALL_SCOPES variable is absent on both sides → unchanged).
 *   - codeSyntax compares by deep equality ({} counts as an explicit "clear
 *     every platform" opinion; absent counts as no opinion).
 */
function diffVariableMeta(
  figmaToken: any,
  codeToken: any,
): {
  scopesChanged: boolean;
  codeSyntaxChanged: boolean;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
} {
  const figmaExt = figmaToken.extensions?.["figma-console-mcp"] ?? {};
  const codeExt = codeToken.extensions?.["figma-console-mcp"] ?? {};

  let scopesChanged = false;
  if (Array.isArray(codeExt.scopes)) {
    const codeScopes = normalizeScopesForComparison(codeExt.scopes);
    const figmaScopes = normalizeScopesForComparison(figmaExt.scopes);
    scopesChanged = !deepEqual(codeScopes, figmaScopes);
  }

  let codeSyntaxChanged = false;
  if (
    codeExt.codeSyntax !== undefined &&
    codeExt.codeSyntax !== null &&
    typeof codeExt.codeSyntax === "object" &&
    !Array.isArray(codeExt.codeSyntax)
  ) {
    codeSyntaxChanged = !deepEqual(codeExt.codeSyntax, figmaExt.codeSyntax ?? {});
  }

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  if (scopesChanged) {
    before.scopes = figmaExt.scopes ?? ["ALL_SCOPES"];
    after.scopes = codeExt.scopes;
  }
  if (codeSyntaxChanged) {
    before.codeSyntax = figmaExt.codeSyntax ?? {};
    after.codeSyntax = codeExt.codeSyntax;
  }
  return { scopesChanged, codeSyntaxChanged, before, after };
}

/**
 * Normalize a scopes array to a sorted, default-collapsed form: absent,
 * empty, and ["ALL_SCOPES"] all mean "the default scoping" in Figma.
 */
function normalizeScopesForComparison(scopes: unknown): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) return ["ALL_SCOPES"];
  const cleaned = scopes.filter((s): s is string => typeof s === "string");
  if (cleaned.length === 0) return ["ALL_SCOPES"];
  if (cleaned.length === 1 && cleaned[0] === "ALL_SCOPES") return ["ALL_SCOPES"];
  return [...cleaned].sort();
}

// ============================================================================
// APPLY PHASE — push code-side changes back to Figma via the plugin
// ============================================================================

/**
 * Aggregate result of the apply phase (create + update + delete sub-phases).
 * Returned in the tool response so the AI can report what actually happened
 * to the user. Per-item failures accumulate in errors[] without failing the
 * batch (partial-success semantics).
 */
interface ApplyResult {
  /** Value updates applied (toUpdate). */
  applied: number;
  /** Variables created (toCreate). */
  created: number;
  /** Collections created (sets with no matching Figma collection). */
  createdCollections: number;
  /** Variables renamed (ID-matched path moves; may include value changes). */
  renamed: number;
  /** Variables deleted (toDelete, strategy "replace" only). */
  deleted: number;
  failed: number;
  errors: Array<{ variableId: string; error: string }>;
}

/**
 * How an alias reference resolves for the apply phase:
 *   - { id }      → an existing (or already-created) Figma variable ID
 *   - { pending } → the target is itself in this import's toCreate batch;
 *                   the create script resolves it in its second pass via the
 *                   returned key
 *   - null        → unresolvable; caller skips with a warning
 */
type AliasIdResolution = { id: string } | { pending: string } | null;

/**
 * Build a resolver that maps a DTCG alias reference (set-qualified
 * `{theme.color.primary}`, bare `{color.primary}` when unambiguous, or the
 * converter's `{__library:VariableID:...}` cross-library form) to a Figma
 * variable ID.
 *
 * Resolution priority for a matched code-side token:
 *   1. a variable created earlier in THIS apply run (createdIdByKey — the
 *      resolver closes over the mutable map, so the create phase's results
 *      are visible to the later update phase)
 *   2. the live Figma snapshot's variable ID for the same set::path
 *   3. "pending" when the target is queued in this run's toCreate batch
 *   4. the token's own $extensions variableId (stale-but-recorded fallback)
 * References that don't match a code-side token fall back to the live Figma
 * snapshot lookup. Exported for test coverage.
 */
export function makeAliasIdResolver(
  figmaDoc: TokenDocument,
  codeDoc: TokenDocument,
  toCreateKeys: Set<string>,
  createdIdByKey: Map<string, string>,
): (reference: string) => AliasIdResolution {
  const codeLookup = buildTokenLookup(codeDoc);
  const figmaLookup = buildTokenLookup(figmaDoc);
  // "SetName::dot.path" → live Figma variable ID.
  const figmaIdByKey = new Map<string, string>();
  for (const set of figmaDoc.sets) {
    for (const t of set.tokens) {
      const id = t.extensions?.["figma-console-mcp"]?.variableId;
      if (typeof id === "string") {
        figmaIdByKey.set(`${set.name}::${t.path.join(".")}`, id);
      }
    }
  }

  return (reference: string): AliasIdResolution => {
    const bare = reference.replace(/^\{|\}$/g, "");
    // Cross-library references preserve the original Figma variable ID —
    // usable directly as an alias target.
    if (bare.startsWith("__library:")) {
      return { id: bare.slice("__library:".length) };
    }
    const codeEntry = codeLookup.get(bare);
    if (codeEntry) {
      const key = `${codeEntry.setName}::${codeEntry.token.path.join(".")}`;
      const createdId = createdIdByKey.get(key);
      if (createdId) return { id: createdId };
      const liveId = figmaIdByKey.get(key);
      if (liveId) return { id: liveId };
      if (toCreateKeys.has(key)) return { pending: key };
      const extId =
        codeEntry.token.extensions?.["figma-console-mcp"]?.variableId;
      if (typeof extId === "string") return { id: extId };
      return null;
    }
    // Not in the code document — the reference may point at a Figma-only
    // token (present in the live snapshot but absent from the import file).
    const figmaEntry = figmaLookup.get(bare);
    if (figmaEntry) {
      const id = figmaEntry.token.extensions?.["figma-console-mcp"]?.variableId;
      if (typeof id === "string") return { id };
    }
    return null;
  };
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
  /**
   * Rename op: set `variable.name` to this '/'-joined path before any value
   * writes. Produced by the ID-first rename classification in
   * computeDiffPlan — never combined with a create/delete of the same
   * variable.
   */
  newName?: string;
  /** Full replacement scopes array (`variable.scopes = [...]`). */
  scopes?: string[];
  /**
   * Per-platform code syntax ops: `set` maps platform → value
   * (setVariableCodeSyntax), `remove` lists platforms to clear
   * (removeVariableCodeSyntax).
   */
  codeSyntax?: { set?: Record<string, string>; remove?: string[] };
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
 *   - color hex string "#RRGGBB(AA)" → { r, g, b, a } floats in [0, 1].
 *     Non-hex color strings ("rgb(255,0,0)", "transparent", named colors
 *     like "salmon") return skip-invalid instead of throwing — a throw here
 *     would abort the import mid-apply.
 *   - DTCG 2025.10 color objects → { r, g, b, a }: srgb components map
 *     directly (clamped to [0, 1]); non-srgb colorSpaces (display-p3,
 *     oklch, …) fall back to the object's `hex` field when present, else
 *     skip-invalid; hex-only objects are accepted too
 *   - FLOAT-typed number → number ("16px"-style strings and DTCG
 *     { value, unit } objects are parsed to their numeric part; anything
 *     that still comes out NaN is skipped rather than pushed to Figma)
 *   - STRING-typed string → string
 *   - BOOLEAN → boolean
 *   - Alias references return `skip-alias` so the CALLER resolves them —
 *     both apply paths pass the reference through their alias-ID resolver
 *     (just-created variable → live snapshot → pending in batch → recorded
 *     $extensions ID) and write { type: "VARIABLE_ALIAS", id }. Only when
 *     the resolver comes up empty does the reference stay skipped, with a
 *     warning rather than a silent drop.
 *
 * Exported for test coverage of the value-conversion edge cases.
 */
export function tokenValueToFigma(
  value: { literal?: unknown; reference?: string },
  resolvedType: VariableUpdate["resolvedType"],
):
  | { kind: "value"; value: unknown }
  | { kind: "skip-alias"; reference: string }
  | { kind: "skip-empty" }
  | { kind: "skip-invalid"; reason: string } {
  if (value.reference) {
    // References aren't converted here — the caller resolves them to a
    // Figma variable ID via its alias-ID resolver and writes a real
    // { type: "VARIABLE_ALIAS", id } payload. Returning skip-alias hands
    // the reference back for that resolution; if the resolver can't find
    // a target, the caller surfaces a warning instead of silently wiping
    // the reference with a literal.
    return { kind: "skip-alias", reference: value.reference };
  }
  if (value.literal === undefined || value.literal === null) {
    return { kind: "skip-empty" };
  }

  let figmaValue: unknown;
  if (resolvedType === "COLOR" && typeof value.literal === "string") {
    // Guarded: hexToRgba throws on anything that isn't a hex color
    // ("rgb(255,0,0)", "transparent", "salmon", "oklch(...)"). A throw here
    // would abort the whole import AFTER the create phase already mutated
    // Figma — so malformed colors become a per-value skip instead.
    try {
      figmaValue = hexToRgba(value.literal);
    } catch (err) {
      return {
        kind: "skip-invalid",
        reason: `cannot convert ${JSON.stringify(value.literal)} to a Figma color (${
          err instanceof Error ? err.message : String(err)
        })`,
      };
    }
  } else if (
    resolvedType === "COLOR" &&
    typeof value.literal === "object" &&
    value.literal !== null &&
    !Array.isArray(value.literal)
  ) {
    // DTCG 2025.10 object-form color. Without this branch the object fell
    // through to String(literal) → "[object Object]" pushed at a COLOR
    // variable.
    const converted = colorObjectToFigmaRgba(
      value.literal as Record<string, unknown>,
    );
    if (converted.kind !== "value") return converted;
    figmaValue = converted.value;
  } else if (resolvedType === "FLOAT") {
    const parsed = parseNumericLiteral(value.literal);
    if (Number.isNaN(parsed)) {
      // Never push NaN into setValueForMode — skip with a reason instead.
      return {
        kind: "skip-invalid",
        reason: `cannot convert ${JSON.stringify(value.literal)} to a number for a FLOAT variable`,
      };
    }
    figmaValue = parsed;
  } else if (resolvedType === "BOOLEAN") {
    figmaValue = Boolean(value.literal);
  } else {
    figmaValue = typeof value.literal === "string" ? value.literal : String(value.literal);
  }
  return { kind: "value", value: figmaValue };
}

/**
 * Convert a DTCG 2025.10 color object literal to Figma's { r, g, b, a }
 * floats. Handles, in priority order:
 *   1. srgb (or unspecified) colorSpace + 3 numeric components → direct
 *      mapping, each channel clamped to [0, 1]; optional `alpha` (default 1)
 *   2. any object with a `hex` string field (covers non-srgb colorSpaces
 *      like display-p3/oklch that carry the hex interop fallback, and
 *      hex-only objects) → hexToRgba, with the `alpha` field taking
 *      precedence over hex-embedded alpha when present
 *   3. non-srgb colorSpace without a hex fallback → skip-invalid (we can't
 *      do color-space conversion, and guessing would corrupt the variable)
 */
function colorObjectToFigmaRgba(
  obj: Record<string, unknown>,
):
  | { kind: "value"; value: { r: number; g: number; b: number; a: number } }
  | { kind: "skip-invalid"; reason: string } {
  const colorSpace =
    typeof obj.colorSpace === "string" ? obj.colorSpace : undefined;
  const comps = obj.components;
  if (
    (colorSpace === undefined || colorSpace === "srgb") &&
    Array.isArray(comps) &&
    comps.length === 3 &&
    comps.every((c) => typeof c === "number")
  ) {
    const [r, g, b] = (comps as number[]).map(clamp01);
    const a = typeof obj.alpha === "number" ? clamp01(obj.alpha) : 1;
    return { kind: "value", value: { r, g, b, a } };
  }
  if (typeof obj.hex === "string") {
    try {
      const rgba = hexToRgba(obj.hex);
      if (typeof obj.alpha === "number") rgba.a = clamp01(obj.alpha);
      return { kind: "value", value: rgba };
    } catch {
      return {
        kind: "skip-invalid",
        reason: `color object has an unparseable hex field ${JSON.stringify(obj.hex)}`,
      };
    }
  }
  if (colorSpace !== undefined && colorSpace !== "srgb") {
    return {
      kind: "skip-invalid",
      reason: `unsupported colorSpace "${colorSpace}" without hex fallback`,
    };
  }
  return {
    kind: "skip-invalid",
    reason: `cannot convert ${JSON.stringify(obj)} to a Figma color — expected srgb components or a hex field`,
  };
}

/**
 * Parse a token literal into a number for FLOAT variables. Handles:
 *   - plain numbers → as-is
 *   - unit-bearing dimension strings ("16px", "1.5rem", "-4pt") → numeric part
 *   - DTCG dimension AND duration objects: { value: 16, unit: "px" } → 16,
 *     { value: 300, unit: "ms" } → 300, and { value: 0.3, unit: "s" } → 300
 *     — seconds MULTIPLY to milliseconds so the write path agrees with the
 *     diff canonicalization (canonicalizeTokenValueForComparison, which
 *     treats {0.3, "s"} ≡ {300, "ms"} ≡ 300). If the write path took the
 *     raw 0.3 instead, the diff would report a change, apply would write a
 *     1000x-wrong value, and every subsequent import would rewrite it
 *     forever. Other units (px/rem/…) keep the raw value — Figma FLOAT is
 *     unitless. True TIMING-typed variables are skipped before import ever
 *     reaches this path (Plugin API can't write them), so plain FLOAT is
 *     the only consumer here.
 * Anything unparseable returns NaN — callers must skip (never push NaN
 * into setValueForMode).
 */
function parseNumericLiteral(literal: unknown): number {
  if (typeof literal === "number") return literal;
  if (typeof literal === "string") {
    const match = literal
      .trim()
      .match(/^(-?(?:\d+\.?\d*|\.\d+))\s*(px|rem|em|pt|dp|ms|s|%)?$/i);
    if (match) return Number(match[1]);
    return Number(literal);
  }
  if (
    literal !== null &&
    typeof literal === "object" &&
    "value" in (literal as Record<string, unknown>)
  ) {
    const obj = literal as Record<string, unknown>;
    const inner = parseNumericLiteral(obj.value);
    // s → ms, matching the diff-side canonicalization (see doc above).
    if (obj.unit === "s") return inner * 1000;
    return inner;
  }
  return Number(literal);
}

/**
 * Parse a hex color string to Figma rgba floats. Validates through the
 * dialect module's colorLiteralToCanonicalHex (via hexToRawRgba) so ONLY
 * genuine 3/6/8-digit hex strings pass — the previous implementation
 * dispatched on string LENGTH alone, so named colors like "red" (3 chars)
 * or "salmon" (6 chars) produced NaN channels that reached setValueForMode.
 * A bare hex without the leading "#" is still tolerated (historical
 * behavior). Throws on anything else; tokenValueToFigma catches and turns
 * it into a skip-invalid.
 */
function hexToRgba(hex: string): {
  r: number;
  g: number;
  b: number;
  a: number;
} {
  const trimmed = hex.trim();
  const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  const rgba = hexToRawRgba(normalized);
  if (!rgba) {
    throw new Error(
      `[figma-console-mcp] Invalid hex color ${JSON.stringify(hex)} — expected #RGB, #RRGGBB, or #RRGGBBAA.`,
    );
  }
  return rgba;
}

/**
 * Walk the toUpdate diff entries and translate each into a VariableUpdate.
 * Tokens that lack a Figma variable ID (never been synced) or have no
 * resolvable value for any mode get skipped with a warning.
 */
function buildUpdatePayloads(
  toUpdate: Array<{
    /** Figma-side diff key (where the live variable is today). */
    path: string;
    /**
     * Code-side diff key when it differs from `path` — set for RENAME
     * entries, where the code token lives at the NEW path while the Figma
     * variable is still indexed under the old one.
     */
    codePath?: string;
    /** Rename op: new '/'-joined variable name. */
    newName?: string;
    before: unknown;
    after: unknown;
    changes?: { values: boolean; scopes: boolean; codeSyntax: boolean };
  }>,
  figmaDoc: TokenDocument,
  codeDoc: TokenDocument,
  collectionModeMap: Map<string, Map<string, string>>,
  warnings: string[],
  resolveAliasId?: (reference: string) => AliasIdResolution,
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
    // Rename entries look up the code token at its NEW path (codePath) and
    // the Figma variable at its OLD path (path).
    const codeMatch = codeLookup.get(entry.codePath ?? entry.path);
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

    // Map our token type → Figma resolvedType. Prefer the actual
    // Figma-native type recorded at export time
    // (extensions.figmaResolvedType) — critical so FLOAT variables whose
    // token type was name-inferred as "duration" keep writing as FLOAT,
    // while true TIMING/EASING variables are recognized. Fall back to
    // inferring from the DTCG type when the extension is absent.
    const recordedType =
      figmaToken.extensions?.["figma-console-mcp"]?.figmaResolvedType;
    const figmaNativeType: string =
      typeof recordedType === "string"
        ? recordedType
        : inferFigmaResolvedType(figmaToken.type);

    if (figmaNativeType === "TIMING" || figmaNativeType === "EASING") {
      // The Figma Plugin API cannot create or setValueForMode on
      // TIMING/EASING variables — only BOOLEAN/COLOR/FLOAT/STRING are
      // writable. Sending these would be rejected (or worse); skip loudly.
      warnings.push(
        `Skipped ${entry.path} — Figma Plugin API cannot write ${
          figmaNativeType === "TIMING" ? "Timing" : "Easing"
        } variables (only BOOLEAN/COLOR/FLOAT/STRING are writable). Update this variable in the Figma UI instead.`,
      );
      continue;
    }
    const resolvedType = figmaNativeType as VariableUpdate["resolvedType"];

    // Value updates apply unless the diff explicitly flagged this entry as
    // metadata-only (changes.values === false) — re-pushing unchanged values
    // would be wasteful and could trip alias-resolution warnings.
    const wantValues = !entry.changes || entry.changes.values;

    const valuesByMode: Record<string, unknown> = {};
    const valueEntries = wantValues
      ? Object.entries(codeMatch.token.values)
      : [];
    for (const [modeName, value] of valueEntries) {
      const modeId = modeMap.get(modeName);
      if (!modeId) {
        warnings.push(
          `Cannot update ${entry.path} (mode "${modeName}") — modeId not found in Figma collection.`,
        );
        continue;
      }
      const conversion = tokenValueToFigma(value as any, resolvedType);
      if (conversion.kind === "skip-alias") {
        // Alias-target update: resolve the reference to a Figma variable ID
        // and write it as a native variable alias. Creates run before
        // updates, so references to just-created variables resolve too.
        const resolved = resolveAliasId?.(conversion.reference);
        if (resolved && "id" in resolved) {
          valuesByMode[modeId] = { type: "VARIABLE_ALIAS", id: resolved.id };
          continue;
        }
        warnings.push(
          `Skipped ${entry.path} (mode "${modeName}") — alias reference "${conversion.reference}" could not be resolved to an existing or newly-created Figma variable. Fix the reference, or edit the alias target's value instead.`,
        );
        continue;
      }
      if (conversion.kind === "skip-invalid") {
        warnings.push(
          `Skipped ${entry.path} (mode "${modeName}") — ${conversion.reason}.`,
        );
        continue;
      }
      if (conversion.kind === "skip-empty") continue;
      valuesByMode[modeId] = conversion.value;
    }

    // Metadata ops (scopes / codeSyntax) — flagged by the diff phase.
    let scopes: string[] | undefined;
    if (entry.changes?.scopes) {
      const codeScopes =
        codeMatch.token.extensions?.["figma-console-mcp"]?.scopes;
      if (Array.isArray(codeScopes) && codeScopes.length > 0) {
        scopes = codeScopes;
      } else {
        // Explicit empty/["ALL_SCOPES"] normalizes to the Figma default.
        scopes = ["ALL_SCOPES"];
      }
    }

    let codeSyntaxOps: VariableUpdate["codeSyntax"];
    if (entry.changes?.codeSyntax) {
      const codeCS: Record<string, string> =
        codeMatch.token.extensions?.["figma-console-mcp"]?.codeSyntax ?? {};
      const figmaCS: Record<string, string> =
        figmaToken.extensions?.["figma-console-mcp"]?.codeSyntax ?? {};
      const toSet: Record<string, string> = {};
      for (const [platform, value] of Object.entries(codeCS)) {
        if (typeof value === "string" && figmaCS[platform] !== value) {
          toSet[platform] = value;
        }
      }
      const toRemove = Object.keys(figmaCS).filter((p) => !(p in codeCS));
      if (Object.keys(toSet).length > 0 || toRemove.length > 0) {
        codeSyntaxOps = {
          ...(Object.keys(toSet).length > 0 ? { set: toSet } : {}),
          ...(toRemove.length > 0 ? { remove: toRemove } : {}),
        };
      }
    }

    if (
      Object.keys(valuesByMode).length === 0 &&
      scopes === undefined &&
      codeSyntaxOps === undefined &&
      entry.newName === undefined
    ) {
      continue;
    }

    updates.push({
      variableId,
      variableName: figmaToken.path.join("/"),
      resolvedType,
      valuesByMode,
      ...(entry.newName !== undefined ? { newName: entry.newName } : {}),
      ...(scopes !== undefined ? { scopes } : {}),
      ...(codeSyntaxOps !== undefined ? { codeSyntax: codeSyntaxOps } : {}),
    });
  }

  return updates;
}

/**
 * Map our internal TokenType to Figma's variable resolvedType.
 *
 * duration/cubicBezier map to the Config-2026 TIMING/EASING variable types
 * — but note the Figma Plugin API CANNOT create or setValueForMode on
 * TIMING/EASING variables (only BOOLEAN/COLOR/FLOAT/STRING are writable),
 * so callers must skip those with a warning instead of pushing them.
 * buildUpdatePayloads prefers the extension-recorded figmaResolvedType over
 * this inference, so FLOAT variables whose token type was name-inferred as
 * "duration" still write correctly as FLOAT.
 */
function inferFigmaResolvedType(
  type: string,
): VariableUpdate["resolvedType"] | "TIMING" | "EASING" {
  if (type === "color") return "COLOR";
  if (type === "boolean") return "BOOLEAN";
  if (type === "string" || type === "fontFamily") return "STRING";
  if (type === "duration") return "TIMING";
  if (type === "cubicBezier") return "EASING";
  return "FLOAT"; // dimension, number, fontWeight, etc.
}

/**
 * Push variable updates to Figma via executeCodeViaUI. The plugin runs the
 * inline script in its sandbox, calling figma.variables.setValueForMode for
 * each (variableId, modeId, value) tuple.
 */
async function applyUpdates(
  connector: any,
  updates: VariableUpdate[],
): Promise<Pick<ApplyResult, "applied" | "failed" | "errors">> {
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
        // Rename FIRST — a rename entry may carry no value writes at all.
        if (u.newName) {
          variable.name = u.newName;
        }
        let appliedModes = 0;
        for (const modeId in u.valuesByMode) {
          variable.setValueForMode(modeId, u.valuesByMode[modeId]);
          appliedModes++;
        }
        // Metadata writes — scopes replace wholesale; codeSyntax applies
        // per-platform sets then removals (removeVariableCodeSyntax is the
        // Plugin API's deletion primitive).
        if (u.scopes) {
          variable.scopes = u.scopes;
        }
        if (u.codeSyntax) {
          if (u.codeSyntax.set) {
            for (const platform in u.codeSyntax.set) {
              variable.setVariableCodeSyntax(platform, u.codeSyntax.set[platform]);
            }
          }
          if (u.codeSyntax.remove) {
            for (const platform of u.codeSyntax.remove) {
              variable.removeVariableCodeSyntax(platform);
            }
          }
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

// ============================================================================
// CREATE PHASE — create missing collections + variables via the plugin
// ============================================================================

/**
 * One value to set on a variable at creation time. New-collection variables
 * carry `modeName` (the script resolves the modeId from the collection it
 * just created); existing-collection variables carry `modeId` (resolved
 * server-side from the live snapshot). Alias values come in two flavors:
 * `alias` (target already exists in Figma) and `alias-pending` (target is
 * created in this same batch; the script resolves `targetKey` against its
 * created-ID map in the second pass).
 */
type CreateValueEntry = {
  modeName?: string;
  modeId?: string;
} & (
  | { kind: "literal"; value: unknown }
  | { kind: "alias"; targetId: string }
  | { kind: "alias-pending"; targetKey: string }
);

interface CreateVariableDef {
  /** Diff key ("SetName::dot.path") — primary key for created-ID mapping. */
  key: string;
  /** Figma variable name (slash-joined token path). */
  name: string;
  resolvedType: VariableUpdate["resolvedType"];
  description?: string;
  values: CreateValueEntry[];
  /** Non-default scopes to apply at creation (from token $extensions). */
  scopes?: string[];
  /** Per-platform code syntax to apply at creation (from token $extensions). */
  codeSyntax?: Record<string, string>;
}

/**
 * The create-phase plan: which collections to create (with the token file's
 * full mode list) and which variables to create where. Built entirely
 * server-side so the plugin script stays a dumb executor.
 */
export interface CreatePlan {
  newCollections: Array<{
    setName: string;
    modes: string[];
    variables: CreateVariableDef[];
  }>;
  existingCollections: Array<{
    collectionId: string;
    variables: CreateVariableDef[];
  }>;
}

const WRITABLE_RESOLVED_TYPES = new Set(["COLOR", "FLOAT", "STRING", "BOOLEAN"]);

/**
 * Translate the diff's toCreate entries into a CreatePlan.
 *
 *   - Sets with no matching Figma collection (matched by the round-trip
 *     figmaCollectionId first, then by name) become newCollections carrying
 *     the set's FULL mode list.
 *   - Variables missing from an existing collection go to that collection,
 *     with values pre-resolved to modeIds; values for modes the collection
 *     doesn't have are skipped with a warning.
 *   - resolvedType honors $extensions.figmaResolvedType when recorded, else
 *     falls back to inferFigmaResolvedType. TIMING/EASING variables are
 *     skipped with a warning — the Figma Plugin API cannot create them.
 *   - Literal values convert via tokenValueToFigma (both DTCG dialects);
 *     alias values resolve via the alias-ID resolver (existing target →
 *     "alias", within-batch target → "alias-pending", unresolvable → skip
 *     with warning).
 *
 * Exported for test coverage.
 */
export function buildCreatePlan(
  toCreate: Array<{ path: string }>,
  codeDoc: TokenDocument,
  figmaPayload: { collections: any[]; variables: any[] },
  resolveAliasId: (reference: string) => AliasIdResolution,
  warnings: string[],
): CreatePlan {
  // Code-side lookup: "SetName::dot.path" → { set, token }.
  const codeByKey = new Map<string, { set: any; token: any }>();
  for (const set of codeDoc.sets) {
    for (const token of set.tokens) {
      codeByKey.set(`${set.name}::${token.path.join(".")}`, { set, token });
    }
  }

  // Figma collection lookup by ID and by name.
  const collectionById = new Map<string, any>();
  const collectionByName = new Map<string, any>();
  for (const c of figmaPayload.collections) {
    collectionById.set(c.id, c);
    collectionByName.set(c.name, c);
  }

  const newBySet = new Map<
    string,
    { setName: string; modes: string[]; variables: CreateVariableDef[] }
  >();
  const existingById = new Map<
    string,
    { collectionId: string; variables: CreateVariableDef[] }
  >();

  for (const entry of toCreate) {
    const match = codeByKey.get(entry.path);
    if (!match) continue; // Defensive — toCreate keys come from codeDoc.
    const { set, token } = match;

    // Which Figma collection does this set map to? Round-trip collection ID
    // wins; name match second; otherwise the set needs a new collection.
    const existingCollection =
      (set.meta?.figmaCollectionId
        ? collectionById.get(set.meta.figmaCollectionId)
        : undefined) ?? collectionByName.get(set.name);

    // Resolve the Figma-native type, honoring the recorded resolvedType.
    const recorded =
      token.extensions?.["figma-console-mcp"]?.figmaResolvedType;
    const figmaNativeType: string =
      typeof recorded === "string" &&
      ["COLOR", "FLOAT", "STRING", "BOOLEAN", "TIMING", "EASING"].includes(
        recorded,
      )
        ? recorded
        : inferFigmaResolvedType(token.type);
    if (!WRITABLE_RESOLVED_TYPES.has(figmaNativeType)) {
      warnings.push(
        `Skipped create for ${entry.path} — Figma Plugin API cannot create ${
          figmaNativeType === "TIMING" ? "Timing" : "Easing"
        } variables (only BOOLEAN/COLOR/FLOAT/STRING are creatable). Create this variable in the Figma UI instead.`,
      );
      continue;
    }
    const resolvedType = figmaNativeType as VariableUpdate["resolvedType"];

    // Mode-name → modeId map for existing collections.
    const modeIdByName = new Map<string, string>();
    if (existingCollection) {
      for (const m of existingCollection.modes ?? []) {
        modeIdByName.set(m.name, m.modeId);
      }
    }

    const values: CreateValueEntry[] = [];
    for (const [modeName, value] of Object.entries(
      token.values as Record<string, any>,
    )) {
      let modeKeying: { modeName?: string; modeId?: string };
      if (existingCollection) {
        const modeId = modeIdByName.get(modeName);
        if (!modeId) {
          warnings.push(
            `Cannot set ${entry.path} (mode "${modeName}") — mode not found in existing Figma collection "${set.name}". Add the mode in Figma first (figma_add_mode).`,
          );
          continue;
        }
        modeKeying = { modeId };
      } else {
        modeKeying = { modeName };
      }

      if (value?.reference) {
        const resolved = resolveAliasId(value.reference);
        if (!resolved) {
          warnings.push(
            `Skipped ${entry.path} (mode "${modeName}") — alias reference "${value.reference}" could not be resolved to an existing or newly-created Figma variable.`,
          );
          continue;
        }
        if ("id" in resolved) {
          values.push({ ...modeKeying, kind: "alias", targetId: resolved.id });
        } else {
          values.push({
            ...modeKeying,
            kind: "alias-pending",
            targetKey: resolved.pending,
          });
        }
        continue;
      }

      const conversion = tokenValueToFigma(value, resolvedType);
      if (conversion.kind === "skip-invalid") {
        warnings.push(
          `Skipped ${entry.path} (mode "${modeName}") — ${conversion.reason}.`,
        );
        continue;
      }
      if (conversion.kind !== "value") continue; // skip-empty / skip-alias (handled above)
      values.push({ ...modeKeying, kind: "literal", value: conversion.value });
    }

    // Stashed variable metadata rides along to creation. Scopes: only
    // meaningful (non-default) arrays; codeSyntax: only non-empty maps.
    const ext = token.extensions?.["figma-console-mcp"] ?? {};
    const createScopes =
      Array.isArray(ext.scopes) &&
      ext.scopes.length > 0 &&
      !(ext.scopes.length === 1 && ext.scopes[0] === "ALL_SCOPES")
        ? ext.scopes.filter((s: unknown): s is string => typeof s === "string")
        : undefined;
    const createCodeSyntax =
      ext.codeSyntax &&
      typeof ext.codeSyntax === "object" &&
      !Array.isArray(ext.codeSyntax) &&
      Object.keys(ext.codeSyntax).length > 0
        ? (ext.codeSyntax as Record<string, string>)
        : undefined;

    const def: CreateVariableDef = {
      key: entry.path,
      name: token.path.join("/"),
      resolvedType,
      ...(token.description ? { description: token.description } : {}),
      values,
      ...(createScopes && createScopes.length > 0
        ? { scopes: createScopes }
        : {}),
      ...(createCodeSyntax ? { codeSyntax: createCodeSyntax } : {}),
    };

    if (existingCollection) {
      let bucket = existingById.get(existingCollection.id);
      if (!bucket) {
        bucket = { collectionId: existingCollection.id, variables: [] };
        existingById.set(existingCollection.id, bucket);
      }
      bucket.variables.push(def);
    } else {
      let bucket = newBySet.get(set.name);
      if (!bucket) {
        bucket = {
          setName: set.name,
          modes: set.modes?.length ? [...set.modes] : ["Default"],
          variables: [],
        };
        newBySet.set(set.name, bucket);
      }
      bucket.variables.push(def);
    }
  }

  return {
    newCollections: [...newBySet.values()],
    existingCollections: [...existingById.values()],
  };
}

/**
 * Execute a CreatePlan via the plugin bridge in ONE batched script (same
 * executeCodeViaUI transport the update phase and figma_setup_design_tokens
 * use — see write-tools.ts for the precedent):
 *
 *   Pass 0 — create missing collections; rename the auto-created default
 *            mode to the set's first mode, addMode() for the rest.
 *   Pass 1 — create every variable and set its LITERAL values.
 *   Pass 2 — set alias values, after all variables exist, so aliases among
 *            just-created variables resolve via the in-script created-ID map.
 *
 * Per-item failures are collected and surfaced without failing the batch.
 */
async function applyCreates(
  connector: any,
  plan: CreatePlan,
): Promise<{
  created: number;
  createdCollections: number;
  failed: number;
  errors: Array<{ variableId: string; error: string }>;
  createdIdByKey: Map<string, string>;
}> {
  const payload = JSON.stringify(plan);
  const totalVars =
    plan.newCollections.reduce((n, c) => n + c.variables.length, 0) +
    plan.existingCollections.reduce((n, c) => n + c.variables.length, 0);
  const timeout = Math.min(
    60000,
    Math.max(15000, totalVars * 200 + plan.newCollections.length * 500),
  );

  const script = `
    const plan = ${payload};
    const results = [];
    const aliasFailures = [];
    const createdIds = {};
    const createdCollections = [];
    const pendingAliases = [];

    function createVariableWithValues(def, collection, modeMap) {
      try {
        const variable = figma.variables.createVariable(def.name, collection, def.resolvedType);
        if (def.description) variable.description = def.description;
        createdIds[def.key] = variable.id;
        let appliedModes = 0;
        const valueErrors = [];
        // Variable metadata (scopes / per-platform code syntax) — failures
        // are per-item value errors, never batch failures.
        if (def.scopes) {
          try { variable.scopes = def.scopes; }
          catch (err) { valueErrors.push('scopes: ' + String(err && err.message || err)); }
        }
        if (def.codeSyntax) {
          for (const platform in def.codeSyntax) {
            try { variable.setVariableCodeSyntax(platform, def.codeSyntax[platform]); }
            catch (err) { valueErrors.push('codeSyntax ' + platform + ': ' + String(err && err.message || err)); }
          }
        }
        for (const val of def.values) {
          const modeId = val.modeId || (modeMap ? modeMap[val.modeName] : null);
          if (!modeId) { valueErrors.push('unknown mode: ' + (val.modeName || val.modeId)); continue; }
          if (val.kind === 'literal') {
            try { variable.setValueForMode(modeId, val.value); appliedModes++; }
            catch (err) { valueErrors.push('mode ' + modeId + ': ' + String(err && err.message || err)); }
          } else {
            // Alias values apply in pass 2, after ALL variables exist.
            pendingAliases.push({ variable: variable, key: def.key, modeId: modeId, targetId: val.targetId || null, targetKey: val.targetKey || null });
          }
        }
        results.push({ key: def.key, name: def.name, id: variable.id, success: true, appliedModes: appliedModes, valueErrors: valueErrors });
      } catch (err) {
        results.push({ key: def.key, name: def.name, success: false, error: String(err && err.message || err) });
      }
    }

    // Pass 0 + 1a — new collections (full mode list), then their variables.
    for (const nc of plan.newCollections) {
      let collection;
      const modeMap = {};
      try {
        collection = figma.variables.createVariableCollection(nc.setName);
        const defaultModeId = collection.modes[0].modeId;
        collection.renameMode(defaultModeId, nc.modes[0]);
        modeMap[nc.modes[0]] = defaultModeId;
        for (let i = 1; i < nc.modes.length; i++) {
          modeMap[nc.modes[i]] = collection.addMode(nc.modes[i]);
        }
        createdCollections.push({ name: nc.setName, id: collection.id });
      } catch (err) {
        // Roll back the orphaned collection if creation succeeded but mode
        // setup (renameMode/addMode) threw — otherwise a half-configured
        // empty collection is left behind in the file.
        let rolledBack = false;
        if (collection) {
          try { collection.remove(); rolledBack = true; } catch (removeErr) {}
        }
        const suffix = rolledBack ? ' (partially-created collection rolled back)' : '';
        for (const def of nc.variables) {
          results.push({ key: def.key, name: def.name, success: false, error: 'collection "' + nc.setName + '" creation failed' + suffix + ': ' + String(err && err.message || err) });
        }
        continue;
      }
      for (const def of nc.variables) createVariableWithValues(def, collection, modeMap);
    }

    // Pass 1b — variables missing from EXISTING collections.
    for (const group of plan.existingCollections) {
      const collection = await figma.variables.getVariableCollectionByIdAsync(group.collectionId);
      if (!collection) {
        for (const def of group.variables) {
          results.push({ key: def.key, name: def.name, success: false, error: 'collection not found: ' + group.collectionId });
        }
        continue;
      }
      for (const def of group.variables) createVariableWithValues(def, collection, null);
    }

    // Pass 2 — alias values. Targets are either pre-resolved IDs or keys of
    // variables created above (createdIds).
    for (const pa of pendingAliases) {
      try {
        const targetId = pa.targetId || (pa.targetKey ? createdIds[pa.targetKey] : null);
        if (!targetId) {
          aliasFailures.push({ key: pa.key, error: 'alias target was not created: ' + (pa.targetKey || 'unknown') });
          continue;
        }
        pa.variable.setValueForMode(pa.modeId, { type: 'VARIABLE_ALIAS', id: targetId });
      } catch (err) {
        aliasFailures.push({ key: pa.key, error: 'alias: ' + String(err && err.message || err) });
      }
    }

    return {
      createdCollections: createdCollections,
      created: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results: results,
      aliasFailures: aliasFailures,
      createdIds: createdIds,
    };
  `;

  const execResult = await connector.executeCodeViaUI(script, timeout);

  if (!execResult?.success) {
    return {
      created: 0,
      createdCollections: 0,
      failed: totalVars,
      errors: [
        {
          variableId: "<create-batch>",
          error:
            execResult?.error ??
            "Plugin executeCodeViaUI returned an error or timed out.",
        },
      ],
      createdIdByKey: new Map(),
    };
  }

  const inner = execResult.result ?? execResult;
  const errors: Array<{ variableId: string; error: string }> = [];
  const results: any[] = inner.results ?? [];
  const aliasFailures: any[] = inner.aliasFailures ?? [];
  for (const r of results) {
    if (!r.success) errors.push({ variableId: r.key, error: r.error });
  }
  for (const f of aliasFailures) {
    errors.push({ variableId: f.key, error: f.error });
  }

  // Count each variable exactly ONCE: a variable that was created but whose
  // alias pass failed counts as failed, not as created+failed (the previous
  // arithmetic double-counted it across both buckets). Alias failures can
  // repeat per mode — dedupe by variable key.
  const aliasFailedKeys = new Set(aliasFailures.map((f) => f.key));
  const createFailed = results.filter((r) => !r.success).length;
  const createdOk = results.filter(
    (r) => r.success && !aliasFailedKeys.has(r.key),
  ).length;

  return {
    created: createdOk,
    createdCollections: (inner.createdCollections ?? []).length,
    failed: createFailed + aliasFailedKeys.size,
    errors,
    // Alias-failed variables DO exist — keep their IDs resolvable for the
    // later update phase.
    createdIdByKey: new Map(Object.entries(inner.createdIds ?? {})),
  };
}

// ============================================================================
// DELETE PHASE — strategy "replace" only
// ============================================================================

/**
 * Delete Figma variables that are absent from the token file. STRICTLY
 * gated by the caller behind strategy "replace" — merge never reaches this.
 * Uses the connector's DELETE_VARIABLE bridge command (the same one behind
 * figma_delete_variable), one call per variable, with per-item error
 * isolation.
 */
async function applyDeletes(
  connector: any,
  toDelete: Array<{ path: string }>,
  figmaDoc: TokenDocument,
): Promise<{
  deleted: number;
  failed: number;
  errors: Array<{ variableId: string; error: string }>;
}> {
  // Diff key → live Figma variable ID.
  const figmaIdByKey = new Map<string, string>();
  for (const set of figmaDoc.sets) {
    for (const t of set.tokens) {
      const id = t.extensions?.["figma-console-mcp"]?.variableId;
      if (typeof id === "string") {
        figmaIdByKey.set(`${set.name}::${t.path.join(".")}`, id);
      }
    }
  }

  let deleted = 0;
  let failed = 0;
  const errors: Array<{ variableId: string; error: string }> = [];

  for (const entry of toDelete) {
    const variableId = figmaIdByKey.get(entry.path);
    if (!variableId) {
      failed++;
      errors.push({
        variableId: entry.path,
        error: "no Figma variable ID recorded for this token — cannot delete",
      });
      continue;
    }
    try {
      const result = await connector.deleteVariable(variableId);
      if (result && result.success === false) {
        throw new Error(result.error ?? "delete failed");
      }
      deleted++;
    } catch (err) {
      failed++;
      errors.push({
        variableId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { deleted, failed, errors };
}
