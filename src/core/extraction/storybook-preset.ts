/**
 * Storybook workshop preset for extracted design systems.
 *
 * `npm create storybook@latest` produces a stock react-vite workshop that
 * knows nothing about the source app. This module generates the glue that
 * makes ported components render faithfully — every piece below was a real
 * failure found during live extraction runs:
 *
 *  - preview.css: Tailwind entry importing the extracted tokens, the SOURCE
 *    app's @theme mapping (so production utility names resolve), its custom
 *    @utility definitions, its @layer base, and its @font-face rules. A dark
 *    @custom-variant covers BOTH `.dark` (generated tokens.css) and
 *    `[data-theme]` (rules ported verbatim from the app).
 *  - main.js patch: tailwindcss() vite plugin, `esbuild.jsx = "automatic"`
 *    (react-vite injects no React plugin into a package without a vite
 *    config — classic-runtime JSX dies with "React is not defined"), and
 *    staticDirs for self-hosted font files.
 *  - preview.jsx patch: a theme toolbar + decorator that sets BOTH the
 *    `.dark`-style class and `data-theme`, so either mode convention
 *    resolves; extracted mode names come from the analysis.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import type { DsAnalysis } from "./types.js";

/** Extract every brace-balanced block starting with `marker` from css text. */
function extractBlocks(css: string, marker: RegExp): string[] {
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(marker.source, "g");
  while ((m = re.exec(css)) !== null) {
    const start = css.indexOf("{", m.index);
    if (start === -1) continue;
    let depth = 0;
    for (let i = start; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") {
        depth--;
        if (depth === 0) {
          blocks.push(css.slice(m.index, i + 1));
          re.lastIndex = i;
          break;
        }
      }
    }
  }
  return blocks;
}

export interface StorybookPresetResult {
  filesWritten: string[];
  patched: string[];
  manualSteps: string[];
  warnings: string[];
}

/**
 * Generate/patch the workshop glue inside `<outDir>/.storybook`. Safe to
 * re-run. Source-app CSS is mined from the analysis's styleSources.
 */
