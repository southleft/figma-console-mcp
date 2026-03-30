# figma-console-mcp (Codex)

Use this skill when working on `figma-console-mcp` plugin behavior, account sync, or Desktop Bridge UI.

## Scope

This skill is project-specific for:
- Desktop Bridge plugin UI (`figma-desktop-bridge/ui.html`, `ui-full.html`)
- Stable plugin copy path and import flow
- Shared account switching between Claude and Codex
- Token persistence and security model

## Canonical Paths

- Source repo: `~/Claude Code/figma/figma-console-mcp`
- Stable plugin dir: `~/Claude Code/figma-console-mcp/plugin`
- Stable manifest to import in Figma: `~/Claude Code/figma-console-mcp/plugin/manifest.json`
- Shared accounts metadata: `~/Claude Code/figma-console-mcp/accounts.json`

Do not create extra plugin folders in random working directories.

## Shared Rules

1. Keep one canonical stable plugin path (`~/Claude Code/figma-console-mcp/plugin`).
2. Keep account metadata in `accounts.json` only (`id`, `email`, `activeAccountId`).
3. Never store plaintext token in `accounts.json`.
4. On macOS, token storage is Keychain service `figma-console-mcp-account-token`.
5. Treat `FIGMA_ACCESS_TOKEN` as temporary override; account switch should persist via shared settings + keychain.
6. Plugin UI should not expose "Add account" form; account creation is done by agent/server workflow.
7. Keep `Desktop Bridge` section collapsible; default state is expanded.
8. Keep `Cloud Mode` section behavior unchanged unless explicitly requested.
9. `Copy Link` should return canonical Figma URL; `&t=` query is optional and not required.
10. WebSocket bridge must bind loopback only by default (`localhost`/`127.0.0.1`/`::1`).
11. Allow non-loopback bind only when explicitly set: `FIGMA_WS_ALLOW_NON_LOCALHOST=true`.

## Desktop Bridge UI Contract

- Header context card includes:
  - Figma icon + current file name
  - Active account email
  - helper text for switching account via Claude/Codex and reloading plugin
- Remove Session Activity row.
- Match spacing/typography from provided Figma spec; avoid text clipping and allow wrapping when needed.

## Update Workflow

When editing plugin UI:
1. Edit `figma-desktop-bridge/ui.html`.
2. Sync full build variant to `figma-desktop-bridge/ui-full.html`.
3. Sync stable copy to `~/Claude Code/figma-console-mcp/plugin/ui.html` and `ui-full.html` for immediate Figma reload tests.

When editing account logic:
1. Keep metadata in `accounts.json`.
2. Keep sensitive token reads/writes in keychain helper (`src/core/account-secrets.ts`).
3. Ensure `src/local.ts` and `src/core/websocket-server.ts` stay aligned on active account resolution.

## Validation Checklist

- `npm run -s build:local`
- Open/reload plugin in Figma and verify:
  - Desktop Bridge section default expanded
  - Cloud Mode toggle still works
  - file name icon and text spacing are correct
  - helper text is not clipped
  - account switch updates active account and survives restart

## Commit Guidance

When user asks to "commit lưu lại", include all intended plugin + account-sync changes together in one clear commit.
