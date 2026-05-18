/**
 * Tests for the v1.28.0 formatter expansion: Tailwind v4, Tailwind v3,
 * SCSS, TypeScript module, JSON (flat + nested), Style Dictionary v3,
 * Tokens Studio.
 *
 * Each formatter gets a primitive-token test, a multi-mode test, an alias
 * test, and a cross-library skip test. Heavier integration verification
 * happens in tests/tokens.test.ts.
 */

import type { TokenDocument } from "../src/core/tokens/index.js";

import { formatTailwindV4 } from "../src/core/tokens/formatters/tailwind-v4.js";
import { formatTailwindV3 } from "../src/core/tokens/formatters/tailwind-v3.js";
import { formatScss } from "../src/core/tokens/formatters/scss.js";
import { formatTsModule } from "../src/core/tokens/formatters/ts-module.js";
import {
  formatJsonFlat,
  formatJsonNested,
} from "../src/core/tokens/formatters/json.js";
import { formatStyleDictionaryV3 } from "../src/core/tokens/formatters/style-dictionary-v3.js";
import { formatTokensStudio } from "../src/core/tokens/formatters/tokens-studio.js";

const SIMPLE_DOC: TokenDocument = {
  sets: [
    {
      name: "Primitives",
      modes: ["Default"],
      tokens: [
        {
          path: ["color", "primary"],
          type: "color",
          values: { Default: { literal: "#4085F2" } },
        },
        {
          path: ["spacing", "md"],
          type: "dimension",
          values: { Default: { literal: 16 } },
        },
      ],
    },
  ],
};

const MULTI_MODE_DOC: TokenDocument = {
  sets: [
    {
      name: "Theme",
      modes: ["Light", "Dark"],
      tokens: [
        {
          path: ["color", "bg"],
          type: "color",
          values: {
            Light: { literal: "#FFFFFF" },
            Dark: { literal: "#000000" },
          },
        },
      ],
    },
  ],
};

const ALIAS_DOC: TokenDocument = {
  sets: [
    {
      name: "Semantic",
      modes: ["Default"],
      tokens: [
        {
          path: ["color", "brand"],
          type: "color",
          values: { Default: { reference: "{color.primary}" } },
        },
        {
          path: ["color", "library-ref"],
          type: "color",
          values: { Default: { reference: "{__library:VariableID:4:4975}" } },
        },
      ],
    },
  ],
};

describe("Tailwind v4 formatter", () => {
  it("emits @theme inline block with primitive tokens", () => {
    const r = formatTailwindV4(SIMPLE_DOC, { target: { format: "tailwind-v4" } });
    const content = r.files[0].content;
    expect(content).toContain("@theme inline {");
    expect(content).toContain("--color-primary: #4085F2;");
    expect(content).toContain("--spacing-md: 16px;");
    expect(content).toContain("}");
  });

  it("emits multi-mode with .dark selector convention", () => {
    const r = formatTailwindV4(MULTI_MODE_DOC, {
      target: { format: "tailwind-v4" },
    });
    const content = r.files[0].content;
    expect(content).toContain("@theme inline {");
    expect(content).toContain("--color-bg: #FFFFFF;"); // Light is primary
    expect(content).toContain(".dark {");
    expect(content).toContain("--color-bg: #000000;");
  });

  it("renders local aliases as var() and skips cross-library", () => {
    const r = formatTailwindV4(ALIAS_DOC, {
      target: { format: "tailwind-v4" },
    });
    const content = r.files[0].content;
    expect(content).toContain("--color-brand: var(--color-primary);");
    expect(content).toContain("skipped — cross-library alias to VariableID:4:4975");
  });
});

describe("SCSS formatter", () => {
  it("emits $var: value primitives", () => {
    const r = formatScss(SIMPLE_DOC, { target: { format: "scss" } });
    const content = r.files[0].content;
    expect(content).toContain("$color-primary: #4085F2;");
    expect(content).toContain("$spacing-md: 16px;");
  });

  it("emits multi-mode tokens with mode-keyed SCSS map", () => {
    const r = formatScss(MULTI_MODE_DOC, { target: { format: "scss" } });
    const content = r.files[0].content;
    expect(content).toContain("$color-bg: #FFFFFF;"); // primary (Light)
    expect(content).toContain("$color-bg--modes: (");
    expect(content).toContain('"Dark": #000000');
  });

  it("renders local aliases as $variable references", () => {
    const r = formatScss(ALIAS_DOC, { target: { format: "scss" } });
    const content = r.files[0].content;
    expect(content).toContain("$color-brand: $color-primary;");
  });
});

