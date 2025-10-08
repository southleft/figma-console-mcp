# Available Tools - Detailed Documentation

All 14 tools work identically in both cloud and local modes. This guide provides detailed documentation for each tool.

## Quick Reference

| Category | Tool | Purpose |
|----------|------|---------|
| **🧭 Navigation** | `figma_navigate` | Open a Figma URL and start monitoring |
| | `figma_get_status` | Check browser and monitoring status |
| **📋 Console** | `figma_get_console_logs` | Retrieve console logs with filters |
| | `figma_watch_console` | Stream logs in real-time |
| | `figma_clear_console` | Clear log buffer |
| **🔍 Debugging** | `figma_take_screenshot` | Capture UI screenshots |
| | `figma_reload_plugin` | Reload current page |
| **🎨 Design System** | `figma_get_variables` | Extract design tokens/variables |
| | `figma_get_styles` | Get color, text, effect styles |
| | `figma_get_component` | Get component data |
| | `figma_get_component_for_development` | Component + visual reference |
| | `figma_get_component_image` | Just the component image |
| | `figma_get_file_data` | File structure with verbosity control |
| | `figma_get_file_for_plugin` | File data optimized for plugins |

---

## 🧭 Navigation & Status Tools

### `figma_navigate`

Navigate to any Figma URL to start monitoring.

**Usage:**
```javascript
figma_navigate({
  url: 'https://www.figma.com/design/abc123/My-Design?node-id=1-2'
})
```

**Always use this first** to initialize the browser and start console monitoring.

**Returns:**
- Navigation status
- Current URL
- Console monitoring status

---

### `figma_get_status`

Check browser and monitoring status. **In local mode, also validates if Figma Desktop is running with the required `--remote-debugging-port=9222` flag.**

**Usage:**
```javascript
figma_get_status()
```

**Returns:**
- **Setup validation** (local mode only):
  - `setup.valid` - Whether Figma Desktop is running with debug flag
  - `setup.message` - Human-readable status
  - `setup.setupInstructions` - Step-by-step setup guide (if invalid)
  - `setup.ai_instruction` - Guidance for AI assistants
- Browser connection status
- Console monitoring active/inactive
- Current URL (if navigated)
- Number of captured console logs

**Example Response (Local Mode - Setup Valid):**
```json
{
  "mode": "local",
  "setup": {
    "valid": true,
    "message": "✅ Figma Desktop is running with remote debugging enabled"
  }
}
```

**Example Response (Local Mode - Setup Invalid):**
```json
{
  "mode": "local",
  "setup": {
    "valid": false,
    "message": "❌ Figma Desktop is NOT running with --remote-debugging-port=9222",
    "setupInstructions": {
      "step1": "QUIT Figma Desktop completely",
      "step2_macOS": "open -a \"Figma\" --args --remote-debugging-port=9222",
      "step2_windows": "start figma://--remote-debugging-port=9222"
    },
    "ai_instruction": "CRITICAL: User must restart Figma with the debug flag"
  }
}
```

**Best Practice:**
- Call this tool first when starting a debugging session in local mode
- If `setup.valid` is false, guide user through setup before using console tools

---

## 📋 Console Tools (Plugin Debugging)

### `figma_get_console_logs`

> **💡 Plugin Developers in Local Mode**: This tool works immediately - no navigation required!
> Just check logs, run your plugin in Figma Desktop, check logs again. All `[Main]`, `[Swapper]`, etc. plugin logs appear instantly.

Retrieve console logs with filters.

**Usage:**
```javascript
figma_get_console_logs({
  count: 50,           // Number of logs to retrieve (default: 100)
  level: 'error',      // Filter by level: 'log', 'info', 'warn', 'error', 'debug', 'all'
  since: 1234567890    // Unix timestamp (ms) - only logs after this time
})
```

**Parameters:**
- `count` (optional): Number of recent logs to retrieve (default: 100)
- `level` (optional): Filter by log level (default: 'all')
- `since` (optional): Unix timestamp in milliseconds - only logs after this time

**Returns:**
- Array of console log entries with:
  - `timestamp`: Unix timestamp (ms)
  - `level`: 'log', 'info', 'warn', 'error', 'debug'
  - `message`: The log message
  - `args`: Additional arguments passed to console method
  - `stackTrace`: Stack trace (for errors)

**Example:**
```javascript
// Get last 20 error logs
figma_get_console_logs({ count: 20, level: 'error' })

// Get all logs from last 30 seconds
const thirtySecondsAgo = Date.now() - (30 * 1000);
figma_get_console_logs({ since: thirtySecondsAgo })
```

---

### `figma_watch_console`

Stream console logs in real-time for a specified duration.

