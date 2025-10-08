# Local Mode Setup - For Plugin Developers

Local mode connects directly to Figma Desktop for **zero-latency console log capture** during plugin development. This is only recommended for advanced users who are developing Figma plugins.

> **Most users should use Cloud Mode instead** - See [README.md](README.md) for quick installation.

## Why Local Mode?

**Use Local Mode when:**
- Developing Figma plugins and need instant console log feedback
- You want zero network latency for debugging
- Working on plugin code that requires rapid iteration

**Use Cloud Mode when:**
- Extracting design system data (variables, components, styles)
- Working remotely or collaborating with teams
- You don't need real-time console monitoring

## Prerequisites

- **Figma Desktop** installed (not Figma web)
- **Node.js** >= 18.0.0
- **FIGMA_ACCESS_TOKEN** for API data extraction tools ([Get your token](https://www.figma.com/developers/api#access-tokens))

## Installation Steps

### Step 1: Clone and Build

```bash
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp
npm install
npm run build:local
```

### Step 2: Launch Figma with Remote Debugging

**macOS:**
```bash
./scripts/launch-figma-debug.sh
```

Or manually:
```bash
open -a "Figma" --args --remote-debugging-port=9222
```

**Windows:**
```bash
start figma://--remote-debugging-port=9222
```

**Linux:**
```bash
figma --remote-debugging-port=9222
```

### Step 3: Enable Developer VM

In Figma Desktop:
1. Open **Plugins → Development**
2. Enable **"Use Developer VM"**

This ensures plugin code runs in a monitored environment where console logs can be captured.

### Step 4: Configure Your MCP Client

<details>
<summary><b>Claude Code</b></summary>

**One-line install:**

```bash
claude mcp add figma-console --env FIGMA_ACCESS_TOKEN=figd_your_token_here -- node /path/to/figma-console-mcp/dist/local.js
```

**Important:**
- Replace `/path/to/figma-console-mcp` with your actual path to the cloned repository
- Replace `figd_your_token_here` with your actual Figma access token

**Verify:**
```bash
claude mcp list
```

Should show `figma-console: connected`

**Optional environment variables:**

If you need to customize the debug port or host:

```bash
claude config edit
```

Add to the `figma-console` entry:
```json
{
  "mcpServers": {
    "figma-console": {
      "command": "node",
      "args": ["/path/to/figma-console-mcp/dist/local.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_your_token_here",
        "FIGMA_DEBUG_PORT": "9222",
        "FIGMA_DEBUG_HOST": "localhost"
      }
    }
  }
}
```

</details>

<details>
<summary><b>Claude Desktop</b></summary>

**Location:** `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows)

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "node",
      "args": ["/absolute/path/to/figma-console-mcp/dist/local.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_your_token_here",
        "FIGMA_DEBUG_PORT": "9222",
        "FIGMA_DEBUG_HOST": "localhost"
      }
    }
  }
}
```

**Important:**
- Replace `/absolute/path/to/figma-console-mcp` with your actual path!
- Replace `figd_your_token_here` with your actual Figma access token

</details>

<details>
<summary><b>Other MCP Clients</b></summary>

Use the same configuration pattern:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/figma-console-mcp/dist/local.js"],
  "env": {
    "FIGMA_ACCESS_TOKEN": "figd_your_token_here",
    "FIGMA_DEBUG_PORT": "9222",
    "FIGMA_DEBUG_HOST": "localhost"
  }
}
```

Consult your MCP client's documentation for the specific configuration file location.

</details>

### Step 5: Test Connection

```bash
# Verify Figma debug port is accessible
curl http://localhost:9222/json/version
```

You should see JSON with browser version info.

In your MCP client:
- Look for "🔌" indicator or MCP connection status
- All 14 Figma tools should be available
- Test with: "Navigate to https://www.figma.com and check status"

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FIGMA_ACCESS_TOKEN` | - | Your Figma API token (required for API tools) |
| `FIGMA_DEBUG_HOST` | `localhost` | Debug host for Figma Desktop |
| `FIGMA_DEBUG_PORT` | `9222` | Debug port for Figma Desktop |

## Troubleshooting

### Error: "Failed to connect to Figma Desktop"

1. Verify Figma Desktop is running
2. Check it was launched with `--remote-debugging-port=9222`
3. Test port accessibility: `curl http://localhost:9222/json/version`
4. Ensure no firewall is blocking port 9222
5. Try restarting Figma Desktop with the debug flag

### Error: "No console logs captured"

1. Enable "Use Developer VM" in Figma (Plugins → Development)
2. Make sure your plugin is actually running
3. Navigate to a Figma file with your plugin active
4. Check `figma_get_status` - should show `consoleMonitor.isMonitoring: true`
5. Try console.log("test") in your plugin code

### Port 9222 Already in Use

If another application is using port 9222:

```bash
# Find what's using the port (macOS/Linux)
lsof -i :9222

# Kill the process if needed
kill -9 <PID>

# Or use a different port
FIGMA_DEBUG_PORT=9223 node dist/local.js
```

Then launch Figma with the same port:
```bash
open -a "Figma" --args --remote-debugging-port=9223
```

## Key Benefits of Local Mode

- ✅ **Native Console Log Capture** - Directly captures plugin console logs via Chrome DevTools Protocol
- ✅ **Zero Latency** - No network round trips, instant response
- ✅ **Free** - No Cloudflare costs, runs entirely on your machine
- ✅ **Live Debugging** - Monitor console logs in real-time as your plugin executes
- ✅ **Perfect for Development** - Ideal workflow for plugin development and testing

## Architecture

Local mode uses Chrome DevTools Protocol to connect to Figma Desktop:

```
AI Assistant → MCP Server (local.js) →
Chrome DevTools Protocol (port 9222) →
Figma Desktop → Your Plugin
```

This direct connection provides:
- Real-time console log streaming
- Screenshot capture from Figma Desktop
- Full access to all 14 MCP tools
- Zero-latency debugging experience

## Next Steps

Once connected, try these prompts:
- "Navigate to my Figma plugin and show me any console errors"
- "Watch the console logs for 30 seconds while I test my plugin"
- "Take a screenshot of the current Figma canvas"

See [README.md](README.md#example-prompts) for more examples.
