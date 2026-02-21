# Figma Desktop Bridge

A Figma plugin that bridges the Variables API and Component descriptions to MCP (Model Context Protocol) clients without requiring an Enterprise plan.

## Overview

This plugin enables AI assistants like Claude Code and Claude Desktop to access your Figma variables AND component descriptions through the MCP protocol. It bypasses both Figma's plugin sandbox restrictions and the REST API's component description bug.

## Architecture

The plugin communicates with the MCP server via WebSocket:

```
MCP Server ←WebSocket (ports 9223–9232)→ Plugin UI ←postMessage→ Plugin Worker → Figma API
```

As of v1.10.0, the server supports multi-instance operation — if port 9223 is already in use, it automatically falls back through ports 9224–9232. The plugin scans all ports and connects to every active server.

**Key Features:**
- ✅ No Enterprise plan required for variables
- ✅ Access all local variables and collections
- ✅ Reliable component descriptions (bypasses REST API bug)
- ✅ Supports multiple variable modes
- ✅ On-demand component data retrieval
- ✅ Persistent connection (stays open until closed)
- ✅ Clean, minimal UI
- ✅ Real-time data updates
- ✅ WebSocket transport — no debug flags needed
- ✅ Auto-reconnect on connection loss
- ✅ Multi-instance: connects to all active MCP servers simultaneously (v1.10.0)

## Installation

### Quick Install (Recommended)

1. **Open Figma Desktop**
2. **Go to Plugins → Development → Import plugin from manifest...**
3. **Navigate to:** `/path/to/figma-console-mcp/figma-desktop-bridge/manifest.json`
4. **Click "Open"**

The plugin will appear in your Development plugins list as "Figma Desktop Bridge".

### Manual Installation

Alternatively, you can install from the plugin directory:

```bash
# From the figma-console-mcp directory
cd figma-desktop-bridge

# Figma will use these files:
# - manifest.json (plugin configuration)
# - code.js (plugin worker logic)
# - ui.html (plugin UI interface)
```

## Usage

### Running the Plugin

1. **Open your Figma file** with variables and/or components
2. **Run the plugin:** Right-click → Plugins → Development → Figma Desktop Bridge
3. **Wait for confirmation:** Plugin UI will show "✓ Desktop Bridge active"

The plugin will:
- Fetch all local variables and collections on startup
- Display counts in the UI (e.g., "Variables: 404 in 2 collections")
- Store variables in `window.__figmaVariablesData`
- Provide on-demand component data via `window.requestComponentData(nodeId)`
- Keep running until manually closed

### Accessing Data via MCP

Once the plugin is running, MCP clients can access both variables and components:

**Variables (pre-loaded):**
```typescript
// From Claude Code or Claude Desktop
figma_get_variables({
  format: "summary"  // or "filtered" or "full"
})
```

**Components (on-demand):**
```typescript
// Request component with description
figma_get_component({
  fileUrl: "https://figma.com/design/YOUR_FILE_KEY",
  nodeId: "279:2861"
})
```

**Important:** Keep the plugin running while querying. Variables are pre-loaded, but component data is fetched on-demand when requested.

## How It Works

### Plugin Worker (code.js)

**On Startup (Variables):**
1. Uses Figma's Variables API to fetch all local variables
2. Formats data with full mode values
3. Sends to UI via `postMessage`

**On Request (Components):**
1. Listens for component requests via `figma.ui.onmessage`
2. Uses `figma.getNodeByIdAsync(nodeId)` to fetch component
3. Extracts description, descriptionMarkdown, and metadata
4. Sends response back to UI via `postMessage` with requestId

### Plugin UI (ui.html)

**Variables Flow:**
1. Listens for `VARIABLES_DATA` message from worker
2. Stores data on `window.__figmaVariablesData`
3. Sets `window.__figmaVariablesReady = true`
4. Displays status to user

**Components Flow:**
1. Exposes `window.requestComponentData(nodeId)` function
2. Returns a Promise that resolves when worker responds
3. Sends request to worker via `parent.postMessage()`
4. Resolves promise when `COMPONENT_DATA` message received
5. Includes 10-second timeout and error handling

### MCP Desktop Connector

**WebSocket Path (Preferred):**
1. MCP server starts WebSocket server on port 9223 (or next available port in range 9223–9232)
2. Plugin UI connects as WebSocket client
3. MCP server sends commands as JSON `{ id, method, params }`
4. Plugin UI routes to the same `window.*` handlers
5. Results sent back as `{ id, result }` or `{ id, error }`

## Troubleshooting

### Plugin doesn't appear in menu
- Make sure Figma Desktop is running (not browser)
- Check that manifest.json path is correct
- Try **Plugins → Development → Refresh plugin list**

### "No plugin UI found with variables data" or "No plugin UI found with requestComponentData"
- Ensure plugin is running (check for open plugin window showing "✓ Desktop Bridge active")
- Try closing and reopening the plugin
- Check browser console for errors (Plugins → Development → Open Console)

