# figma-cli Full Command Reference

## file subcommands

### file get-data
Fetch the full Figma file document tree (analog of `figma_get_file_data`).

```
figma-cli file get-data [OPTIONS]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--file-url <URL>` | env `FIGMA_FILE_URL` | Figma file URL or key |
| `--depth <N>` | 1 | Tree depth (0-3) |
| `--verbosity <V>` | summary | summary / standard / full |
| `--node-ids <IDs>` | - | Comma-separated node IDs to fetch |

### file get-styles
Fetch all styles from file (analog of `figma_get_styles`).

```
figma-cli file get-styles [OPTIONS]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--verbosity <V>` | standard | summary / standard / full |

### file get-kit
Single call for tokens + components + styles (analog of `figma_get_design_system_kit`).

```
figma-cli file get-kit [OPTIONS]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--include <LIST>` | tokens,components,styles | Comma-separated subset |
| `--component-ids <IDs>` | - | Filter to specific components |
| `--format <F>` | full | full / summary / compact |

### file for-plugin
File data optimized for plugin development (analog of `figma_get_file_for_plugin`).

```
figma-cli file for-plugin [OPTIONS]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--depth <N>` | 2 | Tree depth (0-5) |
| `--node-ids <IDs>` | - | Specific node IDs |

---

## variables subcommands

### variables list
List all design variables/tokens (analog of `figma_get_variables`).

```
figma-cli variables list [OPTIONS]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--format <F>` | full | summary / filtered / full |
| `--collection <NAME>` | - | Filter by collection |
| `--mode <NAME>` | - | Filter by mode |
| `--name-pattern <REGEX>` | - | Filter by name regex |

### variables create
Create a single variable (analog of `figma_create_variable`). Requires Desktop Bridge.

```
figma-cli variables create --name <NAME> --collection-id <ID> --type <TYPE>
```

| Flag | Required | Description |
|------|----------|-------------|
| `--name <NAME>` | Yes | Variable name (/ for grouping) |
| `--collection-id <ID>` | Yes | Collection ID |
| `--type <TYPE>` | Yes | COLOR / FLOAT / STRING / BOOLEAN |
| `--description <DESC>` | No | Description text |

### variables update
Update a variable value (analog of `figma_update_variable`). Requires Desktop Bridge.

```
figma-cli variables update --id <VAR_ID> --mode-id <MODE_ID> --value <VALUE>
```

### variables batch-create
Create multiple variables from JSON file (analog of `figma_batch_create_variables`). Requires Desktop Bridge.

```
figma-cli variables batch-create --collection-id <ID> --file <PATH>
```

JSON file format:
```json
[
  {"name": "color/primary", "resolvedType": "COLOR", "valuesByMode": {"1:0": "#FF0000"}},
  {"name": "spacing/sm", "resolvedType": "FLOAT", "valuesByMode": {"1:0": 8}}
]
```

### variables setup-tokens
Create complete token structure atomically (analog of `figma_setup_design_tokens`). Requires Desktop Bridge.

```
figma-cli variables setup-tokens \
  --collection <NAME> \
  --modes <light,dark> \
  --file <tokens.json>
```

tokens.json format:
```json
[
  {
    "name": "color/primary",
    "resolvedType": "COLOR",
    "values": {"light": "#0070F3", "dark": "#60A5FA"}
  }
]
```

---

## components subcommands

### components search
Search components by name/description (analog of `figma_search_components`).

```
figma-cli components search [OPTIONS]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--query <Q>` | "" | Search text |
| `--category <C>` | - | Filter by category |
| `--limit <N>` | 10 | Max results (max 25) |
| `--offset <N>` | 0 | Pagination offset |

### components get
Get component metadata or reconstruction spec (analog of `figma_get_component`).

```
figma-cli components get --node-id <ID> [OPTIONS]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--node-id <ID>` | - | Component node ID (required) |
| `--format <F>` | metadata | metadata / reconstruction |

### components get-image
Render component as image (analog of `figma_get_component_image`).

