/**
 * Orchestrates a full analysis run: walk each target, detect stack, build the
 * component inventory, and persist the manifest under <outDir>/.extraction/.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, isAbsolute, resolve } from "node:path";
import type {
  DsAnalysis,
  DsIconEntry,
  DsStatusManifest,
  DsStyleSource,
  DsTargetAnalysis,
  DsTypographyRule,
} from "./types.js";
import {
  extractStyleBlocks,
  mineTypographyStyles,
} from "./token-extractor.js";
import { walkFiles, readTextFile, type WalkOptions } from "./walker.js";
import {
  readPackageInfo,
  detectFrameworks,
  detectStylingMethods,
  detectComponentLibraries,
} from "./detectors.js";
import { buildComponentInventory } from "./component-inventory.js";
import { classifyArchitecture } from "./architecture.js";

export function resolveTargetPath(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

export function extractionDir(outDir: string): string {
  return join(outDir, ".extraction");
}

export function writeManifest(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export function readManifest<T>(path: string): T | null {
  const raw = readTextFile(path);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export interface AnalyzeOptions extends WalkOptions {
  outDir: string;
}

export function analyzeTargets(
  targetRoots: string[],
  opts: AnalyzeOptions,
): DsAnalysis {
  const analysis: DsAnalysis = {
    version: 1,
    generatedAt: new Date().toISOString(),
    outDir: opts.outDir,
    targets: [],
    components: [],
    duplicateGroups: [],
  };

  targetRoots.forEach((root, targetIndex) => {
    const started = Date.now();
    const walk = walkFiles(root, {
      include: opts.include,
      exclude: opts.exclude,
      maxFiles: opts.maxFiles,
      maxFileSizeKb: opts.maxFileSizeKb,
    });

    const pkg = readPackageInfo(root);
    const frameworks = detectFrameworks(pkg, walk.files);
    const stylingMethods = detectStylingMethods(root, pkg, walk.files, (f) =>
      readTextFile(f.path),
    );
    const componentLibraries = detectComponentLibraries(root, pkg);

    const styleSources: DsStyleSource[] = [];
    const icons: DsIconEntry[] = [];
    const typography: DsTypographyRule[] = [];
    for (const f of walk.files) {
      if (/tailwind\.config\.(js|cjs|mjs|ts)$/.test(f.relPath)) {
        styleSources.push({ file: f.relPath, kind: "tailwind-config" });
      } else if (/\.module\.(css|scss)$/.test(f.relPath)) {
        styleSources.push({ file: f.relPath, kind: "css-module" });
      } else if (f.ext === ".scss" || f.ext === ".sass") {
        styleSources.push({ file: f.relPath, kind: "scss" });
        const text = readTextFile(f.path);
        if (text) typography.push(...mineTypographyStyles(text, f.relPath));
      } else if (f.ext === ".css") {
        const text = readTextFile(f.path);
        const varCount = text ? (text.match(/--[\w-]+\s*:/g)?.length ?? 0) : 0;
        styleSources.push({
          file: f.relPath,
          kind: "css",
          note: varCount > 0 ? `defines ${varCount} custom properties` : undefined,
        });
        if (text) typography.push(...mineTypographyStyles(text, f.relPath));
      } else if (f.ext === ".svg" && f.sizeBytes <= 32 * 1024) {
        if (icons.length < 200) {
          icons.push({
            name: f.relPath.split("/").pop()!.replace(/\.svg$/, ""),
            file: f.relPath,
            source: "svg-file",
          });
        }
      } else if (
        (f.ext === ".astro" || f.ext === ".tsx" || f.ext === ".jsx") &&
        icons.length < 200
      ) {
        const text = readTextFile(f.path);
        if (text) {
          if (text.includes("<svg")) {
            icons.push({
              name: f.relPath.split("/").pop()!.replace(/\.\w+$/, ""),
              file: f.relPath,
              source: "inline-svg",
            });
          }
          if (f.ext === ".astro") {
            for (const block of extractStyleBlocks(text)) {
              typography.push(...mineTypographyStyles(block, f.relPath));
            }
          }
        }
      }
    }

    const inventory = buildComponentInventory(walk.files, targetIndex);

    analysis.targets.push({
      root,
      packageName: pkg.name,
      frameworks,
      stylingMethods,
      componentLibraries,
      styleSources: styleSources.slice(0, 200),
      icons,
      typography: typography.slice(0, 120),
      stats: {
        filesScanned: walk.files.length,
        filesSkipped: walk.skipped.ignored + walk.skipped.tooLarge,
        durationMs: Date.now() - started,
      },
    } satisfies DsTargetAnalysis);

    analysis.components.push(...inventory.components);
    analysis.duplicateGroups.push(...inventory.duplicateGroups);
  });

  // Cross-target duplicates: same component name defined in multiple targets.
  if (targetRoots.length > 1) {
    const byName = new Map<string, string[]>();
    for (const c of analysis.components) {
      if (!c.file) continue;
      const list = byName.get(c.name) ?? [];
      list.push(`${targetRoots[c.targetIndex]}/${c.file}`);
      byName.set(c.name, list);
    }
    for (const [name, files] of byName) {
      if (
        files.length > 1 &&
        !analysis.duplicateGroups.some((g) => g.name === name)
      ) {
        analysis.duplicateGroups.push({ name, files });
      }
    }
  }

  analysis.architecture = classifyArchitecture(analysis.components);

  return analysis;
}

export function initStatusManifest(analysis: DsAnalysis): DsStatusManifest {
  const now = new Date().toISOString();
  const status: DsStatusManifest = {
    version: 1,
    updatedAt: now,
    components: {},
  };
  for (const c of analysis.components) {
    if (c.classification === "pure-vendor") continue;
    status.components[c.name] = { status: "pending", updatedAt: now };
  }
  return status;
}
