/**
 * Code-side accessibility scanning via axe-core + JSDOM.
 *
 * Delegates all rule logic to axe-core (Deque) — the MCP never owns
 * a rule database. JSDOM provides a lightweight DOM for structural checks
 * (~50 rules: ARIA, semantics, alt text, form labels, headings, landmarks).
 *
 * Visual rules (color contrast, focus-visible) are NOT available via JSDOM —
 * those are handled by the design-side figma_lint_design tool.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger } from "./logger.js";

// Lazy-load axe-core and jsdom to keep them optional
let axeCore: any = null;
let JSDOM: any = null;
let depsLoaded = false;
let depsError: string | null = null;

async function loadDeps(): Promise<void> {
	if (depsLoaded) return;
	try {
		axeCore = await import("axe-core");
		// axe-core's default export structure
		if (axeCore.default) axeCore = axeCore.default;
		const jsdomModule = await import("jsdom");
		JSDOM = jsdomModule.JSDOM;
		depsLoaded = true;
	} catch (e: any) {
		depsError = `axe-core or jsdom not installed. Run: npm install axe-core jsdom\n${e.message}`;
		throw new Error(depsError);
	}
}

/**
 * Run axe-core against an HTML string using JSDOM.
 *
 * JSDOM limitations: no computed styles, no layout, no visual rendering.
 * This means ~50-60 structural rules work, but visual rules
 * (color-contrast, focus-visible, etc.) will report as "incomplete".
 */
async function scanHtmlWithAxe(
	html: string,
	options: {
		tags?: string[];
		context?: string;
		disableVisualRules?: boolean;
	} = {},
): Promise<any> {
	await loadDeps();

	// Wrap HTML fragment in a full document if needed
	const fullHtml = html.includes("<html") || html.includes("<!DOCTYPE")
		? html
		: `<!DOCTYPE html><html lang="en"><head><title>Scan</title></head><body>${html}</body></html>`;

	const dom = new JSDOM(fullHtml, {
		runScripts: "dangerously",
		pretendToBeVisual: true,
		url: "http://localhost",
	});

	const { document, window } = dom.window;

	// Inject axe-core into the JSDOM window
	const axeSource = axeCore.source;
	const scriptEl = document.createElement("script");
	scriptEl.textContent = axeSource;
	document.head.appendChild(scriptEl);

	// Configure axe run options
	const runOptions: any = {};

	if (options.tags && options.tags.length > 0) {
		runOptions.runOnly = { type: "tag", values: options.tags };
	}

	// Disable rules that require visual rendering (always fail/incomplete in JSDOM)
	if (options.disableVisualRules !== false) {
		runOptions.rules = {
			"color-contrast": { enabled: false },
			"color-contrast-enhanced": { enabled: false },
			"link-in-text-block": { enabled: false },
		};
	}

	// Determine scan context
	const context = options.context || document;

	try {
		const results = await window.axe.run(context, runOptions);

		// Clean up
		dom.window.close();

		return results;
	} catch (err: any) {
		dom.window.close();
		throw new Error(`axe-core scan failed: ${err.message}`);
	}
}

/**
 * Extract a CodeSpec.accessibility object from HTML + axe-core results.
 * This bridges Phase 3 (code scanning) → Phase 4 (parity comparison).
 *
 * Parses the HTML to extract semantic element, ARIA attributes, and states.
 * Uses axe-core results to infer what the code supports.
 */
