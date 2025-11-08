# AI Decision-Making Guide for Figma Console MCP

## Executive Summary

This document provides comprehensive guidance for AI assistants on when and how to use the Figma console MCP tools effectively, preventing tool-hopping between different MCPs and ensuring optimal tool selection.

## Critical Rule: MCP Tool Selection Priority

**ALWAYS prefer Figma console MCP tools over other MCPs when working with Figma data.**

```
Priority Order:
1. Figma console MCP (this MCP) - PRIMARY for all Figma operations
2. Figma official MCP - ONLY if console MCP explicitly fails
3. Playwright/Browser MCPs - NEVER for Figma data retrieval
```

## Available MCP Tools Overview

### Figma Console MCP Tools (THIS MCP)

| Tool Name | Primary Purpose | When to Use | DO NOT Use For |
|-----------|----------------|-------------|----------------|
| `figma_get_component` | Get component metadata **including descriptions** | Getting component descriptions, properties, metadata | File structure exploration |
| `figma_get_file_data` | Get file structure and document tree | Understanding file structure, finding nodeIds | Component descriptions (use figma_get_component) |
| `figma_get_variables` | Get design tokens/variables | Retrieving design system tokens, theme variables | Component data |
| `figma_get_styles` | Get text/color/effect styles | Style system documentation, design tokens | Component properties |
| `figma_get_component_image` | Render component as image | Visual reference, screenshots | Component metadata |
| `figma_get_component_for_development` | Get component + implementation context | UI implementation, code generation | Simple metadata queries |
| `figma_get_file_for_plugin` | Get file data for plugin development | Plugin development, filtered file data | General queries |

### Desktop Bridge Plugin Architecture

The Figma console MCP includes a **Desktop Bridge plugin** that provides access to data not available through Figma's REST API:

```
Architecture:
┌─────────────────────────────────────┐
│   Figma Desktop Application         │
│  ┌──────────────────────────────┐   │
│  │  Desktop Bridge Plugin       │   │
│  │  (code.js)                   │   │
│  │  - Accesses Figma Plugin API │   │
│  │  - Gets component.description│   │
│  │  - Gets variables data       │   │
│  └──────────┬───────────────────┘   │
│             │ postMessage           │
│  ┌──────────▼───────────────────┐   │
│  │  Plugin UI (ui.html)         │   │
│  │  - window.requestComponentData│   │
│  │  - window.__figmaVariablesData│   │
│  └──────────┬───────────────────┘   │
└─────────────┼───────────────────────┘
              │ Puppeteer access
   ┌──────────▼──────────────┐
   │  FigmaDesktopConnector   │
   │  (figma-desktop-connector.ts) │
   └──────────┬──────────────┘
              │
   ┌──────────▼──────────────┐
   │  figma-tools.ts         │
   │  (MCP Tool Layer)        │
   └─────────────────────────┘
```

**Key Insight:** The Desktop Bridge plugin has access to `node.description` and `node.descriptionMarkdown` via the Figma Plugin API, which are NOT available through the REST API.

## Decision Tree: Getting Component Descriptions

```
User asks for component description
  │
  ▼
Is Desktop Bridge plugin running?
  ├─ YES → Use figma_get_component
  │         ├─ Returns description ✓
  │         └─ Response includes: source: "desktop_bridge_plugin"
  │
  └─ NO → Use figma_get_component anyway
            ├─ Attempts Desktop Bridge
            ├─ Falls back to REST API
            └─ Response includes:
                - source: "rest_api"
                - warning: "description may be missing"
                - action_required: instructions to run Desktop Bridge
```

### How to Verify Desktop Bridge is Running

Check console logs for:
```
🌉 [Desktop Bridge] Plugin loaded and ready
🌉 [Desktop Bridge] Ready to handle component requests
```

## Common Anti-Patterns (AVOID THESE)

### ❌ Anti-Pattern 1: Tool Hopping

```
WRONG:
1. Try figma_get_component (Figma console MCP)
2. No description returned
3. Switch to mcp__figma-official__get_design_context
4. Still missing data
5. Try mcp__playwright__browser_evaluate
```

```
CORRECT:
1. Use figma_get_component (Figma console MCP)
2. Check response.source field
3. If source == "rest_api", instruct user to run Desktop Bridge plugin
4. User runs plugin
5. Retry figma_get_component
```

### ❌ Anti-Pattern 2: Using Playwright for Data Retrieval

```
WRONG:
mcp__playwright__browser_evaluate to query Figma data
```

```
CORRECT:
figma_get_component (handles browser interaction internally)
```

### ❌ Anti-Pattern 3: Assuming REST API Has All Data

```
WRONG:
Assuming figma_get_component will always return description
```

```
CORRECT:
Check response.source:
- "desktop_bridge_plugin" = reliable description
- "rest_api" = description may be missing due to Figma API limitations
```

## Tool Selection Flow Chart

```
User Request: "Get component description"
  │
  ▼
[Analyze Request]
  ├─ Is it about Figma data? ────────► YES
  │                                    │
  │                                    ▼
  │                         [Use Figma Console MCP]
  │                                    │
  │                                    ├─ Component metadata? → figma_get_component
  │                                    ├─ File structure? → figma_get_file_data
  │                                    ├─ Variables/tokens? → figma_get_variables
  │                                    ├─ Styles? → figma_get_styles
  │                                    └─ Visual reference? → figma_get_component_image
  │
  └─ NO → Use appropriate MCP
           (Serena, Context7, etc.)
```

