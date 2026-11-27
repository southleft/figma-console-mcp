---
name: generate-code-with-design-system
description: Write UI code (React, Vue, Svelte, HTML/CSS, Tailwind) using only the project's design system — its component package, exported components and tokens — and report missing pieces to the person instead of re-implementing them. Use when the user asks to build a page, screen, form or feature in code "with our components/design system", implements a Figma design in a codebase that has a component library, or asks to check generated code for design-system adherence.
---

# Generate code with the design system

> **Tools (Local Mode):** this skill uses tools outside the core set. If they aren't in your tool list, call `figma_enable_toolsets({ toolsets: ["inspect", "parity"] })` once at the start; if they still don't appear, call them through `figma_call({ tool, arguments })`. Cloud Mode lists every tool, so skip this there.

This works like generating in Figma, just in code. **Use the system's components and tokens, and report what's missing.** Don't write a local `<Button>`, a styled `<div>` card, or a new CSS variable because the system lacks one. Tell the person and let them decide.

## 1. Discover the code design system (read only)

Find all three of these, and note where each came from:

1. **Component source.** The import specifier(s) that count as the design system, e.g. `@acme/ui` or `@/components/ui`.
   - Check `package.json` dependencies, workspace packages, path aliases in `tsconfig.json`, and existing imports in nearby files.
   - List the components it exports from the package entry (`index.ts`, `exports` in its `package.json`, `dist/index.d.ts`) or from the component directory.
2. **Props and variants** of each component you might use: the TypeScript props, `cva`/variant maps, and stories (`*.stories.*`) if present.
3. **Tokens.** These might be CSS custom properties (`:root { --color-… }`), a Tailwind theme (`@theme` block in v4, `theme.extend` in v3), a `tokens.json` or `*.tokens.json`, or a TS tokens module. Note the token file path.

If the repo has no identifiable design system, say so and ask before writing anything. Don't make one up.

When the code library mirrors a Figma library, the Figma side can help:
- `figma_get_component_for_development({ nodeId, codebasePath: "<components dir>" })` returns specs plus a registry of existing code components, so you don't recreate one.
- `figma_get_component_for_development_deep({ nodeId, depth: 0 })` is for deeply nested components (tables, menus, date pickers).
- `figma_analyze_component_set({ nodeId })` maps variant axes and states to props and pseudo-classes.

## 2. List needs and map them to real components

Break the request into plain UI needs, e.g. "primary button", "email input", "data table", "empty state". Include only what was asked for.

- **Figma library mirrors the code** (same component names): run `figma_resolve_components({ needs, libraryFileKeys })`. Treat `matched` as "use the same-named code export", and confirm that export actually exists in code.
- **Code only**: match each need against the exported component names and their variants yourself. Record each one as `matched` (one exact component), `possible` (several plausible components, or a partial fit) or `gap` (none).

**If anything is `possible` or `gap`, stop before writing code** and tell the person:

```
The design system doesn't cover everything in this request:

Missing: <need> — no component in <package>
Unclear: <need> — could be <ComponentA> or <ComponentB>

For each: use a specific component, leave a clearly marked placeholder (e.g. {/* GAP: date picker */}), or skip it?
```

Wait for the answer. A placeholder is a comment or a plain, unstyled marker element. It never mimics the missing component.

## 3. Write the code

- Import components only from the design-system source. Use the props and variants they expose (`variant="primary"`, `size="sm"`). Don't wrap a component just to restyle it.
- Don't render raw `<button>`, `<input>`, `<select>`, `<textarea>`, `<dialog>` or `<table>` when the system has that component.
- Styling must reference tokens:
  - CSS variables, e.g. `var(--space-4)`, `var(--color-text-muted)`.
  - Tailwind theme utilities (`p-4`, `text-muted-foreground`), never arbitrary values (`p-[13px]`, `bg-[#3b82f6]`).
  - The token module (`tokens.color.primary`).
- No hex, rgb or hsl literals. No px or rem literals for spacing, radius or type. No inline `style={{…}}` for visual properties.
- Only reference tokens that exist. If a value has no token, that's a gap. Report it.
- Layout glue (grid or flex containers) is fine. Use the system's layout primitives (Stack, Grid, Box) if it has them.
- For Figma-backed components, take sizing, spacing and states from the Figma specs (step 1 tools), expressed through tokens.

## 4. Audit (max 3 rounds)

```
figma_audit_code_adherence({
  files: ["src/pages/Settings.tsx", "src/pages/settings.css"],
  designSystem: {
    packages: ["@acme/ui"],
    components: ["Button", "Input", "Select", "Card"],   // when exports can't be inspected
    tokensPath: "src/styles/tokens.css"
  },
  minScore: 90
})
```

Use `sources: [{ path, content }]` instead of `files` for code that isn't on disk yet. Fix by finding:

- Errors:
  - `reimplements-component`: use the system's component.
  - `unknown-token`: use an existing token or report the gap.
- Warnings:
  - `raw-element`: swap for the DS component.
  - `hardcoded-color` / `hardcoded-length`: use a token.
  - `tailwind-arbitrary-value`: use a theme value.
- Info: `inline-style` means move it to classes or tokens.

Re-run the audit after fixing. If a fix would need an invented component or token, stop and add it to the gap list. After 3 failing rounds, report the remaining findings to the person. Don't lower `minScore`.

Optional: if you can render the result to HTML, run `figma_scan_code_accessibility({ html, tags: ["wcag22aa"] })`.

## 5. Hand off for grading

Use the `grade-generation` skill. The grader gets the request, the file paths and the design-system source (packages, components, token path), not your reasoning.

Then report: the files written, the DS components used, the placeholders and gaps, and anything left out at the person's request.

## Never

- Write a local component that duplicates one the system has, or a styled element standing in for a missing one.
- Invent a token, a CSS variable or a Tailwind theme key.
- Hardcode colors, spacing, radius or type sizes.
- Edit the design-system package itself to make your code fit. That's a parity decision for the person (see `design-code-parity`).
- Add features or elements the request didn't ask for.
