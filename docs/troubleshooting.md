---
title: "Troubleshooting"
description: "Solutions to common issues including browser connection, console logs, screenshots, and configuration problems."
---

# Troubleshooting Guide

## Connection Drops or "Not Connected"? Start Here

> **This is the most common issue, and as of v1.31.0 it is fixed at the source.** If the bridge keeps dropping and only comes back when you close the plugin, restart your MCP client, or kill ports by hand, you were hitting **zombie MCP server processes** squatting the WebSocket port range (9223–9232) after a bad shutdown. Each fresh server got bumped to a port with no plugin attached, so status read "not connected." v1.31.0 makes those zombies impossible to create and reaps any that already exist — and the plugin now reconnects itself.

### Step 1 — Update and re-import the plugin (required, one time)

The fix lives in **both** the server and the redesigned Desktop Bridge plugin, so you need both halves:

1. **Update the package** so your MCP client launches v1.31.0+ (NPX users get it automatically on next launch; pinned versions should bump to `figma-console-mcp@1.31.0` or later).
2. **Re-import the plugin** — Figma caches plugin files at the application level, so restarting your MCP client alone will *not* pick up the new plugin UI:
   - Figma Desktop → **Plugins → Development → Import plugin from manifest…**
   - Select `~/.figma-console-mcp/plugin/manifest.json` (the stable path the server maintains automatically)
3. Run the Desktop Bridge plugin in your file. It auto-connects.

> **You only have to do this once.** After you're on v1.31.0+, future updates go back to *not* needing a re-import unless a release explicitly says so.

### Step 2 — Let it reconnect itself (no more restart ritual)

Once you're on v1.31.0+, you should rarely touch the connection again. Three things now keep it alive automatically:

- **Server-side self-healing.** Stale/zombie MCP servers are force-killed (`SIGTERM` → `SIGKILL`) on startup *and* swept every 5 minutes, so the port range stays clean. A hung shutdown can no longer leave an orphan behind.
- **Auto-reconnect watchdog.** If the plugin ever shows disconnected, it re-probes every ~12 seconds and reattaches the instant a server is available — **no restart needed**, even if you opened the plugin before your MCP client started.
- **One-click Reconnect.** The plugin's main button becomes **Reconnect** when a connection drops unexpectedly (and **Pause/Resume** when connected). Click it for an instant retry instead of reopening the plugin.

To confirm state at any time, ask your AI to run `figma_get_status` (or `figma_diagnose`). The plugin's log header also shows a live **`N server(s)`** badge — if that number is higher than the number of MCP clients you're running, you have stale processes (and the reaper will clear them).

### Last resort — manually clear leftover zombies (rarely needed)

You should only need this **once, right after upgrading**, to clear pre-v1.31.0 zombies that were already running before the new reaper existed (it cleans up on the *next* server start, but old processes from before the upgrade may still be holding ports). After that, the automatic reaper handles it.

```bash
# Kill any stale Figma Console MCP servers, then clear their port-advertisement files
pkill -f figma-console-mcp
rm -f "${TMPDIR:-/tmp}"/figma-console-mcp-*.json /tmp/figma-console-mcp-*.json
```

Then reload the Desktop Bridge plugin in Figma — the watchdog reconnects to the clean server. (Port files live in the OS temp dir, which on macOS is `$TMPDIR` → `/var/folders/…`, not `/tmp`, so both paths are listed.) To inspect what's holding the range without killing anything: `lsof -i :9223-9232 | grep LISTEN`.

---

## Common Issues and Solutions

### Issue: Claude Code OAuth Completes But Connection Fails

**Symptoms:**
- Using Claude Code with `claude mcp add --transport sse`
- OAuth opens in browser and you authorize successfully
- Connection never establishes after OAuth
- Server shows "figma-console: not connected" in `/mcp`

