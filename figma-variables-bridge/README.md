# Figma Variables Bridge

A Figma plugin that bridges the Variables API to MCP (Model Context Protocol) clients without requiring an Enterprise plan.

## Overview

This plugin enables AI assistants like Claude Code and Claude Desktop to access your Figma variables through the MCP protocol. It bypasses Figma's plugin sandbox restrictions by using a plugin UI iframe as a data bridge.

## Architecture

```
Figma Plugin Worker → postMessage → Plugin UI Iframe → window object → Puppeteer → MCP Server
```

**Key Features:**
- ✅ No Enterprise plan required
- ✅ Access all local variables and collections
- ✅ Supports multiple variable modes
- ✅ Persistent connection (stays open until closed)
- ✅ Clean, minimal UI
- ✅ Real-time data updates

## Installation

### Quick Install (Recommended)

1. **Open Figma Desktop**
2. **Go to Plugins → Development → Import plugin from manifest...**
3. **Navigate to:** `/path/to/figma-console-mcp/figma-variables-bridge/manifest.json`
4. **Click "Open"**

The plugin will appear in your Development plugins list as "Figma Variables Bridge".

### Manual Installation

Alternatively, you can install from the plugin directory:

```bash
# From the figma-console-mcp directory
cd figma-variables-bridge

# Figma will use these files:
# - manifest.json (plugin configuration)
# - code.js (plugin worker logic)
# - ui.html (plugin UI interface)
```

## Usage

### Running the Plugin

1. **Open your Figma file** with variables
2. **Run the plugin:** Right-click → Plugins → Development → Figma Variables Bridge
3. **Wait for confirmation:** Plugin UI will show "✓ Variables ready"

The plugin will:
- Fetch all local variables and collections
- Display count in the UI
- Store data in `window.__figmaVariablesData`
- Keep running until manually closed

### Accessing Variables via MCP

Once the plugin is running, MCP clients can access variables:

```typescript
// From Claude Code or Claude Desktop
figma_get_variables({
  format: "summary"  // or "filtered" or "full"
})
```

**Important:** Keep the plugin running while querying variables. The data is only available while the plugin UI is open.

## How It Works

### Plugin Worker (code.js)
1. Uses Figma's Variables API to fetch all local variables
2. Formats data with full mode values
3. Sends to UI via `postMessage`

### Plugin UI (ui.html)
1. Listens for `postMessage` from worker
2. Stores data on `window.__figmaVariablesData`
3. Sets `window.__figmaVariablesReady = true`
4. Displays status to user

### MCP Desktop Connector
1. Connects to Figma Desktop via remote debugging port (9222)
2. Enumerates plugin UI iframes
3. Evaluates JavaScript to check for data
4. Retrieves `window.__figmaVariablesData`

## Troubleshooting

### Plugin doesn't appear in menu
- Make sure Figma Desktop is running (not browser)
- Check that manifest.json path is correct
- Try **Plugins → Development → Refresh plugin list**

### "No plugin UI found with variables data"
- Ensure plugin is running (check for open plugin window)
- Try closing and reopening the plugin
- Check browser console for errors

### Variables not updating
- Close and reopen the plugin to refresh data
- Use `refreshCache: true` parameter in MCP call
- Check that you're viewing the correct Figma file

### Empty or outdated data
- Plugin fetches data on load - rerun plugin after making changes
- Cache TTL is 5 minutes - use `refreshCache: true` for immediate updates
- Ensure you're in the correct file (plugin reads current file's variables)

## Development

### File Structure
```
figma-variables-bridge/
├── manifest.json    # Plugin configuration
├── code.js          # Plugin worker (accesses Figma API)
├── ui.html          # Plugin UI (stores data for MCP access)
└── README.md        # This file
```

### Console Logging

The plugin logs to Figma's console:

```
🌉 [Variables Bridge] Plugin loaded and ready
🌉 [Variables Bridge] Fetching variables...
🌉 [Variables Bridge] Found 404 variables in 2 collections
🌉 [Variables Bridge] Data sent to UI successfully
🌉 [Variables Bridge] UI iframe now has variables data accessible via window.__figmaVariablesData
🌉 [Variables Bridge] Plugin will stay open until manually closed
```

View logs: **Plugins → Development → Open Console** (Cmd+Option+I on Mac)

## Security

- Plugin requires **no network access** (allowedDomains: ["none"])
- Data never leaves Figma Desktop
- Uses standard Figma Plugin API (no unofficial APIs)
- Read-only access (cannot modify variables)

## License

Part of the figma-console-mcp project.