## Response Interpretation Guide

### figma_get_component Response Patterns

#### Pattern 1: Desktop Bridge Success
```json
{
  "fileKey": "abc123",
  "nodeId": "729:229",
  "component": {
    "id": "729:229",
    "name": "Banner",
    "description": "A banner component for displaying notifications",
    "descriptionMarkdown": "**Banner** component\n- Supports 4 variants",
    ...
  },
  "source": "desktop_bridge_plugin",
  "enriched": false,
  "note": "Retrieved via Desktop Bridge plugin - description fields are reliable and current"
}
```

**Interpretation:** ✓ Description is reliable and current

#### Pattern 2: REST API Fallback
```json
{
  "fileKey": "abc123",
  "nodeId": "729:229",
  "component": {
    "id": "729:229",
    "name": "Banner",
    // description field missing or null
    ...
  },
  "source": "rest_api",
  "enriched": false,
  "warning": "Retrieved via REST API - description field may be missing due to known Figma API bug",
  "action_required": "To get reliable component descriptions, run the Desktop Bridge plugin..."
}
```

**Interpretation:** ⚠ Description missing due to API limitations. Instruct user to run Desktop Bridge plugin.

## Troubleshooting Guide

### Issue: Component Description Not Returned

**Diagnosis Steps:**

1. Check the response `source` field
   - `"desktop_bridge_plugin"` = Desktop Bridge was used successfully
   - `"rest_api"` = Fell back to REST API

2. If `source == "rest_api"`, check logs for Desktop Bridge errors:
   ```
   "Desktop Bridge plugin failed, falling back to REST API"
   ```

3. Common causes:
   - Desktop Bridge plugin not running in Figma Desktop
   - Browser/Puppeteer not connected
   - Plugin UI iframe not accessible
   - `browserManager` or `ensureInitialized` not available

**Resolution:**
```
1. Instruct user to open Figma Desktop
2. Right-click → Plugins → Development → Figma Desktop Bridge
3. Wait for console log: "🌉 [Desktop Bridge] Ready to handle component requests"
4. Retry figma_get_component
```

### Issue: Tool Returns Incomplete Data

**DO:**
- Check tool description to ensure it's the right tool for the task
- Verify all required parameters are provided
- Check response for `warning` or `action_required` fields

**DO NOT:**
- Immediately switch to a different MCP
- Use Playwright to "fix" missing data
- Assume the tool is broken

## Best Practices

### 1. Single MCP Principle
Stay within Figma console MCP for all Figma operations unless explicitly failing.

### 2. Response Analysis
Always check response metadata:
- `source` field indicates data origin
- `warning` field indicates known limitations
- `action_required` field provides user instructions

### 3. User Communication
When Desktop Bridge is required:
```
Clear Instructions:
"To get the component description, please run the Desktop Bridge plugin:
1. Open Figma Desktop
2. Right-click in the canvas
3. Plugins → Development → Figma Desktop Bridge
4. Wait for the green 'Desktop Bridge active' message
5. Then I'll retrieve the description for you"
```

### 4. Error Handling
```typescript
// Check response structure
if (response.source === "rest_api" && !response.component.description) {
  // Provide clear guidance instead of trying alternative tools
  return "Component description requires Desktop Bridge plugin...";
}
```

## Integration with Other Tools

### When to Use Other MCPs

| Scenario | Use This MCP |
|----------|-------------|
| TypeScript/React code analysis | Serena MCP |
| Up-to-date library documentation | Context7 MCP |
| Complex decision-making | Sequential Thinking MCP |
| Figma data retrieval | **Figma Console MCP (THIS)** |

### Never Use These for Figma Data

- ❌ Playwright MCP for querying Figma data
- ❌ WebFetch for Figma REST API calls
- ❌ Bash for calling Figma CLI tools
- ❌ Direct browser automation for Desktop Bridge access

## Quick Reference

### Component Description Workflow

```
flowchart TD
    A[User asks for component description] --> B[Use figma_get_component]
    B --> C{Check response.source}
    C -->|desktop_bridge_plugin| D[✓ Return description]
    C -->|rest_api| E[Instruct user to run Desktop Bridge]
    E --> F[User runs plugin]
    F --> B
```

### Tool Selection Matrix

| User Request | Tool | Reason |
|--------------|------|--------|
| "Get Banner component description" | `figma_get_component` | Direct component metadata access |
| "Show me variables" | `figma_get_variables` | Specialized for design tokens |
| "What's the file structure?" | `figma_get_file_data` | Optimized for structure exploration |
| "Generate code for this component" | `figma_get_component_for_development` | Includes implementation context |
| "Show component preview" | `figma_get_component_image` | Renders visual output |

## Conclusion

The Figma console MCP is a comprehensive, well-architected system with proper fallbacks and clear error messaging. **Stay within this MCP** for all Figma operations. Tool-hopping to other MCPs or Playwright creates unnecessary complexity and often fails to solve the underlying issue.

When in doubt:
1. Use the appropriate Figma console MCP tool
2. Check the response metadata
3. Follow action_required instructions
4. Trust the tool's fallback mechanisms

Do NOT hop to other MCPs or try to "work around" the tool with browser automation.
