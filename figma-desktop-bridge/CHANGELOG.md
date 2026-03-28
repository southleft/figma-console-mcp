# Changelog

All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/).

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
