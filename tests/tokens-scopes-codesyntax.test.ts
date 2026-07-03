/**
 * Round-trip tests for variable `scopes` and `codeSyntax` through the token
 * pipeline (export → DTCG → parse → diff → apply):
 *
 *   - Converter stashes non-default scopes and non-empty codeSyntax in
 *     $extensions["figma-console-mcp"]; ALL_SCOPES / empty are OMITTED so
 *     output for unscoped variables stays byte-identical.
 *   - Full round-trip (both dialects) diffs as unchanged — no false
 *     positives on scoped variables.
 *   - Diff detects scope changes (order-insensitively) and codeSyntax
 *     changes; code-side ABSENT fields mean "no opinion" (never reset
 *     Figma-side metadata).
 *   - Apply payloads carry `scopes` (wholesale) and `codeSyntax`
 *     ({ set, remove }) writes; newly-created variables carry them too.
 */

import {
  convertFigmaVariablesToDocument,
  type TokenDocument,
} from "../src/core/tokens/index.js";
import { formatDtcg } from "../src/core/tokens/formatters/dtcg.js";
import { parseDtcg } from "../src/core/tokens/parsers/dtcg.js";
import {
  buildCreatePlan,
  computeDiffPlan,
  makeAliasIdResolver,
  registerImportTokensTool,
} from "../src/core/tokens-tools.js";

// ============================================================================
// Fixtures & helpers
// ============================================================================

/**
 * Live-Figma fixture: "Theme" collection, one mode, two color variables.
 *   - color/primary: restrictive scopes + WEB/ANDROID codeSyntax
 *   - color/accent: default ALL_SCOPES + empty codeSyntax (must be omitted)
 */
function figmaState() {
  return {
    variableCollections: [
      {
        id: "VariableCollectionId:1:1",
        name: "Theme",
        modes: [{ modeId: "m1", name: "Default" }],
        variableIds: ["VariableID:1:10", "VariableID:1:11"],
      },
    ],
    variables: [
      {
        id: "VariableID:1:10",
        name: "color/primary",
        resolvedType: "COLOR" as const,
        variableCollectionId: "VariableCollectionId:1:1",
        valuesByMode: { m1: { r: 1, g: 0, b: 0, a: 1 } }, // #FF0000
        scopes: ["FILL_COLOR", "STROKE_COLOR"],
        codeSyntax: { WEB: "var(--color-primary)", ANDROID: "colorPrimary" },
      },
      {
        id: "VariableID:1:11",
        name: "color/accent",
        resolvedType: "COLOR" as const,
        variableCollectionId: "VariableCollectionId:1:1",
        valuesByMode: { m1: { r: 0, g: 1, b: 0, a: 1 } }, // #00FF00
        scopes: ["ALL_SCOPES"],
        codeSyntax: {},
      },
    ],
  };
}

function normalizedFigmaPayload() {
  const s = figmaState();
  return { collections: s.variableCollections, variables: s.variables };
}

function convertFixture() {
  return convertFigmaVariablesToDocument(normalizedFigmaPayload()).document;
}

function mcpExt(doc: TokenDocument, tokenPath: string): any {
  for (const set of doc.sets) {
    for (const t of set.tokens) {
      if (t.path.join("/") === tokenPath) {
        return t.extensions?.["figma-console-mcp"];
      }
    }
  }
  throw new Error(`token not found: ${tokenPath}`);
}

/** Round-trip a document through the DTCG formatter + parser. */
function roundTrip(doc: TokenDocument, dialect: "legacy" | "2025") {
  const formatted = formatDtcg(doc, {
    target: { format: "dtcg", dtcgDialect: dialect },
  });
  expect(formatted.files).toHaveLength(1);
  return parseDtcg({ payload: formatted.files[0].content }).document;
}

/** Extract the JSON payload embedded in a bridge script after `marker`. */
function extractJson(script: string, marker: string): any {
  const idx = script.indexOf(marker);
  if (idx === -1) throw new Error(`marker not found: ${marker}`);
  const start = idx + marker.length;
  const end = script.indexOf(";\n", start);
  return JSON.parse(script.slice(start, end));
}

