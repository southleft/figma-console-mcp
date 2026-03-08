# figma-cli Claude Code Plugin

A Claude Code plugin that teaches Claude to use the `figma-cli` Rust binary as a token-efficient alternative to MCP tool calls.

## Install

```bash
claude plugin install https://github.com/southleft/figma-console-mcp/tree/main/claude-plugin
```

Or locally after cloning the repo:

```bash
claude plugin install ./claude-plugin
```

## Prerequisites

Build the `figma-cli` binary first:

```bash
cd figma-cli
cargo build --release
cp target/release/figma-cli /usr/local/bin/

# Configure credentials
figma-cli init global --token figd_YOUR_TOKEN
```

Or install via Homebrew (once the tap is published):

```bash
brew tap southleft/figma-cli
brew install figma-cli
```

## What the plugin provides

A single skill — `figma-cli` — that loads automatically when you ask Claude to:

- "use figma-cli to..."
- "script figma operations..."
- "run figma cli command..."
- "compare cli vs mcp..."
- "batch process figma tokens..."

The skill teaches Claude the full command reference, setup steps, and when to prefer CLI over MCP.

## Why CLI over MCP?

See [`../docs/benchmark.md`](../docs/benchmark.md) for full measurements.

Short answer: **60–80% fewer input tokens** per call in scripting/automation contexts, because CLI uses the Bash tool schema (~140 tok) instead of loading a per-tool MCP schema (520–1020 tok) every call.

## Plugin structure

```
claude-plugin/
├── .claude-plugin/
│   └── plugin.json          ← manifest
└── skills/
    └── figma-cli/
        ├── SKILL.md          ← core skill (auto-loaded on trigger)
        └── references/
            └── command-reference.md   ← full flag docs (loaded on demand)
```
