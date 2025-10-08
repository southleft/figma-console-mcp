# Figma Console MCP

> MCP server that enables AI coding assistants to access Figma plugin console logs and screenshots in real-time.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare)](https://workers.cloudflare.com/)
[![Live Demo](https://img.shields.io/badge/Demo-Live-success)](https://figma-console-mcp.southleft.com/health)

## Overview

Figma Console MCP is a [Model Context Protocol](https://modelcontextprotocol.io/) server that bridges AI coding assistants (like Claude Desktop and Cursor) to Figma's runtime environment. It enables autonomous debugging of Figma plugins by providing:

- **Real-time console log access** from Figma plugins and files
- **Automated screenshot capture** of Figma UI and plugins
- **Direct visibility** into Figma execution state
- **Zero-friction debugging** workflow (no copy-paste needed)
- **Dual deployment modes** - Local (for plugin development) or Cloud (for remote collaboration)

## Example Prompts

Once connected, try these prompts with your AI assistant:

### 🐛 Debugging & Console Monitoring
- "Navigate to my Figma plugin and show me any console errors"
- "Watch the console logs for 30 seconds while I test my plugin"
- "Get the last 20 console logs from https://figma.com/design/abc123"

### 📸 Visual Debugging
- "Take a screenshot of the current Figma canvas"
- "Navigate to this Figma file and capture what's on screen"
- "Show me what Figma looks like right now with a full-page screenshot"

### 🎨 Design System Extraction
- "Get all design variables from https://figma.com/design/abc123"
- "Extract color styles and show me the CSS exports"
- "Get the Button component data with a visual reference image"

### 🔄 Combined Workflows
- "Navigate to my design system file and extract all variables"
- "Get the Tooltip component and help me implement it in React"
- "Check console errors while I test my plugin, then take a screenshot"

### ✅ Quick Test
- "Navigate to https://www.figma.com and check the status"

## Quick Start

The fastest way to get started is using our public cloud server:

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["mcp-remote", "https://figma-console-mcp.southleft.com/sse"]
    }
  }
}
```

Add this to your MCP client config (see [Installation](#installation) for specific IDE locations), restart your client, and you're ready to go!

## Figma Console MCP vs. Figma Official Dev Mode MCP

Both MCPs connect AI assistants to Figma, but serve different purposes:

**Figma Console MCP (This Project)** - Runtime debugging & live monitoring
- ✅ Real-time console logs from Figma plugins
- ✅ Screenshot capture and visual debugging
- ✅ Error stack traces and runtime state
- ✅ Raw design data extraction (JSON)
- ✅ Works with both Figma Desktop (local) and web (cloud)

**Figma Official Dev Mode MCP** - Code generation from designs
- ✅ Generates React/HTML code from Figma designs
- ✅ Tailwind/CSS class generation
- ✅ Component boilerplate scaffolding
- ❌ No console access or debugging features

### When to Use Each

**Use Figma Console MCP** when developing or debugging Figma plugins, extracting design system data, or investigating runtime errors.

**Use Figma Official MCP** when converting Figma designs into frontend code.

**Use both together** for the complete workflow: generate code with Official MCP, then debug and refine with Console MCP.

## Installation

### Cloud Mode (Recommended for Quick Start)

Connect to the public server - no local setup required.

<details>
<summary><b>Claude Desktop</b></summary>

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["mcp-remote", "https://figma-console-mcp.southleft.com/sse"]
    }
  }
}
```

**After editing:**
1. Save the file
2. Quit Claude Desktop completely
3. Restart Claude Desktop
4. Look for "🔌" indicator showing MCP servers connected
5. All 14 Figma tools should be available

</details>

<details>
<summary><b>Claude Code (VS Code Extension)</b></summary>

**One-line install:**

```bash
claude mcp add --transport sse figma-console https://figma-console-mcp.southleft.com/sse
```

**Verify:**
- Use `/mcp` command in Claude Code
- Should show "figma-console: connected"

**See [CLAUDE_CODE_SETUP.md](docs/CLAUDE_CODE_SETUP.md) for troubleshooting.**

</details>

<details>
<summary><b>Cursor</b></summary>

**Location:** `.cursor/mcp.json` in your project or `~/.cursor/mcp.json` globally

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://figma-console-mcp.southleft.com/sse"]
    }
  }
}
```

**After editing:** Restart Cursor. Tools available via Composer or Chat.

</details>

<details>
<summary><b>Cline (VS Code Extension)</b></summary>

**Location:** VS Code Settings → Cline → MCP Settings

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://figma-console-mcp.southleft.com/sse"]
    }
  }
}
```