/** Minimal mocked Desktop Bridge connector (same pattern as tokens-import-apply). */
function makeMockConnector(state: ReturnType<typeof figmaState>) {
  const calls: Array<{ type: "create" | "update" | "delete"; detail: any }> =
    [];
  return {
    calls,
    getVariablesFromPluginUI: async () => state,
    executeCodeViaUI: async (script: string) => {
      if (script.includes("const plan = ")) {
        const plan = extractJson(script, "const plan = ");
        calls.push({ type: "create", detail: plan });
        const allVars = [
          ...plan.newCollections.flatMap((c: any) => c.variables),
          ...plan.existingCollections.flatMap((c: any) => c.variables),
        ];
        const createdIds: Record<string, string> = {};
        const results = allVars.map((v: any, i: number) => {
          createdIds[v.key] = `VariableID:new:${i}`;
          return { key: v.key, name: v.name, id: createdIds[v.key], success: true };
        });
        return {
          success: true,
          result: {
            createdCollections: plan.newCollections.map((c: any, i: number) => ({
              name: c.setName,
              id: `VariableCollectionId:new:${i}`,
            })),
            created: results.length,
            failed: 0,
            results,
            aliasFailures: [],
            createdIds,
          },
        };
      }
      const updates = extractJson(script, "const updates = ");
      calls.push({ type: "update", detail: updates });
      return {
        success: true,
        result: {
          applied: updates.length,
          failed: 0,
          results: updates.map((u: any) => ({ id: u.variableId, success: true })),
        },
      };
    },
    deleteVariable: async (variableId: string) => {
      calls.push({ type: "delete", detail: variableId });
      return { success: true, deleted: { id: variableId } };
    },
  };
}

function captureImportHandler(connector: any) {
  const handlers: Record<string, any> = {};
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: any, cb: any) => {
      handlers[name] = cb;
    },
  } as any;
  registerImportTokensTool(fakeServer, async () => connector, {
    isRemoteMode: true,
  });
  return handlers["figma_import_tokens"];
}

async function runImport(handler: any, args: Record<string, unknown>) {
  const res = await handler(args);
  expect(res.isError).toBeUndefined();
  return JSON.parse(res.content[0].text);
}

// ============================================================================
// Converter — export-side stash
// ============================================================================

describe("scopes/codeSyntax — converter stash", () => {
  it("stashes non-default scopes and non-empty codeSyntax in $extensions", () => {
    const ext = mcpExt(convertFixture(), "color/primary");
    expect(ext.scopes).toEqual(["FILL_COLOR", "STROKE_COLOR"]);
    expect(ext.codeSyntax).toEqual({
      WEB: "var(--color-primary)",
      ANDROID: "colorPrimary",
    });
  });

  it("OMITS scopes for ALL_SCOPES and codeSyntax when empty (byte-identity for unscoped variables)", () => {
    const ext = mcpExt(convertFixture(), "color/accent");
    expect(ext).not.toHaveProperty("scopes");
    expect(ext).not.toHaveProperty("codeSyntax");
  });

  it("OMITS scopes when the payload has no scopes field at all (older plugin payloads)", () => {
    const payload = normalizedFigmaPayload();
    for (const v of payload.variables) {
      delete (v as any).scopes;
      delete (v as any).codeSyntax;
    }
    const { document } = convertFigmaVariablesToDocument(payload);
    const ext = mcpExt(document, "color/primary");
    expect(ext).not.toHaveProperty("scopes");
    expect(ext).not.toHaveProperty("codeSyntax");
  });
});

// ============================================================================
// Round-trip — no diff false-positives
// ============================================================================

describe("scopes/codeSyntax — round-trip diffs as unchanged", () => {
  it.each(["legacy", "2025"] as const)(
    "export → parse → diff = unchanged (%s dialect)",
    (dialect) => {
      const figmaDoc = convertFixture();
      const parsed = roundTrip(figmaDoc, dialect);

      // The stash survives the DTCG round-trip verbatim.
      expect(mcpExt(parsed, "color/primary").scopes).toEqual([
        "FILL_COLOR",
        "STROKE_COLOR",
      ]);
      expect(mcpExt(parsed, "color/primary").codeSyntax).toEqual({
        WEB: "var(--color-primary)",
        ANDROID: "colorPrimary",
      });

      const diff = computeDiffPlan(figmaDoc, parsed);
      expect(diff.toCreate).toEqual([]);
      expect(diff.toUpdate).toEqual([]);
      expect(diff.toDelete).toEqual([]);
      expect(diff.unchanged).toBe(2);
    },
  );

  it("treats code-side ABSENT scopes/codeSyntax as no opinion (pre-feature files never reset Figma metadata)", () => {
    const figmaDoc = convertFixture();
    const parsed = roundTrip(figmaDoc, "legacy");
    // Simulate a token file that predates the feature (or was hand-authored
    // without metadata): strip the fields entirely.
    const ext = mcpExt(parsed, "color/primary");
    delete ext.scopes;
    delete ext.codeSyntax;

    const diff = computeDiffPlan(figmaDoc, parsed);
    expect(diff.toUpdate).toEqual([]);
    expect(diff.unchanged).toBe(2);
  });
});

