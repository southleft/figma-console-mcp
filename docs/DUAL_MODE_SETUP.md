# Figma Console MCP - Dual Mode Setup Guide

This MCP server supports two deployment modes:

1. **Local Mode** - Connects to Figma Desktop via Chrome Remote Debugging Protocol
2. **Cloudflare Mode** - Deploys to Cloudflare Workers with Browser Rendering API

Both modes provide **identical tools** for accessing Figma console logs, screenshots, and API data.

---

## Local Mode Setup

### Prerequisites

1. **Figma Desktop** installed
2. **Node.js** >= 18.0.0
3. **FIGMA_ACCESS_TOKEN** environment variable (for API access)

### Step 1: Launch Figma Desktop with Remote Debugging

**macOS:**
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

### Step 2: Enable Developer VM

In Figma Desktop:
1. Go to **Plugins → Development**
2. Enable **"Use Developer VM"**

This ensures plugin code runs in a Web Worker that we can monitor.

### Step 3: Install and Build

```bash
npm install
npm run build:local
```

### Step 4: Configure MCP Client

Add to your MCP client configuration (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "node",
      "args": ["/absolute/path/to/figma-console-mcp/dist/local.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "your-figma-access-token-here",
        "FIGMA_DEBUG_PORT": "9222",
        "FIGMA_DEBUG_HOST": "localhost"
      }
    }
  }
}
```

### Step 5: Test Connection

```bash
# Test if Figma Desktop debug port is accessible
curl http://localhost:9222/json/version
```

You should see JSON output with browser version info.

### Local Mode Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FIGMA_ACCESS_TOKEN` | - | **Required**. Your Figma API token |
| `FIGMA_DEBUG_HOST` | `localhost` | Debug host for Figma Desktop |
| `FIGMA_DEBUG_PORT` | `9222` | Debug port for Figma Desktop |

---

## Cloudflare Mode Setup

### Prerequisites

1. **Cloudflare account** with Workers plan
2. **Browser Rendering API** enabled
3. **Wrangler CLI** installed

### Step 1: Install Dependencies

```bash
npm install
```

### Step 2: Configure Cloudflare

Update `wrangler.jsonc` with your credentials:

```jsonc
{
  "name": "figma-console-mcp",
  "main": "dist/cloudflare/index.js",
  "compatibility_date": "2024-01-01",
  "browser": {
    "binding": "BROWSER"
  },
  "vars": {
    "FIGMA_ACCESS_TOKEN": "your-figma-access-token-here"
  }
}
```

### Step 3: Build and Deploy

```bash
npm run build:cloudflare
npm run deploy
```

### Step 4: Connect MCP Client

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "figma-console": {
      "url": "https://your-worker.your-subdomain.workers.dev/sse",
      "transport": "sse"
    }
  }
}
```

---

## Development Workflow

### Local Development

```bash
# Run local server with auto-reload
npm run dev:local

# Build local mode only
npm run build:local

# Type check
npm run type-check
```

### Cloudflare Development

```bash
# Run Cloudflare Workers dev server
npm run dev

# Build Cloudflare mode only
npm run build:cloudflare

# Deploy to production
npm run deploy
```

### Build Both Modes

```bash
# Build both local and Cloudflare versions
npm run build
```

---

## Available Tools

Both modes provide the same 11 MCP tools:

### Console Tools
- `figma_get_console_logs` - Retrieve console logs
- `figma_clear_console` - Clear console buffer
- `figma_watch_console` - Watch console in real-time (future)

### Browser Tools
- `figma_navigate` - Navigate to Figma URL
- `figma_reload_plugin` - Reload current page
- `figma_take_screenshot` - Capture screenshots
- `figma_get_status` - Get browser/monitor status

### Figma API Tools
- `figma_get_file_data` - Get file structure and nodes
- `figma_get_variables` - Get design tokens/variables
- `figma_get_component` - Get component data
- `figma_get_styles` - Get file styles

---

## Architecture

### Shared Core Modules

Both modes share the same core logic:

```
src/core/
  ├── console-monitor.ts   # Console log capture
  ├── figma-api.ts        # Figma REST API client
  ├── figma-tools.ts      # MCP tool registration
  ├── config.ts           # Configuration management
  └── logger.ts           # Structured logging
```

### Mode-Specific Implementations

Each mode has its own browser manager:

```
src/browser/
  ├── base.ts             # IBrowserManager interface
  ├── local.ts            # LocalBrowserManager (puppeteer-core)
  └── cloudflare.ts       # CloudflareBrowserManager (@cloudflare/puppeteer)
```

### Entry Points

- `src/local.ts` - Local mode entry (stdio transport)
- `src/index.ts` - Cloudflare mode entry (SSE/HTTP transport)

---

## Troubleshooting

### Local Mode Issues

**Error: "Failed to connect to Figma Desktop"**

1. Verify Figma Desktop is running
2. Check it was launched with `--remote-debugging-port=9222`
3. Test port accessibility: `curl http://localhost:9222/json/version`
4. Ensure no firewall is blocking port 9222

**Error: "No console logs captured"**

1. Ensure "Use Developer VM" is enabled in Figma
2. Navigate to a Figma file with an active plugin
3. Check that plugin is actually running (check Figma's Dev console)

### Cloudflare Mode Issues

**Error: "BROWSER binding not found"**

1. Ensure Browser Rendering API is enabled in Cloudflare dashboard
2. Verify `wrangler.jsonc` has correct `browser` binding
3. Check Cloudflare account has Workers Paid plan

**Error: "FIGMA_ACCESS_TOKEN not configured"**

1. Add token to `wrangler.jsonc` vars section
2. Or set as Cloudflare Worker secret: `wrangler secret put FIGMA_ACCESS_TOKEN`

---

## Performance Comparison

| Feature | Local Mode | Cloudflare Mode |
|---------|------------|-----------------|
| **Latency** | ~10ms (local) | ~50-200ms (network) |
| **Browser** | Your Figma Desktop | Cloudflare Browser API |
| **Cost** | Free | Workers Paid plan required |
| **Use Case** | Development, debugging | Production, remote access |
| **Plugin Access** | Direct to running plugins | Must navigate to URL |

---

## Next Steps

- **Phase 4**: Refactor to shared base server class
- **Phase 5**: Implement real-time console streaming
- **Phase 6**: Add plugin interaction tools (click, input)

---

## License

MIT
