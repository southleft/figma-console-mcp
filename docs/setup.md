---
title: "Setup Guide"
description: "Complete setup instructions for connecting Figma Console MCP to Claude Desktop, GitHub Copilot, Cursor, Windsurf, and other AI clients."
---

# Figma Console MCP - Setup Guide

Complete setup instructions for connecting Figma Console MCP to various AI clients including Claude Desktop, GitHub Copilot (VS Code), Cursor, Windsurf, and more.

---

## 🎯 Choose Your Setup

**First, decide what you want to do:**

| I want to... | Setup Method | Time |
|--------------|--------------|------|
| **Create and modify designs with AI** | [NPX Setup](#-npx-setup-recommended) (Recommended) | ~10 min |
| **Contribute to the project** | [Local Git Setup](#-local-git-setup-for-contributors) | ~15 min |
| **Just explore my design data** (read-only) | [Remote SSE](#-remote-sse-read-only-exploration) | ~2 min |

### ⚠️ Important: Capability Differences

| Capability | NPX / Local Git | Remote SSE |
|------------|-----------------|------------|
| Read design data | ✅ | ✅ |
| **Create components & frames** | ✅ | ❌ |
| **Edit existing designs** | ✅ | ❌ |
| **Manage design tokens/variables** | ✅ | ❌ |
| Screenshot validation | ✅ | ✅ |
| Desktop Bridge plugin | ✅ | ❌ |
| Variables without Enterprise | ✅ | ❌ |
| **Total tools available** | **50+** | **16** |

> **Bottom line:** Remote SSE is **read-only** with ~32% of the tools. If you want AI to actually design in Figma, use NPX Setup.

---

## 🚀 NPX Setup (Recommended)

**Best for:** Designers who want full AI-assisted design capabilities with automatic updates.

**What you get:** All 50+ tools including design creation, variable management, component instantiation, and Desktop Bridge plugin support.

### Prerequisites Checklist

Before starting, verify you have:

- [ ] **Node.js 18+** installed — Check with `node --version` ([Download](https://nodejs.org))
- [ ] **Figma Desktop** installed (not just the web app)
- [ ] **Claude Desktop** or another MCP client installed

### Step 1: Get Your Figma Token (~2 min)

1. Go to [figma.com/developers/api#access-tokens](https://www.figma.com/developers/api#access-tokens)
2. Click **"Get personal access token"**
3. Enter description: `Figma Console MCP`
4. Click **"Generate token"**
5. **Copy the token immediately** — you won't see it again!

> 💡 Your token starts with `figd_` — if it doesn't, something went wrong.

### Step 2: Configure Your MCP Client (~3 min)

#### Claude Desktop

1. Open Claude Desktop
2. Go to **Settings** → **Developer** → **Edit Config** (or manually edit the config file)
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

3. Add this configuration (replace `YOUR_TOKEN_HERE` with your actual token):

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["-y", "figma-console-mcp@latest"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_YOUR_TOKEN_HERE"
      }
    }
  }
}
```

4. **Save the file**

#### Claude Code (CLI)

Run this command (replace the token):

```bash
claude mcp add figma-console -s user -- npx -y figma-console-mcp@latest
```

Then add your token to `~/.claude.json`:

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["-y", "figma-console-mcp@latest"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_YOUR_TOKEN_HERE"
      }
    }
  }
}
```

#### Other MCP Clients (Cursor, Windsurf, etc.)

Find your client's MCP config file and add the same JSON block shown above.

### Step 3: Start Figma with Debug Mode (~2 min)

This is **required** for the MCP to communicate with Figma Desktop.

1. **Quit Figma completely** (Cmd+Q on macOS, Alt+F4 on Windows)

2. **Restart Figma with the debug flag:**

   **macOS (Terminal):**
   ```bash
   open -a "Figma" --args --remote-debugging-port=9222
   ```

   **Windows (CMD or PowerShell):**
   ```
   cmd /c "%LOCALAPPDATA%\Figma\Figma.exe" --remote-debugging-port=9222
   ```

3. **Verify it worked:** Open Chrome and visit [http://localhost:9222](http://localhost:9222)
   - ✅ You should see a list of inspectable Figma pages
   - ❌ If blank or error, Figma wasn't started correctly — try again

> ⚠️ **You must restart Figma with this flag every time** you quit Figma and want to use the MCP again. Consider creating a desktop shortcut or alias.

### Step 4: Restart Claude Desktop (~1 min)

1. **Quit Claude Desktop completely** (Cmd+Q or right-click → Quit)
2. **Reopen Claude Desktop**
3. Look for the 🔌 icon showing "figma-console: connected"

### Step 5: Test It! (~2 min)

Try these prompts to verify everything works:

```
Check Figma status
```
→ Should show "✅ Figma Desktop connected via port 9222"

```
Search for button components
```
→ Should return component results from your open Figma file

```
Create a simple frame with a blue background
```
→ Should create a frame in your Figma file (this confirms write access!)

**🎉 You're all set!** You now have full AI-assisted design capabilities.

---

## 🔧 Local Git Setup (For Contributors)

**Best for:** Developers who want to modify the source code or contribute to the project.

**What you get:** Same 50+ tools as NPX, plus full source code access.

### Prerequisites

- [ ] Node.js 18+ installed
- [ ] Git installed
- [ ] Figma Desktop installed
- [ ] Claude Desktop or another MCP client

### Step 1: Clone and Build

```bash
# Clone the repository
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp

# Install dependencies
npm install

# Build for local mode
npm run build:local
```

### Step 2: Get Figma Token

Same as [NPX Step 1](#step-1-get-your-figma-token-2-min) above.

### Step 3: Configure Claude Desktop

Edit your config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "figma-console": {
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
- Replace `/absolute/path/to/figma-console-mcp` with the actual path where you cloned the repo
- Use forward slashes `/` even on Windows

### Step 4: Start Figma with Debug Mode

Same as [NPX Step 3](#step-3-start-figma-with-debug-mode-2-min) above.

### Step 5: Restart Claude Desktop and Test

Same as [NPX Steps 4 & 5](#step-4-restart-claude-desktop-1-min) above.

### Updating

To get the latest changes:

```bash
cd figma-console-mcp
git pull
npm install
npm run build:local
```

Then restart Claude Desktop.

---

## 📡 Remote SSE (Read-Only Exploration)

**Best for:** Quickly evaluating the tool or read-only design data extraction.

**What you get:** 16 read-only tools for viewing design data, taking screenshots, and reading console logs.

> ⚠️ **Limitation:** Remote mode **cannot create or modify designs**. It's read-only. For design creation, use [NPX Setup](#-npx-setup-recommended).

### Prerequisites

- [ ] Claude Desktop installed
- That's it! No Node.js, no tokens, no Figma restart required.

### Method 1: UI-Based Setup (Claude Desktop)

1. Open Claude Desktop → **Settings** → **Connectors**
2. Click **"Add Custom Connector"**
3. Enter:
   - **Name:** `Figma Console (Read-Only)`
   - **URL:** `https://figma-console-mcp.southleft.com/sse`
4. Click **"Add"**
5. Done! ✅

OAuth authentication happens automatically when you first use design system tools.

### Method 2: JSON Config

Add to your Claude Desktop config:

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

### What You Can Do (Read-Only)

✅ View design data and file structure
✅ Read design tokens/variables (Enterprise plan required)
✅ Take screenshots
✅ Read console logs
✅ Get component metadata

### What You Cannot Do

❌ Create frames, shapes, or components
❌ Edit existing designs
❌ Create or modify variables
❌ Instantiate components
❌ Use Desktop Bridge plugin

### Upgrading to Full Capabilities

Ready for design creation? Follow the [NPX Setup](#-npx-setup-recommended) guide above.

---

## 🤖 GitHub Copilot (VS Code)

GitHub Copilot supports MCP servers as of VS Code 1.102+.

### Prerequisites

- VS Code 1.102 or later
- GitHub Copilot extension installed and active
- For full capabilities: Node.js 18+ and Figma Personal Access Token

### Quick Setup (CLI)

**Full capabilities (recommended):**
```bash
# Create env file for your token
echo "FIGMA_ACCESS_TOKEN=figd_YOUR_TOKEN_HERE" > ~/.figma-console-mcp.env

# Add the server
code --add-mcp '{"name":"figma-console","command":"npx","args":["-y","figma-console-mcp@latest"],"envFile":"~/.figma-console-mcp.env"}'
```

**Read-only mode:**
```bash
code --add-mcp '{"name":"figma-console","type":"sse","url":"https://figma-console-mcp.southleft.com/sse"}'
```

### Manual Configuration

Create `.vscode/mcp.json` in your project:

**Full capabilities:**
```json
{
  "servers": {
    "figma-console": {
      "command": "npx",
      "args": ["-y", "figma-console-mcp@latest"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_YOUR_TOKEN_HERE"
      }
    }
  }
}
```

> **Security Tip:** Use `envFile` instead of inline `env` to keep tokens out of version control.

### Starting the Server

1. Open Command Palette (**Cmd+Shift+P** / **Ctrl+Shift+P**)
2. Run **"MCP: List Servers"**
3. Click on **"figma-console"** to start it
4. VS Code may prompt you to **trust the server** — click Allow

---

## 🛠️ Troubleshooting

### Quick Fixes

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| "Failed to connect to Figma Desktop" | Figma not in debug mode | Quit Figma, restart with `--remote-debugging-port=9222` |
| "FIGMA_ACCESS_TOKEN not configured" | Missing or wrong token | Check token in config, must start with `figd_` |
| "Command not found: node" | Node.js not installed | Install Node.js 18+ from nodejs.org |
| Tools not appearing in Claude | Config not loaded | Restart Claude Desktop completely |
| "Port 9222 already in use" | Another process using port | Close Chrome windows, check Task Manager |
| NPX using old version | Cached package | Use `figma-console-mcp@latest` explicitly |

### Node.js Version Issues

**Symptom:** Cryptic errors like "parseArgs not exported from 'node:util'"

**Fix:** You need Node.js 18 or higher.

```bash
# Check your version
node --version

# Should show v18.x.x or higher
```

If using **NVM** and having issues, try using the absolute path to Node:

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "/Users/yourname/.nvm/versions/node/v20.10.0/bin/node",
      "args": ["-e", "require('figma-console-mcp')"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_YOUR_TOKEN_HERE"
      }
    }
  }
}
```

### Figma Debug Mode Not Working

1. **Completely quit Figma** — not just close the window
   - macOS: Cmd+Q or Figma menu → Quit Figma
   - Windows: Alt+F4 or right-click taskbar icon → Close window

2. **Verify Figma is fully closed:**
   - macOS: `ps aux | grep -i figma` should show nothing
   - Windows: Check Task Manager for Figma processes

3. **Restart with the flag:**
   - macOS: `open -a "Figma" --args --remote-debugging-port=9222`
   - Windows: `cmd /c "%LOCALAPPDATA%\Figma\Figma.exe" --remote-debugging-port=9222`

4. **Verify:** Visit http://localhost:9222 — should show inspectable pages

### Claude Code OAuth Issues

> **⚠️ Known Issue:** Claude Code's native `--transport sse` has a bug where OAuth completes but the connection fails. Use `mcp-remote` instead.

**Don't use:**
```bash
# This has a known bug
claude mcp add figma-console --transport sse https://figma-console-mcp.southleft.com/sse
```

**Use instead:**
```bash
# This works correctly
claude mcp add figma-console -s user -- npx -y mcp-remote@latest https://figma-console-mcp.southleft.com/sse
```

Or better yet, use the NPX setup for full capabilities:
```bash
claude mcp add figma-console -s user -- npx -y figma-console-mcp@latest
```

### Config File Syntax Errors

If Claude Desktop doesn't see your MCP server:

1. **Validate your JSON:** Use a tool like [jsonlint.com](https://jsonlint.com)
2. **Check for common mistakes:**
   - Missing commas between properties
   - Trailing commas (not allowed in JSON)
   - Wrong quote characters (must be `"` not `'` or smart quotes)
3. **Copy the exact config** from this guide — don't retype it

### Still Having Issues?

1. Check the [GitHub Issues](https://github.com/southleft/figma-console-mcp/issues)
2. Ask in [Discussions](https://github.com/southleft/figma-console-mcp/discussions)
3. Include:
   - Your setup method (NPX, Local Git, or Remote)
   - The exact error message
   - Output of `node --version`
   - Your MCP client (Claude Desktop, Claude Code, etc.)

---

## Optional: Enable MCP Apps

MCP Apps provide interactive UI experiences like the Token Browser and Design System Dashboard.

Add `ENABLE_MCP_APPS` to your config:

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["-y", "figma-console-mcp@latest"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_YOUR_TOKEN_HERE",
        "ENABLE_MCP_APPS": "true"
      }
    }
  }
}
```

> **Note:** MCP Apps require a client with [ext-apps protocol](https://github.com/anthropics/anthropic-cookbook/tree/main/misc/model_context_protocol/ext-apps) support.

---

## Next Steps

1. **Try example prompts:** See [Use Cases](use-cases) for workflow examples
2. **Explore all tools:** See [Tools Reference](tools) for the complete tool list
3. **Install Desktop Bridge plugin:** For variables without Enterprise — see [Desktop Bridge README](https://github.com/southleft/figma-console-mcp/tree/main/figma-desktop-bridge)

---

## Support

- 📖 [Full Documentation](/)
- 🐛 [Report Issues](https://github.com/southleft/figma-console-mcp/issues)
- 💬 [Discussions](https://github.com/southleft/figma-console-mcp/discussions)
- 📊 [Mode Comparison](mode-comparison)
