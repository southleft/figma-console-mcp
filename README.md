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

**Quick fixes:**

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
