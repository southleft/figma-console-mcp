# Implement Command

Implement a feature or fix using best practices for this MCP server project.

## Instructions

When implementing features for the Figma Console MCP server:

1. **Use MCP SDK Patterns**
   - Follow Model Context Protocol TypeScript SDK conventions
   - Use `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`
   - Use Zod for input schema validation
   - Return proper content structures: `{ content: [{ type: "text", text: "..." }] }`

2. **Follow Architecture**
   - Maintain separation of concerns (Server → Tools → Managers)
   - Use Puppeteer for browser automation
   - Use Chrome DevTools Protocol for console monitoring
   - Implement intelligent log truncation (from AgentDesk patterns)

3. **Code Quality**
   - Write TypeScript with strict mode
   - Add JSDoc comments for public APIs
   - Follow existing code style (Prettier + ESLint)
   - Write tests for new features (Jest)

4. **Testing**
   - Unit tests for business logic
   - Integration tests for tool handlers
   - Maintain 70%+ code coverage

5. **Documentation**
   - Update README.md if adding new tools
   - Update ARCHITECTURE.md for significant changes
   - Add inline comments for complex logic

## Example Usage

```
/sc:implement Add error categorization to console logs
```

This will activate the implementation agent with context about the MCP server project.
