/**
 * Plugin command failures must surface as errors.
 *
 * Found live (2026-11-27): figma_update_variable with a mode id Figma rejects
 * ("mode with id 7874:0 not defined for variable") reported "updated
 * successfully" and nothing was written. The plugin UI's per-method wrappers
 * catch the plugin's rejection and RESOLVE it as { success: false, error }, so
 * the WebSocket server treated it as a normal result, and tools that don't
 * check `success` reported success.
 */
import { bridgeCommandFailure } from "../src/core/bridge-result";

describe("bridgeCommandFailure", () => {
	it("turns a { success: false, error } reply into its error message", () => {
		expect(
			bridgeCommandFailure("UPDATE_VARIABLE", {
				success: false,
				error: "in setValueForMode: mode with id 7874:0 not defined for variable",
			}),
		).toBe("in setValueForMode: mode with id 7874:0 not defined for variable");
	});

	it("names the command when the failure carries no message", () => {
		expect(bridgeCommandFailure("RENAME_MODE", { success: false })).toMatch(/RENAME_MODE/);
	});

	it("leaves successful and non-object replies alone", () => {
		expect(bridgeCommandFailure("UPDATE_VARIABLE", { success: true, variable: {} })).toBeNull();
		expect(bridgeCommandFailure("GET_FILE_INFO", { fileKey: "x" })).toBeNull();
		expect(bridgeCommandFailure("PING", undefined)).toBeNull();
		expect(bridgeCommandFailure("PING", "pong")).toBeNull();
	});

	it("leaves EXECUTE_CODE alone: figma_execute reports user-code errors itself", () => {
		expect(bridgeCommandFailure("EXECUTE_CODE", { success: false, error: "ReferenceError: x" })).toBeNull();
	});
});
