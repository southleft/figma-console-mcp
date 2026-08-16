/**
 * Design System Extraction tools (figma_ds_*).
 *
 * Local mode only — these tools read and write the local filesystem (scan a
 * production app, generate a design-system/ package), which Cloudflare
 * Workers cannot do. The module is registered ONLY in src/local.ts (the
 * registerMultiFileTools precedent): the tools never appear in Cloud Mode's
 * tool list, so no silent no-op is possible.
 *
 * Workflow (orchestrated by the design-system-extraction skill):
 *   figma_ds_analyze → figma_ds_extract_tokens → figma_ds_scaffold →
 *   per-component: figma_ds_extract_component + agent ports it →
 *   figma_ds_status records progress. Design-led orgs then run
 *   figma_import_tokens on the extracted tokens/tokens.json.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import {
  analyzeTargets,
  extractionDir,
  initStatusManifest,
  readManifest,
  resolveTargetPath,
  writeManifest,
} from "./extraction/analyzer.js";
import { extractTokens } from "./extraction/token-extractor.js";
import {
  generateStoryScaffold,
  scaffoldDesignSystem,
} from "./extraction/scaffolder.js";
import type {
  DsAnalysis,
  DsStatusManifest,
  DsTokensReport,
} from "./extraction/types.js";
import { parseDtcg } from "./tokens/parsers/dtcg.js";
import type { TokenDocument } from "./tokens/types.js";

const TOKEN_FORMAT_ENUM = z.enum([
  "dtcg",
  "css-vars",
  "tailwind-v4",
  "tailwind-v3",
  "scss",
  "ts-module",
  "json-nested",
  "json-flat",
  "tokens-studio",
  "style-dictionary-v3",
]);

const MAX_COMPONENT_SOURCE_KB = 64;

function ok(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function fail(error: unknown, hint: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          hint,
        }),
      },
    ],
    isError: true,
  };
}

function loadAnalysis(outDir: string): DsAnalysis | null {
  return readManifest<DsAnalysis>(join(extractionDir(outDir), "analysis.json"));
}

function defaultOutDir(targets: string[]): string {
  return join(resolveTargetPath(targets[0]), "design-system");
}

export function registerDesignSystemExtractionTools(server: McpServer): void {
  // ==========================================================================
  // figma_ds_analyze
  // ==========================================================================
  server.tool(
    "figma_ds_analyze",
    "Analyze one or more production app codebases as the first step of design system extraction. Detects framework (React/Next/Angular/Web Components), styling methods (Tailwind v3/v4, CSS Modules, SCSS, Emotion, styled-components), and vendor component layers (shadcn/ui, Radix, MUI, Chakra, etc.); builds a component inventory with per-component classification (vendored / wrapped / pure-vendor / bespoke), prop contracts, real usage counts (porting rank), observed prop values (variant inference), and duplicate detection. Pass multiple targets to find the shared design language across several apps. Writes the full manifest to <outDir>/.extraction/analysis.json and returns a compressed summary — read slices of the manifest for detail. Run this before figma_ds_extract_tokens and figma_ds_scaffold. Local Mode only.",
    {
      targets: z
        .array(z.string())
        .min(1)
        .describe(
          "App root directories to analyze. Absolute paths strongly recommended (the MCP server's working directory is not the project). Multiple targets = cross-app extraction: the inventory merges and duplicate components across apps are flagged.",
        ),
      outDir: z
        .string()
        .optional()
        .describe(
          "Directory where the design-system package will be generated (manifests persist under <outDir>/.extraction/). Default: '<first target>/design-system'.",
        ),
      include: z
        .array(z.string())
        .optional()
        .describe(
          "Substring filters on relative paths — when set, only matching files are scanned (e.g. ['src/', 'app/']).",
        ),
      exclude: z
        .array(z.string())
        .optional()
        .describe(
          "Substring filters on relative paths to skip (node_modules, dist, .next etc. are always skipped)."
        ),
      maxFiles: z
        .number()
        .min(100)
        .max(20000)
        .optional()
        .default(5000)
        .describe("Hard cap on files scanned per target (default 5000)."),
    },
    async ({ targets, outDir, include, exclude, maxFiles }) => {
      try {
        const roots = targets.map(resolveTargetPath);
        for (const root of roots) {
          if (!existsSync(root)) {
            return fail(
              `Target directory not found: ${root}`,
              "Pass absolute paths — the MCP server's working directory is usually not the project directory.",
            );
          }
        }
        const resolvedOut = outDir
          ? resolveTargetPath(outDir)
          : defaultOutDir(targets);

        const analysis = analyzeTargets(roots, {
          outDir: resolvedOut,
          include,
          exclude,
          maxFiles,
        });
        const manifestPath = join(extractionDir(resolvedOut), "analysis.json");
        writeManifest(manifestPath, analysis);

        // Initialize status manifest only if absent (don't clobber progress).
        const statusPath = join(extractionDir(resolvedOut), "status.json");
        if (!existsSync(statusPath)) {
          writeManifest(statusPath, initStatusManifest(analysis));
        }

        const portable = analysis.components.filter(
          (c) => c.classification !== "pure-vendor",
        );
        return ok({
          manifestPath,
          outDir: resolvedOut,
          targets: analysis.targets.map((t) => ({
            root: t.root,
            packageName: t.packageName,
            frameworks: t.frameworks,
            stylingMethods: t.stylingMethods,
            componentLibraries: t.componentLibraries.map((l) => l.name),
            icons: (t.icons ?? []).length,
            typographyRules: (t.typography ?? []).length,
            stats: t.stats,
          })),
          inventory: {
            totalComponents: analysis.components.length,
            portable: portable.length,
            pureVendor: analysis.components.length - portable.length,
            byClassification: analysis.components.reduce<Record<string, number>>(
              (acc, c) => {
                acc[c.classification] = (acc[c.classification] ?? 0) + 1;
                return acc;
              },
              {},
            ),
            topByUsage: analysis.components.slice(0, 25).map((c) => ({
              name: c.name,
              file: c.file,
              classification: c.classification,
              usage: c.usage.tagCount + c.usage.importCount,
              props: c.props.length,
            })),
            duplicateGroups: analysis.duplicateGroups.slice(0, 20),
          },
          architecture: analysis.architecture
            ? {
                summary: analysis.architecture.summary,
                specializations: analysis.architecture.specializations.slice(0, 20),
                missingPrimitives: analysis.architecture.missingPrimitives,
                guidance:
                  "Specializations are USAGE named as components (FollowButton is a Button used to follow) — the UI-kit smell. For a general-purpose design system: build each missingPrimitive as a generic component, re-express specializations as variants/recipes on it, and review the atomic levels with the user (design-systems-assistant MCP has the best-practice grounding when connected).",
              }
            : undefined,
          nextSteps: [
            "Review topByUsage + duplicateGroups + architecture.specializations with the user; decide which become generic primitives vs recipes.",
            "Run figma_ds_extract_tokens to mine the styling decisions into DTCG tokens.",
            "Then figma_ds_scaffold to generate the design-system package.",
          ],
        });
      } catch (e) {
        return fail(e, "Check that targets are readable directories.");
      }
    },
  );

  // ==========================================================================
  // figma_ds_extract_tokens
  // ==========================================================================
  server.tool(
    "figma_ds_extract_tokens",
    "Extract design tokens from analyzed codebases into canonical DTCG JSON (plus optional CSS variables / Tailwind / SCSS / TypeScript projections). Mines declared styling intent first — :root and @theme custom properties (light+dark → multi-mode tokens), SCSS variables, tailwind.config theme values, shadcn HSL triples — then promotes recurring raw values (hex colors, spacing/radius/font sizes) above a frequency threshold. Every token carries provenance (source file:line, confidence, frequency) in $extensions. Names are structural as-mined; do a semantic-naming review pass with the user afterwards. The DTCG output is directly importable into Figma variables with figma_import_tokens (top-level groups become collections). Requires figma_ds_analyze to have run for the same outDir. Local Mode only.",
    {
      outDir: z
        .string()
        .optional()
        .describe(
          "The outDir used in figma_ds_analyze (reads .extraction/analysis.json from it). Default: '<first target of the analysis run>/design-system' — pass explicitly when in doubt.",
        ),
      targets: z
        .array(z.string())
        .optional()
        .describe(
          "Override: scan these app roots instead of the analysis manifest's targets (rarely needed).",
        ),
      formats: z
        .array(TOKEN_FORMAT_ENUM)
        .optional()
        .default(["dtcg", "css-vars"])
        .describe(
          "Token file formats to write under <outDir>/tokens/. 'dtcg' (canonical) is always written. Match the app's styling method — e.g. add 'tailwind-v4' for a Tailwind app, 'scss' for SCSS.",
        ),
      dtcgDialect: z
        .enum(["legacy", "2025"])
        .optional()
        .default("legacy")
        .describe(
          "DTCG dialect: 'legacy' hex-string colors (max compatibility) or '2025' DTCG 2025.10 object colors/dimensions.",
        ),
      minFrequency: z
        .number()
        .min(2)
        .max(100)
        .optional()
        .default(4)
        .describe(
          "How often a raw (undeclared) value must recur to be promoted to a token (default 4). Values below the threshold are listed in the report for review.",
        ),
      write: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Write token files to <outDir>/tokens/ (default true). False returns the DTCG document inline instead (dry run).",
        ),
    },
    async ({ outDir, targets, formats, dtcgDialect, minFrequency, write }) => {
      try {
        let roots: string[];
        let resolvedOut: string;
        if (targets && targets.length > 0) {
          roots = targets.map(resolveTargetPath);
          resolvedOut = outDir ? resolveTargetPath(outDir) : defaultOutDir(targets);
        } else {
          if (!outDir) {
            return fail(
              "Pass outDir (the one used in figma_ds_analyze) or explicit targets.",
              "figma_ds_extract_tokens reads the analysis manifest from <outDir>/.extraction/analysis.json.",
            );
          }
          resolvedOut = resolveTargetPath(outDir);
          const analysis = loadAnalysis(resolvedOut);
          if (!analysis) {
            return fail(
              `No analysis manifest at ${join(extractionDir(resolvedOut), "analysis.json")}.`,
              "Run figma_ds_analyze first (same outDir).",
            );
          }
          roots = analysis.targets.map((t) => t.root);
        }

        // Re-walk style+code files for token mining.
        const { walkFiles } = await import("./extraction/walker.js");
        const files = roots.flatMap(
          (root) =>
            walkFiles(root, {
              extensions: [
                ".css",
                ".scss",
                ".sass",
                ".less",
                ".tsx",
                ".jsx",
                ".ts",
                ".js",
                ".cjs",
                ".mjs",
                ".astro",
                ".vue",
                ".svelte",
              ],
            }).files,
        );

        const extraction = extractTokens(files, {
          minFrequency,
          targetRoots: roots,
        });

        const report: DsTokensReport = {
          version: 1,
          generatedAt: new Date().toISOString(),
          counts: extraction.counts,
          warnings: extraction.warnings,
          belowThreshold: extraction.belowThreshold,
          filesWritten: [],
        };

        if (write) {
          const { format } = await import("./tokens/formatters/index.js");
          const { mkdirSync, writeFileSync } = await import("node:fs");
          const uniqueFormats = [
            "dtcg",
            ...formats.filter((f) => f !== "dtcg"),
          ] as typeof formats;
          const filenames: Record<string, string> = {
            dtcg: "tokens/tokens.json",
            "css-vars": "tokens/tokens.css",
            "tailwind-v4": "tokens/theme.css",
            "tailwind-v3": "tokens/tailwind.tokens.js",
            scss: "tokens/_tokens.scss",
            "ts-module": "tokens/tokens.ts",
            "json-nested": "tokens/tokens.nested.json",
            "json-flat": "tokens/tokens.flat.json",
            "tokens-studio": "tokens/tokens-studio.json",
            "style-dictionary-v3": "tokens/style-dictionary.json",
          };
          for (const f of uniqueFormats) {
            try {
              const res = format(extraction.document, {
                target: { format: f, filename: filenames[f], dtcgDialect },
                projectRoot: resolvedOut,
              });
              report.warnings.push(...res.warnings);
              for (const file of res.files) {
                const abs = join(resolvedOut, file.path);
                mkdirSync(dirname(abs), { recursive: true });
                writeFileSync(abs, file.content, "utf-8");
                report.filesWritten.push(abs);
              }
            } catch (e) {
              report.warnings.push(
                `Format ${f} failed: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
          writeManifest(
            join(extractionDir(resolvedOut), "tokens-report.json"),
            report,
          );
          // Mode names (lowercased, base mode first) for the Storybook theme
          // toolbar generated by figma_ds_setup_storybook.
          const modeNames = (extraction.document.sets[0]?.modes ?? ["Default"])
            .map((m) => m.toLowerCase())
            .filter((m) => m !== "default");
          if (modeNames.length > 1) {
            writeManifest(
              join(extractionDir(resolvedOut), "tokens-modes.json"),
              modeNames,
            );
          }
        }

        return ok({
          counts: extraction.counts,
          sets: extraction.document.sets.map((s) => ({
            name: s.name,
            modes: s.modes,
            tokens: s.tokens.length,
          })),
          warnings: extraction.warnings,
          belowThresholdSample: extraction.belowThreshold.slice(0, 15),
          filesWritten: report.filesWritten,
          document: write ? undefined : extraction.document,
          nextSteps: [
            "Do a semantic-naming pass with the user: promote structural names to role names as alias tokens.",
            "Then figma_ds_scaffold; for design-led orgs, figma_import_tokens on tokens/tokens.json imports these as Figma variables.",
          ],
        });
      } catch (e) {
        return fail(e, "Check outDir/targets paths and rerun figma_ds_analyze if the manifest is stale.");
      }
    },
  );

  // ==========================================================================
  // figma_ds_scaffold
  // ==========================================================================
  server.tool(
    "figma_ds_scaffold",
    "Generate the design-system package skeleton at outDir from a completed analysis + token extraction: package.json (app framework as peer deps), src/components layout, token files via the shared formatter engine, a framework-neutral token-showcase MDX docs page (the bird's-eye view), and a README with the workflow. Storybook itself is NOT installed by this tool — after scaffolding, run `npm create storybook@latest` inside outDir (the CLI auto-detects the framework and installs the current Storybook version). Additive by default: existing files are skipped unless force. Local Mode only.",
    {
      outDir: z
        .string()
        .describe("The outDir used in figma_ds_analyze / figma_ds_extract_tokens."),
      packageName: z
        .string()
        .optional()
        .describe(
          "npm package name for the design system (e.g. '@acme/design-system'). Default: '@extracted/design-system'.",
        ),
      framework: z
        .enum([
          "react",
          "next",
          "astro",
          "angular",
          "web-components",
          "vue",
          "svelte",
        ])
        .optional()
        .describe(
          "Override the scaffold framework. Default: the first framework detected by figma_ds_analyze. Note: Storybook has no .astro renderer — 'astro' scaffolds a react-vite workshop whose stories mirror the component markup.",
        ),
      formats: z
        .array(TOKEN_FORMAT_ENUM)
        .optional()
        .default(["dtcg", "css-vars"])
        .describe("Token formats to (re)generate under tokens/."),
      dtcgDialect: z
        .enum(["legacy", "2025"])
        .optional()
        .default("legacy")
        .describe("DTCG dialect for dtcg/json outputs."),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe("Overwrite existing scaffold files (token files always refresh)."),
    },
    async ({ outDir, packageName, framework, formats, dtcgDialect, force }) => {
      try {
        const resolvedOut = resolveTargetPath(outDir);
        const analysis = loadAnalysis(resolvedOut);
        if (!analysis) {
          return fail(
            `No analysis manifest at ${join(extractionDir(resolvedOut), "analysis.json")}.`,
            "Run figma_ds_analyze first (same outDir).",
          );
        }
        const tokensPath = join(resolvedOut, "tokens", "tokens.json");
        let document: TokenDocument;
        if (existsSync(tokensPath)) {
          const parsed = parseDtcg({
            payload: readFileSync(tokensPath, "utf-8"),
            sourcePath: tokensPath,
          });
          document = parsed.document;
        } else {
          return fail(
            `No extracted tokens at ${tokensPath}.`,
            "Run figma_ds_extract_tokens first (same outDir).",
          );
        }

        const fw = framework ?? analysis.targets[0]?.frameworks[0] ?? "react";
        const result = scaffoldDesignSystem(analysis, document, {
          outDir: resolvedOut,
          packageName: packageName ?? "@extracted/design-system",
          framework: fw,
          formats,
          dtcgDialect,
          force,
        });
        return ok({ outDir: resolvedOut, framework: fw, ...result });
      } catch (e) {
        return fail(e, "Ensure figma_ds_analyze and figma_ds_extract_tokens ran for this outDir.");
      }
    },
  );

  // ==========================================================================
  // figma_ds_setup_storybook
  // ==========================================================================
  server.tool(
    "figma_ds_setup_storybook",
    "Wire a freshly-initialized Storybook workshop to the extracted design system — run AFTER `npm create storybook@latest` inside outDir. Generates .storybook/preview.css (Tailwind entry importing the extracted tokens plus the SOURCE app's @theme utility mapping, custom @utility definitions, @layer base, and @font-face rules mined from its stylesheets, with a dark variant covering both .dark and [data-theme] conventions), copies self-hosted font files into staticDirs, and patches main.js (tailwind vite plugin + automatic JSX runtime — without it stories throw 'React is not defined') and preview.jsx (preview.css import + a theme toolbar/decorator using the extracted mode names). Idempotent; anything it can't patch safely is returned as a manual step. Local Mode only.",
    {
      outDir: z
        .string()
        .describe(
          "The design-system package dir (same outDir as figma_ds_analyze) containing the freshly-initialized .storybook/.",
        ),
    },
    async ({ outDir }) => {
      try {
        const resolvedOut = resolveTargetPath(outDir);
        const analysis = loadAnalysis(resolvedOut);
        if (!analysis) {
          return fail(
            `No analysis manifest at ${join(extractionDir(resolvedOut), "analysis.json")}.`,
            "Run figma_ds_analyze first (same outDir).",
          );
        }
        const { setupStorybookPreset } = await import(
          "./extraction/storybook-preset.js"
        );
        const result = setupStorybookPreset(analysis, resolvedOut);
        return ok({
          ...result,
          nextSteps: [
            ...result.manualSteps,
            "Restart the Storybook dev server if it was running — @imported CSS changes are not always hot-reloaded.",
          ],
        });
      } catch (e) {
        return fail(e, "Check that outDir contains a .storybook directory from `npm create storybook@latest`.");
      }
    },
  );

  // ==========================================================================
  // figma_ds_extract_component
  // ==========================================================================
  server.tool(
    "figma_ds_extract_component",
    "Deep-extract ONE component from the inventory for porting into the design system: returns its source (capped), local import closure (relative imports to follow), prop contract, observed call-site variants, vendor classification, style touchpoints (classNames, CSS-module imports, custom properties referenced), and a ready-to-adapt CSF3 story scaffold with variant stories inferred from real usage. The agent then ports the component into <outDir>/src/components/<Name>/ and records progress with figma_ds_status. Local Mode only.",
    {
      outDir: z
        .string()
        .describe("The outDir used in figma_ds_analyze (manifest is read from it)."),
      component: z
        .string()
        .describe("Component name from the inventory (see figma_ds_analyze topByUsage, or the analysis manifest for the full list)."),
    },
    async ({ outDir, component }) => {
      try {
        const resolvedOut = resolveTargetPath(outDir);
        const analysis = loadAnalysis(resolvedOut);
        if (!analysis) {
          return fail(
            `No analysis manifest at ${join(extractionDir(resolvedOut), "analysis.json")}.`,
            "Run figma_ds_analyze first (same outDir).",
          );
        }
        const matches = analysis.components.filter(
          (c) => c.name.toLowerCase() === component.toLowerCase(),
        );
        if (matches.length === 0) {
          const near = analysis.components
            .filter((c) =>
              c.name.toLowerCase().includes(component.toLowerCase()),
            )
            .slice(0, 10)
            .map((c) => c.name);
          return fail(
            `Component "${component}" not found in the inventory.`,
            near.length > 0
              ? `Did you mean: ${near.join(", ")}?`
              : "Check figma_ds_analyze output for available names.",
          );
        }
        const entry =
          matches.find((c) => c.classification !== "pure-vendor") ?? matches[0];

        if (entry.classification === "pure-vendor" || !entry.file) {
          return ok({
            component: entry,
            portable: false,
            guidance:
              "Pure-vendor component — no local source to port. Represent it via the token theme and document approved usage; if the org needs a customized version, create a wrapper in the design system instead.",
          });
        }

        const root = analysis.targets[entry.targetIndex]?.root;
        const absFile = join(root, entry.file);
        let source = "";
        let truncated = false;
        try {
          source = readFileSync(absFile, "utf-8");
          if (source.length > MAX_COMPONENT_SOURCE_KB * 1024) {
            source = source.slice(0, MAX_COMPONENT_SOURCE_KB * 1024);
            truncated = true;
          }
        } catch {
          return fail(
            `Could not read ${absFile}.`,
            "The analysis manifest may be stale — rerun figma_ds_analyze.",
          );
        }

        // Local import closure (depth 1): relative imports to follow.
        const localImports: string[] = [];
        const cssModuleImports: string[] = [];
        const importRe = /import\s+[^'"]*from\s+['"](\.[^'"]+)['"]/g;
        let m: RegExpExecArray | null;
        while ((m = importRe.exec(source)) !== null) {
          const spec = m[1];
          const abs = resolve(dirname(absFile), spec);
          if (/\.(module\.)?(css|scss)$/.test(spec)) cssModuleImports.push(spec);
          else localImports.push(abs);
        }

        // Style touchpoints.
        const classNames = new Set<string>();
        const classRe = /class(?:Name)?\s*=\s*(?:"([^"]+)"|'([^']+)')/g;
        while ((m = classRe.exec(source)) !== null) {
          for (const cls of (m[1] ?? m[2]).split(/\s+/)) {
            if (cls && classNames.size < 80) classNames.add(cls);
          }
        }
        const customProps = new Set<string>();
        const varRe = /var\(\s*(--[\w-]+)/g;
        while ((m = varRe.exec(source)) !== null) customProps.add(m[1]);

        return ok({
          component: {
            name: entry.name,
            file: entry.file,
            sourceApp: root,
            classification: entry.classification,
            vendorModule: entry.vendorModule,
            props: entry.props,
            observedProps: entry.observedProps,
            usage: entry.usage,
            duplicates: entry.duplicates,
          },
          source,
          sourceTruncated: truncated,
          localImports: localImports.slice(0, 30),
          styleTouchpoints: {
            cssModuleImports,
            classNames: [...classNames],
            customProperties: [...customProps],
          },
          storyScaffold: generateStoryScaffold(entry),
          portingChecklist: [
            `Create <outDir>/src/components/${entry.name}/${entry.name}.<ext> — decouple app-specific imports (routing, state, data fetching).`,
            "Replace hardcoded values with tokens from tokens/ (check styleTouchpoints.customProperties against tokens.json).",
            "Adapt the storyScaffold into <Name>.stories with one story per real variant.",
            "Visually verify in Storybook, then record with figma_ds_status.",
          ],
        });
      } catch (e) {
        return fail(e, "Check outDir and component name.");
      }
    },
  );

  // ==========================================================================
  // figma_ds_verify
  // ==========================================================================
  server.tool(
    "figma_ds_verify",
    "Run the deterministic fidelity evals on an extracted design system package — the governance gate before handing off or pushing to Figma. Checks: tokens.json parses as DTCG and every alias resolves (import-ready); no quoted CSS functional expressions in generated token files (kills transitions); every var() consumed in component/preview CSS resolves in the workshop; every component directory has a stories file and index barrel; every portable inventory component has a porting status. Each check encodes a failure class found in real extraction runs. Also reports Figma round-trip readiness with the exact figma_import_tokens call for design-led orgs (ask the user code-led vs design-led). Local Mode only.",
    {
      outDir: z
        .string()
        .describe("The design-system package dir (same outDir as figma_ds_analyze)."),
    },
    async ({ outDir }) => {
      try {
        const resolvedOut = resolveTargetPath(outDir);
        const analysis = loadAnalysis(resolvedOut);
        const status = readManifest<DsStatusManifest>(
          join(extractionDir(resolvedOut), "status.json"),
        );
        const { verifyExtraction } = await import("./extraction/verifier.js");
        const report = await verifyExtraction(resolvedOut, analysis, status);
        return ok(report);
      } catch (e) {
        return fail(e, "Check the outDir path.");
      }
    },
  );

  // ==========================================================================
  // figma_ds_status
  // ==========================================================================
  server.tool(
    "figma_ds_status",
    "Read or update design-system extraction porting progress (persisted in <outDir>/.extraction/status.json so long engagements survive session boundaries). Call with only outDir to get a progress summary; pass update to record a component's porting status. Local Mode only.",
    {
      outDir: z
        .string()
        .describe("The outDir used in figma_ds_analyze."),
      update: z
        .object({
          component: z.string().describe("Component name from the inventory."),
          status: z
            .enum(["pending", "in-progress", "ported", "skipped"])
            .describe("New porting status."),
          notes: z
            .string()
            .optional()
            .describe("Why skipped / consolidation decisions / gotchas."),
          storyFile: z
            .string()
            .optional()
            .describe("Relative path of the story file, once written."),
        })
        .optional()
        .describe("Status update to record. Omit to just read progress."),
    },
    async ({ outDir, update }) => {
      try {
        const resolvedOut = resolveTargetPath(outDir);
        const statusPath = join(extractionDir(resolvedOut), "status.json");
        let status = readManifest<DsStatusManifest>(statusPath);
        if (!status) {
          const analysis = loadAnalysis(resolvedOut);
          if (!analysis) {
            return fail(
              `No status or analysis manifest under ${extractionDir(resolvedOut)}.`,
              "Run figma_ds_analyze first (same outDir).",
            );
          }
          status = initStatusManifest(analysis);
        }

        if (update) {
          const now = new Date().toISOString();
          status.components[update.component] = {
            status: update.status,
            notes: update.notes,
            storyFile: update.storyFile,
            updatedAt: now,
          };
          status.updatedAt = now;
          writeManifest(statusPath, status);
        }

        const counts: Record<string, number> = {};
        for (const entry of Object.values(status.components)) {
          counts[entry.status] = (counts[entry.status] ?? 0) + 1;
        }
        const remaining = Object.entries(status.components)
          .filter(([, e]) => e.status === "pending" || e.status === "in-progress")
          .slice(0, 25)
          .map(([name, e]) => ({ name, status: e.status }));

        return ok({
          statusPath,
          counts,
          remaining,
          updated: update ? update.component : undefined,
        });
      } catch (e) {
        return fail(e, "Check the outDir path.");
      }
    },
  );
}
