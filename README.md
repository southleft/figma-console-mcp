# Figma Console MCP Server

[![MCP](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Model Context Protocol server** that provides AI assistants with **real-time console access, visual debugging, and design system extraction** for Figma files and plugins.

## Overview

Figma Console MCP is a [Model Context Protocol](https://modelcontextprotocol.io/) server that connects AI assistants (like Claude) to Figma for:

- **🐛 Plugin debugging** - Capture console logs, errors, and stack traces from Figma plugins
- **📸 Visual debugging** - Take screenshots of Figma UI for context
- **🎨 Design system extraction** - Pull variables, components, styles, and file data
- **⚡ Live monitoring** - Watch console logs in real-time as plugins execute
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

## Figma Console MCP vs. Figma Official Dev Mode MCP

Both MCPs connect AI assistants to Figma, but serve different purposes:

**Figma Console MCP (This Project)** - Debugging & data extraction
- ✅ Real-time console logs from Figma plugins
- ✅ Screenshot capture and visual debugging
- ✅ Error stack traces and runtime state
- ✅ Raw design data extraction (JSON)
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
- Extracting design system data as JSON (variables, components, styles)
- You need visual debugging with screenshots
- Investigating runtime errors with stack traces

**Use Figma Official MCP** when:
- Converting Figma designs into React/HTML code
- You want generated Tailwind classes and component boilerplate

**Use both together** for the complete workflow: generate code with Official MCP, then debug and refine with Console MCP.

---

## Installation

### Step 1: Connect to Figma Console MCP

Add this configuration to your AI client:

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

**After editing:**
1. Save and restart Cursor
2. Check for MCP connection indicator
3. Test with a prompt like "Navigate to https://www.figma.com"

</details>

<details>
<summary><b>Zed</b></summary>

**Location:** `~/.config/zed/settings.json` (Linux/macOS) or `%APPDATA%\Zed\settings.json` (Windows)

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

</details>

<details>
<summary><b>Other MCP Clients</b></summary>

Use the same configuration pattern:

```json
{
  "command": "npx",
  "args": ["mcp-remote", "https://figma-console-mcp.southleft.com/sse"]
}
```

Consult your MCP client's documentation for the specific configuration file location.

</details>

---

### Step 2: Add Your Figma Access Token (For Design System Tools)

> **⚠️ Required for:** `figma_get_variables`, `figma_get_component`, `figma_get_styles`, `figma_get_file_data`, and other API-based tools.
>
> **Not required for:** Console monitoring, screenshots, and browser navigation.

**Get your token:** https://www.figma.com/developers/api#access-tokens

<details>
<summary><b>How to add your token to Claude Desktop</b></summary>

Edit your config file to include the `env` section:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

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

**After editing:**
1. Replace `figd_your_actual_token_here` with your actual token
2. Save the file
3. Quit Claude Desktop completely
4. Restart Claude Desktop

</details>

<details>
<summary><b>How to add your token to other MCP clients</b></summary>

The same pattern applies - add an `env` object with `FIGMA_ACCESS_TOKEN`:

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

</details>

---

### Step 3: Test Your Connection

In your AI assistant, try:

```
Navigate to https://www.figma.com and check the status
```

You should see:
- Browser connected successfully
- Console monitoring active
- All 14 tools available

If you added your Figma token, also try:

```
Get design variables from [your Figma file URL]
```

---

## Available Tools

All 14 tools work identically in both cloud and local modes:

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

### Tool Categories

#### 🧭 Navigation Tools
- **figma_navigate** - Navigate to any Figma URL (always use this first)
- **figma_get_status** - Check connection and monitoring status

#### 📋 Console Tools (Plugin Debugging)
- **figma_get_console_logs** - Get recent logs with filters (level, count, since)
- **figma_watch_console** - Live stream logs for X seconds
- **figma_clear_console** - Clear the log buffer

#### 🔍 Debugging Tools
- **figma_take_screenshot** - Capture screenshots (plugin UI, full page, or viewport)
- **figma_reload_plugin** - Reload the current page

#### 🎨 Design System Tools (Requires FIGMA_ACCESS_TOKEN)
- **figma_get_variables** - Extract design tokens/variables with optional CSS/Tailwind exports
- **figma_get_styles** - Get all styles (color, text, effects) with code exports
- **figma_get_component** - Get component metadata and properties
- **figma_get_component_for_development** - Component data + rendered image (for UI implementation)
- **figma_get_component_image** - Just render a component as an image
- **figma_get_file_data** - Full file structure with verbosity control (summary/standard/full)
- **figma_get_file_for_plugin** - File structure optimized for plugin development (IDs, plugin data, relationships)

---

## Use Cases

### Plugin Development & Debugging

**Scenario:** You're developing a Figma plugin and need to debug console errors.

```
"Navigate to my Figma file at https://figma.com/design/abc123 and watch console logs for 30 seconds while I test my plugin"
```

The AI will:
1. Navigate to your file
2. Start monitoring console logs
3. Capture any errors, warnings, or log statements
4. Report back with timestamped logs

### Design System Extraction

**Scenario:** You need to extract design tokens from your Figma design system.

```
"Get all design variables from https://figma.com/design/abc123 and export them as CSS custom properties"
```

The AI will:
1. Extract all variables using the Figma API
2. Format them as CSS custom properties
3. Provide organized, ready-to-use CSS code

### Component Implementation

**Scenario:** You need to implement a Tooltip component from Figma.

```
"Get the Tooltip component from https://figma.com/design/abc123?node-id=695-313 and help me implement it in React"
```

The AI will:
1. Fetch component data with visual reference image
2. Extract layout, styling, and property information
3. Help you implement it with accurate spacing, colors, and behavior

---

## Advanced: Local Mode for Plugin Developers

If you're developing Figma plugins and need **zero-latency console log capture** directly from Figma Desktop, see [LOCAL_MODE_SETUP.md](LOCAL_MODE_SETUP.md).

**Cloud mode (what you just installed) works great for most use cases**, including:
- ✅ Design system extraction
- ✅ Component data and images
- ✅ Console monitoring and screenshots
- ✅ Remote collaboration

**Local mode** is only recommended for:
- Developing Figma plugins with rapid iteration
- Needing instant console feedback (no network latency)
- Advanced debugging workflows

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

<details>
<summary><b>Deploy Your Own Instance</b></summary>

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
- Browser Rendering API enabled (free tier: 10 min/day)

**Set your Figma token:**

```bash
npx wrangler secret put FIGMA_ACCESS_TOKEN
# Paste your token when prompted
```

**Update your MCP client config:**

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["mcp-remote", "https://your-worker-name.your-subdomain.workers.dev/sse"]
    }
  }
}
```

</details>

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

### "FIGMA_ACCESS_TOKEN not configured"

This error appears when using design system tools (`figma_get_variables`, `figma_get_component`, etc.) without setting your Figma access token.

**Solution:** Add your token to your MCP client config (see [Step 2](#step-2-add-your-figma-access-token-for-design-system-tools))

### "Failed to connect to browser"

**Cloud mode:** This is usually temporary. The Cloudflare Browser Rendering API may be initializing. Try again in a few seconds.

**Local mode:** See [LOCAL_MODE_SETUP.md](LOCAL_MODE_SETUP.md#troubleshooting)

### Console tools work but design tools don't

You have the MCP connected, but haven't added your `FIGMA_ACCESS_TOKEN`.

**Solution:** Add your token to the `env` section of your MCP config (see [Step 2](#step-2-add-your-figma-access-token-for-design-system-tools))

### Variables API returns 403 error

The Figma Variables API requires an Enterprise plan. The MCP will automatically fall back to Styles API or provide alternative extraction methods.

### Tools are slow in cloud mode

Cloud mode uses Cloudflare Browser Rendering API, which may have a cold start delay. After the first request, subsequent requests are typically faster.

For plugin development workflows that need instant feedback, consider [Local Mode](LOCAL_MODE_SETUP.md).

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