</details>

<details>
<summary><b>Zed</b></summary>

**Location:** `~/.config/zed/settings.json`

```json
{
  "assistant": {
    "version": "2",
    "provider": {
      "name": "anthropic",
      "mcp_servers": {
        "figma-console": {
          "command": "npx",
          "args": ["-y", "mcp-remote", "https://figma-console-mcp.southleft.com/sse"]
        }
      }
    }
  }
}
```

</details>

<details>
<summary><b>Continue (VS Code/JetBrains)</b></summary>

**Location:** `~/.continue/config.json`

```json
{
  "mcpServers": [
    {
      "name": "figma-console",
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://figma-console-mcp.southleft.com/sse"]
    }
  ]
}
```

</details>

<details>
<summary><b>Cloudflare AI Playground</b></summary>

1. Go to https://playground.ai.cloudflare.com/
2. Click "Add MCP Server"
3. Enter: `https://figma-console-mcp.southleft.com/sse`
4. Start using Figma tools in the playground!

</details>

<details>
<summary><b>Other IDEs</b></summary>

Most MCP-compatible clients use similar configuration formats. The key details are:

- **Command:** `npx`
- **Args:** `["-y", "mcp-remote", "https://figma-console-mcp.southleft.com/sse"]`

Check your IDE's MCP configuration documentation for the exact location and format.

</details>

---

### Local Mode (For Plugin Development)

<details>
<summary><b>Local Mode Setup - Instant Console Log Capture</b></summary>

Perfect for developing Figma plugins with instant console log access from Figma Desktop.

**Prerequisites:**
- Figma Desktop installed
- Node.js >= 18.0.0
- FIGMA_ACCESS_TOKEN (optional, for API access)

**Step 1: Clone and build**

```bash
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp
npm install
npm run build:local
```

**Step 2: Launch Figma with debugging**

**macOS:**
```bash
./scripts/launch-figma-debug.sh
```

Or manually:
```bash
open -a "Figma" --args --remote-debugging-port=9222
```

**Windows:**
```bash
start figma://--remote-debugging-port=9222
```

**Linux:**
```bash
figma --remote-debugging-port=9222
```

**Step 3: Enable Developer VM in Figma**

In Figma Desktop:
1. Open **Plugins → Development**
2. Enable **"Use Developer VM"**

This ensures plugin code runs in a monitored environment.

**Step 4: Configure your MCP client**

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "node",
      "args": ["/absolute/path/to/figma-console-mcp/dist/local.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_your_token_here",
        "FIGMA_DEBUG_PORT": "9222",
        "FIGMA_DEBUG_HOST": "localhost"
      }
    }
  }
}
```

**Important:** Replace `/absolute/path/to/figma-console-mcp` with your actual path!

**Other MCP clients:** Same configuration, but check your client's MCP configuration location.

**Step 5: Test connection**

```bash
# Verify Figma debug port is accessible
curl http://localhost:9222/json/version
```

You should see JSON with browser version info.

In your MCP client:
- Look for "🔌" indicator or MCP connection status
- All 14 Figma tools should be available
- Test with: "Navigate to https://www.figma.com and check status"

**Environment Variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `FIGMA_ACCESS_TOKEN` | - | Your Figma API token (optional, for API tools) |
| `FIGMA_DEBUG_HOST` | `localhost` | Debug host for Figma Desktop |
| `FIGMA_DEBUG_PORT` | `9222` | Debug port for Figma Desktop |

**Troubleshooting:**

**Error: "Failed to connect to Figma Desktop"**
1. Verify Figma Desktop is running
2. Check it was launched with `--remote-debugging-port=9222`
3. Test port: `curl http://localhost:9222/json/version`
4. Ensure no firewall is blocking port 9222

**Error: "No console logs captured"**
1. Enable "Use Developer VM" in Figma (Plugins → Development)
2. Make sure your plugin is actually running
3. Navigate to a Figma file with your plugin active
4. Check `figma_get_status` - should show `consoleMonitor.isMonitoring: true`

