# Figma Console MCP Server

[![MCP](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Model Context Protocol server** that provides AI assistants with **real-time console access, visual debugging, design system auditing, and data extraction** for Figma files and plugins.

## Overview

Figma Console MCP is a [Model Context Protocol](https://modelcontextprotocol.io/) server that connects AI assistants (like Claude) to Figma for:

- **🐛 Plugin debugging** - Capture console logs, errors, and stack traces from Figma plugins
- **📸 Visual debugging** - Take screenshots of Figma UI for context
- **🎨 Design system extraction** - Pull variables, components, styles, and file data
- **🔍 Design system auditing** - AI-powered quality checks, token coverage analysis, compliance reporting
- **⚡ Live monitoring** - Watch console logs in real-time as plugins execute
- **Zero-friction debugging** workflow (no copy-paste needed)
- **Dual deployment modes** - Local (for plugin development) or Cloud (for remote collaboration)

## Example Prompts

Once connected, try these prompts with your AI assistant:

### 🐛 Plugin Debugging

**Cloud Mode (Default - No Setup Required):**
- "Navigate to my Figma plugin and show me any console errors"
- "Watch the console logs for 30 seconds while I test my plugin"
- "Get the last 20 console logs from https://figma.com/design/abc123"

**Local Mode (For Plugin Development - Requires One-Time Setup):**

> **🚨 REQUIRED FIRST-TIME SETUP:**
>
> **Step 1:** Quit Figma Desktop completely (Cmd+Q / Alt+F4)
>
> **Step 2:** Relaunch Figma with remote debugging enabled:
> - **macOS:** Open Terminal and run:
>   ```bash
>   open -a "Figma" --args --remote-debugging-port=9222
>   ```
> - **Windows:** Open Command Prompt and run:
>   ```bash
>   start figma://--remote-debugging-port=9222
>   ```
>
> **Step 3:** Open your design file, run your plugin, then ask:
> - "Check the last 20 console logs"
> - "Show me recent error logs from my plugin"
> - "Watch for new console output"
>
> ✅ **You only need to do this setup once per Figma session.** Your logs will appear instantly!
>
> See [LOCAL_MODE_SETUP.md](LOCAL_MODE_SETUP.md) for detailed local mode installation.

### 📸 Visual Debugging
- "Take a screenshot of the current Figma canvas"
- "Navigate to this Figma file and capture what's on screen"
- "Show me what Figma looks like right now with a full-page screenshot"

### 🎨 Design System Extraction
- "Get all design variables from https://figma.com/design/abc123"
- "Extract color styles and show me the CSS exports"
- "Get the Button component data with a visual reference image"

### 🔍 Design System Auditing (NEW!)
- "Scan my design system file and give me a complete audit report"
- "Which components use hardcoded colors instead of design tokens?"
- "Show me variables that aren't being used anywhere"
- "Analyze my design system for naming consistency and compliance issues"

### 🔄 Combined Workflows
- "Navigate to my design system file and extract all variables"
- "Get the Tooltip component and help me implement it in React"
- "Check console errors while I test my plugin, then take a screenshot"

### ✅ Quick Test
- "Navigate to https://www.figma.com and check the status"

## Figma Console MCP vs. Figma Official Dev Mode MCP

Both MCPs connect AI assistants to Figma, but serve different purposes:

**Figma Console MCP (This Project)** - Debugging, auditing & data extraction
- ✅ Real-time console logs from Figma plugins
- ✅ Screenshot capture and visual debugging
- ✅ Error stack traces and runtime state
- ✅ Raw design data extraction (JSON)
- ✅ AI-powered design system auditing (like ESLint for Figma)
- ✅ Token coverage analysis and compliance reporting
- ✅ Works remotely via cloud or locally via Figma Desktop
- ✅ Component images for visual reference

**Figma Official Dev Mode MCP** - Code generation from designs
- ✅ Generates React/HTML code from Figma designs
- ✅ Tailwind/CSS class generation
- ✅ Component boilerplate scaffolding
- ✅ Works remotely (Figma recently added remote access)
- ✅ Component image export
- ❌ No console access or debugging features

### When to Use Each

Both MCPs can help with **component development**. Console MCP provides design specs as structured data, while Dev Mode MCP generates starter code.

**Use Figma Console MCP** when:
- Debugging Figma plugins (console logs, errors, runtime monitoring)
- Auditing design systems (token coverage, compliance, quality checks)
- Extracting design system data as JSON (variables, components, styles)
- You need visual debugging with screenshots
- Investigating runtime errors with stack traces
- Generating design system quality reports

**Use Figma Official MCP** when:
- Converting Figma designs into React/HTML code
- You want generated Tailwind classes and component boilerplate

**Use both together** for the complete workflow: generate code with Official MCP, then audit, debug and refine with Console MCP.

---

## Installation

Choose **Cloud Mode** or **Local Mode** (for plugin development):

### Cloud Mode

Zero-setup remote access. Works with all AI clients.

<details>
<summary><b>Claude Code</b></summary>

**One-line install:**

```bash
claude mcp add --transport sse figma-console https://figma-console-mcp.southleft.com/sse
```

**To add Figma token** (required for design system tools):

```bash
claude config edit
```

Add the environment variable:

```json
{
  "mcpServers": {
    "figma-console": {
      "transport": "sse",
      "url": "https://figma-console-mcp.southleft.com/sse",
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_your_actual_token_here"
      }
    }
  }
}
```

**Get your Figma token:** https://www.figma.com/developers/api#access-tokens

**Verify:**
- Use `/mcp` command in Claude Code
- Should show "figma-console: connected"

**See [CLAUDE_CODE_SETUP.md](docs/CLAUDE_CODE_SETUP.md) for troubleshooting.**

</details>

<details>
<summary><b>Cursor</b></summary>

**Location:** `.cursor/mcp.json` in your project or `~/.cursor/mcp.json` globally

**Without Figma token** (console/screenshots only):
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

**With Figma token** (full design system access):
```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://figma-console-mcp.southleft.com/sse"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_your_actual_token_here"
      }
    }
  }
}
```

**Get your Figma token:** https://www.figma.com/developers/api#access-tokens

**After editing:**
1. Save and restart Cursor
2. Check for MCP connection indicator
3. Test with a prompt like "Navigate to https://www.figma.com"

</details>

<details>
<summary><b>Windsurf</b></summary>

**Location:** Follow Windsurf's MCP configuration documentation

**Without Figma token** (console/screenshots only):
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

**With Figma token** (full design system access):
```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://figma-console-mcp.southleft.com/sse"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_your_actual_token_here"
      }
    }
  }
}
```

**Get your Figma token:** https://www.figma.com/developers/api#access-tokens

</details>

<details>
<summary><b>Zed</b></summary>

**Location:** `~/.config/zed/settings.json` (Linux/macOS) or `%APPDATA%\Zed\settings.json` (Windows)

**Without Figma token** (console/screenshots only):
```json
{
  "context_servers": {
    "figma-console": {
      "command": {
        "path": "npx",
        "args": ["mcp-remote", "https://figma-console-mcp.southleft.com/sse"]
      }
    }
  }
}
```

**With Figma token** (full design system access):
```json
{
  "context_servers": {
    "figma-console": {
      "command": {
        "path": "npx",
        "args": ["mcp-remote", "https://figma-console-mcp.southleft.com/sse"]
      },
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_your_actual_token_here"
      }
    }
  }
}
```

**Get your Figma token:** https://www.figma.com/developers/api#access-tokens

</details>

<details>
<summary><b>Claude Desktop</b></summary>

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

**Without Figma token** (console/screenshots only):
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

**With Figma token** (full design system access):
```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["mcp-remote", "https://figma-console-mcp.southleft.com/sse"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_your_actual_token_here"
      }
    }
  }
}
```

**Get your Figma token:** https://www.figma.com/developers/api#access-tokens

**After editing:**
1. Save the file
2. Quit Claude Desktop completely
3. Restart Claude Desktop
4. Look for "🔌" indicator showing MCP servers connected
5. All 14 Figma tools should be available

</details>

<details>
<summary><b>Other MCP Clients</b></summary>

**Without Figma token** (console/screenshots only):
```json
{
  "command": "npx",
  "args": ["mcp-remote", "https://figma-console-mcp.southleft.com/sse"]
}
```

**With Figma token** (full design system access):
```json
{
  "command": "npx",
  "args": ["mcp-remote", "https://figma-console-mcp.southleft.com/sse"],
  "env": {
    "FIGMA_ACCESS_TOKEN": "figd_your_actual_token_here"
  }
}
```

**Get your Figma token:** https://www.figma.com/developers/api#access-tokens

Consult your MCP client's documentation for the specific configuration file location.

</details>

---

### Local Mode (For Plugin Development)

Direct connection to Figma Desktop for zero-latency console logs.

> **⚠️ Requires:** One-time Figma restart with `--remote-debugging-port=9222` flag

**See full guide:** [LOCAL_MODE_SETUP.md](LOCAL_MODE_SETUP.md)

**Quick setup:**

1. **Quit Figma Desktop completely**
2. **Relaunch with debug flag:**
   - **macOS:** `open -a "Figma" --args --remote-debugging-port=9222`
   - **Windows:** `start figma://--remote-debugging-port=9222`
3. **Install local MCP server** (see [LOCAL_MODE_SETUP.md](LOCAL_MODE_SETUP.md))

---

### Test Your Connection

In your AI assistant, try:

```
Navigate to [your Figma file URL] and check the status
```

**Example:**
```
Navigate to https://figma.com/design/abc123/My-Design and check the status
```

You should see:
- Browser connected successfully
- Console monitoring active
- All 14 tools available

**If you added your Figma token**, also try:

```
Get design variables from https://figma.com/design/abc123
```

**Don't have a Figma file?** Try the basic test:
```
Navigate to https://www.figma.com and check the status
```

---

## Available Tools

All 14 tools work identically in both cloud and local modes.

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

> **📖 For detailed API documentation, parameters, and examples:** See [docs/TOOLS.md](docs/TOOLS.md)

---

## Use Cases

**Common scenarios:**
- 🐛 **Plugin Development** - Debug console errors, monitor execution, capture stack traces
- 🔍 **Design System Auditing** - AI-powered quality checks, token coverage analysis, compliance reporting (like ESLint for Figma)
- 🎨 **Design System Extraction** - Pull variables, styles, and components as structured data
- 🔧 **Component Implementation** - Get specs + visual references for UI development
- 📸 **Visual Debugging** - Capture screenshots for documentation or troubleshooting

> **📖 For detailed scenarios, workflows, and prompt examples:** See [docs/USE_CASES.md](docs/USE_CASES.md)

---

## Accessing Variables Without Enterprise API

Figma's Variables API requires an Enterprise plan. **We've built a workaround** that lets you access all your local variables through a simple plugin bridge - no Enterprise plan needed.

### How It Works

The **Figma Variables Bridge** plugin runs in Figma Desktop and exposes your variables data through a plugin UI iframe. The MCP server accesses this data via Puppeteer, bypassing Figma's Enterprise API requirement.

```
Figma Plugin Worker → postMessage → Plugin UI Iframe → window object → Puppeteer → MCP Server
```

**Key Features:**
- ✅ No Enterprise plan required
- ✅ Access all local variables and collections
- ✅ Supports multiple variable modes (Light/Dark/Brand variants)
- ✅ Smart caching with 5-minute TTL (no token limits)
- ✅ Natural language queries ("What's the primary font for Stratton mode?")
- ✅ Minimal, clean UI

### Complete Setup Workflow

> **⏱️ One-time setup** (~5 minutes) - After this, variables are instantly available in every session

#### Step 1: Enable Figma Remote Debugging

**Quit Figma Desktop completely**, then relaunch with remote debugging enabled:

**macOS:**
```bash
open -a "Figma" --args --remote-debugging-port=9222
```

**Windows:**
```bash
start figma://--remote-debugging-port=9222
```

**Verify it worked:** Visit http://localhost:9222 in Chrome - you should see inspectable Figma pages.

#### Step 2: Install Local Mode MCP

Follow the complete guide in [LOCAL_MODE_SETUP.md](LOCAL_MODE_SETUP.md) to:
- Install the local MCP server
- Configure Claude Code or Claude Desktop
- Verify the connection

**Quick verification:**
```
Ask Claude: "Check figma status"
```

You should see "✓ Figma Desktop connected" with port 9222.

#### Step 3: Install the Variables Bridge Plugin

1. **Open Figma Desktop** (must be running with debug flag from Step 1)
2. **Go to:** Plugins → Development → Import plugin from manifest...
3. **Navigate to:** `/path/to/figma-console-mcp/figma-variables-bridge/manifest.json`
4. **Click "Open"**

The plugin appears in your Development plugins list as "Figma Variables Bridge".

> **📁 Plugin location:** The `figma-variables-bridge/` directory is in your `figma-console-mcp` repository root

#### Step 4: Run the Plugin in Your Figma File

1. **Open your Figma file** that contains variables
2. **Right-click anywhere** → Plugins → Development → Figma Variables Bridge
3. **Wait for confirmation:** Plugin UI shows "✓ Variables ready"

**What you'll see:**
```
✓ Variables ready
404 variables in 2 collections

Data available via MCP
window.__figmaVariablesData
```

The plugin window can stay open or be minimized - it stays running until you close it.

#### Step 5: Query Your Variables

Now you can ask Claude about your variables using natural language!

**Example prompts:**

**Summary overview (recommended first call):**
```
Get me a summary of the Figma variables from https://figma.com/design/YOUR_FILE_KEY
```

Returns ~4K tokens with:
- Total variable count by collection
- Variable types (colors, floats, strings)
- Mode names
- Quick stats

**Specific questions:**
```
What is the primary font for the Stratton variable mode?
```

```
What is the primary brand color for Winter Park?
```

```
Show me all breakpoint variables
```

**Filtered queries:**
```
Get all color variables from the Brand collection
```

```
Show me font variables that contain "heading"
```

### API Parameters

The `figma_get_variables` tool supports these parameters:

```typescript
{
  fileUrl: string,              // Required: Your Figma file URL
  format?: "summary" | "filtered" | "full",  // Default: "full"
  collection?: string,          // Filter by collection name/ID
  namePattern?: string,         // Filter by name (regex or substring)
  mode?: string,                // Filter by mode name/ID
  refreshCache?: boolean        // Force refresh (default: false)
}
```

**Format options:**
- `"summary"` - ~2-5K tokens with overview and names only
- `"filtered"` - Apply collection/name/mode filters
- `"full"` - Complete dataset (auto-summarized if >25K tokens)

**Examples:**

```typescript
// Get summary first (recommended)
figma_get_variables({
  fileUrl: "https://figma.com/design/abc123",
  format: "summary"
})

// Filter by collection
figma_get_variables({
  fileUrl: "https://figma.com/design/abc123",
  format: "filtered",
  collection: "Brand"
})

// Search by name pattern
figma_get_variables({
  fileUrl: "https://figma.com/design/abc123",
  format: "filtered",
  namePattern: "font/family"
})

// Get specific mode
figma_get_variables({
  fileUrl: "https://figma.com/design/abc123",
  format: "filtered",
  collection: "Brand",
  mode: "Stratton"
})

// Force refresh cache
figma_get_variables({
  fileUrl: "https://figma.com/design/abc123",
  refreshCache: true
})
```

### Smart Caching

The MCP caches variables data with intelligent management:

- **5-minute TTL** - Automatic cache invalidation
- **LRU eviction** - Maximum 10 files cached
- **Token optimization** - Summary format uses ~95% fewer tokens
- **Instant responses** - Filtered queries return from cache immediately

**Cache is automatically used when:**
- Same file accessed within 5 minutes
- No `refreshCache: true` parameter
- File data hasn't been invalidated

**Force cache refresh:**
```typescript
figma_get_variables({
  fileUrl: "https://figma.com/design/abc123",
  refreshCache: true  // Fetches fresh data from plugin
})
```

### Troubleshooting

#### Plugin doesn't appear in menu
- ✅ Verify Figma Desktop is running (not browser)
- ✅ Check manifest.json path is correct
- ✅ Try: Plugins → Development → Refresh plugin list

#### "No plugin UI found with variables data"
- ✅ Ensure plugin is running (check for plugin window)
- ✅ Try closing and reopening the plugin
- ✅ Check Figma console: Plugins → Development → Open Console

#### Variables not updating
- ✅ Close and reopen plugin to refresh data
- ✅ Use `refreshCache: true` parameter
- ✅ Verify you're viewing the correct Figma file

#### Empty or outdated data
- ✅ Plugin fetches data on load - rerun after making changes
- ✅ Cache TTL is 5 minutes - use `refreshCache: true` for immediate updates
- ✅ Ensure you're in the correct file (plugin reads current file's variables)

#### Remote debugging not working
- ✅ Verify Figma was launched with `--remote-debugging-port=9222`
- ✅ Check http://localhost:9222 shows Figma pages
- ✅ Quit Figma completely (Cmd+Q / Alt+F4) and relaunch with flag
- ✅ See [LOCAL_MODE_SETUP.md](LOCAL_MODE_SETUP.md) for detailed troubleshooting

### Technical Details

**Plugin Architecture:**
- **Worker (code.js):** Fetches variables via `figma.variables.getLocalVariablesAsync()`
- **UI (ui.html):** Stores data on `window.__figmaVariablesData` (accessible to Puppeteer)
- **MCP Server:** Reads UI iframe window object via Chrome DevTools Protocol

**Data Format:**
```typescript
{
  success: true,
  timestamp: number,
  fileKey: string,
  variables: Array<{
    id: string,
    name: string,
    resolvedType: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN",
    valuesByMode: Record<string, any>,
    variableCollectionId: string,
    scopes: string[],
    description?: string
  }>,
  variableCollections: Array<{
    id: string,
    name: string,
    modes: Array<{ modeId: string, name: string }>,
    defaultModeId: string,
    variableIds: string[]
  }>
}
```

**Why This Works:**
- Figma plugin worker can access Variables API (no Enterprise restriction in plugins)
- Plugin UI iframe window is accessible via Puppeteer (not sandboxed)
- Data bridge bypasses Enterprise API requirement completely
- No network access required (plugin security: `allowedDomains: ["none"]`)

> **📖 For complete plugin documentation:** See [figma-variables-bridge/README.md](figma-variables-bridge/README.md)

---

## Advanced: Local Mode for Plugin Developers

If you're developing Figma plugins and need **zero-latency console log capture** directly from Figma Desktop:

### 🚨 Critical First Step: Enable Remote Debugging

**Before using local mode, you MUST restart Figma with the debug flag:**

1. **Quit Figma Desktop completely** (Cmd+Q on macOS / Alt+F4 on Windows)
2. **Relaunch with remote debugging:**
   - **macOS:** `open -a "Figma" --args --remote-debugging-port=9222`
   - **Windows:** `start figma://--remote-debugging-port=9222`
3. **Verify it worked:** Visit http://localhost:9222 in Chrome - you should see inspectable pages

**Then proceed to:** [LOCAL_MODE_SETUP.md](LOCAL_MODE_SETUP.md) for full local mode installation.

---

### When to Use Local Mode vs Cloud Mode

**Cloud mode (what you just installed) works great for most use cases:**
- ✅ Design system extraction
- ✅ Component data and images
- ✅ Console monitoring and screenshots
- ✅ Remote collaboration
- ✅ No setup required

**Local mode** is only recommended for:
- ✅ Developing Figma plugins with rapid iteration
- ✅ Needing instant console feedback (no network latency)
- ✅ Advanced debugging workflows with stack traces
- ⚠️ Requires one-time Figma restart with debug flag

---

## Architecture

### Cloud Mode (Default)

```
AI Assistant → mcp-remote → MCP Server (Cloudflare Workers) →
Browser Rendering API → Figma Web → Design Data
```

- ✅ Zero local setup
- ✅ Works from anywhere
- ✅ All 14 tools available
- ✅ Figma API integration for design data

### Local Mode (Advanced)

```
AI Assistant → MCP Server (local.js) →
Chrome DevTools Protocol (port 9222) →
Figma Desktop → Your Plugin
```

- ✅ Zero network latency
- ✅ Direct console log capture
- ✅ Perfect for plugin development
- ⚙️ Requires local setup

See [LOCAL_MODE_SETUP.md](LOCAL_MODE_SETUP.md) for installation.

---

## Self-Hosting (Optional)

Want to deploy your own instance on Cloudflare Workers?

[![Deploy to Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/southleft/figma-console-mcp)

Or via CLI:

```bash
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp
npm install && npm run deploy
```

> **📖 For complete deployment guide, custom domains, monitoring, and costs:** See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)

---

## Development

### Local Development

```bash
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp
npm install

# For cloud mode development
npm run dev

# For local mode development
npm run dev:local
```

### Building

```bash
# Build both modes
npm run build

# Build local mode only
npm run build:local

# Build cloud mode only
npm run build:cloudflare
```

### Testing

```bash
# Run tests
npm test

# Run tests with coverage
npm test:coverage

# Run tests in watch mode
npm test:watch
```

---

## Troubleshooting

### Understanding Console Log Capture

**How It Works:**
- The MCP captures console logs in **real-time** starting from when monitoring begins
- It does **NOT** retrieve historical logs from before monitoring started
- When Claude Code/Desktop restarts, the MCP reconnects and starts fresh monitoring

### Common Issue: "No Plugin Logs Appearing"

**Symptom:** You see logs in Figma's console but not in the MCP

**Cause:** Your plugin ran BEFORE the MCP started monitoring (e.g., before restarting your AI client)

**Solution:**
1. ✅ Check status: Use `figma_get_status` to confirm monitoring is active
2. ✅ **Run your plugin in Figma Desktop** (this generates fresh logs)
3. ✅ Check logs: Use `figma_get_console_logs` to retrieve them
4. ✅ Logs should now appear!

**Best Practice Workflow:**
1. Start your AI client (MCP connects automatically)
2. Check status to confirm monitoring is active
3. Run your Figma plugin
4. Retrieve console logs

### Other Quick Fixes

| Problem | Solution |
|---------|----------|
| "FIGMA_ACCESS_TOKEN not configured" | Add token to MCP config ([Step 2](#step-2-add-your-figma-access-token-for-design-system-tools)) |
| "Failed to connect to browser" | Wait 10-30s (cloud mode cold start) or check [LOCAL_MODE_SETUP.md](LOCAL_MODE_SETUP.md#troubleshooting) |
| Console tools work, design tools don't | You need to add FIGMA_ACCESS_TOKEN |
| Variables API 403 error | Enterprise plan required - MCP auto-falls back to Styles |
| Tools are slow | Normal for cloud mode first request (10-30s), then faster |

> **📖 For complete troubleshooting guide with detailed solutions:** See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

---

## Roadmap

- [ ] **Phase 6: Component Screenshot Diffs** - Visual regression testing for components
- [ ] **Phase 7: Batch Operations** - Process multiple components/files at once
- [ ] **Phase 8: Plugin Template Generation** - Generate plugin boilerplate from specs
- [ ] **Phase 9: Design Linting** - Automated design system compliance checks
- [ ] **Phase 10: Real-time Collaboration** - Multi-user debugging sessions

See [docs/ROADMAP.md](docs/ROADMAP.md) for full roadmap.

---

## Contributing

Contributions welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

MIT - See [LICENSE](LICENSE) file for details.

---

## Support & Resources

- 📖 [Full Documentation](docs/)
- 🐛 [Report Issues](https://github.com/southleft/figma-console-mcp/issues)
- 💬 [Discussions](https://github.com/southleft/figma-console-mcp/discussions)
- 🔗 [Model Context Protocol](https://modelcontextprotocol.io/)
- 🎨 [Figma API Reference](https://www.figma.com/developers/api)
