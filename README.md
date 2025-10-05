# Figma Console MCP

> MCP server that enables AI coding assistants to access Figma plugin console logs and screenshots in real-time.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## ⚠️ Important: Browser Rendering API Required

**This MCP server requires Cloudflare Browser Rendering API to be enabled on your account.**

- **Free Tier Available:** 10 min/day, 3 concurrent browsers (perfect for testing!)
- **Paid Tier:** 10 hours/month included, then $0.09/browser hour
- **Setup Required:** Must be explicitly enabled - see [ENABLE_BROWSER_RENDERING.md](ENABLE_BROWSER_RENDERING.md)
- **Test Your Setup:** Visit `/test-browser` endpoint to verify Browser Rendering is working

**Enable it here:** https://dash.cloudflare.com/?to=/:account/workers/plans

**Not working?** Run the diagnostic: `https://your-worker.workers.dev/test-browser`

---

## Overview

Figma Console MCP is a [Model Context Protocol](https://modelcontextprotocol.io/) server that bridges AI coding assistants (like Claude Code and Cursor) to Figma's runtime environment. It enables autonomous debugging of Figma plugins by providing:

- **Real-time console log access** from Figma plugins
- **Automated screenshot capture** of plugin UI
- **Direct visibility** into plugin execution state
- **Zero-friction debugging** workflow (no copy-paste)
- **Cloudflare Workers deployment** with Browser Rendering API

## Quick Start

### Deploy to Cloudflare Workers

[![Deploy to Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/southleft/figma-console-mcp)

This deploys your MCP server to: `figma-console-mcp.<your-account>.workers.dev`

Alternatively, use the command line:

```bash
# Clone the repository
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp

# Install dependencies
npm install

# Deploy to Cloudflare Workers
npm run deploy
```

### Connect to Claude Desktop

Use [mcp-remote](https://www.npmjs.com/package/mcp-remote) proxy to connect from Claude Desktop:

**`~/.config/Claude/claude_desktop_config.json`:**
```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://figma-console-mcp.your-account.workers.dev/sse"
      ]
    }
  }
}
```

Restart Claude Desktop to see the tools become available.

### Connect to Cloudflare AI Playground

1. Go to https://playground.ai.cloudflare.com/
2. Enter your deployed URL: `https://figma-console-mcp.your-account.workers.dev/sse`
3. Start using the Figma debugging tools!

## Available MCP Tools

**7 tools available** - 6 fully functional, 1 placeholder for Phase 3.

### `figma_navigate` ✅

Navigate to a specific Figma URL to start monitoring.

**Parameters:**
- `url` (string, required): Figma URL to navigate to (e.g., `https://www.figma.com/design/abc123`)

**Use this first** to open Figma and start console monitoring before using other tools.

### `figma_get_console_logs` ✅

Retrieve recent console logs from the Figma plugin.

**Parameters:**
- `count` (number, optional): Number of recent logs to retrieve (default: 100)
- `level` (string, optional): Filter by log level - 'log', 'info', 'warn', 'error', 'debug', 'all' (default: 'all')
- `since` (number, optional): Only logs after this timestamp (Unix ms)

**Returns:** Array of log entries with timestamp, level, message, args, source, and optional stack trace.

### `figma_take_screenshot` ✅

Capture a screenshot of the Figma plugin UI.

**Parameters:**
- `target` (string, optional): What to screenshot - 'plugin', 'full-page', 'viewport' (default: 'plugin')
- `format` (string, optional): Image format - 'png', 'jpeg' (default: 'png')
- `quality` (number, optional): JPEG quality 0-100 (default: 90)

**Returns:** Base64-encoded image data with metadata (id, timestamp, format, size).

### `figma_watch_console` ⏳

Stream console logs in real-time (sends notifications).

**Parameters:**
- `duration` (number, optional): How long to watch in seconds (default: 30)
- `level` (string, optional): Filter by log level (default: 'all')

**Status:** Placeholder for Phase 3 (SSE implementation).

### `figma_reload_plugin` ✅

Reload the currently running Figma plugin.

**Parameters:**
- `clearConsole` (boolean, optional): Clear console logs before reload (default: true)

**Returns:** Reload status, current URL, and number of cleared logs.

### `figma_clear_console` ✅

Clear the console log buffer.

**Parameters:** None

**Returns:** Number of logs cleared and timestamp.

### `figma_get_status` ✅

Get the current status of the browser and console monitor.

**Parameters:** None

**Returns:** Browser running state, current URL, console monitor status (log count, buffer size, timestamps), and initialization state.

## How It Works

```
AI Assistant (Claude Code/Cursor)
         ↓ MCP Protocol
Figma Console MCP Server (Cloudflare Workers)
         ↓ Browser Rendering API (@cloudflare/puppeteer)
Chrome Browser → Figma → Your Plugin
```

The MCP server runs on Cloudflare Workers and uses the Browser Rendering API to control a headless Chrome instance. It monitors console events via the Chrome DevTools Protocol and exposes Figma-specific debugging tools via the MCP protocol.

## Development

### Prerequisites

- Node.js >= 18
- Cloudflare account (for deployment)
- Wrangler CLI (installed via npm)

### Setup

```bash
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp
npm install
```

### Development Commands

```bash
# Start local development server
npm run dev

# Build TypeScript
npm run build

# Run type checking
npm run type-check

# Format code with Biome
npm run format

# Lint and fix
npm run lint:fix

# Deploy to Cloudflare Workers
npm run deploy
```

### Local Development

```bash
# Start Wrangler dev server (includes Browser Rendering API emulation)
npm run dev

# Server will be available at:
# - SSE endpoint: http://localhost:8787/sse
# - HTTP endpoint: http://localhost:8787/mcp
# - Health check: http://localhost:8787/health
```

### Testing with MCP Remote Proxy

During development, connect Claude Desktop to your local server:

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
│   ├── index.ts              # Main entry point (McpAgent implementation)
│   ├── config.ts             # Configuration management
│   ├── logger.ts             # Pino logging infrastructure
│   └── types/
│       └── index.ts          # TypeScript type definitions
├── wrangler.jsonc            # Cloudflare Workers configuration
├── package.json              # Dependencies and scripts
├── tsconfig.json             # TypeScript configuration
├── biome.json                # Biome linter/formatter config
├── ARCHITECTURE.md           # Technical architecture documentation
├── PRODUCT_PLAN.md           # Product requirements document
├── ROADMAP.md                # Development roadmap
└── README.md                 # This file
```

## Architecture

This implementation uses:

- **McpAgent pattern** from Cloudflare's "agents" package for Durable Objects integration
- **Browser Rendering API** (@cloudflare/puppeteer) for headless Chrome control
- **Chrome DevTools Protocol** for console log monitoring
- **SSE (Server-Sent Events)** for real-time log streaming
- **Pino logger** for structured logging to stderr

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed technical documentation.

## Configuration

The server supports configuration via:

1. Environment variable: `FIGMA_CONSOLE_CONFIG`
2. Project-local: `.figma-console-mcp.json`
3. User home: `~/.config/figma-console-mcp/config.json`

Example configuration:

```json
{
  "browser": {
    "headless": true,
    "args": ["--disable-blink-features=AutomationControlled"]
  },
  "console": {
    "bufferSize": 1000,
    "filterLevels": ["log", "info", "warn", "error"],
    "truncation": {
      "maxStringLength": 500,
      "maxArrayLength": 10,
      "maxObjectDepth": 3
    }
  },
  "screenshots": {
    "defaultFormat": "png",
    "quality": 90
  }
}
```

## Roadmap

**Phase 1 (v0.1.0):** ✅ Infrastructure & Cloudflare Workers deployment
- [x] McpAgent integration
- [x] Tool schema definitions
- [x] Browser Rendering API binding
- [ ] Console log capture implementation (Week 4)

**Phase 2 (v0.2.0):** Screenshot capability
**Phase 3 (v0.3.0):** Real-time monitoring
**Phase 4 (v1.0.0):** Advanced features

See [ROADMAP.md](ROADMAP.md) for complete timeline.

## Use Cases

### Autonomous Debugging

Let your AI assistant debug Figma plugins without manual intervention:

```
1. AI navigates to Figma: figma_navigate({ url: 'https://www.figma.com/design/...' })
2. AI writes/modifies plugin code
3. Plugin executes in Figma, logs are captured automatically
4. AI checks logs: figma_get_console_logs({ level: 'error' })
5. AI analyzes errors and fixes code
6. AI reloads: figma_reload_plugin({ clearConsole: true })
7. Loop continues until plugin works
```

### Error Investigation

Quickly investigate runtime errors:

```
AI: "Check the latest error in the plugin"
→ figma_navigate({ url: 'https://www.figma.com/design/abc123' })
→ figma_get_console_logs({ level: 'error', count: 1 })
→ Analyzes stack trace and suggests fix
```

### Visual Debugging

Combine logs with screenshots:

```
AI: "Show me what the plugin looks like when the error occurs"
→ figma_get_status() // Check if browser is running
→ figma_take_screenshot({ target: 'plugin' })
→ figma_get_console_logs({ level: 'error' })
→ Correlates UI state with errors
```

### Monitoring Workflow

Track plugin execution state:

```
→ figma_navigate({ url: 'https://www.figma.com/design/...' })
→ figma_get_status() // See log count, buffer size
→ figma_get_console_logs({ count: 50 })
→ figma_clear_console() // Clear for next test
```

## Cloudflare Workers Costs

Browser Rendering API pricing:
- $5/month for up to 30 concurrent browser sessions
- Includes 2 million requests/month
- 10ms CPU time per request (Workers Standard)

Perfect for development and moderate usage.

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - see [LICENSE](LICENSE) for details.

## Related Projects

- [Model Context Protocol](https://modelcontextprotocol.io/) - Protocol specification
- [Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-rendering/) - Browser automation on Workers
- [Figma Plugin API](https://www.figma.com/plugin-docs/) - Official Figma plugin documentation
- [mcp-remote](https://www.npmjs.com/package/mcp-remote) - Remote MCP proxy for local clients

## Support

- 📖 [Documentation](ARCHITECTURE.md)
- 🐛 [Issue Tracker](https://github.com/southleft/figma-console-mcp/issues)
- 💬 [Discussions](https://github.com/southleft/figma-console-mcp/discussions)

---

Made with ❤️ for Figma plugin developers and AI enthusiasts

Deployed on [Cloudflare Workers](https://workers.cloudflare.com/) ⚡
