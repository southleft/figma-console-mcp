/**
 * Regression tests for the ui.html relay field cherry-pick.
 *
 * The Desktop Bridge has three hops: code.js (plugin sandbox) → ui.html (relay)
 * → WebSocket → server. handleResult() in ui.html does NOT forward the plugin's
 * message wholesale — it rebuilds a fresh object field by field. Any field
 * code.js starts sending that nobody adds to that list is silently dropped, and
 * because the server-side tests mock the connector, they keep passing while the
 * field never arrives in production.
 *
 * That is exactly how `resultAnalysis` and `fileContext` went missing on
 * EXECUTE_CODE: code.js has always sent both, figma_execute's own tool
 * description tells callers to check resultAnalysis.warning for silent
 * failures, and neither ever reached the server.
 *
 * These tests read the real plugin files and assert the contract holds, so the
 * next field added to code.js fails here instead of silently vanishing.
 */

import { readFileSync } from "fs";
import { join } from "path";

const PLUGIN_DIR = join(__dirname, "..", "figma-desktop-bridge");
const codeJs = readFileSync(join(PLUGIN_DIR, "code.js"), "utf8");
const uiHtml = readFileSync(join(PLUGIN_DIR, "ui.html"), "utf8");

/**
 * Extract the top-level keys of the object literal passed to the
 * figma.ui.postMessage(...) call that reports a successful EXECUTE_CODE.
 * Brace/bracket-depth scan so nested objects (fileContext) don't leak keys.
 */
function executeCodeSuccessKeys(): string[] {
	const marker = "type: 'EXECUTE_CODE_RESULT',";
	// The success path is the one that also carries `success: true`.
	let searchFrom = 0;
	let block: string | null = null;
	while (searchFrom < codeJs.length) {
		const at = codeJs.indexOf(marker, searchFrom);
		if (at === -1) break;
		searchFrom = at + marker.length;

		// Walk back to the opening brace of this object literal.
		const open = codeJs.lastIndexOf("{", at);
		let depth = 0;
		let end = -1;
		for (let i = open; i < codeJs.length; i++) {
			const ch = codeJs[i];
			if (ch === "{" || ch === "[") depth++;
			else if (ch === "}" || ch === "]") {
				depth--;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		if (end === -1) continue;
		const candidate = codeJs.slice(open + 1, end);
		if (/\bsuccess:\s*true\b/.test(candidate)) {
			block = candidate;
			break;
		}
	}

	if (!block) throw new Error("Could not locate the EXECUTE_CODE_RESULT success payload in code.js");

	// Strip comments before scanning for keys — code.js documents fileContext
	// with a line comment directly above it, which would otherwise be swallowed
	// into the key buffer and make the field look absent.
	block = block.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

	const keys: string[] = [];
	let depth = 0;
	let atKeyPosition = true;
	let buffer = "";
	for (let i = 0; i < block.length; i++) {
		const ch = block[i];
		if (ch === "{" || ch === "[") depth++;
		else if (ch === "}" || ch === "]") depth--;

		if (depth !== 0) continue;

		if (ch === ",") {
			atKeyPosition = true;
			buffer = "";
			continue;
		}
		if (ch === ":" && atKeyPosition) {
			const key = buffer.trim().replace(/^["']|["']$/g, "");
			if (/^[A-Za-z_$][\w$]*$/.test(key)) keys.push(key);
			atKeyPosition = false;
			buffer = "";
			continue;
		}
		buffer += ch;
	}
	return keys;
}

/** The body of handleResult() in ui.html — the field-by-field rebuild. */
function handleResultBody(): string {
	const start = uiHtml.indexOf("const handleResult = (resultType, dataKey) => {");
	expect(start).toBeGreaterThan(-1);
	const end = uiHtml.indexOf("\n      };", start);
	expect(end).toBeGreaterThan(start);
	return uiHtml.slice(start, end);
}

describe("Desktop Bridge relay field passthrough", () => {
	// Handled structurally by handleResult rather than by name:
	//   type      — drives the switch that calls handleResult
	//   requestId — used to look up the pending request
	//   success   — branches success vs error
	//   result    — arrives as the `dataKey` argument ('result' for EXECUTE_CODE)
	const STRUCTURAL = new Set(["type", "requestId", "success", "result"]);

	it("relays every field code.js sends on a successful EXECUTE_CODE", () => {
		const sent = executeCodeSuccessKeys();
		const relay = handleResultBody();

		// Sanity: the extraction actually found the payload.
		expect(sent).toEqual(expect.arrayContaining(["type", "success", "result"]));

		const dropped = sent
			.filter((key) => !STRUCTURAL.has(key))
			.filter((key) => !new RegExp(`\\bmsg\\.${key}\\b`).test(relay));

		expect(dropped).toEqual([]);
	});

	it("forwards resultAnalysis, which figma_execute's description tells callers to check", () => {
		const relay = handleResultBody();
		expect(relay).toMatch(/msg\.resultAnalysis !== undefined/);
		expect(relay).toMatch(/result\.resultAnalysis = msg\.resultAnalysis/);
	});

	it("forwards fileContext, which is how per-file targeting is verified", () => {
		const relay = handleResultBody();
		expect(relay).toMatch(/msg\.fileContext !== undefined/);
		expect(relay).toMatch(/result\.fileContext = msg\.fileContext/);
	});

	it("still sends fileContext from the plugin sandbox", () => {
		// The relay fix is worthless if code.js stops reporting it.
		expect(executeCodeSuccessKeys()).toEqual(expect.arrayContaining(["fileContext", "resultAnalysis"]));
	});
});
