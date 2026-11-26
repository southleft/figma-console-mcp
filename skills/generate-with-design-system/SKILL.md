---
name: generate-with-design-system
description: Build a screen, section, or flow in Figma using only the file's or library's real design system — existing components, variables and text styles — and report anything missing to the person instead of inventing it. Use whenever the user asks to design, mock up, lay out, or generate UI in Figma ("make a settings page", "build a pricing section", "lay out this form with our components"). Not for creating or editing the components themselves.
---

# Generate in Figma with the design system

> **Tools (Local Mode):** this skill uses tools outside the core set. If they aren't in your tool list, call `figma_enable_toolsets({ toolsets: ["inspect", "docs"] })` once at the start; if they still don't appear, call them through `figma_call({ tool, arguments })`. Cloud Mode lists every tool, so skip this there.

The rule is simple: **build with what exists, and mark what doesn't, right where it belongs.** A missing component, a missing part of a component, or a missing token is something to point out, not a problem for you to solve with a look-alike. If the system has no pagination, the layout gets a labeled note where the pagination would be, saying so. If you're unsure whether a component fits, the person decides.

Work through the steps in order. Don't start building (step 5) until every need has a decided action.

## 1. Confirm the target

- `figma_list_open_files` shows which file is active. If the user means another file, run `figma_navigate({ url, lock: true })` so their clicks elsewhere can't redirect your writes.
- If the design system lives in a **published library** (another file), get its file key from the user or the library URL. You'll pass it as `libraryFileKeys` in steps 3 and 6.
- If any call fails with a connection or timeout error, use the `troubleshoot-connection` skill.

## 2. Inventory the system (read only)

Do just enough to know what exists. Don't dump everything.

- Overview: `figma_get_design_system_summary` gives categories, counts and collection names.
- Components: `figma_search_components({ query, limit: 25 })` for the active file, or add `libraryFileKey` for a published library. `figma_get_library_components({ libraryFileKey, query })` returns component sets with their **variant keys**. Instantiate variant keys, not the set key.
- Variables: `figma_get_variables({ format: "filtered", collection, namePattern, verbosity: "inventory" })` returns local variable names and IDs. For library variables, call `figma_get_library_variables({ libraryName?, collectionName?, resolvedType? })`, then `figma_import_library_variable({ variableKey })` for each one you'll bind. The returned local `id` is what you bind.
- Text styles: `figma_get_text_styles` gives style IDs and names.
- When you need everything at once on a small system, use `figma_get_design_system_kit({ include: ["components","tokens","styles"], format: "compact" })`.

Node IDs go stale between sessions. Re-search every session, and never reuse IDs from earlier conversations.

## 3. List the needs and their parts, then resolve them

Break the request into plain-language UI needs, one per element, e.g. `["primary button", "text input", "date picker", "user avatar", "pricing card"]`. Include everything the request implies a person would expect, such as pagination under a long table, but nothing decorative it didn't ask for ("a footer would be nice").

For any need whose content matters, list its **parts**: an "article preview card" needs `image`, `title`, `excerpt`; a "watchlist table" needs `pagination`; a "profile header" needs `avatar`, `name`, `action button`.

```
figma_resolve_components({
  needs: [...],
  parts: [{ need: "article preview card", parts: ["image", "title", "excerpt"] }],
  libraryFileKeys: ["<library key>"],   // omit to search the active file only
  fileKey: "<file key>",                 // when the system lives in a specific open file
  askUser: true
})
```

Each item comes back with `status` (`matched` | `possible` | `gap`) and an `action`:

| action | What you do |
|---|---|
| `build-with-component` | Instantiate exactly that `component` (its key and nodeId). If it has `missingParts`, add a gap note for each part next to the instance (step 5). |
| `placeholder` | The system lacks it. Put a gap note named `placeholderName` in the spot where it belongs (step 5). |
| `skip` | The person said to leave it out. Build nothing. |
| `ask-user` | An unclear match. **Stop** (step 4). |

A part with status `unverified` means the tool couldn't see inside the component (library-only). Check it with `figma_get_component_details` before relying on it.

Follow the result's `rules` array. If the tool returns an `error` saying no components were found, that's a setup problem (wrong file, missing library key or token), **not** "everything is a gap". Fix the source and re-run.

## 4. Settle unclear matches: check first, ask only when it's a real toss-up

Missing items don't need a decision: they become gap notes. Unclear matches (`possible`) need one, but most can be settled by looking. A gap note for something the system can do is a defect, just as much as a fake is.

