---
title: "Setup Guide"
description: "Complete setup instructions for connecting Figma Console MCP to Claude Desktop, GitHub Copilot, Cursor, Windsurf, and other AI clients."
---

# Figma Console MCP - Setup Guide

Complete setup instructions for connecting Figma Console MCP to various AI clients including Claude Desktop, GitHub Copilot (VS Code), Cursor, Windsurf, and more.

> **Quick Start:** For most users, we recommend [Remote Mode](#remote-mode-setup-recommended) with the UI-based setup method - just paste a URL, no config files needed.

---

## 🚀 Remote Mode Setup (Recommended)

### Prerequisites
- None! Just Claude Desktop installed

### Method 1: UI-Based Setup (Recommended)

This is the new, easier way to add MCP servers in Claude Desktop.

**Steps:**

1. **Open Claude Desktop Settings**
   - **macOS:** Claude menu → Settings
   - **Windows:** File menu → Settings

2. **Navigate to Connectors**
   - Click "Connectors" in the left sidebar

3. **Add Custom Connector**
   - Click "Add Custom Connector" button
   - You'll see a dialog with two fields

4. **Enter Connection Details**
   - **Name:** `Figma Console` (or any name you prefer)
   - **URL:** `https://figma-console-mcp.southleft.com/sse`
   - Click "Add"

5. **Verify Connection**
   - Look for "Figma Console" in your connectors list
   - Status should show "Connected" or "CUSTOM" badge

**That's it!** ✅

The MCP server is now connected. All Figma tools are available.

---

### Method 2: JSON Config File (Legacy Method)

> **Note:** This method still works but is more complex. Use Method 1 (UI) unless you have a specific reason to edit the config file.

**For advanced users who prefer config file editing:**

1. **Locate config file:**
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

2. **Edit the file:**
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

3. **Save and restart Claude Desktop**

4. **Verify:** Look for 🔌 icon in bottom-right showing "figma-console: connected"

---

## 🔧 Local Mode Setup (Advanced)

> **⚠️ Important:** Local mode is for advanced users who need the Figma Desktop Bridge plugin or direct console debugging. Most users should use Remote Mode.

### Prerequisites
- Node.js 18+ installed
- Figma Desktop installed
- Git installed
- Terminal access

### Installation Steps

#### 1. Install the MCP Server

```bash
# Clone the repository
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp

# Install dependencies
npm install

# Build local mode
npm run build:local
```

#### 2. Get Figma Personal Access Token

1. Visit https://www.figma.com/developers/api#access-tokens
2. Click "Get personal access token"
3. Enter description: "Figma Console MCP Local"
4. Click "Generate token"
5. **Copy the token** (you won't see it again!)

#### 3. Configure Claude Desktop (JSON Method Only)

> **Note:** Local mode MUST use JSON config method - UI method only works for remote URLs.

1. **Locate config file:**
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

2. **Edit the file:**
   ```json
   {
     "mcpServers": {
       "figma-console-local": {
         "command": "node",
         "args": ["/absolute/path/to/figma-console-mcp/dist/local.js"],
         "env": {
           "FIGMA_ACCESS_TOKEN": "figd_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
         }
       }
     }
   }
   ```

   **Important:**
   - Replace `/absolute/path/to/figma-console-mcp` with actual absolute path
   - Replace `figd_XXX...` with your actual Figma token
   - Use forward slashes `/` even on Windows

3. **Save the file**

#### 4. Restart Figma Desktop with Remote Debugging

**⚠️ CRITICAL STEP:** You MUST restart Figma with the debug flag for local mode to work.

**macOS:**
```bash
# Quit Figma completely first (Cmd+Q)
# Then run:
open -a "Figma" --args --remote-debugging-port=9222
```

**Windows (CMD or PowerShell):**
```
# Close Figma completely first (Alt+F4)
# Then run:
cmd /c "%LOCALAPPDATA%\Figma\Figma.exe" --remote-debugging-port=9222
```

#### 5. Verify Setup

1. **Check remote debugging is active:**
   - Open Chrome browser
   - Visit: http://localhost:9222
   - You should see a list of inspectable Figma pages

2. **Restart Claude Desktop**
   - Quit completely and relaunch

3. **Test the connection:**
   - Ask Claude: "Check Figma status"
   - Should show: "✅ Figma Desktop connected via port 9222"

---

## 📦 NPX Installation (Local Mode Alternative)

> **Note:** This is an alternative to Local Git installation. Both use the same code and require the same prerequisites (Node.js, Figma Desktop with debug port, Personal Access Token).

### Why Use NPX?

- ✅ No git clone required
- ✅ Automatic updates with `@latest`
- ✅ Same functionality as Local Git mode

### NPX Configuration

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["-y", "figma-console-mcp@latest"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
      }
    }
  }
}
```

**Pin to specific version** (for stability):
```json
"args": ["-y", "figma-console-mcp@1.2.4"]
```

**First run:** NPX downloads and caches the package. Subsequent runs use the cached version unless you specify `@latest`.

---

## 🤖 GitHub Copilot (VS Code)

GitHub Copilot supports MCP servers as of VS Code 1.102+. This enables all Figma Console MCP tools directly in Copilot Chat.

### Prerequisites

- VS Code 1.102 or later
- GitHub Copilot extension installed and active
- For Local Mode: Node.js 18+ and Figma Personal Access Token

### Method 1: VS Code CLI (Recommended)

The fastest way to add the MCP server:

**Remote Mode (No token required):**
```bash
code --add-mcp '{"name":"figma-console","type":"sse","url":"https://figma-console-mcp.southleft.com/sse"}'
```

**Local Mode (Full features):**
```bash
# First, create an env file for your token
echo "FIGMA_ACCESS_TOKEN=figd_YOUR_TOKEN_HERE" > ~/.figma-console-mcp.env

