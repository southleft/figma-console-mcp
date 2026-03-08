# figma-cli Claude Code Plugin

The `figma-cli` plugin provides Claude Code with a skill that teaches it how to use the `figma-cli` Rust binary as a token-efficient alternative to direct MCP tool calls.

---

## Installing from Claude Code Plugin Marketplace

```bash
# Install the plugin
claude plugin install figma-console-mcp

# Or install from local directory (development)
claude plugin install ./path/to/figma-console-mcp --plugin-dir claude-plugin
```

Once installed, Claude automatically loads the `figma-cli` skill whenever you ask it to:
- "use figma-cli to..."
- "run figma cli command..."
- "script figma operations..."
- "compare cli vs mcp..."
- "batch process figma tokens..."

---

## Plugin Structure

```
claude-plugin/
├── .claude-plugin/
│   └── plugin.json                      ← manifest (MUST be here)
├── skills/
│   └── figma-cli/
│       ├── SKILL.md                     ← skill (auto-discovered)
│       └── references/
│           └── command-reference.md     ← full flag reference (loaded on demand)
└── README.md
```

### `.claude-plugin/plugin.json`

The manifest lives in `.claude-plugin/` — not at the plugin root. Skills are auto-discovered from the `skills/` directory; no explicit registration needed.

```json
{
  "name": "figma-cli",
  "version": "0.1.0",
  "description": "Rust CLI analog of figma-console-mcp.",
  "author": { "name": "southleft" },
  "license": "MIT",
  "repository": "https://github.com/southleft/figma-console-mcp",
  "keywords": ["figma", "cli", "rust", "automation"]
}
```

---

## Using the Skill

After installing the plugin and building the CLI binary, Claude will use `figma-cli` commands via the `Bash` tool instead of MCP tool calls.

### Example session

**You:** Use figma-cli to get the file structure

**Claude** *(with skill loaded)*:
```bash
figma-cli file get-data --depth 2 --output json
```

**You:** List all comments and post a reply to the first one

**Claude:**
```bash
# List comments
figma-cli comments list --output json

# Post reply (using comment ID from above)
figma-cli comments post --message "Acknowledged" --reply-to 1664124541
```

---

## Why Use the Plugin vs Direct MCP?

See [docs/benchmark.md](./benchmark.md) for full measurements. Summary:

| | figma-cli (Bash) | figma-console-mcp (MCP) |
|--|-----------------|------------------------|
| **Input tokens/call** | ~200 (skill + bash) | ~520–1020 (tool schema) |
| **Scriptable** | ✓ pipe, redirect, loop | ✗ |
| **Desktop Bridge ops** | full (serve daemon) | full support |
| **Verbosity control** | ✗ raw REST | ✓ summary/standard/full |

The plugin pays off in sessions with **3+ repeated operations** on the same file — the skill (~480 tokens) is loaded once and amortized.

---

## Building the CLI

The plugin requires the `figma-cli` binary to be built locally:

```bash
# Prerequisites: Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Build
cd figma-cli
cargo build --release

# Add to PATH (optional)
cp target/release/figma-cli /usr/local/bin/

# Or install via Homebrew (once published)
brew tap southleft/figma-cli
brew install figma-cli
```

### Configure credentials

```bash
# Global (all projects)
figma-cli init global --token figd_YOUR_TOKEN_HERE

# Local (current directory only, overrides global)
figma-cli init local --token figd_YOUR_TOKEN_HERE --file-url https://www.figma.com/design/FILE_KEY/name
```

---

## Submitting to the Claude Code Plugin Marketplace

To list this plugin in the official marketplace:

1. Ensure `plugin.json` has complete metadata (`name`, `version`, `description`, `author`, `license`, `repository`)
2. All skills have clear `description` fields with specific trigger phrases
3. Test with `claude --plugin-dir claude-plugin`
4. Submit at: https://github.com/anthropics/claude-code-plugins (link TBD — marketplace is in beta)

### Verification checklist

- [ ] `plugin.json` valid JSON with required fields
- [ ] `SKILL.md` has YAML frontmatter with `name` and `description`
- [ ] Skill description uses third-person with specific trigger phrases
- [ ] `SKILL.md` body is ≤3000 words (progressive disclosure)
- [ ] References files are linked from `SKILL.md`
- [ ] Binary builds cleanly with `cargo build --locked`
- [ ] `figma-cli --help` works after `init`
