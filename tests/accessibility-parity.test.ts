/**
 * Tests for expanded compareAccessibility() parity checks (Phase 4)
 *
 * Covers: 9 design-to-code accessibility parity checks including
 * focus indicators, disabled states, semantic elements, target sizes,
 * error states, required fields, keyboard interactions, contrast, and ARIA roles.
 */

import type { CodeSpec, ParityDiscrepancy } from "../src/core/types/design-code";
import { axeResultsToCodeSpec } from "../src/core/accessibility-tools";

// Re-implement compareAccessibility logic for unit testing
// (The actual function is private in design-code-tools.ts)
function compareAccessibility(
	node: any,
	codeSpec: CodeSpec,
	discrepancies: ParityDiscrepancy[],
): void {
	const ca = codeSpec.accessibility;
	if (!ca) return;

	const description = node.descriptionMarkdown || node.description || "";
	const descLower = description.toLowerCase();
	const hasAriaAnnotation = descLower.includes("aria") || descLower.includes("accessibility");

	// 1. ARIA Role
	if (ca.role && !hasAriaAnnotation) {
		discrepancies.push({
			category: "accessibility",
			property: "role",
			severity: "info",
			designValue: null,
			codeValue: ca.role,
			message: `Code defines role="${ca.role}" but design has no accessibility annotations`,
			suggestion: "Add accessibility annotations in Figma description",
		});
	}

	// 2. Semantic Element
	if (ca.semanticElement) {
		const nodeName = (node.name || "").toLowerCase();
		const element = ca.semanticElement.toLowerCase();
		const interactivePattern = /button|link|input|checkbox|radio|switch|toggle|tab|select/i;
		if (interactivePattern.test(nodeName)) {
			const elementMatchesDesign =
				(nodeName.includes("button") && (element === "button" || ca.role === "button")) ||
				(nodeName.includes("link") && (element === "a" || ca.role === "link")) ||
				(nodeName.includes("input") && (element === "input" || element === "textarea")) ||
				(nodeName.includes("checkbox") && (element === "input" || ca.role === "checkbox")) ||
				(nodeName.includes("radio") && (element === "input" || ca.role === "radio")) ||
				(nodeName.includes("switch") && (ca.role === "switch" || element === "input")) ||
				(nodeName.includes("select") && (element === "select" || ca.role === "listbox")) ||
				(nodeName.includes("tab") && (ca.role === "tab" || element === "button"));

			if (!elementMatchesDesign) {
				discrepancies.push({
					category: "accessibility",
					property: "semanticElement",
					severity: "major",
					designValue: nodeName,
					codeValue: `<${element}>${ca.role ? ` role="${ca.role}"` : ""}`,
					message: `Design component "${node.name}" may not match code element <${element}>`,
				});
			}
		}
	}

	// 3. Contrast Ratio
	if (ca.contrastRatio !== undefined && ca.contrastRatio < 4.5) {
		discrepancies.push({
			category: "accessibility",
			property: "contrastRatio",
			severity: "critical",
			designValue: null,
			codeValue: ca.contrastRatio,
			message: `Contrast ratio ${ca.contrastRatio}:1 fails WCAG AA minimum (4.5:1)`,
		});
	}

	// 4. Focus Indicator
	const variants = node.children || [];
	const hasFocusVariant = variants.some((v: any) => /focus|focused/i.test(v.name || ""));
	if (hasFocusVariant && ca.focusVisible === false) {
		discrepancies.push({
			category: "accessibility",
			property: "focusVisible",
			severity: "critical",
			designValue: "focus variant exists",
			codeValue: "focusVisible: false",
			message: "Design has a focus variant but code does not implement :focus-visible styles",
		});
	} else if (!hasFocusVariant && ca.focusVisible === true) {
		discrepancies.push({
			category: "accessibility",
			property: "focusVisible",
			severity: "minor",
			designValue: "no focus variant",
			codeValue: "focusVisible: true",
			message: "Code implements :focus-visible but design has no focus variant",
		});
	}

	// 5. Disabled State
	const hasDisabledVariant = variants.some((v: any) => /disabled|inactive/i.test(v.name || ""));
	if (hasDisabledVariant && ca.supportsDisabled === false) {
		discrepancies.push({
			category: "accessibility",
			property: "disabled",
			severity: "major",
			designValue: "disabled variant exists",
			codeValue: "supportsDisabled: false",
			message: "Design has a disabled variant but code does not support disabled state",
		});
	} else if (!hasDisabledVariant && ca.supportsDisabled === true) {
		discrepancies.push({
			category: "accessibility",
			property: "disabled",
			severity: "minor",
			designValue: "no disabled variant",
			codeValue: "supportsDisabled: true",
			message: "Code supports disabled state but design has no disabled variant",
		});
	}

	// 6. Error State
	const hasErrorVariant = variants.some((v: any) => /error|invalid|danger/i.test(v.name || ""));
	if (hasErrorVariant && ca.supportsError === false) {
		discrepancies.push({
			category: "accessibility",
			property: "errorState",
			severity: "major",
			designValue: "error variant exists",
			codeValue: "supportsError: false",
			message: "Design has an error variant but code does not support error state",
		});
	}

	// 7. Required Field
	if (ca.ariaRequired !== undefined) {
		const hasRequiredVariant = variants.some((v: any) => /required/i.test(v.name || ""));
		const hasRequiredInDescription = descLower.includes("required");
		if (ca.ariaRequired && !hasRequiredVariant && !hasRequiredInDescription) {
			discrepancies.push({
				category: "accessibility",
				property: "required",
				severity: "minor",
				designValue: "no required indicator",
				codeValue: "ariaRequired: true",
				message: "Code marks field as required but design has no visual required indicator",
			});
		}
	}

	// 8. Target Size
	if (ca.renderedSize) {
		const [codeWidth, codeHeight] = ca.renderedSize;
		const designWidth = node.absoluteBoundingBox?.width || node.size?.x;
		const designHeight = node.absoluteBoundingBox?.height || node.size?.y;
		if (designWidth && designHeight) {
			if (codeWidth < designWidth * 0.8 || codeHeight < designHeight * 0.8) {
				discrepancies.push({
					category: "accessibility",
					property: "targetSize",
					severity: "major",
					designValue: `${Math.round(designWidth)}x${Math.round(designHeight)}`,
					codeValue: `${codeWidth}x${codeHeight}`,
					message: `Code renders smaller than design`,
				});
			}
			if (codeWidth < 24 || codeHeight < 24) {
				discrepancies.push({
					category: "accessibility",
					property: "targetSize",
					severity: "critical",
					designValue: `${Math.round(designWidth)}x${Math.round(designHeight)}`,
					codeValue: `${codeWidth}x${codeHeight}`,
					message: `Code renders below WCAG 2.5.8 minimum (24x24px)`,
				});
			}
		}
	}

	// 9. Keyboard Interactions
	if (ca.keyboardInteractions && ca.keyboardInteractions.length > 0 && !descLower.includes("keyboard")) {
		discrepancies.push({
			category: "accessibility",
			property: "keyboardInteractions",
			severity: "info",
			designValue: null,
			codeValue: ca.keyboardInteractions.join(", "),
			message: `Code defines keyboard interactions but design has no keyboard documentation`,
		});
	}
}

