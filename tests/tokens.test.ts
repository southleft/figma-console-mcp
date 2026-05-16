/**
 * Tests for the token sync engine — figma_export_tokens / figma_import_tokens
 * infrastructure.
 *
 * Phase 1 coverage:
 *   - DTCG formatter + parser round-trip
 *   - tokens.config.json autodiscovery + validation
 *   - Alias reference parsing / validation
 *   - Figma variables payload → internal model conversion
 *
 * Format-specific parsers and formatters (CSS vars, Tailwind, etc.) are
 * Phase 2 work and are tested separately when those land.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  convertFigmaVariablesToDocument,
  findTokensConfig,
  loadTokensConfig,
  type TokenDocument,
} from "../src/core/tokens/index.js";
import { formatDtcg } from "../src/core/tokens/formatters/dtcg.js";
import { parseDtcg } from "../src/core/tokens/parsers/dtcg.js";
import {
  buildTokenIndex,
  parseDtcgReference,
  resolveReference,
  validateAliases,
} from "../src/core/tokens/alias-resolver.js";

describe("token sync engine", () => {
  describe("DTCG round-trip", () => {
    it("preserves a single-mode primitive token through format → parse", () => {
      const doc: TokenDocument = {
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
            ],
          },
        ],
      };

      const formatted = formatDtcg(doc, {
        target: { format: "dtcg" },
      });
      expect(formatted.files).toHaveLength(1);
      expect(formatted.files[0].content).toContain('"$value": "#4085F2"');
      expect(formatted.files[0].content).toContain('"$type": "color"');

      const parsed = parseDtcg({ payload: formatted.files[0].content });
      expect(parsed.warnings).toEqual([]);
      expect(parsed.document.sets).toHaveLength(1);
      const token = parsed.document.sets[0].tokens.find(
        (t) => t.path.join("/") === "color/primary",
      );
      expect(token).toBeDefined();
      expect(token!.type).toBe("color");
      expect(token!.values.Default.literal).toBe("#4085F2");
    });

    it("preserves alias references through round-trip", () => {
      const doc: TokenDocument = {
        sets: [
          {
            name: "Semantic",
            modes: ["Default"],
            tokens: [
              {
                path: ["color", "background"],
                type: "color",
                values: {
                  Default: { reference: "{color.primitive.blue.500}" },
                },
              },
            ],
          },
        ],
      };
      const formatted = formatDtcg(doc, { target: { format: "dtcg" } });
      expect(formatted.files[0].content).toContain(
        '"$value": "{color.primitive.blue.500}"',
      );

      const parsed = parseDtcg({ payload: formatted.files[0].content });
      const token = parsed.document.sets[0].tokens[0];
      expect(token.values.Default.reference).toBe(
        "{color.primitive.blue.500}",
      );
      expect(token.values.Default.literal).toBeUndefined();
    });

    it("preserves $extensions[figma-console-mcp] metadata for round-trip ID preservation", () => {
      const doc: TokenDocument = {
        sets: [
          {
            name: "Primitives",
            modes: ["Default"],
            tokens: [
              {
                path: ["color", "primary"],
                type: "color",
                values: { Default: { literal: "#4085F2" } },
                extensions: {
                  "figma-console-mcp": {
                    variableId: "VariableID:1:42",
                    collectionId: "VariableCollectionId:1:5",
                    lastSyncedAt: "2026-05-16T00:00:00.000Z",
                  },
                },
              },
            ],
          },
        ],
      };
      const formatted = formatDtcg(doc, { target: { format: "dtcg" } });
      const parsed = parseDtcg({ payload: formatted.files[0].content });
      const ext = parsed.document.sets[0].tokens[0].extensions?.[
        "figma-console-mcp"
      ];
      expect(ext).toBeDefined();
      expect(ext!.variableId).toBe("VariableID:1:42");
      expect(ext!.collectionId).toBe("VariableCollectionId:1:5");
    });

    it("preserves the original set name through slugification", () => {
      // Real-world case: Figma collection named "1. TailwindCSS" gets
      // slugified to "1-tailwindcss" as the JSON key. Without preserving
      // the original name, every diff against Figma's actual collection
      // name mismatches.
      const doc: TokenDocument = {
        sets: [
          {
            name: "1. TailwindCSS",
            modes: ["Default"],
            tokens: [
              {
                path: ["color", "primary"],
                type: "color",
                values: { Default: { literal: "#4085F2" } },
              },
            ],
          },
        ],
      };
      const formatted = formatDtcg(doc, { target: { format: "dtcg" } });
      // JSON key should be the slug (valid for DTCG consumers).
      expect(formatted.files[0].content).toContain('"1-tailwindcss"');
      // But the original name should be stashed for round-trip.
      expect(formatted.files[0].content).toContain('"originalName": "1. TailwindCSS"');

      const parsed = parseDtcg({ payload: formatted.files[0].content });
      // After round-trip, set name should match the original, not the slug.
      expect(parsed.document.sets[0].name).toBe("1. TailwindCSS");
    });

    it("emits one file per mode when splitByMode is true", () => {
      const doc: TokenDocument = {
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
      const formatted = formatDtcg(doc, {
        target: { format: "dtcg", splitByMode: true },
      });
      expect(formatted.files).toHaveLength(2);
      const filenames = formatted.files.map((f) => f.path).sort();
      expect(filenames).toEqual(["light.tokens.json", "dark.tokens.json"].sort());

      const lightContent = formatted.files.find((f) =>
        f.path.includes("light"),
      )!.content;
      expect(lightContent).toContain('"$value": "#FFFFFF"');
      expect(lightContent).not.toContain("#000000");

      const darkContent = formatted.files.find((f) =>
        f.path.includes("dark"),
      )!.content;
      expect(darkContent).toContain('"$value": "#000000"');
    });

    it("splitByMode files round-trip with correct mode labels (regression)", () => {
      // The CollegeTown failure: splitByMode wrote per-mode files but
      // the parser labeled every token as "Default", so the merge couldn't
      // recombine multi-mode values. Verify that exporting splitByMode and
      // re-parsing both files reassembles the original mode-keyed values.
      const doc: TokenDocument = {
        sets: [
          {
            name: "Mode",
            modes: ["Light", "Dark"],
            tokens: [
              {
                path: ["bg"],
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
      const formatted = formatDtcg(doc, {
        target: { format: "dtcg", splitByMode: true },
      });
      expect(formatted.files).toHaveLength(2);

      // Each file should declare its fileMode in document-level $extensions.
      const lightFile = formatted.files.find((f) => f.path.includes("light"))!;
      const darkFile = formatted.files.find((f) => f.path.includes("dark"))!;
      expect(lightFile.content).toContain('"fileMode": "Light"');
      expect(darkFile.content).toContain('"fileMode": "Dark"');

      // Parse both files and verify modes are correctly labeled.
      const lightParsed = parseDtcg({ payload: lightFile.content });
      const darkParsed = parseDtcg({ payload: darkFile.content });
      expect(lightParsed.document.sets[0].tokens[0].values).toEqual({
        Light: { literal: "#FFFFFF" },
      });
      expect(darkParsed.document.sets[0].tokens[0].values).toEqual({
        Dark: { literal: "#000000" },
      });
    });

    it("produces stable output across runs (deterministic key ordering)", () => {
      const doc: TokenDocument = {
        sets: [
          {
            name: "Test",
            modes: ["Default"],
            tokens: [
              {
                path: ["z"],
                type: "color",
                values: { Default: { literal: "#000" } },
              },
              {
                path: ["a"],
                type: "color",
                values: { Default: { literal: "#FFF" } },
              },
            ],
          },
        ],
      };
      const first = formatDtcg(doc, { target: { format: "dtcg" } });
      const second = formatDtcg(doc, { target: { format: "dtcg" } });
      expect(first.files[0].content).toBe(second.files[0].content);

      // "a" should come before "z" (alphabetical)
      const content = first.files[0].content;
      expect(content.indexOf('"a"')).toBeLessThan(content.indexOf('"z"'));
    });
  });

  describe("alias-resolver", () => {
    it("parses DTCG alias references", () => {
      expect(parseDtcgReference("{color.primary}")).toEqual([
        "color",
        "primary",
      ]);
      expect(parseDtcgReference("{a.b.c}")).toEqual(["a", "b", "c"]);
      expect(parseDtcgReference("not-an-alias")).toBeNull();
      expect(parseDtcgReference("{open-only")).toBeNull();
    });

    it("resolves single-step alias chains", () => {
      const doc: TokenDocument = {
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
            ],
          },
          {
            name: "Semantic",
            modes: ["Default"],
            tokens: [
              {
                path: ["color", "accent"],
                type: "color",
                values: { Default: { reference: "{color.primary}" } },
              },
            ],
          },
        ],
      };
      const index = buildTokenIndex(doc);
      const resolved = resolveReference("{color.primary}", "Default", index);
      expect(resolved.literal).toBe("#4085F2");
    });

    it("detects cycles in alias chains", () => {
      const doc: TokenDocument = {
        sets: [
          {
            name: "Cyclic",
            modes: ["Default"],
            tokens: [
              {
                path: ["a"],
                type: "color",
                values: { Default: { reference: "{b}" } },
              },
              {
                path: ["b"],
                type: "color",
                values: { Default: { reference: "{a}" } },
              },
            ],
          },
        ],
      };
      const index = buildTokenIndex(doc);
      expect(() => resolveReference("{a}", "Default", index)).toThrow(
        /cycle/i,
      );
    });

    it("reports unresolvable references", () => {
      const doc: TokenDocument = {
        sets: [
          {
            name: "Broken",
            modes: ["Default"],
            tokens: [
              {
                path: ["a"],
                type: "color",
                values: { Default: { reference: "{nonexistent}" } },
              },
            ],
          },
        ],
      };
      const errors = validateAliases(doc);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/Unresolvable/i);
    });
  });

  describe("tokens.config.json loader", () => {
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), "fcm-tokens-test-"));
    });

    afterEach(() => {
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("returns null when no config exists", () => {
      const result = loadTokensConfig({ cwd: tmpRoot });
      expect(result).toBeNull();
    });

    it("finds and validates a config at the project root", () => {
      writeFileSync(
        join(tmpRoot, "tokens.config.json"),
        JSON.stringify({
          figmaFile: "abc123",
          source: { dir: "src/styles/tokens", canonical: "dtcg" },
        }),
      );

      const result = loadTokensConfig({ cwd: tmpRoot });
      expect(result).not.toBeNull();
      expect(result!.config.figmaFile).toBe("abc123");
      expect(result!.config.source.canonical).toBe("dtcg");
      expect(result!.projectRoot).toBe(tmpRoot);
    });

    it("autodiscovers a config by walking up from a nested cwd", () => {
      writeFileSync(
        join(tmpRoot, "tokens.config.json"),
        JSON.stringify({ source: { dir: "src/styles/tokens" } }),
      );
      const nested = join(tmpRoot, "src", "components", "Button");
      mkdirSync(nested, { recursive: true });

      const found = findTokensConfig(nested);
      expect(found).toBe(join(tmpRoot, "tokens.config.json"));
    });

    it("throws on invalid JSON", () => {
      writeFileSync(
        join(tmpRoot, "tokens.config.json"),
        "{ not valid json",
      );
      expect(() => loadTokensConfig({ cwd: tmpRoot })).toThrow(
        /not valid JSON/,
      );
    });

    it("throws on schema-invalid config", () => {
      writeFileSync(
        join(tmpRoot, "tokens.config.json"),
        JSON.stringify({ source: { canonical: "not-a-real-format" } }),
      );
      expect(() => loadTokensConfig({ cwd: tmpRoot })).toThrow(
        /failed validation/,
      );
    });
  });

  describe("Figma variables → internal model", () => {
    it("converts a simple color variable correctly", () => {
      const payload = {
        collections: [
          {
            id: "VariableCollectionId:1:5",
            name: "Primitives",
            modes: [{ modeId: "1:0", name: "Default" }],
            variableIds: ["VariableID:1:42"],
          },
        ],
        variables: [
          {
            id: "VariableID:1:42",
            name: "color/primary",
            resolvedType: "COLOR" as const,
            variableCollectionId: "VariableCollectionId:1:5",
            valuesByMode: {
              "1:0": { r: 0.25, g: 0.52, b: 0.95, a: 1 },
            },
          },
        ],
      };

      const { document, warnings } = convertFigmaVariablesToDocument(
        payload,
        { figmaFileKey: "test-key" },
      );
      expect(warnings).toEqual([]);
      expect(document.sets).toHaveLength(1);
      expect(document.sets[0].name).toBe("Primitives");
      expect(document.sets[0].modes).toEqual(["Default"]);
      const token = document.sets[0].tokens[0];
      expect(token.path).toEqual(["color", "primary"]);
      expect(token.type).toBe("color");
      // 0.25 → 64, 0.52 → 133, 0.95 → 242 → #4085F2 (matches a real common color)
      expect(token.values.Default.literal).toBe("#4085F2");
      expect(token.extensions?.["figma-console-mcp"]?.variableId).toBe(
        "VariableID:1:42",
      );
      expect(document.meta?.figmaFileKey).toBe("test-key");
    });

    it("preserves alias references when one variable points at another", () => {
      const payload = {
        collections: [
          {
            id: "c1",
            name: "Semantic",
            modes: [{ modeId: "m1", name: "Default" }],
            variableIds: ["v1", "v2"],
          },
        ],
        variables: [
          {
            id: "v1",
            name: "color/primary",
            resolvedType: "COLOR" as const,
            variableCollectionId: "c1",
            valuesByMode: { m1: { r: 1, g: 0, b: 0, a: 1 } },
          },
          {
            id: "v2",
            name: "color/brand",
            resolvedType: "COLOR" as const,
            variableCollectionId: "c1",
            valuesByMode: { m1: { type: "VARIABLE_ALIAS" as const, id: "v1" } },
          },
        ],
      };

      const { document } = convertFigmaVariablesToDocument(payload);
      const brand = document.sets[0].tokens.find(
        (t) => t.path.join("/") === "color/brand",
      );
      expect(brand).toBeDefined();
      expect(brand!.values.Default.reference).toBe("{color.primary}");
    });

    it("filters by collection ID and modes", () => {
      const payload = {
        collections: [
          {
            id: "c1",
            name: "Keep",
            modes: [
              { modeId: "m1", name: "Light" },
              { modeId: "m2", name: "Dark" },
            ],
            variableIds: ["v1"],
          },
          {
            id: "c2",
            name: "Skip",
            modes: [{ modeId: "m3", name: "Default" }],
            variableIds: ["v2"],
          },
        ],
        variables: [
          {
            id: "v1",
            name: "color/bg",
            resolvedType: "COLOR" as const,
            variableCollectionId: "c1",
            valuesByMode: {
              m1: { r: 1, g: 1, b: 1, a: 1 },
              m2: { r: 0, g: 0, b: 0, a: 1 },
            },
          },
          {
            id: "v2",
            name: "color/other",
            resolvedType: "COLOR" as const,
            variableCollectionId: "c2",
            valuesByMode: { m3: { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
          },
        ],
      };

      const { document } = convertFigmaVariablesToDocument(payload, {
        collectionIds: ["c1"],
        modes: ["Light"],
      });
      expect(document.sets).toHaveLength(1);
      expect(document.sets[0].name).toBe("Keep");
      expect(document.sets[0].modes).toEqual(["Light"]);
      expect(Object.keys(document.sets[0].tokens[0].values)).toEqual(["Light"]);
    });
  });

  describe("DTCG group $type inheritance", () => {
    it("inherits type from group ancestor when leaf has no explicit $type", () => {
      const dtcgJson = JSON.stringify({
        color: {
          $type: "color",
          primary: { $value: "#4085F2" },
          secondary: { $value: "#FF6B35" },
        },
      });
      const parsed = parseDtcg({ payload: dtcgJson });
      expect(parsed.warnings).toEqual([]);
      expect(parsed.document.sets[0].tokens.every((t) => t.type === "color"))
        .toBe(true);
    });
  });
});
