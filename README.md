# Figma Console MCP

> MCP server that enables AI coding assistants to access Figma plugin console logs and screenshots in real-time.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare)](https://workers.cloudflare.com/)
[![Live Demo](https://img.shields.io/badge/Demo-Live-success)](https://figma-console-mcp.southleft.com/health)

## Overview

Figma Console MCP is a [Model Context Protocol](https://modelcontextprotocol.io/) server that bridges AI coding assistants (like Claude Desktop and Cursor) to Figma's runtime environment. It enables autonomous debugging of Figma plugins by providing:

- **Real-time console log access** from Figma plugins and files
- **Automated screenshot capture** of Figma UI and plugins
- **Direct visibility** into Figma execution state
- **Zero-friction debugging** workflow (no copy-paste needed)
- **Cloudflare Workers deployment** with Browser Rendering API

## Live Demo

**Production server:** https://figma-console-mcp.southleft.com

Try the diagnostic test: [https://figma-console-mcp.southleft.com/test-browser](https://figma-console-mcp.southleft.com/test-browser)

## Quick Start

### Option 1: Use Our Public Server (Fastest)

Connect directly to our hosted instance:

**Claude Desktop (`~/.config/Claude/claude_desktop_config.json`):**
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

**Cursor, Cline, Zed, etc:**
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

Restart your MCP client to see the 11 Figma tools become available.

### Option 2: Deploy Your Own Instance

[![Deploy to Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/southleft/figma-console-mcp)

Or via command line:

```bash
# Clone and install
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp
npm install

# Deploy to Cloudflare Workers
npm run deploy
```

**Requirements:**
- Cloudflare account (free or paid)
- Wrangler CLI (installed via `npm install`)
- `@cloudflare/puppeteer@^1.0.4` (already in package.json)

**Browser Rendering API:**
- Free tier: 10 min/day, 3 concurrent browsers
- Paid tier: 10 hours/month, then $0.09/browser hour
- Automatically available on Cloudflare Workers

## Available MCP Tools

All 11 tools are **fully functional** and tested. Here's what you can do:

### Debugging & Navigation Tools (1-7)

#### `figma_navigate`
Navigate to any Figma URL to start monitoring.

```javascript
figma_navigate({
  url: 'https://www.figma.com/design/abc123/My-Design?node-id=1-2'
})
```

**Always use this first** to initialize the browser and start console monitoring.

#### `figma_get_console_logs`
Retrieve console logs from Figma.

```javascript
figma_get_console_logs({
  count: 50,           // Number of recent logs (default: 100)
  level: 'error',      // Filter: 'log', 'info', 'warn', 'error', 'debug', 'all'
  since: 1234567890    // Unix timestamp (optional)
})
```

Returns logs with:
- Timestamp
- Log level
- Message and arguments
- Source (plugin vs Figma)
- Stack traces (for errors)

#### `figma_take_screenshot`
Capture screenshots of Figma UI.

```javascript
figma_take_screenshot({
  target: 'full-page',  // 'plugin', 'full-page', 'viewport'
  format: 'png',        // 'png' or 'jpeg'
  quality: 90           // JPEG quality (0-100)
})
```

Returns base64-encoded image data.

#### `figma_get_status`
Check browser and monitoring status.

```javascript
figma_get_status()
```

Returns:
- Browser running state
- Current URL
- Log count and buffer info
- Initialization state

### Utility Tools

#### `figma_reload_plugin`
Reload the current Figma page.

```javascript
figma_reload_plugin({
  clearConsole: true  // Clear logs before reload
})
```

#### `figma_clear_console`
Clear the console log buffer.

```javascript
figma_clear_console()
```

#### `figma_watch_console` (Coming Soon)
Stream console logs in real-time via SSE notifications.

```javascript
figma_watch_console({
  duration: 30,    // Seconds to watch
  level: 'all'     // Log level filter
})
```

*Currently returns placeholder - planned for Phase 3.*

---

### Figma Data Extraction Tools (8-11)

> **Note:** These tools require a Figma access token. See [FIGMA_API_SETUP.md](FIGMA_API_SETUP.md) for setup instructions.

These tools use the Figma REST API to extract design data, variables, components, and styles directly from Figma files.

#### `figma_get_file_data`
Get file structure, components, and metadata.

```javascript
figma_get_file_data({
  fileUrl: 'https://www.figma.com/design/abc123/My-File',  // Optional if already navigated
  depth: 2,           // How many levels of children to include (default: 1)
  nodeIds: ['123:456', '123:789']  // Optional: specific nodes only
})
```

**Returns:**
- File name, version, last modified date
- Complete document tree structure
- Component and style counts
- Node metadata (if nodeIds specified)

#### `figma_get_variables`
Get design tokens and variables from Figma.

```javascript
figma_get_variables({
  fileUrl: 'https://www.figma.com/design/abc123/My-File',  // Optional if already navigated
  includePublished: true  // Include published library variables (default: true)
})
```

**Returns:**
- Local variables (colors, numbers, strings, booleans)
- Variable collections with modes
- Published library variables
- Summary with counts by type

**Note:** Variables API requires Figma Enterprise plan with `file_variables:read` scope.

#### `figma_get_component`
Get specific component data and properties.

```javascript
figma_get_component({
  fileUrl: 'https://www.figma.com/design/abc123/My-File',  // Optional if already navigated
  nodeId: '123:456'  // Component node ID (from URL: ?node-id=123-456)
})
```

**Returns:**
- Component name, type, and ID
- Component property definitions (variants, boolean props, etc.)
- Children structure
- Bounds, fills, strokes, effects

**Tip:** Get node IDs from Figma URLs. For example, `?node-id=123-456` means nodeId is `'123:456'`.

#### `figma_get_styles`
Get color, text, and effect styles from file.

```javascript
figma_get_styles({
  fileUrl: 'https://www.figma.com/design/abc123/My-File'  // Optional if already navigated
})
```

**Returns:**
- All color, text, and effect styles
- Style names, descriptions, and types
- Total style count

---

### Combined Workflow Examples

**Debug plugin with actual Figma data:**
```javascript
// 1. Navigate to file
figma_navigate({ url: 'https://www.figma.com/design/abc123/My-Design-System' })

// 2. Get all design tokens
figma_get_variables()

// 3. Get specific component properties
figma_get_component({ nodeId: '123:456' })

// 4. Check console for errors
figma_get_console_logs({ level: 'error' })

// AI can now correlate:
// - What variables exist in Figma
// - What your plugin is trying to use
// - Any errors that occurred
```

**Extract design system data:**
```javascript
// Get all variables and styles
figma_get_variables()
figma_get_styles()

// Get specific component metadata
figma_get_component({ nodeId: '5:123' })

// Get file structure
figma_get_file_data({ depth: 2 })
```

## Use Cases

### Autonomous Plugin Debugging

Let AI assistants debug your Figma plugins without manual intervention:

```
1. AI navigates: figma_navigate({ url: '...' })
2. AI reads code and makes changes
3. Plugin executes in Figma → logs captured automatically
4. AI checks: figma_get_console_logs({ level: 'error' })
5. AI analyzes errors and fixes code
6. AI reloads: figma_reload_plugin()
7. Loop continues until plugin works
```

### Error Investigation

```javascript
// Navigate to your Figma file
figma_navigate({ url: 'https://www.figma.com/design/...' })

// Check for errors
figma_get_console_logs({ level: 'error', count: 10 })

// Take screenshot of current state
figma_take_screenshot({ target: 'full-page' })

// AI correlates visual state with errors
```

### Visual Debugging

```javascript
// Get current status
figma_get_status()

// Capture UI state
figma_take_screenshot({ target: 'plugin' })

// Get logs from same timeframe
figma_get_console_logs({ count: 20 })
```

## MCP Client Setup Guides

> **Claude Code users:** See [CLAUDE_CODE_SETUP.md](CLAUDE_CODE_SETUP.md) for detailed setup and troubleshooting if you get "fetch failed" errors.

### Claude Desktop

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

**After editing:**
1. Save the file
2. Quit Claude Desktop completely
3. Restart Claude Desktop
4. Look for "🔌" indicator showing MCP servers connected
5. All 11 Figma tools should be available

### Claude Code (VS Code Extension)

**One-line install:**

```bash
claude mcp add --transport sse figma-console https://figma-console-mcp.southleft.com/sse
```

**Verify:**
- Use `/mcp` command in Claude Code
- Should show "figma-console: connected"

**See [CLAUDE_CODE_SETUP.md](CLAUDE_CODE_SETUP.md) for troubleshooting.**

### Cursor

**Location:** `.cursor/mcp.json` in your project or `~/.cursor/mcp.json` globally

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

**After editing:**
1. Restart Cursor
2. Tools available via Composer or Chat

### Cline (VS Code Extension)

**Location:** VS Code Settings → Cline → MCP Settings

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

### Zed

**Location:** `~/.config/zed/settings.json`

```json
{
  "assistant": {
    "version": "2",
    "provider": {
      "name": "anthropic",
      "mcp_servers": {
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
  }
}
```

### Continue (VS Code/JetBrains)

**Location:** `~/.continue/config.json`

```json
{
  "mcpServers": [
    {
      "name": "figma-console",
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://figma-console-mcp.southleft.com/sse"
      ]
    }
  ]
}
```

### Cloudflare AI Playground

1. Go to https://playground.ai.cloudflare.com/
2. Click "Add MCP Server"
3. Enter: `https://figma-console-mcp.southleft.com/sse`
4. Start using Figma tools in the playground!

## Testing Your Setup

After connecting to any MCP client, try this workflow:

```
1. Ask: "Navigate to https://www.figma.com and check the status"
   → Should call figma_navigate() and figma_get_status()

2. Ask: "What console logs are there?"
   → Should call figma_get_console_logs()

3. Ask: "Take a screenshot"
   → Should call figma_take_screenshot()
```

All tools should execute successfully. If you see errors, check:
- Your MCP client configuration is correct
- The server URL is exactly: `https://figma-console-mcp.southleft.com/sse`
- You've restarted your MCP client after config changes

## How It Works

```
AI Assistant (Claude Desktop/Cursor/etc)
         ↓ MCP Protocol
    mcp-remote proxy
         ↓ SSE/HTTP
Figma Console MCP Server (Cloudflare Workers)
         ↓ Browser Rendering API
Chrome Browser (@cloudflare/puppeteer v1.0.4)
         ↓ Chrome DevTools Protocol
    Figma → Your Plugin
```

The MCP server runs on Cloudflare Workers and uses Browser Rendering API to control a headless Chrome instance. It monitors console events via Chrome DevTools Protocol and exposes Figma-specific debugging tools via MCP.

## Architecture

- **McpAgent pattern** from Cloudflare's "agents" package
- **Durable Objects** for session persistence
- **Browser Rendering API** (@cloudflare/puppeteer) for headless Chrome
- **Chrome DevTools Protocol** for console log monitoring
- **SSE (Server-Sent Events)** for remote MCP clients
- **Circular buffer** for efficient log storage (1000 logs)
- **Pino logger** for structured logging

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed technical documentation.

## Development

### Prerequisites

- Node.js >= 18
- Cloudflare account
- Wrangler CLI (`npm install -g wrangler`)

### Setup

```bash
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp
npm install
```

### Commands

```bash
# Local development
npm run dev
# Server runs at http://localhost:8787

# Build TypeScript
npm run build

# Type checking
npm run type-check

# Format code
npm run format

# Lint and fix
npm run lint:fix

# Deploy to Cloudflare Workers
npm run deploy
```

### Local Testing

```bash
# Start dev server
npm run dev

# In another terminal, test endpoints:
curl http://localhost:8787/health
curl http://localhost:8787/test-browser
```

**Connect Claude Desktop to local server:**
```json
{
  "mcpServers": {
    "figma-console-local": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://localhost:8787/sse"
      ]
    }
  }
}
```

## Project Structure

```
figma-console-mcp/
├── src/
│   ├── index.ts              # Main entry point (McpAgent)
│   ├── browser-manager.ts    # Puppeteer browser lifecycle
│   ├── console-monitor.ts    # Console log capture (CDP)
│   ├── figma-api.ts          # Figma REST API client
│   ├── figma-tools.ts        # Figma data extraction tools (8-11)
│   ├── config.ts             # Configuration management
│   ├── logger.ts             # Pino logging
│   ├── test-browser.ts       # Browser Rendering API diagnostics
│   └── types/
│       └── index.ts          # TypeScript types
├── wrangler.jsonc            # Cloudflare Workers config
├── package.json              # Dependencies
├── tsconfig.json             # TypeScript config
├── biome.json                # Linter/formatter config
├── ARCHITECTURE.md           # Technical architecture
├── FIGMA_API_SETUP.md        # Figma API tools setup guide
├── TROUBLESHOOTING.md        # Common issues and solutions
└── README.md                 # This file
```

## Troubleshooting

### "Browser isn't currently running"

**Solution:** Always call `figma_navigate()` first to initialize the browser.

```javascript
// ✅ Correct workflow
figma_navigate({ url: 'https://www.figma.com/design/...' })
figma_get_console_logs()

// ❌ Wrong - will fail
figma_get_console_logs()  // No browser initialized
```

### "Connection timed out"

**Cause:** First call to `figma_navigate()` can take 10-30 seconds (browser launch + Figma load).

**Solution:** Wait patiently. Subsequent calls will be much faster.

### No console logs captured

**Possible causes:**
1. Plugin hasn't executed yet
2. Logs are filtered out (try `level: 'all'`)
3. Timing issue (wait after navigation)

**Solution:**
```javascript
figma_navigate({ url: '...' })
// Wait a moment for page to load
figma_get_status()  // Check log count
figma_get_console_logs({ level: 'all' })
```

### Tools not showing in MCP client

**Solutions:**
1. Verify server URL exactly: `https://figma-console-mcp.southleft.com/sse`
2. Check MCP config file syntax (valid JSON)
3. Restart your MCP client completely
4. Check client logs for connection errors

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for comprehensive guide.

## Cloudflare Workers Costs

Browser Rendering API pricing:

**Free Tier:**
- 10 minutes of browser time per day
- 3 concurrent browser sessions
- Perfect for development and testing
- **$0/month**

**Paid Tier (if you exceed free tier):**
- 10 hours of browser time included
- Unlimited concurrent browsers
- $0.09 per browser hour after included allowance
- Billing starts August 20, 2025
- **Typical usage: $5-10/month**

Workers Paid plan ($5/month) required only if you exceed free Workers limits (100k requests/day).

## Roadmap

✅ **Phase 1 (v0.1.0):** Infrastructure & Cloudflare Workers deployment
✅ **Phase 2 (v0.2.0):** All 7 debugging tools implemented and tested
✅ **Phase 2.5 (v0.2.5):** Figma API data extraction tools (8-11) - Variables, Components, Styles
🚧 **Phase 3 (v0.3.0):** Real-time `figma_watch_console` via SSE
📋 **Phase 4 (v1.0.0):** Advanced features (custom filters, log persistence)

See [ROADMAP.md](ROADMAP.md) for complete timeline.

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests and linting (`npm run type-check && npm run lint:fix`)
5. Commit changes (`git commit -m 'Add amazing feature'`)
6. Push to branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

## License

MIT License - see [LICENSE](LICENSE) for details.

## Related Projects

- [Model Context Protocol](https://modelcontextprotocol.io/) - Protocol specification
- [Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-rendering/) - Browser automation on Workers
- [Figma Plugin API](https://www.figma.com/plugin-docs/) - Official Figma plugin docs
- [mcp-remote](https://www.npmjs.com/package/mcp-remote) - Remote MCP proxy for local clients

## Support

- 📖 [Documentation](ARCHITECTURE.md)
- 🐛 [Issue Tracker](https://github.com/southleft/figma-console-mcp/issues)
- 💬 [Discussions](https://github.com/southleft/figma-console-mcp/discussions)
- 🔧 [Troubleshooting Guide](TROUBLESHOOTING.md)

## Acknowledgments

Built with:
- [Cloudflare Workers](https://workers.cloudflare.com/) - Serverless platform
- [@cloudflare/puppeteer](https://github.com/cloudflare/puppeteer) - Browser automation
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/sdk) - MCP implementation
- [Anthropic Claude](https://claude.ai/) - AI assistant integration

---

**Made for Figma plugin developers and AI enthusiasts**
**Deployed on Cloudflare Workers ⚡**
**Live at [figma-console-mcp.southleft.com](https://figma-console-mcp.southleft.com)**
