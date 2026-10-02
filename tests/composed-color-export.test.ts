/**
 * Figma composed colors (VariableComposedColor): a color + an opacity percent,
 * at least one of them an alias. Reported by Isabella Minzly (v1.40.8):
 * "figma_export_tokens fails on colour variables aliased with opacity".
 * Value shapes and opacity semantics below were read back from Figma.
 */
import { convertFigmaVariablesToDocument } from "../src/core/tokens/figma-converter";
import { format } from "../src/core/tokens/formatters";

const L = "1:0", D = "1:1";
const alias = (id: string) => ({ type: "VARIABLE_ALIAS", id });
export const composedPayload: any = {
	collections: [
		{ id: "P", name: "Primitives", modes: [{ modeId: "9:0", name: "Value" }], variableIds: ["g", "w", "a", "h"] },
		{ id: "S", name: "Semantic", modes: [{ modeId: L, name: "Light" }, { modeId: D, name: "Dark" }], variableIds: ["o", "s", "t", "x"] },
	],
	variables: [
		{ id: "g", name: "grey/900", resolvedType: "COLOR", variableCollectionId: "P", valuesByMode: { "9:0": { r: 0.149, g: 0.149, b: 0.149, a: 1 } } },
		{ id: "w", name: "white", resolvedType: "COLOR", variableCollectionId: "P", valuesByMode: { "9:0": { r: 1, g: 1, b: 1, a: 1 } } },
		{ id: "h", name: "glass", resolvedType: "COLOR", variableCollectionId: "P", valuesByMode: { "9:0": { r: 0, g: 0, b: 1, a: 0.5 } } },
		{ id: "a", name: "opacity/50", resolvedType: "FLOAT", variableCollectionId: "P", scopes: ["OPACITY"], valuesByMode: { "9:0": 50 } },
		// Isabella's case: color alias + opacity number; differs per mode
		{ id: "o", name: "overlay", resolvedType: "COLOR", variableCollectionId: "S", valuesByMode: { [L]: { color: alias("g"), opacity: 50 }, [D]: { color: alias("w"), opacity: 20 } } },
		// color alias + opacity alias
		{ id: "s", name: "scrim", resolvedType: "COLOR", variableCollectionId: "S", valuesByMode: { [L]: { color: alias("g"), opacity: alias("a") }, [D]: { color: alias("g"), opacity: alias("a") } } },
		// literal color + opacity alias
		{ id: "t", name: "tint", resolvedType: "COLOR", variableCollectionId: "S", valuesByMode: { [L]: { color: { r: 1, g: 0, b: 0, a: 1 }, opacity: alias("a") }, [D]: { color: { r: 1, g: 0, b: 0, a: 1 }, opacity: alias("a") } } },
		// semi-transparent primitive: Figma ignores the opacity
		{ id: "x", name: "haze", resolvedType: "COLOR", variableCollectionId: "S", valuesByMode: { [L]: { color: alias("h"), opacity: 20 }, [D]: { color: alias("h"), opacity: 20 } } },
	],
};

const convert = () => convertFigmaVariablesToDocument(composedPayload, { exportedAt: "2026-10-02T00:00:00.000Z" } as any);
const out = (fmt: string, extra: any = {}) => {
	const r: any = format(convert().document, { target: { format: fmt, ...extra } } as any);
	return { text: r.files.map((f: any) => f.content).join("\n"), warnings: r.warnings as string[] };
};