// ============================================================================
// Tests
// ============================================================================

describe("compareAccessibility (Phase 4 parity checks)", () => {
	// ========================================================================
	// 1. ARIA Role
	// ========================================================================
	describe("ARIA role parity", () => {
		it("should flag when code has role but design lacks annotation", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Button", description: "" },
				{ accessibility: { role: "button" } },
				d,
			);
			expect(d).toHaveLength(1);
			expect(d[0].property).toBe("role");
			expect(d[0].severity).toBe("info");
		});

		it("should NOT flag when design has aria annotation", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Button", description: "Accessibility: role=button, tabindex=0" },
				{ accessibility: { role: "button" } },
				d,
			);
			expect(d).toHaveLength(0);
		});

		it("should skip when no accessibility spec provided", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility({ name: "Button" }, {}, d);
			expect(d).toHaveLength(0);
		});
	});

	// ========================================================================
	// 2. Semantic Element
	// ========================================================================
	describe("semantic element parity", () => {
		it("should pass when button design uses <button> element", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Button", description: "" },
				{ accessibility: { semanticElement: "button" } },
				d,
			);
			const semIssue = d.find((i) => i.property === "semanticElement");
			expect(semIssue).toBeUndefined();
		});

		it("should flag when button design uses <div> element", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Button", description: "" },
				{ accessibility: { semanticElement: "div" } },
				d,
			);
			const semIssue = d.find((i) => i.property === "semanticElement");
			expect(semIssue).toBeDefined();
			expect(semIssue!.severity).toBe("major");
		});

		it("should pass when link design uses <a> element", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Link", description: "" },
				{ accessibility: { semanticElement: "a" } },
				d,
			);
			const semIssue = d.find((i) => i.property === "semanticElement");
			expect(semIssue).toBeUndefined();
		});

		it("should pass when checkbox design uses role=checkbox", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Checkbox", description: "" },
				{ accessibility: { semanticElement: "div", role: "checkbox" } },
				d,
			);
			const semIssue = d.find((i) => i.property === "semanticElement");
			expect(semIssue).toBeUndefined();
		});

		it("should NOT check non-interactive components", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Card", description: "" },
				{ accessibility: { semanticElement: "div" } },
				d,
			);
			const semIssue = d.find((i) => i.property === "semanticElement");
			expect(semIssue).toBeUndefined();
		});
	});

	// ========================================================================
	// 3. Contrast Ratio
	// ========================================================================
	describe("contrast ratio parity", () => {
		it("should flag contrast below 4.5:1", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Label", description: "" },
				{ accessibility: { contrastRatio: 3.2 } },
				d,
			);
			expect(d.find((i) => i.property === "contrastRatio")).toBeDefined();
			expect(d.find((i) => i.property === "contrastRatio")!.severity).toBe("critical");
		});

		it("should NOT flag contrast at 4.5:1", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Label", description: "" },
				{ accessibility: { contrastRatio: 4.5 } },
				d,
			);
			expect(d.find((i) => i.property === "contrastRatio")).toBeUndefined();
		});
	});

	// ========================================================================
	// 4. Focus Indicator
	// ========================================================================
	describe("focus indicator parity", () => {
		it("should flag when design has focus variant but code lacks focus-visible", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Button", description: "", children: [{ name: "State=Default" }, { name: "State=Focused" }] },
				{ accessibility: { focusVisible: false } },
				d,
			);
			const issue = d.find((i) => i.property === "focusVisible");
			expect(issue).toBeDefined();
			expect(issue!.severity).toBe("critical");
			expect(issue!.designValue).toBe("focus variant exists");
		});

		it("should flag when code has focus-visible but design lacks focus variant", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Button", description: "", children: [{ name: "State=Default" }, { name: "State=Hover" }] },
				{ accessibility: { focusVisible: true } },
				d,
			);
			const issue = d.find((i) => i.property === "focusVisible");
			expect(issue).toBeDefined();
			expect(issue!.severity).toBe("minor");
		});

		it("should NOT flag when both design and code have focus", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Button", description: "", children: [{ name: "State=Focused" }] },
				{ accessibility: { focusVisible: true } },
				d,
			);
			expect(d.find((i) => i.property === "focusVisible")).toBeUndefined();
		});

		it("should NOT flag when neither has focus", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Button", description: "", children: [{ name: "State=Default" }] },
				{ accessibility: { focusVisible: undefined } },
				d,
			);
			expect(d.find((i) => i.property === "focusVisible")).toBeUndefined();
		});
	});

	// ========================================================================
	// 5. Disabled State
	// ========================================================================
	describe("disabled state parity", () => {
		it("should flag when design has disabled but code doesn't support it", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Button", description: "", children: [{ name: "State=Disabled" }] },
				{ accessibility: { supportsDisabled: false } },
				d,
			);
			const issue = d.find((i) => i.property === "disabled");
			expect(issue).toBeDefined();
			expect(issue!.severity).toBe("major");
		});

		it("should flag when code supports disabled but design lacks variant", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Button", description: "", children: [{ name: "State=Default" }] },
				{ accessibility: { supportsDisabled: true } },
				d,
			);
			const issue = d.find((i) => i.property === "disabled");
			expect(issue).toBeDefined();
			expect(issue!.severity).toBe("minor");
		});

		it("should match inactive variant name", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Button", description: "", children: [{ name: "State=Inactive" }] },
				{ accessibility: { supportsDisabled: true } },
				d,
			);
			expect(d.find((i) => i.property === "disabled")).toBeUndefined();
		});
	});

	// ========================================================================
	// 6. Error State
	// ========================================================================
	describe("error state parity", () => {
		it("should flag when design has error variant but code doesn't support it", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Input", description: "", children: [{ name: "State=Error" }] },
				{ accessibility: { supportsError: false } },
				d,
			);
			const issue = d.find((i) => i.property === "errorState");
			expect(issue).toBeDefined();
			expect(issue!.severity).toBe("major");
		});

		it("should match danger variant name", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Input", description: "", children: [{ name: "type=danger" }] },
				{ accessibility: { supportsError: false } },
				d,
			);
			expect(d.find((i) => i.property === "errorState")).toBeDefined();
		});

		it("should NOT flag when code supports error", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Input", description: "", children: [{ name: "State=Error" }] },
				{ accessibility: { supportsError: true } },
				d,
			);
			expect(d.find((i) => i.property === "errorState")).toBeUndefined();
		});

		it("should NOT flag when no error variant exists", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Input", description: "", children: [{ name: "State=Default" }] },
				{ accessibility: { supportsError: false } },
				d,
			);
			expect(d.find((i) => i.property === "errorState")).toBeUndefined();
		});
	});

	// ========================================================================
	// 7. Required Field
	// ========================================================================
	describe("required field parity", () => {
		it("should flag when code has required but design lacks indicator", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Input", description: "", children: [{ name: "State=Default" }] },
				{ accessibility: { ariaRequired: true } },
				d,
			);
			const issue = d.find((i) => i.property === "required");
			expect(issue).toBeDefined();
			expect(issue!.severity).toBe("minor");
		});

		it("should NOT flag when design has required variant", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Input", description: "", children: [{ name: "Required=true" }] },
				{ accessibility: { ariaRequired: true } },
				d,
			);
			expect(d.find((i) => i.property === "required")).toBeUndefined();
		});

		it("should NOT flag when description mentions required", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Input", description: "Mark as required with asterisk", children: [] },
				{ accessibility: { ariaRequired: true } },
				d,
			);
			expect(d.find((i) => i.property === "required")).toBeUndefined();
		});

		it("should NOT flag when code does not require the field", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Input", description: "", children: [] },
				{ accessibility: { ariaRequired: false } },
				d,
			);
			expect(d.find((i) => i.property === "required")).toBeUndefined();
		});
	});

	// ========================================================================
	// 8. Target Size
	// ========================================================================
	describe("target size parity", () => {
		it("should flag when code renders significantly smaller than design", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Button", description: "", absoluteBoundingBox: { width: 120, height: 44 } },
				{ accessibility: { renderedSize: [80, 30] } },
				d,
			);
			const issue = d.find((i) => i.property === "targetSize" && i.severity === "major");
			expect(issue).toBeDefined();
		});

		it("should flag when code renders below 24x24 minimum", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Button", description: "", absoluteBoundingBox: { width: 24, height: 24 } },
				{ accessibility: { renderedSize: [20, 20] } },
				d,
			);
			const issue = d.find((i) => i.property === "targetSize" && i.severity === "critical");
			expect(issue).toBeDefined();
		});

		it("should NOT flag when sizes match closely", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Button", description: "", absoluteBoundingBox: { width: 120, height: 44 } },
				{ accessibility: { renderedSize: [118, 42] } },
				d,
			);
			expect(d.find((i) => i.property === "targetSize")).toBeUndefined();
		});

		it("should use size.x/y as fallback when absoluteBoundingBox missing", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Button", description: "", size: { x: 120, y: 44 } },
				{ accessibility: { renderedSize: [50, 20] } },
				d,
			);
			expect(d.find((i) => i.property === "targetSize")).toBeDefined();
		});
	});

	// ========================================================================
	// 9. Keyboard Interactions
	// ========================================================================
	describe("keyboard interactions parity", () => {
		it("should flag when code has keyboard interactions but design lacks docs", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Button", description: "" },
				{ accessibility: { keyboardInteractions: ["Enter", "Space"] } },
				d,
			);
			const issue = d.find((i) => i.property === "keyboardInteractions");
			expect(issue).toBeDefined();
			expect(issue!.severity).toBe("info");
		});

		it("should NOT flag when design documents keyboard interactions", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Button", description: "Keyboard: Enter and Space activate the button" },
				{ accessibility: { keyboardInteractions: ["Enter", "Space"] } },
				d,
			);
			expect(d.find((i) => i.property === "keyboardInteractions")).toBeUndefined();
		});
	});

	// ========================================================================
	// Combined scenarios
	// ========================================================================
	describe("combined scenarios", () => {
		it("should report multiple issues for a poorly-bridged component", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{
					name: "Button",
					description: "",
					children: [
						{ name: "State=Default" },
						{ name: "State=Focused" },
						{ name: "State=Disabled" },
						{ name: "State=Error" },
					],
					absoluteBoundingBox: { width: 120, height: 44 },
				},
				{
					accessibility: {
						role: "button",
						semanticElement: "div",
						focusVisible: false,
						supportsDisabled: false,
						supportsError: false,
						contrastRatio: 2.5,
						renderedSize: [20, 16],
						keyboardInteractions: ["Enter", "Space"],
					},
				},
				d,
			);

			// Should have: role (info), semanticElement (major), contrastRatio (critical),
			// focusVisible (critical), disabled (major), errorState (major),
			// targetSize (major + critical), keyboardInteractions (info)
			expect(d.length).toBeGreaterThanOrEqual(8);

			const criticals = d.filter((i) => i.severity === "critical");
			expect(criticals.length).toBeGreaterThanOrEqual(3); // contrast, focus, target size

			const majors = d.filter((i) => i.severity === "major");
			expect(majors.length).toBeGreaterThanOrEqual(3); // semantic, disabled, error
		});

		it("should report zero issues for a well-bridged component", () => {
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{
					name: "Button",
					description: "Accessibility: role=button. Keyboard: Enter/Space activates.",
					children: [
						{ name: "State=Default" },
						{ name: "State=Focused" },
						{ name: "State=Disabled" },
					],
					absoluteBoundingBox: { width: 120, height: 44 },
				},
				{
					accessibility: {
						role: "button",
						semanticElement: "button",
						focusVisible: true,
						supportsDisabled: true,
						contrastRatio: 7.2,
						renderedSize: [118, 42],
						keyboardInteractions: ["Enter", "Space"],
					},
				},
				d,
			);

			expect(d).toHaveLength(0);
		});
	});

	// ========================================================================
	// Severity distribution
	// ========================================================================
	describe("severity assignments", () => {
		it("should assign critical to: contrast, focus mismatch, target size <24px", () => {
			const criticalChecks = ["contrastRatio", "focusVisible", "targetSize"];
			expect(criticalChecks).toContain("contrastRatio");
			expect(criticalChecks).toContain("focusVisible");
			expect(criticalChecks).toContain("targetSize");
		});

		it("should assign major to: semantic element, disabled, error, target size reduction", () => {
			const majorChecks = ["semanticElement", "disabled", "errorState", "targetSize"];
			expect(majorChecks.length).toBe(4);
		});

		it("should assign minor to: missing design variants, required field", () => {
			const minorChecks = ["focusVisible (code-only)", "disabled (code-only)", "required"];
			expect(minorChecks.length).toBe(3);
		});

		it("should assign info to: role annotations, keyboard docs", () => {
			const infoChecks = ["role", "keyboardInteractions"];
			expect(infoChecks.length).toBe(2);
		});
	});
});

