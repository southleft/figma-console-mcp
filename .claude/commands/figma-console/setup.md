---
skill: figma-console:setup
type: local
title: Figma Console MCP Setup
description: >
  Set up the Figma Console MCP server for any user on macOS or Windows.
  Use when the user wants to install, configure, or connect figma-console-mcp,
  asks "how do I set up the Figma MCP", "connect Figma to Claude", "install figma-console-mcp",
  or mentions needing to configure a Figma token, Desktop Bridge plugin, or MCP server config.
  Also use when troubleshooting setup issues like missing tokens or broken connections.
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
---

# Figma Console MCP Setup

Automated setup for the figma-console-mcp server. Detects the user's platform, checks prerequisites, configures the token, registers the MCP server, and guides Desktop Bridge plugin installation.

## Setup Flow

Run these checks in order. Skip any step that's already satisfied — tell the user what's already done.

### 1. Detect Platform

```bash
uname -s
```

- `Darwin` = macOS — shell profile is `~/.zshrc`
- `MINGW*` / `MSYS*` / Windows = Windows — shell profile is PowerShell `$PROFILE`

### 2. Check Prerequisites

**Node.js 18+:**
```bash
node --version
```
If missing or < 18, tell the user to install from https://nodejs.org.

**Figma Desktop:** Check if installed:
- macOS: `ls /Applications/Figma.app 2>/dev/null`
- Windows: check common install paths or ask the user

If missing, link to https://www.figma.com/downloads/.

### 3. Check FIGMA_ACCESS_TOKEN

```bash
echo "${FIGMA_ACCESS_TOKEN:+set (${#FIGMA_ACCESS_TOKEN} chars)}"
```

**If set:** Confirm and move on.

**If not set:** Guide the user:

1. Go to Figma > Settings > Personal access tokens (or https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens)
2. Create a token with description "Figma Console MCP"
3. Copy it (starts with `figd_`)
4. Add to shell profile:
   - **macOS:** `echo 'export FIGMA_ACCESS_TOKEN=figd_XXXXX' >> ~/.zshrc && source ~/.zshrc`
   - **Windows PowerShell:** `[Environment]::SetEnvironmentVariable('FIGMA_ACCESS_TOKEN', 'figd_XXXXX', 'User')`

**Do NOT hardcode the token in any project file or MCP config.** It lives in the user's environment only.

### 4. Configure MCP Server

Check if figma-console-mcp is already registered. The config can live in several places depending on the MCP client:

- **Claude Code:** `~/.claude.json` (look for `mcpServers.figma-console`)
- **Claude Desktop (macOS):** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Claude Desktop (Windows):** `%APPDATA%\Claude\claude_desktop_config.json`
- **Cursor:** `.cursor/mcp.json` in project or user dir
- **VS Code (Copilot):** `.vscode/mcp.json` or user settings

Ask the user which client(s) they use, then check the relevant config.

**If not configured**, the recommended config is:

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["-y", "figma-console-mcp@latest"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "${FIGMA_ACCESS_TOKEN}",
        "ENABLE_MCP_APPS": "true"
      }
    }
  }
}
```

For **Claude Code specifically**, the fastest method is the CLI command:
```bash
claude mcp add figma-console -s user -e FIGMA_ACCESS_TOKEN=${FIGMA_ACCESS_TOKEN} -e ENABLE_MCP_APPS=true -- npx -y figma-console-mcp@latest
```

**Local clone detection:** If the current working directory contains `figma-console-mcp` source (check for `src/local.ts`), offer to use the local build instead:
```json
{
  "command": "node",
  "args": ["<repo-path>/dist/local.js"],
  "env": {
    "FIGMA_ACCESS_TOKEN": "${FIGMA_ACCESS_TOKEN}",
    "ENABLE_MCP_APPS": "true"
  }
}
```
Remind them to run `npm run build:local` first.

### 5. Desktop Bridge Plugin

The plugin is required for write access and variable management. The MCP server auto-copies plugin files to `~/.figma-console-mcp/plugin/` on first run.

**Check if the stable path exists:**
```bash
ls ~/.figma-console-mcp/plugin/manifest.json 2>/dev/null
```

**If it exists:** Tell the user to import it in Figma:
1. Open Figma Desktop
2. Plugins > Development > Import plugin from manifest...
3. Navigate to `~/.figma-console-mcp/plugin/manifest.json`
4. Click Open

**If it doesn't exist yet:** The path is created on first MCP server startup. Tell the user:
1. Restart their MCP client so the server runs once
2. Then import from `~/.figma-console-mcp/plugin/manifest.json`

Alternative: if in a local clone, they can import from `<repo>/figma-desktop-bridge/manifest.json`.

The plugin uses a bootloader — once imported, it auto-updates when the MCP server updates. No need to re-import.

### 6. Verify

Guide the user to test:
1. Restart their MCP client
2. Open a Figma file and run the Desktop Bridge plugin
3. Ask Claude: "Check Figma status"
4. Try: "Search for button components" or "Create a simple frame"

## Troubleshooting Quick Reference

| Symptom | Fix |
|---------|-----|
| Token not recognized after adding to shell | `source ~/.zshrc` or open new terminal |
| "FIGMA_ACCESS_TOKEN not configured" | Token not in env — check `echo $FIGMA_ACCESS_TOKEN` |
| Plugin not in Figma menu | Re-import manifest, then Plugins > Development > Refresh plugin list |
| WebSocket connection failed | Ensure MCP server is running; check ports 9223-9232 |
| "No plugin UI found" | Plugin must be open in Figma while using tools |
