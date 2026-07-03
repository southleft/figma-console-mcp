/**
 * Tests for the complete figma_import_tokens apply phase:
 *
 *   - CREATE: missing collections (full mode list) + missing variables in
 *     dependency order — collections → variables/literals → aliases in a
 *     second pass so within-batch alias targets exist.
 *   - ALIAS-TARGET UPDATES: references written as { type: "VARIABLE_ALIAS",
 *     id } when resolvable to an existing or just-created variable.
 *   - DELETE: strictly gated behind strategy "replace"; merge reports only.
 *   - TIMING/EASING create skip (Plugin API hard constraint).
 *   - Per-item error isolation (partial-success semantics).
 *
 * The Desktop Bridge connector is mocked; scripts sent to executeCodeViaUI
 * are parsed to inspect the embedded plan/update payloads.
 */

import {
  convertFigmaVariablesToDocument,
  type TokenDocument,
} from "../src/core/tokens/index.js";
import {
  buildCreatePlan,
  computeDiffPlan,
  makeAliasIdResolver,
  registerImportTokensTool,
  tokenValueToFigma,
} from "../src/core/tokens-tools.js";

// ============================================================================
// Fixtures & helpers
// ============================================================================

/** Live-Figma fixture: one "Theme" collection with two color variables. */
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
      },
      {
        id: "VariableID:1:11",
        name: "color/accent",
        resolvedType: "COLOR" as const,
        variableCollectionId: "VariableCollectionId:1:1",
        valuesByMode: { m1: { r: 0, g: 1, b: 0, a: 1 } }, // #00FF00
      },
    ],
  };
}

/** Normalized converter-shaped payload for pure plan-builder tests. */
function normalizedFigmaPayload() {
  const s = figmaState();
  return { collections: s.variableCollections, variables: s.variables };
}

/** Extract the JSON payload embedded in a bridge script after `marker`. */
function extractJson(script: string, marker: string): any {
  const idx = script.indexOf(marker);
  if (idx === -1) throw new Error(`marker not found: ${marker}`);
  const start = idx + marker.length;
  const end = script.indexOf(";\n", start);
  return JSON.parse(script.slice(start, end));
}

/**
 * Mock Desktop Bridge connector. Parses create/update scripts and simulates
 * plugin-side behavior (created IDs, per-item failures) so the server-side
 * orchestration can be asserted end-to-end.
 */
function makeMockConnector(
  state: ReturnType<typeof figmaState>,
  opts: {
    failCreateKeys?: string[];
    failUpdateIds?: string[];
    /**
     * Keys whose variable CREATE succeeds but whose second-pass alias
     * value application fails (plugin-side aliasFailures entries).
     */
    aliasFailKeys?: string[];
  } = {},
) {
  const calls: Array<{
    type: "create" | "update" | "delete";
    detail: any;
    script?: string;
  }> = [];
  return {
    calls,
    getVariablesFromPluginUI: async () => state,
    executeCodeViaUI: async (script: string) => {
      if (script.includes("const plan = ")) {
        const plan = extractJson(script, "const plan = ");
        calls.push({ type: "create", detail: plan, script });
        const allVars = [
          ...plan.newCollections.flatMap((c: any) => c.variables),
          ...plan.existingCollections.flatMap((c: any) => c.variables),
        ];
        const results: any[] = [];
        const createdIds: Record<string, string> = {};
        for (const v of allVars) {
          if (opts.failCreateKeys?.includes(v.key)) {
            results.push({ key: v.key, name: v.name, success: false, error: "boom-create" });
          } else {
            const id = `VariableID:new:${results.length}`;
            createdIds[v.key] = id;
            results.push({ key: v.key, name: v.name, id, success: true });
          }
        }
        const aliasFailures = (opts.aliasFailKeys ?? [])
          .filter((k) => createdIds[k] !== undefined)
          .map((k) => ({ key: k, error: "alias: boom-alias" }));
        return {
          success: true,
          result: {
            createdCollections: plan.newCollections.map((c: any, i: number) => ({
              name: c.setName,
              id: `VariableCollectionId:new:${i}`,
            })),
            created: results.filter((r) => r.success).length,
            failed: results.filter((r) => !r.success).length,
            results,
            aliasFailures,
            createdIds,
          },
        };
      }
      const updates = extractJson(script, "const updates = ");
      calls.push({ type: "update", detail: updates });
      const results = updates.map((u: any) =>
        opts.failUpdateIds?.includes(u.variableId)
          ? { id: u.variableId, success: false, error: "boom-update" }
          : { id: u.variableId, success: true },
      );
      return {
        success: true,
        result: {
          applied: results.filter((r: any) => r.success).length,
          failed: results.filter((r: any) => !r.success).length,
          results,
        },
      };
    },
    deleteVariable: async (variableId: string) => {
      calls.push({ type: "delete", detail: variableId });
      return { success: true, deleted: { id: variableId } };
    },
  };
}

