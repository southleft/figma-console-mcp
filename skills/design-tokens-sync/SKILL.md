---
name: design-tokens-sync
description: Sync design tokens between Figma variables and code with figma_export_tokens and figma_import_tokens — DTCG, CSS variables, Tailwind v3/v4, SCSS, TS, Style Dictionary, Tokens Studio — with dry runs first, multi-mode themes, aliases, and a verified round trip. Use when the user wants to export Figma variables to code, push token edits from code into Figma, set up tokens.config.json, or reconcile token drift.
---

# Sync design tokens (Figma ↔ code)

> **Tools (Local Mode):** this skill uses tools outside the core set. If they aren't in your tool list, call `figma_enable_toolsets({ toolsets: ["variables", "inspect"] })` once at the start; if they still don't appear, call them through `figma_call({ tool, arguments })`. Cloud Mode lists every tool, so skip this there.

Two tools do all the work: `figma_export_tokens` (Figma → files) and `figma_import_tokens` (files → Figma). **DTCG JSON** is the canonical pivot format. It carries Figma variable IDs in `$extensions["figma-console-mcp"]`, so renames on either side don't create duplicates. Always dry-run first, and confirm the source file before writing.

## 0. Preconditions

- The Desktop Bridge plugin must be open in the **right** Figma file. Run `figma_list_open_files`, then `figma_navigate({ url, lock: true })` if needed.
- Variables are read through the plugin, so this works on any Figma plan.
- Every response includes `source: { fileName, fileKey }`. **Check it each time.** The wrong active file is the #1 cause of bad syncs.

## 1. Configure once: tokens.config.json

Calling `figma_export_tokens()` with no config returns a `suggestedScaffold`. Show it to the person, write it with your file tools, then call again. A typical config:

```json
{
  "figmaFile": "<fileKey or URL>",
  "source":    { "dir": "src/styles/tokens", "pattern": "*.tokens.json", "canonical": "dtcg" },
  "generated": { "dir": "src/styles/generated",
                 "formats": [ { "format": "css-vars", "splitByMode": true },
                              { "format": "tailwind-v4" } ] },
  "modes":     { "map": { "Light": "light", "Dark": "dark" }, "default": "Light" },
  "conflictResolution": "ask"
}
```

**Pin `figmaFile`.** With it set, exports are routed to that file and fail if it isn't open, no matter which tab is focused.

## 2. Export (Figma → code)

1. Preview first: `figma_export_tokens({ strategy: "dry-run" })`, or with explicit options:
   ```
   figma_export_tokens({ format: "dtcg", outputPath: "src/styles/tokens/", modes: "all",
                         splitByCollection: true, dtcgDialect: "legacy", strategy: "dry-run" })
   ```
   Check `source`, `wouldWriteTo`, and the token counts.
2. Write with the default `strategy: "merge"`. That's the safe mode: it **refuses** to overwrite an existing DTCG file if doing so would drop tokens it doesn't manage (hand-added tokens, other collections), if a requested `collectionIds` entry is missing, if the export is empty, or if the file was generated from a different Figma file. When it refuses, report the reason. **Don't** switch to `replace` unless the person agrees after seeing what would be lost.
3. Generate the runtime formats from config, or one at a time:
   - `format: "css-vars"`: mode-aware selectors, aliases resolved.
   - `tailwind-v4` / `tailwind-v3`, `scss`, `ts-module`, `json-flat` / `json-nested`, `style-dictionary-v3`, `tokens-studio`.
   - Useful options: `prefix` (e.g. `"ds-"`), `colorFormat` (hex, hex8, rgba, oklch, hsl), `sizeUnit` (px, rem, pt, dp), `remBase`.

**outputPath** is treated as a directory by default. A path ending in `.json`, `.css`, `.scss`, `.less`, `.ts` or `.js` is treated as a single file, so the export must produce exactly one file (one format, no splitting). To re-export one collection into one file, use `scope: "collection"` with `collectionIds`.

## 3. Import (code → Figma)

1. **Always dry-run first:**
   ```
   figma_import_tokens({ dryRun: true })                                // uses tokens.config.json
   figma_import_tokens({ files: [{ path, content }], format: "dtcg", dryRun: true })
   figma_import_tokens({ payload: "<dtcg json>", format: "dtcg", dryRun: true })
   ```
   Report the plan to the person: counts and samples of `toCreate`, `toUpdate`, `toRename`, `toDelete`, plus any conflicts.
2. Only DTCG (both the legacy and the 2025.10 dialect) is fully supported as import input. CSS, Tailwind, SCSS and Tokens Studio input returns NotImplemented. Convert to DTCG first, or import the DTCG source those formats were generated from.
3. Apply with `strategy: "merge"` (the default). It creates, updates and renames, and **never deletes**. Figma-only variables are reported, not removed.
4. Conflicts (both sides changed since the last sync): with `onConflict: "ask"` (the default) nothing is written. Show each conflict to the person and let them choose `figma-wins`, `code-wins` or `skip` per run. Don't choose for them.
5. `strategy: "replace"` permanently deletes Figma variables that are absent from the token files, but only in the collections those files contain. The server asks the person to confirm the deletions. If the client can't show that prompt, you must get explicit approval yourself first: list what will be deleted, and warn that anything bound to those variables loses its binding.
6. Use `collectionMapping` (`{ "primitives": "Primitive Tokens" }`), `modeMapping` (`{ "light": "Light" }`) and `prefix` (stripped on import) when the names differ between sides.
7. Check `applyResult.errors[]`. Failures are per item, so the overall result can be a partial success.

## 4. Before renaming or deleting a variable

Check what uses it first: `figma_find_usages({ kind: "variable", id })` (inspect toolset) gives the bound layers by page. Report the count to the person before a destructive import (replace mode) removes or renames variables in use.

For a brand or product theme on top of a shared library, prefer an extended collection, `figma_extend_library_collection`, over copying the library's variables. It inherits every variable and overrides only what differs.

## 5. Multi-mode and aliases

- Modes: export with `modes: "all"` or `["Light","Dark"]`. `splitByMode: true` produces one file per mode. Import creates missing collections with the token file's full mode list.
- Aliases are kept as references in DTCG and JSON (`{color.primary}`). CSS, SCSS and Tailwind resolve them, because those formats can't express aliases (`resolveAliases` controls this).
- On import, references are written as real variable aliases. References that can't be resolved are skipped with a warning. Report those.
- Colors with opacity ("grey/900 at 50%") round-trip through `$extensions["figma-console-mcp"].composedColor`. Edit that, not only `$value`, to keep the link.
- Library aliases show up as `{__library:VariableID:…}`. They're preserved but not resolvable locally. List them for the person.

## 6. Verify the round trip

After any write:
1. Export DTCG with `strategy: "dry-run"` and check that the result matches the files you expect.
2. Run `figma_import_tokens({ dryRun: true })` on the repo's DTCG. A clean round trip shows **0** `toCreate`, `toUpdate`, `toRename` and `toDelete`, and no conflicts. Anything else is drift. Report it.
3. Spot-check a few values in Figma: `figma_get_variables({ format: "filtered", namePattern: "<token>", resolveAliases: true })`.

## Report

State the source file (name and key), the direction, the strategy, the counts created, updated, renamed and deleted, the conflicts and how they were resolved (and by whom), any skipped references, and the files written.

## Never

- Write without first checking `source`.
- Use `replace` on either tool to get around a refusal without the person agreeing.
- Resolve conflicts automatically.
- Hand-edit generated files (CSS, Tailwind, etc.). Edit the DTCG source and regenerate.
