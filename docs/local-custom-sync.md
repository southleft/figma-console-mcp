# Local Custom Sync (Follow Upstream + Keep Local Patch)

This project is configured so you can:
- follow upstream repo: `southleft/figma-console-mcp`
- keep your local custom behavior (account switch + Claude/Codex sync + UI patch)

## Remotes

- `origin` -> `southleft/figma-console-mcp` (upstream)
- `builtbysang` -> your fork

## Patch branch

Use branch:
- `codex/bridge-ui-context-copy-link`

This branch contains your custom commits and should be used for daily work.

## Update flow (one command)

From repo root:

```bash
scripts/sync-upstream-keep-custom.sh
```

What it does:
1. Fetches latest `origin/main`
2. Rebases your patch branch on top of upstream main
3. Force-pushes rebased branch to your fork (`builtbysang`)

## After sync

If plugin/UI behavior changed, run:

```bash
npm run -s build:local
```

Then reload the plugin in Figma from the stable manifest path:

- `~/Claude Code/figma-console-mcp/plugin/manifest.json`

## Security Notes

- `accounts.json` stores metadata only (`id`, `email`, `activeAccountId`), not plaintext tokens.
- Account tokens are stored in macOS Keychain service `figma-console-mcp-account-token`.
- WebSocket bridge should stay on loopback (`localhost`/`127.0.0.1`/`::1`).
- If `FIGMA_WS_HOST` is set to a non-loopback host by mistake, server now forces `localhost`.
- Only use non-loopback bind intentionally with:
  - `FIGMA_WS_ALLOW_NON_LOCALHOST=true`
