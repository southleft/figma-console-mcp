---
title: "Troubleshooting"
description: "Solutions to common issues including browser connection, console logs, screenshots, and configuration problems."
---

# Troubleshooting Guide

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

> **FIRST-TIME SETUP — Choose one:**
>
> **Option A: Desktop Bridge Plugin (Recommended)**
> 1. Open Figma Desktop normally (no special flags)
> 2. Go to **Plugins → Development → Import plugin from manifest...**
> 3. Select `figma-desktop-bridge/manifest.json` from the figma-console-mcp directory
> 4. Run the plugin in your Figma file — it auto-connects via WebSocket
>
> ✅ **One-time import.** The plugin stays in your Development plugins list. Just run it each session.
>
> **Option B: CDP Debug Mode (Alternative)**
> 1. Quit Figma Desktop completely (Cmd+Q on macOS / Alt+F4 on Windows)
> 2. Relaunch with remote debugging:
>    - **macOS:** `open -a "Figma" --args --remote-debugging-port=9222`
>    - **Windows:** `cmd /c "%LOCALAPPDATA%\Figma\Figma.exe" --remote-debugging-port=9222`
> 3. Verify at http://localhost:9222 — you should see inspectable pages
>
> ⚠️ You must relaunch with this flag every time you quit Figma.

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
**Cause:** MCP server is not running (it hosts the WebSocket server on port 9223).
**Fix:** Start or restart your MCP client (Claude Code, Cursor, etc.) so the MCP server process starts.

#### Plugin Not Appearing in Development Plugins
**Cause:** Plugin manifest not imported.
**Fix:** Go to Figma → Plugins → Development → Import plugin from manifest... → select `figma-desktop-bridge/manifest.json`.

#### Port 9223 Already in Use
**Cause:** Another MCP server instance is running.
**Fix:** Stop the other instance, or set the `FIGMA_WS_PORT` environment variable to a different port (note: you'll also need to update `wsPort` in the plugin's `ui.html` and `allowedDomains` in `manifest.json`).

#### Running in Docker
**Cause:** The WebSocket server binds to `localhost` by default, which is unreachable from the Docker host.
**Fix:** Set `FIGMA_WS_HOST=0.0.0.0` in your container environment and expose the port with `-p 9223:9223`.

#### Plugin Connected but Commands Timeout
**Cause:** Plugin may be running in a different Figma file than expected.
**Fix:** The MCP server routes commands to the active file. Make sure the Desktop Bridge Plugin is running in the file you want to work with. Use `figma_get_status` to see which file is connected.

#### WebSocket Works but CDP Doesn't (or Vice Versa)
**Cause:** These are independent transports. WebSocket requires the Desktop Bridge Plugin running; CDP requires the `--remote-debugging-port=9222` flag.
**Fix:** You can use either or both. The MCP server tries WebSocket first and falls back to CDP automatically.

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

### For Cloud Mode (Figma Web)

If you're using cloud mode or need to navigate to a specific file:

```javascript
figma_navigate({ url: 'https://www.figma.com/design/...' })
figma_get_console_logs({ count: 100 })
```

**How It Works:**
- Monitors main page console (Figma web app)
- Monitors all Web Worker consoles (Figma plugins)
- Automatically detects when workers are created/destroyed
- Merges all console logs into a single stream
- Tags logs with source: `'plugin'`, `'figma'`, `'page'`

**If You Still Don't See Plugin Logs:**

1. **Check timing:** Make sure you run the plugin AFTER navigating
   ```javascript
   figma_navigate({ url: '...' })
   // Now run your plugin in Figma
   figma_get_console_logs() // Should capture plugin logs
   ```

2. **Check worker count:** Use `figma_get_status()` to verify workers are detected
   ```json
   {
     "consoleMonitor": {
       "isMonitoring": true,
       "workerCount": 2  // Should be > 0 when plugin is running
     }
   }
   ```

3. **Check log levels:** Use `level: 'all'` to ensure nothing is filtered
   ```javascript
   figma_get_console_logs({ level: 'all', count: 500 })
   ```

**Technical Details:**
The MCP uses Puppeteer's Worker APIs to:
- Enumerate existing workers via `page.workers()`
- Listen for new workers via `page.on('workercreated')`
- Attach console listeners to each worker
- Tag worker logs with `source: 'plugin'`

This is the same mechanism Figma's own DevTools uses, just exposed natively through the MCP.

---

### Issue: "Browser isn't currently running"

**Symptoms:**
- Error message: "The browser isn't currently running"
- `figma_get_status` shows `browser.running: false`

**Cause:**
You haven't called `figma_navigate` yet to initialize the browser.

**Solution:**

Always start with `figma_navigate`:

```javascript
figma_navigate({ url: 'https://www.figma.com/design/your-file-id' })
```

This tool:
- Launches the headless Chrome browser
- Initializes console monitoring
- Navigates to your Figma file

Then check status:

```javascript
figma_get_status()
```

Should show:
- `browser.running: true`
- `initialized: true`
- `consoleMonitor.isMonitoring: true`

**Note:** If using the public server at `https://figma-console-mcp.southleft.com`, browser launch is handled automatically and should work without issues.

---

### Issue: "Failed to retrieve console logs"

**Symptoms:**
- Error: "Console monitor not initialized"
- Error: "Make sure to call figma_navigate first"

**Solution:**
Always use this workflow:
```
1. figma_navigate({ url: 'https://www.figma.com/design/...' })
2. Wait for success response
3. Then use figma_get_console_logs()
```

---

### Issue: Screenshot Returns Empty Data

**Symptoms:**
- Screenshot tool succeeds but image is blank
- Base64 data is present but doesn't render

**Possible Causes:**
1. Page hasn't fully loaded yet
2. Plugin UI isn't visible
3. Timing issue