export function setupStorybookPreset(
  analysis: DsAnalysis,
  outDir: string,
): StorybookPresetResult {
  const result: StorybookPresetResult = {
    filesWritten: [],
    patched: [],
    manualSteps: [],
    warnings: [],
  };
  const sbDir = join(outDir, ".storybook");
  if (!existsSync(sbDir)) {
    result.manualSteps.push(
      "No .storybook directory — run `npm create storybook@latest -- --yes --no-dev` in the package first, then re-run this tool.",
    );
    return result;
  }

  const target = analysis.targets[0];
  const usesTailwind = target?.stylingMethods.some((s) =>
    s.startsWith("tailwind"),
  );
  if (usesTailwind) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(outDir, "package.json"), "utf-8"),
      );
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (!deps["@tailwindcss/vite"]) {
        result.manualSteps.push(
          "Install the Tailwind packages the injected vite plugin needs: npm install --save-dev tailwindcss @tailwindcss/vite",
        );
      }
    } catch {
      /* no package.json — the missing-dep error will surface on build */
    }
  }

  // ---- Mine the source app's global styling layers -------------------------
  let themeBlocks: string[] = [];
  let utilityBlocks: string[] = [];
  let baseBlocks: string[] = [];
  let fontFaces: string[] = [];
  const sharedRules: string[] = [];
  const fontFiles = new Set<string>();
  for (const src of target?.styleSources ?? []) {
    if (src.kind !== "css" && src.kind !== "scss") continue;
    const abs = join(target.root, src.file);
    let css: string;
    try {
      css = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    if (css.length > 200 * 1024) continue; // generated/vendor-sized — skip
    const theme = extractBlocks(css, /@theme\b[^{]*/);
    const utils = extractBlocks(css, /@utility\s+[\w-]+\s*/);
    const base = extractBlocks(css, /@layer base\s*/);
    const faces = extractBlocks(css, /@font-face\s*/);
    themeBlocks.push(...theme);
    utilityBlocks.push(...utils);
    baseBlocks.push(...base);
    fontFaces.push(...faces);
    for (const face of faces) {
      let fm: RegExpExecArray | null;
      const urlRe = /url\(['"]?(\/[^'")]+)['"]?\)/g;
      while ((fm = urlRe.exec(face)) !== null) fontFiles.add(fm[1]);
    }
    // The remainder — the app's shared class layer (plain `.panel`,
    // `.btn-accent` style rules many apps keep in globals.css). Ported
    // components rely on these; without them stories render unstyled
    // (found live on the second test target). Blocks already mined above
    // and framework directives are stripped; the rest ships verbatim.
    let remainder = css;
    for (const block of [...theme, ...utils, ...base, ...faces]) {
      remainder = remainder.replace(block, "");
    }
    remainder = remainder
      .replace(/^\s*@(import|plugin|custom-variant|source)\b[^;]*;\s*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    // Only keep files that actually define rules beyond the mined blocks.
    if (/[.\w[][^{}]*\{[^}]*\}/.test(remainder)) {
      sharedRules.push(
        `/* ---- shared rules from ${src.file} (verbatim) ---- */\n${remainder}`,
      );
    }
  }

  // ---- Copy self-hosted font files into the workshop's staticDirs ----------
  const publicRoot = resolve(outDir, "public");
  for (const file of fontFiles) {
    const srcPath = join(target.root, "public", file);
    const dstPath = join(outDir, "public", file);
    // url("/../../x") in mined CSS must never escape outDir/public — join()
    // normalizes traversal (review finding).
    if (!resolve(dstPath).startsWith(publicRoot + sep)) {
      result.warnings.push(`Skipped font copy with traversal in its path: ${file}`);
      continue;
    }
    if (existsSync(srcPath) && !existsSync(dstPath)) {
      mkdirSync(dirname(dstPath), { recursive: true });
      cpSync(srcPath, dstPath);
      result.filesWritten.push(`public${file}`);
    }
  }

  // ---- preview.css ---------------------------------------------------------
  const tokensCss = existsSync(join(outDir, "tokens", "tokens.css"))
    ? "@import '../tokens/tokens.css';"
    : "/* tokens/tokens.css not found — run figma_ds_extract_tokens with the css-vars format */";
  let previewCss = [
    "/* Generated by figma_ds_setup_storybook — safe to re-run; hand-edits are overwritten.",
    "   Order matters: tailwind → dark variant → extracted tokens → the source app's",
    "   @theme utility mapping / @utility defs / @layer base / @font-face. */",
    usesTailwind ? "@import 'tailwindcss';" : "",
    "",
    usesTailwind
      ? "@custom-variant dark (&:where([data-theme='dark'], [data-theme='dark'] *, .dark, .dark *));"
      : "",
    "",
    tokensCss,
    "",
    ...themeBlocks,
    "",
    ...utilityBlocks,
    "",
    ...baseBlocks,
    "",
    ...fontFaces,
    "",
    ...sharedRules,
    "",
    "/* Storybook's injected preview stylesheet sets its own font (Nunito Sans)",
    "   on form controls, which don't inherit font-family — overriding the app's",
    "   cascade and making every ported button render in the wrong face (found",
    "   live). Pin them back to the app's font with story-root specificity. */",
    "#storybook-root button, #storybook-root input, #storybook-root textarea, #storybook-root select,",
    ".sb-story button, .sb-story input, .sb-story textarea, .sb-story select {",
    "  font-family: inherit;",
    "}",
    "",
  ]
    .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
    .join("\n");

  // Self-check: variables consumed but never defined in CSS are usually
  // runtime-injected (next/font's `variable: "--font-body"`, JS theme
  // setters). The app defines them in JavaScript; the workshop needs CSS
  // fallbacks or every consuming declaration silently breaks (caught live
  // by figma_ds_verify on the second test target).
  {
    const tokensCssText = existsSync(join(outDir, "tokens", "tokens.css"))
      ? readFileSync(join(outDir, "tokens", "tokens.css"), "utf-8")
      : "";
    const definedVars = new Set<string>();
    for (const m of (previewCss + tokensCssText).matchAll(/--([\w-]+)\s*:/g))
      definedVars.add(m[1]);
    const fallbacks: string[] = [];
    const seen = new Set<string>();
    for (const m of previewCss.matchAll(/var\(\s*--([\w-]+)\s*\)/g)) {
      const name = m[1];
      if (definedVars.has(name) || seen.has(name)) continue;
      seen.add(name);
      if (/font|typeface/i.test(name)) {
        const stack = /mono|code/i.test(name)
          ? "ui-monospace, 'SF Mono', Menlo, monospace"
          : "system-ui, -apple-system, sans-serif";
        fallbacks.push(`  --${name}: ${stack}; /* runtime-injected (e.g. next/font) — workshop fallback */`);
        result.manualSteps.push(
          `--${name} falls back to a system font stack — for exact type fidelity, find the real font in the app's next/font (or equivalent) setup, install its @fontsource package, import it in .storybook/preview.jsx, and prepend it to the --${name} fallback in preview.css.`,
        );
      } else {
        result.warnings.push(
          `var(--${name}) is consumed but never defined in CSS — likely runtime-injected; add a fallback to .storybook/preview.css if stories render wrong.`,
        );
      }
    }
    if (fallbacks.length > 0) {
      previewCss += `\n/* Runtime-injected variables — workshop fallbacks */\n:root {\n${fallbacks.join("\n")}\n}\n`;
    }
  }

  writeFileSync(join(sbDir, "preview.css"), previewCss, "utf-8");
  result.filesWritten.push(".storybook/preview.css");

  // ---- Patch main.js (only when it still looks like stock init output) -----
  const mainPath = ["main.js", "main.ts"]
    .map((f) => join(sbDir, f))
    .find(existsSync);
  if (mainPath) {
    let main = readFileSync(mainPath, "utf-8");
    let changed = false;
    if (usesTailwind && !main.includes("@tailwindcss/vite")) {
      main = `import tailwindcss from "@tailwindcss/vite";\n${main}`;
      changed = true;
    }
    if (!main.includes("viteFinal")) {
      const inject = [
        "  async viteFinal(viteConfig) {",
        usesTailwind
          ? "    viteConfig.plugins = [...(viteConfig.plugins ?? []), tailwindcss()];"
          : "",
        "    // No vite.config in this package → react-vite injects no React",
        '    // plugin; without the automatic JSX runtime, stories throw',
        '    // "React is not defined" at runtime.',
        '    viteConfig.esbuild = { ...viteConfig.esbuild, jsx: "automatic" };',
        "    return viteConfig;",
        "  },",
      ]
        .filter(Boolean)
        .join("\n");
      // The stock config may or may not have a trailing comma after the
      // framework line — always emit one before injecting (found live:
      // comma-less config produced "Unexpected token 'async'").
      const anchor = /("framework":\s*"[^"]+"),?/;
      if (anchor.test(main)) {
        main = main.replace(anchor, `$1,\n${inject}`);
        changed = true;
      } else {
        result.manualSteps.push(
          `Add to ${mainPath}: a viteFinal that appends the tailwindcss() vite plugin and sets esbuild.jsx = "automatic".`,
        );
      }
    }
    if (!main.includes("staticDirs") && fontFiles.size > 0) {
      const anchor = /("framework":\s*"[^"]+"),?/;
      if (anchor.test(main)) {
        main = main.replace(anchor, `$1,\n  "staticDirs": ["../public"],`);
        changed = true;
      }
    }
    if (changed) {
      writeFileSync(mainPath, main, "utf-8");
      result.patched.push(mainPath.slice(outDir.length + 1));
    }
  } else {
    result.manualSteps.push(
      "No .storybook/main.js|ts found to patch — add the tailwind vite plugin and esbuild.jsx='automatic' manually.",
    );
  }

  // ---- Patch preview.jsx: import + theme decorator -------------------------
  const previewPath = ["preview.jsx", "preview.js", "preview.tsx", "preview.ts"]
    .map((f) => join(sbDir, f))
    .find(existsSync);
  // Mode names come from the extracted tokens when available.
  const modes = readModeNames(outDir) ?? ["dark", "light"];
  if (previewPath && /\.(jsx|tsx)$/.test(previewPath)) {
    let preview = readFileSync(previewPath, "utf-8");
    let changed = false;
    if (!preview.includes("preview.css")) {
      preview = `import "./preview.css";\n${preview}`;
      changed = true;
    }
    if (!preview.includes("data-theme") && modes.length > 1) {
      const decorator = generateThemeDecorator(modes);
      preview = preview.replace(
        /const preview = \{/,
        `${decorator.helper}\nconst preview = {\n${decorator.previewFields}`,
      );
      if (preview.includes("withTheme")) changed = true;
      else
        result.manualSteps.push(
          "Could not inject the theme decorator (preview.jsx has a non-stock shape) — add a decorator that sets both a mode class and data-theme on a wrapper.",
        );
    }
    if (changed) {
      writeFileSync(previewPath, preview, "utf-8");
      result.patched.push(previewPath.slice(outDir.length + 1));
    }
  } else if (previewPath) {
    result.manualSteps.push(
      `${previewPath} is not JSX — rename to preview.jsx (or add the theme decorator manually) and import "./preview.css".`,
    );
  }

  return result;
}

function readModeNames(outDir: string): string[] | null {
  try {
    const doc = JSON.parse(
      readFileSync(join(outDir, ".extraction", "tokens-modes.json"), "utf-8"),
    );
    return Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

function generateThemeDecorator(modes: string[]): {
  helper: string;
  previewFields: string;
} {
  const items = modes
    .map((mode) => `          { value: ${JSON.stringify(mode)}, title: ${JSON.stringify(mode)} },`)
    .join("\n");
  const helper = [
    "// Theme decorator generated by figma_ds_setup_storybook: applies BOTH a",
    "// mode class and data-theme, so generated tokens (.dark) and rules ported",
    "// verbatim from the app ([data-theme='...']) resolve either way.",
    "const withTheme = (Story, context) => {",
    `  const theme = context.globals.theme ?? ${JSON.stringify(modes[0])};`,
    "  return (",
    '    <div className={theme === "dark" ? "dark" : undefined} data-theme={theme}',
    '      style={{ background: "var(--sl-bg, var(--bg, inherit))", color: "var(--sl-fg, var(--fg, inherit))", padding: 32, minHeight: "100vh", boxSizing: "border-box" }}>',
    "      <Story />",
    "    </div>",
    "  );",
    "};",
    "",
  ].join("\n");
  const previewFields = [
    "  globalTypes: {",
    "    theme: {",
    '      description: "Token mode",',
    '      toolbar: { title: "Theme", icon: "circlehollow", dynamicTitle: true,',
    "        items: [",
    items,
    "        ],",
    "      },",
    "    },",
    "  },",
    `  initialGlobals: { theme: ${JSON.stringify(modes[0])} },`,
    "  decorators: [withTheme],",
  ].join("\n");
  return { helper, previewFields };
}