### Variables not updating
- Close and reopen the plugin to refresh data
- Use `refreshCache: true` parameter in MCP call
- Check that you're viewing the correct Figma file

### Component descriptions are empty or missing
- **First, verify in Figma:** Check if the component actually has a description set
- If using REST API fallback (not Desktop Bridge), descriptions may be missing due to known Figma API bug
- Ensure the plugin is running - component data requires active plugin connection
- Check that the nodeId is correct (format: "123:456")

### Component request times out
- Ensure plugin is running and shows "Desktop Bridge active"
- Check that the component exists in the current file
- Verify nodeId format is correct
- Timeout is set to 10 seconds - complex files may take longer

### WebSocket connection not working
- Verify the MCP server is running (it starts the WebSocket server on port 9223)
- Check that the plugin is open in Figma — the WebSocket client is in the plugin UI
- Check the browser console (Plugins > Development > Open Console) for `[MCP Bridge] WebSocket connected to port 9223`
- As of v1.10.0, multiple MCP servers can run simultaneously on different ports (9223–9232). If tools aren't working on a fallback port, re-import the plugin manifest to enable multi-port scanning.
- **Custom ports:** As of v1.10.0, the plugin scans ports 9223–9232 automatically. The `FIGMA_WS_PORT` env var sets the preferred starting port. Multi-instance support works out of the box within this range.

### Empty or outdated data
- Plugin fetches variables on load - rerun plugin after making variable changes
- Component data is fetched on-demand - always returns current state
- Cache TTL is 5 minutes for variables - use `refreshCache: true` for immediate updates
- Ensure you're in the correct file (plugin reads current file's data)

## Multi-Instance Support (v1.10.0)

The Desktop Bridge plugin supports connecting to **multiple MCP server instances** simultaneously. This is useful when:

- **Claude Desktop** runs both Chat and Code tabs (each spawns a separate MCP server)
- **Multiple CLI terminals** are running different projects with the MCP
- **Claude Desktop + Claude Code CLI** are used together

### How It Works

1. The MCP server tries port 9223 first. If it's taken, it falls back to 9224, 9225, etc. (up to 9232)
2. The plugin scans **all 10 ports** on startup and connects to every active server
3. All events (selection changes, document changes, variables, console logs) are **broadcast to every connected server**
4. Each server instance independently receives real-time data from Figma

### Important: One-Time Plugin Update

If you imported the Desktop Bridge plugin **before v1.10.0**, you need to re-import the manifest once to enable multi-port scanning:

1. In Figma: **Plugins → Development → Import plugin from manifest...**
2. Select the `manifest.json` file from the `figma-desktop-bridge` directory
3. Run the plugin — it will now scan all ports and connect to all servers

> **Why?** Figma caches plugin files at the application level. Simply restarting the plugin does NOT reload the code from disk. You must re-import the manifest to force Figma to pick up the new multi-port scanning logic.

Without re-importing, the old plugin code only connects to port 9223. If your server fell back to a different port, the plugin won't find it.

## Development

### File Structure
```
figma-desktop-bridge/
├── manifest.json    # Plugin configuration
├── code.js          # Plugin worker (accesses Figma API)
├── ui.html          # Plugin UI (stores/requests data for MCP access)
└── README.md        # This file
```

### Console Logging

The plugin logs to Figma's console:

**Variables (startup):**
```
🌉 [Desktop Bridge] Plugin loaded and ready
🌉 [Desktop Bridge] Fetching variables...
🌉 [Desktop Bridge] Found 404 variables in 2 collections
🌉 [Desktop Bridge] Variables data sent to UI successfully
🌉 [Desktop Bridge] UI iframe now has variables data accessible via window.__figmaVariablesData
```

**Components (on-demand):**
```
🌉 [Desktop Bridge] Fetching component: 279:2861
🌉 [Desktop Bridge] Component data ready. Has description: true
```

**Ready state:**
```
🌉 [Desktop Bridge] Ready to handle component requests
🌉 [Desktop Bridge] Plugin will stay open until manually closed
```

View logs: **Plugins → Development → Open Console** (Cmd+Option+I on Mac)

## Security

- Plugin network access limited to `localhost` only (for WebSocket bridge)
- Data never leaves the local machine
- Uses standard Figma Plugin API (no unofficial APIs)
- Component requests are scoped to current file only
- WebSocket bridge is local-only and unauthenticated — it relies on `localhost` binding for security. Multiple clients may be connected concurrently (one per Figma file). Do not expose the WebSocket port outside `localhost` (e.g., via port forwarding) on untrusted machines

## Why Desktop Bridge for Components?

Figma's REST API has a known bug where component `description` and `descriptionMarkdown` fields are often missing or outdated. This is particularly problematic for:

- **Local project components** (not published to team libraries)
- **Unpublished components** in active development
- **Team collaboration** where descriptions contain important usage guidelines

The Desktop Bridge plugin bypasses this limitation by using the Figma Plugin API (`figma.getNodeByIdAsync()`), which has reliable, real-time access to all component fields including descriptions. This makes it ideal for teams working with local components in shared project files.

## License

Part of the figma-console-mcp project.
