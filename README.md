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

## Figma Console MCP vs. Figma Official Dev Mode MCP

Both MCPs connect AI assistants to Figma, but serve **completely different purposes**:

| Feature | **Figma Console MCP** (This Plugin) | **Figma Official Dev Mode MCP** |
|---------|-------------------------------------|--------------------------------|
| **Primary Purpose** | **Runtime debugging & live monitoring** | **Code generation from designs** |
| **What it returns** | Console logs, errors, runtime state, design data | React/HTML code with Tailwind classes |
| **Best for** | Plugin development, debugging, data extraction | Converting designs to frontend code |
| **Console access** | ✅ Real-time log capture via Chrome DevTools Protocol | ❌ No console access |
| **Error debugging** | ✅ Stack traces, warnings, runtime errors | ❌ No debugging info |
| **Screenshot capture** | ✅ Automated UI screenshots | ❌ No screenshot capability |
| **Design variables** | ✅ Raw variable data (JSON) | ✅ As CSS/Tailwind tokens in code |
| **Component data** | ✅ Full component metadata and properties | ✅ As React component code |
| **File structure** | ✅ Complete node tree with metadata | ✅ As component structure in code |
| **Live monitoring** | ✅ Watch console logs in real-time | ❌ Not available |
| **Deployment** | Local (instant) or Cloud (remote) | Figma Desktop only |

### When to Use Each

**Use Figma Console MCP when you need to:**
- **Debug Figma plugins** - See console.log(), errors, and warnings from your plugin code
- **Monitor runtime behavior** - Watch what happens when your plugin executes
- **Extract design system data** - Get variables, components, and styles as raw JSON
- **Investigate errors** - Get stack traces and error context
- **Develop plugins locally** - Zero-latency console log capture from Figma Desktop
- **Automate debugging** - Let AI assistants debug your plugin code autonomously

**Use Figma Official Dev Mode MCP when you need to:**
- **Convert designs to code** - Generate React components from Figma designs
- **Implement UI from mockups** - Get starter code with Tailwind classes
- **Scaffold components** - Quick component boilerplate generation
- **Extract design tokens as code** - Variables rendered as CSS/Tailwind values

### Can They Work Together?

**Yes!** They're complementary:

1. **Use Figma Official MCP** to generate initial component code from designs
2. **Use Figma Console MCP** to:
   - Debug that generated code when integrated into your app
   - Extract the actual variable values as JSON for your design token system
   - Monitor console logs when the component runs
   - Verify the component matches design specs via screenshots

### Example: Design System Workflow

```javascript
// 1. Use Figma Official MCP to generate component code
// → Returns: React component with Tailwind classes
<div className="bg-[#4375ff] px-[12px] py-[8px] rounded-[6px]">
  <p className="text-[#000b29] text-[16px]">Label</p>
</div>

// 2. Use Figma Console MCP to get actual design tokens
figma_get_variables()
// → Returns: { "color/background/primary-default": "#4375FF", ... }

// 3. Replace hardcoded values with design tokens
<Button color="primary" size="medium">Label</Button>

// 4. Use Figma Console MCP to debug the integrated component
figma_watch_console({ duration: 10 })
// → See console logs: "Button rendered with variant: primary"
```

### Key Insight

