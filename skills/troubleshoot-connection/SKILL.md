---
name: troubleshoot-connection
description: Diagnose and fix Figma Console MCP connection problems — "not connected", "plugin disconnected", "token expired", commands timing out or hitting the wrong file, "plugin is still busy", 403 errors, empty console logs. Use when any figma-console tool fails with a connection, routing, auth or timeout error, or the user says the bridge/plugin isn't working.
---

# Troubleshoot the Figma Console connection

> **Tools (Local Mode):** this skill uses tools outside the core set. If they aren't in your tool list, call `figma_enable_toolsets({ toolsets: ["debug"] })` once at the start; if they still don't appear, call them through `figma_call({ tool, arguments })`. Cloud Mode lists every tool, so skip this there.

Figma Console MCP reaches Figma through the **Desktop Bridge plugin**: the MCP server listens on a WebSocket in ports **9223–9232**, and the plugin, running inside each open Figma file, connects to it. REST tools (versions, comments, library search) additionally need a **Figma access token**. Almost every failure is one of: no plugin running, the wrong file targeted, a busy plugin, a missing token scope, or a message that actually came from a *different* Figma MCP server.

Work through the steps in order. Stop as soon as the problem is identified, and tell the user in plain language what was wrong and what you did.

## 1. Get the facts (always first)

Call `figma_diagnose` (add `verbose: true` if you need raw state). It reports, in plain language:
- whether this is figma-console-mcp at all (errors mentioning `use_figma`, "Dev Mode MCP" or port 3845 come from Figma's own MCP server, not this one),
- plugin connection, connected files, active file,
- token presence.

Then call `figma_get_status` with `probe: true`. The probe sends a real round trip to the plugin; `probeResult.success: false` with an open socket means the plugin is connected but not responding (see step 4).

## 2. No plugin connected

Symptoms: `figma_get_status` shows no connection; tools say the Desktop Bridge isn't running.

- Ask the user to open the **Desktop Bridge** plugin in the Figma file they want to work in (Plugins → Development → Figma Desktop Bridge). It connects on its own within a few seconds; you don't need to restart anything.
- If it isn't in the Development menu, it hasn't been imported: Plugins → Development → **Import plugin from manifest…** → `~/.figma-console-mcp/plugin/manifest.json`. Development plugins only run in the **Figma desktop app**, not figma.com in a browser.
- If the plugin shows an update banner, or the user just upgraded and things misbehave, have them re-import the manifest. Figma caches plugin files at the app level; reopening the plugin does not reload them.
- Plugin says "No MCP server found" / keeps scanning: the MCP server isn't running in their client. It starts when their MCP client (Claude Code, Cursor, …) starts.

## 3. Wrong file, or commands land somewhere unexpected

- `figma_list_open_files` lists every file with the plugin running and which one is **active**. All tools target the active file unless you pass `fileKey`.
- Switch with `figma_navigate({ url })`. To keep working in one file while the user works in another, use `figma_navigate({ url, lock: true })` so their clicks elsewhere can't move the target. Release with `lock: false`.
- `figma_navigate` never opens a file; if the file isn't listed, the user has to open it and run the plugin there.

## 4. Timeouts and "The Desktop Bridge plugin is still busy"

Figma can't interrupt a running plugin script. A long `figma_execute` keeps running after the server gives up, and later commands queue behind it; after two timeouts in a row the server stops sending to that file and says the plugin is busy.

- Wait — when the script finishes the busy state clears (the server also retries on its own after 10 minutes).
- To stop it now, the user closes and reopens the plugin in that file.
- Don't retry the same heavy script. Split it into smaller calls or pass a larger `timeout` to `figma_execute` (max 300000 ms). Avoid walking every node of a large file in one call; scope to a page or node.

If calls time out on a quiet plugin, `figma_reconnect` forces a fresh connection.

## 5. REST errors: 401, 403, "token"

- **401** — the token isn't recognized: missing, mistyped or revoked `FIGMA_ACCESS_TOKEN`.
- **403** — the token is valid but lacks a scope. Map the failing tool to the scope:
  - component search, design system kit, component docs, styles → `library_content:read`
  - looking up a published component by key → `library_assets:read`
  - version history, changelogs, version diffs, blame → `file_versions:read`
  - comments → `file_comments:read` / `file_comments:write`
  - variables over REST → `file_variables:read` (Enterprise only). On other plans, variables come through the plugin and need no scope — prefer `figma_get_variables` with the plugin open.
- The fix is a new token with the scopes, set as `FIGMA_ACCESS_TOKEN`, then restart the MCP client.
- "Token expired" while plugin tools work fine usually means the message came from another Figma MCP server the client also has configured. `figma_diagnose` says which server it is.

## 6. Many servers / port trouble

Each MCP client window can start its own server; they take successive ports in 9223–9232 and the plugin connects to all of them. The server cleans up orphaned instances on startup and every 5 minutes, so manual cleanup is rarely needed. Only if the user reports the plugin stuck after an upgrade, suggest (and let them run):

```bash
pkill -f figma-console-mcp
rm -f "${TMPDIR:-/tmp}"/figma-console-mcp-*.json /tmp/figma-console-mcp-*.json
```

then reload the plugin. Never kill processes on the user's machine without asking.

## 7. Console logs are empty

`figma_get_console_logs` only captures output from code run **through the bridge** (`figma_execute` and the write tools) and from the bridge itself — never from another plugin, which runs in its own sandbox. To debug plugin logic, run it through `figma_execute` and read the logs. Use `figma_watch_console` to stream logs for a period while something runs.

## Reporting back

Tell the user: what was wrong (one sentence), what you did or what they need to do, and confirm the fix with `figma_get_status({ probe: true })` before continuing the original task.