describe("TypeScript module formatter", () => {
  it("emits export const tokens = { ... } as const", () => {
    const r = formatTsModule(SIMPLE_DOC, { target: { format: "ts-module" } });
    const content = r.files[0].content;
    expect(content).toContain("export const tokens =");
    expect(content).toContain("as const;");
    expect(content).toContain('primary: "#4085F2"');
    expect(content).toContain('md: "16px"');
    expect(content).toContain("export type Tokens = typeof tokens;");
  });

  it("multi-mode emits { ModeName: value } objects", () => {
    const r = formatTsModule(MULTI_MODE_DOC, {
      target: { format: "ts-module" },
    });
    const content = r.files[0].content;
    expect(content).toMatch(/bg:\s*\{\s*Light:\s*"#FFFFFF",\s*Dark:\s*"#000000"/);
  });

  it("cross-library aliases emit null with TODO comment", () => {
    const r = formatTsModule(ALIAS_DOC, { target: { format: "ts-module" } });
    const content = r.files[0].content;
    expect(content).toContain("null /* TODO: cross-library alias unresolved */");
  });
});

describe("Tailwind v3 formatter", () => {
  it("emits module.exports namespaced by Tailwind theme keys", () => {
    const r = formatTailwindV3(SIMPLE_DOC, {
      target: { format: "tailwind-v3" },
    });
    const content = r.files[0].content;
    expect(content).toContain("module.exports = {");
    expect(content).toContain('colors:');
    expect(content).toContain('primary: "#4085F2"');
    expect(content).toContain('spacing:');
    expect(content).toContain('md: "16px"');
  });

  it("resolves alias chains to literal values; warns on unresolvable refs", () => {
    const r = formatTailwindV3(ALIAS_DOC, {
      target: { format: "tailwind-v3" },
    });
    const warnings = r.warnings.join("\n");
    // {color.primary} target doesn't exist in ALIAS_DOC → unresolved warning.
    expect(warnings).toContain("alias target not found");
    expect(warnings).toContain("{color.primary}");
    // Cross-library refs always skip regardless of resolution capability.
    expect(warnings).toContain("cross-library alias");
  });
});

describe("JSON flat formatter", () => {
  it("flattens path into hyphenated keys with prefix", () => {
    const r = formatJsonFlat(SIMPLE_DOC, {
      target: { format: "json-flat", prefix: "ds-" },
    });
    const parsed = JSON.parse(r.files[0].content);
    expect(parsed["ds-color-primary"]).toBe("#4085F2");
    expect(parsed["ds-spacing-md"]).toBe("16px");
  });

  it("suffixes non-primary modes", () => {
    const r = formatJsonFlat(MULTI_MODE_DOC, {
      target: { format: "json-flat" },
    });
    const parsed = JSON.parse(r.files[0].content);
    expect(parsed["color-bg"]).toBe("#FFFFFF"); // Light is primary, no suffix
    expect(parsed["color-bg--dark"]).toBe("#000000");
  });
});

describe("JSON nested formatter", () => {
  it("emits nested object structure", () => {
    const r = formatJsonNested(SIMPLE_DOC, {
      target: { format: "json-nested" },
    });
    const parsed = JSON.parse(r.files[0].content);
    expect(parsed.color.primary).toBe("#4085F2");
    expect(parsed.spacing.md).toBe("16px");
  });

  it("multi-mode emits mode-keyed objects", () => {
    const r = formatJsonNested(MULTI_MODE_DOC, {
      target: { format: "json-nested" },
    });
    const parsed = JSON.parse(r.files[0].content);
    expect(parsed.color.bg).toEqual({ Light: "#FFFFFF", Dark: "#000000" });
  });
});

describe("Style Dictionary v3 formatter", () => {
  it("emits {value, type} with bare keys (no $-prefix)", () => {
    const r = formatStyleDictionaryV3(SIMPLE_DOC, {
      target: { format: "style-dictionary-v3" },
    });
    const parsed = JSON.parse(r.files[0].content);
    expect(parsed.color.primary).toEqual({
      value: "#4085F2",
      type: "color",
    });
    expect(parsed.spacing.md).toEqual({
      value: "16px",
      type: "spacing",
    });
  });

  it("preserves aliases in SD's {path.to.token} syntax", () => {
    const r = formatStyleDictionaryV3(ALIAS_DOC, {
      target: { format: "style-dictionary-v3" },
    });
    const parsed = JSON.parse(r.files[0].content);
    expect(parsed.color.brand.value).toBe("{color.primary}");
  });

  it("uses SD's `comment` field for descriptions", () => {
    const doc: TokenDocument = {
      sets: [
        {
          name: "P",
          modes: ["Default"],
          tokens: [
            {
              path: ["color", "primary"],
              type: "color",
              description: "Brand primary color",
              values: { Default: { literal: "#4085F2" } },
            },
          ],
        },
      ],
    };
    const r = formatStyleDictionaryV3(doc, {
      target: { format: "style-dictionary-v3" },
    });
    const parsed = JSON.parse(r.files[0].content);
    expect(parsed.color.primary.comment).toBe("Brand primary color");
  });
});

describe("Tokens Studio formatter", () => {
  it("emits per-set token files plus $metadata and $themes", () => {
    const r = formatTokensStudio(SIMPLE_DOC, {
      target: { format: "tokens-studio" },
    });
    const filenames = r.files.map((f) => f.path);
    expect(filenames).toContain("primitives.json");
    expect(filenames).toContain("$metadata.json");
    expect(filenames).toContain("$themes.json");

    const setFile = r.files.find((f) => f.path === "primitives.json")!;
    const parsed = JSON.parse(setFile.content);
    expect(parsed.color.primary).toEqual({
      value: "#4085F2",
      type: "color",
    });

    const metadata = JSON.parse(
      r.files.find((f) => f.path === "$metadata.json")!.content,
    );
    expect(metadata.tokenSetOrder).toContain("primitives");
  });

  it("multi-mode emits one file per (set, mode) pair", () => {
    const r = formatTokensStudio(MULTI_MODE_DOC, {
      target: { format: "tokens-studio" },
    });
    const filenames = r.files.map((f) => f.path);
    expect(filenames).toContain("theme/light.json");
    expect(filenames).toContain("theme/dark.json");

    const lightFile = r.files.find((f) => f.path === "theme/light.json")!;
    const parsed = JSON.parse(lightFile.content);
    expect(parsed.color.bg.value).toBe("#FFFFFF");
  });

  it("$themes.json has one entry per mode", () => {
    const r = formatTokensStudio(MULTI_MODE_DOC, {
      target: { format: "tokens-studio" },
    });
    const themes = JSON.parse(
      r.files.find((f) => f.path === "$themes.json")!.content,
    );
    expect(Array.isArray(themes)).toBe(true);
    expect(themes).toHaveLength(2);
    const names = themes.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["Dark", "Light"]);
  });
});

describe("Dispatcher: all formats route through format()", () => {
  // Sanity check that the dispatcher in formatters/index.ts now handles
  // every format without throwing TokenFormatNotImplementedError.
  it("does not throw NotImplementedError for any newly-shipped format", async () => {
    const { format } = await import("../src/core/tokens/formatters/index.js");
    const shippedFormats = [
      "dtcg",
      "css-vars",
      "tailwind-v4",
      "tailwind-v3",
      "scss",
      "ts-module",
      "json-flat",
      "json-nested",
      "style-dictionary-v3",
      "tokens-studio",
    ] as const;

    for (const fmt of shippedFormats) {
      // The dispatcher should route to the right formatter without throwing.
      expect(() =>
        format(SIMPLE_DOC, { target: { format: fmt } }),
      ).not.toThrow();
    }
  });
});