**Usage:**
```javascript
figma_watch_console({
  duration: 30,        // Watch for 30 seconds (default: 30, max: 300)
  level: 'all'         // Filter by level (default: 'all')
})
```

**Parameters:**
- `duration` (optional): How long to watch in seconds (default: 30, max: 300)
- `level` (optional): Filter by log level (default: 'all')

**Returns:**
- Real-time stream of console logs captured during the watch period
- Summary of total logs captured by level

**Use case:** Perfect for monitoring console output while you test your plugin manually.

---

### `figma_clear_console`

Clear the console log buffer.

**Usage:**
```javascript
figma_clear_console()
```

**Returns:**
- Confirmation of buffer cleared
- Number of logs that were cleared

---

## 🔍 Debugging Tools

### `figma_take_screenshot`

Capture screenshots of Figma UI.

**Usage:**
```javascript
figma_take_screenshot({
  target: 'plugin',           // 'plugin', 'full-page', or 'viewport'
  format: 'png',              // 'png' or 'jpeg'
  quality: 90,                // JPEG quality 0-100 (default: 90)
  filename: 'my-screenshot'   // Optional filename
})
```

**Parameters:**
- `target` (optional): What to screenshot
  - `'plugin'`: Just the plugin UI (default)
  - `'full-page'`: Entire scrollable page
  - `'viewport'`: Current visible viewport
- `format` (optional): Image format (default: 'png')
- `quality` (optional): JPEG quality 0-100 (default: 90)
- `filename` (optional): Custom filename

**Returns:**
- Screenshot image
- Metadata (dimensions, format, size)

---

### `figma_reload_plugin`

Reload the current Figma page.

**Usage:**
```javascript
figma_reload_plugin({
  clearConsole: true   // Clear console logs before reload (default: true)
})
```

**Returns:**
- Reload status
- New page URL (if changed)

---

## 🎨 Design System Tools

