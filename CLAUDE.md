# Figma Console MCP

The most comprehensive MCP server for Figma — design tokens, components, variables, and programmatic design creation.

## Build & Test

```bash
npm run build          # Compiles local + cloudflare + apps
npm run build:local    # Local mode only (use if Cloudflare types fail)
npm run build:cloudflare
npm run build:apps     # Vite: token-browser & design-system-dashboard
npm test               # Jest test suite
npx tsc --noEmit       # Type-check (pre-existing errors in src/apps/*/ui/mcp-app.ts are expected)
npm run lint:fix       # Biome linter + formatter
```

## Development

```bash
npm run dev:local      # Run server locally (tsx, stdio transport)
npm run dev:apps       # Watch & rebuild UI apps
npm run deploy         # Deploy to Cloudflare Workers (wrangler)
```

## Release Process

Before any release, read `.notes/RELEASING.md` and follow all five phases.

```bash
scripts/release.sh --version X.Y.Z --local-tools N --remote-tools N
# Supports --dry-run for preview
```

## Known Issues

- **npm publish**: Use `npm publish --ignore-scripts` if prepublishOnly triggers a build failure.
- **Pre-existing tsc errors**: `src/apps/*/ui/mcp-app.ts` DOM type errors are expected (separate tsconfig files).

## Our Changes vs Original Repo

- **`src/browser-manager.ts`**: `BROWSER` binding made optional (`BROWSER?: Fetcher`) + null guard added in `launch()`. `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` added to `Env` interface.
- **`src/index.ts`**: All `this.env as Env` casts replaced with `this.env as unknown as Env` to fix Cloudflare type overlap error.
- **`wrangler.jsonc`**: `browser` binding removed (not used in our architecture — requires paid Cloudflare plan). KV namespace IDs updated to our account.

## Architecture

### Entry Points

| File | Mode | Transport |
|------|------|-----------|
| `src/local.ts` | Local / NPX | stdio (StdioServerTransport) |
| `src/index.ts` | Cloudflare Workers | HTTP (WebStandardStreamableHTTPServerTransport) |

- Local mode enables **MCP Apps** (Token Browser, Design System Dashboard) — require Node.js FS.
- Cloudflare mode: read-only ~16 tools via SSE.
- Both modes register tools via `registerXxxTools(server, getFigmaAPI, ...)`.

### Tool Registration Pattern

```ts
registerFigmaAPITools(server, getFigmaAPI, getConnector)
registerDesignCodeTools(server, getFigmaAPI)
registerCommentTools(server, getFigmaAPI)
registerDesignSystemTools(server, getFigmaAPI, getConnector)
```

Tool files live in `src/core/`. The largest is `src/core/figma-tools.ts` (~124 KB).

### Desktop Bridge

- WebSocket server: `src/core/websocket-server.ts`
- Connector: `src/core/figma-desktop-connector.ts`
- Fallback: CDP via `chrome-remote-interface`
- Port discovery: `src/core/port-discovery.ts` (dynamic fallback 9223–9232)
- The Figma plugin (git submodule at `figma-desktop-bridge/`) must be running for write operations.

### Key Source Directories

```
src/
├── local.ts                  # Local entry point
├── index.ts                  # Cloudflare Workers entry point
├── core/                     # All tools and core logic
│   ├── figma-tools.ts        # Main design tools (124 KB)
│   ├── figma-api.ts          # REST API wrapper
│   ├── figma-connector.ts    # Connection abstraction
│   ├── websocket-server.ts   # Desktop Bridge WS server
│   ├── design-system-tools.ts
│   ├── design-code-tools.ts
│   ├── comment-tools.ts
│   ├── console-monitor.ts
│   ├── enrichment/           # Token/style enrichment
│   └── types/
├── apps/
│   ├── token-browser/        # MCP App: Token Browser UI
│   └── design-system-dashboard/  # MCP App: DS Dashboard UI
└── browser/                  # Browser implementations
```

### Schema Compatibility

**No `z.any()`** — Gemini requires strictly typed Zod schemas. Always use specific types.

## Testing

Tests live in `tests/`. Run with `npm test` (Jest).

## Deployment Targets

- **Local / NPX**: Node.js + stdio, full write access via Desktop Bridge
- **Cloudflare Workers**: HTTP SSE, read-only tools (~16)
- **IDE integrations**: Claude Code, Cursor, Windsurf

## Environment Variables

- `FIGMA_ACCESS_TOKEN` — required for REST API calls in local mode