/** Register the import tool against a fake McpServer and return its handler. */
function captureImportHandler(connector: any) {
  const handlers: Record<string, any> = {};
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: any, cb: any) => {
      handlers[name] = cb;
    },
  } as any;
  // isRemoteMode: true skips tokens.config.json autodiscovery — the tests
  // always pass inline payloads.
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
// buildCreatePlan (pure)
// ============================================================================

describe("import apply phase — buildCreatePlan", () => {
  function codeDocWith(tokens: {
    setName: string;
    modes?: string[];
    entries: any[];
  }): TokenDocument {
    return {
      sets: [
        {
          name: tokens.setName,
          modes: tokens.modes ?? ["Default"],
          tokens: tokens.entries,
        },
      ],
    };
  }

  function resolverFor(codeDoc: TokenDocument, toCreateKeys: Set<string>) {
    const { document: figmaDoc } = convertFigmaVariablesToDocument(
      normalizedFigmaPayload(),
    );
    return makeAliasIdResolver(figmaDoc, codeDoc, toCreateKeys, new Map());
  }

  it("plans a NEW collection with the token file's full mode list and literal values by mode name", () => {
    const codeDoc = codeDocWith({
      setName: "Brand",
      modes: ["Light", "Dark"],
      entries: [
        {
          path: ["color", "base"],
          type: "color",
          values: {
            Light: { literal: "#FF00FF" },
            Dark: {
              // 2025 dialect object literal — must convert like hex does.
              literal: { colorSpace: "srgb", components: [0, 0, 1] },
            },
          },
        },
      ],
    });
    const toCreate = [{ path: "Brand::color.base" }];
    const warnings: string[] = [];
    const plan = buildCreatePlan(
      toCreate,
      codeDoc,
      normalizedFigmaPayload(),
      resolverFor(codeDoc, new Set(toCreate.map((e) => e.path))),
      warnings,
    );

    expect(plan.existingCollections).toEqual([]);
    expect(plan.newCollections).toHaveLength(1);
    const nc = plan.newCollections[0];
    expect(nc.setName).toBe("Brand");
    expect(nc.modes).toEqual(["Light", "Dark"]);
    expect(nc.variables).toHaveLength(1);
    const def = nc.variables[0];
    expect(def.name).toBe("color/base");
    expect(def.resolvedType).toBe("COLOR");
    // New-collection values are keyed by mode NAME (script resolves IDs).
    expect(def.values).toEqual([
      { modeName: "Light", kind: "literal", value: { r: 1, g: 0, b: 1, a: 1 } },
      { modeName: "Dark", kind: "literal", value: { r: 0, g: 0, b: 1, a: 1 } },
    ]);
    expect(warnings).toEqual([]);
  });

  it("routes variables for an EXISTING collection with modeId-keyed values, warning on unknown modes", () => {
    const codeDoc = codeDocWith({
      setName: "Theme",
      entries: [
        {
          path: ["color", "brandnew"],
          type: "color",
          values: {
            Default: { literal: "#123456" },
            Dark: { literal: "#654321" }, // Theme has no Dark mode in Figma
          },
        },
      ],
    });
    const toCreate = [{ path: "Theme::color.brandnew" }];
    const warnings: string[] = [];
    const plan = buildCreatePlan(
      toCreate,
      codeDoc,
      normalizedFigmaPayload(),
      resolverFor(codeDoc, new Set(toCreate.map((e) => e.path))),
      warnings,
    );

    expect(plan.newCollections).toEqual([]);
    expect(plan.existingCollections).toHaveLength(1);
    expect(plan.existingCollections[0].collectionId).toBe(
      "VariableCollectionId:1:1",
    );
    const def = plan.existingCollections[0].variables[0];
    // Existing-collection values pre-resolve to modeIds server-side.
    expect(def.values).toHaveLength(1);
    expect(def.values[0]).toMatchObject({ modeId: "m1", kind: "literal" });
    expect(warnings.join("\n")).toContain('mode not found in existing Figma collection "Theme"');
  });

  it("skips TIMING/EASING creates with a warning (Plugin API cannot create them)", () => {
    const codeDoc = codeDocWith({
      setName: "Motion",
      entries: [
        {
          path: ["duration", "quick"],
          type: "duration",
          values: { Default: { literal: { value: 300, unit: "ms" } } },
          extensions: {
            "figma-console-mcp": { figmaResolvedType: "TIMING" },
          },
        },
        {
          // No recorded figmaResolvedType — cubicBezier infers EASING.
          path: ["easing", "standard"],
          type: "cubicBezier",
          values: { Default: { literal: [0.4, 0, 0.2, 1] } },
        },
        {
          // Name-inferred duration WITHOUT a TIMING record stays skipped
          // too (inferFigmaResolvedType maps duration → TIMING), but a
          // recorded FLOAT must create as FLOAT.
          path: ["delay", "short"],
          type: "duration",
          values: { Default: { literal: 200 } },
          extensions: {
            "figma-console-mcp": { figmaResolvedType: "FLOAT" },
          },
        },
      ],
    });
    const toCreate = [
      { path: "Motion::duration.quick" },
      { path: "Motion::easing.standard" },
      { path: "Motion::delay.short" },
    ];
    const warnings: string[] = [];
    const plan = buildCreatePlan(
      toCreate,
      codeDoc,
      normalizedFigmaPayload(),
      resolverFor(codeDoc, new Set(toCreate.map((e) => e.path))),
      warnings,
    );

    const planned = plan.newCollections[0]?.variables ?? [];
    expect(planned.map((v) => v.key)).toEqual(["Motion::delay.short"]);
    expect(planned[0].resolvedType).toBe("FLOAT");
    expect(warnings.join("\n")).toContain("cannot create Timing");
    expect(warnings.join("\n")).toContain("cannot create Easing");
  });

  it("resolves aliases: existing target → alias, within-batch target → alias-pending, unresolvable → warning", () => {
    const codeDoc = codeDocWith({
      setName: "Brand",
      entries: [
        {
          path: ["color", "base"],
          type: "color",
          values: { Default: { literal: "#FF00FF" } },
        },
        {
          path: ["color", "fellow"],
          type: "color",
          // Points at another token created in this SAME batch.
          values: { Default: { reference: "{brand.color.base}" } },
        },
        {
          path: ["color", "toexisting"],
          type: "color",
          // Points at a variable already live in Figma.
          values: { Default: { reference: "{theme.color.primary}" } },
        },
        {
          path: ["color", "broken"],
          type: "color",
          values: { Default: { reference: "{nowhere.to.be.found}" } },
        },
      ],
    });
    const toCreate = [
      { path: "Brand::color.base" },
      { path: "Brand::color.fellow" },
      { path: "Brand::color.toexisting" },
      { path: "Brand::color.broken" },
    ];
    const warnings: string[] = [];
    const plan = buildCreatePlan(
      toCreate,
      codeDoc,
      normalizedFigmaPayload(),
      resolverFor(codeDoc, new Set(toCreate.map((e) => e.path))),
      warnings,
    );

    const byKey = new Map(
      plan.newCollections[0].variables.map((v) => [v.key, v]),
    );
    expect(byKey.get("Brand::color.fellow")!.values).toEqual([
      {
        modeName: "Default",
        kind: "alias-pending",
        targetKey: "Brand::color.base",
      },
    ]);
    expect(byKey.get("Brand::color.toexisting")!.values).toEqual([
      { modeName: "Default", kind: "alias", targetId: "VariableID:1:10" },
    ]);
    // Unresolvable: variable still planned, but with no values + a warning.
    expect(byKey.get("Brand::color.broken")!.values).toEqual([]);
    expect(warnings.join("\n")).toContain("{nowhere.to.be.found}");
  });
});

