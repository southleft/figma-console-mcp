# Figma Console MCP Server

[![MCP](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Model Context Protocol server** that provides AI assistants with **real-time console access, visual debugging, and design system extraction** for Figma.

## What is this?

Figma Console MCP connects AI assistants (like Claude) to Figma, enabling:

- **🐛 Plugin debugging** - Capture console logs, errors, and stack traces
- **📸 Visual debugging** - Take screenshots for context
- **🎨 Design system extraction** - Pull variables, components, and styles
- **⚡ Real-time monitoring** - Watch logs as plugins execute
- **🔄 Three ways to install** - Remote SSE (OAuth, zero-setup), NPX (npm package), or Local Git (source code)

---

## ⚡ Quick Start

### Choose Your Installation Method

This MCP server offers **three installation methods** with different tradeoffs:

| Method | Setup | Auth | Best For |
|--------|-------|------|----------|
| **[Remote SSE](#for-most-users-remote-mode-zero-setup)** | ⭐ Paste URL (2 min) | OAuth (automatic) | Most users - design system extraction |
| **[NPX](#npx-alternative-package-distribution)** | npm package (10 min) | PAT (manual) | Local execution without source code |
| **[Local Git](#for-plugin-developers-local-mode)** | git clone (15 min) | PAT (manual) | Developers - modify source code |

**Key Insight:** Only Remote SSE offers true zero-setup via OAuth. Both NPX and Local Git require manual `FIGMA_ACCESS_TOKEN` setup.

Choose the setup that fits your needs:

### For Most Users: Remote Mode (Zero Setup)

Perfect for design system extraction and basic debugging. No installation required!

#### Claude Desktop (Recommended)

**Latest Method - No Config Files!**

1. Open Claude Desktop → **Settings** → **Connectors**
2. Click **"Add Custom Connector"**
3. Enter:
   - **Name:** `Figma Console`
   - **URL:** `https://figma-console-mcp.southleft.com/sse`
4. Click **"Add"**
5. Done! ✅

**What you get:**
- ✅ All 14 Figma tools available immediately
- ✅ OAuth authentication (automatic when you first use API tools)
- ✅ Design system extraction (variables*, components, styles)
- ✅ Console debugging and screenshots
- ❌ Desktop Bridge plugin NOT available (use Local Mode for that)

*Variables API requires Figma Enterprise plan OR use Local Mode + Desktop Bridge plugin

---

#### Claude Code

One-line install:

```bash
claude mcp add --transport sse figma-console https://figma-console-mcp.southleft.com/sse
```

Verify: `/mcp` should show "figma-console: connected"

---

#### Cursor

Add to `.cursor/mcp.json`:

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

Restart Cursor after saving.

---

<details>
<summary><b>Other MCP Clients (Windsurf, Zed, etc.)</b></summary>

Consult your client's MCP documentation for the config file location, then add:

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

---

### NPX: Alternative Package Distribution

**Use NPX if you:**
- ✅ Want local execution without cloning source code
- ✅ Need Desktop Bridge plugin features
- ✅ Prefer npm package distribution over git
- ⚠️ Are comfortable with manual `FIGMA_ACCESS_TOKEN` setup

**Setup time:** 10 minutes

**Note:** NPX has **identical authentication requirements** to Local Git mode. For true zero-setup, use [Remote Mode](#for-most-users-remote-mode-zero-setup) instead.

#### Configuration

Add to your MCP config (e.g., `.claude.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "figma-console": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "figma-console-mcp@latest"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "your_figma_access_token_here"
      }
    }
  }
}
```

#### Prerequisites

- Get **Figma Personal Access Token**: https://www.figma.com/developers/api#access-tokens
- Restart Figma Desktop with `--remote-debugging-port=9222`
  - **macOS:** `open -a "Figma" --args --remote-debugging-port=9222`
  - **Windows:** `start figma://--remote-debugging-port=9222`

**📖 [Complete NPX Setup Guide](docs/NPX-INSTALLATION.md)**

---

### For Plugin Developers: Local Mode

**Use Local Mode if you:**
- ✅ Are developing Figma plugins (need zero-latency console debugging)
- ✅ Need variables WITHOUT Enterprise plan (via Desktop Bridge plugin)
- ✅ Need reliable component descriptions (Figma API has bugs, plugin bypasses them)
- ✅ Want direct access to Figma Desktop state

**⚠️ Important:** The **Desktop Bridge plugin ONLY works in Local Mode**. Remote mode cannot access it because the plugin requires direct connection to Figma Desktop via `localhost:9222`.

**Setup time:** 10-15 minutes

#### Prerequisites
- Node.js 18+ installed
- Figma Desktop installed
- Git installed
- Terminal/command line access

#### Step 1: Install the MCP Server

```bash
# Clone the repository
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp

# Install dependencies
npm install

# Build for local mode
npm run build:local
```

#### Step 2: Get Figma Personal Access Token

1. Visit https://www.figma.com/developers/api#access-tokens
2. Click "Get personal access token"
3. Enter description: "Figma Console MCP Local"
4. Click "Generate token"
5. **Copy the token** (you won't see it again!)

#### Step 3: Configure Claude Desktop

**macOS:** Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** Edit `%APPDATA%\Claude\claude_desktop_config.json`

Add this configuration:

```json
{
  "mcpServers": {
    "figma-console-local": {
      "command": "node",
      "args": ["/absolute/path/to/figma-console-mcp/dist/local.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_YOUR_TOKEN_HERE"
      }
    }
  }
}
```

**Important:**
- Replace `/absolute/path/to/figma-console-mcp` with the actual absolute path where you cloned the repo
- Replace `figd_YOUR_TOKEN_HERE` with your actual Figma token from Step 2
- Use forward slashes `/` even on Windows

#### Step 4: Launch Figma Desktop with Remote Debugging

**⚠️ CRITICAL:** Quit Figma completely first, then restart it with the debug flag:

**macOS:**
```bash
open -a "Figma" --args --remote-debugging-port=9222
```

**Windows:**
```cmd
start figma://--remote-debugging-port=9222
```

#### Step 5: Restart Claude Desktop

Quit Claude Desktop completely and relaunch it. The MCP server will connect automatically.

#### Step 6: Verify Setup

1. **Check debug port is working:**
   - Open Chrome browser
   - Visit: http://localhost:9222
   - You should see inspectable Figma pages

2. **Test in Claude Desktop:**
   - Look for 🔌 icon showing "figma-console-local: connected"
   - Ask Claude: "Check Figma status"
   - Should show: "✅ Figma Desktop connected"

**📖 For more details:** See [Complete Setup Guide](docs/SETUP.md)

---

## 📊 Installation Method Comparison

| Feature | Remote SSE | NPX | Local Git |
|---------|------------|-----|-----------|
| **Setup** | 2 minutes | 10 minutes | 15 minutes |
| **Prerequisites** | None | PAT + Figma restart | PAT + Figma restart + git |
| **Authentication** | OAuth (automatic) | PAT (manual) | PAT (manual) |
| **Console logs** | ✅ | ✅ (zero latency) | ✅ (zero latency) |
| **API access** | ✅ | ✅ | ✅ |
| **Desktop Bridge plugin** | ❌ | ✅ | ✅ |
| **Variables (no Enterprise)** | ❌ | ✅ (via plugin) | ✅ (via plugin) |
| **Reliable descriptions** | ⚠️ (API bugs) | ✅ (via plugin) | ✅ (via plugin) |
| **Source code access** | ❌ | ❌ | ✅ |
| **Distribution** | URL | npm package | git clone |

**📖 [Complete Feature Comparison](docs/MODE_COMPARISON.md)**

---

## 🎯 Test Your Connection

After setup, try these prompts:

**Basic test (both modes):**
```
Navigate to https://www.figma.com and check status
```

**Design system test (requires auth):**
```
Get design variables from [your Figma file URL]
```

**Plugin test (Local Mode only):**
```
Show me the primary font for [your theme name]
```

---

## 🔐 Authentication

### Remote Mode - OAuth (Automatic)

When you first use design system tools:
1. Browser opens automatically to Figma authorization page
2. Click "Allow" to authorize (one-time)
3. Token stored securely and refreshed automatically
4. Works with Free, Pro, and Enterprise Figma plans

### Local Mode - Personal Access Token (Manual)

1. Visit https://www.figma.com/developers/api#access-tokens
2. Generate token
3. Add to MCP config as `FIGMA_ACCESS_TOKEN` environment variable

---

## 🛠️ Available Tools

All 14 tools work in both Remote and Local modes:

### Navigation & Status
- `figma_navigate` - Open Figma URLs
- `figma_get_status` - Check connection status

### Console Debugging
- `figma_get_console_logs` - Retrieve console logs
- `figma_watch_console` - Real-time log streaming
- `figma_clear_console` - Clear log buffer
- `figma_reload_plugin` - Reload current page

### Visual Debugging
- `figma_take_screenshot` - Capture UI screenshots

### Design System Extraction
- `figma_get_variables` - Extract design tokens/variables
- `figma_get_component` - Get component data
- `figma_get_component_for_development` - Component + image
- `figma_get_component_image` - Just the image
- `figma_get_styles` - Color, text, effect styles
- `figma_get_file_data` - Full file structure
- `figma_get_file_for_plugin` - Optimized file data

**📖 [Detailed Tool Documentation](docs/TOOLS.md)**

---

## 📖 Example Prompts

### Plugin Debugging
```
Navigate to my Figma plugin and show me any console errors
Watch the console for 30 seconds while I test my plugin
Get the last 20 console logs
```

### Design System Extraction
```
Get all design variables from https://figma.com/design/abc123
Extract color styles and show me the CSS exports
Get the Button component with a visual reference image
```

### Visual Debugging
```
Take a screenshot of the current Figma canvas
Navigate to this file and capture what's on screen
```

**📖 [More Use Cases & Examples](docs/USE_CASES.md)**

---

## 🎨 Desktop Bridge Plugin (Local Mode Only)

The **Figma Desktop Bridge** plugin enables:
- ✅ Variables without Enterprise API
- ✅ Reliable component descriptions (bypasses API bugs)
- ✅ Multi-mode support (Light/Dark/Brand variants)

**⚠️ Plugin Limitation:** Only works in Local Mode. Remote mode cannot access it.

**Setup:**
1. Install Local Mode MCP
2. Download plugin from [Releases](https://github.com/southleft/figma-console-mcp/releases/latest)
3. Import plugin: Figma Desktop → Plugins → Development → Import plugin from manifest
4. Run plugin in your Figma file
5. Ask Claude: "Show me the primary font for [your theme]"

**📖 [Desktop Bridge Documentation](figma-desktop-bridge/README.md)**

---

## 🚀 Advanced Topics

- **[Setup Guide](docs/SETUP.md)** - Complete setup guide for all MCP clients
- **[Self-Hosting](docs/SELF_HOSTING.md)** - Deploy your own instance on Cloudflare
- **[Architecture](docs/ARCHITECTURE.md)** - How it works under the hood
- **[OAuth Setup](docs/OAUTH_SETUP.md)** - Configure OAuth for self-hosted deployments
- **[Troubleshooting](docs/TROUBLESHOOTING.md)** - Common issues and solutions

---

## 🤝 vs. Figma Official MCP

**Figma Console MCP (This Project)** - Debugging & data extraction
- ✅ Real-time console logs from Figma plugins
- ✅ Screenshot capture and visual debugging
- ✅ Error stack traces and runtime monitoring
- ✅ Raw design data extraction (JSON)
- ✅ Works remotely or locally

**Figma Official Dev Mode MCP** - Code generation
- ✅ Generates React/HTML code from designs
- ✅ Tailwind/CSS class generation
- ✅ Component boilerplate scaffolding

**Use both together** for the complete workflow: generate code with Official MCP, then debug and extract data with Console MCP.

---

## 🛤️ Roadmap

- [ ] **Real-time collaboration** - Multi-user debugging sessions
- [ ] **Component screenshot diffs** - Visual regression testing
- [ ] **Batch operations** - Process multiple files at once
- [ ] **Design linting** - Automated compliance checks
- [ ] **Plugin template generation** - Generate plugin boilerplate

**📖 [Full Roadmap](docs/ROADMAP.md)**

---

## 💻 Development

```bash
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp
npm install

# Local mode development
npm run dev:local

# Cloud mode development
npm run dev

# Build
npm run build
```

**📖 [Development Guide](docs/ARCHITECTURE.md)**

---

## 📄 License

MIT - See [LICENSE](LICENSE) file for details.

---

## 🔗 Links

- 📖 [Full Documentation](docs/)
- 🐛 [Report Issues](https://github.com/southleft/figma-console-mcp/issues)
- 💬 [Discussions](https://github.com/southleft/figma-console-mcp/discussions)
- 🌐 [Model Context Protocol](https://modelcontextprotocol.io/)
- 🎨 [Figma API](https://www.figma.com/developers/api)