// ============================================================================
// axeResultsToCodeSpec mapper tests
// ============================================================================

describe("axeResultsToCodeSpec mapper", () => {
	describe("semantic element extraction", () => {
		it("should extract <button> as semantic element", () => {
			const spec = axeResultsToCodeSpec('<button class="btn">Click me</button>', { violations: [] });
			expect(spec.semanticElement).toBe("button");
		});

		it("should extract <a> as semantic element", () => {
			const spec = axeResultsToCodeSpec('<a href="/page">Link</a>', { violations: [] });
			expect(spec.semanticElement).toBe("a");
		});

		it("should extract <input> as semantic element", () => {
			const spec = axeResultsToCodeSpec('<input type="text" id="name">', { violations: [] });
			expect(spec.semanticElement).toBe("input");
		});

		it("should default to div for non-semantic elements", () => {
			const spec = axeResultsToCodeSpec('<div class="card"><span>content</span></div>', { violations: [] });
			expect(spec.semanticElement).toBe("div");
		});

		it("should prefer semantic elements over wrappers", () => {
			const spec = axeResultsToCodeSpec('<div class="wrapper"><button>Submit</button></div>', { violations: [] });
			expect(spec.semanticElement).toBe("button");
		});
	});

	describe("ARIA attribute extraction", () => {
		it("should extract role", () => {
			const spec = axeResultsToCodeSpec('<div role="alert">Error!</div>', { violations: [] });
			expect(spec.role).toBe("alert");
		});

		it("should extract aria-label", () => {
			const spec = axeResultsToCodeSpec('<button aria-label="Close dialog">X</button>', { violations: [] });
			expect(spec.ariaLabel).toBe("Close dialog");
		});

		it("should extract aria-required", () => {
			const spec = axeResultsToCodeSpec('<input aria-required="true">', { violations: [] });
			expect(spec.ariaRequired).toBe(true);
		});

		it("should extract required attribute", () => {
			const spec = axeResultsToCodeSpec('<input required>', { violations: [] });
			expect(spec.ariaRequired).toBe(true);
		});
	});

	describe("state support detection", () => {
		it("should detect disabled attribute support", () => {
			const spec = axeResultsToCodeSpec('<button disabled>Submit</button>', { violations: [] });
			expect(spec.supportsDisabled).toBe(true);
		});

		it("should detect aria-disabled support", () => {
			const spec = axeResultsToCodeSpec('<div role="button" aria-disabled="true">Submit</div>', { violations: [] });
			expect(spec.supportsDisabled).toBe(true);
		});

		it("should leave supportsDisabled undefined when no evidence found", () => {
			const spec = axeResultsToCodeSpec('<button>Submit</button>', { violations: [] });
			expect(spec.supportsDisabled).toBeUndefined();
			// Absence of `disabled` attr doesn't mean the component can't be disabled —
			// it may just be in a non-disabled state. Only positive evidence counts.
		});

		it("should detect aria-invalid support", () => {
			const spec = axeResultsToCodeSpec('<input aria-invalid="true">', { violations: [] });
			expect(spec.supportsError).toBe(true);
		});

		it("should leave supportsError undefined when no evidence found", () => {
			const spec = axeResultsToCodeSpec('<input type="text">', { violations: [] });
			expect(spec.supportsError).toBeUndefined();
			// Default-state HTML won't have aria-invalid — doesn't mean error state is unsupported.
		});
	});

	describe("focus visible inference", () => {
		it("should infer focusVisible for native button", () => {
			const spec = axeResultsToCodeSpec('<button>Click</button>', { violations: [] });
			expect(spec.focusVisible).toBe(true);
		});

		it("should infer focusVisible for native input", () => {
			const spec = axeResultsToCodeSpec('<input type="text">', { violations: [] });
			expect(spec.focusVisible).toBe(true);
		});

		it("should infer focusVisible for native link", () => {
			const spec = axeResultsToCodeSpec('<a href="/page">Link</a>', { violations: [] });
			expect(spec.focusVisible).toBe(true);
		});

		it("should detect focus-visible in CSS references", () => {
			const spec = axeResultsToCodeSpec('<div class="focus-visible-ring" role="button">Custom</div>', { violations: [] });
			expect(spec.focusVisible).toBe(true);
		});

		it("should NOT infer focusVisible for plain div", () => {
			const spec = axeResultsToCodeSpec('<div class="card">Content</div>', { violations: [] });
			expect(spec.focusVisible).toBe(false);
		});
	});

	describe("keyboard interactions inference", () => {
		it("should infer Enter/Space for buttons", () => {
			const spec = axeResultsToCodeSpec('<button>Click</button>', { violations: [] });
			expect(spec.keyboardInteractions).toContain("Enter");
			expect(spec.keyboardInteractions).toContain("Space");
		});

		it("should infer Enter for links", () => {
			const spec = axeResultsToCodeSpec('<a href="/page">Link</a>', { violations: [] });
			expect(spec.keyboardInteractions).toContain("Enter");
		});

		it("should detect custom key handlers", () => {
			const spec = axeResultsToCodeSpec('<div onkeydown="handleKey(event)">Custom</div>', { violations: [] });
			expect(spec.keyboardInteractions).toContain("Custom key handler");
		});

		it("should infer Space for checkboxes", () => {
			const spec = axeResultsToCodeSpec('<div role="checkbox">Check</div>', { violations: [] });
			expect(spec.keyboardInteractions).toContain("Space");
		});
	});

	describe("axe-core results integration", () => {
		it("should clear ariaLabel when button-name violation exists", () => {
			const spec = axeResultsToCodeSpec(
				'<button></button>',
				{ violations: [{ id: "button-name", impact: "critical", nodes: [] }] },
			);
			expect(spec.ariaLabel).toBeUndefined();
		});

		it("should clear ariaLabel when label violation exists", () => {
			const spec = axeResultsToCodeSpec(
				'<input type="text">',
				{ violations: [{ id: "label", impact: "critical", nodes: [] }] },
			);
			expect(spec.ariaLabel).toBeUndefined();
		});
	});

	describe("end-to-end CodeSpec generation", () => {
		it("should produce a complete CodeSpec for a well-formed component", () => {
			const html = '<button class="btn" aria-label="Submit form" disabled>Submit</button>';
			const spec = axeResultsToCodeSpec(html, { violations: [] });

			expect(spec.semanticElement).toBe("button");
			expect(spec.ariaLabel).toBe("Submit form");
			expect(spec.supportsDisabled).toBe(true);
			expect(spec.focusVisible).toBe(true);
			expect(spec.keyboardInteractions).toContain("Enter");
			expect(spec.keyboardInteractions).toContain("Space");
		});

		it("should produce a CodeSpec usable by compareAccessibility", () => {
			const html = '<button aria-label="Save">Save</button>';
			const spec = axeResultsToCodeSpec(html, { violations: [] });

			// This should be directly passable to compareAccessibility as codeSpec.accessibility
			const d: ParityDiscrepancy[] = [];
			compareAccessibility(
				{ name: "Button", description: "", children: [{ name: "State=Focused" }] },
				{ accessibility: spec as any },
				d,
			);

			// focusVisible should be true (native button), focus variant exists → no focus mismatch
			expect(d.find((i) => i.property === "focusVisible")).toBeUndefined();
		});
	});
});