**Solution:**
```
1. figma_navigate({ url: 'https://www.figma.com/design/...' })
2. Wait 2-3 seconds (automatic in figma_navigate)
3. figma_take_screenshot({ target: 'full-page' })
```

Try different targets:
- `'full-page'` - Entire page including scrollable areas
- `'viewport'` - Currently visible area
- `'plugin'` - Plugin UI only (may need to be visible first)

---

### Issue: No Console Logs Captured

**Symptoms:**
- `figma_get_console_logs()` returns empty array
- Log count is 0

**Possible Causes:**
1. Plugin hasn't executed yet
2. Plugin doesn't produce console output
3. Logs are being filtered out

**Solutions:**

#### Check Plugin Execution
```
1. figma_navigate({ url: 'https://www.figma.com/design/...' })
2. Interact with the plugin in Figma
3. figma_get_console_logs({ level: 'all' })
```

#### Check Log Levels
Try different level filters:
```
figma_get_console_logs({ level: 'all' })     // Everything
figma_get_console_logs({ level: 'error' })   // Only errors
figma_get_console_logs({ level: 'log' })     // Only console.log
figma_get_console_logs({ level: 'warn' })    // Only warnings
```

#### Check Timing
```
1. figma_navigate({ url: '...' })
2. figma_get_status()  // Check log count
3. If logCount > 0, logs are being captured
```

---

### Issue: "Connection timed out" or Network Errors

**Symptoms:**
- Claude Desktop shows connection timeout
- Tools take very long to respond
- Intermittent failures

**Possible Causes:**
1. Cloudflare Workers cold start
2. Browser initialization takes time
3. Figma page load is slow

**Solutions:**

#### Allow More Time
The first call to `figma_navigate` can take 10-30 seconds:
- Browser needs to launch
- Figma needs to load
- Console monitoring needs to initialize

Just wait - subsequent calls will be faster!

#### Use figma_get_status
This is a lightweight call that doesn't require browser initialization:
```
figma_get_status()  // Fast, shows current state
```

#### Check Server Health
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
# 1. Start session
figma_navigate({ url: 'https://www.figma.com/design/your-file' })

# 2. Check initial state
figma_get_status()

# 3. Work with plugin, then check logs
figma_get_console_logs({ level: 'error' })

# 4. Capture UI state
figma_take_screenshot({ target: 'plugin' })

# 5. Make code changes, reload
figma_reload_plugin({ clearConsole: true })

# 6. Clear for next test
figma_clear_console()
```

### Tips

**1. Always Navigate First**
- `figma_navigate` must be the first call
- It initializes everything
- Subsequent calls will fail without it

**2. Use figma_get_status for Health Checks**
- Lightweight and fast
- Shows browser state
- Shows log count without retrieving logs

**3. Clear Console Between Tests**
- Prevents old logs from mixing with new ones
- `figma_clear_console()` or `figma_reload_plugin({ clearConsole: true })`

**4. Be Patient on First Call**
- Browser launch takes time
- First navigation is slowest
- Subsequent operations are faster

**5. Check Error Messages**
- Error messages include helpful hints
- Often suggest the next step to try
- Include troubleshooting tips

---

## Getting Help

If you're still experiencing issues:

1. **Check Error Message Details**
   - Error messages include specific troubleshooting steps
   - Follow the hints provided

2. **Verify Deployment**
   ```bash
   curl https://figma-console-mcp.southleft.com/health
   ```

3. **Check Cloudflare Status**
   - Visit status.cloudflare.com
   - Browser Rendering API status

4. **Report Issues**
   - GitHub Issues: https://github.com/southleft/figma-console-mcp/issues
   - Include error messages
   - Include steps to reproduce
   - Include figma_get_status output

---

## Technical Details

### Browser Session Lifecycle

1. **First Call to figma_navigate:**
   - Launches Puppeteer browser (10-15s)
   - Initializes console monitoring
   - Navigates to Figma URL
   - Starts capturing logs

2. **Subsequent Calls:**
   - Reuse existing browser instance
   - Much faster (1-2s)
   - Logs accumulated in circular buffer

3. **Session Timeout:**
   - Browser kept alive for 10 minutes
   - After timeout, automatically relaunches on next call

### Console Log Buffer

- **Size:** 1000 logs (configurable)
- **Type:** Circular buffer (oldest logs dropped when full)
- **Capture:** Real-time via Chrome DevTools Protocol
- **Source Detection:** Automatically identifies plugin vs Figma logs

### Screenshot Format

- **Formats:** PNG (lossless), JPEG (with quality control)
- **Encoding:** Base64 for easy transmission
- **Targets:**
  - `full-page`: Entire page with scrollable content
  - `viewport`: Currently visible area only
  - `plugin`: Plugin iframe only (experimental)

---

## Environment Variables

For local development or custom deployments:

```bash
# Log level (trace, debug, info, warn, error, fatal)
LOG_LEVEL=info

# Configuration file location
FIGMA_CONSOLE_CONFIG=/path/to/config.json

# Node environment
NODE_ENV=production
```

---

## Advanced Configuration

Create `~/.config/figma-console-mcp/config.json`:

```json
{
  "browser": {
    "headless": true,
    "args": ["--disable-blink-features=AutomationControlled"]
  },
  "console": {
    "bufferSize": 2000,
    "filterLevels": ["log", "info", "warn", "error", "debug"],
    "truncation": {
      "maxStringLength": 1000,
      "maxArrayLength": 20,
      "maxObjectDepth": 5
    }
  },
  "screenshots": {
    "defaultFormat": "png",
    "quality": 95
  }
}
```

**Note:** Custom configuration is optional. The public server at `https://figma-console-mcp.southleft.com` uses sensible defaults that work for most use cases.