**Figma Official MCP** gives you **code** (what to build).
**Figma Console MCP** gives you **runtime insight** (how it's working).

If you're building a design system or developing Figma plugins, you'll benefit from **both**. The Figma Official MCP generates your initial implementation, while Figma Console MCP helps you debug, validate, and extract the underlying data.

### 🚀 The Cheat Code: Using Both MCPs Together

Running **both MCPs simultaneously** is like having a superpower for Figma development:

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["mcp-remote", "https://figma-console-mcp.southleft.com/sse"]
    },
    "figma-dev-mode": {
      "command": "npx",
      "args": ["-y", "@figma/mcp-server-figma"]
    }
  }
}
```

**The workflow becomes magical:**

1. **AI generates component code** (Figma Official MCP)
   ```typescript
   // AI creates: <Button /> with Tailwind classes
   ```

2. **You integrate it into your app**
   ```typescript
   import { Button } from './components/Button'
   ```

3. **AI monitors and debugs it live** (Figma Console MCP)
   ```javascript
   figma_watch_console({ duration: 10 })
   // → Sees: "Button rendered", "onClick triggered", etc.
   ```

4. **AI extracts actual design tokens** (Figma Console MCP)
   ```javascript
   figma_get_variables()
   // → Returns: { "color/button/primary": "#4375FF" }
   ```

5. **AI refactors to use design tokens**
   ```typescript
   // Before: className="bg-[#4375ff]"
   // After:  color="primary"
   ```

**Result:** AI can autonomously build, test, debug, and refine components using real design system data - all without you leaving your editor. It's the fastest way to go from Figma design to production-ready code.

## Architecture Overview

Figma Console MCP supports **two deployment modes** that provide identical functionality with different trade-offs:

| Mode | Best For | Latency | Browser | Setup Complexity |
|------|----------|---------|---------|------------------|
| **Local** | Plugin development, debugging | ~10ms | Your Figma Desktop | Low (run script) |
| **Cloud** | Remote collaboration, production | ~50-200ms | Cloudflare Browser API | Medium (deploy once) |

### When to Use Each Mode

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

**Both modes provide the same 11 MCP tools** - the only difference is where the browser runs.

## Live Demo

**Production server:** https://figma-console-mcp.southleft.com

Try the diagnostic test: [https://figma-console-mcp.southleft.com/test-browser](https://figma-console-mcp.southleft.com/test-browser)

## Quick Start

Choose the deployment mode that fits your workflow:

### Option 1: Local Mode (Plugin Development)

Perfect for developing Figma plugins with instant console log access.

**Prerequisites:**
- Figma Desktop installed
- Node.js >= 18.0.0
- FIGMA_ACCESS_TOKEN (optional, for API access)

**Step 1: Launch Figma Desktop with remote debugging**

We provide launch scripts for convenience:

**macOS:**
```bash
# Clone the repository first
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp
npm install

# Launch Figma with debugging enabled
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

**Step 2: Enable Developer VM in Figma**

In Figma Desktop:
1. Go to **Plugins → Development**
2. Enable **"Use Developer VM"**

This ensures plugin code runs in a monitored environment.

**Step 3: Build and configure**

```bash
# Build local mode
npm run build:local

# Add to Claude Desktop config (~/.config/Claude/claude_desktop_config.json):
{
  "mcpServers": {
    "figma-console": {
      "command": "node",
      "args": ["/absolute/path/to/figma-console-mcp/dist/local.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "your-token-here"
      }
    }
  }
}
```

**Step 4: Test**

Restart Claude Desktop and verify the connection:
- Look for "🔌" indicator
- All 11 Figma tools should be available
- Console logs from your running plugins are captured automatically!