// ============================================================================
// makeAliasIdResolver
// ============================================================================

describe("import apply phase — alias ID resolver", () => {
  const { document: figmaDoc } = convertFigmaVariablesToDocument(
    normalizedFigmaPayload(),
  );
  const codeDoc: TokenDocument = {
    sets: [
      {
        name: "Brand",
        modes: ["Default"],
        tokens: [
          {
            path: ["color", "base"],
            type: "color",
            values: { Default: { literal: "#FF00FF" } },
          },
        ],
      },
    ],
  };

  it("prefers IDs created earlier in the same run (createdIdByKey)", () => {
    const created = new Map([["Brand::color.base", "VariableID:new:0"]]);
    const resolve = makeAliasIdResolver(
      figmaDoc,
      codeDoc,
      new Set(["Brand::color.base"]),
      created,
    );
    expect(resolve("{brand.color.base}")).toEqual({ id: "VariableID:new:0" });
  });

  it("returns pending for targets still queued in the toCreate batch", () => {
    const resolve = makeAliasIdResolver(
      figmaDoc,
      codeDoc,
      new Set(["Brand::color.base"]),
      new Map(),
    );
    expect(resolve("{brand.color.base}")).toEqual({
      pending: "Brand::color.base",
    });
  });

  it("resolves against the live Figma snapshot when the reference isn't in the code doc", () => {
    const resolve = makeAliasIdResolver(figmaDoc, codeDoc, new Set(), new Map());
    expect(resolve("{theme.color.accent}")).toEqual({ id: "VariableID:1:11" });
  });

  it("passes cross-library references through as raw variable IDs", () => {
    const resolve = makeAliasIdResolver(figmaDoc, codeDoc, new Set(), new Map());
    expect(resolve("{__library:VariableID:9:99}")).toEqual({
      id: "VariableID:9:99",
    });
  });

  it("returns null for unresolvable references", () => {
    const resolve = makeAliasIdResolver(figmaDoc, codeDoc, new Set(), new Map());
    expect(resolve("{ghost.color.void}")).toBeNull();
  });
});

