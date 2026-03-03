# Changelog

All notable changes to Figma Console MCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
