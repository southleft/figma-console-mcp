# Figma Console MCP — Fork (Remote Architecture)

This is a fork of [southleft/figma-console-mcp](https://github.com/southleft/figma-console-mcp).
The goal is to run the MCP server as a **hosted remote service** on Cloudflare Workers, with write capabilities delivered via a Supabase bridge relay, so that users in an organisation can connect without installing anything locally.

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
npm run dev:local      # Run server locally (tsx, stdio transport) — out of scope for this fork
npm run dev:apps       # Watch & rebuild UI apps
npm run deploy         # Deploy to Cloudflare Workers (wrangler)
```

## Out of Scope Files — Do Not Touch

- **`src/local.ts`** — local/NPX entry point (stdio). Not used in remote mode.
- **`src/core/figma-tools.ts`** — largest tool file (~124 KB). Upstream file, do not modify.

## Our Changes vs Original Repo

- **`src/browser-manager.ts`**: `BROWSER` binding made optional (`BROWSER?: Fetcher`) + null guard added in `launch()`. `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` added to `Env` interface.
- **`src/index.ts`**: All `this.env as Env` casts replaced with `this.env as unknown as Env` to fix Cloudflare type overlap. OAuth callback now calls `/v1/me` to get `figmaUserId`, derives a stable per-user `userSessionId` (stored in KV as `user_session:${figmaUserId}`), stores it in `bearer_token:${accessToken}`, exposes it on the post-auth page. MCP client OAuth flow shows an intermediate page with the Session ID before redirecting to mcp-remote. `/bridge/config` accepts a `?session_id=` query param. Write commands routed via Supabase bridge relay (`src/bridge-relay.ts`).
- **`src/bridge-relay.ts`** (new): `bridgeRelay(command, sessionId, env)` — INSERTs a command row into Supabase `bridge_commands`, polls every 500 ms for up to 30 s for the plugin to write back the result, then returns it.
- **`wrangler.jsonc`**: `browser` binding removed (not used — requires paid Cloudflare plan). KV namespace IDs updated to our account.
- **`figma-desktop-bridge/ui.html`**: Added Session ID input field in the setup form. `fetchBridgeConfig(serverUrl, sessionId)` now appends `?session_id=` to the config URL. The plugin persists both URL and Session ID via `figma.clientStorage`. Supabase connection uses the anon key (no JWT auth); session isolation is enforced by the UUID-based session_id filter.

> **Note on the submodule:** `figma-desktop-bridge/` is a git submodule pointing to the `bridge-plugin/` repo. If you need to edit plugin files, edit them in `bridge-plugin/` and update the submodule reference here. In practice, `ui.html` changes are made directly in `figma-desktop-bridge/` as the submodule is detached for development purposes.

## Architecture

### Entry Points

| File | Mode | Transport |
|------|------|-----------|
| `src/local.ts` | Local / NPX (out of scope) | stdio (StdioServerTransport) |
| `src/index.ts` | Cloudflare Workers | HTTP (SSE + Streamable HTTP) |

- **Cloudflare mode** (our target): REST API tools are fully available (read). Write operations are routed via `src/bridge-relay.ts` → Supabase `bridge_commands` → Figma Desktop Bridge plugin.
- Local mode is retained from upstream but is not the focus of this fork.
- Both modes register tools via `registerXxxTools(server, getFigmaAPI, ...)`.

### Write Command Flow (Remote Mode)

```
AI / Claude Desktop
  → HTTPS → Cloudflare Worker (src/index.ts)
    → bridge-relay.ts: INSERT into bridge_commands (Supabase)
      → Figma Desktop Bridge plugin receives via Supabase Realtime
        → executes figma.*() in Figma Desktop
          → UPDATE bridge_commands.result
    → Worker polls result (500 ms, 30 s timeout)
  → Returns result to AI
```

### Supabase Schema

Table: `bridge_commands`
```sql
id          uuid primary key default gen_random_uuid()
session_id  text not null
command     jsonb not null
result      jsonb
created_at  timestamptz default now()
resolved_at timestamptz
```

RLS policies:
- Plugin uses **anon key** — no JWT auth required. Security relies on unguessable UUID v4 session IDs.
- `SELECT TO anon USING(true)` — plugin filters by `session_id` in its own queries.
- `UPDATE TO anon WITH CHECK (result IS NOT NULL AND resolved_at IS NOT NULL)` — plugin can only write a result.
- Worker uses `service_role` key → bypasses RLS, can INSERT/DELETE.

### Session ID Architecture

Each Figma user gets one stable Session ID:
1. OAuth completes → Worker calls `https://api.figma.com/v1/me` → gets `figmaUserId`
2. Looks up `user_session:${figmaUserId}` in KV → reuses existing UUID or creates new one
3. Stores as `bearer_token:${accessToken}` → `{ sessionId: userSessionId, figmaUserId, expiresAt }`
4. Displays Session ID on the post-auth page (intermediate page for MCP client flow, success page for direct browser flow)
5. User pastes Session ID into the Figma Desktop Bridge plugin → plugin subscribes to Supabase Realtime filtered on `session_id=eq.${sessionId}`

### Desktop Bridge (Remote Mode)

- The plugin connects to **Supabase Realtime** (not a local WebSocket).
- It polls the `bridge_commands` table filtered by the user's Session ID.
- The server URL entered in the plugin is only used to fetch `/bridge/config`, which returns `{ supabaseUrl, supabaseAnonKey, sessionId }`.
- CDP (Chrome DevTools Protocol) was removed in upstream v1.11.0 and is not used in this fork.

### Tool Registration Pattern

```ts
registerFigmaAPITools(server, getFigmaAPI, getConnector)
registerDesignCodeTools(server, getFigmaAPI)
registerCommentTools(server, getFigmaAPI)
registerDesignSystemTools(server, getFigmaAPI, getConnector)
```

Tool files live in `src/core/`. The largest is `src/core/figma-tools.ts` (~124 KB, do not modify).

### Key Source Files

```
src/
├── local.ts                  # Local entry point (out of scope)
├── index.ts                  # Cloudflare Workers entry point — main target
├── bridge-relay.ts           # Supabase bridge relay for write commands (new)
├── core/
│   ├── figma-tools.ts        # Main design tools (124 KB, do not modify)
│   ├── figma-api.ts          # REST API wrapper
│   ├── figma-connector.ts    # Connection abstraction
│   ├── websocket-server.ts   # Desktop Bridge WS server (local mode only)
│   ├── design-system-tools.ts
│   ├── design-code-tools.ts
│   ├── comment-tools.ts
│   ├── console-monitor.ts
│   ├── enrichment/
│   └── types/
├── apps/
│   ├── token-browser/        # MCP App: Token Browser UI (local mode only)
│   └── design-system-dashboard/  # MCP App: DS Dashboard UI (local mode only)
└── browser/
figma-desktop-bridge/         # git submodule → bridge-plugin/ repo
├── src/                      # TypeScript sources — EDIT HERE
│   ├── main.ts               # Entry point → compiled to code.js
│   ├── console-capture.ts    # Console interception (setupConsoleCapture)
│   ├── startup.ts            # documentchange / selectionchange / pagechange listeners
│   ├── capabilities.ts       # Capability detection
│   ├── handlers/
│   │   ├── system.ts         # RELOAD_UI, GET_FILE_INFO, SAVE_BRIDGE_CONFIG
│   │   ├── execute-code.ts   # EXECUTE_CODE (figma_execute)
│   │   ├── variables.ts
│   │   ├── components.ts
│   │   ├── component-properties.ts
│   │   ├── nodes.ts
│   │   └── screenshot.ts
│   └── utils/
├── code.js                   # ⚠️ BUILD OUTPUT — NEVER edit directly (esbuild from src/main.ts)
├── ui.html                   # Plugin UI — edit directly (not built)
├── build.mjs                 # esbuild config (ES2017 target — no ?. or ?? operators)
└── package.json              # build: "node build.mjs" / watch: "node build.mjs --watch"
```

## Plugin Build (figma-desktop-bridge)

**IMPORTANT:** `code.js` is a **compiled output**. Always edit sources in `figma-desktop-bridge/src/`.

```bash
cd figma-desktop-bridge
npm run build    # one-shot build → updates code.js
npm run watch    # watch mode for development
```

Target: **ES2017** — the Figma QuickJS sandbox does NOT support:
- Optional chaining `?.` → use `obj && obj.prop` instead
- Nullish coalescing `??` → use `obj !== null && obj !== undefined ? obj : default` instead
- Spread in some contexts

### Schema Compatibility

**No `z.any()`** — Gemini requires strictly typed Zod schemas. Always use specific types.

## Testing

Tests live in `tests/`. Run with `npm test` (Jest).

## Deployment

```bash
npm run build:cloudflare   # Build
npx wrangler deploy        # Deploy to Cloudflare Workers
```

Required Wrangler secrets (set with `npx wrangler secret put <NAME>`):

| Secret | Description |
|--------|-------------|
| `FIGMA_OAUTH_CLIENT_ID` | Figma OAuth app client ID |
| `FIGMA_OAUTH_CLIENT_SECRET` | Figma OAuth app client secret |
| `SUPABASE_URL` | Supabase project URL (e.g. `https://xxxx.supabase.co`) |
| `SUPABASE_ANON_KEY` | Supabase `anon` / `public` key (used by plugin) |
| `SUPABASE_SERVICE_KEY` | Supabase `service_role` key (used by Worker to bypass RLS) |

## Known Pre-existing Issues

- `src/index.ts` ~line 54: Env type mismatch (Cloudflare build, non-breaking)
- `src/apps/*/ui/mcp-app.ts`: DOM type errors (expected, separate tsconfig)

## Workflow Conventions

- Validate architecture before starting dev
- Petites étapes simples, valider avant de coder
- Build with `npm run build:cloudflare` after every change, verify 0 errors before deploying