describe("composed colors: conversion", () => {
	it("no longer warns 'isn't an RGB object' and resolves what Figma renders", () => {
		const r: any = convert();
		expect(r.warnings.join("\n")).not.toMatch(/isn't an RGB object/);
		const sem = r.document.sets.find((s: any) => s.name === "Semantic");
		const tok = (n: string) => sem.tokens.find((t: any) => t.path.join("/") === n);
		expect(tok("overlay").values.Light).toMatchObject({ literal: "#26262680", composed: { color: { reference: expect.stringContaining("grey.900") }, opacity: { literal: 50 }, colorOpaque: true } });
		expect(tok("overlay").values.Dark).toMatchObject({ literal: "#FFFFFF33", composed: { opacity: { literal: 20 } } });
		expect(tok("scrim").values.Light).toMatchObject({ literal: "#26262680", composed: { opacity: { reference: expect.stringContaining("opacity.50") } } });
		expect(tok("tint").values.Light).toMatchObject({ literal: "#FF000080", composed: { color: { literal: "#FF0000" } } });
		// Figma keeps a semi-transparent primitive's alpha and ignores the opacity
		expect(tok("haze").values.Light).toMatchObject({ literal: "#0000FF80", composed: { colorOpaque: false } });
	});
});

describe("composed colors: formats", () => {
	it.each(["dtcg", "css-vars", "tailwind-v4", "tailwind-v3", "scss", "ts-module", "json-flat", "json-nested", "style-dictionary-v3", "tokens-studio"])(
		"%s emits no broken values",
		(fmt) => {
			const { text } = out(fmt);
			expect(text).not.toContain("[object Object]");
			expect(text).not.toContain("NaN");
		},
	);

	it("css-vars keeps the link to the primitive with color-mix", () => {
		const { text, warnings } = out("css-vars");
		expect(text).toMatch(/--overlay: color-mix\(in srgb, var\(--grey-900\) 50%, transparent\);/);
		expect(text).toMatch(/--overlay: color-mix\(in srgb, var\(--white\) 20%, transparent\);/);
		expect(text).toMatch(/--scrim: color-mix\(in srgb, var\(--grey-900\) calc\(var\(--opacity-50\) \* 1%\), transparent\);/);
		expect(text).toMatch(/--tint: color-mix\(in srgb, #FF0000 calc\(var\(--opacity-50\) \* 1%\), transparent\);/);
		expect(text).toMatch(/--opacity-50: 50;/);
		expect(text).toMatch(/--haze: #0000FF80;/);
		expect(warnings.join("\n")).toMatch(/haze in CSS: exported as its resolved color because its color is semi-transparent/);
	});
});

import { parse } from "../src/core/tokens/parsers";
import { canonicalizeTokenValueForComparison } from "../src/core/tokens/dialect";
import { tokenValueToFigma } from "../src/core/tokens-tools";
import { resolveVariableAliases } from "../src/core/figma-tools";
import { makeFigmaColorResolver } from "../src/core/design-system-manifest";

describe("composed colors: other formats keep the link", () => {
	it("tailwind-v4 uses color-mix in the color namespace", () => {
		const { text } = out("tailwind-v4");
		expect(text).toMatch(/--color-overlay: color-mix\(in srgb, var\(--color-grey-900\) 50%, transparent\);/);
	});
	it("scss uses rgba($primitive, alpha)", () => {
		const { text } = out("scss");
		expect(text).toMatch(/\$overlay: rgba\(\$grey-900, 0\.5\);/);
		expect(text).toMatch(/\$scrim: rgba\(\$grey-900, \(\$opacity-50 \* 0\.01\)\);/);
		expect(text).toMatch(/\$haze: #0000FF80;/);
	});
	it("tokens-studio references the primitive with an alpha modifier", () => {
		const r: any = format(convert().document, { target: { format: "tokens-studio" } } as any);
		const light = JSON.parse(r.files.find((f: any) => /semantic\/light/i.test(f.path)).content);
		expect(light.overlay).toMatchObject({ value: "{grey.900}", $extensions: { "studio.tokens": { modify: { type: "alpha", value: "0.5" } } } });
		expect(light.scrim.$extensions["studio.tokens"].modify.value).toBe("{opacity.50} / 100");
		expect(light.haze.value).toBe("#0000FF80");
		expect(light.haze.$extensions).toBeUndefined();
	});
	it("dtcg keeps the resolved $value and records the composition per mode", () => {
		const d = JSON.parse(out("dtcg").text);
		expect(d.semantic.overlay.$value).toBe("#26262680");
		expect(d.semantic.overlay.$extensions["figma-console-mcp"].composedColor).toEqual({
			Light: { color: "{primitives.grey.900}", opacity: 50 },
			Dark: { color: "{primitives.white}", opacity: 20 },
		});
	});
});

describe("composed colors: round trip", () => {
	const figmaDoc = () => convert().document;
	const reparsed = () => parse("dtcg", { payload: out("dtcg").text }).document;
	const tokenIn = (doc: any, set: string, name: string) =>
		doc.sets.find((s: any) => s.name.toLowerCase() === set).tokens.find((t: any) => t.path.join("/") === name);

	it("an unchanged export re-imports as unchanged", () => {
		for (const name of ["overlay", "scrim", "tint", "haze"]) {
			const a = tokenIn(figmaDoc(), "semantic", name).values;
			const b = tokenIn(reparsed(), "semantic", name).values;
			for (const mode of ["Light", "Dark"]) {
				expect(canonicalizeTokenValueForComparison(b[mode])).toEqual(canonicalizeTokenValueForComparison(a[mode]));
			}
		}
	});

	it("an edited opacity is a change and converts to Figma's composed value", () => {
		const text = out("dtcg").text.replace('"opacity": 50', '"opacity": 40');
		const doc = parse("dtcg", { payload: text }).document;
		const v = tokenIn(doc, "semantic", "overlay").values.Light;
		expect(canonicalizeTokenValueForComparison(v)).not.toEqual(canonicalizeTokenValueForComparison(tokenIn(figmaDoc(), "semantic", "overlay").values.Light));
		expect(tokenValueToFigma(v, "COLOR")).toEqual({ kind: "composed", color: { reference: "{primitives.grey.900}" }, opacity: { value: 40 } });
	});

	it("rejects bad composed input instead of writing it", () => {
		expect(tokenValueToFigma({ composed: { color: { reference: "{a.b}" }, opacity: { literal: 150 } } } as any, "COLOR").kind).toBe("skip-invalid");
		expect(tokenValueToFigma({ composed: { color: { literal: "#FF0000" }, opacity: { literal: 50 } } } as any, "COLOR").kind).toBe("skip-invalid");
	});
});

describe("composed colors: resolvers", () => {
	const vars = composedPayload.variables;
	const cols = new Map(composedPayload.collections.map((c: any) => [c.id, { ...c, defaultModeId: c.modes[0].modeId }]));
	it("figma_get_variables resolveAliases returns the rendered color", () => {
		const r = resolveVariableAliases(vars.filter((v: any) => ["o", "s", "x"].includes(v.id)), new Map(vars.map((v: any) => [v.id, v])), cols as any);
		const val = (id: string) => r.find((v: any) => v.id === id).resolvedValuesByMode;
		expect(JSON.stringify(val("o"))).toContain("#26262680");
		expect(JSON.stringify(val("s"))).toContain("#26262680");
		expect(JSON.stringify(val("x"))).toContain("#0000FF80");
	});
	it("design-system manifest no longer turns aliased or composed colors black", () => {
		const hex = makeFigmaColorResolver(vars, [...cols.values()] as any);
		expect(hex({ type: "VARIABLE_ALIAS", id: "g" })).toBe("#262626");
		expect(hex(vars.find((v: any) => v.id === "o").valuesByMode["1:0"])).toBe("#26262680");
	});
});

describe("composed colors: review findings", () => {
	const two = (extra: any = {}) => {
		const p = JSON.parse(JSON.stringify(composedPayload));
		// An opacity variable without "opacity" in its name, scoped to OPACITY
		p.variables.find((v: any) => v.id === "a").name = "transparency/medium";
		return Object.assign(p, extra);
	};
	const fmt = (payload: any, target: any) =>
		format(convertFigmaVariablesToDocument(payload, { exportedAt: "x" } as any).document, { target } as any) as any;

	it("an opacity variable is unitless even when its name doesn't say opacity", () => {
		const css = fmt(two(), { format: "css-vars" }).files[0].content;
		expect(css).toMatch(/--transparency-medium: 50;/);
		expect(css).toMatch(/calc\(var\(--transparency-medium\) \* 1%\)/);
		// …and when it is only USED as an opacity (no OPACITY scope)
		const p = two(); delete p.variables.find((v: any) => v.id === "a").scopes;
		expect(fmt(p, { format: "css-vars" }).files[0].content).toMatch(/--transparency-medium: 50;/);
	});

	it("a primitive outside the export falls back to the resolved color", () => {
		const doc = convertFigmaVariablesToDocument(composedPayload, { exportedAt: "x", collectionIds: ["S"] } as any).document;
		const r: any = format(doc, { target: { format: "css-vars" } } as any);
		const css = r.files[0].content;
		expect(css).not.toMatch(/var\(--primitives/);
		expect(css).toMatch(/--overlay: #26262680;/);
		expect(r.warnings.join("\n")).toMatch(/overlay in CSS: exported as its resolved color/);
	});

	it("SCSS mode maps use each mode's resolved color", () => {
		const scss = fmt(composedPayload, { format: "scss" }).files[0].content;
		expect(scss).toMatch(/"Dark": #FFFFFF33/);
	});

	it("cross-collection aliases resolve to the target mode with the same name", () => {
		const p = JSON.parse(JSON.stringify(composedPayload));
		const prim = p.collections.find((c: any) => c.id === "P");
		prim.modes = [{ modeId: "9:0", name: "Light" }, { modeId: "9:1", name: "Dark" }];
		const grey = p.variables.find((v: any) => v.id === "g");
		grey.valuesByMode["9:1"] = { r: 0.9, g: 0.9, b: 0.9, a: 1 };
		p.variables.find((v: any) => v.id === "s").valuesByMode["1:1"] = { color: alias("g"), opacity: 50 };
		const sem = convertFigmaVariablesToDocument(p, { exportedAt: "x" } as any).document.sets.find((s: any) => s.name === "Semantic")!;
		expect(sem.tokens.find((t: any) => t.path.join("/") === "scrim")!.values.Dark.literal).toBe("#E6E6E680");
	});

	it("splitByMode: each file owns only its mode's composition, so an edit survives", () => {
		const files = fmt(composedPayload, { format: "dtcg", splitByMode: true }).files;
		const dark = files.find((f: any) => /dark/i.test(f.path));
		const light = files.find((f: any) => /light/i.test(f.path));
		expect(dark.content).not.toMatch(/"Light": \{\s*"color"/);
		const edited = JSON.parse(dark.content);
		edited.semantic.overlay.$extensions["figma-console-mcp"].composedColor.Dark.opacity = 40;
		const darkDoc = parse("dtcg", { payload: JSON.stringify(edited), sourcePath: dark.path }).document;
		const lightDoc = parse("dtcg", { payload: light.content, sourcePath: light.path }).document;
		const ov = (d: any) => d.sets.find((s: any) => s.name.toLowerCase() === "semantic").tokens.find((t: any) => t.path.join("/") === "overlay").values;
		expect(ov(darkDoc).Dark.composed.opacity).toEqual({ literal: 40 });
		expect(ov(lightDoc).Dark).toBeUndefined();
	});

	it("a $value-only edit imports as a plain color, with a warning", () => {
		const text = out("dtcg").text.replace('"$value": "#26262680"', '"$value": "#FF0000"');
		const r = parse("dtcg", { payload: text });
		const v = r.document.sets.find((s: any) => s.name.toLowerCase() === "semantic")!.tokens.find((t: any) => t.path.join("/") === "overlay")!.values.Light;
		expect(v.composed).toBeUndefined();
		expect(v.literal).toBe("#FF0000");
		expect(r.warnings.join("\n")).toMatch(/\$value was edited but its composedColor wasn't/);
	});
});