**Key Benefits:**
- ✅ Native Console Log Capture - Directly captures plugin console logs via Chrome DevTools Protocol
- ✅ Zero Latency - No network round trips, instant response
- ✅ Free - No Cloudflare costs, runs entirely on your machine
- ✅ Live Debugging - Monitor console logs in real-time as your plugin executes
- ✅ Perfect for Development - Ideal workflow for plugin development and testing

</details>

---

### Self-Hosted Cloud Mode

<details>
<summary><b>Deploy Your Own Cloudflare Workers Instance</b></summary>

[![Deploy to Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/southleft/figma-console-mcp)

Or via CLI:

```bash
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp
npm install
npm run deploy
```

**Requirements:**
- Cloudflare account (free or paid)
- Wrangler CLI (installed via `npm install`)
- `@cloudflare/puppeteer@^1.0.4` (already in package.json)

**Browser Rendering API:**
- Free tier: 10 min/day, 3 concurrent browsers
- Paid tier: 10 hours/month, then $0.09/browser hour
- Automatically available on Cloudflare Workers

</details>

---

## Testing Your Setup

After connecting to any MCP client, try this workflow:

```
1. Ask: "Navigate to https://www.figma.com and check the status"
   → Should call figma_navigate() and figma_get_status()

2. Ask: "What console logs are there?"
   → Should call figma_get_console_logs()

3. Ask: "Take a screenshot"
   → Should call figma_take_screenshot()
```

All tools should execute successfully. If you see errors, check:
- Your MCP client configuration is correct
- The server URL is exactly: `https://figma-console-mcp.southleft.com/sse`
- You've restarted your MCP client after config changes

## Available Tools

All 14 tools are **fully functional** and tested in **both local and cloud modes**. The tools provide identical functionality regardless of deployment mode.

> **Note on Local Mode:** In local mode, console logs are captured automatically from your running Figma Desktop plugins via Chrome DevTools Protocol.

### Quick Reference

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

### Detailed Documentation

#### 🧭 Navigation & Status Tools

##### `figma_navigate`
Navigate to any Figma URL to start monitoring.

```javascript
figma_navigate({
  url: 'https://www.figma.com/design/abc123/My-Design?node-id=1-2'
})
```

**Always use this first** to initialize the browser and start console monitoring.

##### `figma_get_status`
Check browser and monitoring status.

```javascript
figma_get_status()
```

Returns:
- Browser running state
- Current URL
- Log count and buffer info
- Initialization state

---

#### 📋 Console Monitoring Tools

##### `figma_get_console_logs`
Retrieve console logs from Figma.

```javascript
figma_get_console_logs({
  count: 50,           // Number of recent logs (default: 100)
  level: 'error',      // Filter: 'log', 'info', 'warn', 'error', 'debug', 'all'
  since: 1234567890    // Unix timestamp (optional)
})
```

Returns logs with:
- Timestamp
- Log level
- Message and arguments
- Source (plugin vs Figma)
- Stack traces (for errors)

##### `figma_watch_console`
Stream console logs in real-time for a specified duration.

```javascript
figma_watch_console({
  duration: 30,    // Seconds to watch
  level: 'all'     // Log level filter
})
```

Returns logs captured during the watch period with real-time monitoring.

##### `figma_clear_console`
Clear the console log buffer.

```javascript
figma_clear_console()
```

---

#### 🔍 Debugging Tools

##### `figma_take_screenshot`
Capture screenshots of Figma UI.

```javascript
figma_take_screenshot({
  target: 'full-page',  // 'plugin', 'full-page', 'viewport'
  format: 'png',        // 'png' or 'jpeg'
  quality: 90           // JPEG quality (0-100)
})
```

Returns base64-encoded image data.

##### `figma_reload_plugin`
Reload the current Figma page.

```javascript
figma_reload_plugin({
  clearConsole: true  // Clear logs before reload
})
```

---

#### 🎨 Design System Extraction Tools

> **Note:** These tools require a Figma access token. See [FIGMA_API_SETUP.md](docs/FIGMA_API_SETUP.md) for setup instructions.

These tools use the Figma REST API to extract design data, variables, components, and styles directly from Figma files.

**🎯 Tool Selection Guide:**

**For UI Component Development:**
- Use `figma_get_component_for_development` - Get component with visual reference image + styling data
- Use `figma_get_component_image` - Get just the component image for visual reference

**For Plugin Development:**
- Use `figma_get_file_for_plugin` - Get file structure with plugin data, IDs, relationships
- Higher depth allowed (max 5) since visual bloat is filtered out

**For General Use:**
- Use `figma_get_file_data` - Flexible general-purpose tool with verbosity control

---

##### `figma_get_component_for_development`
**🎨 Optimized for UI Component Implementation**

Get complete component data for building UI components, with automatic visual reference image.

```javascript
figma_get_component_for_development({
  fileUrl: 'https://www.figma.com/design/abc123/My-File',  // Optional if already navigated
  nodeId: '695:313',      // Component node ID (from URL: ?node-id=695-313)
  includeImage: true      // Include rendered image for visual reference (default: true)
})
```

**Returns:**
- **Visual Reference:** Rendered PNG image (2x scale) displayed directly to AI
- **Layout Properties:** Bounds, constraints, auto-layout (padding, spacing, alignment)
- **Visual Styling:** Fills, strokes, effects, opacity, corner radius, blend modes
- **Typography:** Font styles, character data, text formatting
- **Component System:** Properties, variants, definitions
- **Hierarchy:** Complete children structure

**Excludes:** Plugin data, document-level bloat

**Use Case:** When AI needs to implement a component like tooltip, button, card, etc.

---

##### `figma_get_file_for_plugin`
**🔌 Optimized for Plugin Development**

Get file structure focused on plugin-relevant data with minimal visual bloat.

```javascript
figma_get_file_for_plugin({
  fileUrl: 'https://www.figma.com/design/abc123/My-File',  // Optional if already navigated
  depth: 3,              // Levels of children to include (default: 2, max: 5)
  nodeIds: ['123:456']   // Optional: specific nodes only
})
```

**Returns:**
- **Navigation:** IDs, names, types, children hierarchy
- **Plugin Data:** pluginData, sharedPluginData (CRITICAL for plugins)
- **Component Relationships:** componentId, mainComponent, instanceOf
- **Structure:** visible, locked, lightweight bounds (x, y, width, height)
- **Text Content:** characters for text nodes

**Excludes:** Detailed visual properties, full style definitions

**Use Case:** When building Figma plugins that need to traverse, query, or manipulate the document.

---

##### `figma_get_component_image`
**📸 Just the Image**

Get only the rendered component image for quick visual reference.

```javascript
figma_get_component_image({
  fileUrl: 'https://www.figma.com/design/abc123/My-File',  // Optional if already navigated
  nodeId: '695:313',  // Component node ID
  scale: 2,          // Image scale (0.01-4, default: 2)
  format: 'png'      // 'png', 'jpg', 'svg', 'pdf' (default: png)
})
```

**Returns:**
- Image URL (expires in 30 days)
- Metadata (fileKey, nodeId, scale, format)

**Use Case:** Quick visual reference without component data overhead.

---

##### `figma_get_file_data`
**⚙️ General Purpose with Verbosity Control**

Get file structure with flexible verbosity levels for different needs.

```javascript
figma_get_file_data({
  fileUrl: 'https://www.figma.com/design/abc123/My-File',  // Optional if already navigated
  depth: 2,           // Levels of children (default: 1, max: 3 to prevent context exhaustion)
  verbosity: 'standard',  // 'summary', 'standard', 'full' (default: 'standard')
  nodeIds: ['123:456'],   // Optional: specific nodes only
  enrich: true        // Optional: Add statistics, health metrics (default: false)
})
```

**Verbosity Levels:**
- **`summary`** (~90% smaller): IDs, names, types only - good for exploration
- **`standard`** (~50% smaller): Essential properties for plugins - good for most use cases
- **`full`** (no reduction): Everything - use sparingly to avoid context exhaustion

**Returns:**
- File name, version, last modified date
- Document tree (filtered by verbosity level)
- Component and style counts
- Node metadata (if nodeIds specified)
- **When enriched:** File statistics, health scores, design system audit results

**Use Case:** When specialized tools don't fit your needs, or you need custom verbosity control.

---

##### `figma_get_variables`
Get design tokens and variables from Figma with optional enrichment and console fallback.

```javascript
figma_get_variables({
  fileUrl: 'https://www.figma.com/design/abc123/My-File',  // Optional if already navigated
  includePublished: true,  // Include published library variables (default: true)
  enrich: true,           // Optional: Add resolved values, dependencies, usage analysis (default: false)
  include_usage: true,    // Optional: Include usage in styles and components (requires enrich=true)
  include_dependencies: true,  // Optional: Include variable dependency graph (requires enrich=true)
  include_exports: true,  // Optional: Include export format examples (requires enrich=true)
  export_formats: ['css', 'tailwind']  // Optional: Specify export formats (default: all formats)
})
```

**Returns:**
- Local variables (colors, numbers, strings, booleans)
- Variable collections with modes
- Published library variables
- Summary with counts by type
- **When enriched:** Resolved values, dependency graphs, usage analysis, code export examples

**Console Fallback:** If Variables API returns 403 (Enterprise plan required), the tool automatically provides a JavaScript snippet that users can run in Figma's plugin console to extract variables. This is a two-step process:
1. First call returns the snippet to run
2. After running the snippet, call again with `parseFromConsole: true` to retrieve the data

---

##### `figma_get_component`
Get specific component data and properties with optional enrichment.

```javascript
figma_get_component({
  fileUrl: 'https://www.figma.com/design/abc123/My-File',  // Optional if already navigated
  nodeId: '123:456',  // Component node ID (from URL: ?node-id=123-456)
  enrich: true        // Optional: Add token coverage analysis and hardcoded value detection (default: false)
})
```

**Returns:**
- Component name, type, and ID
- Component property definitions (variants, boolean props, etc.)
- Children structure
- Bounds, fills, strokes, effects
- **When enriched:** Design token coverage metrics, hardcoded value analysis, component quality scores

**Tip:** Get node IDs from Figma URLs. For example, `?node-id=123-456` means nodeId is `'123:456'`.

---

##### `figma_get_styles`
Get color, text, and effect styles from file with optional enrichment.

```javascript
figma_get_styles({
  fileUrl: 'https://www.figma.com/design/abc123/My-File',  // Optional if already navigated
  enrich: true,           // Optional: Add resolved values and export formats (default: false)
  include_usage: true,    // Optional: Include component usage information (requires enrich=true)
  include_exports: true,  // Optional: Include export format examples (requires enrich=true)
  export_formats: ['css', 'sass', 'tailwind']  // Optional: Specify export formats (default: all formats)
})
```

**Returns:**
- All color, text, and effect styles
- Style names, descriptions, and types
- Total style count
- **When enriched:** Resolved values, usage analysis, CSS/Sass/Tailwind export examples

---

### Combined Workflow Examples

**Debug plugin with actual Figma data:**
```javascript
// 1. Navigate to file
figma_navigate({ url: 'https://www.figma.com/design/abc123/My-Design-System' })

// 2. Get all design tokens
figma_get_variables()

// 3. Get specific component properties
figma_get_component({ nodeId: '123:456' })

// 4. Check console for errors
figma_get_console_logs({ level: 'error' })

// AI can now correlate:
// - What variables exist in Figma
// - What your plugin is trying to use
// - Any errors that occurred
```

**Extract design system data:**
```javascript
// Get all variables and styles
figma_get_variables()
figma_get_styles()

// Get specific component metadata
figma_get_component({ nodeId: '5:123' })

// Get file structure
figma_get_file_data({ depth: 2 })
```

**Extract enriched design system with export formats:**
```javascript
// Get variables with full enrichment and export formats
figma_get_variables({
  enrich: true,
  export_formats: ['css', 'tailwind'],
  include_dependencies: true
})

// Get styles with CSS/Sass/Tailwind exports
figma_get_styles({
  enrich: true,
  export_formats: ['css', 'sass', 'tailwind']
})

// Analyze component token coverage
figma_get_component({
  nodeId: '123:456',
  enrich: true
})
```

## Use Cases

### Autonomous Plugin Debugging

Let AI assistants debug your Figma plugins without manual intervention:

```
1. AI navigates: figma_navigate({ url: '...' })
2. AI reads code and makes changes
3. Plugin executes in Figma → logs captured automatically
4. AI checks: figma_get_console_logs({ level: 'error' })
5. AI analyzes errors and fixes code
6. AI reloads: figma_reload_plugin()
7. Loop continues until plugin works
```

### Error Investigation

```javascript
// Navigate to your Figma file
figma_navigate({ url: 'https://www.figma.com/design/...' })

// Check for errors
figma_get_console_logs({ level: 'error', count: 10 })

// Take screenshot of current state
figma_take_screenshot({ target: 'full-page' })

// AI correlates visual state with errors
```

### Visual Debugging

```javascript
// Get current status
figma_get_status()

// Capture UI state
figma_take_screenshot({ target: 'plugin' })

// Get logs from same timeframe
figma_get_console_logs({ count: 20 })
```

## Architecture

### How It Works

Figma Console MCP uses a **dual-mode architecture** with shared core logic and mode-specific browser managers.

**Local Mode:**
```
AI Assistant → MCP Server (Node.js) → puppeteer-core →
Chrome DevTools Protocol → Figma Desktop → Your Plugin
```

**Cloud Mode:**
```
AI Assistant → mcp-remote → MCP Server (Cloudflare Workers) →
Browser Rendering API → Chrome → Figma Web → Your Plugin
```

### Deployment Modes

| Mode | Best For | Latency | Browser | Setup Complexity |
|------|----------|---------|---------|------------------|
| **Local** | Plugin development, debugging | ~10ms | Your Figma Desktop | Low (run script) |
| **Cloud** | Remote collaboration, production | ~50-200ms | Cloudflare Browser API | Medium (deploy once) |

**Use Local Mode when:**
- Developing Figma plugins locally
- You need instant console log capture from running plugins
- You want zero network latency
- You're debugging plugin code in real-time

**Use Cloud Mode when:**
- Working remotely or collaborating with teams
- You need access from multiple machines
- You want a persistent debugging endpoint
- You're deploying for production use

**Both modes provide the same 14 MCP tools** - the only difference is where the browser runs.

### Core Components

#### Shared Core (Runtime-Agnostic)

All core debugging and API logic is shared between modes:

```
src/core/
  ├── console-monitor.ts   # Console log capture via Chrome DevTools Protocol
  ├── figma-api.ts        # Figma REST API client
  ├── figma-tools.ts      # MCP tool registration (tools 8-14)
  ├── config.ts           # Configuration with mode detection
  └── logger.ts           # Structured logging (Pino)
```

#### Browser Managers

Each mode has its own browser implementation:

```
src/browser/
  ├── base.ts             # IBrowserManager interface
  ├── local.ts            # LocalBrowserManager (puppeteer-core)
  └── cloudflare.ts       # CloudflareBrowserManager (@cloudflare/puppeteer)
```

**Local Mode (`LocalBrowserManager`):**
- Uses `puppeteer-core` to connect to existing browser
- Connects to `localhost:9222` (Chrome Remote Debugging Protocol)
- No browser launch overhead
- Direct access to Figma Desktop

**Cloud Mode (`CloudflareBrowserManager`):**
- Uses `@cloudflare/puppeteer` to launch browser
- Runs on Cloudflare Browser Rendering API
- Manages browser lifecycle
- Navigates to Figma web URLs

### Entry Points

- **`src/local.ts`** - Local mode entry point
  - StdioServerTransport for MCP communication
  - Registers all 14 tools
  - Connects to Figma Desktop

- **`src/index.ts`** - Cloud mode entry point
  - McpAgent pattern for SSE/HTTP transport
  - Durable Objects for session persistence
  - Registers all 14 tools

### Key Technologies

**Local Mode:**
- `puppeteer-core` - Connect to existing browser
- `@modelcontextprotocol/sdk` - MCP server (stdio)
- Chrome DevTools Protocol - Console monitoring

**Cloud Mode:**
- `@cloudflare/puppeteer` - Browser Rendering API
- `@cloudflare/agents` - McpAgent pattern
- Durable Objects - Session persistence
- SSE (Server-Sent Events) - Remote MCP transport

**Shared:**
- Circular buffer for efficient log storage (1000 logs)
- Pino logger for structured logging
- Zod for schema validation
- TypeScript for type safety

**See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed technical documentation.**

## Development

### Prerequisites

- Node.js >= 18
- For Cloud Mode: Cloudflare account and Wrangler CLI

### Setup

```bash
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp
npm install
```

### Commands

**Local Mode Development:**
```bash
# Watch mode with auto-reload
npm run dev:local

# Build local mode only
npm run build:local

# Run local mode (after building)
node dist/local.js
```

**Cloud Mode Development:**
```bash
# Cloudflare Workers dev server (localhost:8787)
npm run dev

# Build cloud mode only
npm run build:cloudflare

# Deploy to Cloudflare Workers
npm run deploy
```

**Both Modes:**
```bash
# Build both modes
npm run build

# Type checking
npm run type-check

# Format code
npm run format

# Lint and fix
npm run lint:fix
```

### Testing Local Mode

```bash
# 1. Launch Figma Desktop with debugging
./scripts/launch-figma-debug.sh

# 2. Build and run local server
npm run build:local
node dist/local.js

# 3. Test in another terminal
curl http://localhost:9222/json/version  # Should show browser info
```

Configure Claude Desktop with local mode (see [Installation](#installation)).

### Testing Cloud Mode

```bash
# Start Cloudflare Workers dev server
npm run dev

# In another terminal, test endpoints:
curl http://localhost:8787/health
curl http://localhost:8787/test-browser
```

**Connect Claude Desktop to local cloud dev server:**
```json
{
  "mcpServers": {
    "figma-console-dev": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:8787/sse"]
    }
  }
}
```

## Troubleshooting

### "Browser isn't currently running"

**Solution:** Always call `figma_navigate()` first to initialize the browser.

```javascript
// ✅ Correct workflow
figma_navigate({ url: 'https://www.figma.com/design/...' })
figma_get_console_logs()

// ❌ Wrong - will fail
figma_get_console_logs()  // No browser initialized
```

### "Connection timed out"

**Cause:** First call to `figma_navigate()` can take 10-30 seconds (browser launch + Figma load).

**Solution:** Wait patiently. Subsequent calls will be much faster.

### No console logs captured

**Possible causes:**
1. Plugin hasn't executed yet
2. Logs are filtered out (try `level: 'all'`)
3. Timing issue (wait after navigation)

**Solution:**
```javascript
figma_navigate({ url: '...' })
// Wait a moment for page to load
figma_get_status()  // Check log count
figma_get_console_logs({ level: 'all' })
```

### Tools not showing in MCP client

**Solutions:**
1. Verify server URL exactly: `https://figma-console-mcp.southleft.com/sse`
2. Check MCP config file syntax (valid JSON)
3. Restart your MCP client completely
4. Check client logs for connection errors

See [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for comprehensive guide.

## Advanced Topics

### Cloudflare Workers Costs

Browser Rendering API pricing:

**Free Tier:**
- 10 minutes of browser time per day
- 3 concurrent browser sessions
- Perfect for development and testing
- **$0/month**

**Paid Tier (if you exceed free tier):**
- 10 hours of browser time included
- Unlimited concurrent browsers
- $0.09 per browser hour after included allowance
- Billing starts August 20, 2025
- **Typical usage: $5-10/month**

Workers Paid plan ($5/month) required only if you exceed free Workers limits (100k requests/day).

### Project Structure

```
figma-console-mcp/
├── src/
│   ├── core/                    # Shared core logic (both modes)
│   │   ├── console-monitor.ts   # Console log capture via CDP
│   │   ├── figma-api.ts         # Figma REST API client
│   │   ├── figma-tools.ts       # Figma API MCP tools (8-14)
│   │   ├── config.ts            # Configuration with mode detection
│   │   ├── logger.ts            # Pino logging
│   │   └── types/
│   │       └── index.ts         # TypeScript types
│   ├── browser/                 # Browser manager implementations
│   │   ├── base.ts              # IBrowserManager interface
│   │   ├── local.ts             # LocalBrowserManager (puppeteer-core)
│   │   └── cloudflare.ts        # CloudflareBrowserManager (@cloudflare/puppeteer)
│   ├── local.ts                 # Local mode entry point (stdio MCP)
│   ├── index.ts                 # Cloud mode entry point (McpAgent)
│   └── test-browser.ts          # Browser Rendering API diagnostics
├── scripts/
│   └── launch-figma-debug.sh    # Launch Figma with debugging (macOS)
├── dist/                        # Build output
│   ├── local.js                 # Local mode build
│   └── cloudflare/              # Cloud mode build
│       └── index.js
├── docs/                        # Documentation
│   ├── ARCHITECTURE.md          # Technical architecture details
│   ├── CLAUDE_CODE_SETUP.md     # Claude Code setup guide
│   ├── DUAL_MODE_SETUP.md       # Dual mode setup guide
│   ├── FIGMA_API_SETUP.md       # Figma API tools setup
│   ├── PHASE3_SUMMARY.md        # Phase 3 implementation details
│   ├── PRODUCT_PLAN.md          # Product roadmap and planning
│   ├── ROADMAP.md               # Feature roadmap
│   └── TROUBLESHOOTING.md       # Common issues and solutions
├── tsconfig.json                # Base TypeScript config
├── tsconfig.local.json          # Local mode build config
├── tsconfig.cloudflare.json     # Cloud mode build config
├── wrangler.jsonc               # Cloudflare Workers config
├── package.json                 # Dependencies and scripts
├── biome.json                   # Linter/formatter config
└── README.md                    # This file
```

## Roadmap

✅ **Phase 1 (v0.1.0):** Infrastructure & Cloudflare Workers deployment
✅ **Phase 2 (v0.2.0):** All 7 debugging tools implemented and tested
✅ **Phase 2.5 (v0.2.5):** Figma API data extraction tools (8-14) - Variables, Components, Styles
✅ **Phase 3 (v0.3.0):** Local MCP server mode with dual-mode architecture
✅ **Phase 4 (v0.4.0):** Console monitoring with `figma_watch_console` and real-time log capture
📋 **Phase 5 (v1.0.0):** Advanced features (custom filters, log persistence, plugin interaction)

### What's New in Phase 4 (Current)

- **✅ Working console monitoring:** All 14 tools fully functional and tested
- **Real-time log capture:** Native console monitoring via Chrome DevTools Protocol
- **Dual-mode architecture:** Local (stdio) and Cloud (SSE) modes both working
- **Local browser manager:** Connect to Figma Desktop via Chrome Remote Debugging Protocol
- **Shared core logic:** Identical tool behavior across both modes
- **Launch scripts:** Easy setup for macOS with `launch-figma-debug.sh`
- **Zero latency debugging:** Native console log capture from running plugins

See [ROADMAP.md](docs/ROADMAP.md) for complete timeline and [PHASE3_SUMMARY.md](docs/PHASE3_SUMMARY.md) for implementation details.

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests and linting (`npm run type-check && npm run lint:fix`)
5. Commit changes (`git commit -m 'Add amazing feature'`)
6. Push to branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

## License

MIT License - see [LICENSE](LICENSE) for details.

## Support & Resources

### Documentation
- [Architecture Documentation](docs/ARCHITECTURE.md)
- [Dual Mode Setup Guide](docs/DUAL_MODE_SETUP.md)
- [Troubleshooting Guide](docs/TROUBLESHOOTING.md)
- [Figma API Setup](docs/FIGMA_API_SETUP.md)

### Community
- [Issue Tracker](https://github.com/southleft/figma-console-mcp/issues)
- [Discussions](https://github.com/southleft/figma-console-mcp/discussions)

### Related Projects
- [Model Context Protocol](https://modelcontextprotocol.io/) - Protocol specification and SDK
- [Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-rendering/) - Browser automation on Workers
- [Figma Plugin API](https://www.figma.com/plugin-docs/) - Official Figma plugin documentation
- [mcp-remote](https://www.npmjs.com/package/mcp-remote) - Remote MCP proxy for SSE transport
- [puppeteer-core](https://github.com/puppeteer/puppeteer) - Headless Chrome Node.js API
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) - Remote debugging protocol

### Acknowledgments

Built with:
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/sdk) - MCP server and transport
- [Cloudflare Workers](https://workers.cloudflare.com/) - Serverless edge platform (cloud mode)
- [@cloudflare/puppeteer](https://github.com/cloudflare/puppeteer) - Browser automation (cloud mode)
- [puppeteer-core](https://github.com/puppeteer/puppeteer) - Chrome DevTools Protocol (local mode)
- [Anthropic Claude](https://claude.ai/) - AI assistant integration
- [TypeScript](https://www.typescriptlang.org/) - Type-safe development
- [Zod](https://github.com/colinhacks/zod) - Schema validation
- [Pino](https://github.com/pinojs/pino) - Structured logging

---

**Made for Figma plugin developers and AI enthusiasts**

**Dual-mode deployment:** Run locally or deploy to Cloudflare Workers ⚡

**Live cloud demo:** [figma-console-mcp.southleft.com](https://figma-console-mcp.southleft.com)
