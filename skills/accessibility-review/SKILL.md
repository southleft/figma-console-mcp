---
name: accessibility-review
description: Review a Figma design, a Figma component, or UI code for accessibility (WCAG 2.2) with figma_lint_design, figma_audit_component_accessibility and figma_scan_code_accessibility, report findings grouped by WCAG level with node IDs or file locations, and check that design and code agree on accessibility. Use when the user asks to check accessibility, WCAG or contrast, review a11y before handoff, or compare design vs code accessibility.
---

# Accessibility review

> **Tools (Local Mode):** this skill uses tools outside the core set. If they aren't in your tool list, call `figma_enable_toolsets({ toolsets: ["parity", "docs"] })` once at the start; if they still don't appear, call them through `figma_call({ tool, arguments })`. Cloud Mode lists every tool, so skip this there.

Design-side and code-side tools check different things, so a full review uses both. Report only what the tools found, plus clearly labeled manual checks. Don't turn best-practice hints into WCAG failures.

| Scope | Tool | What it covers |
|---|---|---|
| A screen or frame in Figma | `figma_lint_design` | Contrast (AA), non-text contrast 1.4.11, color-only 1.4.1, focus indicators 2.4.7, target size 2.5.8, alt text 1.1.1, heading hierarchy and reading order 1.3.1/1.3.2, reflow 1.4.10, disabled context 4.1.2 |
| A Figma component or component set | `figma_audit_component_accessibility` | State coverage (default/hover/focus/disabled/error/active/loading), focus indicator quality, non-color differentiation, target-size consistency, annotations, color-blind simulation; scored 0–100 |
| Code (HTML) | `figma_scan_code_accessibility` | axe-core structural rules: ARIA, roles, labels, form labels, landmarks, headings, tabindex, duplicate IDs, lang, plus text-spacing and resize advisories. **No** contrast or focus-visibility checks. |

## 1. Design: screens and frames

```
figma_lint_design({ nodeId: "<frame>", rules: ["wcag"], maxFindings: 200 })
```

- The default (no `rules`) runs `wcag` + `design-system` + `layout`. Use `["wcag"]` for a pure conformance review. Add `"best-practice"` only if the user wants readability hints.
- Specific rules can be run alone, e.g. `["wcag-contrast", "wcag-focus-indicator"]`.
- Line or paragraph spacing below 1.5x/2x is a **best-practice hint, not a 1.4.12 failure**. Report it under hints if you report it at all.
- A large page may need several runs with a scoped `nodeId`. Raise `maxDepth` (default 10) for deep trees.

## 2. Design: components

```
figma_audit_component_accessibility({ nodeId: "<COMPONENT_SET or COMPONENT>", targetSize: 24 })
```

- `targetSize`: 24 is WCAG 2.5.8 AA. Use 44 for iOS or 48 for Android if the product targets them.
- Missing states, especially focus, disabled and error, are the most common gaps. Report them as missing variants. Don't draw them yourself unless asked.
- To add annotations a dev needs (role, label, keyboard behavior), use `figma_get_annotation_categories`, then `figma_set_annotations`, but only when the user asks.

## 3. Code

Get HTML: static markup, a rendered story, or the component's output for its main states. Then run:

```
figma_scan_code_accessibility({ html, tags: ["wcag2a","wcag2aa","wcag21aa","wcag22aa"], context: "#root", includePassingRules: false })
```

- Scan each meaningful state separately (default, error, disabled, open).
- Contrast and focus visibility aren't checked here. Take contrast from the design lint, or list it as a manual check for the running app.

## 4. Design ↔ code a11y parity (when both exist)

1. Run `figma_scan_code_accessibility({ html, mapToCodeSpec: true })` and take the returned `codeSpec.accessibility`.
2. Run `figma_check_design_parity({ nodeId, codeSpec: { filePath, accessibility: <that object> }, canonicalSource })`. Pass `canonicalSource` explicitly. If nobody has said which side is canonical, report the mismatches as decisions; don't fix them.
3. Typical mismatches:
   - design has a focus state, but code has no `:focus-visible`;
   - design shows an error state, but code doesn't support `aria-invalid`;
   - the rendered size is smaller than the design's target;
   - the semantic element doesn't match the design intent (a `div` acting as a button).

## 5. Manual checks (list them, don't claim them)

The tools can't verify these: keyboard operability and focus order in the running app, screen-reader announcements, motion and reduced-motion, captions and media, content zoom to 400%, timing. List the ones relevant to the scope as **Not verified by tools**.

## Report format

Group by WCAG level, then by severity. Every item cites its evidence.

```
ACCESSIBILITY REVIEW — <scope> (WCAG 2.2, target level <AA>)

SUMMARY: A <n> · AA <n> · AAA <n> · best-practice hints <n> · component score <n>/100

LEVEL A
- [critical] 1.1.1 Non-text content — <nodeId | selector | file:line> — <finding> — fix: <action>
LEVEL AA
- [critical] 1.4.3 Contrast — <nodeId> — 3.1:1 text on <token> (needs 4.5:1) — fix: use <token>
- ...
LEVEL AAA (informational unless targeted)
BEST-PRACTICE HINTS (not WCAG failures)
COMPONENT STATE COVERAGE: <missing states per component>
DESIGN ↔ CODE MISMATCHES: <property — design vs code — decision needed?>
NOT VERIFIED BY TOOLS: <manual checks>
```

Recommend fixes that use the design system's existing tokens and variants, e.g. a higher-contrast color token or an existing focus variant. If no compliant token or variant exists, report that as a design-system gap. Don't invent a color.