> **⚠️ All Design System tools require `FIGMA_ACCESS_TOKEN`** configured in your MCP client.
>
> See [Installation Guide](../README.md#step-2-add-your-figma-access-token-for-design-system-tools) for setup instructions.

### `figma_get_variables`

Extract design tokens/variables from a Figma file.

**Usage:**
```javascript
figma_get_variables({
  fileUrl: 'https://figma.com/design/abc123',
  includePublished: true,                        // Include published library variables
  enrich: true,                                  // Add CSS/Tailwind exports
  export_formats: ['css', 'tailwind', 'sass'],   // Export formats
  include_usage: true,                           // Show where variables are used
  include_dependencies: true                     // Show variable dependencies
})
```

**Parameters:**
- `fileUrl` (optional): Figma file URL (uses current if navigated)
- `includePublished` (optional): Include published variables (default: true)
- `enrich` (optional): Add exports and usage analysis (default: false)
- `export_formats` (optional): Code formats to generate
- `include_usage` (optional): Include usage in styles/components
- `include_dependencies` (optional): Include dependency graph

**Returns:**
- Variable collections
- Variables with modes and values
- Summary statistics
- Export code (if `enrich: true`)
- Usage information (if `include_usage: true`)

**Note:** Figma Variables API requires Enterprise plan. If unavailable, the tool automatically falls back to Styles API or console-based extraction.

---

### `figma_get_styles`

Get all styles (color, text, effects) from a Figma file.

**Usage:**
```javascript
figma_get_styles({
  fileUrl: 'https://figma.com/design/abc123',
  enrich: true,                                  // Add code exports
  export_formats: ['css', 'tailwind'],           // Export formats
  include_usage: true,                           // Show component usage
  include_exports: true                          // Include code examples
})
```

**Parameters:**
- `fileUrl` (optional): Figma file URL
- `enrich` (optional): Add exports and usage (default: false)
- `export_formats` (optional): Code formats to generate
- `include_usage` (optional): Show where styles are used
- `include_exports` (optional): Include code examples

**Returns:**
- All styles (color, text, effect, grid)
- Style metadata and properties
- Export code (if `enrich: true`)
- Usage information (if requested)

---

### `figma_get_component`

Get component metadata and properties.

**Usage:**
```javascript
figma_get_component({
  fileUrl: 'https://figma.com/design/abc123',
  nodeId: '123:456',
  enrich: true   // Add token coverage analysis
})
```

**Parameters:**
- `fileUrl` (optional): Figma file URL
- `nodeId` (required): Component node ID (e.g., '123:456')
- `enrich` (optional): Add quality metrics (default: false)

**Returns:**
- Component metadata
- Properties and variants
- Bounds and layout info
- Token coverage (if `enrich: true`)

---

### `figma_get_component_for_development`

Get component data optimized for UI implementation, with visual reference.

**Usage:**
```javascript
figma_get_component_for_development({
  fileUrl: 'https://figma.com/design/abc123',
  nodeId: '695:313',
  includeImage: true   // Include rendered image (default: true)
})
```

**Parameters:**
- `fileUrl` (optional): Figma file URL
- `nodeId` (required): Component node ID
- `includeImage` (optional): Include rendered image (default: true)

**Returns:**
- Component image (rendered at 2x scale)
- Filtered component data with:
  - Layout properties (auto-layout, padding, spacing)
  - Visual properties (fills, strokes, effects)
  - Typography
  - Component properties and variants
  - Bounds and positioning

**Excludes:** Plugin data, document metadata (optimized for UI implementation)

---

### `figma_get_component_image`

Render a component as an image only.

**Usage:**
```javascript
figma_get_component_image({
  fileUrl: 'https://figma.com/design/abc123',
  nodeId: '695:313',
  scale: 2,              // Image scale (0.01-4, default: 2)
  format: 'png'          // 'png', 'jpg', 'svg', 'pdf'
})
```

**Parameters:**
- `fileUrl` (optional): Figma file URL
- `nodeId` (required): Node ID to render
- `scale` (optional): Scale factor (default: 2)
- `format` (optional): Image format (default: 'png')

**Returns:**
- Image URL (expires after 30 days)
- Image metadata

---

### `figma_get_file_data`

Get file structure with verbosity control.

**Usage:**
```javascript
figma_get_file_data({
  fileUrl: 'https://figma.com/design/abc123',
  depth: 2,                  // Levels of children (0-3, default: 1)
  verbosity: 'standard',     // 'summary', 'standard', 'full'
  nodeIds: ['123:456'],      // Specific nodes only (optional)
  enrich: true               // Add file statistics and health metrics
})
```

**Parameters:**
- `fileUrl` (optional): Figma file URL
- `depth` (optional): Depth of children tree (max: 3)
- `verbosity` (optional): Data detail level
  - `'summary'`: IDs, names, types only (~90% smaller)
  - `'standard'`: Essential properties (~50% smaller)
  - `'full'`: Everything
- `nodeIds` (optional): Retrieve specific nodes only
- `enrich` (optional): Add statistics and metrics

**Returns:**
- File metadata
- Document tree (filtered by verbosity)
- Component/style counts
- Statistics (if `enrich: true`)

---

### `figma_get_file_for_plugin`

Get file data optimized for plugin development.

**Usage:**
```javascript
figma_get_file_for_plugin({
  fileUrl: 'https://figma.com/design/abc123',
  depth: 3,                  // Higher depth allowed (max: 5)
  nodeIds: ['123:456']       // Specific nodes (optional)
})
```

**Parameters:**
- `fileUrl` (optional): Figma file URL
- `depth` (optional): Depth of children (max: 5, default: 2)
- `nodeIds` (optional): Specific nodes only

**Returns:**
- Filtered file data with:
  - IDs, names, types
  - Plugin data (pluginData, sharedPluginData)
  - Component relationships
  - Lightweight bounds
  - Structure for navigation

**Excludes:** Visual properties (fills, strokes, effects) - optimized for plugin work

---

## Tool Comparison

### When to Use Each Tool

**For Component Development:**
- `figma_get_component_for_development` - Best for implementing UI components (includes image + layout data)
- `figma_get_component_image` - Just need a visual reference
- `figma_get_component` - Need full component metadata

**For Plugin Development:**
- `figma_get_file_for_plugin` - Optimized file structure for plugins
- `figma_get_console_logs` - Debug plugin code
- `figma_watch_console` - Monitor plugin execution

**For Design System Extraction:**
- `figma_get_variables` - Design tokens with code exports
- `figma_get_styles` - Traditional styles with code exports
- `figma_get_file_data` - Full file structure with verbosity control

**For Debugging:**
- `figma_get_console_logs` - Retrieve specific logs
- `figma_watch_console` - Live monitoring
- `figma_take_screenshot` - Visual debugging
- `figma_get_status` - Check connection health

---

## Error Handling

All tools return structured error responses:

```json
{
  "error": "Error message",
  "message": "Human-readable description",
  "hint": "Suggestion for resolution"
}
```

Common errors:
- `"FIGMA_ACCESS_TOKEN not configured"` - Set up your token (see installation guide)
- `"Failed to connect to browser"` - Browser initializing or connection issue
- `"Invalid Figma URL"` - Check URL format
- `"Node not found"` - Verify node ID is correct

See [Troubleshooting Guide](TROUBLESHOOTING.md) for detailed solutions.
