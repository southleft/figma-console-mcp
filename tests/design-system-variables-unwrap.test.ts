/**
 * The design-system cache (figma_get_design_system_summary,
 * figma_get_token_values, ...) read `getVariables().data`, but that call runs
 * through EXECUTE_CODE, which nests the payload under `result`. Every file
 * reported 0 tokens (seen on a 15,206-variable file).
 */

import { readFileSync } from "fs";
import { join } from "path";
import { unwrapBridgeVariables } from "../src/core/design-system-manifest";

describe("unwrapBridgeVariables", () => {
	const payload = { success: true, variables: [{ id: "v1" }], variableCollections: [{ id: "c1" }] };

	it("unwraps the EXECUTE_CODE envelope", () => {
		expect(unwrapBridgeVariables({ success: true, result: payload })).toEqual({ variables: [{ id: "v1" }], variableCollections: [{ id: "c1" }] });
	});

	it("accepts the bare snapshot shape and a .data envelope", () => {
		expect(unwrapBridgeVariables(payload)?.variables).toHaveLength(1);
		expect(unwrapBridgeVariables({ success: true, data: payload })?.variables).toHaveLength(1);
	});

	it("returns null for failures", () => {
		expect(unwrapBridgeVariables({ success: true, result: { success: false, error: "x" } })).toBeNull();
		expect(unwrapBridgeVariables(undefined)).toBeNull();
	});
});

describe("src/local.ts design-system cache", () => {
	it("no longer reads getVariables().data directly", () => {
		const src = readFileSync(join(__dirname, "..", "src", "local.ts"), "utf-8");
		expect(src).not.toMatch(/variablesResult\.data/);
		expect((src.match(/unwrapBridgeVariables\(await connector\.getVariables\(fileKey\)\)/g) || []).length).toBe(2);
	});
});
