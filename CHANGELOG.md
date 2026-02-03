# Changelog

All notable changes to Figma Console MCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