// ============================================================================
// Diff — change detection
// ============================================================================

describe("scopes/codeSyntax — diff detection", () => {
  it("detects a scope change as a metadata-only update", () => {
    const figmaDoc = convertFixture();
    const parsed = roundTrip(figmaDoc, "legacy");
    mcpExt(parsed, "color/primary").scopes = ["TEXT_FILL"];

    const diff = computeDiffPlan(figmaDoc, parsed);
    expect(diff.toUpdate).toHaveLength(1);
    const entry = diff.toUpdate[0];
    expect(entry.path).toBe("Theme::color.primary");
    expect(entry.changes).toEqual({
      values: false,
      scopes: true,
      codeSyntax: false,
    });
    expect(entry.before).toEqual({ scopes: ["FILL_COLOR", "STROKE_COLOR"] });
    expect(entry.after).toEqual({ scopes: ["TEXT_FILL"] });
    expect(diff.unchanged).toBe(1);
  });

  it("compares scopes order-insensitively (reorder is NOT a change)", () => {
    const figmaDoc = convertFixture();
    const parsed = roundTrip(figmaDoc, "legacy");
    mcpExt(parsed, "color/primary").scopes = ["STROKE_COLOR", "FILL_COLOR"];

    const diff = computeDiffPlan(figmaDoc, parsed);
    expect(diff.toUpdate).toEqual([]);
    expect(diff.unchanged).toBe(2);
  });

  it("treats explicit ['ALL_SCOPES'] on the code side as equal to Figma's omitted default", () => {
    const figmaDoc = convertFixture();
    const parsed = roundTrip(figmaDoc, "legacy");
    // accent has default scoping — Figma side omits. Explicit ALL_SCOPES on
    // the code side must not diff.
    mcpExt(parsed, "color/accent").scopes = ["ALL_SCOPES"];

    const diff = computeDiffPlan(figmaDoc, parsed);
    expect(diff.toUpdate).toEqual([]);
  });

  it("detects codeSyntax edits and removals", () => {
    const figmaDoc = convertFixture();
    const parsed = roundTrip(figmaDoc, "legacy");
    // WEB value changed, ANDROID entry dropped.
    mcpExt(parsed, "color/primary").codeSyntax = { WEB: "var(--brand)" };

    const diff = computeDiffPlan(figmaDoc, parsed);
    expect(diff.toUpdate).toHaveLength(1);
    expect(diff.toUpdate[0].changes).toEqual({
      values: false,
      scopes: false,
      codeSyntax: true,
    });
  });

  it("flags combined value + metadata changes on one entry", () => {
    const figmaDoc = convertFixture();
    const parsed = roundTrip(figmaDoc, "legacy");
    const token = parsed.sets[0].tokens.find(
      (t) => t.path.join("/") === "color/primary",
    )!;
    token.values.Default = { literal: "#0000FF" };
    mcpExt(parsed, "color/primary").scopes = ["TEXT_FILL"];

    const diff = computeDiffPlan(figmaDoc, parsed);
    expect(diff.toUpdate).toHaveLength(1);
    expect(diff.toUpdate[0].changes).toEqual({
      values: true,
      scopes: true,
      codeSyntax: false,
    });
    // Value change keeps the historical before/after shape (mode → value).
    expect((diff.toUpdate[0].after as any).Default.literal).toBe("#0000FF");
  });
});

// ============================================================================
// Apply — update payload carries the writes
// ============================================================================

