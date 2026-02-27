# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build all targets (local, cloudflare, apps)
npm run build

# Build individual targets
npm run build:local        # Node.js / stdio MCP server
npm run build:cloudflare   # Cloudflare Workers bundle
npm run build:apps         # Vite apps (token-browser, design-system-dashboard)

# Development
npm run dev:local          # Run local MCP server via tsx (no build needed)
npm run dev                # Cloudflare Workers dev (wrangler)
npm run dev:apps           # Watch mode for MCP Apps

# Testing
npm test                   # Run all tests
npm run test:watch         # Watch mode
npm run test:coverage      # With coverage report
npx jest tests/basic.test.ts  # Run a single test file

# Code quality
npm run format             # Biome formatter (auto-fix)
npm run lint:fix           # Biome linter (auto-fix)
npm run type-check         # TypeScript type check only (no emit)
```

## Architecture

This is a **dual-mode MCP server** that bridges AI assistants with Figma. There are two distinct deployment targets built from the same source:

### Deployment Modes

| Mode | Entry Point | Transport | Tools | Auth |
|------|------------|-----------|-------|------|
| Local (NPX/CLI) | `src/local.ts` | stdio | 56+ | PAT |
| Remote (Cloudflare) | `src/index.ts` | SSE | ~21 (read-only) | OAuth |

The local mode is significantly more capable because it uses a WebSocket bridge to communicate with the Figma Desktop plugin in real-time.

### Communication Flow (Local Mode)

```
AI Assistant → stdio → MCP Server (src/local.ts)
                           ↕
                    WebSocket Server (ports 9223–9232)
                           ↕
              Figma Desktop Plugin (figma-desktop-bridge/)
```

The plugin runs inside Figma Desktop and connects to the MCP server's WebSocket. The MCP server routes tool calls through this channel to execute JavaScript in the Figma plugin context (`figma_execute`) or access plugin APIs.

### Key Source Files

- **`src/local.ts`** — Main CLI entry point. Initializes MCP server, registers all 56+ tools, starts WebSocket server, handles port discovery.
- **`src/index.ts`** — Cloudflare Workers entry (`McpAgent`). OAuth-based, limited to REST API tools.
- **`src/core/figma-tools.ts`** — All MCP tool definitions. Includes LRU caching (5 min TTL, 10 entries) and adaptive response compression (thresholds: 100KB ideal, 500KB critical, 1MB max).
- **`src/core/websocket-server.ts`** — Multi-client WebSocket hub. Tracks state per Figma file (selection, document changes, console logs). Supports ports 9223–9232 with automatic fallback for multiple Figma instances.
- **`src/core/websocket-connector.ts`** — WebSocket communication layer implementing `IFigmaConnector`.
- **`src/core/figma-desktop-connector.ts`** — Legacy CDP/Puppeteer-based connector (backwards compat).
- **`src/core/figma-api.ts`** — REST API client (files, nodes, styles, variables, images). Handles OAuth vs PAT token detection.
- **`src/core/port-discovery.ts`** — Port file management for multi-instance support.
- **`src/core/design-code-tools.ts`** — Design-code parity comparison and component documentation generation.
- **`src/apps/`** — Two interactive MCP Apps: `token-browser/` and `design-system-dashboard/`. Built with Vite.

### Multi-Instance Support

The WebSocket server tries ports 9223–9232 sequentially. `port-discovery.ts` maintains port files so multiple Figma instances can each connect to the same MCP server simultaneously.

### Response Compression

`figma-tools.ts` implements adaptive compression on large tool responses to stay within context window limits. Responses are compressed if they exceed 100KB (ideal), and truncated aggressively above 500KB–1MB.

### Build System

Three independent TypeScript configs:
- `tsconfig.local.json` → Node.js target (compiled to `dist/local.js`)
- `tsconfig.cloudflare.json` → Cloudflare Workers target (`dist/cloudflare/`)
- Vite (`vite.config.ts`) → MCP Apps UI bundles

The `APP_NAME` environment variable controls which Vite app is built (`token-browser` or `design-system-dashboard`).

### Code Style

- **Formatter/Linter:** Biome (4-space indent, 100-char line width)
- **TypeScript:** Strict mode, ES2021 target, ES2022 modules
- ESLint enforces explicit return types and no unused vars
- Run `npm run format && npm run lint:fix` before committing