For each `possible` item, look at its top candidates with `figma_get_component_details` (inspect toolset): description, properties, variants, slots.
- **One candidate clearly fits** the need and its purpose. For example, a general Card for a stat card or an article preview (its slots or properties hold the content), or Input or Input Stepper for a quantity field. Use it, and say in your report which component you chose and why.
- **Two or more fit equally well, or none clearly does:** that's the person's call. A component made for something else is not a fit, e.g. a Badge as a stat card, or a single "Pagination Item" as pagination.

If any item is still unsettled (or `ask-user`), build nothing yet and ask:

```
Before I build, these have more than one possible component:
- <need> — candidates: "<name>" (score <n>), "<name>" (score <n>)

For each one: use a candidate, mark it with a gap note, or leave it out?
```

Wait for the answer, then re-run `figma_resolve_components` (the decisions come back as actions). If the person has already said to mark anything still unclear with a note, pass `onUnclear: "placeholder"` — after you've checked the candidates as above, not instead of it.

## 5. Build only with approved parts

**Placement.** Take a screenshot of the page first (`figma_capture_screenshot`) to find clear space. Put the work in a named Section or top-level Frame, below or beside existing content and never overlapping it. Reuse a page that already exists rather than creating a duplicate.

**Structure.**
- Create the root and layout frames with `figma_create_child({ parentId, nodeType: "FRAME", properties: { name } })`.
- Lay them out with `figma_set_layout({ nodeId, mode: "VERTICAL"|"HORIZONTAL"|"GRID", gap, padding, primaryAlign, counterAlign, horizontalSizing, verticalSizing, children: [...] })`. Use FILL for content that should stretch. Hug-everything layouts end up lopsided.
- Name layout frames by **role**: "Header", "Main column", "Row 1", "Actions". **Don't** give them component words like Card, Button, Tabs, Menu, Icon, Search or Badge. The audit flags those as hand-built imitations.

**Components.**
- `figma_instantiate_component({ componentKey, nodeId, variant: { ... }, overrides: { ... }, parentId })`. For a component set, use the resolve result's `component.defaultVariant` key and nodeId (variant keys, never the set key) and pass `variant` for other values; no separate library lookup needed. Always pass both `componentKey` and `nodeId`.
- Set content through component properties with `figma_set_instance_properties({ nodeId, properties: { Label: "Save", "Show Icon": false } })`. Never edit text inside an instance directly. Those edits fail silently.
- Pick the variant you need rather than restyling an instance. Style overrides on instances get reported.

**Tokens, never raw values.** Everything outside an instance must be bound:
- Fills: `figma_set_fills({ nodeId, fills: [{ type: "SOLID", variableId: "VariableID:…" }] })`. Strokes: `figma_set_strokes` with the same `variableId` field. If you need a color and no variable exists for it, that's a gap. Report it, don't pick a hex.
- Spacing, radius, sizes: set the layout with `figma_set_layout`, then bind the values to the system's variables with `figma_bind_tokens({ nodeId, bindings: { padding: "space/md", gap: "space/sm", cornerRadius: "radius/lg" } })` (names or ids; shorthands `padding`, `paddingX`, `paddingY`, `gap`, `cornerRadius`, or exact fields like `paddingTop`, `itemSpacing`, `topLeftRadius`). It never creates tokens: a field it can't bind comes back in `failed` with the closest real names. Pick from those only if one is clearly intended; otherwise it's a missing token. Tell the user.
- Text outside instances: create the node with `figma_create_child({ nodeType: "TEXT", properties: { text } })`, then `figma_bind_tokens({ nodeId, textStyle: "<style name from figma_get_text_styles>" })`. Don't hand-set fontSize or fontFamily.
- The root frame counts too: bind its fill or leave it empty.

**Gap notes**, for items whose action is `placeholder` and for each `missingParts` entry:
- **Where:** in the exact spot the missing element belongs. Pagination goes under the table it pages; a missing card image goes above the card's content; a missing chart goes in the chart's panel. A part gap sits beside its instance, with both wrapped in a layout frame named by role ("Article 1").
- **What:** one frame named exactly `placeholderName` (e.g. `GAP: pagination`, `GAP: article preview card — image`), roughly the missing element's size, holding one text layer. Start the text from `placeholderNote` and add what it would hold for *this* request, e.g. "Pagination for the 48-row watchlist goes here. The design system has no pagination component."
- **Look:** plain and clearly not the real thing. Bind its fill, stroke, spacing and text style to system variables like everything else. Don't draw a fake of the missing element.
- **Never** use a gap note for something the system has. The audit fails a note that stands in for an existing component.

