/**
 * Tests for the Design System Extraction feature (figma_ds_* tools).
 *
 * Runs the real analyzers against fixture mini-apps in
 * tests/fixtures/extraction/:
 *   - shadcn-app: Next/React + Tailwind v3 + shadcn-style vendored Button
 *     (CVA + Radix), bespoke Card, shadcn HSL triples with a .dark theme,
 *     tailwind.config theme.extend values, and a recurring raw color.
 *   - css-modules-app: React + CSS Modules with a var() alias chain.
 *
 * The load-bearing invariant: extracted DTCG output must round-trip through
 * parseDtcg (the same parser figma_import_tokens uses), so codebase-extracted
 * tokens are importable into Figma variables unchanged.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkFiles } from "../src/core/extraction/walker.js";
import { analyzeTargets } from "../src/core/extraction/analyzer.js";
import {
  extractTokens,
  normalizeColor,
  hslToHex,
  mineTailwindConfig,
} from "../src/core/extraction/token-extractor.js";
import {
  scaffoldDesignSystem,
  generateStoryScaffold,
  generateTokenShowcaseMdx,
  generateTypographyShowcaseMdx,
  generateIconShowcaseMdx,
} from "../src/core/extraction/scaffolder.js";
import { formatDtcg } from "../src/core/tokens/formatters/dtcg.js";
import { parseDtcg } from "../src/core/tokens/parsers/dtcg.js";
import type { DsComponentEntry } from "../src/core/extraction/types.js";

const SHADCN_APP = join(__dirname, "fixtures/extraction/shadcn-app");
const CSS_MODULES_APP = join(__dirname, "fixtures/extraction/css-modules-app");
const ASTRO_APP = join(__dirname, "fixtures/extraction/astro-app");

function walkTarget(root: string) {
  return walkFiles(root, {
    extensions: [".css", ".scss", ".tsx", ".jsx", ".ts", ".js", ".astro"],
  }).files;
}

describe("codebase analysis (figma_ds_analyze core)", () => {
  const analysis = analyzeTargets([SHADCN_APP], {
    outDir: join(SHADCN_APP, "design-system"),
  });

  it("detects framework, styling method, and vendor layers", () => {
    const target = analysis.targets[0];
    expect(target.frameworks).toEqual(
      expect.arrayContaining(["next", "react"]),
    );
    expect(target.stylingMethods).toContain("tailwind-v3");
    const libNames = target.componentLibraries.map((l) => l.name);
    expect(libNames).toContain("shadcn/ui");
    expect(libNames).toContain("Radix UI");
    expect(libNames).toContain("CVA (class-variance-authority)");
  });

  it("inventories the shadcn Button (deferred export) as vendored", () => {
    const button = analysis.components.find((c) => c.name === "Button");
    expect(button).toBeDefined();
    expect(button!.classification).toBe("vendored");
    expect(button!.file).toBe("components/ui/button.tsx");
    expect(button!.props.map((p) => p.name)).toContain("asChild");
  });

  it("inventories the bespoke Card with props and usage", () => {
    const card = analysis.components.find((c) => c.name === "Card");
    expect(card).toBeDefined();
    expect(card!.classification).toBe("bespoke");
    const title = card!.props.find((p) => p.name === "title");
    expect(title?.required).toBe(true);
    const elevated = card!.props.find((p) => p.name === "elevated");
    expect(elevated?.required).toBe(false);
    expect(card!.usage.tagCount).toBeGreaterThanOrEqual(2);
  });

  it("observes real call-site prop values for variant inference", () => {
    const button = analysis.components.find((c) => c.name === "Button");
    expect(button!.observedProps?.variant).toEqual(
      expect.arrayContaining(["outline", "ghost"]),
    );
    expect(button!.observedProps?.size).toEqual(
      expect.arrayContaining(["sm", "lg"]),
    );
  });

  it("ranks components by usage", () => {
    const names = analysis.components.map((c) => c.name);
    // Button (4 usages) should rank above Card (2 usages).
    expect(names.indexOf("Button")).toBeLessThan(names.indexOf("Card"));
  });

  it("merges multi-target inventories and flags cross-app scope", () => {
    const multi = analyzeTargets([SHADCN_APP, CSS_MODULES_APP], {
      outDir: join(SHADCN_APP, "design-system"),
    });
    expect(multi.targets).toHaveLength(2);
    expect(
      multi.components.some((c) => c.name === "Badge" && c.targetIndex === 1),
    ).toBe(true);
  });
});

describe("token extraction (figma_ds_extract_tokens core)", () => {
  it("converts colors to canonical hex", () => {
    expect(normalizeColor("#ABC")).toBe("#aabbcc");
    expect(normalizeColor("rgb(59, 130, 246)")).toBe("#3b82f6");
    expect(normalizeColor("hsl(217, 91%, 60%)")).toMatch(/^#[0-9a-f]{6}$/);
    expect(normalizeColor("222.2 47.4% 11.2%")).toMatch(/^#[0-9a-f]{6}$/);
    expect(normalizeColor("16px")).toBeNull();
    expect(hslToHex(0, 100, 50)).toBe("#ff0000");
  });

  const result = extractTokens(walkTarget(SHADCN_APP), { minFrequency: 3 });

  it("extracts shadcn HSL triples as multi-mode color tokens", () => {
    const semantic = result.document.sets.find((s) => s.name === "Semantic");
    expect(semantic).toBeDefined();
    expect(semantic!.modes).toEqual(["Light", "Dark"]);
    const primary = semantic!.tokens.find((t) => t.path.join("/") === "primary");
    expect(primary).toBeDefined();
    expect(primary!.type).toBe("color");
    expect(String(primary!.values.Light.literal)).toMatch(/^#[0-9a-f]{6}$/);
    // Dark value differs from light (theme flips in .dark).
    expect(primary!.values.Dark.literal).not.toBe(primary!.values.Light.literal);
  });

  it("mines tailwind.config theme values without executing unsafe code", () => {
    const configText = readFileSync(
      join(SHADCN_APP, "tailwind.config.js"),
      "utf-8",
    );
    const mined = mineTailwindConfig(configText, "tailwind.config.js");
    const byName = Object.fromEntries(mined.map((v) => [v.name, v.value]));
    // Parse-don't-eval (config code is NEVER executed — review finding):
    // literal mining captures key/value pairs flat, quoted or bare keys.
    expect(byName["brand"]).toBe("#3b82f6");
    expect(byName["brand-dark"]).toBe("#1d4ed8");
    expect(byName["18"]).toBe("4.5rem");
    expect(byName["card"]).toBe("12px");
  });

  it("promotes recurring raw colors above the frequency threshold", () => {
    // #22c55e recurs 4x in CSS/JSX but is never declared as a variable;
    // #ff6b35 is declared (--accent-highlight) so it must NOT be re-promoted.
    const primitives = result.document.sets.find((s) => s.name === "Primitives");
    expect(
      primitives!.tokens.some(
        (t) =>
          t.values.Light?.literal === "#ff6b35" ||
          t.values.Default?.literal === "#ff6b35",
      ),
    ).toBe(false);
    const promoted = primitives!.tokens.find(
      (t) => t.values.Light?.literal === "#22c55e" || t.values.Default?.literal === "#22c55e",
    );
    expect(promoted).toBeDefined();
    const provenance = promoted!.extensions?.[
      "figma-console-mcp.extraction"
    ] as { confidence: string; frequency: number };
    expect(provenance.confidence).toBe("inferred");
    expect(provenance.frequency).toBeGreaterThanOrEqual(3);
  });

  it("carries provenance on declared tokens", () => {
    const semantic = result.document.sets.find((s) => s.name === "Semantic");
    const primary = semantic!.tokens.find((t) => t.path.join("/") === "primary");
    const provenance = primary!.extensions?.[
      "figma-console-mcp.extraction"
    ] as { confidence: string; sources: string[] };
    expect(provenance.confidence).toBe("declared");
    expect(provenance.sources[0]).toContain("globals.css");
  });

  it("turns var() chains into DTCG alias references", () => {
    const cssResult = extractTokens(walkTarget(CSS_MODULES_APP), {
      minFrequency: 99, // declared only
    });
    const semantic = cssResult.document.sets.find((s) => s.name === "Semantic");
    const primary = semantic!.tokens.find(
      (t) => t.path.join("/") === "color/primary",
    );
    expect(primary).toBeDefined();
    const value = Object.values(primary!.values)[0];
    expect(value.reference).toBe("color.blue.500");
  });

  it("round-trips through the DTCG parser used by figma_import_tokens", () => {
    const formatted = formatDtcg(result.document, {
      target: { format: "dtcg" },
    });
    expect(formatted.files).toHaveLength(1);
    const parsed = parseDtcg({
      payload: formatted.files[0].content,
      sourcePath: "tokens.json",
    });
    // Top-level groups become collections: Primitives + Semantic.
    expect(parsed.document.sets.map((s) => s.name).sort()).toEqual(
      ["Primitives", "Semantic"],
    );
    const tokenCount = (sets: typeof parsed.document.sets) =>
      sets.reduce((n, s) => n + s.tokens.length, 0);
    expect(tokenCount(parsed.document.sets)).toBe(
      tokenCount(result.document.sets),
    );
  });
});

describe("Astro support (v1.1)", () => {
  const analysis = analyzeTargets([ASTRO_APP], {
    outDir: join(ASTRO_APP, "design-system"),
  });

  it("detects astro + tailwind-v4 and inventories .astro components with props", () => {
    expect(analysis.targets[0].frameworks).toContain("astro");
    expect(analysis.targets[0].stylingMethods).toContain("tailwind-v4");

    const button = analysis.components.find((c) => c.name === "Button");
    expect(button).toBeDefined();
    expect(button!.framework).toBe("astro");
    expect(button!.file).toBe("src/components/Button.astro");
    const label = button!.props.find((p) => p.name === "label");
    expect(label?.required).toBe(true);
    const kind = button!.props.find((p) => p.name === "kind");
    expect(kind?.defaultValue).toBe("'primary'");
    // Pages are not components.
    expect(analysis.components.some((c) => c.name === "Index")).toBe(false);
  });

  it("counts usage and observes variant values from .astro call sites", () => {
    const button = analysis.components.find((c) => c.name === "Button");
    expect(button!.usage.tagCount).toBeGreaterThanOrEqual(3);
    expect(button!.observedProps?.kind).toEqual(
      expect.arrayContaining(["primary", "ghost"]),
    );
  });

  it("collects iconography: svg files and inline-svg components", () => {
    const icons = analysis.targets[0].icons;
    expect(icons.some((i) => i.name === "arrow" && i.source === "svg-file")).toBe(true);
    expect(icons.some((i) => i.name === "Logo" && i.source === "inline-svg")).toBe(true);
  });

  it("mines the typography hierarchy (h1, .lead, .eyebrow)", () => {
    const typo = analysis.targets[0].typography;
    const h1 = typo.find((r) => r.selector === "h1");
    expect(h1?.properties["font-size"]).toBe("var(--sl-text-h1)");
    expect(typo.some((r) => r.selector === ".lead")).toBe(true);
    expect(
      typo.find((r) => r.selector === ".eyebrow")?.properties["text-transform"],
    ).toBe("uppercase");
  });

  it("extracts data-theme dark/light as multi-mode semantic aliases", () => {
    const result = extractTokens(walkTarget(ASTRO_APP), { minFrequency: 99 });
    const semantic = result.document.sets.find((s) => s.name === "Semantic");
    expect(semantic).toBeDefined();
    expect(semantic!.modes).toEqual(["Light", "Dark"]);
    const bg = semantic!.tokens.find((t) => t.path.join("/") === "sl/bg");
    expect(bg).toBeDefined();
    expect(bg!.values.Dark.reference).toBe("sl.color.ink.900");
    expect(bg!.values.Light.reference).toBe("sl.color.paper.100");
    // Font stack typed as fontFamily despite non-standard --sl-font-* naming.
    const primitives = result.document.sets.find((s) => s.name === "Primitives");
    const display = primitives!.tokens.find(
      (t) => t.path.join("/") === "sl/font/display",
    );
    expect(display?.type).toBe("fontFamily");
    // Component <style> blocks are mined too: border-radius: 999px recurs
    // twice inside Button.astro's <style> and promotes at minFrequency 2.
    const lowBar = extractTokens(walkTarget(ASTRO_APP), { minFrequency: 2 });
    const primsLow = lowBar.document.sets.find((s) => s.name === "Primitives");
    expect(
      primsLow!.tokens.some((t) => t.path.join("/") === "radius/999px"),
    ).toBe(true);
  });

  it("generates Typography and Icons showcase MDX", () => {
    const result = extractTokens(walkTarget(ASTRO_APP), { minFrequency: 99 });
    const typographyMdx = generateTypographyShowcaseMdx(
      result.document,
      analysis.targets[0].typography,
    );
    expect(typographyMdx).toContain('<Meta title="Design Tokens/Typography" />');
    expect(typographyMdx).toContain("Applied hierarchy");
    expect(typographyMdx).toContain("h1");

    const iconsMdx = generateIconShowcaseMdx(
      analysis.targets[0].icons.map((icon) => ({ icon, root: ASTRO_APP })),
    );
    expect(iconsMdx).toContain('<Meta title="Design Tokens/Iconography" />');
    expect(iconsMdx).toContain("arrow");
    // Static inline svg from Logo.astro is renderable.
    expect(iconsMdx).toContain("dangerouslySetInnerHTML");
  });
});

describe("multi-framework variable modes (v1.2)", () => {
  it("classifies theme headers across framework conventions", async () => {
    const { classifyThemeHeader } = await import(
      "../src/core/extraction/token-extractor.js"
    );
    expect(classifyThemeHeader(":root")).toBe("light");
    expect(classifyThemeHeader("@theme inline ")).toBe("light");
    expect(classifyThemeHeader("[data-theme='dark'] ")).toBe("dark");
    expect(classifyThemeHeader('[data-theme="sepia"] ')).toBe("sepia");
    expect(classifyThemeHeader("[data-mode='high-contrast'] ")).toBe("high-contrast");
    expect(classifyThemeHeader(".dark ")).toBe("dark");
    expect(classifyThemeHeader(".dark-mode ")).toBe("dark"); // Nuxt color-mode
    expect(classifyThemeHeader(".light-mode ")).toBe("light");
    expect(classifyThemeHeader(".theme-ocean ")).toBe("ocean");
    expect(classifyThemeHeader("@media (prefers-color-scheme: dark) ")).toBe("dark");
    expect(classifyThemeHeader("@media (prefers-color-scheme: light) ")).toBe("light");
  });

  it("assembles N named modes with base-value fallback", async () => {
    const { mineCssCustomProps } = await import(
      "../src/core/extraction/token-extractor.js"
    );
    const css = `
:root { --brand: #111111; --spacing-unit: 4px; }
[data-theme='dark'] { --brand: #eeeeee; }
[data-theme='sepia'] { --brand: #704214; }
`;
    const mined = mineCssCustomProps(css, "theme.css");
    const brandModes = mined.filter((v) => v.name === "brand").map((v) => v.mode);
    expect(brandModes.sort()).toEqual(["dark", "light", "sepia"]);

    // Full pipeline over a temp fixture: three modes, fallback for the
    // un-overridden token.
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "modes-"));
    try {
      writeFileSync(join(dir, "theme.css"), css);
      const files = walkFiles(dir, { extensions: [".css"] }).files;
      const result = extractTokens(files, { minFrequency: 99 });
      const allTokens = result.document.sets.flatMap((s) => s.tokens);
      for (const s of result.document.sets) {
        expect(s.modes).toEqual(["Light", "Dark", "Sepia"]);
      }
      // "brand" is role-named → Semantic set; spacing stays in Primitives.
      const brand = allTokens.find((t) => t.path.join("/") === "brand");
      expect(brand!.values.Dark.literal).toBe("#eeeeee");
      expect(brand!.values.Sepia.literal).toBe("#704214");
      const spacing = allTokens.find((t) => t.path.join("/") === "spacing/unit");
      // Not overridden in any theme → base value in every mode.
      expect(spacing!.values.Dark.literal).toBe("4px");
      expect(spacing!.values.Sepia.literal).toBe("4px");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("architecture classification (UI kit → design system)", () => {
  it("detects specializations, levels, and missing primitives", async () => {
    const { classifyArchitecture } = await import(
      "../src/core/extraction/architecture.js"
    );
    const mk = (name: string) =>
      ({
        name,
        targetIndex: 0,
        framework: "react",
        classification: "bespoke",
        props: [],
        usage: { importCount: 1, tagCount: 1, files: [] },
      }) as never;
    // These are INVENTED example inputs, not a list the tool knows about.
    // The classifier carries no product names — only the canonical generic
    // vocabulary (button/card/menu/...) — and matches by SUFFIX pattern, so
    // <AnyDomainWord>Button → Button for any domain word, unbounded. The
    // design-system component stays generic; the qualifier is the usage.
    const arch = classifyArchitecture([
      mk("SubscribeButton"),
      mk("AdminMenu"),
      mk("InvoiceCard"),
      mk("Avatar"),
      mk("ActionBar"),
      mk("OnboardingCanvas"),
      mk("CheckoutPage"),
    ]);
    // SubscribeButton is a subscribe USAGE of a generic Button — none exists.
    const sub = arch.specializations.find((s) => s.component === "SubscribeButton");
    expect(sub?.genericOf).toBe("Button");
    expect(sub?.qualifier).toBe("subscribe");
    expect(arch.missingPrimitives).toContain("Button");
    expect(arch.missingPrimitives).toContain("Menu");
    expect(arch.missingPrimitives).toContain("Card");
    // Avatar is already generic — no specialization entry for it.
    expect(arch.specializations.some((s) => s.component === "Avatar")).toBe(false);
    expect(arch.levels["Avatar"]).toBe("atom");
    expect(arch.levels["AdminMenu"]).toBe("molecule");
    expect(arch.levels["OnboardingCanvas"]).toBe("organism");
    expect(arch.levels["ActionBar"]).toBe("molecule");
    expect(arch.levels["CheckoutPage"]).toBe("template");
  });
});

describe("Tailwind utility-class frequency mining (v1.3)", () => {
  it("translates counted utilities into tokens valued from the app's theme", async () => {
    const { parseTailwindTheme, scanUtilityClasses, utilityToMinedVar } =
      await import("../src/core/extraction/token-extractor.js");
    const theme = parseTailwindTheme(`
@theme {
  --color-zinc-900: oklch(21% 0.006 285.885);
  --radius-lg: 0.5rem;
  --text-sm: 0.875rem;
  --font-weight-semibold: 600;
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1);
}
`);
    const acc = new Map<string, number>();
    scanUtilityClasses(
      `<div className="bg-zinc-900 hover:bg-zinc-900 md:p-4 rounded-lg text-sm font-semibold shadow-md flex">
       <span className={\`p-4 text-sm bg-zinc-900\`} />`,
      acc,
    );
    // Variant prefixes stripped and merged into the base utility count.
    expect(acc.get("bg-zinc-900")).toBe(3);
    expect(acc.get("p-4")).toBe(2);

    expect(utilityToMinedVar("bg-zinc-900", 3, theme)).toMatchObject({
      name: "color-zinc-900",
      value: "oklch(21% 0.006 285.885)",
      inferred: true,
      frequency: 3,
    });
    expect(utilityToMinedVar("p-4", 2, theme)).toMatchObject({
      name: "spacing-4",
      value: "1rem",
    });
    expect(utilityToMinedVar("rounded-lg", 5, theme)?.value).toBe("0.5rem");
    expect(utilityToMinedVar("text-sm", 5, theme)?.name).toBe("font-size-sm");
    expect(utilityToMinedVar("font-semibold", 5, theme)?.value).toBe("600");
    expect(utilityToMinedVar("shadow-md", 5, theme)?.name).toBe("shadow-md");
    // Non-design and unknown-in-theme utilities are ignored.
    expect(utilityToMinedVar("flex", 9, theme)).toBeNull();
    expect(utilityToMinedVar("bg-notacolor-900", 9, theme)).toBeNull();
  });
});

describe("CSS expression values survive formatting unquoted", () => {
  // Regression: quoted cubic-bezier/calc values invalidate every declaration
  // that consumes the variable (killed a button hover transition live).
  const doc = {
    sets: [
      {
        name: "Primitives",
        modes: ["Default"],
        tokens: [
          {
            path: ["sl", "ease", "out"],
            type: "string" as const,
            values: { Default: { literal: "cubic-bezier(0.22, 1, 0.36, 1)" } },
          },
          {
            path: ["sl", "section", "gap"],
            type: "string" as const,
            values: {
              Default: { literal: "calc(clamp(6rem, 8vw, 10rem) * var(--sl-space-factor))" },
            },
          },
          {
            path: ["brand", "name"],
            type: "string" as const,
            values: { Default: { literal: "South Left Studio" } },
          },
        ],
      },
    ],
  };

  it("css-vars, scss, and tailwind-v4 leave CSS functions unquoted but quote real strings", async () => {
    const { formatCssVars } = await import(
      "../src/core/tokens/formatters/css-vars.js"
    );
    const { formatScss } = await import("../src/core/tokens/formatters/scss.js");
    const { formatTailwindV4 } = await import(
      "../src/core/tokens/formatters/tailwind-v4.js"
    );
    for (const fmt of [
      formatCssVars(doc as never, { target: { format: "css-vars" } }),
      formatScss(doc as never, { target: { format: "scss" } }),
      formatTailwindV4(doc as never, { target: { format: "tailwind-v4" } }),
    ]) {
      const out = fmt.files.map((f: { content: string }) => f.content).join("\n");
      expect(out).toContain("cubic-bezier(0.22, 1, 0.36, 1)");
      expect(out).not.toContain('"cubic-bezier');
      expect(out).not.toContain('"calc(');
      expect(out).toContain('"South Left Studio"');
    }
  });
});

describe("scaffolding (figma_ds_scaffold core)", () => {
  let outDir: string;

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "ds-scaffold-"));
  });
  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("generates the package skeleton, token files, and showcase", () => {
    const analysis = analyzeTargets([SHADCN_APP], { outDir });
    const extraction = extractTokens(walkTarget(SHADCN_APP), {
      minFrequency: 3,
    });
    const result = scaffoldDesignSystem(analysis, extraction.document, {
      outDir,
      packageName: "@acme/design-system",
      framework: "react",
      formats: ["dtcg", "css-vars"],
    });

    expect(existsSync(join(outDir, "package.json"))).toBe(true);
    expect(existsSync(join(outDir, "tokens/tokens.json"))).toBe(true);
    expect(existsSync(join(outDir, "tokens/tokens.css"))).toBe(true);
    expect(existsSync(join(outDir, "src/docs/Tokens.mdx"))).toBe(true);
    expect(existsSync(join(outDir, "README.md"))).toBe(true);
    expect(result.nextSteps.join(" ")).toContain("npm create storybook@latest");

    const pkg = JSON.parse(readFileSync(join(outDir, "package.json"), "utf-8"));
    expect(pkg.name).toBe("@acme/design-system");
    expect(pkg.peerDependencies.react).toBeDefined();

    // Scaffold is additive: second run skips existing files.
    const second = scaffoldDesignSystem(analysis, extraction.document, {
      outDir,
      packageName: "@acme/design-system",
      framework: "react",
      formats: ["dtcg", "css-vars"],
    });
    expect(second.filesSkipped).toContain("package.json");
  });

  it("token showcase MDX includes swatches and provenance note", () => {
    const extraction = extractTokens(walkTarget(SHADCN_APP), {
      minFrequency: 3,
    });
    const mdx = generateTokenShowcaseMdx(extraction.document);
    expect(mdx).toContain('<Meta title="Design Tokens/Overview" />');
    expect(mdx).toContain("## Semantic");
    expect(mdx).toContain("$extensions");
  });
});

describe("story scaffolds (figma_ds_extract_component core)", () => {
  it("generates variant stories from observed props for React", () => {
    const entry: DsComponentEntry = {
      name: "Button",
      file: "components/ui/button.tsx",
      targetIndex: 0,
      framework: "react",
      classification: "vendored",
      props: [{ name: "variant", required: false, type: "string" }],
      usage: { importCount: 1, tagCount: 4, files: [] },
      observedProps: { variant: ["ghost", "outline"], size: ["sm"] },
    };
    const story = generateStoryScaffold(entry);
    expect(story).toContain("satisfies Meta<typeof Button>");
    expect(story).toContain("tags: ['autodocs']");
    expect(story).toContain('variant: "ghost"');
    expect(story).toContain('variant: "outline"');
  });

  it("generates web-components stories with lit html tags", () => {
    const entry: DsComponentEntry = {
      name: "MyChip",
      file: "src/my-chip.ts",
      targetIndex: 0,
      framework: "web-components",
      classification: "bespoke",
      props: [],
      usage: { importCount: 0, tagCount: 0, files: [] },
    };
    const story = generateStoryScaffold(entry);
    expect(story).toContain("@storybook/web-components-vite");
    expect(story).toContain("<my-chip>");
  });
});