// ============================================================================
// Handler end-to-end (mocked connector)
// ============================================================================

describe("figma_import_tokens apply phase (mocked connector)", () => {
  const createAndUpdatePayload = JSON.stringify({
    Theme: {
      color: {
        primary: { $type: "color", $value: "#0000FF" }, // literal update
        accent: { $type: "color", $value: "{theme.color.primary}" }, // alias-target update
        brandnew: { $type: "color", $value: "#123456" }, // create in existing collection
      },
    },
    Brand: {
      color: {
        base: { $type: "color", $value: "#FF00FF" }, // create in new collection
        alias: { $type: "color", $value: "{brand.color.base}" }, // within-batch alias
      },
    },
  });

  it("runs create BEFORE update, never deletes under merge, and reports aggregate counts", async () => {
    const connector = makeMockConnector(figmaState());
    const handler = captureImportHandler(connector);
    const res = await runImport(handler, {
      payload: createAndUpdatePayload,
      dryRun: false,
      strategy: "merge",
    });

    expect(res.mode).toBe("applied");
    // Dependency order: creates first (so alias-target updates can point at
    // just-created variables), then updates. No deletes in merge mode.
    expect(connector.calls.map((c) => c.type)).toEqual(["create", "update"]);

    // Create batch: Brand is a NEW collection (full mode list), brandnew
    // lands in the EXISTING Theme collection.
    const plan = connector.calls[0].detail;
    expect(plan.newCollections).toHaveLength(1);
    expect(plan.newCollections[0].setName).toBe("Brand");
    expect(plan.newCollections[0].modes).toEqual(["Default"]);
    expect(
      plan.newCollections[0].variables.map((v: any) => v.key).sort(),
    ).toEqual(["Brand::color.alias", "Brand::color.base"]);
    expect(plan.existingCollections).toHaveLength(1);
    expect(plan.existingCollections[0].variables.map((v: any) => v.key)).toEqual([
      "Theme::color.brandnew",
    ]);
    // Within-batch alias is deferred to the script's second pass.
    const aliasVar = plan.newCollections[0].variables.find(
      (v: any) => v.key === "Brand::color.alias",
    );
    expect(aliasVar.values[0]).toEqual({
      modeName: "Default",
      kind: "alias-pending",
      targetKey: "Brand::color.base",
    });

    expect(res.applyResult.created).toBe(3);
    expect(res.applyResult.createdCollections).toBe(1);
    expect(res.applyResult.deleted).toBe(0);
    expect(res.applyResult.failed).toBe(0);
  });

  it("writes alias-target updates as VARIABLE_ALIAS values", async () => {
    const connector = makeMockConnector(figmaState());
    const handler = captureImportHandler(connector);
    const res = await runImport(handler, {
      payload: createAndUpdatePayload,
      dryRun: false,
      strategy: "merge",
    });

    const updates = connector.calls.find((c) => c.type === "update")!.detail;
    const accentUpdate = updates.find(
      (u: any) => u.variableId === "VariableID:1:11",
    );
    expect(accentUpdate).toBeDefined();
    expect(accentUpdate.valuesByMode.m1).toEqual({
      type: "VARIABLE_ALIAS",
      id: "VariableID:1:10",
    });
    expect(res.applyResult.applied).toBe(2);
  });

  it("deletes Figma-only variables ONLY under strategy 'replace', with a loud warning", async () => {
    // Payload omits color/accent — it becomes a toDelete candidate.
    const payload = JSON.stringify({
      Theme: {
        color: { primary: { $type: "color", $value: "#FF0000" } }, // unchanged
      },
    });

    // merge: reported, never deleted.
    const mergeConnector = makeMockConnector(figmaState());
    const mergeRes = await runImport(captureImportHandler(mergeConnector), {
      payload,
      dryRun: false,
      strategy: "merge",
    });
    expect(mergeConnector.calls.filter((c) => c.type === "delete")).toEqual([]);
    expect(mergeRes.deleteNote).toContain("preserved (merge strategy)");

    // replace: deleted, with the loud warning.
    const replaceConnector = makeMockConnector(figmaState());
    const replaceRes = await runImport(
      captureImportHandler(replaceConnector),
      { payload, dryRun: false, strategy: "replace" },
    );
    expect(
      replaceConnector.calls.filter((c) => c.type === "delete").map((c) => c.detail),
    ).toEqual(["VariableID:1:11"]);
    expect(replaceRes.applyResult.deleted).toBe(1);
    expect(replaceRes.deleteNote).toContain("REPLACE STRATEGY");
    expect(
      replaceRes.warnings.some((w: string) => w.includes("permanently deleted 1")),
    ).toBe(true);

    // replace + dry-run: nothing touched, deletion clearly previewed.
    const dryConnector = makeMockConnector(figmaState());
    const dryRes = await runImport(captureImportHandler(dryConnector), {
      payload,
      dryRun: true,
      strategy: "replace",
    });
    expect(dryConnector.calls).toEqual([]);
    expect(dryRes.mode).toBe("dry-run");
    expect(dryRes.deleteNote).toContain("would be PERMANENTLY DELETED");
  });

  it("isolates per-item failures without failing the batch", async () => {
    const connector = makeMockConnector(figmaState(), {
      failCreateKeys: ["Brand::color.alias"],
      failUpdateIds: ["VariableID:1:10"],
    });
    const handler = captureImportHandler(connector);
    const res = await runImport(handler, {
      payload: createAndUpdatePayload,
      dryRun: false,
      strategy: "merge",
    });

    expect(res.success).toBe(true);
    expect(res.applyResult.created).toBe(2);
    expect(res.applyResult.applied).toBe(1);
    expect(res.applyResult.failed).toBe(2);
    const errorIds = res.applyResult.errors.map((e: any) => e.variableId).sort();
    expect(errorIds).toEqual(["Brand::color.alias", "VariableID:1:10"]);
  });

  it("dry-run performs zero mutations", async () => {
    const connector = makeMockConnector(figmaState());
    const handler = captureImportHandler(connector);
    const res = await runImport(handler, {
      payload: createAndUpdatePayload,
      dryRun: true,
    });
    expect(res.mode).toBe("dry-run");
    expect(connector.calls).toEqual([]);
    expect(res.diff.summary.toCreate).toBe(3);
    expect(res.diff.summary.toUpdate).toBe(2);
  });

  it("counts a created-but-alias-failed variable ONCE (as failed), and its script carries pass-0 rollback", async () => {
    const connector = makeMockConnector(figmaState(), {
      aliasFailKeys: ["Brand::color.alias"],
    });
    const handler = captureImportHandler(connector);
    const res = await runImport(handler, {
      payload: createAndUpdatePayload,
      dryRun: false,
      strategy: "merge",
    });

    // 3 variables created plugin-side; one's alias pass failed → it counts
    // once, as failed. created + failed must equal the total (3), never 4.
    expect(res.applyResult.created).toBe(2);
    expect(res.applyResult.failed).toBe(1);
    expect(res.applyResult.created + res.applyResult.failed).toBe(3);
    expect(
      res.applyResult.errors.some(
        (e: any) =>
          e.variableId === "Brand::color.alias" && e.error.includes("boom-alias"),
      ),
    ).toBe(true);

    // Orphaned-collection rollback lives in the create script's pass-0
    // catch: a failed addMode() must remove() the half-created collection.
    const createCall = connector.calls.find((c) => c.type === "create")!;
    expect(createCall.script).toContain("collection.remove()");
    expect(createCall.script).toContain("rolled back");
  });
});

