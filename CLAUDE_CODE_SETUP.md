# Claude Code Setup Guide

## Quick Setup for Local Mode

Claude Code uses the same MCP configuration as Claude Desktop. Follow these steps to enable Figma plugin debugging in Claude Code:

### Prerequisites

1. **Figma Desktop** running with remote debugging:
   ```bash
   ./scripts/launch-figma-debug.sh
   ```

2. **Developer VM enabled** in Figma:
   - Go to: Plugins → Development → Use Developer VM
   - Click to enable (no checkmark shown, but it toggles on/off)

3. **Build the local mode server**:
   ```bash
   npm run build:local
   ```

### Configuration

Add to your MCP settings file:

**macOS/Linux:** `~/.config/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "node",
      "args": ["/absolute/path/to/figma-console-mcp/dist/local.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "your-figma-token-here"
      }
    }
  }
}
```

**Important:** Replace `/absolute/path/to/figma-console-mcp/` with the actual path to this repository.

### Get Your Figma Access Token

1. Go to https://www.figma.com/developers/api#access-tokens
2. Generate a new personal access token
3. Copy and paste it into the `FIGMA_ACCESS_TOKEN` field above

### Verify Setup

1. Restart Claude Desktop/Code
2. Open a Figma design file
3. Run your plugin
4. In Claude, ask: "Show me the latest console logs"

You should see your plugin's console logs captured in real-time!

## Available MCP Tools

Once configured, you have access to 11 tools:

### Console Tools
- `figma_get_console_logs` - Get recent console logs (with filtering)
- `figma_clear_console` - Clear the console buffer
- `figma_watch_console` - Watch console in real-time (planned)

### Navigation Tools
- `figma_navigate` - Navigate to a Figma URL
- `figma_reload_plugin` - Reload current page

### Screenshot Tools
- `figma_take_screenshot` - Capture screenshots (plugin/full-page/viewport)

### Status Tools
- `figma_get_status` - Get MCP server status

### Figma API Tools
- `figma_get_file_variables` - Extract design tokens
- `figma_get_file_components` - Get component library
- `figma_get_file_styles` - Get shared styles
- `figma_extract_node_data` - Extract specific node data

## Troubleshooting

### MCP Server Won't Connect

**Error:** `Failed to connect to Figma Desktop at http://localhost:9222`

**Solution:**
1. Make sure Figma is running
2. Quit Figma and relaunch with debug flag:
   ```bash
   ./scripts/launch-figma-debug.sh
   ```
3. Verify debug port is accessible:
   ```bash
   curl http://localhost:9222/json/version
   ```

### No Plugin Console Logs

**Error:** Only seeing Figma page logs, not plugin logs

**Solution:**
1. Enable Developer VM: Plugins → Development → Use Developer VM
2. Restart your plugin
3. Clear console and check again

### JSON Parsing Errors (FIXED)

If you see `Unexpected token '\x1B'` errors, update to the latest version - the logger now auto-detects stdio mode and disables colored output.

## Next Steps

- [Full Setup Guide](DUAL_MODE_SETUP.md)
- [API Documentation](README.md#available-mcp-tools)
- [Implementation Details](IMPLEMENTATION_COMPLETE.md)

---

**Made with ❤️ for Figma plugin developers**
