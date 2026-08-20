/**
 * Bounded filesystem walker for design system extraction.
 *
 * Hand-rolled (no glob dependency) recursive walk with hard bounds so a scan
 * of a large production app can't run away: ignored directory names, max
 * depth, max file count, max file size. Symlinks are never followed.
 */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, sep, extname } from "node:path";

/** Directories that never contain design-system source. */
const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".angular",
  ".turbo",
  ".cache",
  "coverage",
  ".storybook-static",
  "storybook-static",
  ".vercel",
  ".netlify",
  "vendor",
  "__snapshots__",
  ".extraction",
]);

export interface WalkOptions {
  /** Only include files with these extensions (with dot). Empty = all. */
  extensions?: string[];
  /** Substring filters on the relative path. Any match includes the file. */
  include?: string[];
  /** Substring filters on the relative path. Any match excludes the file. */
  exclude?: string[];
  /** Hard cap on files returned. */
  maxFiles?: number;
  /** Per-file size cap in KB; larger files are skipped (likely generated). */
  maxFileSizeKb?: number;
  maxDepth?: number;
}

export interface WalkedFile {
  /** Absolute path. */
  path: string;
  /** Path relative to the walk root, always "/"-separated. */
  relPath: string;
  ext: string;
  sizeBytes: number;
}

export interface WalkResult {
  files: WalkedFile[];
  skipped: { tooLarge: number; ignored: number; overMaxFiles: boolean };
}

const DEFAULTS = {
  maxFiles: 5000,
  maxFileSizeKb: 512,
  maxDepth: 12,
};

export function walkFiles(root: string, opts: WalkOptions = {}): WalkResult {
  const maxFiles = opts.maxFiles ?? DEFAULTS.maxFiles;
  const maxBytes = (opts.maxFileSizeKb ?? DEFAULTS.maxFileSizeKb) * 1024;
  const maxDepth = opts.maxDepth ?? DEFAULTS.maxDepth;
  const extFilter =
    opts.extensions && opts.extensions.length > 0
      ? new Set(opts.extensions.map((e) => e.toLowerCase()))
      : null;

  const result: WalkResult = {
    files: [],
    skipped: { tooLarge: 0, ignored: 0, overMaxFiles: false },
  };

  const visit = (dir: string, depth: number): void => {
    if (result.files.length >= maxFiles) {
      result.skipped.overMaxFiles = true;
      return;
    }
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip silently, scan is best-effort
    }

    for (const entry of entries) {
      if (result.files.length >= maxFiles) {
        result.skipped.overMaxFiles = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;

      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
          result.skipped.ignored++;
          continue;
        }
        visit(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const relPath = relative(root, abs).split(sep).join("/");
      const ext = extname(entry.name).toLowerCase();

      if (extFilter && !extFilter.has(ext)) continue;
      if (opts.exclude?.some((p) => relPath.includes(p))) {
        result.skipped.ignored++;
        continue;
      }
      if (
        opts.include &&
        opts.include.length > 0 &&
        !opts.include.some((p) => relPath.includes(p))
      ) {
        continue;
      }

      let sizeBytes: number;
      try {
        sizeBytes = statSync(abs).size;
      } catch {
        continue;
      }
      if (sizeBytes > maxBytes) {
        result.skipped.tooLarge++;
        continue;
      }

      result.files.push({ path: abs, relPath, ext, sizeBytes });
    }
  };

  visit(root, 0);
  return result;
}

/** Read a walked file as UTF-8, returning null on failure (best-effort scan). */
export function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