// ============================================================================
// FINDING 1 — ID-first rename detection (no duplicate create / no delete)
// ============================================================================

describe("rename detection (ID-first matching)", () => {
  /** DTCG payload: color/primary renamed to color/renamedPrimary, carrying
   *  the round-trip variableId. accent unchanged. */
  function renamePayload(newValue = "#FF0000") {
    return JSON.stringify({
      Theme: {
        color: {
          renamedPrimary: {
            $type: "color",
            $value: newValue,
            $extensions: {
              "figma-console-mcp": {
                variableId: "VariableID:1:10",
                collectionId: "VariableCollectionId:1:1",
                figmaResolvedType: "COLOR",
              },
            },
          },
          accent: { $type: "color", $value: "#00FF00" },
        },
      },
    });
  }

  it("computeDiffPlan classifies an ID-matched path move as toRename, not create+delete", () => {
    const { document: figmaDoc } = convertFigmaVariablesToDocument(
      normalizedFigmaPayload(),
    );
    const codeDoc: TokenDocument = {
      sets: [
        {
          name: "Theme",
          modes: ["Default"],
          tokens: [
            {
              path: ["color", "renamedPrimary"],
              type: "color",
              values: { Default: { literal: "#FF0000" } },
              extensions: {
                "figma-console-mcp": { variableId: "VariableID:1:10" },
              },
            },
            {
              path: ["color", "accent"],
              type: "color",
              values: { Default: { literal: "#00FF00" } },
            },
          ],
        },
      ],
    };
    const diff = computeDiffPlan(figmaDoc, codeDoc);
    expect(diff.toCreate).toEqual([]);
    expect(diff.toDelete).toEqual([]);
    expect(diff.toUpdate).toEqual([]);
    expect(diff.toRename).toEqual([
      {
        path: "Theme::color.renamedPrimary",
        from: "Theme::color.primary",
        variableId: "VariableID:1:10",
        newName: "color/renamedPrimary",
        changes: { values: false, scopes: false, codeSyntax: false },
      },
    ]);
    expect(diff.unchanged).toBe(1); // accent
  });

  it("merge: applies a pure rename as ONE name-change update — no create, no delete", async () => {
    const connector = makeMockConnector(figmaState());
    const handler = captureImportHandler(connector);
    const res = await runImport(handler, {
      payload: renamePayload(),
      dryRun: false,
      strategy: "merge",
    });

    expect(res.mode).toBe("applied");
    expect(connector.calls.map((c) => c.type)).toEqual(["update"]);
    const updates = connector.calls[0].detail;
    expect(updates).toHaveLength(1);
    expect(updates[0].variableId).toBe("VariableID:1:10");
    expect(updates[0].newName).toBe("color/renamedPrimary");
    // Pure rename: no value writes.
    expect(updates[0].valuesByMode).toEqual({});

    expect(res.applyResult.renamed).toBe(1);
    expect(res.applyResult.created).toBe(0);
    expect(res.applyResult.deleted).toBe(0);
    expect(res.applyResult.applied).toBe(0);
    expect(res.diff.summary.toRename).toBe(1);
  });

  it("replace: a rename NEVER deletes the original variable", async () => {
    const connector = makeMockConnector(figmaState());
    const handler = captureImportHandler(connector);
    const res = await runImport(handler, {
      payload: renamePayload(),
      dryRun: false,
      strategy: "replace",
    });

    // The old path is consumed by the rename — not a Figma-only leftover.
    expect(connector.calls.filter((c) => c.type === "delete")).toEqual([]);
    expect(connector.calls.filter((c) => c.type === "create")).toEqual([]);
    expect(res.applyResult.renamed).toBe(1);
    expect(res.applyResult.deleted).toBe(0);
    expect(res.diff.summary.toDelete).toBe(0);
  });

  it("rename + value change applies both in a single update entry", async () => {
    const connector = makeMockConnector(figmaState());
    const handler = captureImportHandler(connector);
    const res = await runImport(handler, {
      payload: renamePayload("#123456"),
      dryRun: false,
      strategy: "merge",
    });

    const updates = connector.calls.find((c) => c.type === "update")!.detail;
    expect(updates).toHaveLength(1);
    expect(updates[0].newName).toBe("color/renamedPrimary");
    const written = updates[0].valuesByMode.m1;
    expect(written.r).toBeCloseTo(0x12 / 255, 10);
    expect(written.g).toBeCloseTo(0x34 / 255, 10);
    expect(written.b).toBeCloseTo(0x56 / 255, 10);
    // One variable, one op — counted as a rename (which carried values).
    expect(res.applyResult.renamed).toBe(1);
    expect(res.applyResult.applied).toBe(0);
  });
});

