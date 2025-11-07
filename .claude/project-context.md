# Figma Console MCP - Project Context

## Project Overview

**Name:** Figma Console MCP
**Type:** Model Context Protocol (MCP) Server
**Language:** TypeScript
**Runtime:** Node.js >= 18

## Purpose

Enable AI coding assistants (Claude Code, Cursor) to access Figma plugin console logs and screenshots in real-time, allowing autonomous debugging without manual copy-paste.

## Key Technologies

- **@modelcontextprotocol/sdk** - MCP protocol implementation
- **Puppeteer** - Browser automation
- **Chrome DevTools Protocol (CDP)** - Console log capture
- **TypeScript** - Type-safe development
- **Jest** - Testing framework

## Architecture Pattern

3-tier architecture:
1. **MCP Server** - Protocol handling and tool registration
2. **Tool Implementations** - Business logic for each MCP tool
3. **Managers** - Browser automation, console monitoring, screenshots

## Core Features

1. `figma_get_console_logs()` - Retrieve console logs from plugin
2. `figma_take_screenshot()` - Capture plugin UI screenshots
3. `figma_watch_console()` - Stream logs in real-time
4. `figma_reload_plugin()` - Reload plugin after code changes
5. `figma_clear_console()` - Clear console log buffer

## Development Workflow

1. Plan feature → Use `/sc:implement`
2. Write code → Follow MCP SDK patterns
3. Add tests → Maintain 70%+ coverage
4. Run tests → Use `/sc:test`
5. Review code → Use `senior-code-reviewer` agent
6. Document → Update relevant docs

## Important Patterns

### MCP Tool Registration
```typescript
server.registerTool(
  "tool-name",
  {
    description: "What the tool does",
    inputSchema: { param: z.string() }
  },
  async ({ param }) => ({
    content: [{ type: "text", text: "result" }]
  })
);
```

### Console Log Truncation
Always truncate logs to prevent overwhelming AI context:
- Max string length: 500 chars
- Max array length: 10 elements
- Max object depth: 3 levels

### Error Handling
All tools must handle errors gracefully:
```typescript
try {
  // Tool logic
} catch (error) {
  return {
    content: [{ type: "text", text: `Error: ${error.message}` }],
    isError: true
  };
}
```

## References

- [Product Plan](../PRODUCT_PLAN.md) - Complete requirements
- [Architecture](../ARCHITECTURE.md) - Technical design
- [README](../README.md) - User documentation
