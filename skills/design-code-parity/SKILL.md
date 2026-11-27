---
name: design-code-parity
description: Keep a Figma component library and the code library that mirrors it in line — compare each component's variants, props, styling and tokens, triage every discrepancy to a design-side fix, a code-side fix, or a decision for a person, and produce a parity report. Use when the user asks about drift between Figma and code, "are our components in sync", parity audits, or before or after a design-system release.
---

# Design ↔ code parity

> **Tools (Local Mode):** this skill uses tools outside the core set. If they aren't in your tool list, call `figma_enable_toolsets({ toolsets: ["inspect", "parity", "components", "variables"] })` once at the start; if they still don't appear, call them through `figma_call({ tool, arguments })`. Cloud Mode lists every tool, so skip this there.

Find where the Figma library and the code library disagree, and fix only what has a clear owner. **Never silently pick a side.** If nobody has said which side is canonical for a component or property, the discrepancy goes to a person.

## 0. Establish canonical source

Ask, or read from the repo or team docs, which side is the source of truth:
- per library ("Figma is canonical"),
- per component, or
- per concern (e.g. design owns visuals, code owns the props API).

Record the answer. If there isn't one, treat every discrepancy as **needs decision**. You can still measure parity, but don't apply fixes.

## 1. Pair components

- Figma: `figma_search_components({ query, libraryFileKey? })` or `figma_get_library_components({ libraryFileKey, query })` gives you nodeIds and keys.
- Code: list the exports of the component package (entry `index.ts`, `package.json` exports, component directory).
- Pair them by name. Components on only one side go in the report as **missing in code** or **missing in Figma**. Don't create the missing side unless the person asks.

## 2. For each pair, gather both sides

**Figma side:**
- `figma_analyze_component_set({ nodeId: "<COMPONENT_SET id>" })` gives the variant axes and values, state → pseudo-class mapping, property definitions mapped to prop types, and slots.
- `figma_get_component_for_development({ nodeId })` gives bound token names, sizing and annotations. For deep trees, use `figma_get_component_for_development_deep({ nodeId, depth: 0 })`.

**Code side.** Read the source and build a `codeSpec`. Fill in only the sections you actually read, and leave the rest out:

```
codeSpec: {
  filePath: "src/components/Button/Button.tsx",
  visual:     { backgroundColor, borderColor, borderWidth, borderRadius, opacity, fills:[{color,opacity}], strokes:[{color,width}], effects:[{type,color,offset:{x,y},blur}] },
  spacing:    { paddingTop, paddingRight, paddingBottom, paddingLeft, gap, width, height, minWidth, maxWidth, minHeight, maxHeight, layoutDirection: "horizontal"|"vertical" },
  typography: { fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, textAlign, textDecoration, textTransform },
  tokens:     { usedTokens: ["--color-primary", …], hardcodedValues: [{ property, value }], tokenPrefix: "--ds-" },
  componentAPI: { props: [{ name, type, required, defaultValue, values: [...] }], events: [...], slots: [...] },
  accessibility: { … },
  metadata:   { name, description, status, version, tags }
}
```

- Resolve token references to values where the parity check needs a value (e.g. `var(--space-3)` → 12).
- For `accessibility`, render the component's default markup and run `figma_scan_code_accessibility({ html, mapToCodeSpec: true })`, then pass the returned `codeSpec.accessibility` as is.
- For variant parity, compare `componentAPI.props[].values` against the variant axes from `figma_analyze_component_set`. Check that each Figma axis maps to a prop whose values match, and that each state has a code equivalent.

## 3. Run the check

```
figma_check_design_parity({ nodeId: "<component or set id>", codeSpec, canonicalSource: "design" | "code", enrich: true })
```

`canonicalSource` defaults to `"design"`, so **always pass it explicitly**, set to what you recorded in step 0. When there's no canonical source, pass either value, but treat the returned fix items as proposals only. The discrepancy list is the evidence either way.

## 4. Triage every discrepancy

| Bucket | When | Action |
|---|---|---|
| **Design-side fix** | Code is canonical for this property, and the Figma fix is mechanical | Apply it with tools. Use `figma_set_fills` / `figma_set_strokes` with `variableId`, `figma_set_layout`, or `figma_edit_component_property` / `figma_add_component_property` for props. Variant structure changes go through the person first. |
| **Code-side fix** | Design is canonical, and the code fix is mechanical | Edit the source: the token reference, the prop values, the default. Keep the component's public API stable unless the person approves a change. |
| **Needs decision** | No canonical source, both sides changed, an API or breaking change, a missing component, or a value with no token on either side | Don't change anything. List it with both values and a recommendation. |
| **Not a discrepancy** | A known intentional difference (platform convention, documented exception) | Note it once. |

Token-level differences, where both sides use a token but the tokens' values differ, are a token sync issue. Handle those in step 5, not per component.

After applying fixes, re-run `figma_check_design_parity` for that component and record the before and after scores.

## 5. Token drift

Compare the code's token files against Figma variables without writing anything:

- `figma_import_tokens({ dryRun: true })` uses tokens.config.json. Without a config, pass `files: [{ path, content }]` or `payload` plus `format: "dtcg"`. The diff plan shows:
  - `toCreate`: in code, not in Figma.
  - `toUpdate`: values differ.
  - `toRename`.
  - `toDelete`: in Figma, not in code.
  - conflicts, where both sides changed since the last sync.
- `figma_export_tokens({ format: "dtcg", strategy: "dry-run" })` shows what an export would write (`wouldWriteTo`), and whether it would refuse because of hand-added tokens or a different source file.
- Check the `source` file key in each response. Drift reported against the wrong Figma file is meaningless.

Treat every conflict and every delete candidate as **needs decision**. To actually sync, use the `design-tokens-sync` skill.

## 6. Link components to their code

Once pairs are confirmed, offer to add the links developers see in Dev Mode with `figma_manage_dev_resources({ action: "add", items: [{ nodeId, url, name: "Storybook" | "Code" }] })`. It skips links that already exist. Only link URLs you actually know (the code file's repo URL, the Storybook story); never guess one.

## 7. Parity report

```
PARITY REPORT — <library> vs <package>@<version>   (canonical: <design|code|undeclared>)

SUMMARY
- Components paired: <n> | missing in code: <n> | missing in Figma: <n>
- Mean parity score: <before> → <after>
- Token drift: create <n>, update <n>, rename <n>, delete <n>, conflicts <n>

PER COMPONENT
<Name> — score <before> → <after>
- Fixed (design): <property>: <old> → <new> (<tool call>)
- Fixed (code):   <file:line> <property>: <old> → <new>
- Needs decision: <property> — Figma <value> vs code <value> — recommend <side> because <reason>

MISSING
- In code: <components>
- In Figma: <components>

DECISIONS NEEDED (consolidated)
1. ...
```

Hand the "Decisions needed" list to the person. Don't resolve those items yourself.