export function axeResultsToCodeSpec(html: string, axeResults: any): Record<string, any> {
	const spec: Record<string, any> = {};

	// Parse HTML to extract attributes (lightweight regex-based, no DOM needed)
	const htmlLower = html.toLowerCase();

	// Semantic element: find the root/first meaningful element
	const rootElementMatch = html.match(/<(button|a|input|select|textarea|details|dialog|nav|main|form|label|fieldset)\b/i);
	if (rootElementMatch) {
		spec.semanticElement = rootElementMatch[1].toLowerCase();
	} else {
		const firstElementMatch = html.match(/<(\w+)[\s>]/);
		if (firstElementMatch && !["div", "span", "html", "head", "body", "script", "style", "!doctype"].includes(firstElementMatch[1].toLowerCase())) {
			spec.semanticElement = firstElementMatch[1].toLowerCase();
		} else {
			spec.semanticElement = "div";
		}
	}

	// ARIA role
	const roleMatch = html.match(/role=["']([^"']+)["']/i);
	if (roleMatch) {
		spec.role = roleMatch[1];
	}

	// ARIA label
	const ariaLabelMatch = html.match(/aria-label=["']([^"']+)["']/i);
	if (ariaLabelMatch) {
		spec.ariaLabel = ariaLabelMatch[1];
	}

	// Focus visible: check for :focus-visible or :focus in inline styles/class names,
	// or infer from element type (native interactive elements have default focus)
	const nativeFocusElements = ["button", "a", "input", "select", "textarea"];
	const hasFocusCSS = /focus-visible|:focus\b|outline.*focus|ring.*focus|focus.*ring/i.test(html);
	spec.focusVisible = hasFocusCSS || nativeFocusElements.includes(spec.semanticElement || "");

	// Disabled support: only assert true when we find positive evidence.
	// Absence of disabled/aria-disabled in a single HTML snapshot does NOT mean
	// the component lacks disabled support — it may be in a non-disabled state.
	if (/\bdisabled\b|aria-disabled/i.test(htmlLower)) {
		spec.supportsDisabled = true;
	}
	// (leave undefined when not found — absence ≠ lack of support)

	// Error support: same principle — only assert true on positive evidence.
	// A default-state HTML snippet won't have aria-invalid; that doesn't mean
	// the component can't enter an error state.
	if (/aria-invalid|aria-errormessage|aria-describedby.*error/i.test(htmlLower)) {
		spec.supportsError = true;
	}
	// (leave undefined when not found — scan a different state to confirm)

	// Required: check for required or aria-required attributes
	if (/aria-required=["']true["']|required(?!=)/i.test(html)) {
		spec.ariaRequired = true;
	} else if (/aria-required=["']false["']/i.test(html)) {
		spec.ariaRequired = false;
	}

	// Keyboard interactions: infer from element type
	const keyboardInteractions: string[] = [];
	if (spec.semanticElement === "button" || spec.role === "button") {
		keyboardInteractions.push("Enter", "Space");
	} else if (spec.semanticElement === "a" || spec.role === "link") {
		keyboardInteractions.push("Enter");
	} else if (spec.semanticElement === "input" || spec.semanticElement === "textarea") {
		keyboardInteractions.push("Tab (focus)", "Type (input)");
	} else if (spec.semanticElement === "select" || spec.role === "listbox") {
		keyboardInteractions.push("Arrow keys", "Enter", "Space");
	} else if (spec.role === "checkbox" || spec.role === "switch") {
		keyboardInteractions.push("Space");
	} else if (spec.role === "tab") {
		keyboardInteractions.push("Arrow keys");
	}
	// Check HTML for custom keyboard handlers
	if (/onkeydown|onkeyup|onkeypress|@keydown|@keyup|v-on:keydown/i.test(html)) {
		if (!keyboardInteractions.includes("Custom key handler")) {
			keyboardInteractions.push("Custom key handler");
		}
	}
	if (keyboardInteractions.length > 0) {
		spec.keyboardInteractions = keyboardInteractions;
	}

	// Use axe-core results to refine: if certain violations exist, it tells us what's missing
	if (axeResults?.violations) {
		for (const v of axeResults.violations) {
			// If button-name violation exists, the button has no accessible name
			if (v.id === "button-name") {
				spec.ariaLabel = undefined; // Explicitly missing
			}
			// If label violation exists, input lacks a label
			if (v.id === "label") {
				spec.ariaLabel = undefined;
			}
		}
	}

	return spec;
}

/**
 * Format axe-core results into our standard lint-like output structure.
 */
function formatAxeResults(axeResults: any): any {
	const categories: any[] = [];
	const severityMap: Record<string, string> = {
		critical: "critical",
		serious: "critical",
		moderate: "warning",
		minor: "info",
	};

	// Group violations
	for (const violation of axeResults.violations || []) {
		const severity = severityMap[violation.impact] || "warning";
		const nodes = violation.nodes.map((node: any) => ({
			html: node.html?.substring(0, 200),
			target: node.target,
			failureSummary: node.failureSummary?.substring(0, 300),
		}));

		categories.push({
			rule: violation.id,
			severity,
			count: violation.nodes.length,
			description: violation.help,
			wcagTags: violation.tags.filter((t: string) => t.startsWith("wcag") || t.startsWith("best-practice")),
			helpUrl: violation.helpUrl,
			nodes: nodes.slice(0, 10), // Cap at 10 per rule
		});
	}

	// Sort: critical first, then by count
	categories.sort((a: any, b: any) => {
		const sevOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
		if (sevOrder[a.severity] !== sevOrder[b.severity]) {
			return sevOrder[a.severity] - sevOrder[b.severity];
		}
		return b.count - a.count;
	});

	// Summary
	const summary = { critical: 0, warning: 0, info: 0, total: 0 };
	for (const cat of categories) {
		summary[cat.severity as keyof typeof summary] += cat.count;
		summary.total += cat.count;
	}

	return {
		engine: "axe-core",
		version: axeResults.testEngine?.version || "unknown",
		mode: "jsdom-structural",
		note: "JSDOM mode: structural/semantic checks only. Visual rules (color contrast, focus visibility) are disabled — use figma_lint_design for visual accessibility checks.",
		categories,
		summary,
		passes: axeResults.passes?.length || 0,
		incomplete: axeResults.incomplete?.length || 0,
		inapplicable: axeResults.inapplicable?.length || 0,
	};
}

export function registerAccessibilityTools(
	server: McpServer,
): void {
	server.tool(
		"figma_scan_code_accessibility",
		"Scan HTML code for accessibility violations using axe-core (Deque). " +
		"Runs structural/semantic checks via JSDOM: ARIA attributes, roles, labels, alt text, " +
		"form labels, heading order, landmarks, semantic HTML, tabindex, duplicate IDs, lang attribute, and ~50 more rules. " +
		"Visual checks (color contrast, focus visibility) are disabled in this mode — use figma_lint_design for visual a11y on the design side. " +
		"Together, these two tools provide full-spectrum accessibility coverage across design and code. " +
		"Pass component HTML directly or use with figma_check_design_parity for design-to-code a11y comparison. " +
		"No Figma connection required — this is a standalone code analysis tool.",
		{
			html: z.string().describe("HTML string to scan. Can be a full document or a component fragment (will be wrapped in a valid document)."),
			tags: z.array(z.string()).optional().describe(
				"WCAG tag filter. Examples: ['wcag2a'], ['wcag2aa'], ['wcag21aa'], ['wcag22aa'], ['best-practice']. " +
				"Defaults to all structural rules if omitted.",
			),
			context: z.string().optional().describe("CSS selector to scope the scan to a specific element (e.g., '#my-component', '.card'). Scans entire document if omitted."),
			includePassingRules: z.boolean().optional().describe("If true, includes count of passing and incomplete rules in the response (default: false)."),
			mapToCodeSpec: z.boolean().optional().describe(
				"If true, includes a codeSpec.accessibility object auto-extracted from the HTML + scan results. " +
				"Pass this directly into figma_check_design_parity's codeSpec.accessibility field for automated design-to-code a11y parity checking.",
			),
		},
		async ({ html, tags, context, includePassingRules, mapToCodeSpec }) => {
			try {
				const axeResults = await scanHtmlWithAxe(html, {
					tags: tags || undefined,
					context: context || undefined,
				});

				const formatted = formatAxeResults(axeResults);

				// Optionally strip pass/incomplete counts to save tokens
				if (!includePassingRules) {
					delete formatted.passes;
					delete formatted.incomplete;
					delete formatted.inapplicable;
				}

				// Auto-generate CodeSpec.accessibility from HTML + results
				if (mapToCodeSpec) {
					formatted.codeSpecAccessibility = axeResultsToCodeSpec(html, axeResults);
					formatted.codeSpecAccessibility._usage = "Pass this object as codeSpec.accessibility in figma_check_design_parity for automated a11y parity checking.";
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(formatted, null, 2),
						},
					],
				};
			} catch (error: any) {
				const isDepsError = error.message?.includes("not installed");
				logger.error({ error }, "Failed to scan code accessibility");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: error.message,
								hint: isDepsError
									? "Install dependencies: npm install axe-core jsdom"
									: "Check that the HTML is valid. For visual accessibility checks, use figma_lint_design instead.",
							}),
						},
					],
					isError: true,
				};
			}
		},
	);
}