**Cause:**
This is a [known bug in Claude Code's HTTP/SSE transport](https://github.com/anthropics/claude-code/issues/2466). The native SSE transport doesn't properly reconnect after completing the OAuth flow.

**Solution:**
Use the `mcp-remote` package instead of Claude Code's native SSE transport:

```bash
claude mcp add figma-console -s user -- npx -y mcp-remote@latest https://figma-console-mcp.southleft.com/sse
```

Or add to `~/.claude.json` manually:

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["-y", "mcp-remote@latest", "https://figma-console-mcp.southleft.com/sse"]
    }
  }
}
```

Restart Claude Code (`/mcp` to reconnect) — mcp-remote will open a browser for OAuth, and the connection will work correctly.

**Alternative:** If you're using Claude Code, consider using [Local Mode](/setup#local-mode-setup-advanced) instead. It provides the full feature set including the Desktop Bridge plugin, and doesn't require OAuth (uses a Personal Access Token).

---

### Plugin Debugging: Simple Workflow ✅

**For Plugin Developers in Local Mode:**

> **FIRST-TIME SETUP:**
>
> 1. Open Figma Desktop normally (no special flags needed)
> 2. Go to **Plugins → Development → Import plugin from manifest...**
> 3. Select `~/.figma-console-mcp/plugin/manifest.json` (stable path created automatically by the MCP server)
> 4. Run the plugin in your Figma file — it auto-connects via WebSocket
>
> ✅ Re-importing the manifest after a package update is **optional**. Most upgrades stay wire-compatible with the previous plugin — you'll still get all functional changes. Re-import only when release notes specifically call for it (typical for plugin-side method additions), or when you want the latest cosmetic touches (status-pill copy, `pluginVersion` reporting).

### How to Verify Setup is Working

Before trying to get console logs, verify your setup:

```
"Check Figma status"
```

You should see something like:
```json
{
  "setup": {
    "valid": true,
    "message": "✅ Figma Desktop connected via WebSocket (Desktop Bridge Plugin)"
  }
}
```

If you see `"valid": false`, the AI will provide step-by-step setup instructions.

---

### WebSocket Bridge Troubleshooting

#### Plugin Shows "Disconnected"
**Cause:** MCP server is not running (it hosts the WebSocket server on ports 9223–9232).
**Fix:** Start or restart your MCP client (Claude Code, Cursor, etc.) so the MCP server process starts.

#### Plugin Not Appearing in Development Plugins
**Cause:** Plugin manifest not imported.
**Fix:** Go to Figma → Plugins → Development → Import plugin from manifest... → select `figma-desktop-bridge/manifest.json`.

#### Port 9223 Already in Use
**Cause:** Another MCP server instance or orphaned process is running on port 9223.
**Fix:** The server automatically cleans up orphaned MCP processes on startup and falls back to the next available port in the range 9223–9232. The plugin scans the whole range on launch and picks up whichever port the server bound to.

#### Plugin Shows "MCP scanning" or "Retry"
**Cause:** The MCP server is not running yet, or all ports 9223–9232 are occupied.
**Fix:** Start your MCP client (Claude Code, Cursor, etc.) so the MCP server process starts. On v1.31.0+ the plugin's watchdog keeps probing and connects on its own the moment a server appears — you don't need to restart anything. If ports are jammed by stale processes from *before* you upgraded, see [Start Here → Last resort](#last-resort--manually-clear-leftover-zombies-rarely-needed); going forward the server's reaper clears orphans on startup and every 5 minutes automatically.

#### Plugin Shows "No MCP server found"
**Cause:** The plugin scanned every port in 9223–9232 and got no response.
**Fix:** Make sure an MCP client is running with figma-console-mcp configured. Check `figma_get_status` from your AI client.

#### Orphaned MCP Processes Filling Port Range
**Cause:** MCP clients can leave orphaned MCP server processes running after tabs/windows close (a known Claude Desktop issue, and the original root cause of the recurring "not connected until restart" reports).
**Fix (v1.31.0+):** The server now force-kills orphans it finds — escalating `SIGTERM` → `SIGKILL` so even a hung process that ignores a graceful shutdown is cleared — on startup *and* on a 5-minute background sweep. A shutdown backstop also prevents a server from zombifying in the first place. In normal use you should never need to intervene. To inspect (not kill) what's holding ports: `lsof -i :9223-9232 | grep LISTEN`. To force-clear leftovers from before you upgraded, see [Start Here → Last resort](#last-resort--manually-clear-leftover-zombies-rarely-needed).

> **Stable plugin path:** The MCP server automatically copies plugin files to `~/.figma-console-mcp/plugin/` on startup. Import from this path instead of the volatile npx cache path. Re-importing after a package update is optional — only required when the release notes call for it.

#### Running in Docker
**Cause:** The WebSocket server binds to `localhost` by default, which is unreachable from the Docker host.
**Fix:** Set `FIGMA_WS_HOST=0.0.0.0` in your container environment and expose the port with `-p 9223:9223`.

#### Plugin Connected but Commands Timeout
**Cause:** Plugin may be running in a different Figma file than expected.
**Fix:** The MCP server routes commands to the active file. Make sure the Desktop Bridge Plugin is running in the file you want to work with. Use `figma_get_status` to see which file is connected.

---

### The Simplest Workflow - No Navigation Needed!

Once setup is complete, just ask your AI to check console logs:

```
"Check the last 20 console logs"
```

Then run your plugin in Figma Desktop, and ask again:

```
"Check the last 20 console logs"
```

You'll see all your `[Main]`, `[Swapper]`, `[Serializer]`, etc. plugin logs immediately:

```json
{
  "logs": [
    {
      "timestamp": 1759747593482,
      "level": "log",
      "message": "[Main] ✓ Instance Swapping: 0 swapped, 20 unmatched",
      "source": "figma"
    },
    {
      "timestamp": 1759747593880,
      "level": "log",
      "message": "[Serializer] Collected 280 variables, 144 paint styles",
      "source": "figma"
    }
  ]
}
```

**That's it!** No navigation, no browser setup, no complex configuration.

---

### Issue: No Console Logs Captured

**Symptoms:**
- `figma_get_console_logs()` returns empty array
- Log count is 0

**Possible Causes:**
1. The Desktop Bridge plugin isn't running in the file you expect
2. The plugin hasn't produced output yet
3. Logs are being filtered out by level

**Solutions:**

#### Verify the plugin is connected
```
figma_get_status()
```

`bridge.connected` should be `true`, and `bridge.file.name` should match the file you're working in.

#### Re-run the plugin in Figma
The Desktop Bridge plugin captures `console.log/warn/error/info/debug` from its own QuickJS sandbox. Open the file, run **Plugins → Development → Figma Console Desktop Bridge**, then trigger your work.

#### Check log levels
```
figma_get_console_logs({ level: 'all' })     // Everything
figma_get_console_logs({ level: 'error' })   // Only errors
figma_get_console_logs({ level: 'log' })     // Only console.log
figma_get_console_logs({ level: 'warn' })    // Only warnings
```

> **Cloud Mode note:** In Local Mode `figma_get_console_logs` reads from the Desktop Bridge plugin's QuickJS sandbox. In Cloud Mode the Cloudflare-hosted server launches a headless browser via the Browser Rendering API and captures logs from there. Plugin-sandbox logs from a paired Desktop Bridge plugin are **not** currently captured in Cloud Mode — use Local Mode for that.

---

### Issue: Screenshot Returns Empty Data

**Symptoms:**
- `figma_take_screenshot` succeeds but image is blank
- Base64 data is present but doesn't render

**Possible Causes:**
1. The target node ID is stale (node IDs are session-specific)
2. The node is off-canvas or hidden
3. The Desktop Bridge plugin isn't connected to the right file

**Solutions:**

Re-search for the node before screenshotting:
```javascript
figma_search_components({ query: 'YourComponent' })
figma_take_screenshot({ nodeId: '<fresh-id>' })
```

Verify the connected file with `figma_get_status` and make sure the node belongs to it.

---

### Issue: Claude Desktop Not Seeing Tools

**Symptoms:**
- MCP server connected but no tools visible
- Tools list is empty

**Solutions:**

#### Check Configuration

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

**Important:** URL must be exactly `https://figma-console-mcp.southleft.com/sse` (note the `/sse` endpoint).

