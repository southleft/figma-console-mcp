# Figma Console MCP

> MCP server that enables AI coding assistants to access Figma plugin console logs and screenshots in real-time.

[![npm version](https://badge.fury.io/js/figma-console-mcp.svg)](https://www.npmjs.com/package/figma-console-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Overview

Figma Console MCP is a [Model Context Protocol](https://modelcontextprotocol.io/) server that bridges AI coding assistants (like Claude Code and Cursor) to Figma's runtime environment. It enables autonomous debugging of Figma plugins by providing:

- **Real-time console log access** from Figma plugins
- **Automated screenshot capture** of plugin UI
- **Direct visibility** into plugin execution state
- **Zero-friction debugging** workflow (no copy-paste)

## Features

- 🔍 **Console Log Monitoring**: Capture and filter console logs from Figma plugins
- 📸 **Screenshot Capture**: Take screenshots of plugin UI automatically
- 🔄 **Auto-Reload**: Reload plugins after code changes
- ⚡ **Real-time Streaming**: Watch console logs as they happen
- 🤖 **AI-Native**: Designed for autonomous AI debugging workflows

## Installation

```bash
npm install -g figma-console-mcp
```

Or use directly with `npx`:

```bash
npx figma-console-mcp
```

## Quick Start

### 1. Configure MCP Client

Add to your MCP client configuration (e.g., Claude Code):

**`~/.config/claude-code/mcp-servers.json`:**
```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["figma-console-mcp"]
    }
  }
}
```

### 2. Start Your Figma Plugin

Open Figma and run your plugin in development mode.

### 3. Use MCP Tools

Now your AI assistant can access these tools:

```typescript
// Get recent console logs
figma_get_console_logs({ count: 50, level: 'error' })

// Take a screenshot
figma_take_screenshot({ target: 'plugin', format: 'png' })

// Reload the plugin
figma_reload_plugin({ clearConsole: true })

// Watch logs in real-time
figma_watch_console({ duration: 30, level: 'all' })

// Clear console buffer
figma_clear_console()
```

## How It Works

```
AI Assistant (Claude Code/Cursor)
         ↓ MCP Protocol
Figma Console MCP Server
         ↓ Chrome DevTools Protocol
Chrome Browser → Figma → Your Plugin
```

The MCP server uses Puppeteer to control a Chrome browser, connects to the Chrome DevTools Protocol to monitor console events, and exposes Figma-specific debugging tools via the MCP protocol.

## Configuration

Create a config file at `~/.config/figma-console-mcp/config.json`:

```json
{
  "browser": {
    "headless": false,
    "args": ["--disable-blink-features=AutomationControlled"],
    "executablePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  },
  "console": {
    "bufferSize": 1000,
    "filterLevels": ["log", "info", "warn", "error"]
  },
  "screenshots": {
    "defaultFormat": "png",
    "quality": 90,
    "storePath": "/tmp/figma-console-mcp/screenshots"
  }
}
```

## MCP Tools Reference

### `figma_get_console_logs`

Retrieve recent console logs from the Figma plugin.

**Parameters:**
- `count` (number, optional): Number of recent logs to retrieve (default: 100)
- `level` (string, optional): Filter by log level - 'log', 'info', 'warn', 'error', 'debug', 'all' (default: 'all')
- `since` (number, optional): Only logs after this timestamp (Unix ms)

**Returns:**
```json
{
  "logs": [
    {
      "timestamp": 1704067200000,
      "level": "log",
      "message": "Plugin initialized",
      "args": [],
      "source": "plugin"
    }
  ],
  "totalCount": 1,
  "oldestTimestamp": 1704067200000,
  "newestTimestamp": 1704067200000
}
```

### `figma_take_screenshot`

Capture a screenshot of the Figma plugin UI.

**Parameters:**
- `target` (string, optional): What to screenshot - 'plugin', 'full-page', 'viewport' (default: 'plugin')
- `format` (string, optional): Image format - 'png', 'jpeg' (default: 'png')
- `quality` (number, optional): JPEG quality 0-100 (default: 90)

**Returns:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": 1704067200000,
  "format": "png",
  "width": 800,
  "height": 600,
  "base64": "iVBORw0KGgoAAAANSUhEUgA..."
}
```

### `figma_watch_console`

Stream console logs in real-time (sends notifications).

**Parameters:**
- `duration` (number, optional): How long to watch in seconds (default: 30)
- `level` (string, optional): Filter by log level (default: 'all')

**Returns:**
```json
{
  "status": "watching",
  "duration": 30,
  "endsAt": 1704067230000
}
```

### `figma_reload_plugin`

Reload the currently running Figma plugin.

**Parameters:**
- `clearConsole` (boolean, optional): Clear console logs before reload (default: true)

**Returns:**
```json
{
  "status": "reloaded",
  "timestamp": 1704067200000,
  "pluginContext": {
    "pluginName": "My Plugin",
    "pluginId": "1234567890",
    "isRunning": true
  }
}
```

### `figma_clear_console`

Clear the console log buffer.

**Returns:**
```json
{
  "status": "cleared",
  "clearedCount": 42,
  "timestamp": 1704067200000
}
```

## Use Cases

### Autonomous Debugging

Let your AI assistant debug Figma plugins without manual intervention:

```
1. AI writes plugin code
2. Plugin executes, logs appear
3. AI calls figma_get_console_logs()
4. AI analyzes errors and fixes code
5. AI calls figma_reload_plugin()
6. Loop continues until plugin works
```

### Error Investigation

Quickly investigate runtime errors:

```
AI: "Check the latest error in the plugin"
→ figma_get_console_logs({ level: 'error', count: 1 })
→ Analyzes stack trace and suggests fix
```

### Visual Debugging

Combine logs with screenshots:

```
AI: "Show me what the plugin looks like when the error occurs"
→ figma_take_screenshot({ target: 'plugin' })
→ figma_get_console_logs({ level: 'error' })
→ Correlates UI state with errors
```

## Development

### Prerequisites

- Node.js >= 18
- Chrome/Chromium browser
- Figma account (for testing with real plugins)

### Setup

```bash
git clone https://github.com/yourusername/figma-console-mcp.git
cd figma-console-mcp
npm install
```

### Development Commands

```bash
# Build TypeScript
npm run build

# Development mode with auto-reload
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Generate test coverage
npm run test:coverage

# Lint code
npm run lint

# Fix linting issues
npm run lint:fix

# Format code
npm run format
```

### Project Structure

```
figma-console-mcp/
├── src/
│   ├── index.ts              # Entry point
│   ├── server.ts             # MCP server implementation
│   ├── figma-manager.ts      # Browser automation
│   ├── console-monitor.ts    # Console log capture
│   ├── screenshot-manager.ts # Screenshot handling
│   ├── tools/                # MCP tool implementations
│   │   ├── get-console-logs.ts
│   │   ├── take-screenshot.ts
│   │   ├── watch-console.ts
│   │   ├── reload-plugin.ts
│   │   └── clear-console.ts
│   └── types/                # TypeScript type definitions
│       ├── config.ts
│       ├── console.ts
│       └── screenshot.ts
├── tests/                    # Test files
├── docs/                     # Additional documentation
├── PRODUCT_PLAN.md          # Product requirements
├── ARCHITECTURE.md          # Technical architecture
├── package.json
├── tsconfig.json
└── README.md
```

## Troubleshooting

### Browser doesn't launch

Make sure Chrome/Chromium is installed:

```bash
# macOS
brew install --cask google-chrome

# Linux
sudo apt-get install chromium-browser

# Or specify custom path in config
{
  "browser": {
    "executablePath": "/path/to/chrome"
  }
}
```

### Can't detect Figma plugin

Ensure your plugin is running in Figma:
1. Open Figma
2. Go to Plugins → Development → Run your plugin
3. The MCP server should detect the plugin iframe

### Console logs not appearing

Check log filtering:
- Logs must originate from the plugin context
- Make sure you're using `console.log()` in plugin code
- Try increasing buffer size in config

## Roadmap

See [PRODUCT_PLAN.md](PRODUCT_PLAN.md) for the complete roadmap.

**Phase 1 (v0.1.0):** Basic console log capture ✅
**Phase 2 (v0.2.0):** Screenshot capability 🚧
**Phase 3 (v0.3.0):** Real-time monitoring 📋
**Phase 4 (v1.0.0):** Advanced features 📋

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - see [LICENSE](LICENSE) for details.

## Related Projects

- [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) - General browser debugging MCP server
- [Model Context Protocol](https://modelcontextprotocol.io/) - Protocol specification
- [Figma Plugin API](https://www.figma.com/plugin-docs/) - Official Figma plugin documentation

## Support

- 📖 [Documentation](https://github.com/yourusername/figma-console-mcp/wiki)
- 🐛 [Issue Tracker](https://github.com/yourusername/figma-console-mcp/issues)
- 💬 [Discussions](https://github.com/yourusername/figma-console-mcp/discussions)

---

Made with ❤️ for Figma plugin developers and AI enthusiasts
