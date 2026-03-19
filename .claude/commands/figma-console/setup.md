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

Automated setup for the figma-console-mcp server. Detects platform and shell, checks prerequisites, configures the token, registers the MCP server, and guides Desktop Bridge plugin installation.

## Phase 1: Environment Scan

Run all of these checks in parallel — they have no dependencies on each other:

```bash
uname -s                                                          # Platform
echo $SHELL                                                       # Shell (zsh, bash, fish)
node --version                                                    # Node.js
ls /Applications/Figma.app 2>/dev/null                            # Figma Desktop (macOS)
echo "${FIGMA_ACCESS_TOKEN:+set (${#FIGMA_ACCESS_TOKEN} chars)}"  # Token
ls ~/.figma-console-mcp/plugin/manifest.json 2>/dev/null          # Plugin path
ls src/local.ts 2>/dev/null                                       # Local clone?
```

Map results:
- **Platform:** `Darwin` = macOS, `MINGW*`/`MSYS*` = Windows. If `Linux`, inform user that Figma Desktop is not available on Linux — they can use Remote Mode (read-only) but not the full local setup.
- **Shell profile:** zsh → `~/.zshrc`, bash → `~/.bashrc`, fish → `~/.config/fish/config.fish`, PowerShell → `$PROFILE`
- **Node.js:** must be 18+. If missing, link to https://nodejs.org. If installed via nvm, warn that MCP clients launch in non-interactive shells — recommend using the absolute path to npx (e.g., `~/.nvm/versions/node/v20.x.x/bin/npx`) or installing Node globally via Homebrew/official installer.
- **Figma Desktop:** required. If missing, link to https://www.figma.com/downloads/

Present a summary of what's ready and what needs action before continuing.

## Phase 2: Token Setup

If `FIGMA_ACCESS_TOKEN` is not set:

1. Go to Figma > Settings > Personal access tokens (or https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens)
2. Create a token with description "Figma Console MCP"
3. Copy it (starts with `figd_`)
4. Add to shell profile (use the shell detected in Phase 1):
   - **zsh:** `echo 'export FIGMA_ACCESS_TOKEN=figd_XXXXX' >> ~/.zshrc && source ~/.zshrc`
   - **bash:** `echo 'export FIGMA_ACCESS_TOKEN=figd_XXXXX' >> ~/.bashrc && source ~/.bashrc`
   - **fish:** `set -Ux FIGMA_ACCESS_TOKEN figd_XXXXX`
   - **PowerShell:** `[Environment]::SetEnvironmentVariable('FIGMA_ACCESS_TOKEN', 'figd_XXXXX', 'User')`

After setting the token, verify it's available: `echo $FIGMA_ACCESS_TOKEN`

## Phase 3: Configure MCP Server

Check all common config locations in parallel — don't ask the user which client they use, just check:

- `~/.claude.json` (Claude Code)
- `~/Library/Application Support/Claude/claude_desktop_config.json` (Claude Desktop macOS)
- `%APPDATA%\Claude\claude_desktop_config.json` (Claude Desktop Windows)
- `.cursor/mcp.json` (Cursor)
- `.vscode/mcp.json` (VS Code / Copilot)

Report which configs exist and whether `figma-console` is already registered.

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

`ENABLE_MCP_APPS` enables the Token Browser and Design System Dashboard UI apps — harmless if the client doesn't support MCP Apps.

`${FIGMA_ACCESS_TOKEN}` is a literal string for MCP hosts that support env passthrough (Claude Code, Cursor). Claude Desktop does not — for that client, the actual token value must go in the JSON.

For **Claude Code**, the fastest method is the CLI command — but only run this after confirming the token is set:
```bash
claude mcp add figma-console -s user -e FIGMA_ACCESS_TOKEN=${FIGMA_ACCESS_TOKEN} -e ENABLE_MCP_APPS=true -- npx -y figma-console-mcp@latest
```

**Local clone:** If Phase 1 detected `src/local.ts`, offer the local build instead:
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

**After configuring, tell the user to restart their MCP client now.** This starts the MCP server for the first time and creates the plugin directory at `~/.figma-console-mcp/plugin/`.

## Phase 4: Desktop Bridge Plugin

The plugin is required for write access and variable management.

**Primary path:** `~/.figma-console-mcp/plugin/manifest.json` (auto-created on first MCP server run). On Windows: `%USERPROFILE%\.figma-console-mcp\plugin\manifest.json`.

**Fallback (local clone only):** `<repo>/figma-desktop-bridge/manifest.json` — use this only if the user hasn't run the server yet and is working from a clone.

Import in Figma:
1. Open Figma Desktop
2. Plugins > Development > Import plugin from manifest...
3. Navigate to the manifest path above
4. Click Open

The plugin uses a bootloader — once imported, it auto-updates when the MCP server updates. No need to re-import.

## Phase 5: Verify

Guide the user to test:
1. Open a Figma file and run the Desktop Bridge plugin (Plugins > Development > Figma Desktop Bridge)
2. Ask Claude: "Check Figma status"
3. Try: "Search for button components" or "Create a simple frame"

## Troubleshooting Quick Reference

| Symptom | Fix |
|---------|-----|
| Token not recognized after adding to shell | Open a new terminal or source the profile for your shell |
| "FIGMA_ACCESS_TOKEN not configured" | Token not in env — check `echo $FIGMA_ACCESS_TOKEN` |
| `command not found: npx` from MCP client | Node installed via nvm — use absolute npx path or install Node globally |
| Plugin not in Figma menu | Re-import manifest, then Plugins > Development > Refresh plugin list |
| WebSocket connection failed | Ensure MCP server is running; check ports 9223-9232 |
| "No plugin UI found" | Plugin must be open in Figma while using tools |
