# Changelog

All notable changes to Figma Console MCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.31.0] - 2026-06-05

Fixes the most-reported reliability problem with the Desktop Bridge: the connection between your MCP client and Figma dropping, and staying down until you close the plugin, restart Claude Code, or manually hunt and kill ports. The root cause was never a flaky network — it was **zombie MCP server processes** squatting the WebSocket port range (9223–9232) after a bad shutdown, so each fresh server was bumped to a port with no plugin attached. This release makes those zombies impossible to create and reaps any that already exist, and pairs it with a plugin that reconnects itself instead of needing a restart.

**Plugin re-import required:** this release redesigns the Desktop Bridge plugin UI (`ui.html`) and updates `code.js`. Re-import the plugin in Figma Desktop after updating — **Plugins → Development → Import plugin from manifest…** → `~/.figma-console-mcp/plugin/manifest.json`. Figma caches plugin files at the application level, so an MCP-client restart alone will not pick up the new UI.

### Added

- **Self-healing zombie reaper.** The server now force-kills stale MCP processes that ignore a graceful shutdown. The old reaper sent only `SIGTERM` and counted success the instant the signal was *sent* — but a server hung on a lingering keep-alive connection catches `SIGTERM`, never reaches `process.exit`, and keeps its port. `terminateProcess` now escalates `SIGTERM` → grace period → `SIGKILL` and counts only confirmed deaths, so a hung zombie can no longer survive a reap.
- **Periodic background reaper.** Long-lived servers now sweep the port range every 5 minutes (`startPeriodicReaper`, timer `unref`'d so it never keeps the process alive), so zombies are cleared continuously — not only at the next startup. An `ORPHAN_MIN_AGE_MS` (60s) age guard spares mid-startup sibling servers.
- **Plugin auto-reconnect watchdog.** While the Desktop Bridge holds zero connections and you haven't paused it, it re-probes the port range every 12s and attaches automatically the instant a server appears — so a plugin opened before the MCP client started (or after a drop) connects on its own, with no restart. Probing stops the moment a connection succeeds.
- **Context-aware connection button.** The plugin's primary button now reflects state: **Pause** when connected, **Resume** when you've paused it, and **Reconnect** when a connection drops unexpectedly — a one-click instant retry instead of reopening the plugin.
- **Live server-count badge** in the plugin log header (`N server(s)`), which doubles as a zombie diagnostic: more servers than you expect means stale processes are present.

### Changed

- **Shutdown can no longer hang into a zombie.** The local-mode `SIGINT`/`SIGTERM` handlers previously did `await server.shutdown()` *before* `process.exit()`; if a WebSocket/HTTP close blocked on a lingering connection, the process stayed alive with its port file already removed — an invisible orphan. A 5-second hard backstop timer (`unref`'d) now forces exit even if shutdown hangs.
- **Desktop Bridge UI redesign (v0.2.1):** clearer log intelligence, the server-count badge, and Pause/Resume rescan controls. The manual **theme toggle** was removed — the plugin now follows the Figma app theme directly. The **file/page name mask toggle** was removed (it implied a privacy guarantee it didn't provide).
- **macOS-safe process-age detection.** Orphan-age checks use the portable `ps -o etime` (the Linux-only `-o etimes` is rejected by macOS `ps`).

### Fixed

- **"Not connected until I restart the plugin / Claude Code / kill ports."** The headline fix above. Diagnosed live from a machine carrying 8 stale `dist/local.js` servers (3–9 days old) holding ports 9223–9231; the SIGKILL escalation + shutdown backstop + periodic reaper together eliminate both the creation and the persistence of these zombies. Covered by integration tests that spawn a real `SIGTERM`-ignoring process and assert the reaper still kills it.


## [1.30.0] - 2026-06-02

Closes a set of Figma Plugin API gaps that previously forced callers into raw `figma_execute` code for common design-system operations — binding color variables to fills, changing typography, and overriding text on component instances. These are the failure modes that made people reach for external "how to drive the Console MCP" cheat-sheets; the structured tools now handle them directly, on any Figma plan, via the Desktop Bridge.

**Plugin re-import required:** this release changes the Desktop Bridge plugin files (`code.js` and `ui.html`). Re-import the plugin in Figma Desktop after updating — Figma caches plugin files, so an MCP restart alone is not enough.

### Added

- **`figma_set_fills` and `figma_set_strokes` can now bind a fill/stroke to a Figma variable.** Each fill/stroke object accepts an optional `variableId` (e.g. `"VariableID:1:23"` from `figma_get_variables`). The plugin builds the solid paint and attaches the binding via `figma.variables.setBoundVariableForPaint(paint, 'color', variable)` — the paint-level binding that the Plugin API requires (you cannot bind `fills` at the node level). Works on **any Figma plan** through the bridge; no raw `figma_execute` and no Enterprise Variables REST API needed. Import library variables first via `figma_import_library_variable`. An unknown `variableId` now returns a clear, actionable error instead of silently producing a flat color.
- **`figma_set_text` can now change the font family and style**, via new optional `fontFamily` and `fontStyle` params. Figma font-style names are space-sensitive (`"Semi Bold"`, not `"SemiBold"`), which silently produced wrong typography before. The tool now normalizes common no-space variants (`"SemiBold"` → `"Semi Bold"`, `"ExtraBold"` → `"Extra Bold"`), tries the value as-is first (for families that legitimately use no-space names), and falls back to `Regular` if the requested weight genuinely doesn't exist — so typography no longer requires raw `figma_execute`.

### Changed

- **`figma_set_fills` / `figma_set_strokes`: `color` is now optional** when `variableId` is provided (the bound variable drives the color). Existing hex-only calls are unaffected.

### Fixed

- **`figma_instantiate_component` no longer fails silently when overriding text.** The handler applied text-property overrides via `setProperties()` without first loading the instance's text fonts — which throws in `documentAccess: "dynamic-page"` mode (any instance whose text uses a non-Regular weight, e.g. Semi Bold). The font load was missing, the throw was swallowed as a `console.warn`, and the call returned `success` with the override quietly not applied. The handler now pre-loads every font used by the instance's text nodes (once, up front — avoiding the per-node loop that also caused timeouts) before applying overrides, and collects any override/variant failures into a `warnings[]` array returned in the result, so a bad override key (or any other failure) is surfaced instead of hidden.
- **Mixed-font text nodes no longer crash `figma_set_text`.** The old path called `figma.loadFontAsync(node.fontName)`, which throws when `fontName` is `figma.mixed`. It now loads every font actually used across the node's character ranges.
- **Plugin bridge relay (`ui.html`) was dropping newly-added message fields.** The relay reconstructs command messages field-by-field rather than forwarding them whole, and the inbound `setTextContent` relay only copied `fontSize`/`fontWeight`/`fontFamily` (so `fontStyle` was silently lost), while the outbound `handleResult` only copied a fixed set of fields (so instantiate `warnings` never reached the caller). Both now forward the new fields. (Nested payloads like a fill's `variableId` were already forwarded because arrays pass through whole.)


## [1.29.2] - 2026-06-02

Bug-fix patch: `figma_generate_component_doc` now renders Figma component descriptions faithfully and reliably tags each component's atomic-design level.

### Fixed

- **Component descriptions render their sections instead of leaking heading markup.** Figma component descriptions that used single `#` headings (e.g. `# Usage Guidelines`, `# Accessibility Requirements`) were only parsed at the `##`/`###` levels, so those sections leaked into the output as literal `- # Heading` list items instead of becoming real document sections. The parser now recognizes single-`#` headings as well, so Usage Guidelines, Implementation Considerations, Accessibility Requirements, and Content Configuration render as proper sections.
- **Frontmatter `description` no longer truncates mid-sentence.** The generated frontmatter took its `description` by splitting on the bare word "Accessibility", which cut the summary off mid-sentence whenever that word appeared. It now takes the first sentence up to the first heading or blank line.
- **Figma URL no longer contains a doubled `?node-id=`.** When the connected file's URL already carried a `?node-id=<page>` query param, the target node id was appended without stripping the existing one, producing a malformed URL with two `node-id` params. The existing param is now stripped before the target node is appended.
- **Atomic-design `level` is detected without relying on published-library metadata.** Auto-detection of a component's atomic level (atom / molecule / organism / template) first depended on the published `containing_frame.pageId` from `/components` + `/component_sets`, but many real files — including ones whose components have publish keys — return an empty `/component_sets` list over REST, so no `level` was emitted. Detection now resolves the home page directly via a single `ids=<node>` file request (which returns every page in document order, pruned to the path reaching the node) and walks back to the nearest `ATOMS`/`MOLECULES`/`ORGANISMS`/`TEMPLATES` divider — emitting `level:` frontmatter plus a matching tag, with no dependency on library publishing.


## [1.29.1] - 2026-05-30

Bug-fix patch: design-system token extraction now works on any Figma plan.

### Fixed

- **`figma_get_design_system_kit` no longer returns a 403 on its token/variable section for non-Enterprise users.** The kit fetched variables directly through the Enterprise-only Variables REST API (`getLocalVariables`) with no Desktop Bridge fallback — and wasn't even passed a bridge connector. So Starter/Pro/Org users (the majority) hit `403 "Limited by Figma plan"` *even when the Desktop Bridge or cloud relay was connected*, and AI clients would conclude variables were inaccessible and fall back to other sources (e.g. an uploaded `styles.css`). Variable resolution is now **bridge-first** via a shared `resolveFormattedVariables` helper that mirrors `figma_get_variables`' resolution order: the Desktop Bridge / cloud relay reads variables via the Plugin API on **any** plan, and the REST Variables API is used only as a fallback when no bridge is connected. When the bridge is absent *and* REST returns 403, the error now explicitly points the caller at the bridge / Cloud Mode and tells it to retry, instead of reading as a dead end.

### Changed

- **`figma_get_design_system_kit` description** now states that tokens/variables are read through the connected Desktop Bridge or cloud relay and work on any Figma plan (no Enterprise required), and that a Variables-REST 403 means "connect the bridge and retry" — so AI clients don't treat it as "variables unavailable."


## [1.29.0] - 2026-05-22

Shared-library inspection upgrade. Three new tools fill the gap between "I see a component key from search results" and "I can actually use it" — without forcing the user to find the source library file's URL, switch to a different file, or pay for Figma Enterprise to read library variables. The MCP now answers "what properties does this library component expose?" and "what design tokens does this library publish?" in a single tool call, then lets you import those tokens into the current file so they bind to nodes alongside the file's own variables.

Combined with the existing `figma_instantiate_component`, the end-to-end workflow now is: discover (`search_design_system` / `figma_get_library_components`) → inspect (`figma_get_library_component_by_key`) → instantiate (`figma_instantiate_component`) → inspect tokens (`figma_get_library_variables`) → import + bind (`figma_import_library_variable` → existing variable-binding tools). No file-URL hunting, no Enterprise plan required.

### Added

- **`figma_get_library_component_by_key`** — given only a 40-char component key (the kind returned by `figma_search_components`, `figma_get_library_components`, or the official Figma MCP's `search_design_system`), resolves it via Figma REST API `/v1/component_sets/{key}` → on 404 falls back to `/v1/components/{key}` → returns `componentPropertyDefinitions`, every variant with its published key + node id + per-variant `visualSpec` (fills, strokes, padding, typography), and the source `fileKey` + `nodeId`. Auto-detects COMPONENT_SET vs standalone COMPONENT. For component sets, also fetches the source file's `/components` list in parallel to map each variant node to its published variant key — without that mapping, downstream `figma_instantiate_component` calls can't pick a specific variant. Adaptive compression strips per-variant `visualSpec`s when the response exceeds 500KB (e.g. a 42-variant button at full visual-spec verbosity). Works on **all Figma plans** — no Enterprise plan required.
- **`figma_get_library_variables`** — lists every variable from team libraries the current file has subscribed, via Plugin API `figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()` + `getVariablesInLibraryCollectionAsync()` through the Desktop Bridge. Returns collections grouped by library with each variable's key, name, and resolvedType (COLOR / FLOAT / STRING / BOOLEAN). Server-side filters: `libraryName` and `collectionName` (case-insensitive substring), `resolvedType` (exact match — auto-prunes empty collections). Works on **all Figma plans** — the REST API's `/v1/files/{key}/variables/local` endpoint is Enterprise-only, but the Plugin API path this tool uses works on Pro and Org as well.
- **`figma_import_library_variable`** — imports a single variable from a subscribed library into the current file via Plugin API `figma.variables.importVariableByKeyAsync(key)`. Returns the imported variable's local `id`, which can be passed to `figma_set_fills` / `figma_update_variable` / any existing variable-binding tool to reference the library token from nodes in the current file. Idempotent — calling twice returns the same local id. Specific hint when the library isn't subscribed by the current file (the Plugin API rejects with a generic message; this tool detects the pattern and tells you to subscribe via Figma UI > Assets panel > Libraries).
- **`FigmaAPI.getComponentByKey(key)`** and **`FigmaAPI.getComponentSetByKey(key)`** — public methods on the REST client. Hit `/v1/components/{key}` and `/v1/component_sets/{key}` respectively. Return Figma's `PublishedComponent` / `PublishedComponentSet` shape wrapped in `{ status, error, meta }`. Available for use by other tools and third-party callers of the FigmaAPI class.
- **`extractVisualSpec`** is now exported from `src/core/design-system-tools.ts` — previously file-local. Other tools (including `figma_get_library_component_by_key`) can reuse the same fill/stroke/effect/padding/typography extractor that powers `figma_get_design_system_kit`, avoiding duplication.
- **`src/core/library-tools.ts`** — new module hosting the three tools above. Exports `registerLibraryTools(server, getFigmaAPI)` (REST-based inspection) and `registerLibraryVariableTools(server, getDesktopConnector)` (Plugin-API variable access). Registered in both `src/local.ts` (NPX/Local Git mode) and `src/index.ts` (Durable Object stateful path + stateless HTTP path) — so all three tools are available across local and cloud transports, unlike the older `figma_get_library_components` which is local-only.
- **27 new Jest tests** under `tests/library-tools.test.ts` covering: COMPONENT_SET resolution + variant key matching, standalone COMPONENT fallback on 404, error paths (both endpoints 404, 403/Forbidden, 429 rate-limited, non-404 errors that should NOT fall through), format=`summary` skip, `includeVisualSpecs=false` skip, adaptive >500KB compression, Plugin-API filters (libraryName / collectionName / resolvedType), `__error` sentinel parsing, connector failures, JSON-stringify escape of injected variable keys, and contract assertions (`_mcp` identity tag, `isError` propagation). Full suite: 1178 passing (was 1151 in v1.28.1).

### Changed

- **AI-facing tool descriptions** for the three new tools explicitly call out which Figma plans they work on. Library variables in particular have historically been gated behind Enterprise via the REST API; the description for `figma_get_library_variables` makes clear the Plugin API path bypasses that restriction.
- Plugin `PLUGIN_VERSION` bumped to `1.29.0`. **Re-importing the plugin manifest is _optional_** — none of the three new tools modify `figma-desktop-bridge/code.js`. The Plugin API variable tools route through the existing `executeCodeViaUI` handler that has shipped since v1.8.0.

### Deferred to a future release

- **Bind imported library variable to a node in a single tool call** — currently a two-step flow (`figma_import_library_variable` → returns local id → pass to `figma_set_fills` with `boundVariables`). A combined `figma_bind_library_variable_to_node` would be ergonomic but adds surface area without enabling anything new; revisit if real-world usage shows the two-step is friction.
- **List published variables from a specific library by `libraryKey` (lk-…)** — `figma_get_library_variables` lists everything subscribed by the current file. There's no Plugin API surface to query an arbitrary library by its `lk-` key without first subscribing it (subscription is UI-only). Documented as a limitation; users who need this should subscribe the library in Figma first.


## [1.28.1] - 2026-05-18

Patch release that surfaced from live-fire testing the v1.28.0 formatters against real multi-tier Figma libraries (Altitude Design System, lib-NEF-v5). Four bugs that produced garbage output for alias-heavy semantic-token sets, now fixed and covered by tests.

### Fixed

- **Tailwind v3 formatter — alias-only sets produced empty `module.exports`.** Sets where every token aliases a primitive (e.g. an Altitude `tier-2-theme` semantic layer pointing at `tier-1` brand colors) previously emitted a bare `{}` because the formatter skipped any token with a reference. The formatter now resolves alias chains to their literal target value at export time using a document-wide token index that spans every set, so semantic-layer sets emit the full namespaced color/spacing/etc. tree.
- **TypeScript module formatter — emitted `"{alias.path}"` strings as literal values.** Tokens with alias references were written into `tokens.ts` as `Light: "{color.brand.red.500}"` — useless at runtime since TypeScript has no resolution layer. Now resolves alias chains the same way Tailwind v3 does. Cross-library references stay as `null /* TODO: cross-library alias unresolved */` since those genuinely can't be resolved without the source library file.
- **JSON-flat and JSON-nested formatters — same alias-as-string bug.** `tier-2-theme.tokens.nested.json` would emit `{"Dark": "{color.brand.red.500}", "Light": "{color.brand.red.500}"}` instead of hex values. Now resolves to literals, with the same cross-library-skip path as the TS/Tailwind formatters.
- **Tailwind v4 formatter — namespace prefix doubled when token path already contained the namespace segment.** A token at `theme.color.header.background` (color type) produced `--color-theme-color-header-background` because the heuristic blindly prepended `color-` without checking whether the path already named the namespace. Now dedups the segment so the same path emits `--color-theme-header-background`. Affects any design system that includes the namespace word inside the variable path (common in tier-2 semantic layers).

### Added

- `resolveAliasChain` helper in `src/core/tokens/alias-resolver.ts` — the safer counterpart of `resolveReference` that returns `null` on cross-library or unresolvable references instead of throwing. Used by the four formatters above; available via the public token API for plugin authors building their own formatters.


## [1.28.0] - 2026-05-18

Full formatter coverage for `figma_export_tokens`. Seven new output formats moved from "scaffolded stub" to "fully implemented," completing the canonical-to-runtime pipeline for every popular styling method we surveyed across the user's design system portfolio. Combined with the existing DTCG JSON + CSS variables formatters, `figma_export_tokens` now ships **10 fully-implemented output formats** with zero third-party build-tool dependencies.

The MCP now replaces Style Dictionary and Tokens Studio's export pipeline end-to-end. Pull Figma variables once, emit code in any styling flavor your project uses.

### Added

- **Tailwind v4 formatter** (`format: "tailwind-v4"`) — emits `@theme inline { ... }` block with Tailwind's namespace conventions baked in. Token-path-to-Tailwind-namespace mapping (`color/*` → `--color-*` which generates `bg-*`/`text-*`/`border-*` utilities; same for `spacing`, `radius`, `font`, `text`, `font-weight`, `tracking`, `leading`, `shadow`). Mode variants emit under `.dark` (Tailwind's class-strategy convention) and `[data-theme="..."]`. Composite typography expands into primitive vars.
- **Tailwind v3 formatter** (`format: "tailwind-v3"`) — emits `module.exports = { colors: {...}, spacing: {...} }` grouped under Tailwind v3 theme keys. Designed to be spread into `tailwind.config.js`'s `theme.extend`. Heuristic type-to-namespace fallback for tokens whose path doesn't match a known Tailwind theme key.
- **SCSS formatter** (`format: "scss"`) — `$var: value;` declarations. Multi-mode tokens emit as a primary `$var` plus a `$var--modes` SCSS map keyed by mode name, so consumers can `map-get` for runtime mode access. Composite typography expands; composite shadow renders as a CSS shadow string. Cross-library aliases emit `//` line comments with the original Figma variable ID.
- **TypeScript module formatter** (`format: "ts-module"`) — `export const tokens = { ... } as const` with derived `type Tokens = typeof tokens`. Multi-mode tokens emit as `{ Light: "...", Dark: "..." }` objects. Custom identifier-prefix support produces camelCased export names (`dsTokens`, `dsTokensType`, etc.). Cross-library aliases emit `null /* TODO: cross-library alias unresolved */` so consumers see what to fill in.
- **JSON flat formatter** (`format: "json-flat"`) — flat key-value object (`{"ds-color-primary": "#4085F2"}`). Non-primary modes get `--<mode>` suffix on keys. Deterministic alphabetical key ordering. For custom build scripts that don't want the DTCG envelope.
- **JSON nested formatter** (`format: "json-nested"`) — nested object structure mirroring the token path tree. Multi-mode tokens emit as mode-keyed sub-objects. Alphabetical key ordering at every level.
- **Style Dictionary v3 formatter** (`format: "style-dictionary-v3"`) — SD v3 bare-key source format (`{value, type, comment}` instead of DTCG's `{$value, $type, $description}`). Back-compat for existing SD users (cbds-components, blocks, czi-edu, eddie-design-system). Maps DTCG type names to SD's conventions (dimension → size/spacing, fontFamily → string, etc.).
- **Tokens Studio formatter** (`format: "tokens-studio"`) — Tokens Studio for Figma's multi-file layout. Emits per-set token files (e.g. `primitives.json`, `theme/light.json`, `theme/dark.json`) plus `$metadata.json` (token-set order) and `$themes.json` (one theme entry per mode with Figma collection/mode bindings preserved). Enables round-trip with users of the Tokens Studio Figma plugin (notably Altitude).
- **22 new Jest tests** under `tests/tokens-formatters.test.ts` covering each formatter against primitive tokens, multi-mode tokens, local aliases (resolve), cross-library aliases (skip with traceable marker), and the dispatcher's smoke-test that confirms no `TokenFormatNotImplementedError` for any newly-shipped format. Full suite: 1151 passing (was 1129 in v1.27.1).

### Changed

- **AI-facing tool description** for `figma_export_tokens` now lists all 10 fully-implemented output formats with one-sentence descriptions. Previous "DTCG is the only format fully implemented" language is gone — that claim was already inaccurate at v1.27.0 when CSS variables shipped, and is now wildly out of date.
- **`docs/tools.md` Output formats table** — every previously-`⏳ Planned` row now shows `✅ Shipped`. Format-specific notes added (Tailwind v4 namespace mapping, SCSS multi-mode map, TS module derived types, Tokens Studio multi-file layout).
- **`scripts/release.sh`** — extended `MCP_VERSION` stamp updates to cover this release. Cloud Mode tool count regex unchanged (still missed bare `**93**` table cells, fixed manually as part of Phase 3.5 audit).
- **Stale `93 tools` references** in `README.md`, `docs/setup.md`, `docs/mode-comparison.md`, and `docs/introduction.md` table cells (the release script's regex doesn't catch `| **93** |` patterns) — swept manually as part of Phase 3.5 Block D.
- **`docs/index.mdx` `<Note>` banner and README banner** — refreshed with the v1.28.0 headline. Anchor links point to `CHANGELOG.md#1280---2026-05-18`.
- Plugin `PLUGIN_VERSION` bumped to `1.28.0`. **Re-importing the plugin manifest is _optional_** — the wire protocol is unchanged from v1.27.x.

### Deferred to a future release

These items remained out of scope for this release but are tracked in the roadmap:

- **Parsers** for non-DTCG input formats (Tokens Studio, CSS vars, Tailwind v4, Tailwind v3 config, SCSS, Style Dictionary v3, JSON flat/nested). `figma_import_tokens` still accepts DTCG only; convert other formats to DTCG via `figma_export_tokens` first.
- **`toCreate` apply orchestration** — diff plan returned but variable-creation mutations not yet wired. Use `figma_setup_design_tokens` / `figma_batch_create_variables` manually for now.
- **`toDelete` apply** for the `replace` strategy — destructive, needs careful UX.
- **Alias-target updates in the apply phase** — code-side `{color.primary}` references skip the update with a warning; needs target-ID resolution.
- **Cross-library variable resolution** — `{__library:VariableID:...}` references currently emit skip-comments. Needs a new plugin bridge command (`GET_VARIABLES_BY_ID`).



## [1.27.1] - 2026-05-16

Documentation patch. No code behavior changes. Catches the stale-content surface that the v1.27.0 release missed — the README's front-page banner still announced v1.23.0 (the previous user-visible release notes), and several tool descriptions / error messages / internal comments still said "Phase 1 ships with DTCG only" even though CSS variables formatter and the apply phase shipped during the v1.27.0 development cycle.

### Changed

- **README.md front-page banner** — was still announcing v1.23.0's "Version History & Time-Series Awareness" callout. Now shows the v1.27.0 token sync headline. The four releases between (v1.24–v1.27) had each shipped without updating the banner; this release sweeps every stale prose claim across README, docs, and source comments.
- **"What is this?" capability list** in README — added bidirectional token sync (the v1.27.0 headline), version history & time-series awareness, Slides presentations, and cross-MCP identity disambiguation.
- **Roadmap** — updated to v1.27.0 status, added entries for v1.27.0 / v1.26.0 / v1.25.0 / v1.24.0, trimmed pre-v1.7 entries to keep the list scannable.
- **AI-facing tool descriptions** for `figma_export_tokens` and `figma_import_tokens` — replaced "Phase 1 ships with DTCG only" with the current accurate scope: DTCG + CSS variables fully implemented, apply phase pushes value updates end-to-end with partial-success semantics, what's still deferred.
- **User-facing error messages** in the format stub classes — now correctly state that DTCG (parser + formatter) AND CSS variables (formatter only) are the fully-implemented paths.
- **Internal comments** in `src/core/tokens-tools.ts` and `src/core/tokens/transforms/` — softened "Phase 1 stub" / "Phase 2.5 will resolve" language to current-state descriptions.
- **Tool count consistency** — residual "93 tools" Cloud Mode references in `docs/mode-comparison.md` / `docs/setup.md` / `docs/tools.md` that the v1.27.0 release script's regex didn't catch are now 95.

### Fixed

- Shell-escape bug in EXPORT_TOOL_DESCRIPTION introduced during the audit pass: unescaped backticks inside the template literal (for `:root`, `.dark` selector examples) caused a TypeScript compile error. Backticks escaped.

## [1.27.0] - 2026-05-16

Bidirectional design token sync. Two new MCP tools replace Style Dictionary and Tokens Studio's export pipeline for popular styling methods. Designers can now ask their AI to push a hex value edit back to Figma — the diff-aware import produces exactly one Figma API call for that one variable, not a full collection rewrite.

The full pipeline is operational end-to-end: **Figma variables → DTCG JSON + CSS custom properties → edit hex → push to Figma**. Verified against two real design systems with different architectures (CollegeTown's 713-token TailwindCSS-derived setup with multi-mode tokens, and Altitude's 280-token 3-tier + brand-layer architecture). Both round-trip cleanly with `0 toCreate / 0 toUpdate / 0 toDelete` after export.

**Existing users (Local and Cloud Mode) are not impacted by these additions.** No existing tool changed name, schema, or behavior. No new required env vars, dependencies, or plugin protocol changes. Plugin re-import is **not required** — the wire protocol is unchanged.

### Added

- **`figma_export_tokens`** (Local + Cloud Mode) — Pull every variable across every collection and mode, normalize to canonical DTCG JSON (W3C Design Tokens Community Group spec), and fan out to one or more output formats. Phase 1 ships fully working DTCG canonical output + CSS custom properties (Tailwind v4 `@theme`, SCSS, TypeScript modules, etc. are scaffolded — DTCG canonical is the only format whose serializer is implemented; CSS variables is the second). Multi-mode tokens encoded via per-mode files with the file's mode name stamped in `$extensions["figma-console-mcp"].fileMode` for round-trip recovery. Cross-library aliases (variables pointing at published-library targets the local Plugin API doesn't return) preserve the original Figma variable ID in `{__library:VariableID:...}` references — CSS formatters emit a traceable comment instead of broken `var()` references.
- **`figma_import_tokens`** (Local + Cloud Mode) — Parse any supported source format, diff against current Figma state via ID-first / path-second / value-fingerprint match, and apply only the deltas via the Plugin API. Default `merge` strategy preserves Figma-only and code-only tokens. `dry-run` (the default for the first call after detecting changes) returns a structured diff plan without mutating Figma. Real apply phase wired through `connector.executeCodeViaUI` → `figma.variables.setValueForMode` — verified working against CollegeTown's 3-mode `base/primary` and Altitude's 4-brand `theme/color/background/primary-default`. Partial-success semantics: per-variable errors are surfaced in `applyResult.errors[]` without failing the batch.
- **`tokens.config.json`** schema — JSON Schema-validated, autodiscovered by walking up from the cwd (same convention as `tsconfig.json`). Drives both tools so subsequent calls are zero-arg. Honors `source.dir`/`source.canonical`, `generated.dir`/`generated.formats[]`, `modes.map`, `conflictResolution`, and `sync` behavior flags.
- **DTCG `$extensions["figma-console-mcp"]`** vendor metadata block on every exported token: `variableId`, `collectionId`, `lastSyncedValue` (per-mode snapshot for two-sided conflict detection), `lastSyncedAt`. Set-level: `originalName` (so slugified JSON keys round-trip to the original Figma collection name). Document-level: `figmaFileKey`, `exportedAt`, `mcpVersion`.
- **CSS variables formatter** with mode-aware selectors: `Light` / `Default` → `:root`, `Dark` → `.dark` (matches Tailwind's `darkMode: 'class'` convention), other modes → `[data-theme="<slug>"]`. Composite typography expands into multiple primitive vars. Shadow composites render as standard CSS `box-shadow` strings.
- **Order-independent diff comparison** in the import tool. Tokens that have the same mode values but different key insertion order (Figma returns collection-defined order, parsed JSON returns alphabetical) no longer surface as false-positive `toUpdate` entries.
- **Cloud Mode safety guard.** The tools are registered identically in both Local and Cloud Mode entry points but detect their runtime environment via an `isRemoteMode` flag passed at registration. In Cloud Mode (Cloudflare Workers, no local filesystem), `configPath` autodiscovery, `outputPath` disk writes, and config-source file reads throw a structured `[figma-console-mcp]` error pointing the user at the inline-payload workaround — instead of cryptic `ENOENT`/"not implemented" errors. Inline-mode export and import both work in Cloud Mode because the apply phase routes through `executeCodeViaUI` (transport-agnostic).
- **29 new Jest tests** under `tests/tokens.test.ts` covering: DTCG round-trip (single-mode, multi-mode, alias references, `$extensions` metadata, `splitByMode` recovery, deterministic key ordering, set-name slug round-trip), alias resolver (parse, resolve, cycle detection, unresolvable references), config loader (missing, valid, autodiscover, invalid JSON, schema validation), Figma converter (color, alias chains, collection/mode filtering, group `$type` inheritance), CSS variables formatter (primitives, aliases, dark mode convention, prefix, cross-library skip, multi-word font quoting, path slugification), Cloud Mode registration. Full suite: 1129 passing (was 1100).

### Changed

- **`scripts/release.sh`** extended to bump `MCP_VERSION` in `src/core/tokens-tools.ts` alongside the existing version stamps in `src/index.ts`, `figma-desktop-bridge/code.js`, and `docs/mint.json`. The auto-detected Cloud tool count now correctly includes the two new registrars (95 instead of 93).
- **`/health` response** now reports v1.27.0.
- **Plugin `PLUGIN_VERSION`** bumped to `1.27.0`. **Re-importing the plugin manifest is _optional_** — the wire protocol is unchanged from v1.26.0. Re-import only if you want the cosmetic plugin-version reporting in `figma_get_status` / `figma_diagnose` to read `1.27.0` instead of `1.26.0`.

### Deferred to Phase 2

- Remaining output formatters: `tokens-studio`, `tailwind-v4`, `tailwind-v3`, `scss`, `less`, `ts-module`, `json-flat`, `json-nested`, `style-dictionary-v3`. Each scaffolded — the dispatcher routes to the right module — but the serializers throw `TokenFormatNotImplementedError` with a clear message directing users to DTCG.
- Remaining input parsers: same list as above plus `tailwind-v3-config`. Auto-detection of payload format works end-to-end for DTCG; non-DTCG formats throw with a clear "convert to DTCG first" message.
- `toCreate` apply phase: diff plan returned but variable-creation orchestration not yet wired (`figma_setup_design_tokens` and `figma_batch_create_variables` remain the manual path for new variables).
- `toDelete` apply phase: Figma-only tokens preserved by default under `merge`. `replace` strategy + delete-apply ships in a future minor version.
- Alias updates in the apply phase: code-side `{color.primary}` references skip the update with a warning explaining the workaround. The Phase 2.5 fix needs `VARIABLE_ALIAS` target-ID resolution.
- Cross-library variable resolution: pulling values for `{__library:VariableID:...}` references via the plugin's `figma.variables.getVariableByIdAsync` (a new bridge command), so cross-library aliases render as actual `var(--target-token)` references instead of skip-comments.


## [1.26.0] - 2026-05-16

Internal cleanup and clarity release. No new tools, no removed tools, no breaking argument-shape changes. Three things are different for users running multiple Figma-related MCPs side by side and one is different for anyone who'd set up the old CDP debug path.

The headline change is that Local Mode no longer carries the Chrome DevTools Protocol / Puppeteer transport at all — the WebSocket Desktop Bridge plugin is the only Local path. Cloud Mode still uses Cloudflare's Browser Rendering API for `figma_navigate` / `figma_get_console_logs` / `figma_take_screenshot`; that path is unchanged.

The second change is that every tool response now carries an `_mcp: "figma-console-mcp"` field, and every error message is prefixed `[figma-console-mcp]`. This came from a real user case where a misleading "API token expired" message from Figma's official MCP was confused for an error from this server. The identity wrap makes the source of each response unambiguous in any agent transcript that mixes multiple MCPs.

The third change is a new tool, `figma_diagnose` — a designer-readable health check that reports mode, bridge state, PAT presence (without leaking the token), and disambiguation notes when other Figma MCPs are mounted alongside. Use it as the first call when a setup looks broken.

### Added

- **`figma_diagnose`** — single-call health check that returns structured status (mode, bridge connection, file context, transport, PAT state) plus designer-readable guidance. Registered in both Local and Cloud entry points (`src/core/diagnose-tool.ts`).
- **Plugin status pill** — the Desktop Bridge plugin UI now shows transport-specific state: `Local · ready`, `Cloud · ready`, or `Local + Cloud · ready`, instead of the previous generic `MCP ready`. Falls back to `MCP` when no connection is active. Updated in `figma-desktop-bridge/ui.html`.
- **MCP identity wrap** — every tool response carries a top-level `_mcp: "figma-console-mcp"` field; every thrown error is prefixed `[figma-console-mcp]`. Idempotent: re-tagging skips already-tagged payloads, preserves `isError`, leaves non-JSON content untouched (`src/core/identity.ts`).

### Changed

- **Local Mode is now WebSocket-only.** The `FigmaDesktopConnector` / Puppeteer / Chrome DevTools Protocol path has been removed entirely from Local Mode. All 101 Local Mode tools route through the WebSocket Desktop Bridge plugin on ports 9223–9232.
- **`puppeteer-core` and `chrome-remote-interface`** dropped from `dependencies`. Cloud Mode continues to use `@cloudflare/puppeteer` for its Browser Rendering path; that's a separate dependency and is unchanged.
- **30 write tools deduplicated** — the 30 inline write-tool registrations that were duplicated between `src/local.ts` and `src/core/write-tools.ts` are now defined in `write-tools.ts` only and consumed by both entry points via `registerWriteTools()`. Tool names, argument shapes, and return shapes are unchanged.
- **`transport` field in console-tool responses** is now always `"websocket"` in Local Mode (was `"cdp" | "websocket"`). Cloud Mode continues to report `"cdp"` for its Browser Rendering path.
- **`figma_navigate` description** rewritten to match current behavior. In Local Mode it switches the active file target among files that already have the Desktop Bridge plugin running; it does **not** launch a browser. In Cloud/Remote Mode it navigates the Cloudflare-hosted headless browser. Tool name and argument shape are unchanged.
- **REST auth error messages** rephrased to show only the relevant remediation path. Local-mode errors no longer mention OAuth / pairing codes; Cloud-mode errors no longer mention `FIGMA_ACCESS_TOKEN`.
- **`variablesCache` invalidation** — the cache now clears on plugin disconnect; previously a stale cache could survive a reconnect and shadow live data. Document-change events with no variable/style payload no longer blanket-clear the cache.
- **Bootloader scaffolding removed.** `BOOT_LOAD_UI`, `BOOT_FALLBACK`, `GET_PLUGIN_UI`, and the `/plugin/ui` HTTP endpoint were dead code (never functioned at runtime) and have been deleted. The plugin loads `ui.html` directly from disk at plugin-open time.
- **Documentation scrub** — every stale tool-count claim across `README.md`, `docs/`, `mint.json`, and `SECURITY.md` has been reconciled to the actual current counts (Local 101 / Cloud 93 / Remote 9). The release script's `auto_count_cloud` was extended to cover the four registrar files added since the script was written (`deep-component-tools.ts`, `version-tools.ts`, `accessibility-tools.ts`, `diagnose-tool.ts`), so future releases auto-detect correctly.
- Plugin `PLUGIN_VERSION` bumped to `1.26.0`. **Re-importing the plugin manifest is _optional_ in this release.** The v1.25.0 plugin remains wire-compatible with the v1.26.0 server — every tool, every command, and every protocol message still works. Re-import only if you want the cosmetic updates (new transport-aware status pill: `Local · ready` / `Cloud · ready` / `Local + Cloud · ready`, accurate `pluginVersion` in `figma_get_status` / `figma_diagnose` output). Required re-imports will continue to be called out explicitly when they apply, as they were in v1.22.4 (Plugin API method additions) and v1.10.0 (multi-port scanning).

### Removed

- **`FIGMA_DEBUG_HOST` / `FIGMA_DEBUG_PORT`** environment variables are no longer read. They only ever fed the CDP path; anyone who set them in their MCP client config will see them silently ignored. No migration is needed — the plugin auto-discovers the WebSocket server on ports 9223–9232.
- **`LocalModeConfig.debugHost` / `debugPort`** removed from `src/core/config.ts`.
- **`useCDP` flag** and `transport: "cdp"` literal removed from Local Mode source. Cloud Mode is unaffected.
- **`launch-figma-debug.sh` / `launch-figma-debug.ps1`** scripts deleted. They launched Figma with `--remote-debugging-port=9222` to expose CDP — a transport that no longer exists in Local Mode.
- **`/test-browser` HTTP endpoint** removed from the Cloudflare entry point. No docs referenced it.
- **`figma_get_variables` `parseFromConsole: true`** path removed. The cache → plugin → REST → styles resolution chain handles every case the old console-snippet workflow served; callers who passed `parseFromConsole: true` will now see an identified error.

### Fixed

- **Race condition in WebSocket grace-period timer** that could keep the Node process alive past `stop()`. Timer is now tracked and cleared in `stop()` and on new connections.
- **Plugin status pill** correctly reads `activeConnections` via the global getter rather than the IIFE-scoped variable that wasn't reachable at render time.
- **Cloud-only build** (`npm run build:local`) now succeeds without the pre-existing CDP-related TypeScript errors. The remaining pre-existing errors in `src/apps/*/ui/mcp-app.ts` (DOM types) are unchanged.


## [1.25.0] - 2026-05-13

Description and Dev Mode annotation changes are now first-class citizens in `figma_diff_versions`. v1.23.0 introduced version diffs but Figma's REST API never returns COMPONENT_SET descriptions or annotations in version snapshots — meaning every description edit and every annotation edit was silently invisible to the diff engine. For design-system teams who rely on descriptions and annotations to communicate intent, this was the most important category of change being missed.

This release closes the gap by capturing those edits via the Desktop Bridge plugin's `documentchange` listener, forwarding them over WebSocket into a per-file ring buffer on the MCP server, and merging them into the diff response by correlating the buffer's timestamps with the version time window. When the plugin is connected during an edit, descriptions and annotations now appear under `scoped_nodes[].metadata_changes[]` (when the changed node matches a `component_ids` scope) or `unscoped_metadata_changes[]` (when it doesn't). Both views carry a `source: "plugin_buffer"` marker so callers can distinguish REST-driven from plugin-captured changes.

The honesty principle from v1.24.0 still holds: `scope_coverage.metadata_buffer` reports whether the buffer is `available` at all and how many entries fell inside the time window. When the plugin wasn't connected during an edit, the buffer simply won't have those events — `notes[]` warns about this explicitly so the AI knows what it might be missing.

### Added

- **`scoped_nodes[].metadata_changes[]`** — description and annotation edits captured by the plugin, surfaced per scoped component. Each entry has `field` (`"description" | "annotations"`), `new_value`, `timestamp` (Unix ms), and `source: "plugin_buffer"`. Buffer matches contribute to the node's `change_count`, so summary stats stay consistent.
- **`unscoped_metadata_changes[]`** — same shape, for events whose `node_id` didn't match any requested `component_ids`. Prevents the buffer from silently dropping captured events when the caller's scope is narrow.
- **`scope_coverage.metadata_buffer`** — structured status object: `{ available, entries_in_window, entries_matched_to_scoped_nodes, entries_outside_scope }`. AI clients can branch on `available: false` to know they're in REST-only mode.
- **Plugin-side `METADATA_CHANGE` event** in `figma-desktop-bridge/code.js` — `figma.on('documentchange')` detects `PROPERTY_CHANGE` events touching `description`, `descriptionMarkdown`, or `annotations`, captures the new value (with annotations serialized to JSON-safe form), and posts to the UI. Forwarded over WebSocket by `ui.html`.
- **Server-side metadata buffer** in `src/core/websocket-server.ts` — new `MetadataChangeEntry` interface, per-`ClientConnection` ring buffer (size matches `documentChangeBufferSize`), `METADATA_CHANGE` message handler, and `getMetadataChanges({ fileKey, since, until, nodeIds })` reader API. Emits a `metadataChange` event for downstream subscribers.
- **6 new jest tests** under `metadata buffer (v1.25.0)` in `tests/version-tools.test.ts` — assertions for: available-false fallback when no getter wired, available-true empty-window case, scoped-match attachment, unscoped surfacing, time-window filtering, and propagation through `figma_generate_changelog`. Total suite: 1101 passing across 36 suites (up from 1095).

### Changed

- `scope_coverage.tracks[]` now lists "component descriptions via plugin session buffer" and "Dev Mode annotations via plugin session buffer" when the buffer is available; `does_not_track[]` correspondingly drops "comments, annotations" from its previous entry and adds either "description/annotation edits made while the Desktop Bridge plugin was disconnected" (buffer wired) or the full REST-omission caveats (buffer not wired).
- `scope_coverage.complementary_tools[]` adds `figma_get_component` for live description/annotation state on a single node.
- `figma_diff_versions` tool description rewritten to mention metadata buffer capability up front, so AI clients know to expect description and annotation visibility.
- `notes[]` in every diff response now includes a metadata-buffer status line — either "tracked when plugin was connected" + caveat, "buffer empty in this window," or "not tracked (no buffer wired)."
- Plugin `PLUGIN_VERSION` bumped to `1.25.0`. **Re-import the plugin manifest in Figma to pick up the new code.js / ui.html.**

### Fixed

- The silent description/annotation blind spot in `figma_diff_versions`. Empirical verification (this release's commit) confirmed Figma's REST `/v1/files/:key/nodes?version=…` endpoint returns `description: ""` for COMPONENT_SET nodes at every version, regardless of what the Plugin API reports. The new plugin-buffer pipeline is the only practical way to surface these changes without waiting for the user to publish a library.


## [1.24.0] - 2026-05-13

Honest scope coverage on version diffs. v1.23.0 already flagged variable VALUE history as a known blind spot in `notes[]`, but two other categories of change were silently invisible: **instances of components placed on the canvas** (documentation examples, hero frames, mockups) and **raw layout/visual properties** that aren't bound to variables (`layoutSizingHorizontal`, unbound paddings, `cornerRadius`, etc.). When the diff returned `change_count: 0` on a scoped node, an AI client had no way to know whether that meant "nothing changed" or "something changed in a category I don't see." That silent failure mode burned an entire investigation in our own demo. This release makes the limits loud — every response now carries always-on coverage warnings and a structured `scope_coverage` object.

### Added

- Always-on `notes[]` warnings in `figma_diff_versions`, `figma_get_changes_since_version`, and `figma_generate_changelog` responses:
  - "**Raw layout/visual properties are NOT tracked**" — fires on every response. Calls out `layoutSizingHorizontal/Vertical` (hug vs. fill), `primaryAxisSizingMode`/`counterAxisSizingMode`, raw paddings/widths/`cornerRadius` when not bound, and unbound fills/strokes/effects.
  - "**Component-scoped diff covers the canonical components only. INSTANCES of these components placed elsewhere on the canvas are NOT diffed**" — fires whenever `component_ids` are passed (explicitly or via selection fallback). Names `figma_get_design_changes` as the complementary forensic tool.
- New `scope_coverage` object in every diff response — machine-readable summary of what the diff DID and DID NOT examine:
  - `page_structure_diffed`, `component_ids_diffed`, `max_depth`
  - `tracks[]` — the 5 change categories surfaced (page structure, children, property defs, name/description, variable bindings)
  - `does_not_track[]` — the 6 known blind spots (instances, raw layout, raw visual, variable values, style content, comments/annotations)
  - `complementary_tools[]` — `figma_get_design_changes`, `figma_get_variables`, `figma_get_styles` mapped to the blind spots they cover
- Tool descriptions for `figma_diff_versions` updated with an `IMPORTANT:` callout pointing to `scope_coverage` and `notes[]` so AI clients see the limits at tool-selection time, not just in the response.

### Changed

- `figma_diff_versions` description rewritten to be explicit about what's tracked (structural + binding deltas) vs. what isn't, replacing the previous single-line variable-history caveat.

### Fixed

- Silent blind spot: a component-scoped diff that returned `change_count: 0` while a real edit existed on an instance of that component or on a raw layout property used to look identical to "no changes anywhere." It now always tells you what wasn't checked, in both prose (`notes[]`) and structured form (`scope_coverage`).


## [1.23.0] - 2026-05-09

Time-series awareness for design files. Six new tools that turn a Figma file from a static snapshot into a queryable history — list versions, snapshot any past version, diff two versions for added/removed/modified components and binding deltas, generate human-readable markdown changelogs, and trace exactly when (and by whom) a specific component property or variant was introduced via a binary-search blame walker. All composable, all cache-aware (~log₂(N) probes for blame, repeat queries on the same range nearly free), all honest about Figma REST API limits in `notes[]` responses.

Cloud Mode also unblocked: re-added `file_comments:read`, `file_comments:write`, and `file_versions:read` to the OAuth scope set so cloud users can post comments and use the new version-history tools. Local PAT users add the `Versions (Read)` checkbox alongside their existing scopes.

### Added

- `figma_get_file_versions` — list a file's version history with author/label/timestamp metadata. Auto-paginates, defaults to labeled-only (skips auto-saves), configurable cap. Cursor-style pagination with response-provided `next_cursor`.
- `figma_get_file_at_version` — snapshot a file (or specific node IDs) as it existed at a past version. Thin wrapper over `getFile`/`getNodes` with the `version` param.
- `figma_diff_versions` — structured diff between any two versions. Always returns a cheap page-structure diff (~2 API calls, parallel). When `component_ids` are passed, additionally produces per-node diffs at depth=2: added/removed children (variants), name/description changes, `componentPropertyDefinitions` changes, and `boundVariables` deltas. Mode-aware (`summary` / `standard` / `detailed`). Falls back to current Figma selection when `component_ids` omitted.
- `figma_get_changes_since_version` — convenience wrapper for `figma_diff_versions` with `to_version="current"` (HEAD). Same selection fallback.
- `figma_generate_changelog` — markdown changelog generator. Wraps the diff with author enrichment via `figma_get_file_versions` lookback (one extra cheap API call). Returns BOTH a `markdown` string (paste into release notes / PRs / Storybook MDX) and the structured diff payload. Mode-aware verbosity. HEAD renders as "Current state" without false attribution.
- `figma_blame_node` — find the version that introduced a specific component property or variant. Walks history backward via binary search (~log₂(N) probes instead of N). Default `include_autosaves: true` because most autosaves carry the real human user; system 'Figma' user is flagged via `attribution_certainty: "system_attributed"`. Falls back to current Figma selection when `node_id` omitted. Honest about the monotonic-existence assumption in `notes[]`.
- LRU snapshot cache (in-memory, 50 entries default) for past-version fetches. Past versions are immutable, so cached snapshots never go stale within a process. HEAD is intentionally never cached. Repeat blame/diff queries on the same range are nearly free.
- Cloud-mode OAuth scopes: `file_comments:read`, `file_comments:write`, `file_versions:read` re-added so cloud users can post comments AND use the new version-history tools.

### Changed

- Property-comparison helpers (`figmaRGBAToHex`, `normalizeColor`, `numericClose`) extracted from `design-code-tools.ts` into a shared `src/core/diff/property-compare.ts` module so the diff engine and parity checker can share without circular deps. Re-exported from the original location for back-compat.
- `summary.api_calls_made` on diff/changelog responses now reflects actual live calls (zero on a fully-cached repeat). New `cache_hits` field exposes how many fetches were served from cache.
- Tool descriptions for blame/diff/changelog clarify that they fall back to the current Figma selection when scope is omitted.

### Fixed

- Versions list pagination cursor direction (`figma_get_file_versions`). The Figma REST API uses `?after=ID` (not `?before=`) to walk into older history; the inverted cursor was returning the same labeled version repeatedly. Empirically verified against a 1000+ version file.
- `next_cursor` on `figma_get_file_versions` now reflects the LAST DISPLAYED item, not the last received from the API. Previous behavior would silently skip 40 versions if a caller paged forward with `max_versions=10` (since each page fetches 50 from Figma).
- Changelog markdown formatter no longer emits double blank lines between component change-count subtitle and the first sub-section when no intermediate bullets are present.


## [1.22.4] - 2026-04-28

Critical patch release. Restores compatibility with Gemini CLI / OpenCode / Codex CLI clients that broke in v1.21+, fixes silent variable-fetch failures via the Desktop Bridge, and addresses the plugin-version cache-staleness pattern that caused "Unknown method" errors after upgrades.

### Fixed
- **Schema regression broke Gemini CLI / OpenCode / Codex CLI** — `figma_check_design_parity` used `z.tuple([z.number(), z.number()])` for `codeSpec.accessibility.renderedSize`, which `zod-to-json-schema` emits as `items: [{type:'number'},{type:'number'}]`. Gemini's stricter Function Calling validator rejects this with `"is not of type 'object', 'boolean'"`, crashing the entire CLI. Replaced with `z.array(z.number()).min(2).max(2)` — same runtime validation, Gemini-safe schema (`items: {type:'number'}` plus `minItems`/`maxItems`). Added a regression test that sweeps every tool registered by `registerDesignCodeTools` and fails CI if any schema reintroduces the tuple shape. Closes #64, #66.
- **`figma_get_variables({refreshCache: true})` silently returned no variables via Desktop Bridge** — the plugin's `code.js` already wraps every `EXECUTE_CODE` payload in `(async function() { <code> })()`. The connectors at `src/core/websocket-connector.ts` and `src/core/cloud-websocket-connector.ts` were also wrapping the script body in an inner `(async () => { ... })()` IIFE; the inner `return` returned from the inner function but the outer async returned `undefined`, so the variables were silently dropped, the success guard at `figma-tools.ts:1926` failed, and the call fell through to the REST API fallback (which 403s on Pro/Org plans) — ending in "All methods failed." Both connectors now use a bare `try/catch` with top-level `return`. `figma-tools.ts` unwraps the `EXECUTE_CODE` response envelope so both transport paths produce a uniform shape downstream. Verified end-to-end: a ~700-variable file now returns the full token set instead of failing. Closes #68.
- **Plugin version drift caused "Unknown method" errors after upgrades** — `figma-desktop-bridge/code.js` had `var PLUGIN_VERSION = '1.14.0'` hardcoded while the npm package shipped 1.22.3. Figma Desktop appears to use the plugin version string as a cache key; without bumping it, Figma kept serving cached pre-update plugin code, so methods added in newer versions (`DEEP_GET_COMPONENT` from v1.19.0, `ANALYZE_COMPONENT_SET`, etc.) hit a `methodMap` miss and failed with `"Unknown method: DEEP_GET_COMPONENT"` even after users re-imported the manifest. Bumped `PLUGIN_VERSION` to match `package.json`, added step 3b to `scripts/release.sh` to keep them in sync on every release, and added a regression test that asserts the two values stay equal. Closes #62.

### Notes for users still hitting "Unknown method" after upgrading
If `figma_get_component_for_development_deep` or `figma_analyze_component_set` still fails after installing v1.22.4, fully delete the plugin from Figma (Plugins → Manage Plugins → trash icon) and re-import the manifest. Re-importing alone does not always invalidate Figma's content cache.


## [1.22.3] - 2026-04-07

### Added
- **`wcag-disabled-no-context`** rule — flags disabled variants that have no tooltip, helper text, or annotation explaining why the element is disabled. Based on accessibility consultant Isabella Minzly's guidance: use `aria-disabled` (not HTML `disabled`) to keep elements focusable for screen readers, and add a tooltip so all users understand the disabled reason.
- **`token-misuse`** rule — flags semantic token misuse: `bg/*` variables used as text fills, or `text/*` variables used as background fills. Catches misbound tokens that may or may not produce contrast failures.
- **WCAG conformance level tagging** — every finding now carries a `wcagLevel` field (`a`, `aa`, or `best-practice`). Teams targeting AA can filter out best-practice findings that don't represent legal requirements.

### Fixed
- **`wcag-focus-indicator` severity: warning → critical** — WCAG 2.4.7 (Focus Visible) is Level AA. Missing focus indicators are a blocker for keyboard users. Reviewed by Isabella Minzly.
- **`wcag-line-height` and `wcag-paragraph-spacing` severity: warning → info** — WCAG 1.4.12 (Text Spacing) requires supporting user-overridden spacing, not requiring specific default values. Flagging every heading with 1.33x line-height was a misinterpretation that created unnecessary noise.
- **`wcag-text-size` reclassified as best-practice** — WCAG 1.4.4 is about supporting 200% text-only zoom (use rem units), not about minimum pixel sizes. The 12px check remains as a readability best practice.
- **13 rule descriptions corrected** based on Isabella Minzly's accessibility review spreadsheet, including proper large text thresholds, 1.4.12 user-override clarification, 320px minimum width for reflow, and decorative image guidance.


## [1.22.0] - 2026-04-04

Comprehensive accessibility scanning — full-spectrum WCAG coverage across design and code without maintaining a rule database. Design-side checks are bounded by Figma's API surface (~15 rules); code-side checks delegate to axe-core (104 rules from Deque).

### Added
- **9 new WCAG lint rules** in `figma_lint_design` — non-text contrast (1.4.11), color-only differentiation (1.4.1), focus indicators (2.4.7), letter/paragraph spacing (1.4.12), image alt text (1.1.1), heading hierarchy (1.3.1), reflow/responsive (1.4.10), reading order (1.3.2). Expands from 4 to 13 WCAG checks.
- **`figma_audit_component_accessibility`** — deep accessibility scorecard for component sets with 6 audit categories: state coverage, focus indicator quality, non-color differentiation, target size consistency, annotation completeness, and color-blind simulation (protanopia/deuteranopia/tritanopia via Brettel/Vienot matrices). Returns weighted 0-100 score with prioritized recommendations.
- **`figma_scan_code_accessibility`** — server-side HTML scanning via axe-core 4.11.2 + JSDOM. Runs ~50 structural/semantic checks (ARIA, labels, alt text, headings, landmarks, tabindex, duplicate IDs). Visual rules disabled (handled by design-side lint). No Figma connection required.
- **`mapToCodeSpec` parameter** on `figma_scan_code_accessibility` — auto-generates a `codeSpec.accessibility` object from HTML + scan results, ready to pass directly into `figma_check_design_parity` for automated design-to-code accessibility parity checking.
- **7 new design-to-code parity checks** in `figma_check_design_parity` — focus indicator parity (design variant ↔ :focus-visible), disabled state parity, error state parity, required field parity, semantic element matching (button→`<button>`), target size parity, keyboard interaction documentation.
- **`CodeSpec.accessibility` fields** — `semanticElement`, `supportsDisabled`, `supportsError`, `renderedSize` for richer parity comparison.
- **`axe-core`** and **`jsdom`** added as dependencies for code-side accessibility scanning.

### Changed
- `figma_lint_design` WCAG rule group expanded from 4 to 13 rules. Existing rules unchanged — fully backward compatible.
- `figma_check_design_parity` accessibility comparison expanded from 2 to 9 checks. Existing CodeSpec fields remain optional.

### Fixed
- **Closed-world assumption in CodeSpec mapper** — `supportsDisabled` and `supportsError` now report `undefined` (unknown) instead of `false` when scanning a single HTML state snapshot. Prevents false positives when the scanned HTML is in default state but the component supports error/disabled states dynamically.


## [1.22.1] - 2026-04-06

### Fixed
- **Component audit false positives on presentational components** — The audit tool was applying interactive-component expectations (hover, focus, disabled states) to all components. An Alert component scored 53/100 when it actually had excellent coverage of its real variant axes (5/5 types, 2/2 styles). Components are now classified as `interactive` (button, input, checkbox, toggle) or `presentational` (alert, badge, card, avatar, tooltip, progress) based on name and variant axis analysis. Presentational components are scored on variant axis completeness instead of interaction state coverage.
- **Target size false positives on presentational components** — WCAG 2.5.8 defines minimum target size for interactive elements. Badges (16px), avatars (16x16), and other non-tap-target components were incorrectly flagged. Target size checks now only apply to interactive components; presentational components get `notApplicable` (scored 100%).
- **Focus indicator false positives on presentational components** — Focus indicators are not expected on presentational components like alerts and badges. Now marked `notApplicable` instead of "missing".


## [1.21.1] - 2026-04-01

### Fixed
- **Security: remove token metadata from production logs** — Removed `tokenPreview` (first 10 characters of access token), `tokenLength`, and `hasToken` fields from `logger.info` calls in `figma-api.ts`, `local.ts`, and `index.ts`. Development-time debugging that was never cleaned up. Reported by Samuel Klein, CISSP.


## [1.21.0] - 2026-04-01

Connection health protocol — agents no longer need custom health-check logic to detect and recover from bridge disconnections. Inspired by a connection resilience protocol shared by [Kaelig Deloumeau-Prigent](https://www.linkedin.com/in/kaelig/).

### Added
- **WebSocket heartbeat** — 30s ping/pong keepalive detects dead connections within ~60s instead of waiting for OS TCP keepalive (30-120s). Browser WebSocket auto-responds per RFC 6455 — no plugin changes needed.
- **`failureLayer`** on `figma_get_status` — Machine-readable `1 | 2 | null` field distinguishing Layer 1 (MCP server) from Layer 2 (plugin bridge) failures. Agents can programmatically route recovery without parsing error strings.
- **`probe` param** on `figma_get_status` — Optional active roundtrip verification (`probe: true`) sends a real command to the plugin and returns `probeResult: { success, latencyMs, error? }`. Replaces the need for canary calls.
- **`recoverySteps[]`** on `figma_get_status` — Structured, actionable recovery instructions for each failure layer. Agents can execute or display these directly.
- **`connectionError`** on bridge tool failures — Structured `{ layer, type, canRetry, recoverySteps }` object added to `figma_execute`, `figma_reconnect`, and bridge-dependent tool error responses. Backward compatible — existing `error`, `message`, `hint` fields unchanged.
- **`lastPongAt`** in status response — Heartbeat diagnostic timestamp exposed in `transport.websocket` for connection health monitoring.
- **`connectedClients`** on `/health` endpoint — Heartbeat-verified connected client count alongside raw `clients` count.

### Changed
- **`isClientConnected()`** now checks both socket `readyState` and heartbeat pong freshness (90s window), preventing phantom-connected state on silently dropped connections.

### Fixed
- **Plugin reconnect counter bug** — `wsReconnectAttempts` was a global counter shared across all ports, only reset during initial scan. Now resets on any successful reconnect, giving each disconnect the full retry budget.
- **Plugin permanent death after retry cap** — After 5 rapid reconnect attempts, the plugin stopped trying permanently. Now starts a 30s background retry interval, automatically reconnecting when the MCP server restarts without requiring the user to reopen the plugin.


## [1.20.1] - 2026-03-31

### Added
- **`figjam_create_section`** — New tool to create positioned, sized FigJam sections with fill color.

### Changed
- **`figjam_create_shape_with_text`** — Added `width`, `height`, `fillColor`, `strokeColor`, `fontSize`, `strokeDashPattern` parameters.
- **`figjam_create_connector`** — Added `startMagnet`, `endMagnet` parameters (AUTO, TOP, BOTTOM, LEFT, RIGHT) for directional connector routing.

### Fixed


## [1.20.0] - 2026-03-29

### Added
- **`figma_set_slide_background`** — New tool to set a slide's background color with a single call. Creates a 1920x1080 rectangle named "Background" or updates the existing one. Eliminates the need for manual rectangle creation + z-ordering via `figma_execute`.
- **`figma_get_text_styles`** — New tool to retrieve all local text styles with their IDs, font families, weights, sizes, and spacing. Works in any file type. Eliminates the need to discover text style IDs via `figma_execute`.
- **14 new slides tests** covering both new tools and enhanced `figma_add_text_to_slide` parameters (49 total slides tests).

### Changed
- **`figma_add_text_to_slide` enhanced** — 8 new optional parameters: `fontFamily`, `fontStyle`, `color`, `textAlign`, `width`, `lineHeight`, `letterSpacing`, `textCase`. Enables production-quality slide text creation without falling back to `figma_execute`. Font is loaded dynamically based on family/style parameters.

### Fixed


## [1.19.2] - 2026-03-27

### Added
- **171 new tests** across 8 core modules: config, snippet-injector, write-tools, console-monitor, design-system-manifest, figma-tools, figma-api, and figma-style-extractor. (Thanks to [@klgral](https://github.com/klgral).)
- **PAT scope documentation** — Token scopes table added to README.md, docs/setup.md, and docs/security.md with troubleshooting entries for common 403 errors. (Thanks to [@arevlo-flow](https://github.com/arevlo-flow).)

### Changed
- **AI-optimized screenshot defaults** — `figma_capture_screenshot` now defaults to PNG at 1x (was 2x) with automatic scale capping at 1568px (Claude's AI vision processing ceiling). Adds content-aware `formatAdvice` suggesting JPG for image-heavy content. 61–95% payload reduction, fully backwards compatible. (Thanks to [@klgral](https://github.com/klgral).)

### Fixed
- **Stale variables after writes** — `figma_get_variables` with `refreshCache: true` now fetches live data from the Plugin API instead of reading a stale UI snapshot. All 11 variable write operations now invalidate the cache on success. Fixed hardcoded `cached: true` flag. (Thanks to [@muloka](https://github.com/muloka) for the thorough diagnosis.)
- **ESM package root resolution** — `serverVersion` reported `"0.0.0"` in ESM runtime (`npx`) because `__dirname` is undefined. Now resolved via `import.meta.url` with a Jest CJS mock. Fixes Desktop Bridge plugin rejecting the server as "legacy." (Thanks to [@nick-inkeep](https://github.com/nick-inkeep). Closes #38, #39.)
- **Unhandled rejection crash in `withTimeout()`** — `promise.finally()` cleanup branch could cause an unhandled rejection that crashes the Node.js process. (Thanks to [@klgral](https://github.com/klgral).)


## [1.19.1] - 2026-03-27

### Fixed
- **Cloud Mode PAT authentication** — Figma Personal Access Tokens (`figd_*`) were rejected with `invalid_token` when used as Bearer tokens in Cloud Mode. The auth middleware on `/mcp` and `/sse` endpoints only validated tokens stored in the OAuth KV store, but PATs bypass OAuth entirely. Now PATs are detected by prefix and validated directly against Figma's API using the correct `X-Figma-Token` header. Affects Lovable, v0, Replit, and any MCP client using PAT-based Bearer auth with the cloud server. (Thanks to [Leesan Kwok](https://www.linkedin.com/in/leesankwok/) for reporting and diagnosing this issue.)


## [1.19.0] - 2026-03-25

### Added
- **High-fidelity design-to-code context** — Major enhancement to `figma_get_component_for_development`:
  - **Depth 2 → 4** across all design-to-code tools. Deeply nested components (data tables, nested menus, compound forms) now visible.
  - **18 new properties** in component output: `boundVariables` (design token bindings), `reactions` (prototype interactions), `layoutSizingHorizontal/Vertical` (CSS sizing), `minWidth/maxWidth/minHeight/maxHeight` (responsive constraints), `counterAxisSpacing`/`layoutWrap` (flex-wrap), `textAutoResize/textTruncation/textCase/textDecoration`, `componentPropertyReferences`, `styles` (shared style refs).
  - **Adaptive truncation** — responses >500KB auto-compress to prevent context overflow.
  - **Annotation enrichment** — fetches designer annotations via Desktop Bridge when connected.
- **`figma_get_component_for_development_deep`** — New MCP tool for unlimited-depth component extraction via Plugin API. Resolves `boundVariables` to actual token names (not just IDs), follows `mainComponent` references on INSTANCE nodes, extracts `reactions` and `annotations` at every tree level.
- **`figma_analyze_component_set`** — New MCP tool for variant state machine analysis. Maps Figma state variants to CSS pseudo-classes (hover→`:hover`, focus→`:focus-visible`, disabled→`:disabled`, error→`[aria-invalid]`). Produces cross-variant diffs showing only changed properties per state with resolved token names.
- **Codebase component scanning** — New `codebasePath` parameter on `figma_get_component_for_development`. Scans the target codebase for existing components, cross-references against Figma sub-component dependencies, marks each as IMPORT_EXISTING or BUILD_NEW. Prevents recreating existing components with inline markup. Model-agnostic — works for any AI client.
- **Composition dependency detection** — Component responses now include `compositionDependencies` listing every INSTANCE sub-component used, with explicit instructions to build sub-components as standalone before composing the parent.

### Changed
- **Enrichment service** — `hardcoded_values` detection and `variables_used` extraction now functional (previously stubbed). Token coverage calculates meaningful percentages.
- **`getComponentData()` helper** — depth parameter now configurable (default 4, was hardcoded 2).
- **`figma_check_design_parity`** — depth increased from 2 to 4.

### Fixed
- **componentProperties bloat** — Icon instances with 200KB+ instance swap catalogs now capped at 10KB summaries.
- **fillGeometry bloat** — SVG path data restricted to VECTOR/icon nodes only (was included on every frame).


## [1.18.0] - 2026-03-24

### Added
- **Design Annotations** — 3 new tools for reading, writing, and managing Figma design annotations via the Desktop Bridge plugin:
  - `figma_get_annotations` — Read annotations from nodes with optional child traversal and depth control. Returns plain text labels, markdown labels, pinned design properties, and annotation categories.
  - `figma_set_annotations` — Write or clear annotations on nodes. Supports plain text, rich markdown, pinned properties (fills, width, fontSize, etc.), annotation categories, and append mode. Pass an empty array to clear.
  - `figma_get_annotation_categories` — List available annotation categories in the current file.
- **Annotation enrichment** — `figma_get_component_for_development` now surfaces an annotation summary in its response. `figma_generate_component_doc` includes a "Design Annotations" section with full markdown rendering of designer-authored specs.

### Fixed
- **Annotation append mode** — When appending annotations, existing annotations are now correctly preserved. Figma auto-populates both `label` and `labelMarkdown` on read, but rejects writing both when they differ. The append logic now prefers `labelMarkdown` to avoid validation errors.


## [1.17.4] - 2026-03-24

### Fixed
- **Port exhaustion auto-recovery** — When all 10 WebSocket ports (9223–9232) are occupied by stale MCP server processes from old sessions, the server now automatically evicts the oldest instance to free a port. Previously, users had to manually kill processes. Safety guards: only triggers after both existing cleanup phases fail, won't evict instances younger than 2 minutes, never evicts its own PID, retries port binding exactly once.
- **PAT scope documentation** — Setup guide now specifies the three required Figma Personal Access Token scopes: File content (Read), Variables (Read), Comments (Read and write).


## [1.17.3] - 2026-03-22

### Fixed
- **Tool count accuracy** — Release script now correctly counts FigJam tools (`figjam_*`) and Slides tools in addition to `figma_*` tools. Previous releases reported 78+ tools; actual count is 84+ (75 figma + 9 figjam). Cloud mode updated from 52 to 76 tools.


## [1.17.2] - 2026-03-22

### Changed
- **Desktop Bridge priority for variable fetching** — When the Desktop Bridge plugin is connected, `figma_get_variables` now tries it FIRST instead of the REST API. Eliminates the 2-5 second 403 timeout penalty on non-Enterprise plans. REST API is preserved as a fallback for cloud mode or if the Desktop Bridge fails.


## [1.17.1] - 2026-03-22

### Added
- **Variable `codeSyntax` in Desktop Bridge** — Plugin now includes `codeSyntax` (CSS custom property mappings like `{ WEB: 'var(--color-primary)' }`) in all variable extraction paths. Previously only available via Enterprise REST API.

### Fixed
- **Variable alias resolution with summary/inventory verbosity** — `resolveAliases: true` now correctly returns resolved hex values at all verbosity levels. Previously, summary and inventory verbosity stripped `valuesByMode` before alias resolution ran, causing `resolvedValuesByMode` to always return empty objects.


## [1.17.0] - 2026-03-22

### Added
- **Figma Slides support** — 15 new MCP tools enable AI assistants to manage entire Figma Slides presentations. Covers the full lifecycle: reading, creating, editing, navigating, and presenting.
  - **`figma_list_slides`** — List all slides with IDs, names, grid positions, and skip status
  - **`figma_get_slide_content`** — Get the full content tree of a slide (text, shapes, frames, vectors)
  - **`figma_get_slide_grid`** — Get the 2D grid layout showing how slides are organized in rows and columns
  - **`figma_get_slide_transition`** — Read transition settings (style, duration, curve, timing)
  - **`figma_get_focused_slide`** — Get the currently focused slide in single-slide view
  - **`figma_create_slide`** — Create a new blank slide with optional grid position
  - **`figma_delete_slide`** — Delete a slide (undoable via Figma's undo)
  - **`figma_duplicate_slide`** — Clone an existing slide
  - **`figma_reorder_slides`** — Reorder slides via new 2D array of slide IDs
  - **`figma_set_slide_transition`** — Set transition effects with 22 styles (DISSOLVE, SMART_ANIMATE, directional slides/pushes/moves), 8 easing curves (LINEAR, EASE_IN/OUT, GENTLE, QUICK, BOUNCY, SLOW), and configurable duration
  - **`figma_skip_slide`** — Toggle whether a slide is skipped during presentation mode
  - **`figma_add_text_to_slide`** — Add text elements with configurable position and font size
  - **`figma_add_shape_to_slide`** — Add rectangles or ellipses with hex color fills
  - **`figma_set_slides_view_mode`** — Toggle between grid and single-slide view
  - **`figma_focus_slide`** — Navigate to and focus a specific slide
- **Slides documentation page** — Dedicated guide covering all 15 tools, use cases, transitions, and example prompts for designers.
- **Cloud mode support** — All Slides tools registered in both local and cloud entry points.

### Changed
- **Editor type detection extended** — Plugin now reports and handles `slides` editor type alongside `figma`, `figjam`, and `dev`. Variables bootstrap skipped in Slides mode (no variables API).
- **Manifest updated** — Added `"slides"` to `editorType` array in manifest.json.

### Fixed
- **Slides API corrections** — Four runtime API issues discovered and fixed during live testing:
  - `node.isSkippedSlide` (not `node.skipped`) for skip status
  - `figma.viewport.slidesView` (not `slidesMode`) for view mode control
  - Easing curves: `GENTLE`, `QUICK`, `BOUNCY`, `SLOW` (not `_BACK` variants which are for prototype interactions only)
  - Grid rows are array-like with numeric indices (not objects with `.children`)
  - `setSlideGrid()` expects existing SlideNode reference arrays from `getSlideGrid()`, not newly created SlideRow objects

### Contributors
- **Toni Haidamous (Tonihaydamous)** — Original Slides tool design and product vision (PR #11)

## [1.16.0] - 2026-03-22

### Added
- **FigJam board support** — 9 new MCP tools enable AI assistants to create and read FigJam collaborative boards. Opens the MCP server to an entirely new Figma product surface.
  - **`figjam_create_sticky`** — Create a sticky note with 9 color options (YELLOW, BLUE, GREEN, PINK, ORANGE, PURPLE, RED, LIGHT_GRAY, GRAY)
  - **`figjam_create_stickies`** — Batch create up to 200 sticky notes in one call. Ideal for populating boards from meeting notes, brainstorm ideas, or structured data.
  - **`figjam_create_connector`** — Connect two nodes with a labeled connector line. Build flowcharts, relationship maps, and process diagrams.
  - **`figjam_create_shape_with_text`** — Create labeled shapes (ROUNDED_RECTANGLE, DIAMOND, ELLIPSE, TRIANGLE_UP/DOWN, PARALLELOGRAM, ENG_DATABASE, ENG_QUEUE, ENG_FILE, ENG_FOLDER) for flowchart nodes and visual organization.
  - **`figjam_create_table`** — Create tables with cell data (up to 100 rows x 50 columns). Populate with 2D string arrays for comparison matrices and structured data display.
  - **`figjam_create_code_block`** — Create code blocks with language syntax highlighting (JAVASCRIPT, PYTHON, TYPESCRIPT, JSON, HTML, CSS, etc.).
  - **`figjam_auto_arrange`** — Arrange nodes in grid, horizontal, or vertical layouts with configurable spacing and column count.
  - **`figjam_get_board_contents`** — Read all content from a FigJam board with type-specific serialization (sticky text/colors, shape types, connector endpoints, table cell data, code content). Supports filtering by node type and pagination.
  - **`figjam_get_connections`** — Read the connection graph from a FigJam board. Returns all connectors as edges with start/end node references and labels, plus a lookup map of connected nodes.
- **Editor type detection** — Plugin reports `figma.editorType` (figma, figjam, dev) via WebSocket FILE_INFO. `figma_get_status` now exposes `editorType` so AI agents know which tools are available.
- **FigJam documentation page** — Dedicated guide covering all 9 tools, use cases, and example prompts.

### Changed
- **Variables bootstrap skipped in FigJam** — The plugin no longer attempts to fetch variables when running in a FigJam board (FigJam has no variables API), preventing unnecessary errors.
- **Enum-validated schemas** — Sticky colors, shape types, and board content node type filters now use `z.enum()` instead of `z.string()` for stricter validation and better LLM tool discovery. Gemini-compatible (no `z.any()`).
- **Shared color map in plugin** — Extracted duplicated sticky color map to a single module-level constant in `code.js` for DRY compliance.

### Security
- **Code injection prevention** — `figjam_auto_arrange` uses `JSON.stringify()` for proper JS string escaping instead of manual single-quote replacement, handling all control characters including Unicode line/paragraph separators.
- **Input bounds** — All FigJam tools enforce maximum sizes: 200 batch stickies, 100x50 table, 5000 char text, 50000 char code, 500 arrange nodes, 1000 read nodes.

### Contributors
- **klgral (G Klas)** — Original FigJam write tools implementation (PR #33)
- **lukemoderwell (Luke Moderwell)** — FigJam read tools, documentation, and E2E testing (PR #47)

## [1.15.5] - 2026-03-19

### Fixed
- **Library component import hangs** — `importComponentByKeyAsync` in the Desktop Bridge plugin could hang indefinitely when Figma couldn't resolve a library component. Added 15-second timeout via `Promise.race` for fast failure with a clear error message.
- **Component set keys rejected** — `figma_instantiate_component` only tried `importComponentByKeyAsync` which fails for COMPONENT_SET keys. Added `importComponentSetByKeyAsync` fallback that imports the set and uses `defaultVariant`.
- **REST API errors silently swallowed** — `figma_get_library_components` caught REST API errors (expired tokens, 403, wrong scope) and returned 0 results with no error message. API errors are now surfaced in the response with diagnostic hints.
- **Stale reconnect message** — Updated `figma_get_status` fallback port message to say "restart the plugin" instead of the outdated "re-import the manifest" instruction.

### Changed
- **Improved tool descriptions** — `figma_instantiate_component` and `figma_get_library_components` now include guidance on using variant keys (not component set keys), font pre-loading for cross-library components, and multi-file navigation tips for precise component discovery.


## [1.15.4] - 2026-03-19

### Fixed
- **Reverted bootloader UI swap** — The v1.15.0 bootloader used `figma.showUI(dynamicHtml)` to load fresh UI from the server, but Figma's Content Security Policy blocks inline scripts in dynamically loaded HTML on some environments. Reverted `ui.html` to the full plugin UI loaded via `__html__` (which gets proper CSP nonce treatment). The stable plugin directory, orphan process cleanup, HTTP endpoint, and housekeeping audit remain intact. The dynamic update approach will be revisited using external script loading.
- **Bootloader scanning hang** (v1.15.2) — Fixed timeout that caused infinite "MCP scanning" when a non-MCP server held a port in the 9223-9232 range.
- **`--print-path` starting full server** (v1.15.3) — Fixed the CLI flag to print the stable directory path and exit instead of accidentally launching the MCP server.

## [1.15.0] - 2026-03-18

### Added
- **Plugin bootloader architecture (experimental, reverted in v1.15.4)** — Attempted dynamic UI loading from MCP server via `figma.showUI()`. Worked on some environments but CSP blocked inline script execution on others. The server-side infrastructure (HTTP endpoint, `GET_PLUGIN_UI` WebSocket handler) remains for future use.
- **Stable plugin directory** — Plugin files are automatically copied to `~/.figma-console-mcp/plugin/` on server startup, providing a permanent import path that survives npx cache changes.
- **Orphaned process cleanup** — The server now detects and terminates stale MCP server processes on startup via `lsof`, freeing up ports in the 9223-9232 range that were held by zombie processes from closed Claude Desktop tabs.
- **Plugin version tracking** — `PLUGIN_VERSION` constant in `code.js` is sent in `FILE_INFO` WebSocket messages, enabling server-side version compatibility detection.
- **HTTP endpoint on WebSocket port** — The WebSocket server now also serves HTTP on the same port: `/plugin/ui` delivers the full plugin UI to the bootloader, `/health` provides server status for discovery.
- **Post-execution housekeeping audit** — `figma_execute` automatically runs a lightweight audit after code that creates pages, components, or frames. Detects duplicate page names, empty pages from failed attempts, and floating nodes not placed in Sections. Warnings are included in the tool response with `CLEANUP REQUIRED` instructions so AI assistants fix issues immediately.

### Changed
- **`figma_execute` tool description** — Added mandatory housekeeping rules: screenshot before/after creating, place inside Sections, clean up partial artifacts on failure, never create duplicate pages, remove orphaned layers.
- **`figma_create_child` tool description** — Updated to enforce Section/Frame placement and cleanup on failure.
- **Setup documentation** — Replaced re-import instructions with one-time bootloader setup. Updated stable plugin path, troubleshooting for new plugin states, architecture docs for bootloader and HTTP endpoint.

### Fixed
- **WebSocket server port conflict handling** — Fixed error handler for HTTP+WS shared server to properly catch `EADDRINUSE` from both the HTTP server and WSS (which re-emits HTTP errors). Prevents unhandled exceptions during port fallback.


## [1.14.0] - 2026-03-18

### Added
- **`figma_get_library_components` tool** — Discover published components from shared/team library files via the Figma REST API. Enables cross-file design system workflows: search a library file by URL or file key, get component keys with full variant detail, then instantiate them in your working file with `figma_instantiate_component`. Supports search filtering, pagination, and variant inclusion.
- **Cross-file library search in `figma_search_components`** — New `libraryFileKey` and `libraryFileUrl` parameters let you search for components in a published library from another file. When omitted, existing local search behavior is preserved.

### Changed
- **`figma_instantiate_component` description** — Updated to clarify support for both local and published library components. For library components, pass just the `componentKey` from library search results.

### Fixed
- **Variant-to-component-set matching** — Fixed variant grouping in REST API responses. The Figma REST API returns `containingComponentSet` as an object `{ name, nodeId }`, not a boolean. Added triple-fallback matching (object nodeId, containing_frame nodeId, component_set_id) to correctly associate variants with their parent component sets across all API response formats.


## [1.13.0] - 2026-03-14

### Added
- **`figma_lint_design` tool** — Run WCAG accessibility and design quality checks directly against Figma's node tree. 10 rules across 3 categories:
  - **WCAG Accessibility**: Color contrast (AA 4.5:1 / AAA 7:1 / large text 3:1), text minimum size (12px), interactive touch target minimum (24x24px), line height (1.5x font size with PIXELS and PERCENT support)
  - **Design System Hygiene**: Hardcoded colors (fills not bound to variables/styles), missing text styles, default/generic names, detached components (frames with component naming but no component reference)
  - **Layout Quality**: Missing auto-layout on multi-child frames, empty containers
  - Supports rule group filtering (`wcag`, `design-system`, `layout`) and individual rule IDs
  - Configurable tree depth and max findings limits
  - Opacity-aware contrast checking with `approximate` flag for semi-transparent fills
  - Works in both local and cloud relay modes

## [1.12.2] - 2026-03-13

### Fixed
- **Plugin crash when interacting with slot-based components** — Accessing `.name` on instance sublayers inside slots throws "does not exist" in Figma's Plugin API. Added try/catch guards around selection change handler, component children traversal, component set variant parsing, and recursive node walking. The plugin now silently skips unresolvable slot sublayers instead of crashing. (Thanks [@JannikSchulz](https://github.com) for reporting)

## [1.12.1] - 2026-03-13

### Added
- **`figma_set_image_fill` tool** — Set image fills on one or more Figma nodes. Accepts base64-encoded JPEG/PNG or file paths (local mode). Supports FILL, FIT, CROP, and TILE scale modes. Works in both local and cloud relay modes. (Thanks [@Gururagavendra](https://github.com/Gururagavendra) — [#31](https://github.com/southleft/figma-console-mcp/pull/31))

## [1.12.0] - 2026-03-13

### Added
- **Cloud Write Relay** — Web-based AI clients (Claude.ai, v0, Replit, Lovable) can now create and modify Figma designs through a cloud relay. Pair the Desktop Bridge plugin via a 6-character code and get full write access (43 tools) without installing Node.js locally.
  - `figma_pair_plugin` tool generates pairing codes (5-minute TTL) on the `/mcp` endpoint
  - `PluginRelayDO` Cloudflare Durable Object bridges commands via hibernation-aware WebSocket
  - `CloudWebSocketConnector` implements `IFigmaConnector` for cloud-to-plugin routing
  - `registerWriteTools()` shared function provides 27 write tools to both local and cloud paths
  - Desktop Bridge plugin gains Cloud Mode toggle with pairing code input and connect/disconnect
- **`CANONICAL_ORIGIN` environment variable** — Ensures OAuth redirect URIs use your custom domain instead of the default `workers.dev` URL. Optional with safe fallback to `url.origin`.

### Changed
- **Remote mode expanded from 22 to 43 tools** — When paired via Cloud Relay, remote mode gains all 27 write tools (design creation, variable management, node manipulation) plus the pairing tool. Read-only mode (without pairing) remains available with 15 REST API tools.
- **Desktop Bridge plugin renamed back to "Figma Desktop Bridge"** — Reverted from "MCP Bridge" to avoid confusion for existing local mode users.
- **Documentation restructured for three-tier model** — README, setup guide, mode comparison, tools reference, use cases, architecture, and Desktop Bridge docs updated to reflect Remote (read-only) / Cloud+Relay / Local setup options.

### Fixed
- **Cloud relay connection dropping between AI turns** — Durable Object now uses `ctx.getWebSockets('plugin')` and DO storage instead of in-memory class properties, surviving hibernation cycles.
- **Disconnect button not working in Desktop Bridge Cloud Mode** — `attachWsHandlers()` was overwriting the cloud-specific `onclose` handler. Fixed with chained disconnect callback and immediate UI reset.

## [1.11.6] - 2026-03-12

### Added
- **`--print-path` CLI flag** — Run `npx figma-console-mcp --print-path` to print the Desktop Bridge plugin manifest directory and exit. Useful for scripting and automation when you need to locate the plugin files without starting the server. Resolves #22.

### Fixed
- **Port exhaustion from zombie MCP processes** — Claude Desktop's known double-spawn bug and orphaned process issue could cause zombie MCP server instances to accumulate across WebSocket ports 9223-9232, eventually exhausting all available ports. Added three-layer zombie detection: heartbeat refresh (30s `lastSeen` updates), stale heartbeat detection (>5 min without refresh), and age ceiling (>4h for pre-v1.12 instances without heartbeat support). Zombie processes are terminated with SIGTERM to free their ports. Backward compatible with port files from older versions. Resolves #20.

## [1.11.5] - 2026-03-12

### Fixed
- **12 dependency vulnerabilities resolved** — `npm audit fix` clears all 12 reported vulnerabilities including 1 critical (basic-ftp path traversal), 6 high (hono XSS/prototype pollution, rollup path traversal, express-rate-limit bypass, minimatch ReDoS), and 5 moderate (undici, ajv, js-yaml, lodash). All fixes are semver-compatible transitive dependency updates. Resolves #18.

## [1.11.4] - 2026-03-12

### Added
- **SERVER_HELLO protocol** — WebSocket server sends identity message (port, PID, version, uptime) on new connections for debugging and logging
- **SERVER_HELLO test** — Test coverage for the new protocol message

### Fixed
- **Infinite WebSocket port scanning console spam** — Replaced unbounded retry loop with 3 initial scans (3s, 6s backoff) then stop. Disconnect reconnect capped at 5 attempts per port. Eliminates `ERR_CONNECTION_REFUSED` noise in Figma plugin console.
- **Manifest HTTP port entries** — Added explicit `http://localhost:9223`–`9232` entries to `allowedDomains` and `devAllowedDomains`. Figma's domain matching requires explicit ports for HTTP requests; bare `http://localhost` doesn't cover ported requests.

## [1.11.2] - 2026-02-25

### Fixed
- **`figma_take_screenshot` failing without explicit `nodeId` in WebSocket mode** — The synthesized URL from the Desktop Bridge connection lacked a `?node-id=` parameter, causing the tool to throw "No node ID found" when no `nodeId` was passed. The plugin now reports `currentPageId` alongside `currentPage`, and the server includes it in the synthesized URL so `figma_take_screenshot` (and any future URL-dependent tool) resolves the current page automatically.

## [1.11.1] - 2026-02-24

### Fixed
- **Frontmatter description overflow in `figma_generate_component_doc`** — When Figma descriptions contained multiple sections (overview, When to Use, Variants, etc.), the entire blob was dumped into the YAML `description` field. Now extracts only the overview paragraph.
- **Malformed Variant Matrix markdown tables** — Table rows were missing leading/trailing pipe characters, producing invalid markdown. Tables now render correctly in all markdown viewers.
- **Property metadata leaking into Content Guidelines and Accessibility sections** — Figma per-property documentation blocks (e.g., "Show Left Icon: True – Purpose") were being parsed into content and accessibility sections instead of being filtered out. Added pattern detection to route these to the discard bucket.

### Added
- **Storybook link in generated docs** — When `codeInfo.sourceFiles` includes a Storybook stories file, a `[View Storybook]` link is added to the doc header alongside Open in Figma and View Source.

## [1.11.0] - 2026-02-22

### Changed
- **Complete removal of CDP (Chrome DevTools Protocol) references** — Figma has blocked `--remote-debugging-port`, making CDP non-functional. All user-facing error messages, tool descriptions, status responses, and AI instructions now reference only the WebSocket Desktop Bridge plugin. Internal legacy code is retained for backwards compatibility but is no longer surfaced to users or AI models.
- **`figma_get_status` response simplified** — Removed `transport.cdp`, `browser`, and `availablePages` fields. Setup instructions no longer present CDP as an option. The response is now WebSocket-only.
- **Improved multi-file active tracking** — The most recently connected file now becomes the active file (previously the first connection held priority). When multiple files have the Desktop Bridge plugin open, switching tabs and interacting in Figma (selecting nodes, changing pages) immediately updates the active file via `SELECTION_CHANGE` and `PAGE_CHANGE` events.

### Fixed
- **Dead CDP probe on startup** — `checkFigmaDesktop()` was making a `fetch()` call to `localhost:9222/json/version` with a 3-second timeout on every server start, even though the result was never used. Removed the dead code path.
- **Incorrect transport type in `figma_reconnect`** — When the browser manager reconnected, the tool reported `transport: "cdp"` even though CDP is no longer active. Now correctly reports `transport: "websocket"`.
- **Active file not switching on new plugin open** — When opening the Desktop Bridge plugin in a new Figma tab while other tabs were already connected, the active file stayed on the first-connected file instead of switching to the newly opened one. The server now tracks which file connected most recently and uses `selectionCount` from `FILE_INFO` to identify the user's focused tab.

## [1.10.0] - 2026-02-12

### Added
- **Dynamic port fallback for multi-instance coexistence** — Multiple MCP server instances (e.g., Claude Desktop Chat tab + Code tab, or multiple CLI terminals) can now run simultaneously without port conflicts
  - Server automatically tries ports 9223–9232 in sequence when the preferred port is occupied
  - File-based port advertisement (`/tmp/figma-console-mcp-{port}.json`) with PID validation for stale detection
  - `figma_get_status` now reports actual port, preferred port, fallback flag, and discovered peer instances
  - Port files automatically cleaned up on shutdown (SIGINT/SIGTERM/exit) and stale entries pruned on startup
- **Multi-connection Desktop Bridge plugin** — The plugin now connects to ALL active MCP servers, not just the first one found
  - Parallel port scanning across 9223–9232 on startup
  - All events (selection changes, document changes, variables, console logs, page changes) broadcast to every connected server
  - Per-connection reconnect with automatic fallback to full port rescan
  - Each Claude Desktop tab or CLI session independently receives real-time events from Figma
- **Port discovery module** (`src/core/port-discovery.ts`) — Reusable module for port range management, instance discovery, and cleanup
- **`FigmaWebSocketServer.address()`** — Exposes the actual bound port after server starts (critical for OS-assigned port support)

### Changed
- Desktop Bridge manifest now allows WebSocket connections to ports 9223–9232 (was only 9223)
- `figma_get_status` transport section includes `preferredPort`, `portFallbackUsed`, and `otherInstances` fields
- Status messages updated to indicate when a fallback port is in use

### Fixed
- **EADDRINUSE crash when multiple Claude Desktop tabs spawn MCP servers** — Server now gracefully falls back to the next available port instead of failing to start. This was the primary issue reported by users of Claude Desktop's dual-tab architecture (Chat + Code tabs).

## [1.9.1] - 2026-02-11

### Added
- **`FIGMA_WS_HOST` environment variable** — Override the WebSocket server bind address (default: `localhost`). Set to `0.0.0.0` when running inside Docker so the host machine can reach the MCP server. (Thanks [@mikeziri](https://github.com/mikeziri) — [#10](https://github.com/southleft/figma-console-mcp/pull/10))

## [1.9.0] - 2026-02-10

### Added
- **Figma Comments tools** — 3 new MCP tools for managing comments on Figma files via REST API
  - `figma_get_comments` — Retrieve comment threads with author, message, timestamps, and pinned node locations. Supports `as_md` for markdown output and `include_resolved` to filter resolved threads.
  - `figma_post_comment` — Post comments pinned to specific design nodes. Use after `figma_check_design_parity` to notify designers of drift when code is the canonical source. Supports threaded replies.
  - `figma_delete_comment` — Delete comments by ID for cleanup after issues are resolved.
  - Works in both Local (NPX) and Remote (Cloudflare Workers) modes — pure REST API, no Plugin API dependency.
  - OAuth tokens require `file_comments:write` scope for posting and deleting. Personal access tokens work as-is.

### Fixed
- **Misleading "No connection" error when WebSocket port is in use** — When another MCP server instance already occupied port 9223, `figma_get_status` reported "No connection to Figma Desktop" and advised opening the Desktop Bridge plugin. Now correctly detects `EADDRINUSE` and reports: "WebSocket port 9223 is already in use by another process" with instructions to close the other shell.

## [1.8.0] - 2026-02-07

### Added
- **WebSocket Bridge transport** — Automatic fallback transport layer for when Figma removes Chrome DevTools Protocol (CDP) support
  - New `IFigmaConnector` interface abstracts transport layer (`src/core/figma-connector.ts`)
  - `FigmaDesktopConnector` (CDP) and `WebSocketConnector` implementations
  - WebSocket server on port 9223 (configurable via `FIGMA_WS_PORT` env var)
  - Auto-detection: WebSocket preferred when available, CDP fallback when not
  - Zero user action needed if CDP still works — fully backward compatible
  - Desktop Bridge plugin UI includes WebSocket client with auto-reconnect
  - Request/response correlation for reliable command execution over WebSocket
- **`figma_reconnect` tool** — Force reconnection to Figma Desktop, useful for switching transports or recovering from connection issues
- **Transport info in `figma_get_status`** — Status now reports which transport is active (CDP or WebSocket)
- **File identity tracking** — Plugin proactively reports file name and key on WebSocket connect via `FILE_INFO` message. The MCP server tracks connected file identity instantly (no roundtrip needed), and `figma_get_status` now includes `currentFileKey` and `connectedFile` details. AI instructions warn to verify file identity before destructive operations when multiple files are open.
- **Document change event forwarding** — Plugin listens to `figma.on('documentchange')` and forwards change events (node changes, style changes) through WebSocket. The MCP server uses these events to automatically invalidate the variable cache when design changes occur, preventing stale data.
- **WebSocket console monitoring** — Console tools (`figma_get_console_logs`, `figma_watch_console`, `figma_clear_console`) now work without CDP. The plugin overrides `console.log/warn/error/info/debug` in the QuickJS sandbox and forwards captured messages through WebSocket to the MCP server. Captures all plugin-context logs; for full-page monitoring (Figma app internals), CDP is still available.
- **WebSocket plugin UI reload** — `figma_reload_plugin` now works via WebSocket by re-invoking `figma.showUI()` to reload the plugin UI iframe. The `code.js` context continues running; only the UI is refreshed and the WebSocket connection auto-reconnects.
- **Graceful `figma_navigate` in WebSocket mode** — Instead of failing silently, `figma_navigate` now detects WebSocket-only mode and returns actionable guidance: the connected file identity and instructions to manually navigate in Figma Desktop.
- **`figma_get_selection` tool** — Real-time selection tracking via WebSocket. The AI knows what the user has selected in Figma without needing to ask. Returns node IDs, names, types, and dimensions. Optional `verbose` mode fetches fills, strokes, text content, and component properties for selected nodes. Selection state updates automatically as the user clicks around.
- **`figma_get_design_changes` tool** — Buffered document change event feed. The AI can ask "what changed since I last checked?" instead of re-reading the entire file. Returns change events with node IDs, style/node change flags, and timestamps. Supports `since` timestamp filtering and `clear` for polling workflows. Buffer holds up to 200 events.
- **Live page tracking** — `figma_get_status` now reports which page the user is currently viewing, updated in real-time via `figma.on('currentpagechange')`. Combined with selection tracking, the AI knows both "where" (page) and "what" (selection) without roundtrips.

### Fixed
- **`figma_get_component_image` crash** — Was using `api.getFile()` with `ids` param but accessing `fileData.nodes[nodeId]` which doesn't exist on the file endpoint response. Changed to `api.getNodes()` which returns the correct `{ nodes: { nodeId: { document } } }` structure.
- **`figma_set_instance_properties` crash with dynamic-page access** — Plugin code used synchronous `node.componentProperties` and `node.mainComponent` which fail with `documentAccess: "dynamic-page"`. Added `await node.getMainComponentAsync()` before accessing properties.
- **Rename tools showing "from undefined"** — The `handleResult` function in `ui.html` was only passing through the `dataKey` field, dropping `oldName` from rename operation responses. Fixed to pass through `oldName` and `instance` fields.
- **`figma_capture_screenshot` and `figma_set_instance_properties` bypassing WebSocket** — Both tools had a try/catch wrapper around `getDesktopConnector()` that silently swallowed errors and fell through to a legacy CDP fallback path, even when the connector factory was available. Removed the try/catch so errors propagate directly, and added a `!getDesktopConnector` guard so the legacy path only runs when no connector factory exists.
- **Transport priority reversed for reliability** — `getDesktopConnector()` now tries WebSocket first (instant connectivity check) then falls back to CDP (which involves a network timeout). Previously CDP was tried first, and its timeout delay caused race conditions during file switching.
- **Multi-file WebSocket client cycling** — When multiple Figma files had the Desktop Bridge plugin open, background plugins would aggressively reconnect (500ms backoff) after being displaced, creating an infinite replacement loop. Fixed by detecting the "Replaced by new connection" close reason in the plugin UI and stopping auto-reconnect for displaced instances, while keeping the standard reconnection backoff (up to 5 seconds) for other disconnections.
- **MCP Apps (Token Browser + Dashboard) bypassing WebSocket** — Both apps used `browserManager` (CDP-only) to construct a `FigmaDesktopConnector` directly, skipping WebSocket entirely. In WebSocket-only mode, they fell through to REST API (Enterprise plan required). Changed to use the transport-agnostic `getDesktopConnector()` which works with both WebSocket and CDP.

## [1.7.0] - 2026-02-07

### Added
- **Design-code parity checker** (`figma_check_design_parity`) — Compares a Figma component's design tokens against a code implementation to identify visual discrepancies in colors, typography, spacing, borders, and shadows
- **Component documentation generator** (`figma_generate_component_doc`) — Generates comprehensive developer documentation for Figma components including props/variants tables, design token mappings, usage examples, and accessibility guidelines

## [1.6.4] - 2026-02-04

### Fixed
- **Variables timeout for large design systems** — Increased `REFRESH_VARIABLES` timeout from 15 seconds to 5 minutes, matching the `GET_LOCAL_COMPONENTS` timeout. Fixes MCP disconnects when loading design systems with many variables.

## [1.6.3] - 2026-02-04

### Performance
- **Batched page processing for large design systems** — Component search now processes pages in batches of 3 with event loop yields between batches. This prevents UI freeze and potential crashes when loading design systems with many pages and components. Progress logging added for debugging large file loads.

### Fixed
- **Component instantiation error messages** — Removed misleading "unpublished or deleted from library" wording that caused AI assistants to incorrectly suggest publishing component libraries. New messages clarify that `componentKey` only works for published library components, and that local components require `nodeId`. Guides users to pass both identifiers together for reliable instantiation.

## [1.6.2] - 2026-02-04

### Fixed
- **Component instantiation error messages** — Same fix as above (released to address immediate user feedback).

## [1.6.1] - 2026-02-02

### Added
- **File name subheader** in Token Browser UI — Displays the Figma file name below "Design Tokens" title, matching the Design System Health dashboard style

### Fixed
- **MCP App UI caching** — Fixed issue where Claude Desktop would show stale data when reusing cached app iframes. Both Token Browser and Dashboard now refresh data via `ontoolresult` when a new tool request is made
- **Tab switching with Desktop Bridge** — Fixed plugin frame cache not being cleared when `figma_navigate` switches between Figma tabs, causing the bridge to communicate with the wrong file
- **Dashboard URL tracking** — Fixed `figma_audit_design_system` not tracking the actual file URL when called without an explicit URL parameter, causing the dashboard UI to fetch data for the wrong file

## [1.6.0] - 2026-02-02

### Added
- **Batch variable tools** for high-performance bulk operations
  - `figma_batch_create_variables` — Create up to 100 variables in one call (10-50x faster than individual calls)
  - `figma_batch_update_variables` — Update up to 100 variable values in one call
  - `figma_setup_design_tokens` — Create a complete token system (collection + modes + variables) atomically
- **Plugin frame caching** — Cached Desktop Bridge plugin frame reference eliminates redundant DOM lookups
- **Diagnostic gating** — Console log capture gated behind active monitoring to reduce idle overhead
- **Batch routing guidance** in MCP server instructions so AI models prefer batch tools automatically

### Changed
- Tool descriptions trimmed for token efficiency (`figma_execute` -75%, `figma_arrange_component_set` -78%)
- JSON responses compacted across 113 `JSON.stringify` calls (removed `null, 2` formatting)
- Individual variable tool descriptions now cross-reference batch alternatives

## [1.5.0] - 2026-01-30

### Added
- **Design System Health Dashboard** — Lighthouse-style MCP App that audits design system quality across six weighted categories
  - Scoring categories: Naming & Semantics (25%), Token Architecture (20%), Component Metadata (20%), Consistency (15%), Accessibility (10%), Coverage (10%)
  - Overall weighted score (0–100) with per-category gauge rings and severity indicators
  - Expandable category sections with individual findings, actionable details, and diagnostic locations
  - Tooltips explaining each check's purpose and scoring criteria
  - Refresh button for re-auditing without consuming AI context
  - Pure scoring engine with no external dependencies — all analysis runs locally
  - `figma_audit_design_system` tool with context-efficient summary (full data stays in UI)
  - `ds_dashboard_refresh` app-only tool for UI-initiated re-audit

### Fixed
- **Smart tab navigation** — `figma_navigate` now detects when a file is already open in a browser tab and switches to it instead of overwriting a different tab. Console monitoring automatically transfers to the switched tab.

### Documentation
- Design System Dashboard added to README and MCP Apps documentation
- Updated MCP Apps roadmap (dashboard moved from planned to shipped)
- Updated docs site banner for v1.5

## [1.4.0] - 2025-01-27

### Added
- **MCP Apps Framework** — Extensible architecture for rich interactive UI experiences powered by the [MCP Apps protocol](https://github.com/anthropics/anthropic-cookbook/tree/main/misc/model_context_protocol/ext-apps)
  - Modular multi-app build system using Vite with single-file HTML output
  - Parameterized `vite.config.ts` supporting unlimited apps via `APP_NAME` env var
  - Gated behind `ENABLE_MCP_APPS=true` — zero impact on existing tools
- **Token Browser MCP App** — Interactive design token explorer rendered inline in Claude Desktop
  - Browse all design tokens organized by collection with expandable sections
  - Filter by type (Colors, Numbers, Strings) and search by name or description
  - Per-collection mode columns (Light/Dark/Custom) matching Figma's Variables panel layout
  - Color swatches with hex/rgba values, alias reference resolution, and click-to-copy
  - Desktop Bridge priority — works without Enterprise plan via local plugin
  - Compact table layout with sticky headers and horizontal scroll for many modes
  - `figma_browse_tokens` tool with context-efficient summary (full data stays in UI)
  - `token_browser_refresh` app-only tool for UI-initiated data refresh

### Documentation
- New MCP Apps section in README with explanation, usage, and future roadmap
- New `docs/mcp-apps.md` documentation page with MCP Apps overview and architecture
- Updated Mintlify docs navigation to include MCP Apps guide

## [1.3.0] - 2025-01-23

### Added
- **Branch URL Support**: `figma_get_variables` now supports Figma branch URLs
  - Path-based format: `/design/{fileKey}/branch/{branchKey}/{fileName}`
  - Query-based format: `?branch-id={branchId}`
  - Auto-detection when using `figma_navigate` first
- `extractFigmaUrlInfo()` utility for comprehensive URL parsing
- `withTimeout()` wrapper for API stability (30s default)
- `refreshCache` parameter for forcing fresh data fetch
- Frame detachment protection in desktop connector
- GitHub Copilot setup instructions in documentation

### Changed
- Variables API now uses branch key directly for API calls when on a branch
- Improved error handling for API requests with better error messages

### Documentation
- Comprehensive Mintlify documentation site launch
- Redesigned landing page with value-focused hero and bento-box layout
- Updated tool count from 36+ to 40+
- Added Open Graph and Twitter meta tags

## [1.2.5] - 2025-01-19

### Fixed
- Documentation cleanup and error fixes

## [1.2.4] - 2025-01-19

### Fixed
- McpServer constructor type error - moved instructions to correct parameter

## [1.2.3] - 2025-01-19

### Documentation
- Comprehensive documentation update for v1.2.x features

## [1.2.2] - 2025-01-18

### Fixed
- Gemini model compatibility fix

## [1.2.1] - 2025-01-17

### Fixed
- Component set label alignment issues

## [1.1.1] - 2025-01-16

### Fixed
- Minor bug fixes and stability improvements

## [1.1.0] - 2025-01-15

### Added
- New design system tools
- Enhanced component inspection capabilities
- Improved variable extraction

## [1.0.0] - 2025-01-14

### Added
- Initial public release
- 40+ MCP tools for Figma automation
- Console monitoring and code execution
- Design system extraction (variables, styles, components)
- Component instantiation and manipulation
- Real-time Figma Desktop Bridge plugin
- Support for both local (stdio) and Cloudflare Workers deployment

[1.31.0]: https://github.com/southleft/figma-console-mcp/compare/v1.30.0...v1.31.0
[1.30.0]: https://github.com/southleft/figma-console-mcp/compare/v1.29.2...v1.30.0
[1.29.2]: https://github.com/southleft/figma-console-mcp/compare/v1.29.1...v1.29.2
[1.29.1]: https://github.com/southleft/figma-console-mcp/compare/v1.29.0...v1.29.1
[1.29.0]: https://github.com/southleft/figma-console-mcp/compare/v1.28.1...v1.29.0
[1.28.1]: https://github.com/southleft/figma-console-mcp/compare/v1.28.0...v1.28.1
[1.28.0]: https://github.com/southleft/figma-console-mcp/compare/v1.27.1...v1.28.0
[1.27.1]: https://github.com/southleft/figma-console-mcp/compare/v1.27.0...v1.27.1
[1.27.0]: https://github.com/southleft/figma-console-mcp/compare/v1.26.0...v1.27.0
[1.26.0]: https://github.com/southleft/figma-console-mcp/compare/v1.25.0...v1.26.0
[1.25.0]: https://github.com/southleft/figma-console-mcp/compare/v1.24.0...v1.25.0
[1.24.0]: https://github.com/southleft/figma-console-mcp/compare/v1.23.0...v1.24.0
[1.23.0]: https://github.com/southleft/figma-console-mcp/compare/v1.22.4...v1.23.0
[1.22.4]: https://github.com/southleft/figma-console-mcp/compare/v1.22.3...v1.22.4
[1.22.3]: https://github.com/southleft/figma-console-mcp/compare/v1.22.1...v1.22.3
[1.22.1]: https://github.com/southleft/figma-console-mcp/compare/v1.22.0...v1.22.1
[1.22.0]: https://github.com/southleft/figma-console-mcp/compare/v1.21.1...v1.22.0
[1.21.1]: https://github.com/southleft/figma-console-mcp/compare/v1.21.0...v1.21.1
[1.21.0]: https://github.com/southleft/figma-console-mcp/compare/v1.20.1...v1.21.0
[1.20.1]: https://github.com/southleft/figma-console-mcp/compare/v1.20.0...v1.20.1
[1.20.0]: https://github.com/southleft/figma-console-mcp/compare/v1.19.2...v1.20.0
[1.19.2]: https://github.com/southleft/figma-console-mcp/compare/v1.19.1...v1.19.2
[1.19.1]: https://github.com/southleft/figma-console-mcp/compare/v1.19.0...v1.19.1
[1.19.0]: https://github.com/southleft/figma-console-mcp/compare/v1.18.0...v1.19.0
[1.18.0]: https://github.com/southleft/figma-console-mcp/compare/v1.17.4...v1.18.0
[1.17.4]: https://github.com/southleft/figma-console-mcp/compare/v1.17.3...v1.17.4
[1.17.3]: https://github.com/southleft/figma-console-mcp/compare/v1.17.2...v1.17.3
[1.17.2]: https://github.com/southleft/figma-console-mcp/compare/v1.17.1...v1.17.2
[1.17.1]: https://github.com/southleft/figma-console-mcp/compare/v1.17.0...v1.17.1
[1.15.5]: https://github.com/southleft/figma-console-mcp/compare/v1.15.4...v1.15.5
[1.15.0]: https://github.com/southleft/figma-console-mcp/compare/v1.14.0...v1.15.0
[1.14.0]: https://github.com/southleft/figma-console-mcp/compare/v1.13.1...v1.14.0
[1.11.5]: https://github.com/southleft/figma-console-mcp/compare/v1.11.4...v1.11.5
[1.11.4]: https://github.com/southleft/figma-console-mcp/compare/v1.11.2...v1.11.4
[1.11.2]: https://github.com/southleft/figma-console-mcp/compare/v1.11.1...v1.11.2
[1.11.1]: https://github.com/southleft/figma-console-mcp/compare/v1.11.0...v1.11.1
[1.11.0]: https://github.com/southleft/figma-console-mcp/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/southleft/figma-console-mcp/compare/v1.9.1...v1.10.0
[1.9.1]: https://github.com/southleft/figma-console-mcp/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/southleft/figma-console-mcp/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/southleft/figma-console-mcp/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/southleft/figma-console-mcp/compare/v1.6.4...v1.7.0
[1.6.4]: https://github.com/southleft/figma-console-mcp/compare/v1.6.3...v1.6.4
[1.6.3]: https://github.com/southleft/figma-console-mcp/compare/v1.6.2...v1.6.3
[1.6.2]: https://github.com/southleft/figma-console-mcp/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/southleft/figma-console-mcp/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/southleft/figma-console-mcp/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/southleft/figma-console-mcp/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/southleft/figma-console-mcp/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/southleft/figma-console-mcp/compare/v1.2.5...v1.3.0
[1.2.5]: https://github.com/southleft/figma-console-mcp/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/southleft/figma-console-mcp/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/southleft/figma-console-mcp/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/southleft/figma-console-mcp/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/southleft/figma-console-mcp/compare/v1.1.1...v1.2.1
[1.1.1]: https://github.com/southleft/figma-console-mcp/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/southleft/figma-console-mcp/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/southleft/figma-console-mcp/releases/tag/v1.0.0
