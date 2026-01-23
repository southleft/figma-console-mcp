---
title: Changelog
description: Release history and version updates for Figma Console MCP
icon: clock-rotate-left
---

# Changelog

All notable changes to Figma Console MCP are documented here.

<Note>
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
</Note>

## [1.3.0] - January 23, 2025

### Added

<AccordionGroup>
  <Accordion title="Branch URL Support" icon="code-branch">
    `figma_get_variables` now supports Figma branch URLs in both formats:

    **Path-based format:**
    ```
    https://figma.com/design/{fileKey}/branch/{branchKey}/{fileName}
    ```

    **Query-based format:**
    ```
    https://figma.com/design/{fileKey}/{fileName}?branch-id={branchId}
    ```

    Auto-detection works when using `figma_navigate` first.
  </Accordion>

  <Accordion title="API Stability Improvements" icon="shield-check">
    - `extractFigmaUrlInfo()` utility for comprehensive URL parsing
    - `withTimeout()` wrapper for API stability (30s default)
    - `refreshCache` parameter for forcing fresh data fetch
    - Frame detachment protection in desktop connector
  </Accordion>
</AccordionGroup>

### Changed
- Variables API now uses branch key directly for API calls when on a branch
- Improved error handling for API requests with better error messages

### Documentation
- Comprehensive Mintlify documentation site launch
- Redesigned landing page with value-focused hero
- Updated tool count from 36+ to 40+
- Added GitHub Copilot setup instructions

---

## [1.2.5] - January 19, 2025

### Fixed
- Documentation cleanup and error fixes

---

## [1.2.4] - January 19, 2025

### Fixed
- McpServer constructor type error - moved instructions to correct parameter

---

## [1.2.3] - January 19, 2025

### Documentation
- Comprehensive documentation update for v1.2.x features

---

## [1.2.2] - January 18, 2025

### Fixed
- Gemini model compatibility fix

---

## [1.2.1] - January 17, 2025

### Fixed
- Component set label alignment issues

---

## [1.1.1] - January 16, 2025

### Fixed
- Minor bug fixes and stability improvements

---

## [1.1.0] - January 15, 2025

### Added
- New design system tools
- Enhanced component inspection capabilities
- Improved variable extraction

---

## [1.0.0] - January 14, 2025

<Info>
**Initial Public Release**
</Info>

### Added
- **40+ MCP tools** for Figma automation
- Console monitoring and code execution
- Design system extraction (variables, styles, components)
- Component instantiation and manipulation
- Real-time Figma Desktop Bridge plugin
- Support for both local (stdio) and Cloudflare Workers deployment

<CardGroup cols={2}>
  <Card title="View on GitHub" icon="github" href="https://github.com/southleft/figma-console-mcp/releases">
    See all releases and release notes
  </Card>
  <Card title="npm Package" icon="npm" href="https://www.npmjs.com/package/figma-console-mcp">
    View package on npm registry
  </Card>
</CardGroup>