describe("scopes/codeSyntax — apply phase", () => {
  function payloadWithMeta(mutate: (ext: any, token: any) => void): string {
    const figmaDoc = convertFixture();
    const formatted = formatDtcg(figmaDoc, { target: { format: "dtcg" } });
    const tree = JSON.parse(formatted.files[0].content);
    const primary = tree.theme.color.primary;
    mutate(primary.$extensions["figma-console-mcp"], primary);
    return JSON.stringify(tree);
  }

  it("pushes a metadata-only update with scopes + codeSyntax {set, remove} and NO value writes", async () => {
    const payload = payloadWithMeta((ext) => {
      ext.scopes = ["TEXT_FILL"];
      ext.codeSyntax = { WEB: "var(--brand)" }; // edits WEB, drops ANDROID
    });

    const connector = makeMockConnector(figmaState());
    const res = await runImport(captureImportHandler(connector), {
      payload,
      dryRun: false,
      strategy: "merge",
    });

    expect(res.mode).toBe("applied");
    expect(connector.calls.map((c) => c.type)).toEqual(["update"]);
    const updates = connector.calls[0].detail;
    expect(updates).toHaveLength(1);
    expect(updates[0].variableId).toBe("VariableID:1:10");
    // Metadata-only: unchanged values are NOT re-pushed.
    expect(updates[0].valuesByMode).toEqual({});
    expect(updates[0].scopes).toEqual(["TEXT_FILL"]);
    expect(updates[0].codeSyntax).toEqual({
      set: { WEB: "var(--brand)" },
      remove: ["ANDROID"],
    });
    expect(res.applyResult.applied).toBe(1);
  });

  it("resets scopes to ['ALL_SCOPES'] when the code side explicitly asks for the default", async () => {
    const payload = payloadWithMeta((ext) => {
      ext.scopes = ["ALL_SCOPES"];
    });
    const connector = makeMockConnector(figmaState());
    await runImport(captureImportHandler(connector), {
      payload,
      dryRun: false,
      strategy: "merge",
    });
    const updates = connector.calls[0].detail;
    expect(updates[0].scopes).toEqual(["ALL_SCOPES"]);
    expect(updates[0].codeSyntax).toBeUndefined();
  });

  it("carries scopes/codeSyntax into buildCreatePlan defs (and omits defaults)", () => {
    const codeDoc: TokenDocument = {
      sets: [
        {
          name: "Brand",
          modes: ["Default"],
          tokens: [
            {
              path: ["color", "scoped"],
              type: "color",
              values: { Default: { literal: "#112233" } },
              extensions: {
                "figma-console-mcp": {
                  scopes: ["FILL_COLOR"],
                  codeSyntax: { WEB: "var(--scoped)" },
                },
              },
            },
            {
              path: ["color", "unscoped"],
              type: "color",
              values: { Default: { literal: "#445566" } },
              extensions: {
                "figma-console-mcp": { scopes: ["ALL_SCOPES"], codeSyntax: {} },
              },
            },
          ],
        },
      ],
    };
    const figmaDoc = convertFixture();
    const toCreate = [
      { path: "Brand::color.scoped" },
      { path: "Brand::color.unscoped" },
    ];
    const warnings: string[] = [];
    const plan = buildCreatePlan(
      toCreate,
      codeDoc,
      normalizedFigmaPayload(),
      makeAliasIdResolver(
        figmaDoc,
        codeDoc,
        new Set(toCreate.map((e) => e.path)),
        new Map(),
      ),
      warnings,
    );

    const byKey = new Map(
      plan.newCollections[0].variables.map((v) => [v.key, v]),
    );
    expect(byKey.get("Brand::color.scoped")!.scopes).toEqual(["FILL_COLOR"]);
    expect(byKey.get("Brand::color.scoped")!.codeSyntax).toEqual({
      WEB: "var(--scoped)",
    });
    expect(byKey.get("Brand::color.unscoped")).not.toHaveProperty("scopes");
    expect(byKey.get("Brand::color.unscoped")).not.toHaveProperty("codeSyntax");
    expect(warnings).toEqual([]);
  });

  it("end-to-end: created variables ship scopes/codeSyntax to the plugin script", async () => {
    const payload = JSON.stringify({
      Brand: {
        color: {
          scoped: {
            $type: "color",
            $value: "#112233",
            $extensions: {
              "figma-console-mcp": {
                scopes: ["FILL_COLOR"],
                codeSyntax: { WEB: "var(--scoped)" },
              },
            },
          },
        },
      },
    });
    const connector = makeMockConnector(figmaState());
    const res = await runImport(captureImportHandler(connector), {
      payload,
      dryRun: false,
      strategy: "merge",
    });

    const plan = connector.calls.find((c) => c.type === "create")!.detail;
    const def = plan.newCollections[0].variables[0];
    expect(def.scopes).toEqual(["FILL_COLOR"]);
    expect(def.codeSyntax).toEqual({ WEB: "var(--scoped)" });
    expect(res.applyResult.created).toBe(1);
  });
});