// ============================================================================
// FINDING 2 + 3 — malformed color literals never throw or emit NaN
// ============================================================================

describe("malformed color literals (skip-invalid, never throw)", () => {
  it("returns skip-invalid for CSS functional notation instead of throwing", () => {
    const result = tokenValueToFigma({ literal: "rgb(255,0,0)" }, "COLOR");
    expect(result.kind).toBe("skip-invalid");
    expect((result as { reason: string }).reason).toContain("rgb(255,0,0)");
  });

  it("returns skip-invalid for CSS keywords like 'transparent'", () => {
    expect(tokenValueToFigma({ literal: "transparent" }, "COLOR").kind).toBe(
      "skip-invalid",
    );
  });

  it("returns skip-invalid for named colors ('salmon' is 6 chars but NOT hex)", () => {
    // Regression: length-only dispatch parsed "salmon" as hex digits and
    // pushed NaN channels into setValueForMode.
    expect(tokenValueToFigma({ literal: "salmon" }, "COLOR").kind).toBe(
      "skip-invalid",
    );
    expect(tokenValueToFigma({ literal: "red" }, "COLOR").kind).toBe(
      "skip-invalid",
    );
  });

  it("still accepts genuine hex, with and without the leading '#'", () => {
    expect(tokenValueToFigma({ literal: "#4085F2" }, "COLOR")).toEqual({
      kind: "value",
      value: { r: 0x40 / 255, g: 0x85 / 255, b: 0xf2 / 255, a: 1 },
    });
    // Bare hex tolerance is historical behavior — keep it.
    expect(tokenValueToFigma({ literal: "4085F2" }, "COLOR")).toEqual({
      kind: "value",
      value: { r: 0x40 / 255, g: 0x85 / 255, b: 0xf2 / 255, a: 1 },
    });
  });
});

