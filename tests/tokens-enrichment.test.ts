/**
 * Regression tests for the enrichment-side token value resolution:
 *
 *   - Multi-mode variables must resolve EACH mode's own value (previously
 *     every mode resolved to the first mode's value because modeId was
 *     never threaded through and the cache key had no mode component).
 *   - Falsy-but-legitimate values (0, false, "") must not be nulled out.
 *   - Semi-transparent colors must keep their alpha byte (#RRGGBBAA).
 */

import { StyleValueResolver } from "../src/core/enrichment/style-resolver.js";

const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any;

describe("enrichment style-resolver", () => {
  it("resolves each mode to its own value, not the first mode's (regression)", async () => {
    const resolver = new StyleValueResolver(stubLogger);
    const variable = {
      id: "VariableID:1:1",
      name: "color/bg",
      resolvedType: "COLOR",
      valuesByMode: {
        "m:light": { r: 1, g: 1, b: 1, a: 1 },
        "m:dark": { r: 0, g: 0, b: 0, a: 1 },
      },
    };
    const variables = new Map([[variable.id, variable]]);

    const light = await resolver.resolveVariableValue(
      variable,
      variables,
      10,
      0,
      "m:light",
    );
    const dark = await resolver.resolveVariableValue(
      variable,
      variables,
      10,
      0,
      "m:dark",
    );
    expect(light).toBe("#FFFFFF");
    expect(dark).toBe("#000000");
  });

  it("caches per (variable, mode), not per variable (regression)", async () => {
    const resolver = new StyleValueResolver(stubLogger);
    const variable = {
      id: "VariableID:1:2",
      name: "spacing/gap",
      resolvedType: "FLOAT",
      valuesByMode: { "m:a": 8, "m:b": 16 },
    };
    const variables = new Map([[variable.id, variable]]);

    // Warm the cache with mode A, then ask for mode B — must NOT get A's
    // cached value back.
    const a = await resolver.resolveVariableValue(variable, variables, 10, 0, "m:a");
    const b = await resolver.resolveVariableValue(variable, variables, 10, 0, "m:b");
    expect(a).toBe(8);
    expect(b).toBe(16);
  });

  it("resolves alias chains per requested mode", async () => {
    const resolver = new StyleValueResolver(stubLogger);
    const target = {
      id: "VariableID:2:1",
      name: "primitive/gray",
      resolvedType: "COLOR",
      valuesByMode: {
        "m:light": { r: 1, g: 1, b: 1, a: 1 },
        "m:dark": { r: 0, g: 0, b: 0, a: 1 },
      },
    };
    const aliasVar = {
      id: "VariableID:2:2",
      name: "semantic/surface",
      resolvedType: "COLOR",
      valuesByMode: {
        "m:light": { type: "VARIABLE_ALIAS", id: target.id },
        "m:dark": { type: "VARIABLE_ALIAS", id: target.id },
      },
    };
    const variables = new Map<string, any>([
      [target.id, target],
      [aliasVar.id, aliasVar],
    ]);

    const dark = await resolver.resolveVariableValue(
      aliasVar,
      variables,
      10,
      0,
      "m:dark",
    );
    expect(dark).toBe("#000000");
  });

  it("does not null out legitimate falsy values (0, false, empty string)", async () => {
    const resolver = new StyleValueResolver(stubLogger);
    const variables = new Map<string, any>();

    const zeroVar = {
      id: "v:zero",
      name: "opacity/none",
      resolvedType: "FLOAT",
      valuesByMode: { m: 0 },
    };
    const falseVar = {
      id: "v:false",
      name: "flag/off",
      resolvedType: "BOOLEAN",
      valuesByMode: { m: false },
    };
    const emptyVar = {
      id: "v:empty",
      name: "label/blank",
      resolvedType: "STRING",
      valuesByMode: { m: "" },
    };

    expect(
      await resolver.resolveVariableValue(zeroVar, variables, 10, 0, "m"),
    ).toBe(0);
    expect(
      await resolver.resolveVariableValue(falseVar, variables, 10, 0, "m"),
    ).toBe(false);
    expect(
      await resolver.resolveVariableValue(emptyVar, variables, 10, 0, "m"),
    ).toBe("");
  });

  it("preserves alpha for semi-transparent colors (#RRGGBBAA)", async () => {
    const resolver = new StyleValueResolver(stubLogger);
    const variable = {
      id: "v:alpha",
      name: "color/overlay",
      resolvedType: "COLOR",
      valuesByMode: { m: { r: 0, g: 0, b: 0, a: 0.5 } },
    };
    const resolved = await resolver.resolveVariableValue(
      variable,
      new Map(),
      10,
      0,
      "m",
    );
    expect(resolved).toBe("#00000080");
  });

  it("keeps fully-opaque colors as #RRGGBB (no alpha byte)", async () => {
    const resolver = new StyleValueResolver(stubLogger);
    const variable = {
      id: "v:opaque",
      name: "color/solid",
      resolvedType: "COLOR",
      valuesByMode: { m: { r: 0.25, g: 0.52, b: 0.95, a: 1 } },
    };
    const resolved = await resolver.resolveVariableValue(
      variable,
      new Map(),
      10,
      0,
      "m",
    );
    expect(resolved).toBe("#4085F2");
  });
});