See [Local Mode Setup](#local-mode-setup) for detailed configuration.

---

### Option 2: Remote/Cloud Mode (Public Server)

Connect directly to our hosted instance:

**Claude Desktop (`~/.config/Claude/claude_desktop_config.json`):**
```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://figma-console-mcp.southleft.com/sse"
      ]
    }
  }
}
```

**Cursor, Cline, Zed, etc:**
```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://figma-console-mcp.southleft.com/sse"
      ]
    }
  }
}
```

Restart your MCP client to see the 11 Figma tools become available.

### Option 3: Remote/Cloud Mode (Self-Hosted)

[![Deploy to Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/southleft/figma-console-mcp)

Or via command line:

```bash
# Clone and install
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp
npm install

# Deploy to Cloudflare Workers
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

## Local Mode Setup

Detailed setup for local plugin development with native console log capture.

### Prerequisites

1. **Figma Desktop** - Download from [figma.com/downloads](https://www.figma.com/downloads/)
2. **Node.js** >= 18.0.0
3. **FIGMA_ACCESS_TOKEN** - Optional for API access (get from [Figma settings](https://www.figma.com/developers/api#access-tokens))

### Step-by-Step Setup

**1. Clone and Install**

```bash
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp
npm install
```

**2. Build Local Mode**

```bash
npm run build:local
```

This builds to `dist/local.js` - the MCP server entry point.

**3. Launch Figma with Remote Debugging**

**Option A: Use our launch script (macOS)**

```bash
./scripts/launch-figma-debug.sh
```

This script will:
- Check if Figma is installed
- Quit Figma if already running
- Relaunch with `--remote-debugging-port=9222`
- Verify the debug port is accessible

**Option B: Manual launch**

**macOS:**
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

**4. Enable Developer VM**

In Figma Desktop:
1. Open **Plugins → Development**
2. Enable **"Use Developer VM"**

This ensures your plugin code runs in the Web Worker that we can monitor via Chrome DevTools Protocol.

**5. Configure MCP Client**

**Claude Desktop** (`~/.config/Claude/claude_desktop_config.json` or `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

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

**Other MCP Clients** (Cursor, Cline, etc.):

Same configuration, but check your client's MCP configuration location.

**6. Test Connection**

Restart your MCP client and verify:

```bash
# Verify Figma debug port is accessible
curl http://localhost:9222/json/version
```

You should see JSON with browser version info.

In your MCP client:
- Look for "🔌" indicator or MCP connection status
- All 11 Figma tools should be available
- Test with: "Navigate to https://www.figma.com and check status"

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FIGMA_ACCESS_TOKEN` | - | Your Figma API token (optional, for API tools) |
| `FIGMA_DEBUG_HOST` | `localhost` | Debug host for Figma Desktop |
| `FIGMA_DEBUG_PORT` | `9222` | Debug port for Figma Desktop |

### Troubleshooting Local Mode

**Error: "Failed to connect to Figma Desktop"**

1. Verify Figma Desktop is running
2. Check it was launched with `--remote-debugging-port=9222`
3. Test port: `curl http://localhost:9222/json/version`
4. Ensure no firewall is blocking port 9222
5. On macOS, try relaunching with the provided script

**Error: "No console logs captured"**

1. Enable "Use Developer VM" in Figma (Plugins → Development)
2. Make sure your plugin is actually running
3. Open Figma's developer console (Plugins → Development → Open Console) to verify logs appear there
4. Navigate to a Figma file with your plugin active
5. Check `figma_get_status` - should show `consoleMonitor.isMonitoring: true`

**Error: "FIGMA_ACCESS_TOKEN not configured"**

- This error only affects Figma API tools (8-11)
- Console logging and screenshots (tools 1-7) work without a token
- Get a token at: https://www.figma.com/developers/api#access-tokens

### Development Workflow

```bash
# Watch mode for development
npm run dev:local

# Type checking
npm run type-check

# Build both modes
npm run build
```

### Key Benefits of Local Mode

1. **Native Console Log Capture** - Directly captures plugin console logs via Chrome DevTools Protocol
2. **Zero Latency** - No network round trips, instant response
3. **Free** - No Cloudflare costs, runs entirely on your machine
4. **Live Debugging** - Monitor console logs in real-time as your plugin executes
5. **Perfect for Development** - Ideal workflow for plugin development and testing

## Available MCP Tools

All 11 tools are **fully functional** and tested in **BOTH local and cloud modes**. The tools provide identical functionality regardless of deployment mode.

> **Note on Local Mode:** In local mode, console logs are captured natively from your running Figma Desktop plugins via Chrome DevTools Protocol - this is the whole point of local mode! No need to navigate to Figma URLs for console monitoring; logs from your development plugins are captured automatically.

### Debugging & Navigation Tools (1-7)

#### `figma_navigate`
Navigate to any Figma URL to start monitoring.

```javascript
figma_navigate({
  url: 'https://www.figma.com/design/abc123/My-Design?node-id=1-2'
})
```

**Always use this first** to initialize the browser and start console monitoring.

#### `figma_get_console_logs`
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

#### `figma_take_screenshot`
Capture screenshots of Figma UI.

```javascript
figma_take_screenshot({
  target: 'full-page',  // 'plugin', 'full-page', 'viewport'
  format: 'png',        // 'png' or 'jpeg'
  quality: 90           // JPEG quality (0-100)
})
```

Returns base64-encoded image data.

#### `figma_get_status`
Check browser and monitoring status.

```javascript
figma_get_status()
```

Returns:
- Browser running state
- Current URL
- Log count and buffer info
- Initialization state

### Utility Tools

#### `figma_reload_plugin`
Reload the current Figma page.

```javascript
figma_reload_plugin({
  clearConsole: true  // Clear logs before reload
})
```

#### `figma_clear_console`
Clear the console log buffer.

```javascript
figma_clear_console()
```

#### `figma_watch_console`
Stream console logs in real-time for a specified duration.

```javascript
figma_watch_console({
  duration: 30,    // Seconds to watch
  level: 'all'     // Log level filter
})
```

Returns logs captured during the watch period with real-time monitoring.

---

### Figma Data Extraction Tools (8-14)

> **Note:** These tools require a Figma access token. See [FIGMA_API_SETUP.md](docs/FIGMA_API_SETUP.md) for setup instructions.

These tools use the Figma REST API to extract design data, variables, components, and styles directly from Figma files.

#### **🎯 Specialized Tools for Specific Workflows**

**For UI Component Development:**
- Use `figma_get_component_for_development` - Get component with visual reference image + styling data
- Use `figma_get_component_image` - Get just the component image for visual reference

**For Plugin Development:**
- Use `figma_get_file_for_plugin` - Get file structure with plugin data, IDs, relationships
- Higher depth allowed (max 5) since visual bloat is filtered out

**For General Use:**
- Use `figma_get_file_data` - Flexible general-purpose tool with verbosity control

---

#### `figma_get_component_for_development`
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

**Use Case:** When AI needs to implement a component like tooltip, button, card, etc. Provides everything needed to recreate the visual appearance accurately.

---

#### `figma_get_file_for_plugin`
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

**Use Case:** When building Figma plugins that need to traverse, query, or manipulate the document. Higher depth allowed since visual bloat is filtered out.

---

#### `figma_get_component_image`
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

#### `figma_get_file_data`
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

#### `figma_get_variables`
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

#### `figma_get_component`
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

#### `figma_get_styles`
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

## MCP Client Setup Guides

> **Claude Code users:** See [CLAUDE_CODE_SETUP.md](docs/CLAUDE_CODE_SETUP.md) for detailed setup and troubleshooting if you get "fetch failed" errors.

### Claude Desktop

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://figma-console-mcp.southleft.com/sse"
      ]
    }
  }
}
```

**After editing:**
1. Save the file
2. Quit Claude Desktop completely
3. Restart Claude Desktop
4. Look for "🔌" indicator showing MCP servers connected
5. All 11 Figma tools should be available

### Claude Code (VS Code Extension)

**One-line install:**

```bash
claude mcp add --transport sse figma-console https://figma-console-mcp.southleft.com/sse
```

**Verify:**
- Use `/mcp` command in Claude Code
- Should show "figma-console: connected"

**See [CLAUDE_CODE_SETUP.md](docs/CLAUDE_CODE_SETUP.md) for troubleshooting.**

### Cursor

**Location:** `.cursor/mcp.json` in your project or `~/.cursor/mcp.json` globally

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://figma-console-mcp.southleft.com/sse"
      ]
    }
  }
}
```

