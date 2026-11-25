---
name: generate-with-design-system
description: Build a screen, section, or flow in Figma using only the file's or library's real design system — existing components, variables and text styles — and report anything missing to the person instead of inventing it. Use whenever the user asks to design, mock up, lay out, or generate UI in Figma ("make a settings page", "build a pricing section", "lay out this form with our components"). Not for creating or editing the components themselves.
---

# Generate in Figma with the design system

The rule is simple: **build with what exists, and tell the person what doesn't.** A missing component or token is something to report, not a problem for you to solve with a look-alike. Don't make the call on someone's behalf. If you're unsure whether a component fits, the person decides.

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

## 3. List the needs, then resolve them

Break the request into plain-language UI needs, one per element, e.g. `["primary button", "text input", "date picker", "user avatar", "pricing card"]`. Include only what the request asks for. Don't add extras ("a footer would be nice").

```
figma_resolve_components({
  needs: [...],
  libraryFileKeys: ["<library key>"],   // omit to search the active file only
  includeLocal: true,
  askUser: true
})
```

Each item comes back with `status` (`matched` | `possible` | `gap`) and an `action`:

| action | What you do |
|---|---|
| `build-with-component` | Instantiate exactly that `component` (its key and nodeId). |
| `placeholder` | The person chose a gap placeholder. Use a frame named exactly `placeholderName` (`GAP: <need>`). |
| `skip` | Build nothing for it. |
| `ask-user` | Undecided. **Stop** (step 4). |

Follow the result's `rules` array. If the tool returns an `error` saying no components were found, that's a setup problem (wrong file, missing library key or token), **not** "everything is a gap". Fix the source and re-run.

## 4. STOP if anything is undecided

If the result has an `ai_instruction`, or any item is `ask-user`, build nothing. Tell the person:

```
Before I build, the design system needs your call on these:

Missing (no component in the system):
- <need>

Unclear match:
- <need> — candidates: "<name>" (score <n>), "<name>" (score <n>)

For each one: use a candidate, add a labeled "GAP: <need>" placeholder, or leave it out?
```

Wait for the answer, then re-run `figma_resolve_components` (the decisions come back as actions) or apply what they said. Don't treat silence as a decision.

## 5. Build only with approved parts

**Placement.** Take a screenshot of the page first (`figma_capture_screenshot`) to find clear space. Put the work in a named Section or top-level Frame, below or beside existing content and never overlapping it. Reuse a page that already exists rather than creating a duplicate.

**Structure.**
- Create the root and layout frames with `figma_create_child({ parentId, nodeType: "FRAME", properties: { name } })`.
- Lay them out with `figma_set_layout({ nodeId, mode: "VERTICAL"|"HORIZONTAL"|"GRID", gap, padding, primaryAlign, counterAlign, horizontalSizing, verticalSizing, children: [...] })`. Use FILL for content that should stretch. Hug-everything layouts end up lopsided.
- Name layout frames by **role**: "Header", "Main column", "Row 1", "Actions". **Don't** give them component words like Card, Button, Tabs, Menu, Icon, Search or Badge. The audit flags those as hand-built imitations.

**Components.**
- `figma_instantiate_component({ componentKey, nodeId, variant: { ... }, overrides: { ... }, parentId })`. Always pass both `componentKey` and `nodeId` from the resolve or search result.
- Set content through component properties with `figma_set_instance_properties({ nodeId, properties: { Label: "Save", "Show Icon": false } })`. Never edit text inside an instance directly. Those edits fail silently.
- Pick the variant you need rather than restyling an instance. Style overrides on instances get reported.

**Tokens, never raw values.** Everything outside an instance must be bound:
- Fills: `figma_set_fills({ nodeId, fills: [{ type: "SOLID", variableId: "VariableID:…" }] })`. Strokes: `figma_set_strokes` with the same `variableId` field. If you need a color and no variable exists for it, that's a gap. Report it, don't pick a hex.
- Spacing, radius, sizes: set the layout with `figma_set_layout`, then bind the values to the system's variables with `figma_bind_tokens({ nodeId, bindings: { padding: "space/md", gap: "space/sm", cornerRadius: "radius/lg" } })` (names or ids; shorthands `padding`, `paddingX`, `paddingY`, `gap`, `cornerRadius`, or exact fields like `paddingTop`, `itemSpacing`, `topLeftRadius`). It never creates tokens: a field it can't bind comes back in `failed` with the closest real names. Pick from those only if one is clearly intended; otherwise it's a missing token. Tell the user.
- Text outside instances: create the node with `figma_create_child({ nodeType: "TEXT", properties: { text } })`, then `figma_bind_tokens({ nodeId, textStyle: "<style name from figma_get_text_styles>" })`. Don't hand-set fontSize or fontFamily.
- The root frame counts too: bind its fill or leave it empty.

**Gap placeholders** (only for items whose action is `placeholder`): one plain frame named exactly `GAP: <need>`, holding a single text layer with the need. Give it no styling that imitates a real component. Size it roughly to the space the missing element would take.

## 6. Audit, look, fix (max 3 rounds)

```
figma_audit_adherence({ nodeId: "<root frame>", libraryFileKeys: ["<library key>"], minScore: 90 })
figma_capture_screenshot({ nodeId: "<root frame>" })
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
- Check the screenshot for alignment, padding balance, FILL vs HUG, and overlaps.
- If a fix would require inventing something, stop and add it to the gap list for the person.
- A truncated audit never passes. Audit a smaller frame or raise `maxNodes`.

If it still fails after 3 rounds, stop and report the remaining findings. Don't loosen `minScore`.

## 7. Hand off for grading

Don't grade your own work. Use the `grade-generation` skill: an independent grader gets the original request, the root `nodeId`, the file and the library keys, and nothing else.

Then report to the person: what you built (root nodeId), the components used, the declared `GAP:` items, and anything left out at their request.

## Never

- Hand-build a look-alike of a component (a frame styled like a button, card, input, tab bar…).
- Create a new component or component set inside the composition.
- Use a raw hex, rgb or px value where a variable or style exists, or invent a token when none does.
- Hand-draw icons, logos or illustrations with vectors.
- Swap in a "close enough" component without the person approving it.
- Add elements the request didn't ask for.
- Leave partial artifacts behind after a failed attempt. Delete them before retrying (`figma_delete_node`).
