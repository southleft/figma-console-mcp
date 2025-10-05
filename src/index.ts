#!/usr/bin/env node

/**
 * Figma Console MCP Server
 * Entry point for the MCP server that enables AI assistants to access
 * Figma plugin console logs and screenshots.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Create MCP server instance
const server = new McpServer({
  name: 'figma-console-mcp',
  version: '0.1.0',
});

// Placeholder tool - will be implemented in Phase 1, Week 4
server.registerTool(
  'figma_get_console_logs',
  {
    description: 'Retrieve recent console logs from the Figma plugin (placeholder)',
    inputSchema: {
      count: z.number().optional().default(100).describe('Number of logs to retrieve'),
      level: z.enum(['log', 'info', 'warn', 'error', 'debug', 'all']).optional().default('all'),
    },
  },
  async ({ count, level }) => {
    // TODO: Implement actual console log retrieval
    return {
      content: [
        {
          type: 'text',
          text: `Placeholder: Would retrieve ${count} logs of level '${level}'.\n\nThis tool will be implemented in Phase 1 of development.`,
        },
      ],
    };
  }
);

// Main function to start the server
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is used for MCP protocol)
  console.error('Figma Console MCP server running...');
  console.error('Version: 0.1.0');
  console.error('Ready to accept MCP tool calls');
}

// Error handling
main().catch((error) => {
  console.error('Fatal error starting MCP server:', error);
  process.exit(1);
});
