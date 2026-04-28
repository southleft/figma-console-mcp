/**
 * Regression tests for issue #68 — refreshCache: true silently returns no variables.
 *
 * Root cause: figma-desktop-bridge/code.js wraps every EXECUTE_CODE payload in
 * `(async function() { <code> })()`. The websocket-connector and cloud-websocket-
 * connector previously *also* wrapped in `(async () => { ... })()`. The inner IIFE
 * built a Promise as a statement-expression but the outer async returned undefined,
 * so { success: true, variables: [...] } was silently dropped.
 *
 * These tests document the contract code.js expects (bare try/catch with top-level
 * `return`) and the response-envelope unwrap that figma-tools.ts performs.
 */

describe("#68 refreshCache IIFE regression", () => {
	// The wrap that figma-desktop-bridge/code.js (line 289) applies before eval.
	function simulatePluginEval(scriptBody: string): Promise<any> {
		const wrappedCode = "(async function() {\n" + scriptBody + "\n})()";
		// eslint-disable-next-line no-eval
		return eval(wrappedCode);
	}

	beforeEach(() => {
		(global as any).figma = {
			root: { name: "TestFile" },
			fileKey: "test-file-key",
			variables: {
				getLocalVariablesAsync: async () => [
					{
						id: "VariableID:1:1",
						name: "color/primary",
						key: "v_key",
						resolvedType: "COLOR",
						valuesByMode: { "1:0": { r: 1, g: 0, b: 0, a: 1 } },
						variableCollectionId: "VariableCollectionId:1:0",
						scopes: ["ALL_SCOPES"],
						description: "",
						hiddenFromPublishing: false,
					},
				],
				getLocalVariableCollectionsAsync: async () => [
					{
						id: "VariableCollectionId:1:0",
						name: "Tokens",
						key: "c_key",
						modes: [{ modeId: "1:0", name: "Default" }],
						defaultModeId: "1:0",
						variableIds: ["VariableID:1:1"],
					},
				],
			},
		};
	});

	afterEach(() => {
		delete (global as any).figma;
	});

	it("connector contract: bare try/catch with top-level return DOES propagate the value", async () => {
		// This mirrors the post-fix script in src/core/websocket-connector.ts and
		// src/core/cloud-websocket-connector.ts — no inner IIFE, just try/return.
		const connectorScript = `
      try {
        if (typeof figma === 'undefined') {
          throw new Error('Figma API not available in this context');
        }
        const variables = await figma.variables.getLocalVariablesAsync();
        const collections = await figma.variables.getLocalVariableCollectionsAsync();
        return {
          success: true,
          timestamp: Date.now(),
          fileMetadata: { fileName: figma.root.name, fileKey: figma.fileKey || null },
          variables: variables.map(function(v) { return { id: v.id, name: v.name }; }),
          variableCollections: collections.map(function(c) { return { id: c.id, name: c.name }; })
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    `;

		const result = await simulatePluginEval(connectorScript);

		expect(result).toBeDefined();
		expect(result.success).toBe(true);
		expect(result.variables).toHaveLength(1);
		expect(result.variables[0].id).toBe("VariableID:1:1");
		expect(result.variableCollections).toHaveLength(1);
		expect(result.fileMetadata.fileName).toBe("TestFile");
	});

	it("documents the bug: an inner async IIFE swallows the return and yields undefined", async () => {
		// This is the OLD shape from src/core/websocket-connector.ts at v1.22.3.
		// Reverting the connector to this would silently break refreshCache:true again.
		// If a contributor reintroduces the inner IIFE, this test still passes (because
		// it asserts the buggy behavior), but the "bare contract" test above would still
		// pass too — so we add a CI guard below that scans the source for the pattern.
		const buggyScript = `
      (async () => {
        try {
          const variables = await figma.variables.getLocalVariablesAsync();
          return { success: true, variables: variables.map(function(v){return{id:v.id};}) };
        } catch (error) {
          return { success: false, error: error.message };
        }
      })()
    `;

		const result = await simulatePluginEval(buggyScript);
		expect(result).toBeUndefined();
	});

	it("unwrap logic: handles both EXECUTE_CODE-nested and direct GET_VARIABLES_DATA shapes", () => {
		// Mirrors the unwrap at src/core/figma-tools.ts (post-#68-fix). The plugin's
		// ui-full.html handleResult nests EXECUTE_CODE returns under `result`, but the
		// GET_VARIABLES_DATA path returns the variables shape directly.
		function unwrapDesktopVariablesResult(desktopResult: any): any {
			return desktopResult?.result?.variables ? desktopResult.result : desktopResult;
		}

		// Shape A: connector.getVariables() (refreshCache:true) → EXECUTE_CODE → wrapped under .result
		const executeShape = {
			success: true,
			result: {
				success: true,
				variables: [{ id: "v1" }, { id: "v2" }],
				variableCollections: [{ id: "c1" }],
				timestamp: 12345,
			},
		};
		const unwrappedA = unwrapDesktopVariablesResult(executeShape);
		expect(unwrappedA.success).toBe(true);
		expect(unwrappedA.variables).toHaveLength(2);
		expect(unwrappedA.timestamp).toBe(12345);

		// Shape B: connector.getVariablesFromPluginUI() (refreshCache:false) → direct
		const directShape = {
			success: true,
			variables: [{ id: "v9" }],
			variableCollections: [{ id: "c9" }],
		};
		const unwrappedB = unwrapDesktopVariablesResult(directShape);
		expect(unwrappedB.variables).toHaveLength(1);
		expect(unwrappedB.variables[0].id).toBe("v9");

		// Shape C: defensive — pre-fix shape where outer success exists but no variables anywhere.
		// Unwrap should return the original shape so the downstream `if (variableData?.variables)`
		// guard correctly falls through to the REST API fallback rather than crashing.
		const emptyShape = { success: true };
		const unwrappedC = unwrapDesktopVariablesResult(emptyShape);
		expect(unwrappedC).toBe(emptyShape);
		expect(unwrappedC?.variables).toBeUndefined();

		// Shape D: failure shape — connector script threw and code.js wrapped the error.
		const errorShape = {
			success: true,
			result: { success: false, error: "Figma API not available" },
		};
		const unwrappedD = unwrapDesktopVariablesResult(errorShape);
		// No `.result.variables`, so unwrap returns the OUTER object (which has success:true
		// but no .variables). This correctly fails the `variableData.variables` guard and
		// drops to the REST API fallback — same as Shape C.
		expect(unwrappedD).toBe(errorShape);
		expect(unwrappedD?.variables).toBeUndefined();
	});

	// CI guard: if a contributor reintroduces the inner IIFE in either connector,
	// fail fast with a clear message rather than waiting for a Gemini/Codex user
	// to file the same bug again.
	it("source guard: connector getVariables() must not contain an inner async IIFE wrapper", async () => {
		const fs = await import("fs");
		const path = await import("path");
		const root = path.resolve(__dirname, "..");
		const sources = [
			"src/core/websocket-connector.ts",
			"src/core/cloud-websocket-connector.ts",
		];
		for (const rel of sources) {
			const content = fs.readFileSync(path.join(root, rel), "utf8");
			// Locate the getVariables method body (between `async getVariables(` and the next `async ` method)
			const start = content.indexOf("async getVariables(");
			expect(start).toBeGreaterThan(-1);
			const after = content.slice(start);
			const next = after.indexOf("async ", "async getVariables(".length);
			const body = next > -1 ? after.slice(0, next) : after;
			// Reject the inner-IIFE pattern. The plugin's code.js already wraps EXECUTE_CODE
			// payloads in `(async function() { ... })()`; doubling it swallows the return.
			expect(body).not.toMatch(/\(\s*async\s*\(\s*\)\s*=>/);
			expect(body).not.toMatch(/\(\s*async\s+function\s*\(\s*\)/);
		}
	});
});