**Missing tokens:** if no variable or style exists for a value you need, leave that property unset (no raw value), add a Figma annotation on the node naming the missing token (`figma_set_annotations`), and list it in your report.

**Build a section per call, not a node per call.** Every tool call re-sends the whole conversation, so 40 small calls cost far more than 5 larger ones. Once resolve and the token lookups have given you the ids, build each section (header, KPI row, table area…) with **one** `figma_execute` script:
- Use only what earlier steps returned: component variant keys/node ids from resolve, variable ids from `figma_get_variables`, text style ids from `figma_get_text_styles`. A value you didn't look up is a value you invented.
- Inside the script:
  - **Instances:** `(await figma.getNodeByIdAsync(variantNodeId)).createInstance()`, or `figma.importComponentByKeyAsync(key)` for library components. Set content with `instance.setProperties({...})`, using the names from `componentProperties`.
  - **Layout frames:** auto layout, with spacing bound via `frame.setBoundVariable("itemSpacing", variable)`. The same goes for padding fields and corner radii.
  - **Colors:** `figma.variables.setBoundVariableForPaint(paint, "color", variable)`.
  - **Text:** `await text.setTextStyleIdAsync(styleId)` after loading its font.
- Return only ids and names, e.g. `{ header: "12:3", kpis: ["12:7", …] }`. Not node dumps: whatever a script returns enters the conversation.
- Make it re-runnable. Find or create the section by name, and on failure remove what it created before retrying (scripts can time out and keep running, so check the page before a retry).
- Keep the single-purpose tools for one-off fixes after the audit. `figma_bind_tokens` is still the safest way to bind one node, because it refuses names that don't exist.

The audit in step 6 checks a script-built section exactly like a tool-built one, so nothing gets past it either way.

## 6. Audit, look, fix (max 3 rounds)

```
figma_audit_adherence({ nodeId: "<root frame>", libraryFileKeys: ["<library key>"], minScore: 90 })
figma_capture_screenshot({ nodeId: "<root frame>" })
figma_lint_design({ nodeId: "<root frame>", rules: ["wcag"] })
```

- `pass: false` with errors means you have work to do:
  - `imitates-component`: swap the layer for an instance.
  - `new-component`: delete it and use an existing component, or report the gap.
  - `off-system-component`: replace it with the library's component.
  - `missing-main-component`: re-instantiate.
- Warnings:
  - `hardcoded-*`: bind to a variable or style.
  - `hand-drawn-vector`: use the system's icon component.
  - `looks-hand-built`: rename it if it's really just layout, or replace it if it's really a component.
- Info: `style-override` means switch to a variant if one exists.
- Check the screenshot for alignment, padding balance, FILL vs HUG, and overlaps — and for readability. The adherence score can be 100 while text is unreadable: components follow the theme's variable mode (often dark), so a root frame with no background shows light text on a white canvas. Give the root a surface fill bound to the system's background variable so it follows the same mode. Fix every WCAG contrast finding from `figma_lint_design`.
- A component that doesn't stretch or behave as needed (e.g. an inner field that hugs) is a finding about the component. Report it; don't override its internals.
- If a fix would require inventing something, mark it with a gap note instead.
- `gap-unexplained`: say in the note what goes there and why it's missing. `gap-but-component-exists`: replace the note with that component.
- A truncated audit never passes. Audit a smaller frame or raise `maxNodes`.

If it still fails after 3 rounds, stop and report the remaining findings. Don't loosen `minScore`.

## 7. Hand off for grading

Don't grade your own work. Use the `grade-generation` skill: an independent grader gets the original request, the root `nodeId`, the file and the library keys, and nothing else.

Then report to the person: what you built (root nodeId), the components used, every gap note (missing components and missing parts) with where it sits, any missing tokens, and anything left out at their request.

## Never

- Hand-build a look-alike of a component (a frame styled like a button, card, input, tab bar…).
- Create a new component or component set inside the composition.
- Use a raw hex, rgb or px value where a variable or style exists, or invent a token when none does.
- Hand-draw icons, logos or illustrations with vectors.
- Swap in a "close enough" component without the person approving it.
- Fill a gap silently: drop the missing piece without a note, or fake it.
- Add elements the request didn't ask for.
- Leave partial artifacts behind after a failed attempt. Delete them before retrying (`figma_delete_node`).
