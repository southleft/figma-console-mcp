/**
 * Tests for DTCG 2025.10 dialect support in the token sync engine.
 *
 * Part A — import accepts BOTH dialects unconditionally:
 *   - tokenValueToFigma handles 2025 object-form colors (srgb components,
 *     hex fallback for non-srgb colorSpaces, clamping)
 *   - parseNumericLiteral covers dimension AND duration { value, unit }
 *     objects (via tokenValueToFigma FLOAT path)
 *   - diff comparison normalizes across dialects so a 2025 file doesn't
 *     report every color as toUpdate forever
 *   - the DTCG parser passes object $value literals through intact
 *
 * Part B — export opt-in 2025 dialect (default 'legacy' unchanged):
 *   - dtcg/json formatters emit object colors/dimensions in '2025' mode
 *   - round-trip (export → parse → diff) is unchanged in BOTH dialects
 */

import {
  convertFigmaVariablesToDocument,
  canonicalizeTokenValueForComparison,
  type TokenDocument,
} from "../src/core/tokens/index.js";
import { formatDtcg } from "../src/core/tokens/formatters/dtcg.js";
import {
  formatJsonFlat,
  formatJsonNested,
} from "../src/core/tokens/formatters/json.js";
import { parseDtcg } from "../src/core/tokens/parsers/dtcg.js";
import {
  computeDiffPlan,
  tokenValueToFigma,
} from "../src/core/tokens-tools.js";

/**
 * Representative Figma payload: full-precision + alpha colors, a color
 * alias, a FLOAT dimension, and a TIMING duration across two modes.
 */
function motionPayload() {
  return {
    collections: [
      {
        id: "c1",
        name: "Theme",
        modes: [
          { modeId: "m1", name: "Light" },
          { modeId: "m2", name: "Dark" },
        ],
        variableIds: ["v1", "v2", "v3", "v4"],
      },
    ],
    variables: [
      {
        id: "v1",
        name: "color/primary",
        resolvedType: "COLOR" as const,
        variableCollectionId: "c1",
        valuesByMode: {
          m1: { r: 0.25, g: 0.52, b: 0.95, a: 1 },
          // Alpha color — exercises the alpha field + 8-digit hex path.
          m2: { r: 0.1, g: 0.2, b: 0.3, a: 0.5 },
        },
      },
      {
        id: "v2",
        name: "spacing/md",
        resolvedType: "FLOAT" as const,
        variableCollectionId: "c1",
        valuesByMode: { m1: 16, m2: 16 },
      },
      {
        id: "v3",
        name: "color/brand",
        resolvedType: "COLOR" as const,
        variableCollectionId: "c1",
        valuesByMode: {
          m1: { type: "VARIABLE_ALIAS" as const, id: "v1" },
          m2: { type: "VARIABLE_ALIAS" as const, id: "v1" },
        },
      },
      {
        id: "v4",
        name: "motion/duration/quick/Timing",
        resolvedType: "TIMING" as const,
        variableCollectionId: "c1",
        valuesByMode: { m1: 0.3, m2: 0.3 },
      },
    ],
  };
}