#### Restart Claude Desktop
After changing configuration:
1. Quit Claude Desktop completely
2. Restart it
3. Check the tools menu

#### Verify mcp-remote
Make sure `mcp-remote` is installed:
```bash
npm list -g mcp-remote
```

If not installed:
```bash
npm install -g mcp-remote
```

---

## Workflow Best Practices

### Recommended Workflow

```
# 1. Verify the Desktop Bridge plugin is connected
figma_get_status()

# 2. Pull the latest plugin console output
figma_get_console_logs({ level: 'error' })

# 3. Screenshot a specific node (re-search node IDs each session)
figma_search_components({ query: 'YourComponent' })
figma_take_screenshot({ nodeId: '<id-from-search>' })

# 4. After plugin code changes, reload the plugin UI
figma_reload_plugin({ clearConsole: true })

# 5. Clear the server-side buffer between tests
figma_clear_console()
```

### Tips

**1. Always Verify the Bridge First**
- `figma_get_status` shows whether the Desktop Bridge plugin is connected and to which file
- If `bridge.connected` is `false`, open the plugin in Figma Desktop

**2. Re-search Node IDs Per Session**
- Node IDs are session-specific and become stale across conversations
- Run `figma_search_components` before screenshotting or instantiating

**3. Clear Console Between Tests**
- Prevents old logs from mixing with new ones
- `figma_clear_console()` or `figma_reload_plugin({ clearConsole: true })`

