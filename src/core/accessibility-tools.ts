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
		},
		async ({ html, tags, context, includePassingRules }) => {
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