**After editing:**
1. Restart Cursor
2. Tools available via Composer or Chat

### Cline (VS Code Extension)

**Location:** VS Code Settings → Cline → MCP Settings

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://figma-console-mcp.southleft.com/sse"
      ]
    }
  }
}
```

### Zed

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
          "args": [
            "-y",
            "mcp-remote",
            "https://figma-console-mcp.southleft.com/sse"
          ]
        }
      }
    }
  }
}
```

### Continue (VS Code/JetBrains)

**Location:** `~/.continue/config.json`

```json
{
  "mcpServers": [
    {
      "name": "figma-console",
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://figma-console-mcp.southleft.com/sse"
      ]
    }
  ]
}
```

### Cloudflare AI Playground

1. Go to https://playground.ai.cloudflare.com/
2. Click "Add MCP Server"
3. Enter: `https://figma-console-mcp.southleft.com/sse`
4. Start using Figma tools in the playground!

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

## How It Works

### Local Mode Architecture

```
AI Assistant (Claude Desktop/Cursor/etc)
         ↓ MCP Protocol (stdio)
Figma Console MCP Server (Node.js)
         ↓ puppeteer-core
Chrome Remote Debugging (localhost:9222)
         ↓ Chrome DevTools Protocol
    Figma Desktop → Your Plugin
```

The local MCP server connects directly to your Figma Desktop application via Chrome Remote Debugging Protocol. It captures console logs natively from running plugins using Chrome DevTools Protocol.

### Cloud Mode Architecture