describe("DTCG 2025.10 dialect", () => {
  // ==========================================================================
  // PART A1 — import: object-form colors in tokenValueToFigma
  // ==========================================================================
  describe("tokenValueToFigma with 2025 color objects", () => {
    it("converts srgb components to Figma rgba floats", () => {
      const result = tokenValueToFigma(
        {
          literal: {
            colorSpace: "srgb",
            components: [0.25, 0.52, 0.95],
            hex: "#4085F2",
          },
        },
        "COLOR",
      );
      expect(result).toEqual({
        kind: "value",
        value: { r: 0.25, g: 0.52, b: 0.95, a: 1 },
      });
    });

    it("honors the alpha field on srgb components", () => {
      const result = tokenValueToFigma(
        { literal: { colorSpace: "srgb", components: [0.1, 0.2, 0.3], alpha: 0.5 } },
        "COLOR",
      );
      expect(result).toEqual({
        kind: "value",
        value: { r: 0.1, g: 0.2, b: 0.3, a: 0.5 },
      });
    });

    it("clamps out-of-range components to [0, 1]", () => {
      const result = tokenValueToFigma(
        { literal: { colorSpace: "srgb", components: [-0.2, 1.4, 0.5], alpha: 2 } },
        "COLOR",
      );
      expect(result).toEqual({
        kind: "value",
        value: { r: 0, g: 1, b: 0.5, a: 1 },
      });
    });

    it("falls back to the hex field for non-srgb colorSpaces", () => {
      const result = tokenValueToFigma(
        {
          literal: {
            colorSpace: "display-p3",
            components: [0.9, 0.2, 0.3],
            hex: "#FF0000",
          },
        },
        "COLOR",
      );
      expect(result).toEqual({
        kind: "value",
        value: { r: 1, g: 0, b: 0, a: 1 },
      });
    });

    it("skips non-srgb colorSpaces without a hex fallback", () => {
      const result = tokenValueToFigma(
        { literal: { colorSpace: "oklch", components: [0.7, 0.1, 250] } },
        "COLOR",
      );
      expect(result.kind).toBe("skip-invalid");
      expect((result as { reason: string }).reason).toContain("oklch");
      expect((result as { reason: string }).reason).toContain("hex");
    });

    it("accepts objects with only a hex field", () => {
      const result = tokenValueToFigma({ literal: { hex: "#00FF00" } }, "COLOR");
      expect(result).toEqual({
        kind: "value",
        value: { r: 0, g: 1, b: 0, a: 1 },
      });
    });

    it("hex-fallback path applies the alpha field over the opaque hex", () => {
      const result = tokenValueToFigma(
        { literal: { colorSpace: "display-p3", hex: "#FF0000", alpha: 0.25 } },
        "COLOR",
      );
      expect(result).toEqual({
        kind: "value",
        value: { r: 1, g: 0, b: 0, a: 0.25 },
      });
    });

    it("skips unrecognizable color objects instead of stringifying them", () => {
      // Regression: this previously fell through to String(literal) →
      // "[object Object]" pushed at a COLOR variable.
      const result = tokenValueToFigma({ literal: { foo: "bar" } }, "COLOR");
      expect(result.kind).toBe("skip-invalid");
    });
  });

  // ==========================================================================
  // PART A2 — import: { value, unit } objects for FLOAT variables
  // ==========================================================================
  describe("FLOAT parsing of dimension/duration objects", () => {
    it("takes the raw value from dimension objects", () => {
      const result = tokenValueToFigma(
        { literal: { value: 16, unit: "px" } },
        "FLOAT",
      );
      expect(result).toEqual({ kind: "value", value: 16 });
    });

    it("takes the raw value from duration objects in ms", () => {
      const result = tokenValueToFigma(
        { literal: { value: 300, unit: "ms" } },
        "FLOAT",
      );
      expect(result).toEqual({ kind: "value", value: 300 });
    });

    it("converts seconds duration objects to milliseconds (agrees with diff canonicalization)", () => {
      // The diff side canonicalizes {0.3, "s"} ≡ {300, "ms"} ≡ 300; the
      // write path MUST agree, or the diff would report a change and apply
      // would write a 1000x-wrong raw value on every import, forever.
      const result = tokenValueToFigma(
        { literal: { value: 0.3, unit: "s" } },
        "FLOAT",
      );
      expect(result).toEqual({ kind: "value", value: 300 });
    });
  });

  // ==========================================================================
  // PART A3 — diff normalization across dialects
  // ==========================================================================
  describe("dialect-agnostic value comparison", () => {
    it("canonicalizes hex strings and 2025 color objects to the same form", () => {
      const fromHex = canonicalizeTokenValueForComparison({
        literal: "#4085F2",
        rawColor: { r: 0.25, g: 0.52, b: 0.95, a: 1 },
      });
      const fromObject = canonicalizeTokenValueForComparison({
        literal: {
          colorSpace: "srgb",
          components: [0.25, 0.52, 0.95],
          hex: "#4085F2",
        },
      });
      expect(fromHex).toEqual({ literal: "#4085f2ff" });
      expect(fromObject).toEqual({ literal: "#4085f2ff" });
    });

    it("tolerates 8-bit quantization between components-form and hex-form", () => {
      // 0.52 * 255 = 132.6 → rounds to 133 → 0x85. The full-precision float
      // must compare equal to the byte the hex string carries.
      const components = canonicalizeTokenValueForComparison({
        literal: { colorSpace: "srgb", components: [0.2501, 0.5199, 0.9502] },
      });
      const hex = canonicalizeTokenValueForComparison({ literal: "#4085F2" });
      expect(components).toEqual(hex);
    });

    it("equates { value, unit } dimension objects with bare numbers", () => {
      expect(
        canonicalizeTokenValueForComparison({ literal: { value: 16, unit: "px" } }),
      ).toEqual({ literal: 16 });
      expect(canonicalizeTokenValueForComparison({ literal: 16 })).toEqual({
        literal: 16,
      });
    });

    it("equates seconds and milliseconds duration objects", () => {
      expect(
        canonicalizeTokenValueForComparison({ literal: { value: 0.3, unit: "s" } }),
      ).toEqual(
        canonicalizeTokenValueForComparison({ literal: { value: 300, unit: "ms" } }),
      );
    });

    it("leaves unrecognized literals untouched (conservative fallback)", () => {
      expect(
        canonicalizeTokenValueForComparison({ literal: { value: 1.5, unit: "rem" } }),
      ).toEqual({ literal: { value: 1.5, unit: "rem" } });
      expect(canonicalizeTokenValueForComparison({ literal: "hello" })).toEqual({
        literal: "hello",
      });
      expect(
        canonicalizeTokenValueForComparison({ reference: "{color.primary}" }),
      ).toEqual({ reference: "{color.primary}" });
    });

    it("computeDiffPlan reports cross-dialect same-value tokens as unchanged", () => {
      const figmaSide: TokenDocument = {
        sets: [
          {
            name: "Primitives",
            modes: ["Default"],
            tokens: [
              {
                path: ["color", "primary"],
                type: "color",
                values: {
                  Default: {
                    literal: "#4085F2",
                    rawColor: { r: 0.25, g: 0.52, b: 0.95, a: 1 },
                  },
                },
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
      const codeSide: TokenDocument = {
        sets: [
          {
            name: "Primitives",
            modes: ["Default"],
            tokens: [
              {
                path: ["color", "primary"],
                type: "color",
                values: {
                  Default: {
                    literal: {
                      colorSpace: "srgb",
                      components: [0.25, 0.52, 0.95],
                      hex: "#4085F2",
                    },
                  },
                },
              },
              {
                path: ["spacing", "md"],
                type: "dimension",
                values: { Default: { literal: { value: 16, unit: "px" } } },
              },
            ],
          },
        ],
      };
      const diff = computeDiffPlan(figmaSide, codeSide);
      expect(diff.toCreate).toEqual([]);
      expect(diff.toUpdate).toEqual([]);
      expect(diff.toDelete).toEqual([]);
      expect(diff.unchanged).toBe(2);
    });

    it("computeDiffPlan still detects genuinely different colors across dialects", () => {
      const figmaSide: TokenDocument = {
        sets: [
          {
            name: "Primitives",
            modes: ["Default"],
            tokens: [
              {
                path: ["color", "primary"],
                type: "color",
                values: {
                  Default: {
                    literal: "#4085F2",
                    rawColor: { r: 0.25, g: 0.52, b: 0.95, a: 1 },
                  },
                },
              },
            ],
          },
        ],
      };
      const codeSide: TokenDocument = {
        sets: [
          {
            name: "Primitives",
            modes: ["Default"],
            tokens: [
              {
                path: ["color", "primary"],
                type: "color",
                values: {
                  Default: {
                    literal: { colorSpace: "srgb", components: [1, 0, 0] },
                  },
                },
              },
            ],
          },
        ],
      };
      const diff = computeDiffPlan(figmaSide, codeSide);
      expect(diff.toUpdate).toHaveLength(1);
      // rawColor is transient and must not leak into diff samples.
      expect(
        JSON.stringify(diff.toUpdate[0].before),
      ).not.toContain("rawColor");
    });
  });

  // ==========================================================================
  // PART A4 — parser passes object $value literals through intact
  // ==========================================================================
  describe("DTCG parser with 2025 object $values", () => {
    it("preserves color objects and dimension objects as literals", () => {
      const payload = JSON.stringify({
        primitives: {
          color: {
            primary: {
              $type: "color",
              $value: {
                colorSpace: "srgb",
                components: [0.25, 0.52, 0.95],
                hex: "#4085F2",
              },
            },
          },
          spacing: {
            md: {
              $type: "dimension",
              $value: { value: 16, unit: "px" },
            },
          },
        },
      });
      const parsed = parseDtcg({ payload });
      const tokens = parsed.document.sets[0].tokens;
      const color = tokens.find((t) => t.path.join("/") === "color/primary")!;
      expect(color.values.Default.literal).toEqual({
        colorSpace: "srgb",
        components: [0.25, 0.52, 0.95],
        hex: "#4085F2",
      });
      const spacing = tokens.find((t) => t.path.join("/") === "spacing/md")!;
      expect(spacing.values.Default.literal).toEqual({ value: 16, unit: "px" });
    });
  });

  // ==========================================================================
  // PART B — export dialect
  // ==========================================================================
  describe("dtcg formatter dialect", () => {
    it("default (legacy) emits hex strings and bare numbers — unchanged", () => {
      const { document } = convertFigmaVariablesToDocument(motionPayload());
      const out = formatDtcg(document, { target: { format: "dtcg" } });
      const content = out.files[0].content;
      expect(content).toContain('"$value": "#4085F2"');
      expect(content).toContain('"$value": 16');
      expect(content).not.toContain('"colorSpace"');
      // Transient rawColor never serializes.
      expect(content).not.toContain("rawColor");
    });

    it("2025 dialect emits object colors with full-precision components", () => {
      const { document } = convertFigmaVariablesToDocument(motionPayload());
      const out = formatDtcg(document, {
        target: { format: "dtcg", dtcgDialect: "2025" },
      });
      const parsed = JSON.parse(out.files[0].content);
      const primary = parsed.theme.color.primary;
      // Components come from the raw Figma floats — NOT re-derived from the
      // 8-bit hex (0x40/255 would be 0.25098…, not 0.25).
      expect(primary.$value).toEqual({
        colorSpace: "srgb",
        components: [0.25, 0.52, 0.95],
        hex: "#4085F2",
      });
      // Opaque color: no alpha key at all.
      expect("alpha" in primary.$value).toBe(false);
      // Dark mode (alpha 0.5) is stashed in extensions.modes, also encoded.
      const darkValue = primary.$extensions["figma-console-mcp"].modes.Dark;
      expect(darkValue).toEqual({
        colorSpace: "srgb",
        components: [0.1, 0.2, 0.3],
        alpha: 0.5,
        hex: "#1A334D",
      });
      expect(out.files[0].content).not.toContain("rawColor");
    });

    it("2025 dialect emits dimension objects and leaves duration/aliases unchanged", () => {
      const { document } = convertFigmaVariablesToDocument(motionPayload());
      const out = formatDtcg(document, {
        target: { format: "dtcg", dtcgDialect: "2025" },
      });
      const parsed = JSON.parse(out.files[0].content);
      expect(parsed.theme.spacing.md.$value).toEqual({ value: 16, unit: "px" });
      // duration already emits { value, unit: "ms" } in both dialects.
      expect(parsed.theme.motion.duration.quick.$value).toEqual({
        value: 300,
        unit: "ms",
      });
      // Alias references are untouched by the dialect.
      expect(parsed.theme.color.brand.$value).toBe("{theme.color.primary}");
    });
  });

  describe("json formatter dialect", () => {
    it("json-flat 2025 emits object colors/dimensions; legacy unchanged", () => {
      const { document } = convertFigmaVariablesToDocument(motionPayload());

      const legacy = JSON.parse(
        formatJsonFlat(document, { target: { format: "json-flat" } }).files[0]
          .content,
      );
      expect(legacy["color-primary"]).toBe("#4085F2");
      expect(legacy["spacing-md"]).toBe("16px");

      const modern = JSON.parse(
        formatJsonFlat(document, {
          target: { format: "json-flat", dtcgDialect: "2025" },
        }).files[0].content,
      );
      expect(modern["color-primary"]).toEqual({
        colorSpace: "srgb",
        components: [0.25, 0.52, 0.95],
        hex: "#4085F2",
      });
      expect(modern["spacing-md"]).toEqual({ value: 16, unit: "px" });
      // Aliases resolve to the target's value — also dialect-encoded.
      expect(modern["color-brand"]).toEqual(modern["color-primary"]);
    });

    it("json-nested 2025 emits object colors with alpha only when < 1", () => {
      const { document } = convertFigmaVariablesToDocument(motionPayload());
      const modern = JSON.parse(
        formatJsonNested(document, {
          target: { format: "json-nested", dtcgDialect: "2025" },
        }).files[0].content,
      );
      expect(modern.color.primary.Light).toEqual({
        colorSpace: "srgb",
        components: [0.25, 0.52, 0.95],
        hex: "#4085F2",
      });
      expect(modern.color.primary.Dark).toEqual({
        colorSpace: "srgb",
        components: [0.1, 0.2, 0.3],
        alpha: 0.5,
        hex: "#1A334D",
      });
    });
  });

  // ==========================================================================
  // PART B6 — round-trip: export → parse → diff must be a no-op, both dialects
  // ==========================================================================
  describe.each(["legacy", "2025"] as const)(
    "round-trip in %s dialect",
    (dialect) => {
      it("diffs as unchanged after export → parse (incl. alpha color, dimension, duration)", () => {
        const payload = motionPayload();
        const { document: figmaDoc } = convertFigmaVariablesToDocument(payload);

        const out = formatDtcg(figmaDoc, {
          target: { format: "dtcg", dtcgDialect: dialect },
        });
        expect(out.files).toHaveLength(1);
        const parsed = parseDtcg({ payload: out.files[0].content });

        // Simulate the next import: fresh conversion of the same Figma state
        // diffed against the parsed code-side document.
        const { document: freshFigmaDoc } =
          convertFigmaVariablesToDocument(payload);
        const diff = computeDiffPlan(freshFigmaDoc, parsed.document);

        expect(diff.toCreate).toEqual([]);
        expect(diff.toUpdate).toEqual([]);
        expect(diff.toDelete).toEqual([]);
        expect(diff.unchanged).toBe(4);
      });
    },
  );
});
