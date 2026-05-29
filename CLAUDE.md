# Figma Console MCP

The most comprehensive MCP server for Figma — design tokens, components, variables, and programmatic design creation.

## Build & Test

```bash
npm run build          # Compiles local + cloudflare + apps
npm run build:local    # Local mode only (use if Cloudflare types fail)
npm test               # Jest test suite
npx tsc --noEmit       # Type-check (pre-existing errors in src/apps/*/ui/mcp-app.ts are expected)
```

## Release Process

Before any release, read `.notes/RELEASING.md` and follow all five phases. Run `scripts/release.sh` for automated version/count updates before manual content edits.

## Known Issues

- **Cloudflare build type error**: `src/index.ts` line ~54 Env type mismatch is pre-existing on main. Does not affect runtime.
- **npm publish**: Use `npm publish --ignore-scripts` if prepublishOnly triggers a build failure.
- **Pre-existing tsc errors**: `src/apps/*/ui/mcp-app.ts` DOM type errors are expected (separate tsconfig files).

## Fork Ownership — NEVER OVERWRITE

This repo is a fork of `southleft/figma-console-mcp` (upstream = TJ's repo).

**Upstream (`southleft/figma-console-mcp`) owns:** all `src/`, `tests/`, `docs/`, `scripts/`, `package.json`, `figma-desktop-bridge/code.js` — pull these verbatim from upstream.

**This fork owns:** `figma-desktop-bridge/ui.html` and `figma-desktop-bridge/ui-full.html`. These files have a custom visual design layer that must never be overwritten by upstream changes.

### Upstream sync process

1. `git fetch upstream`
2. Fast-forward `main` to `upstream/main` — this brings in all upstream changes verbatim
3. On `ui-improvements-desktop-bridge`, the upstream changes to `ui.html` must be **cherry-picked as patches** on top of our version — check the diff and manually apply only the JS additions (message handlers, forwarding functions). Never let `ui.html` be replaced wholesale.
4. `ui-full.html` must always mirror `ui.html` exactly after any sync (`cp ui.html ui-full.html`).

### Fork-owned CSS rules (never hardcode, always use tokens)

`ui.html` uses a two-layer token system:
- **Figma surface tokens** (`--figma-color-bg`, `--figma-color-border`, etc.) — injected by Figma's `themeColors: true`
- **Status/log tokens** (`:root` + `body[data-theme]` overrides) — fork-owned, must be preserved on every rewrite:

| Token | Dark | Light |
|---|---|---|
| `--color-connected` | `#44FF88` | `#16a34a` |
| `--color-connected-glow` | `rgba(68,255,136,0.5)` | `rgba(22,163,74,0.45)` |
| `--color-waiting` | `#FFB700` | `#d97706` |
| `--color-error` | `#FF455B` | `#ef4444` |
| `--color-idle` | `#737373` | `#6b7280` |
| `--log-info` | `#6cf` | `#00639e` |
| `--log-success` | `#6f6` | `#167016` |
| `--log-error` | `#ff8080` | `#b81e2c` |
| `--log-warn` | `#fc0` | `#7a5c00` |

If any of these are ever hardcoded in CSS, that is a regression — replace with the token.

### Commit discipline

All UI work on `ui-improvements-desktop-bridge` must be committed before any upstream sync. Uncommitted changes cannot be rebased — they get stashed/popped and conflicts are hidden. Rule: no upstream fetch while `git status` shows modified files in `figma-desktop-bridge/`.

## Architecture

- Entry points: `src/local.ts` (local/NPX mode), `src/index.ts` (Cloudflare Workers)
- Tool registration: `registerXxxTools(server, getFigmaAPI, ...)` pattern in `src/tools/`
- Desktop Bridge: WebSocket (`src/core/websocket-server.ts`)
- Schema compatibility: No `z.any()` — Gemini requires strictly typed Zod schemas
