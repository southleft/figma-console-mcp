# Changelog

All notable changes to Figma Console MCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
