# Claude Code Setup Guide

## Issue: "Error: fetch failed" when using Figma Console MCP

If you're seeing this error when trying to use Figma Console MCP tools in Claude Code:

```
⏺ figma-console - figma_get_console_logs (MCP)(count: 100, level: "all")
  ⎿  Error: fetch failed
```

This means Claude Code can see the tools but can't connect to the server.

## Solution: Configure Claude Code MCP

Claude Code uses a different configuration file than Claude Desktop.

### Step 1: Create or Edit `~/.claude.json`

**Location:** `~/.claude.json` (in your home directory)

```bash
# Create the file if it doesn't exist
touch ~/.claude.json

# Or edit it
code ~/.claude.json  # VS Code
vim ~/.claude.json   # Vim
nano ~/.claude.json  # Nano
```

### Step 2: Add Figma Console MCP Configuration

**Add this to `~/.claude.json`:**

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

**Important notes:**
- Use `-y` flag for `npx` to auto-confirm package installation
- URL must end with `/sse` (Server-Sent Events endpoint)
- Exact URL: `https://figma-console-mcp.southleft.com/sse`

### Step 3: Restart Claude Code

After saving the config:

1. **Quit Claude Code completely** (not just close the window)
2. **Restart Claude Code**
3. Wait for MCP servers to initialize (look for 🔌 indicator)

### Step 4: Verify Connection

Test if it's working:

```
Ask Claude Code: "What's the status of the Figma Console MCP?"
```

Expected response:
- Should call `figma_get_status()` successfully
- Should show browser state (even if not initialized yet)
- No "fetch failed" errors

## Alternative: Project-Scoped Configuration

If you want to configure MCP per-project instead of globally:

**Create `.mcp.json` in your project root:**

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

This makes the configuration shareable with your team via git.

## Troubleshooting

### Still Getting "fetch failed"?

**1. Check npx is installed:**
```bash
npx --version
```

If not installed:
```bash
npm install -g npx
```

**2. Test mcp-remote manually:**
```bash
npx -y mcp-remote https://figma-console-mcp.southleft.com/sse
```

Should connect and show "Listening for messages..."

**3. Check server is reachable:**
```bash
curl https://figma-console-mcp.southleft.com/health
```

Should return:
```json
{
  "status": "healthy",
  "service": "Figma Console MCP",
  "version": "0.1.0",
  "endpoints": ["/sse", "/mcp", "/test-browser"]
}
```

**4. Verify Claude Code can access network:**

Check if Claude Code has network permissions (firewall, VPN, proxy settings).

**5. Try without mcp-remote (direct connection):**

Some users report issues with `mcp-remote`. Try direct SSE:

```json
{
  "mcpServers": {
    "figma-console": {
      "url": "https://figma-console-mcp.southleft.com/sse",
      "transport": "sse"
    }
  }
}
```

**Note:** This syntax may vary based on Claude Code version. Check docs.

### "The Figma Console MCP server isn't configured or running"

This error means Claude Code can't find `~/.claude.json` or the config is invalid.

**Verify:**
```bash
# Check file exists
ls -la ~/.claude.json

# Check file contents
cat ~/.claude.json

# Validate JSON syntax
python3 -m json.tool ~/.claude.json
```

**Common JSON errors:**
- Missing commas
- Trailing commas
- Unescaped quotes
- Wrong brackets

### Tools visible but all calls fail

If Claude Code shows the tools but every call fails:

1. **Restart Claude Code completely**
2. **Clear Claude Code cache** (if option available)
3. **Check Claude Code logs** for connection errors
4. **Test with a simpler tool first** (like `figma_get_status`)

## Usage Once Connected

After successful setup, you can use Figma Console MCP like this:

### 1. Navigate to Figma
```
"Navigate to https://www.figma.com/design/abc123 and check for errors"
```

### 2. Check Console Logs
```
"Show me the latest console errors from Figma"
```

### 3. Take Screenshot
```
"Take a screenshot of the current Figma page"
```

### 4. Debug Plugin
```
"Monitor console logs while I test the plugin, then show me any errors"
```

## Configuration Priority

If you have MCP servers configured in multiple locations:

**Priority order:**
1. Local project `.mcp.json` (highest priority)
2. User home `~/.claude.json`
3. Claude Code built-in servers (lowest priority)

Local configs override global ones for the same server name.

## Common Mistakes

❌ **Wrong file location:**
- NOT: `.claude.json` (in project)
- YES: `~/.claude.json` (in home)

❌ **Wrong URL:**
- NOT: `https://figma-console-mcp.southleft.com`
- YES: `https://figma-console-mcp.southleft.com/sse`

❌ **Missing `-y` flag:**
- NOT: `["mcp-remote", "..."]`
- YES: `["-y", "mcp-remote", "..."]`

❌ **Didn't restart:**
- Must fully quit and restart Claude Code
- Reloading window is not enough

## Complete Working Example

**File: `~/.claude.json`**

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

**Test workflow:**

1. Save the file
2. Quit Claude Code completely
3. Restart Claude Code
4. Ask: "What Figma tools are available?"
5. Should list all 7 tools
6. Ask: "Check Figma status"
7. Should call `figma_get_status()` without errors

## Need Help?

If you're still having issues:

1. **Check the logs** - Look for MCP connection errors in Claude Code
2. **Test the server** - Visit https://figma-console-mcp.southleft.com/test-browser
3. **Report issue** - https://github.com/southleft/figma-console-mcp/issues

Include:
- Your `~/.claude.json` config (redact sensitive info)
- Error messages from Claude Code
- Output of `npx -y mcp-remote https://figma-console-mcp.southleft.com/sse`
- OS and Claude Code version

---

**Quick Reference:**

| Item | Value |
|------|-------|
| Config file | `~/.claude.json` |
| Server URL | `https://figma-console-mcp.southleft.com/sse` |
| Command | `npx` |
| Args | `["-y", "mcp-remote", "https://figma-console-mcp.southleft.com/sse"]` |
| Restart required | Yes (full quit + restart) |