**4. Re-import the Manifest Only When Needed**
- Figma Desktop caches plugin files at the application level
- Re-importing is **optional for most updates** (wire-compatible upgrades) and only required when the release notes specifically say so (e.g. when the plugin adds new methods)
- When required: re-import `~/.figma-console-mcp/plugin/manifest.json` (Plugins → Manage plugins → re-import)

**5. Check Error Messages**
- Errors are prefixed `[figma-console-mcp]` so you can tell them apart from other MCPs
- Most include the next step to try

---

## Getting Help

If you're still experiencing issues:

1. **Check Error Message Details**
   - Error messages include specific troubleshooting steps
   - Follow the hints provided

2. **Run `figma_diagnose`**
   - Returns a structured report of mode, bridge state, OAuth status, and likely causes for common failures

3. **Verify Cloud Deployment**
   ```bash
   curl https://figma-console-mcp.southleft.com/health
   ```

4. **Report Issues**
   - GitHub Issues: https://github.com/southleft/figma-console-mcp/issues
   - Include error messages
   - Include `figma_get_status` and `figma_diagnose` output

---

## Technical Details

### Console Log Buffer

- **Size:** 1000 logs (circular buffer)
- **Capture:** Real-time via WebSocket from the Desktop Bridge plugin's QuickJS sandbox
- **Source Detection:** Plugin `console.log/warn/error/info/debug` calls are tagged with source: `figma`

### Screenshot Format

- **Formats:** PNG (lossless), JPEG (with quality control)
- **Encoding:** Base64 for easy transmission
- **Targets:** Specific node IDs via the Plugin API (`figma.getNodeByIdAsync`)

---

## Environment Variables

For local development or custom deployments:

```bash
# Log level (trace, debug, info, warn, error, fatal)
LOG_LEVEL=info

# WebSocket bridge port range (defaults to 9223)
FIGMA_WS_PORT=9223

# WebSocket bind host (set to 0.0.0.0 when running in Docker)
FIGMA_WS_HOST=localhost

# Personal Access Token for the Figma REST API (local mode only)
FIGMA_ACCESS_TOKEN=figd_xxx

# Node environment
NODE_ENV=production
```