```
figma-cli components get-image --node-id <ID> [OPTIONS]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--node-id <ID>` | - | Node ID (required) |
| `--scale <N>` | 2 | Scale factor (0.01-4) |
| `--format <F>` | png | png / jpg / svg / pdf |

### components for-dev
Get component with layout/typography for UI implementation (analog of `figma_get_component_for_development`).

```
figma-cli components for-dev --node-id <ID>
```

### components details
Get full component details with all variants (analog of `figma_get_component_details`).

```
figma-cli components details [--key <KEY>] [--name <NAME>]
```

### components generate-doc
Generate markdown documentation for component (analog of `figma_generate_component_doc`).

```
figma-cli components generate-doc --node-id <ID> [OPTIONS]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--output-path <PATH>` | - | Save to file |
| `--system-name <NAME>` | - | Design system name |

---

## comments subcommands

### comments list
Get all comment threads (analog of `figma_get_comments`).

```
figma-cli comments list [--include-resolved] [--as-md]
```

### comments post
Post a comment (analog of `figma_post_comment`).

```
figma-cli comments post --message <MSG> [OPTIONS]
```

| Flag | Description |
|------|-------------|
| `--message <MSG>` | Comment text (required) |
| `--node-id <ID>` | Pin to node |
| `--x <N>` | Canvas X coordinate |
| `--y <N>` | Canvas Y coordinate |
| `--reply-to <ID>` | Reply to comment ID |

### comments delete
Delete a comment (analog of `figma_delete_comment`).

```
figma-cli comments delete --id <COMMENT_ID>
```

---

## styles subcommands

### styles list
List all styles (analog of `figma_get_styles`).

```
figma-cli styles list [--verbosity standard]
```

---

## design-system subcommands

### design-system summary
Compact overview of design system (analog of `figma_get_design_system_summary`).

```
figma-cli design-system summary [--force-refresh]
```

### design-system tokens
Get resolved token values (analog of `figma_get_token_values`).

```
figma-cli design-system tokens [OPTIONS]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--filter <PATTERN>` | - | Filter token names |
| `--type <T>` | all | colors / spacing / all |
| `--limit <N>` | 50 | Max results |

---

## desktop subcommands

All desktop commands require the Figma Desktop Bridge plugin running.

```
figma-cli desktop status          # Check connection
figma-cli desktop logs            # Get console logs
figma-cli desktop screenshot      # Capture screenshot
figma-cli desktop navigate --url  # Navigate to URL
figma-cli desktop reload          # Reload plugin
figma-cli desktop clear-console   # Clear console
figma-cli desktop reconnect       # Force reconnect
figma-cli desktop selection       # Get selected nodes
figma-cli desktop changes         # Get recent changes
figma-cli desktop files           # List open files
```

---

## execute subcommands

### execute run
Execute JavaScript in plugin context (analog of `figma_execute`). Requires Desktop Bridge.

```
figma-cli execute run --code <JS> [--timeout 5000]
```

Examples:
```bash
figma-cli execute run --code "figma.currentPage.name"
figma-cli execute run --code "figma.root.children.map(p => p.name)"
figma-cli execute run --code "$(cat script.js)"
```

---

## nodes subcommands

Most node commands require Desktop Bridge for mutations.

```
figma-cli nodes get --node-id <ID>           # Get node info (REST API)
figma-cli nodes resize --node-id <ID> --width 200 --height 100
figma-cli nodes move --node-id <ID> --x 100 --y 200
figma-cli nodes set-fills --node-id <ID> --fills '[{"color":"#FF0000"}]'
figma-cli nodes set-strokes --node-id <ID> --strokes '[{"color":"#000"}]'
figma-cli nodes clone --node-id <ID>
figma-cli nodes delete --node-id <ID>
figma-cli nodes rename --node-id <ID> --name "New Name"
figma-cli nodes set-text --node-id <ID> --text "Hello"
figma-cli nodes create-child --parent-id <ID> --type RECTANGLE
```
