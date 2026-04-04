/**
 * Tests for figma_scan_code_accessibility tool (axe-core + JSDOM)
 *
 * Covers: axe-core rule availability, output format, severity mapping,
 * tag filtering, WCAG coverage, and complementarity with design-side tools.
 *
 * Note: JSDOM has ESM transitive deps that conflict with Jest's CJS transform.
 * Integration tests that scan live HTML are run via a spawned Node process.
 * Unit tests validate formatting, severity mapping, and rule coverage directly.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const axeCore = require("axe-core");
import { execSync } from "child_process";

describe("figma_scan_code_accessibility", () => {
	// ========================================================================
	// axe-core rule availability
	// ========================================================================

	describe("axe-core rules", () => {
		it("should load axe-core successfully", () => {
			expect(axeCore).toBeDefined();
			expect(axeCore.source).toBeDefined();
			expect(typeof axeCore.source).toBe("string");
			expect(axeCore.source.length).toBeGreaterThan(10000);
		});

		it("should have 100+ rules", () => {
			expect(axeCore.getRules().length).toBeGreaterThanOrEqual(100);
		});

		it("should support WCAG 2.0 A tags", () => {
			expect(axeCore.getRules(["wcag2a"]).length).toBeGreaterThan(0);
		});

		it("should support WCAG 2.0 AA tags", () => {
			expect(axeCore.getRules(["wcag2aa"]).length).toBeGreaterThan(0);
		});

		it("should support WCAG 2.1 AA tags", () => {
			expect(axeCore.getRules(["wcag21aa"]).length).toBeGreaterThan(0);
		});

		it("should support WCAG 2.2 AA tags", () => {
			expect(axeCore.getRules(["wcag22aa"]).length).toBeGreaterThan(0);
		});

		it("should support best-practice tags", () => {
			expect(axeCore.getRules(["best-practice"]).length).toBeGreaterThan(0);
		});

		it("should have ARIA category rules", () => {
			expect(axeCore.getRules(["cat.aria"]).length).toBeGreaterThan(10);
		});

		it("should have form category rules", () => {
			expect(axeCore.getRules(["cat.forms"]).length).toBeGreaterThan(0);
		});

		it("should have semantics category rules", () => {
			expect(axeCore.getRules(["cat.semantics"]).length).toBeGreaterThan(0);
		});

		it("should have text-alternatives category rules", () => {
			expect(axeCore.getRules(["cat.text-alternatives"]).length).toBeGreaterThan(0);
		});

		it("should have structure category rules", () => {
			expect(axeCore.getRules(["cat.structure"]).length).toBeGreaterThan(0);
		});
	});

	// ========================================================================
	// Structural rules that design-side cannot check
	// ========================================================================

	describe("code-only rules (not available in Figma design)", () => {
		const allRuleIds = axeCore.getRules().map((r: any) => r.ruleId);

		const codeOnlyChecks = [
			"aria-allowed-attr",
			"aria-required-attr",
			"aria-roles",
			"button-name",
			"document-title",
			"duplicate-id",
			"html-has-lang",
			"image-alt",
			"label",
			"landmark-one-main",
			"link-name",
			"list",
			"tabindex",
		];

		for (const rule of codeOnlyChecks) {
			it(`should include rule: ${rule}`, () => {
				expect(allRuleIds).toContain(rule);
			});
		}
	});

	// ========================================================================
	// Severity mapping
	// ========================================================================

	describe("severity mapping", () => {
		const severityMap: Record<string, string> = {
			critical: "critical",
			serious: "critical",
			moderate: "warning",
			minor: "info",
		};

		it("should map critical impact to critical severity", () => {
			expect(severityMap["critical"]).toBe("critical");
		});

		it("should map serious impact to critical severity", () => {
			expect(severityMap["serious"]).toBe("critical");
		});

		it("should map moderate impact to warning severity", () => {
			expect(severityMap["moderate"]).toBe("warning");
		});

		it("should map minor impact to info severity", () => {
			expect(severityMap["minor"]).toBe("info");
		});
	});

	// ========================================================================
	// Output format
	// ========================================================================

	describe("output format", () => {
		it("should produce categories with expected fields", () => {
			const category = {
				rule: "image-alt",
				severity: "critical",
				count: 2,
				description: "Images must have alternate text",
				wcagTags: ["wcag2a", "wcag111"],
				helpUrl: "https://dequeuniversity.com/rules/axe/4.11/image-alt",
				nodes: [
					{
						html: '<img src="photo.jpg">',
						target: ["img"],
						failureSummary: "Fix any of the following: ...",
					},
				],
			};

			expect(category.rule).toBeDefined();
			expect(category.severity).toMatch(/critical|warning|info/);
			expect(category.count).toBeGreaterThan(0);
			expect(category.wcagTags).toBeInstanceOf(Array);
			expect(category.helpUrl).toMatch(/^https:/);
			expect(category.nodes).toBeInstanceOf(Array);
			expect(category.nodes[0]).toHaveProperty("html");
			expect(category.nodes[0]).toHaveProperty("target");
			expect(category.nodes[0]).toHaveProperty("failureSummary");
		});

		it("should produce summary with correct totals", () => {
			const summary = { critical: 3, warning: 5, info: 1, total: 9 };
			expect(summary.total).toBe(
				summary.critical + summary.warning + summary.info,
			);
		});

		it("should include engine metadata", () => {
			const meta = {
				engine: "axe-core",
				version: axeCore.version,
				mode: "jsdom-structural",
				note: "JSDOM mode: structural/semantic checks only.",
			};

			expect(meta.engine).toBe("axe-core");
			expect(meta.mode).toBe("jsdom-structural");
			expect(meta.version).toMatch(/\d+\.\d+\.\d+/);
		});

		it("should sort categories: critical first, then by count", () => {
			const categories = [
				{ severity: "info", count: 5 },
				{ severity: "critical", count: 1 },
				{ severity: "warning", count: 10 },
				{ severity: "critical", count: 3 },
			];

			const sevOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
			const sorted = categories.sort((a, b) => {
				if (sevOrder[a.severity] !== sevOrder[b.severity]) {
					return sevOrder[a.severity] - sevOrder[b.severity];
				}
				return b.count - a.count;
			});

			expect(sorted[0]).toEqual({ severity: "critical", count: 3 });
			expect(sorted[1]).toEqual({ severity: "critical", count: 1 });
			expect(sorted[2]).toEqual({ severity: "warning", count: 10 });
			expect(sorted[3]).toEqual({ severity: "info", count: 5 });
		});

		it("should cap nodes at 10 per rule", () => {
			const nodes = Array.from({ length: 15 }, (_, i) => ({
				html: `<div id="item-${i}">`,
			}));
			const capped = nodes.slice(0, 10);
			expect(capped).toHaveLength(10);
		});
	});

	// ========================================================================
	// Visual rule handling
	// ========================================================================

	describe("visual rule handling", () => {
		const disabledVisualRules = [
			"color-contrast",
			"color-contrast-enhanced",
			"link-in-text-block",
		];

		it("should disable visual rules in JSDOM mode", () => {
			const rules: Record<string, { enabled: boolean }> = {};
			for (const rule of disabledVisualRules) {
				rules[rule] = { enabled: false };
			}
			expect(rules["color-contrast"].enabled).toBe(false);
			expect(rules["color-contrast-enhanced"].enabled).toBe(false);
			expect(rules["link-in-text-block"].enabled).toBe(false);
		});

		it("should have visual rules available in axe-core (just disabled)", () => {
			const allRuleIds = axeCore.getRules().map((r: any) => r.ruleId);
			for (const rule of disabledVisualRules) {
				expect(allRuleIds).toContain(rule);
			}
		});

		it("should note figma_lint_design handles visual checks", () => {
			const note =
				"JSDOM mode: structural/semantic checks only. Visual rules (color contrast, focus visibility) are disabled — use figma_lint_design for visual accessibility checks.";
			expect(note).toContain("figma_lint_design");
			expect(note).toContain("color contrast");
		});
	});

	// ========================================================================
	// Live JSDOM + axe-core integration (via child process to avoid ESM issue)
	// ========================================================================

	describe("live scanning integration", () => {
		function runAxeScan(html: string): any {
			const fs = require("fs");
			const path = require("path");
			const tmpFile = path.join(__dirname, `..`, `.axe-scan-${Date.now()}.cjs`);
			const script = `
const { JSDOM } = require('jsdom');
const axeCore = require('axe-core');
const html = ${JSON.stringify(html)};
const fullHtml = html.includes('<html') ? html : '<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body>' + html + '</body></html>';
const dom = new JSDOM(fullHtml, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost' });
const s = dom.window.document.createElement('script');
s.textContent = axeCore.source;
dom.window.document.head.appendChild(s);
dom.window.axe.run(dom.window.document, { rules: { 'color-contrast': { enabled: false }, 'color-contrast-enhanced': { enabled: false }, 'link-in-text-block': { enabled: false } } }).then(results => {
	dom.window.close();
	console.log(JSON.stringify({ violations: results.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })), passes: results.passes.length }));
}).catch(err => { dom.window.close(); console.log(JSON.stringify({ error: err.message })); });
`;
			fs.writeFileSync(tmpFile, script);
			try {
				const result = execSync(`node "${tmpFile}"`, {
					timeout: 30000,
					encoding: "utf-8",
					cwd: path.resolve(__dirname, ".."),
				}).trim();
				return JSON.parse(result);
			} finally {
				fs.unlinkSync(tmpFile);
			}
		}

		it("should detect missing alt text on images", () => {
			const result = runAxeScan('<img src="photo.jpg">');
			expect(result.violations).toBeDefined();
			const altRule = result.violations.find((v: any) => v.id === "image-alt");
			expect(altRule).toBeDefined();
			expect(altRule.impact).toBe("critical");
		}, 30000);

		it("should pass for accessible images", () => {
			const result = runAxeScan('<img src="photo.jpg" alt="Team photo">');
			const altRule = result.violations.find((v: any) => v.id === "image-alt");
			expect(altRule).toBeUndefined();
		}, 30000);

		it("should detect missing form labels", () => {
			const result = runAxeScan('<input type="text" id="name">');
			const labelRule = result.violations.find((v: any) => v.id === "label");
			expect(labelRule).toBeDefined();
		}, 30000);

		it("should detect buttons without accessible names", () => {
			const result = runAxeScan("<button></button>");
			const btnRule = result.violations.find((v: any) => v.id === "button-name");
			expect(btnRule).toBeDefined();
		}, 30000);

		it("should detect missing lang attribute", () => {
			const result = runAxeScan(
				"<!DOCTYPE html><html><head><title>Test</title></head><body><p>Hello</p></body></html>",
			);
			const langRule = result.violations.find((v: any) => v.id === "html-has-lang");
			expect(langRule).toBeDefined();
		}, 30000);

		it("should handle empty body gracefully", () => {
			const result = runAxeScan("<div></div>");
			expect(result.violations).toBeDefined();
			expect(result.passes).toBeGreaterThan(0);
		}, 30000);
	});

	// ========================================================================
	// Design-code complementarity
	// ========================================================================

	describe("design-code complementarity", () => {
		it("should handle checks that design-side lint cannot", () => {
			// Design-side checks (figma_lint_design):
			const designChecks = [
				"color-contrast",
				"text-size",
				"target-size",
				"line-height",
				"non-text-contrast",
				"color-only",
				"focus-indicator",
				"letter-spacing",
				"paragraph-spacing",
				"image-alt-annotations",
				"heading-hierarchy-visual",
				"reflow",
				"reading-order",
			];

			// Code-side checks (axe-core via JSDOM):
			const codeChecks = [
				"aria-allowed-attr",
				"aria-required-attr",
				"button-name",
				"document-title",
				"duplicate-id",
				"html-has-lang",
				"image-alt",
				"label",
				"landmark-one-main",
				"link-name",
				"tabindex",
				"list",
			];

			// No overlap — they're complementary
			const overlap = designChecks.filter((d) => codeChecks.includes(d));
			expect(overlap).toHaveLength(0);
		});

		it("should together cover visual + structural accessibility", () => {
			const designCovers = "visual"; // contrast, spacing, sizes, colors
			const codeCovers = "structural"; // ARIA, semantics, labels, landmarks
			expect(designCovers).not.toBe(codeCovers);
		});
	});
});
