# Figma Console MCP — Remote Edition

[![MCP](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Fork of southleft/figma-console-mcp](https://img.shields.io/badge/fork-southleft%2Ffigma--console--mcp-lightgrey)](https://github.com/southleft/figma-console-mcp)

> **This is a fork of [southleft/figma-console-mcp](https://github.com/southleft/figma-console-mcp).**
> All credit for the original MCP server, tools, and Desktop Bridge plugin goes to the southleft team and contributors.
>
> This fork transforms the project into a **fully remote, hosted MCP service** — no local installation needed for end users.

---

## What is this?

**Figma Console MCP** is a Model Context Protocol server that connects AI assistants (Claude, Cursor, Windsurf…) to Figma. It gives AI complete access to your design system for **reading** design data (tokens, components, styles, variables) and **writing** directly into Figma (create frames, update variables, instantiate components, and more).

This fork adds a **remote-first architecture** on top of the original project:

| Original project | This fork |
|-----------------|-----------|
| Runs as a local Node.js process (`npx`) | Runs on **Cloudflare Workers** — no install needed |
| Connects to Figma via a local WebSocket | Connects via **Supabase Realtime** bridge relay |
| One user per machine | **Multi-user** — each team member has their own session |
| Manual Figma token setup | **Figma OAuth** — authenticate with one click |

### How write commands work

```
Claude / AI client
  → HTTPS → Cloudflare Worker (MCP server)
    → INSERT command → Supabase bridge_commands table
      → Figma Desktop Bridge plugin (Supabase Realtime)
        → executes figma.*() in Figma Desktop
          → writes result back to Supabase
    → Worker polls result → returns to Claude
```

---

## For Users — Connect to an existing deployment

> The following assumes an admin has already deployed this service and given you the Worker URL.

### What you need

- [Claude Desktop](https://claude.ai/download) (or another MCP-compatible client)
- [Figma Desktop](https://www.figma.com/downloads/) (for write operations — reading works without it)
- The Worker URL from your admin (e.g. `https://figma-console-mcp.your-org.workers.dev`)

---

### Step 1 — Connect your MCP client

#### Claude Desktop

1. Open Claude Desktop → **Settings** → **Integrations** (or **Connectors**)
2. Click **Add Custom Integration**
3. Set the URL to: `https://figma-console-mcp.your-org.workers.dev/sse`
4. Click **Add** and follow the Figma OAuth prompt that appears

#### Claude Code (CLI)

```bash
claude mcp add figma-console -s user -- npx -y mcp-remote@latest https://figma-console-mcp.your-org.workers.dev/sse
```

#### Cursor / Windsurf

Add to your MCP config file:

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://figma-console-mcp.your-org.workers.dev/sse"]
    }
  }
}
```

---

### Step 2 — Authenticate with Figma

When you first use the MCP (or when your token expires), a browser window opens and asks you to authorise the app in Figma. After clicking **Allow**:

1. **A page appears showing your Session ID** — copy it, you will need it for the plugin.
2. The page then automatically redirects back to your MCP client.

> The Session ID is your personal, stable identifier. It stays the same across reconnects as long as you use the same Figma account.

---

### Step 3 — Install and configure the Figma Desktop Bridge plugin

The plugin runs inside Figma Desktop and executes write commands locally on your behalf.

1. In Figma Desktop, go to **Plugins → Development → Import plugin from manifest…**
2. Select `figma-desktop-bridge/manifest.json` from this repository (ask your admin for the file, or clone the repo locally)
3. Run the plugin in any Figma file (**Plugins → Development → Figma Desktop Bridge**)
4. In the plugin UI:
   - Enter the **Worker URL**: `https://figma-console-mcp.your-org.workers.dev`
   - Enter your **Session ID** (from Step 2)
   - Click **Connect**

The plugin is now listening for commands from your Claude session. You only need to do this setup once — the URL and Session ID are saved automatically.

---

### Step 4 — Test it

Open a conversation in Claude and try:

```
Check Figma status
```
→ Should report that the bridge is connected.

```
Get the design variables from [your Figma file URL]
```
→ Should return your design tokens.

```
Create a blue rectangle 200×100 on the current page
```
→ Should create a shape in your open Figma file (plugin must be running).

---

### Available capabilities

| Capability | Without plugin | With plugin running |
|------------|---------------|---------------------|
| Read design tokens & variables | ✅ | ✅ |
| Read components & styles | ✅ | ✅ |
| Take screenshots | ✅ | ✅ |
| Create / edit frames and shapes | ❌ | ✅ |
| Manage design variables | ❌ | ✅ |
| Instantiate components | ❌ | ✅ |
| Run arbitrary Figma Plugin API code | ❌ | ✅ |

---

## For Developers / Admins — Deploy your own instance

### Prerequisites

- A **Cloudflare account** (free tier is enough — Workers + KV)
- A **Supabase project** (free tier is enough)
- A **Figma OAuth app** (created in [Figma's developer settings](https://www.figma.com/developers/apps))
- Node.js 18+ and `npm`

---

### Step 1 — Clone and install

```bash
git clone <this-repo-url>
cd figma-console-mcp
npm install
```

---

### Step 2 — Configure Cloudflare (wrangler.jsonc)

Make sure `wrangler.jsonc` has your KV namespace IDs. To create namespaces:

```bash
npx wrangler kv namespace create OAUTH_TOKENS
npx wrangler kv namespace create OAUTH_STATE
```

Then update `wrangler.jsonc` with the returned IDs.

---

### Step 3 — Set up Supabase

In your Supabase project, run the following SQL:

```sql
-- Create the bridge relay table
create table bridge_commands (
  id          uuid primary key default gen_random_uuid(),
  session_id  text not null,
  command     jsonb not null,
  result      jsonb,
  created_at  timestamptz default now(),
  resolved_at timestamptz
);

-- Enable Realtime for the table
alter table bridge_commands replica identity full;

-- RLS policies
alter table bridge_commands enable row level security;

-- Plugin (anon key): can read all rows, filters by session_id client-side
create policy "anon read" on bridge_commands
  for select to anon using (true);

-- Plugin (anon key): can only write a result back (no INSERT, no DELETE)
create policy "anon update result" on bridge_commands
  for update to anon
  with check (result is not null and resolved_at is not null);

-- Worker uses service_role key → bypasses RLS
```

Enable the `bridge_commands` table in **Supabase → Database → Replication** for Realtime to work.

---

### Step 4 — Create a Figma OAuth app

1. Go to [figma.com/developers/apps](https://www.figma.com/developers/apps) → **Create new app**
2. Set the **redirect URI** to: `https://figma-console-mcp.<your-subdomain>.workers.dev/oauth/callback`
3. Note the **Client ID** and **Client Secret**

---

### Step 5 — Set Wrangler secrets

```bash
npx wrangler secret put FIGMA_OAUTH_CLIENT_ID
npx wrangler secret put FIGMA_OAUTH_CLIENT_SECRET
npx wrangler secret put SUPABASE_URL          # e.g. https://xxxx.supabase.co
npx wrangler secret put SUPABASE_ANON_KEY     # anon/public key
npx wrangler secret put SUPABASE_SERVICE_KEY  # service_role key
```

---

### Step 6 — Build and deploy

```bash
npm run build:cloudflare
npx wrangler deploy
```

Your MCP server is now live. Share the Worker URL with your team.

---

### Step 7 — Distribute the plugin

Share the `figma-desktop-bridge/` folder (or the manifest + ui.html) with your team so they can import it in Figma Desktop (see User Setup Step 3 above).

---

### Architecture overview

```
Cloudflare Workers (src/index.ts)
├── /sse, /mcp         → MCP transport (SSE + Streamable HTTP)
├── /authorize         → Figma OAuth authorization
├── /oauth/callback    → Token exchange + per-user Session ID generation
├── /bridge/config     → Returns { supabaseUrl, supabaseAnonKey, sessionId }
└── MCP tools          → REST API reads + write commands via bridge-relay.ts

src/bridge-relay.ts
└── INSERT command → Supabase → plugin executes → Worker polls result

figma-desktop-bridge/ui.html
└── Supabase Realtime subscription (filtered by session_id)
    → executes figma.*() → UPDATE result
```

---

### Build commands

```bash
npm run build:cloudflare   # Build Worker
npm run build:local        # Build local mode (not used in this fork)
npm test                   # Run Jest tests
npm run lint:fix           # Biome linter
npx wrangler deploy        # Deploy to Cloudflare
npx wrangler secret list   # Verify secrets are set
```

---

## Credits

Original project: **[southleft/figma-console-mcp](https://github.com/southleft/figma-console-mcp)**
Built and maintained by the [southleft](https://github.com/southleft) team and contributors.

This fork adds the remote architecture described above. The core MCP tools, Desktop Bridge plugin base, and all upstream features are the work of the original authors.

---

## License

MIT — see [LICENSE](LICENSE).