# Then add the server
code --add-mcp '{"name":"figma-console","command":"npx","args":["-y","figma-console-mcp@latest"],"envFile":"~/.figma-console-mcp.env"}'
```

### Method 2: Manual Configuration

Create `.vscode/mcp.json` in your project (workspace-level) or configure globally:

**Remote Mode:**
```json
{
  "servers": {
    "figma-console": {
      "type": "sse",
      "url": "https://figma-console-mcp.southleft.com/sse"
    }
  }
}
```

**Local Mode:**
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

> **Security Tip:** Use `envFile` instead of inline `env` to keep tokens out of version control. Add your mcp.json to `.gitignore`.

### Starting the Server

1. Open Command Palette (**Cmd+Shift+P** / **Ctrl+Shift+P**)
2. Run **"MCP: List Servers"**
3. Click on **"figma-console"** to start it (if showing "Stopped")
4. VS Code may prompt you to **trust the server** — click Allow

### Verify It Works

1. Open **Copilot Chat** (Cmd+Shift+I or click Copilot icon)
2. Try: *"Use the figma-console tools to get status"*
3. Copilot should now have access to all 45+ Figma tools

### Enterprise Considerations

For organizations using GitHub Enterprise:

- MCP is governed by the **"MCP servers in Copilot"** policy
- This policy is **disabled by default** for enterprise organizations
- IT admins must enable it in GitHub organization settings
- See [GitHub MCP Enterprise Docs](https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/context/mcp)

### Troubleshooting Copilot

**Server not appearing in list:**
- Run **"Developer: Reload Window"** after adding
- Check **View → Output → MCP** for error logs
- Verify VS Code version is 1.102+

**Server shows "Stopped":**
- Click on server name to start it
- Check for trust prompt notification
- Verify Node.js is installed (for local mode)

**"No Figma tools available" in chat:**
- Ensure server status shows "Running"
- Try restarting Copilot Chat
- Check that you're using Agent mode (not just Chat)

---

## What You Get With Each Mode

### Remote Mode (UI Setup)
- ✅ **All MCP tools**
- ✅ **OAuth authentication** (automatic, no token needed)
- ✅ **Design system extraction** (variables*, components, styles)
- ✅ **Console logs and screenshots**
- ✅ **Zero maintenance**
- ❌ **No Desktop Bridge plugin** (can't access local variables without Enterprise)

*Variables require Figma Enterprise plan

### Local Mode (JSON Setup)
- ✅ **All MCP tools**
- ✅ **Desktop Bridge plugin support** (access local variables, no Enterprise needed)
- ✅ **Zero-latency console debugging**
- ✅ **Reliable component descriptions** (bypasses API bugs)
- ⚠️ **Manual token management** (PAT required)
- ⚠️ **Requires Figma restart** with debug flag

**See [MODE_COMPARISON.md](MODE_COMPARISON.md) for detailed feature breakdown.**

---

## Troubleshooting

### Remote Mode Issues

**"Connection failed" in UI:**
- ✅ Check internet connection
- ✅ Try removing and re-adding the connector
- ✅ Restart Claude Desktop

**"OAuth authentication required" error:**
- ✅ This is normal for first design system tool use
- ✅ Your browser will open automatically
- ✅ Click "Allow" to authorize

**"Variables API requires Enterprise" error:**
- ✅ Expected if you don't have Enterprise plan
- ✅ Solution: Switch to Local Mode + Desktop Bridge plugin
- ✅ See [MODE_COMPARISON.md](MODE_COMPARISON.md) for details

### Local Mode Issues

**"Failed to connect to Figma Desktop":**
- ✅ Verify Figma was restarted with `--remote-debugging-port=9222`
- ✅ Visit http://localhost:9222 in Chrome - should show pages
- ✅ If blank, quit Figma and relaunch with debug flag

**"FIGMA_ACCESS_TOKEN not configured":**
- ✅ Check token is set in `claude_desktop_config.json`
- ✅ Verify no typos in token (should start with `figd_`)
- ✅ Token must be in `env` object as shown above

**"Command not found: node":**
- ✅ Install Node.js 18+ from https://nodejs.org
- ✅ Restart terminal/Claude Desktop after install
- ✅ Verify with: `node --version`

**"Module not found" errors:**
- ✅ Run `npm install` in the figma-console-mcp directory
- ✅ Run `npm run build:local` again
- ✅ Check that `dist/local.js` file exists

**"Port 9222 already in use":**
- ✅ Kill other Chrome/Figma processes using that port
- ✅ Run: `lsof -i :9222` (macOS) or check Task Manager (Windows)
- ✅ Restart Figma with debug flag

---

## Switching Between Modes

### Remote → Local

1. Remove remote connector from Claude Desktop
2. Follow Local Mode setup steps above
3. Restart Claude Desktop

### Local → Remote

1. Remove local MCP config from `claude_desktop_config.json`
2. Use UI method to add remote connector
3. Restart Claude Desktop

**You can have both configured simultaneously** (with different names like "figma-console-remote" and "figma-console-local"), but be aware they'll both appear in Claude's tool list.

---

## Next Steps

**After connecting:**

1. **Test basic tools:**
   - "Navigate to https://www.figma.com and check status"
   - "Get design variables from [your Figma file URL]"

2. **For Local Mode users - Install Desktop Bridge plugin:**
   - See [Figma Desktop Bridge README](../figma-desktop-bridge/README.md)
   - Enables variables without Enterprise API

3. **Read tool documentation:**
   - See [TOOLS.md](TOOLS.md) for all 40+ available tools
   - See [USE_CASES.md](USE_CASES.md) for example workflows

---

## Support

- 📖 [Full Documentation](../README.md)
- 🐛 [Report Issues](https://github.com/southleft/figma-console-mcp/issues)
- 💬 [Discussions](https://github.com/southleft/figma-console-mcp/discussions)
- 📊 [Mode Comparison](MODE_COMPARISON.md)