// ============================================================================
// FINDING 4 — seconds/milliseconds agreement between diff and write paths
// ============================================================================

describe("duration unit agreement (diff canonicalization vs write path)", () => {
  function figmaSideWith(value: number): TokenDocument {
    return {
      sets: [
        {
          name: "Motion",
          modes: ["Default"],
          tokens: [
            {
              path: ["delay", "short"],
              type: "number",
              values: { Default: { literal: value } },
            },
          ],
        },
      ],
    };
  }
  function codeSideWith(seconds: number): TokenDocument {
    return {
      sets: [
        {
          name: "Motion",
          modes: ["Default"],
          tokens: [
            {
              path: ["delay", "short"],
              type: "number",
              values: {
                Default: { literal: { value: seconds, unit: "s" } },
              },
            },
          ],
        },
      ],
    };
  }

  it("FLOAT 300 vs {value: 0.3, unit: 's'} diffs as UNCHANGED", () => {
    const diff = computeDiffPlan(figmaSideWith(300), codeSideWith(0.3));
    expect(diff.toUpdate).toEqual([]);
    expect(diff.unchanged).toBe(1);
  });

  it("{value: 0.5, unit: 's'} produces ONE update writing 500, and the next diff is clean", () => {
    // Diff detects the change…
    const diff = computeDiffPlan(figmaSideWith(300), codeSideWith(0.5));
    expect(diff.toUpdate).toHaveLength(1);
    // …the write path agrees with the canonicalization (500, NOT raw 0.5)…
    expect(
      tokenValueToFigma({ literal: { value: 0.5, unit: "s" } }, "FLOAT"),
    ).toEqual({ kind: "value", value: 500 });
    // …and once Figma holds 500, the loop closes: no permanent re-diff.
    const nextDiff = computeDiffPlan(figmaSideWith(500), codeSideWith(0.5));
    expect(nextDiff.toUpdate).toEqual([]);
    expect(nextDiff.unchanged).toBe(1);
  });
});
