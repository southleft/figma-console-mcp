---
name: figma-cli
description: This skill should be used when the user asks to "use figma-cli", "use cli instead of mcp", "run figma cli command", "script figma operations", "compare cli vs mcp", "batch process figma tokens", mentions "figma-cli", "rust cli figma", or wants to use the Rust binary alternative to the figma-console-mcp MCP server. Provides setup, command reference, and workflow guidance for the figma-cli Rust binary.
version: 0.1.0
---

# figma-cli Skill

The `figma-cli` is a Rust CLI binary located at `figma-cli/` in this project. It wraps the same Figma REST API operations available via the figma-console-mcp MCP server as shell commands. Use it for scripting, CI/CD automation, batch processing, and performance comparison with MCP tools.

## Setup

Build and configure the CLI before use:

```bash
cd figma-cli
cargo build --release
# Binary at: figma-cli/target/release/figma-cli

# Configure credentials
export FIGMA_ACCESS_TOKEN=your_token_here
export FIGMA_FILE_URL=https://www.figma.com/design/FILE_KEY/filename

# Or use .env file (copy from .env.example)
cp .env.example .env && vim .env
```

## Global Flags

Every command accepts these flags:

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `--token <TOKEN>` | `FIGMA_ACCESS_TOKEN` | - | Figma API token |
| `--file-url <URL>` | `FIGMA_FILE_URL` | - | Target file URL or key |
| `--output <FORMAT>` | - | `pretty` | Output: `json`, `table`, `pretty` |
| `--quiet` | - | false | Suppress formatting |
| `--verbose` | - | false | Show timing info |

## Quick Command Reference

### File Operations
```bash
figma-cli file get-data [--depth 1] [--verbosity summary|standard|full]
figma-cli file get-styles [--verbosity standard]
figma-cli file get-kit [--include tokens,components,styles]
figma-cli file for-plugin [--depth 2]
```

### Variable Operations
```bash
figma-cli variables list [--format full] [--collection NAME] [--mode light]
figma-cli variables create --name "color/primary" --collection-id ID --type COLOR
figma-cli variables update --id VariableID:123:456 --mode-id 1:0 --value "#FF0000"
figma-cli variables delete --id VariableID:123:456
figma-cli variables rename --id VariableID:123:456 --name "color/brand"
figma-cli variables batch-create --collection-id ID --file tokens.json
figma-cli variables batch-update --file updates.json
figma-cli variables setup-tokens --collection Primitives --modes light,dark --file tokens.json
```

### Component Operations
```bash
figma-cli components search [--query "button"] [--limit 10]
figma-cli components get --node-id "1:234"
figma-cli components get-image --node-id "1:234" [--scale 2] [--format png]
figma-cli components for-dev --node-id "1:234"
figma-cli components details [--key COMPONENT_KEY] [--name "Button"]
figma-cli components generate-doc --node-id "1:234" [--output-path docs/button.md]
```

### Comment Operations
```bash
figma-cli comments list [--include-resolved]
figma-cli comments post --message "Review needed" [--node-id "1:234"]
figma-cli comments delete --id COMMENT_ID
```

### Styles
```bash
figma-cli styles list [--verbosity standard|full]
```

### Design System
```bash
figma-cli design-system summary
figma-cli design-system tokens [--filter color] [--type colors|spacing|all]
figma-cli design-system audit
```

### Desktop Bridge (requires Figma plugin)

The CLI runs a WebSocket daemon (`desktop serve`) that the Figma Desktop Bridge plugin
connects to automatically. Once the daemon is set up as a system service (see below),
**the user only needs to open the plugin in Figma** — no terminal required.

When connected, the plugin shows an **orange "CLI Ready"** badge alongside the blue
"MCP Ready" badge (if figma-console-mcp is also running).

#### One-time daemon setup (macOS)

Install `figma-cli desktop serve` as a LaunchAgent so it starts on login:

```bash
# 1. Get the absolute path to the binary
BINARY=$(which figma-cli || echo "/usr/local/bin/figma-cli")

# 2. Create the LaunchAgent plist
cat > ~/Library/LaunchAgents/com.figma-cli.bridge.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.figma-cli.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BINARY}</string>
    <string>desktop</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/figma-cli-bridge.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/figma-cli-bridge.log</string>
</dict>
</plist>
EOF

# 3. Load it (starts immediately, survives reboots)
launchctl load ~/Library/LaunchAgents/com.figma-cli.bridge.plist
```

Verify it's running:
```bash
launchctl list | grep figma-cli      # should show the service
figma-cli desktop status             # should return { "connected": false } until plugin opens
```

To uninstall:
```bash
launchctl unload ~/Library/LaunchAgents/com.figma-cli.bridge.plist
rm ~/Library/LaunchAgents/com.figma-cli.bridge.plist
```

#### One-time daemon setup (Linux / systemd)

```bash
BINARY=$(which figma-cli)
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/figma-cli-bridge.service << EOF
[Unit]
Description=figma-cli Desktop Bridge daemon
After=network.target

[Service]
ExecStart=${BINARY} desktop serve
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user enable --now figma-cli-bridge
systemctl --user status figma-cli-bridge
```

#### Desktop Bridge commands

```bash
figma-cli desktop status          # check plugin connection
figma-cli desktop selection       # get canvas selection
figma-cli desktop files           # list open files/pages
figma-cli desktop screenshot [--output out.png] [--scale 2]

# execute run: code is wrapped in async function, always use return
figma-cli execute run --code "return figma.currentPage.name"
figma-cli execute run --code "return figma.currentPage.selection.length"
figma-cli execute run --code "return figma.root.children.map(p => p.name)"

# Node mutations (all use Desktop Bridge)
figma-cli nodes resize --node-id "1:234" --width 200 --height 100
figma-cli nodes move --node-id "1:234" --x 50 --y 100
figma-cli nodes rename --node-id "1:234" --new-name "Button/Primary"
figma-cli nodes delete --node-id "1:234"
figma-cli nodes clone --node-id "1:234"
figma-cli nodes set-text --node-id "1:234" --text "Hello"
figma-cli nodes set-fills --node-id "1:234" \
  --fills-json '[{"type":"SOLID","color":{"r":1,"g":0,"b":0},"opacity":1}]'
figma-cli nodes create-child --parent-id "0:1" --node-type FRAME

# REST-based node query (no daemon needed)
figma-cli nodes get --file $FIGMA_FILE_URL --ids "1:234,1:235"
```

## Common Patterns

```bash
# Export variables as JSON for processing
figma-cli variables list --output json > variables.json

# Search components and pipe to jq
figma-cli components search --query "button" --output json | jq '.[] | .name'

# Get full file structure for analysis
figma-cli file get-data --depth 2 --verbosity full --output json > file.json

# Time a request (verbose mode)
figma-cli file get-data --verbose

# Batch create tokens from JSON file
figma-cli variables setup-tokens \
  --collection "Primitives" \
  --modes light,dark \
  --file design-tokens.json
```

## MCP vs CLI Comparison

| Aspect | figma-cli | figma-console MCP |
|--------|-----------|-------------------|
| Token overhead | Low (~300-800 tokens/call) | Higher (~1500-4000 tokens/call) |
| Desktop Bridge support | Full (serve daemon) | Full |
| Scriptable | Yes | No |
| Batch via shell | Yes | No |
| Response inspection | Easy (pipe/redirect) | In-context only |
| Timing measurement | `--verbose` flag | External tools needed |

## Additional Resources

- **`references/command-reference.md`** — Full command flag reference for all subcommands
- **`figma-cli/README.md`** — Project README with setup details
- **`figma-cli/.env.example`** — Environment variable template