```
AI Assistant (Claude Desktop/Cursor/etc)
         ↓ MCP Protocol
    mcp-remote proxy
         ↓ SSE/HTTP
Figma Console MCP Server (Cloudflare Workers)
         ↓ Browser Rendering API
Chrome Browser (@cloudflare/puppeteer v1.0.4)
         ↓ Chrome DevTools Protocol
    Figma (web) → Your Plugin
```

The cloud MCP server runs on Cloudflare Workers and uses Browser Rendering API to control a headless Chrome instance. It monitors console events via Chrome DevTools Protocol and exposes Figma-specific debugging tools via MCP.

## Architecture

Figma Console MCP uses a **dual-mode architecture** with shared core logic and mode-specific implementations.

### Shared Core (Runtime-Agnostic)

All core debugging and API logic is shared between modes:

```
src/core/
  ├── console-monitor.ts   # Console log capture via Chrome DevTools Protocol
  ├── figma-api.ts        # Figma REST API client
  ├── figma-tools.ts      # MCP tool registration (tools 8-11)
  ├── config.ts           # Configuration with mode detection
  └── logger.ts           # Structured logging (Pino)
```

### Mode-Specific Browser Managers

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
  - Registers all 11 tools
  - Connects to Figma Desktop

- **`src/index.ts`** - Cloud mode entry point
  - McpAgent pattern for SSE/HTTP transport
  - Durable Objects for session persistence
  - Registers all 11 tools

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

### Build System

Separate TypeScript configurations for each mode:

- `tsconfig.local.json` - Builds to `dist/local.js`
- `tsconfig.cloudflare.json` - Builds to `dist/cloudflare/`

This prevents bundling wrong dependencies and optimizes each mode independently.

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) and [DUAL_MODE_SETUP.md](docs/DUAL_MODE_SETUP.md) for detailed technical documentation.

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

Configure Claude Desktop with local mode (see [Local Mode Setup](#local-mode-setup)).

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
      "args": [
        "mcp-remote",
        "http://localhost:8787/sse"
      ]
    }
  }
}
```

## Project Structure

```
figma-console-mcp/
├── src/
│   ├── core/                    # Shared core logic (both modes)
│   │   ├── console-monitor.ts   # Console log capture via CDP
│   │   ├── figma-api.ts         # Figma REST API client
│   │   ├── figma-tools.ts       # Figma API MCP tools (8-11)
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

## Cloudflare Workers Costs

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

## Roadmap

✅ **Phase 1 (v0.1.0):** Infrastructure & Cloudflare Workers deployment
✅ **Phase 2 (v0.2.0):** All 7 debugging tools implemented and tested
✅ **Phase 2.5 (v0.2.5):** Figma API data extraction tools (8-11) - Variables, Components, Styles
✅ **Phase 3 (v0.3.0):** Local MCP server mode with dual-mode architecture
✅ **Phase 4 (v0.4.0):** Console monitoring with `figma_watch_console` and real-time log capture
📋 **Phase 5 (v1.0.0):** Advanced features (custom filters, log persistence, plugin interaction)

### What's New in Phase 4 (Current)

- **✅ Working console monitoring:** All 11 tools fully functional and tested
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

## Related Projects

- [Model Context Protocol](https://modelcontextprotocol.io/) - Protocol specification and SDK
- [Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-rendering/) - Browser automation on Workers
- [Figma Plugin API](https://www.figma.com/plugin-docs/) - Official Figma plugin documentation
- [mcp-remote](https://www.npmjs.com/package/mcp-remote) - Remote MCP proxy for SSE transport
- [puppeteer-core](https://github.com/puppeteer/puppeteer) - Headless Chrome Node.js API
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) - Remote debugging protocol

## Support

- 📖 [Architecture Documentation](docs/ARCHITECTURE.md)
- 🏠 [Dual Mode Setup Guide](docs/DUAL_MODE_SETUP.md)
- 🐛 [Issue Tracker](https://github.com/southleft/figma-console-mcp/issues)
- 💬 [Discussions](https://github.com/southleft/figma-console-mcp/discussions)
- 🔧 [Troubleshooting Guide](docs/TROUBLESHOOTING.md)
- 🔑 [Figma API Setup](docs/FIGMA_API_SETUP.md)

## Acknowledgments

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
