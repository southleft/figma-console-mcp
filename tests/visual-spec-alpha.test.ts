import { describe, expect, it } from "@jest/globals";
import { extractVisualSpec } from "../src/core/design-system-tools";

describe("extractVisualSpec color alpha", () => {
	it("keeps the alpha of shadow, stroke and fill colors below 1", () => {
		const vs: any = extractVisualSpec({
			type: "COMPONENT",
			effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 2 }, radius: 4 }],
			strokes: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 0.5 } }],
			fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 1, a: 0.12 } }],
		});
		expect(vs.effects[0].color).toBe("#00000040");
		expect(vs.strokes[0].color).toBe("#FF000080");
		expect(vs.fills[0].color).toBe("#0000FF1F");
	});

	it("leaves opaque or alpha-less colors as #RRGGBB", () => {
		const vs: any = extractVisualSpec({
			type: "RECTANGLE",
			fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }, { type: "SOLID", color: { r: 0, g: 1, b: 0, a: 1 } }],
		});
		expect(vs.fills.map((f: any) => f.color)).toEqual(["#FF0000", "#00FF00"]);
	});
});
