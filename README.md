# Figma Console MCP Server

[![MCP](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io/)
[![npm](https://img.shields.io/npm/v/figma-console-mcp)](https://www.npmjs.com/package/figma-console-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Documentation](https://img.shields.io/badge/docs-docs.figma--console--mcp.southleft.com-0D9488)](https://docs.figma-console-mcp.southleft.com)
[![Sponsor](https://img.shields.io/badge/Sponsor-southleft-ea4aaa?logo=github-sponsors&logoColor=white)](https://github.com/sponsors/southleft)

> **Your design system as an API.** Model Context Protocol server that bridges design and development—giving AI assistants complete access to Figma for **extraction**, **creation**, **debugging**, and **bidirectional token sync**.

> **🆕 The "not connected until restart" bug is fixed (v1.31.0):** The Desktop Bridge dropping its connection — and only recovering when you closed the plugin, restarted your MCP client, or killed ports by hand — was caused by **zombie MCP processes** squatting the WebSocket port range after a bad shutdown. v1.31.0 force-kills them (`SIGTERM` → `SIGKILL`), sweeps the range every 5 minutes, and adds a shutdown backstop so a server can't zombify in the first place. The plugin now reconnects itself (auto-reconnect watchdog + one-click **Reconnect** button) instead of needing a restart. **Update and re-import the plugin once** to get the fix. [See what's new →](CHANGELOG.md#1310---2026-06-05)

## What is this?

Figma Console MCP connects AI assistants (like Claude) to Figma, enabling:

- **🎨 Design system extraction** - Pull variables, components, and styles
- **🔁 Bidirectional token sync** - Export Figma variables to DTCG JSON + CSS custom properties; push code-side edits back to Figma. Replaces Style Dictionary and Tokens Studio's export pipeline.
- **📸 Visual debugging** - Take screenshots for context
- **✏️ Design creation** - Create UI components, frames, and layouts directly in Figma
- **🔧 Variable management** - Create, update, rename, and delete design tokens
- **🕰 Version history & time-series awareness** - List versions, diff snapshots, generate markdown changelogs, trace property/variant introduction via binary-search blame
- **⚡ Real-time monitoring** - Watch console logs from the Desktop Bridge plugin
- **📌 FigJam boards** - Create stickies, flowcharts, tables, and code blocks on collaborative boards
- **🎞️ Slides presentations** - Build and manage Figma Slides decks programmatically
- **♿ Accessibility scanning** - 14 WCAG design checks with conformance level tagging, component scorecards, axe-core code scanning, design-to-code parity
- **🛡 Cross-MCP identity** - Every tool response carries `_mcp: "figma-console-mcp"` and errors are prefixed `[figma-console-mcp]` so attribution stays unambiguous in agents running multiple Figma MCPs
- **☁️ Cloud Write Relay** - Web AI clients (Claude.ai, v0, Replit) can design in Figma via cloud pairing
- **🔄 Four ways to connect** - Remote SSE, Cloud Mode, NPX, or Local Git

---

## ⚡ Quick Start

### Choose Your Setup

**First, decide what you want to do:**

| I want to... | Setup Method | Time |
|--------------|--------------|------|
| **Create and modify designs with AI** | [NPX Setup](#-npx-setup-recommended) (Recommended) | ~10 min |
| **Design from the web** (Claude.ai, v0, Replit, Lovable) | [Cloud Mode](#-cloud-mode-web-ai-clients) | ~5 min |
| **Contribute to the project** | [Local Git Setup](#for-contributors-local-git-mode) | ~15 min |
| **Just explore my design data** (read-only) | [Remote SSE](#-remote-sse-read-only-exploration) | ~2 min |

### ⚠️ Important: Capability Differences

| Capability | NPX / Local Git | Cloud Mode | Remote SSE |
|------------|-----------------|------------|------------|
| Read design data | ✅ | ✅ | ✅ |
| **Create components & frames** | ✅ | ✅ | ❌ |
| **Edit existing designs** | ✅ | ✅ | ❌ |
| **Manage design tokens/variables** | ✅ | ✅ | ❌ |
| **FigJam boards (stickies, flowcharts)** | ✅ | ✅ | ❌ |
| Real-time monitoring (console, selection) | ✅ | ❌ | ❌ |
| Desktop Bridge plugin | ✅ | ✅ | ❌ |
| Requires Node.js | Yes | **No** | No |
| **Total tools available** | **106** | **95** | **9** |

> **Bottom line:** Remote SSE is **read-only** with ~38% of the tools. **Cloud Mode** unlocks write access from web AI clients without Node.js. NPX/Local Git gives the full 106 tools with real-time monitoring.

---

### 🚀 NPX Setup (Recommended)

**Best for:** Designers who want full AI-assisted design capabilities.

**What you get:** All 106 tools including design creation, variable management, and component instantiation.

#### Prerequisites

- [ ] **Node.js 18+** — Check with `node --version` ([Download](https://nodejs.org))
- [ ] **Figma Desktop** installed (not just the web app)
- [ ] **An MCP client** (Claude Code, Cursor, Windsurf, Claude Desktop, etc.)

#### Step 1: Get Your Figma Token

1. Go to [Manage personal access tokens](https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens) in Figma Help
2. Follow the steps to **create a new personal access token**
3. Enter description: `Figma Console MCP`
4. Set scopes: **File content** (Read), **File versions** (Read), **Variables** (Read), **Comments** (Read and write)
5. **Copy the token** — you won't see it again! (starts with `figd_`)

#### Step 2: Configure Your MCP Client

**Claude Code (CLI):**
```bash
claude mcp add figma-console -s user -e FIGMA_ACCESS_TOKEN=figd_YOUR_TOKEN_HERE -e ENABLE_MCP_APPS=true -- npx -y figma-console-mcp@latest
```

**Cursor / Windsurf / Claude Desktop:**

Add to your MCP config file (see [Where to find your config file](#-where-to-find-your-config-file) below):

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["-y", "figma-console-mcp@latest"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_YOUR_TOKEN_HERE",
        "ENABLE_MCP_APPS": "true"
      }
    }
  }
}
```

#### 📂 Where to Find Your Config File

If you're not sure where to put the JSON configuration above, here's where each app stores its MCP config:

| App | macOS | Windows |
|-----|-------|---------|
| **Claude Desktop** | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` |
| **Claude Code (CLI)** | `~/.claude.json` | `%USERPROFILE%\.claude.json` |
| **Cursor** | `~/.cursor/mcp.json` | `%USERPROFILE%\.cursor\mcp.json` |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` |

> **Tip for designers:** The `~` symbol means your **home folder**. On macOS, that's `/Users/YourName/`. On Windows, it's `C:\Users\YourName\`. You can open these files in any text editor — even TextEdit or Notepad.
>
> **Can't find the file?** If it doesn't exist yet, create it. The app will pick it up on its next restart. Make sure the entire file is valid JSON (watch for missing commas or brackets).
>
> **Claude Code users:** You can skip manual editing entirely. Just run the `claude mcp add` command above and it handles everything for you.

#### Step 3: Connect to Figma Desktop

**Desktop Bridge Plugin:**
1. Open Figma Desktop normally (no special flags needed) and open a file
2. Go to **Plugins → Development → Import plugin from manifest...**
3. Select `~/.figma-console-mcp/plugin/manifest.json` (stable path, auto-created by the MCP server)
4. Run the plugin in your Figma file — it scans ports 9223–9232 and connects automatically to your running MCP server

> **Heads-up on plugin updates.** Figma caches plugin files (`code.js` and `ui.html`) at the application level. The MCP server refreshes the files at `~/.figma-console-mcp/plugin/` on every startup, but Figma keeps using its cached copy until you re-import the manifest.
>
> **Re-importing is _required_ only when a release notes entry says so** — typically when the plugin adds a new method the server needs (e.g. v1.22.4, v1.10.0). For most upgrades the new server stays wire-compatible with the previous plugin, and re-importing is **optional**: you'll still get every functional change, just not the cosmetic plugin-side touches (status-pill copy, `pluginVersion` reporting).
>
> When you do re-import: Plugins → Manage plugins → re-import `~/.figma-console-mcp/plugin/manifest.json`. The stable path never changes, so it's a one-click step.

#### Step 4: Restart Your MCP Client

Restart your MCP client to load the new configuration.

#### Step 5: Test It!

```
Check Figma status
```
→ Should show connection status with active WebSocket transport

```
Create a simple frame with a blue background
```
→ Should create a frame in Figma (confirms write access!)

**📖 [Complete Setup Guide](docs/setup.md)**

---

### For Contributors: Local Git Mode

**Best for:** Developers who want to modify source code or contribute to the project.

**What you get:** Same 106 tools as NPX, plus full source code access.

#### Quick Setup

```bash
# Clone and build
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp
npm install
npm run build:local
```

#### Configure Your MCP Client

Add to your config file (see [Where to find your config file](#-where-to-find-your-config-file)):

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "node",
      "args": ["/absolute/path/to/figma-console-mcp/dist/local.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_YOUR_TOKEN_HERE",
        "ENABLE_MCP_APPS": "true"
      }
    }
  }
}
```

Then follow [NPX Steps 3-5](#step-3-connect-to-figma-desktop) above.

**📖 [Complete Setup Guide](docs/setup.md)**

---

### 📡 Remote SSE (Read-Only Exploration)

**Best for:** Quickly evaluating the tool or read-only design data extraction.

**What you get:** 9 read-only tools — view data, take screenshots, read logs, design-code parity. **Cannot create or modify designs.**

#### Claude Desktop (UI Method)

1. Open Claude Desktop → **Settings** → **Connectors**
2. Click **"Add Custom Connector"**
3. Enter:
   - **Name:** `Figma Console (Read-Only)`
   - **URL:** `https://figma-console-mcp.southleft.com/sse`
4. Click **"Add"** — Done! ✅

OAuth authentication happens automatically when you first use design system tools.

#### Claude Code

> **⚠️ Known Issue:** Claude Code's native `--transport sse` has a [bug](https://github.com/anthropics/claude-code/issues/2466). Use `mcp-remote` instead:

```bash
claude mcp add figma-console -s user -- npx -y mcp-remote@latest https://figma-console-mcp.southleft.com/sse
```

**💡 Tip:** For full capabilities, use [NPX Setup](#-npx-setup-recommended) instead of Remote SSE.

#### Other Clients (Cursor, Windsurf, etc.)

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://figma-console-mcp.southleft.com/sse"]
    }
  }
}
```

#### Upgrading to Full Capabilities

Ready for design creation? Follow the [NPX Setup](#-npx-setup-recommended) guide above, or try [Cloud Mode](#-cloud-mode-web-ai-clients) if you don't want to install Node.js.

**📖 [Complete Setup Guide](docs/setup.md)**

---

### ☁️ Cloud Mode (Web AI Clients)

**Best for:** Using Claude.ai, v0, Replit, or Lovable to create and modify Figma designs — no Node.js required.

**What you get:** 95 tools including full write access — design creation, variable management, component instantiation, and all REST API tools. Only real-time monitoring (console logs, selection tracking, document changes) requires Local Mode.

#### Prerequisites

- [ ] **Figma Personal Access Token** — [Create one here](https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens) (starts with `figd_`)
- [ ] **Figma Desktop** with the Desktop Bridge plugin installed (see [Desktop Bridge setup](#step-3-connect-to-figma-desktop))
- [ ] **A web AI client** that supports MCP (Claude.ai, Lovable, v0, Replit, etc.)

#### Step 1: Add the MCP Connector

Add this endpoint to your AI platform's MCP settings:

**URL:** `https://figma-console-mcp.southleft.com/mcp`
**Auth:** Your Figma PAT as Bearer token

In **Claude.ai**: Settings → Connectors → Add Custom Connector → paste the URL above.
In **Lovable/v0/Replit**: Look for "Add MCP Server" or "Integrations" in settings → paste the URL and add your token.

#### Step 2: Pair the Plugin

1. **Open the Desktop Bridge plugin** in Figma Desktop (Plugins → Development → Figma Desktop Bridge)
2. **Tell your AI assistant:**
   ```
   Connect to my Figma plugin
   ```
3. **The AI gives you a 6-character pairing code** (expires in 5 minutes)
4. **In the plugin:** Toggle "Cloud Mode" → enter the code → click Connect
5. **You're paired!** Full write access is now available

#### What You Can Do

Once paired, use natural language to design:
```
Create a card component with a header image, title, description, and action button
Set up a color token collection with Light and Dark modes
Add a "High Contrast" mode to my existing token collection
```

#### How It Works

Your AI client sends write commands through the cloud MCP server, which relays them via WebSocket to the Desktop Bridge plugin running in your Figma Desktop. The plugin executes the commands using the Figma Plugin API and returns results back through the same path.

```
AI Client → Cloud MCP Server → Durable Object Relay → Desktop Bridge Plugin → Figma
```

> **Variables on any plan:** Cloud Mode uses the Plugin API (not the Enterprise REST API), so variable management works on Free, Pro, and Organization plans.

**📖 [Complete Setup Guide](docs/setup.md)**

---

## 📊 Installation Method Comparison

| Feature | NPX (Recommended) | Cloud Mode | Local Git | Remote SSE |
|---------|-------------------|------------|-----------|------------|
| **Setup time** | ~10 minutes | ~5 minutes | ~15 minutes | ~2 minutes |
| **Total tools** | **106** | **95** | **106** | **9** (read-only) |
| **Design creation** | ✅ | ✅ | ✅ | ❌ |
| **Variable management** | ✅ | ✅ | ✅ | ❌ |
| **Component instantiation** | ✅ | ✅ | ✅ | ❌ |
| **FigJam boards** | ✅ | ✅ | ✅ | ❌ |
| **Real-time monitoring** | ✅ | ❌ | ✅ | ❌ |
| **Desktop Bridge plugin** | ✅ | ✅ | ✅ | ❌ |
| **Variables (no Enterprise)** | ✅ | ✅ | ✅ | ❌ |
| **Console logs** | ✅ (zero latency) | ❌ | ✅ (zero latency) | ✅ |
| **Read design data** | ✅ | ✅ | ✅ | ✅ |
| **Requires Node.js** | Yes | **No** | Yes | No |
| **Authentication** | PAT (manual) | OAuth (automatic) | PAT (manual) | OAuth (automatic) |
| **Automatic updates** | ✅ (`@latest`) | ✅ | Manual (`git pull`) | ✅ |
| **Source code access** | ❌ | ❌ | ✅ | ❌ |

> **Key insight:** Remote SSE is read-only. Cloud Mode adds write access for web AI clients without Node.js. NPX/Local Git give the full 106 tools.

**📖 [Complete Feature Comparison](docs/mode-comparison.md)**

---

## 🎯 Test Your Connection

After setup, try these prompts:

**Basic test (all modes):**
```
Navigate to https://www.figma.com and check status
```

**Design system test (requires auth):**
```
Get design variables from [your Figma file URL]
```

**Cloud Mode test:**
```
Connect to my Figma plugin
```
→ Follow the pairing flow, then try: "Create a simple blue rectangle"

**Plugin test (Local Mode only):**
```
Show me the primary font for [your theme name]
```

---

## 🔐 Authentication

### Remote Mode - OAuth (Automatic)

When you first use design system tools:
1. Browser opens automatically to Figma authorization page
2. Click "Allow" to authorize (one-time)
3. Token stored securely and refreshed automatically
4. Works with Free, Pro, and Enterprise Figma plans

### Local Mode - Personal Access Token (Manual)

1. Visit https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens
2. Generate token with scopes: **File content** (Read), **File versions** (Read), **Variables** (Read), **Comments** (Read and write)
3. Add to MCP config as `FIGMA_ACCESS_TOKEN` environment variable

---

## 🛠️ Available Tools

### Status & Diagnostics
- `figma_get_status` - Check WebSocket bridge connection and file context
- `figma_diagnose` - Designer-readable health check + setup guidance
- `figma_reconnect` - Force reconnect to the Desktop Bridge plugin
- `figma_navigate` - Switch the active file target among connected plugins (Local), or navigate the cloud headless browser (Remote/Cloud)

### Console Debugging
- `figma_get_console_logs` - Retrieve console logs
- `figma_watch_console` - Real-time log streaming
- `figma_clear_console` - Clear log buffer
- `figma_reload_plugin` - Reload current page

### Visual Debugging
- `figma_take_screenshot` - Capture UI screenshots

### Design System Extraction
- `figma_get_design_system_kit` - **Full design system in one call** — tokens, components, styles, visual specs
- `figma_get_variables` - Extract design tokens/variables
- `figma_get_component` - Get component data (metadata or reconstruction spec)
- `figma_get_component_for_development` - Component + image
- `figma_get_component_image` - Just the image
- `figma_get_styles` - Color, text, effect styles
- `figma_get_file_data` - Full file structure
- `figma_get_file_for_plugin` - Optimized file data

### 📚 Shared Library Inspection
- `figma_get_library_component_by_key` - **Resolve any component key to full properties + variants + visual specs** — without needing the source library file's URL. Works for both COMPONENT_SET and standalone COMPONENT keys. Adaptive compression at >500KB.
- `figma_get_library_components` - Discover all components in a library file (requires library file URL/key)
- `figma_get_library_variables` - List every variable from team libraries the current file has subscribed. **Works on every Figma plan** — uses the Plugin API path, not the Enterprise-only REST endpoint. Filter by `libraryName`, `collectionName`, or `resolvedType`.
- `figma_import_library_variable` - Import a library variable into the current file. Returns a local `id` ready to pass to `figma_set_fills` / `figma_update_variable` / any variable-binding tool.

### ☁️ Cloud Relay
- `figma_pair_plugin` - Generate a pairing code to connect a Desktop Bridge plugin via the cloud relay

### ✏️ Design Creation (Local Mode + Cloud Mode)
- `figma_execute` - **Power tool**: Run any Figma Plugin API code to create designs
  - Create frames, shapes, text, components
  - Apply auto-layout, styles, effects
  - Build complete UI mockups programmatically
- `figma_arrange_component_set` - **Organize variants into professional component sets**
  - Convert multiple component variants into a proper Figma component set
  - Applies native purple dashed border visualization automatically
  - Creates white container frame with title, row labels, and column headers
  - Row labels vertically centered with each grid row
  - Column headers horizontally centered with each column
  - Use natural language like "arrange these variants" or "organize as component set"
- `figma_set_description` - **Document components with rich descriptions**
  - Add descriptions to components, component sets, and styles
  - Supports markdown formatting for rich documentation
  - Descriptions appear in Dev Mode for developers

### 🔍 Design-Code Parity (All Modes)
- `figma_check_design_parity` - Compare Figma component specs against code implementation, producing a scored diff report with actionable fix items
- `figma_generate_component_doc` - Generate platform-agnostic markdown documentation by merging Figma design data with code-side info

### 🔁 Token Sync (Local Mode + Cloud Mode)
- `figma_export_tokens` - **Export Figma variables to design token files in your codebase.** Canonical DTCG JSON + CSS custom properties out of the box. Diff-aware merge against existing source files (only writes what changed). `tokens.config.json` autodiscovery means zero-arg calls after first setup. Replaces Style Dictionary and Tokens Studio's export pipeline for popular styling methods.
- `figma_import_tokens` - **Push code-side token edits back to Figma.** Diff against current Figma state, apply only the deltas. Round-trip safe — Figma variable IDs preserved in DTCG `$extensions["figma-console-mcp"]` so renames on either side don't create duplicates. Dry-run default for safety. In Cloud Mode, pass tokens inline via `payload` or `files` (no local filesystem access).

### 🔧 Variable Management (Local Mode + Cloud Mode)
- `figma_create_variable_collection` - Create new variable collections with modes
- `figma_create_variable` - Create COLOR, FLOAT, STRING, or BOOLEAN variables
- `figma_update_variable` - Update variable values in specific modes
- `figma_rename_variable` - Rename variables while preserving values
- `figma_delete_variable` - Delete variables
- `figma_delete_variable_collection` - Delete collections and all their variables
- `figma_add_mode` - Add modes to collections (e.g., "Dark", "Mobile")
- `figma_rename_mode` - Rename existing modes
- `figma_batch_create_variables` - Create up to 100 variables in one call (10-50x faster)
- `figma_batch_update_variables` - Update up to 100 variable values in one call
- `figma_setup_design_tokens` - Create complete token system (collection + modes + variables) atomically

### 📌 FigJam Board Tools (Local Mode + Cloud Mode)
- `figjam_create_sticky` - Create a sticky note with color options
- `figjam_create_stickies` - Batch create up to 200 stickies
- `figjam_create_connector` - Connect nodes with labeled connector lines
- `figjam_create_shape_with_text` - Create flowchart shapes (diamond, ellipse, etc.)
- `figjam_create_table` - Create tables with cell data
- `figjam_create_code_block` - Add code snippets with syntax highlighting
- `figjam_auto_arrange` - Arrange nodes in grid, horizontal, or vertical layouts
- `figjam_get_board_contents` - Read all content from a FigJam board
- `figjam_get_connections` - Read the connection graph (flowcharts, relationships)

### 🎞️ Slides Presentation Tools (Local Mode + Cloud Mode)
- `figma_list_slides` - List all slides with IDs, positions, and skip status
- `figma_get_slide_content` - Get the full content tree of a slide
- `figma_get_slide_grid` - Get the 2D grid layout of the presentation
- `figma_get_slide_transition` - Read transition settings for a slide
- `figma_get_focused_slide` - Get the currently focused slide
- `figma_create_slide` - Create a new blank slide
- `figma_delete_slide` - Delete a slide from the presentation
- `figma_duplicate_slide` - Clone an existing slide
- `figma_reorder_slides` - Reorder slides via new 2D grid layout
- `figma_set_slide_transition` - Set transition effects (22 styles, 8 curves)
- `figma_skip_slide` - Toggle whether a slide is skipped in presentation mode
- `figma_add_text_to_slide` - Add text to a slide with custom fonts, colors, alignment, and wrapping
- `figma_add_shape_to_slide` - Add rectangle or ellipse shapes with color
- `figma_set_slide_background` - Set a slide's background color (creates or updates)
- `figma_get_text_styles` - Get all local text styles with IDs, fonts, and sizes
- `figma_set_slides_view_mode` - Toggle grid vs. single-slide view
- `figma_focus_slide` - Navigate to a specific slide

**📖 [Detailed Tool Documentation](docs/TOOLS.md)**

---

## 📖 Example Prompts

### Cloud Mode (Web AI Clients)
```
Connect to my Figma plugin so we can start designing
Pair with my Figma file and create a login form with email, password, and submit button
Set up a brand color token collection with Light and Dark modes
```

### Plugin Debugging
```
Navigate to my Figma plugin and show me any console errors
Watch the console for 30 seconds while I test my plugin
Get the last 20 console logs
```

### Design System Extraction
```
Get all design variables from https://figma.com/design/abc123
Extract color styles and show me the CSS exports
Get the Button component with a visual reference image
Get the Badge component in reconstruction format for programmatic creation
```

### Design Creation (Local Mode + Cloud Mode)
```
Create a success notification card with a checkmark icon and message
Design a button component with hover and disabled states
Build a navigation bar with logo, menu items, and user avatar
Create a modal dialog with header, content area, and action buttons
Arrange these button variants into a component set
Organize my icon variants as a proper component set with the purple border
```

### Variable Management (Local Mode + Cloud Mode)
```
Create a new color collection called "Brand Colors" with Light and Dark modes
Add a primary color variable with value #3B82F6 for Light and #60A5FA for Dark
Rename the "Default" mode to "Light Theme"
Add a "High Contrast" mode to the existing collection
```

### Design-Code Parity
```
Compare the Button component in Figma against our React implementation
Check design parity for the Card component before sign-off
Generate component documentation for the Dialog from our design system
```

### FigJam Boards
```
Create a retrospective board with "Went Well", "To Improve", and "Action Items" columns
Build a user flow diagram for the checkout process with decision points
Read this brainstorming board and summarize the key themes
Generate an affinity map from these meeting notes
Create a comparison table of our three platform options
```

### Slides Presentations
```
List all slides and tell me which ones are skipped
Add a new slide with the title "Thank You" in 72px text
Set a DISSOLVE transition on the first slide with 0.5 second duration
Duplicate slide 5 for an A/B comparison
Skip slides 8 and 9 — they're not ready for the client presentation
Reorder my slides so the conclusion comes before Q&A
```

### Visual Debugging
```
Take a screenshot of the current Figma canvas
Navigate to this file and capture what's on screen
```

**📖 [More Use Cases & Examples](docs/USE_CASES.md)**

---

## 🎨 AI-Assisted Design Creation

> **Requires Desktop Bridge:** This feature works with Local Mode (NPX or Local Git) and [Cloud Mode](#-cloud-mode-web-ai-clients). Remote SSE without Cloud Mode pairing is read-only and cannot create or modify designs.

One of the most powerful capabilities of this MCP server is the ability to **design complete UI components and pages directly in Figma through natural language conversation** with any MCP-compatible AI assistant like Claude Desktop or Claude Code.

### What's Possible

**Create original designs from scratch:**
```
Design a login card with email and password fields, a "Forgot password?" link,
and a primary Sign In button. Use 32px padding, 16px border radius, and subtle shadow.
```

**Leverage existing component libraries:**
```
Build a dashboard header using the Avatar component for the user profile,
Button components for actions, and Badge components for notifications.
```

**Generate complete page layouts:**
```
Create a settings page with a sidebar navigation, a main content area with form fields,
and a sticky footer with Save and Cancel buttons.
```

### How It Works

1. **You describe what you want** in plain English
2. **The AI searches your component library** using `figma_search_components` to find relevant building blocks
3. **Components are instantiated** with proper variants and properties via `figma_instantiate_component`
4. **Custom elements are created** using the full Figma Plugin API via `figma_execute`
5. **Visual validation** automatically captures screenshots and iterates until the design looks right

### Who Benefits

| Role | Use Case |
|------|----------|
| **Designers** | Rapidly prototype ideas without manual frame-by-frame construction. Explore variations quickly by describing changes. |
| **Developers** | Generate UI mockups during planning discussions. Create visual specs without switching to design tools. |
| **Product Managers** | Sketch out feature concepts during ideation. Communicate visual requirements directly to stakeholders. |
| **Design System Teams** | Test component flexibility by generating compositions. Identify gaps in component coverage. |
| **Agencies** | Speed up initial concept delivery. Iterate on client feedback in real-time during calls. |

### Example Workflows

**Brand New Design:**
> "Create a notification toast with an icon on the left, title and description text, and a dismiss button. Use our brand colors."

The AI creates custom frames, applies your design tokens, and builds the component from scratch.

**Component Composition:**
> "Build a user profile card using the Avatar component (large size), two Button components (Edit Profile and Settings), and a Badge for the user's status."

The AI searches your library, finds the exact components, and assembles them with proper spacing and alignment.

**Design Iteration:**
> "The spacing feels too tight. Increase the gap between sections to 24px and make the heading larger."

The AI modifies the existing design, takes a screenshot to verify, and continues iterating until you're satisfied.

### Visual Validation

The AI automatically follows a validation workflow after creating designs:

1. **Create** → Execute the design code
2. **Screenshot** → Capture the result
3. **Analyze** → Check alignment, spacing, and visual balance
4. **Iterate** → Fix any issues detected
5. **Verify** → Final screenshot to confirm

This ensures designs aren't just technically correct—they *look* right.

---

## 🎨 Desktop Bridge Plugin (Recommended Connection)

The **Figma Desktop Bridge** plugin is the recommended way to connect Figma to the MCP server. It communicates via WebSocket — no special Figma launch flags needed, and it persists across Figma restarts.

### Setup

1. Open Figma Desktop (normal launch — no debug flags needed)
2. Go to **Plugins → Development → Import plugin from manifest...**
3. Select `figma-desktop-bridge/manifest.json` from the figma-console-mcp directory
4. Run the plugin in your Figma file — it auto-connects via WebSocket (scans ports 9223–9232)
5. Ask your AI: "Check Figma status" to verify the connection

> **One-time import.** Once imported, the plugin stays in your Development plugins list. Just run it whenever you want to use the MCP.

**📖 [Desktop Bridge Documentation](figma-desktop-bridge/README.md)**

### Capabilities

**Read Operations:**
- Variables without Enterprise API
- Reliable component descriptions (bypasses API bugs)
- Multi-mode support (Light/Dark/Brand variants)
- Real-time selection tracking and document change monitoring

**Write Operations:**
- **Design Creation** - Create frames, shapes, text, components via `figma_execute`
- **Variable Management** - Full CRUD operations on variables and collections
- **Mode Management** - Add and rename modes for multi-theme support

### How the Transport Works

- The MCP server communicates via **WebSocket** through the Desktop Bridge plugin
- The server tries port 9223 first, then automatically falls back through ports 9224–9232 if needed
- The plugin scans all ports in the range and connects to every active server it finds
- All 106 tools work through the WebSocket transport

**Multiple files:** The WebSocket server supports multiple simultaneous plugin connections — one per open Figma file. Each connection is tracked by file key with independent state (selection, document changes, console logs).

**Environment variables:**
- `FIGMA_WS_PORT` — Override the preferred WebSocket port (default: 9223). The server will fall back through a 10-port range starting from this value if the preferred port is occupied.
- `FIGMA_WS_HOST` — Override the WebSocket server bind address (default: `localhost`). Set to `0.0.0.0` when running inside Docker so the host machine can reach the MCP server.

**Cloud Mode:** The plugin also supports a **Cloud Mode** toggle for pairing with web AI clients (Claude.ai, v0, Replit, Lovable). Toggle "Cloud Mode" in the plugin UI, enter the 6-character pairing code from your AI assistant, and click Connect. See [Cloud Mode](#-cloud-mode-web-ai-clients) for details.

**Plugin Limitation:** In Local Mode, works with NPX or Local Git. In Cloud Mode, pairs with the remote MCP endpoint. Remote SSE without Cloud Mode pairing is read-only.

---

## 🔀 Multi-Instance Support (v1.10.0)

Figma Console MCP now supports **multiple simultaneous instances** — perfect for designers and developers who work across multiple projects or use Claude Desktop's Chat and Code tabs at the same time.

### The Problem (Before v1.10.0)

When two processes tried to start the MCP server (e.g., Claude Desktop's Chat tab and Code tab), the second one would crash with `EADDRINUSE` because both competed for port 9223.

### How It Works Now

- The server tries port **9223** first (the default)
- If that port is already taken, it automatically tries **9224**, then **9225**, and so on up to **9232**
- The Desktop Bridge plugin in Figma connects to **all** active servers simultaneously
- Every server instance receives real-time events (selection changes, document changes, console logs)
- `figma_get_status` shows which port you're on and lists other active instances

### What This Means for You

| Scenario | Before v1.10.0 | Now |
|----------|----------------|-----|
| Two Claude Desktop tabs (Chat + Code) | Second tab crashes | Both work independently |
| Multiple CLI terminals on different projects | Only one can run | All run simultaneously |
| Claude Desktop + Claude Code CLI | Port conflict | Both coexist |

### Do I Need to Do Anything?

**Nothing.** Multi-instance support is fully automatic:
- Each MCP server claims the next available port in the range
- The Desktop Bridge plugin scans all ports and connects to every active server
- Orphaned processes from closed tabs are automatically cleaned up on startup
- No manual port management — the plugin already scans the whole range

(Re-importing the manifest is only required when the plugin code itself changes — e.g. after a package update. Port-range scanning is already in the shipped plugin.)

---

## 🧩 MCP Apps (Experimental)

Figma Console MCP includes support for **MCP Apps** — rich interactive UI experiences that render directly inside any MCP client that supports the [MCP Apps protocol extension](https://github.com/anthropics/anthropic-cookbook/tree/main/misc/model_context_protocol/ext-apps). Built with the official [`@modelcontextprotocol/ext-apps`](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps) SDK.

> **What are MCP Apps?** Traditional MCP tools return text or images to the AI. MCP Apps go further — they render interactive HTML interfaces inline in the chat, allowing users to browse, filter, and interact with data directly without consuming AI context.

### Token Browser

An interactive design token explorer.

**Usage:** Ask Claude to "browse the design tokens" or "show me the design tokens" while connected to a Figma file.

**Features:**
- Browse all tokens organized by collection with expandable sections
- Filter by type (Colors, Numbers, Strings) and search by name/description
- Per-collection mode columns (Light, Dark, Custom) matching Figma's Variables panel
- Color swatches, alias resolution, and click-to-copy on any value
- Works without Enterprise plan via Desktop Bridge (local mode)

### Design System Dashboard

A Lighthouse-style health scorecard that audits your design system across six categories.

**Usage:** Ask Claude to "audit the design system" or "show me design system health" while connected to a Figma file.

**Features:**
- Overall weighted score (0–100) with six category gauges: Naming, Tokens, Components, Accessibility, Consistency, Coverage
- Expandable category sections with individual findings, severity indicators, and actionable details
- Diagnostic locations linking findings to specific variables, components, or collections
- Tooltips explaining each check's purpose and scoring criteria
- Refresh button to re-run the audit without consuming AI context
- Pure scoring engine with no external dependencies — all analysis runs locally

**Enabling MCP Apps:**

MCP Apps are enabled by default in the setup configurations above (via `"ENABLE_MCP_APPS": "true"`). If you set up before v1.10.0 and don't have this in your config, add it to your `env` section:

```json
"env": {
  "FIGMA_ACCESS_TOKEN": "figd_YOUR_TOKEN_HERE",
  "ENABLE_MCP_APPS": "true"
}
```

> **Note:** MCP Apps require an MCP client with [ext-apps protocol](https://github.com/anthropics/anthropic-cookbook/tree/main/misc/model_context_protocol/ext-apps) support (e.g. Claude Desktop). This feature is experimental and the protocol may evolve.

### Future MCP Apps Roadmap

Planned MCP Apps:

- **Component Gallery** — Visual browser for searching and previewing components with variant exploration
- **Style Inspector** — Interactive panel for exploring color, text, and effect styles with live previews
- **Variable Diff Viewer** — Side-by-side comparison of token values across modes and branches

The architecture supports adding new apps with minimal boilerplate — each app is a self-contained module with its own server-side tool registration and client-side UI.

---

## 🚀 Advanced Topics

- **[Setup Guide](docs/SETUP.md)** - Complete setup guide for all MCP clients
- **[Self-Hosting](docs/SELF_HOSTING.md)** - Deploy your own instance on Cloudflare
- **[Architecture](docs/ARCHITECTURE.md)** - How it works under the hood
- **[OAuth Setup](docs/OAUTH_SETUP.md)** - Configure OAuth for self-hosted deployments
- **[Troubleshooting](docs/TROUBLESHOOTING.md)** - Common issues and solutions

---

## 🤝 vs. Figma Official MCP

**Figma Console MCP (This Project)** - Debugging, data extraction, and design creation
- ✅ Real-time console logs from Figma plugins
- ✅ Screenshot capture and visual debugging
- ✅ Error stack traces and runtime monitoring
- ✅ Raw design data extraction (JSON)
- ✅ FigJam board creation and reading (stickies, flowcharts, tables)
- ✅ Works remotely or locally

**Figma Official Dev Mode MCP** - Code generation
- ✅ Generates React/HTML code from designs
- ✅ Tailwind/CSS class generation
- ✅ Component boilerplate scaffolding

**Use both together** for the complete workflow: generate code with Official MCP, then debug and extract data with Console MCP.

---

## 🛤️ Roadmap

**Current Status:** v1.31.0 (Stable) - Production-ready with a self-healing Desktop Bridge connection (zombie-process reaper + auto-reconnect watchdog — fixes the recurring "not connected until restart" bug), native variable binding on fills/strokes + typography control in the write tools, shared-library inspection (key-based component resolution + library variable read/import without Enterprise plan), 10-format token export pipeline (DTCG, CSS, Tailwind v4, Tailwind v3, SCSS, TS module, JSON flat/nested, Style Dictionary v3, Tokens Studio), bidirectional Figma↔code token sync, version history & time-series awareness, FigJam + Slides support, Cloud Write Relay, Design System Kit, WebSocket-only connectivity, smart multi-file tracking, **106 tools** (Local) / **95 tools** (Cloud) / **9 tools** (Remote read-only), Comments API, cross-MCP identity disambiguation, and MCP Apps.

**Recent Releases:**
- [x] **v1.31.0** - Fixes the most-reported reliability bug: the Desktop Bridge connection dropping and staying down until you closed the plugin, restarted your MCP client, or killed ports by hand. Root cause was **zombie MCP server processes** squatting the WebSocket port range (9223–9232) after a bad shutdown. The reaper now escalates `SIGTERM` → `SIGKILL` (a hung server that ignores graceful shutdown can no longer survive), sweeps the range every 5 minutes via an `unref`'d periodic reaper, and a shutdown backstop prevents a server from zombifying in the first place. The redesigned Desktop Bridge plugin adds an auto-reconnect watchdog (re-probes every ~12s while disconnected), a context-aware **Pause / Resume / Reconnect** button, and a live server-count badge. No new tools; **plugin re-import required** (bridge `ui.html` + `code.js` changed). 1190 tests passing, including an integration test that spawns a real `SIGTERM`-ignoring process and asserts the reaper kills it.
- [x] **v1.30.0** - Native variable binding + typography in the structured write tools, closing the Plugin API gaps that used to force raw `figma_execute`. `figma_set_fills` / `figma_set_strokes` accept a `variableId` to bind a fill/stroke to a color variable via `setBoundVariableForPaint` (any plan, via the bridge). `figma_set_text` gains `fontFamily` / `fontStyle` with space-insensitive normalization (`SemiBold` → `Semi Bold`) and graceful `Regular` fallback. `figma_instantiate_component` pre-loads instance text fonts before applying overrides (fixes silently-skipped text overrides on non-Regular weights) and returns a `warnings` array for failed overrides. Also fixes a mixed-font crash in `figma_set_text` and a `ui.html` relay that was dropping new message fields. No new tools; **plugin re-import required** (bridge `ui.html` + `code.js` changed). Validated live; 1185 tests passing.
- [x] **v1.29.2** - Bug fix: `figma_generate_component_doc` now renders Figma component descriptions faithfully and reliably tags atomic-design level. Single-`#` headings in descriptions render as real sections (Usage Guidelines, Implementation Considerations, Accessibility Requirements, Content Configuration) instead of leaking as `- # Heading` list items; frontmatter `description` takes the first sentence instead of truncating on the word "Accessibility"; the generated Figma URL no longer doubles `?node-id=`; and the component's atomic level (atom/molecule/organism/template) is auto-detected via a single `ids=<node>` file request + divider walk-back, with no dependency on library publishing. No new tools; plugin re-import not required.
- [x] **v1.29.1** - Bug fix: `figma_get_design_system_kit` now resolves variables bridge-first (Desktop Bridge / cloud relay → REST fallback) instead of calling the Enterprise-only Variables REST API directly. Non-Enterprise users no longer hit a 403 on the kit's token section when a bridge is connected, and a REST 403 now points the caller back to the bridge instead of dead-ending. 7 new tests, 1185 total passing. No new tools; plugin re-import not required.
- [x] **v1.29.0** - Shared library inspection: three new tools close the gap between "I have a component key" and "I can actually use it." `figma_get_library_component_by_key` resolves any 40-char component key to full `componentPropertyDefinitions` + variants (with their published keys) + per-variant visual specs — without needing the source library file's URL. `figma_get_library_variables` lists library tokens via Plugin API (works on every Figma plan; the REST equivalent is Enterprise-only). `figma_import_library_variable` imports a library token to the current file so it can be bound to nodes. 27 new tests, 1178 total passing. Plugin re-import optional.
- [x] **v1.28.1** - Bug fix patch surfacing from live-fire testing of the v1.28.0 formatters against multi-tier semantic-token design systems. Fixes: Tailwind v3 emitted empty `module.exports` for alias-only sets (now resolves alias chains to literal values); TypeScript module + JSON flat + JSON nested formatters emitted `"{alias.path}"` strings as literal values (now resolves); Tailwind v4 namespace-prefix doubling (`--color-theme-color-X` is now `--color-theme-X`). Adds `resolveAliasChain` public helper. 1151 tests still passing.
- [x] **v1.28.0** - Full formatter coverage for `figma_export_tokens`. Seven new output formats: Tailwind v4 `@theme inline`, Tailwind v3 config, SCSS variables, TypeScript module, JSON flat/nested, Style Dictionary v3, Tokens Studio multi-file. Combined with DTCG + CSS variables, ships **10 fully-implemented output formats** with zero third-party build-tool dependencies. Tool description updated, docs/tools.md table all-green. 22 new Jest tests, 1151 total passing.
- [x] **v1.27.1** - Documentation patch. No code behavior changes. Sweeps stale "Phase 1 ships with DTCG only" claims across tool descriptions, error messages, and internal comments after CSS variables formatter and the apply phase shipped during the v1.27.0 dev cycle. Refreshes README banner + capability bullets + roadmap. Adds `Phase 3.5: Stale-Content Audit` to the release runbook so future releases get a strict pre-publish grep sweep across banners, tool descriptions, error messages, source comments, and tool-count consistency.
- [x] **v1.27.0** - Bidirectional token sync: `figma_export_tokens` + `figma_import_tokens` replace Style Dictionary and Tokens Studio's export pipeline. Canonical DTCG JSON + CSS custom properties. Diff-aware merge with round-trip ID preservation via `$extensions["figma-console-mcp"]`. Apply phase pushes hex-value edits back to Figma via the plugin bridge. Verified end-to-end against 713-token + 280-token design systems.
- [x] **v1.26.0** - Internal cleanup + cross-MCP identity: Local-mode CDP/Puppeteer transport removed entirely (WebSocket-only). `figma_diagnose` tool for designer-readable health checks. Every response tagged `_mcp: "figma-console-mcp"`; errors prefixed `[figma-console-mcp]` so attribution is unambiguous when running multiple Figma MCPs. Plugin status pill now reads `Local · ready` / `Cloud · ready` / `Local + Cloud · ready`. Net diff: −7,299 lines, plugin re-import optional.
- [x] **v1.25.0** - Description + Dev Mode annotation tracking in `figma_diff_versions` via plugin session buffer. Description and annotation edits made during a session now appear in diff output (REST API doesn't return these — bridged through the plugin's `documentchange` listener).
- [x] **v1.24.0** - Honest scope coverage on version diffs. `scope_coverage` object surfaces what `figma_diff_versions` does and doesn't track; always-on coverage warnings prevent silent invisibility on token-value changes and component-instance placements.
- [x] **v1.23.0** - Version History & Time-Series Awareness: 6 new tools (list versions, snapshot any past version, diff two versions for component/binding deltas, generate markdown changelogs, trace property/variant introduction via binary-search blame walker). Author attribution flows from autosaves, not just labeled releases.
- [x] **v1.17.0** - Figma Slides support: 15 tools for managing presentations.
- [x] **v1.16.0** - FigJam support: 9 tools for creating and reading FigJam boards.
- [x] **v1.12.0** - Cloud Write Relay: web AI clients can create and modify Figma designs without Node.js.
- [x] **v1.11.0** - Complete CDP removal, improved multi-file active tracking with focus detection.
- [x] **v1.10.0** - Multi-instance support (dynamic port fallback 9223–9232, multi-connection plugin, instance discovery).
- [x] **v1.9.0** - Figma Comments tools, improved port conflict detection.
- [x] **v1.8.0** - WebSocket Bridge transport (CDP-free connectivity), real-time selection/document tracking.
- [x] **v1.7.0** - MCP Apps (Token Browser, Design System Dashboard), batch variable operations, design-code parity tools.

**Coming Next:**
- [ ] **Token sync — parsers + import-side apply expansion** - Parsers for non-DTCG input (Tokens Studio, CSS vars, Tailwind v4, Tailwind v3 config, SCSS, Style Dictionary v3, JSON flat/nested). Plus `toCreate` apply orchestration, `toDelete` for `replace` strategy, alias-target updates, and cross-library variable resolution via `getVariableByIdAsync` so cross-library aliases render as real `var(--target)` references instead of comments.
- [ ] **Component template library** - Common UI pattern generation
- [ ] **Visual regression testing** - Screenshot diff capabilities
- [ ] **Design linting** - Automated compliance and accessibility checks

**📖 [Full Roadmap](docs/ROADMAP.md)**

---

## 💻 Development

```bash
git clone https://github.com/southleft/figma-console-mcp.git
cd figma-console-mcp
npm install

# Local mode development
npm run dev:local

# Cloud mode development
npm run dev

# Build
npm run build
```

**📖 [Development Guide](docs/ARCHITECTURE.md)**

---

## 📄 License

MIT - See [LICENSE](LICENSE) file for details.

---

## 🔗 Links

- 📚 **[Documentation Site](https://docs.figma-console-mcp.southleft.com)** — Complete guides, tutorials, and API reference
- 📖 [Local Docs](docs/) — Documentation source files
- 🐛 [Report Issues](https://github.com/southleft/figma-console-mcp/issues)
- 💬 [Discussions](https://github.com/southleft/figma-console-mcp/discussions)
- 🌐 [Model Context Protocol](https://modelcontextprotocol.io/)
- 🎨 [Figma API](https://www.figma.com/developers/api)
