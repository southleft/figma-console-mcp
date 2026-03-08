# figma-cli

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A command-line interface for the Figma REST API — the CLI analog of the [figma-console-mcp](https://github.com/figma-console-mcp) MCP server.

Inspect files, manage design tokens, search components, read comments, and export assets — all from your terminal.

## Installation

### From source

```bash
git clone https://github.com/figma-console-mcp/figma-cli
cd figma-cli
cargo install --path .
```

### Build locally

```bash
cargo build --release
# Binary: ./target/release/figma
```

> [!IMPORTANT]
> Requires Rust 1.70 or later. Install via [rustup](https://rustup.rs).

## Setup

Create a `.env` file in your working directory (copy from `.env.example`):

```bash
cp .env.example .env
```

```ini
FIGMA_ACCESS_TOKEN=your_token_here
FIGMA_FILE_URL=https://www.figma.com/design/YOUR_FILE_KEY/filename
FIGMA_WS_PORT=9000
```

Generate a Figma personal access token at https://www.figma.com/settings.

## Usage

```bash
figma [OPTIONS] <COMMAND>
```

### Global options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--token` | | Figma access token | `$FIGMA_ACCESS_TOKEN` |
| `--output` | | Output format: `pretty`, `json`, `table` | `pretty` |
| `--quiet` | `-q` | Emit raw JSON only | false |
| `--verbose` | `-v` | Print request timing | false |

### Commands

| Command | Description |
|---------|-------------|
| `file` | Inspect file structure, styles, and metadata |
| `variables` | List and manage design tokens (Enterprise plan) |
| `components` | Search and inspect components |
| `comments` | Read and write file comments |
| `nodes` | Fetch or export specific nodes |
| `styles` | List published styles |
| `design-system` | Design system summary and audit |
| `execute` | Run plugin JavaScript (Desktop Bridge) |
| `desktop` | Desktop Bridge operations |

## Examples

### Inspect a file

```bash
# Get file structure (depth 2)
figma file get-data --file https://www.figma.com/design/KEY/name --depth 2

# List all styles
figma file get-styles --file $FIGMA_FILE_URL

# Export as plugin-compatible format
figma file for-plugin --file $FIGMA_FILE_URL
```

### Design tokens (variables)

```bash
# List all variables
figma variables list --file $FIGMA_FILE_URL

# Create a variable
figma variables create \
  --file $FIGMA_FILE_URL \
  --collection-id "VariableCollectionId:1:1" \
  --name "color/primary" \
  --variable-type COLOR

# Update a value
figma variables update \
  --file $FIGMA_FILE_URL \
  --variable-id "VariableID:1:2" \
  --mode-id "1:0" \
  --value '{"r":0.2,"g":0.4,"b":1.0,"a":1.0}'

# Batch create from JSON
figma variables batch-create \
  --file $FIGMA_FILE_URL \
  --json-file ./tokens.json
```

### Components

```bash
# Search by name
figma components search --file $FIGMA_FILE_URL --query "Button"

# Get a specific component
figma components get --key abc123def456

# Export as PNG at 2x
figma components get-image \
  --file $FIGMA_FILE_URL \
  --node-id "123:456" \
  --scale 2.0 \
  --format png
```

### Comments

```bash
# List comments
figma comments list --file $FIGMA_FILE_URL

# Post a comment anchored to a node
figma comments post \
  --file $FIGMA_FILE_URL \
  --message "Please update this color" \
  --node-id "123:456"

# Delete a comment
figma comments delete --file $FIGMA_FILE_URL --comment-id "12345"
```

### Design system audit

```bash
# High-level summary: component count, style count, variable count
figma design-system summary --file $FIGMA_FILE_URL

# Find components and styles missing descriptions
figma design-system audit --file $FIGMA_FILE_URL

# List tokens filtered by collection
figma design-system tokens --file $FIGMA_FILE_URL --collection "Brand"
```

### Node export

```bash
# Fetch specific nodes
figma nodes get --file $FIGMA_FILE_URL --ids "0:1,0:2,0:3"

# Export nodes as SVG
figma nodes export \
  --file $FIGMA_FILE_URL \
  --ids "123:456" \
  --format svg
```

### Output formats

```bash
# Pretty-printed colored JSON (default)
figma variables list --file $FIGMA_FILE_URL

# Raw JSON for piping
figma variables list --file $FIGMA_FILE_URL --output json | jq '.meta.variables'

# Table view
figma components search --file $FIGMA_FILE_URL --query "" --output table

# Quiet mode (same as --output json, no decorations)
figma comments list --file $FIGMA_FILE_URL -q
```

## Desktop Bridge

Some operations require the **Figma Desktop Bridge** plugin running inside the Figma desktop app. These include:

- Programmatic node creation and mutation
- Component instantiation and property management
- Plugin execution (`execute run`)
- Canvas screenshots and navigation

> [!NOTE]
> Commands that require the Desktop Bridge will print a clear message explaining how to connect rather than failing silently.

Commands in the `desktop` and `execute` groups all require the bridge:

```bash
figma desktop status --port 9000
figma execute run --code "figma.currentPage.children.length" --port 9000
```

## Project Structure

```
src/
  main.rs              Entry point
  cli.rs               Clap arg definitions
  api/
    client.rs          FigmaApiClient (HTTP transport)
    figma.rs           FigmaApi (domain methods)
    desktop.rs         DesktopBridgeClient (WebSocket stub)
  commands/
    file.rs            file subcommands
    variables.rs       variables subcommands
    components.rs      components subcommands
    comments.rs        comments subcommands
    nodes.rs           nodes subcommands
    styles.rs          styles subcommands
    design_system.rs   design-system subcommands
    desktop.rs         desktop subcommands (stubs)
    execute.rs         execute subcommands (stubs)
  output.rs            Formatting: pretty/json/table
```

## License

MIT
