# figma-console-mcp (Claude)

Use this skill for this repository when requests involve Desktop Bridge UI, account switching, stable plugin import path, or Claude/Codex shared workflow.

## Trigger

Apply this skill when the user asks to:
- update Desktop Bridge plugin UI to match Figma
- debug plugin connection/sync behavior
- switch account or persist account state between Claude and Codex
- validate stable plugin import path and copy-link behavior

## Canonical Setup

- Source repo: `~/Claude Code/figma/figma-console-mcp`
- Stable plugin files: `~/Claude Code/figma-console-mcp/plugin/`
- Manifest to import once in Figma: `~/Claude Code/figma-console-mcp/plugin/manifest.json`
- Shared account metadata: `~/Claude Code/figma-console-mcp/accounts.json`

Always treat these as source of truth.

## Rules (Project-specific)

1. Do not create new ad-hoc plugin folders under cache/home paths.
2. Keep plugin import path fixed to the stable manifest.
3. Keep `accounts.json` metadata-only (`id`, `email`, `activeAccountId`).
4. Never persist plaintext tokens in `accounts.json`.
5. Use keychain-backed token storage on macOS (`figma-console-mcp-account-token`).
6. Keep account switching compatible across both Claude and Codex sessions.
7. Keep Add Account UI removed from plugin.
8. Keep Session Activity row removed unless explicitly requested.
9. Keep Desktop Bridge section expand/collapse behavior (default expanded).
10. Keep Cloud Mode section behavior intact.
11. Keep UI fidelity aligned with provided Figma frames (spacing, icon, wrapping, no clipping).

## UI Contract

Top context area must include:
- file icon + file name
- active account email
- helper text: switch account via Claude/Codex, then reload plugin

`Copy Link` behavior:
- Use canonical Figma design URL
- `&t=` is session/query context and optional

## Implementation Notes

- UI source: `figma-desktop-bridge/ui.html`
- Full UI bundle file: `figma-desktop-bridge/ui-full.html`
- Server account sync touchpoints:
  - `src/core/websocket-server.ts`
  - `src/local.ts`
  - `src/core/account-secrets.ts`

## Verification

Run:
- `npm run -s build:local`

Then verify in Figma Desktop:
- plugin loads via stable manifest
- Desktop Bridge section starts expanded
- icon, spacing, and wrapping match design
- account switch persists after reload/restart
