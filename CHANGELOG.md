# Changelog

All notable changes to Figma Console MCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.3.0]: https://github.com/southleft/figma-console-mcp/compare/v1.2.5...v1.3.0
[1.2.5]: https://github.com/southleft/figma-console-mcp/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/southleft/figma-console-mcp/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/southleft/figma-console-mcp/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/southleft/figma-console-mcp/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/southleft/figma-console-mcp/compare/v1.1.1...v1.2.1
[1.1.1]: https://github.com/southleft/figma-console-mcp/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/southleft/figma-console-mcp/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/southleft/figma-console-mcp/releases/tag/v1.0.0
