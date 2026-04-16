# Changelog

All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.2.0] - 2026-04-16

Minimised plugin footprint and improved log usefulness.

### Added
- Smart log summaries: commands show human-readable descriptions (e.g. "Run: create frame, set text") instead of raw type names
- Full session log history with "Copy log" button for audit export (timestamped plain text to clipboard)
- Collapsible toolbar via +/- button: default view is a single compact row (dot, status, disconnect)
- Panel state memory: collapsing and re-expanding preserves open panels and log scroll position

### Changed
- Reduced all padding and font sizes (~75%) to minimise overlay footprint on the canvas
- Status dot 16px to 10px, status text 15px to 11px, connect button and toolbar scaled proportionally
- Plugin content padding aligned to Figma chrome header (icon left edge, X button centre)
- WCAG AA contrast fixes: `--text-dim` and `--log-error` tokens updated for both dark and light themes

## [0.1.0] - 2026-03-14

First release of the forked Figma Desktop Bridge with UI improvements.

### Added
- Connect/Disconnect button for manual control over WebSocket connection
- Connected filename display with privacy toggle (CSS blur) in Info panel
- Log panel sticky header showing plugin version and server count
- Simplified Info panel copy for novice users
- Error state with helpful message when AI agent is not running
- WCAG AA compliant status colours with colour-blind cross on error dot

### Changed
- Status text shows "CONNECTED" instead of "READY" when active
- "Show log" eye icon direction corrected (open eye = show, slashed = hide)
- Server count moved from main status area to log panel header
- Light mode status dot colours adjusted for WCAG AA contrast compliance
