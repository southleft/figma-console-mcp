# MCP vs CLI Benchmark Results

Measured comparison of `figma-console-mcp` MCP tool calls vs `figma-cli` Rust binary for identical Figma API operations.

**Test file:** [`mcp-vs-cli`](https://www.figma.com/design/4NVpfuQaY95l0BUm6UlbI2/mcp-vs-cli)
**File contents:** 2 pages · 15 Button components · 23 local styles · 3 comments · Typography, Spacing, Color Palette frames
**Date:** March 2026
**CLI version:** figma-cli 0.1.0 (debug build)
**MCP version:** figma-console-mcp 1.11.2

---

## How Measurements Were Taken

### Input Tokens (overhead per call)

**MCP:** Each tool call loads its full JSON schema on every invocation. Schema sizes were estimated by measuring the tool description + parameter schema from the MCP server manifest (`npx figma-console-mcp --list-tools`). Range: **520–1020 tokens** depending on tool complexity.

**CLI:** The Bash tool schema is fixed at ~140 tokens. The `figma-cli` skill (`.claude/skills/figma-cli/SKILL.md`) is ~480 tokens and is loaded once per session, amortized across calls. Effective overhead: **~200 tokens/call** after the first.

### Output Tokens (response payload)

Both paths call the same Figma REST API endpoints and return the same underlying data. Differences arise from:
- MCP verbosity controls (`summary`/`standard`/`full`) which compress responses
- MCP wrapper metadata (file key, enrichment flags, AI instruction blobs)
- CLI passes the raw REST response with no transformation

Output tokens were measured as `response_bytes / 4` (rough character-per-token estimate).

---

## Results

### Output Token Comparison (same underlying data)

| Operation | CLI bytes | CLI ~tokens | MCP bytes | MCP ~tokens | Winner | Notes |
|-----------|-----------|-------------|-----------|-------------|--------|-------|
| `file get-data` (depth=1) | 1278 B | ~319 | 283 B | ~71 | **MCP** | MCP `summary` verbosity 4× smaller |
| `file get-data` (depth=2) | 5474 B | ~1368 | 1094 B | ~274 | **MCP** | MCP `standard` verbosity 5× smaller |
| `styles list` | 61 B | ~15 | 54 B | ~13 | tie | Both return 0 (REST: published only) |
| `comments list` | 1605 B | ~401 | 1657 B | ~414 | **CLI** | MCP adds summary wrapper |
| `design-system summary` | 102 B | ~25 | 446 B | ~112 | **MCP** | MCP richer: uses local traversal, found 15 components vs CLI's 0 |
| `file get-kit` / `design-system kit` | 151 B | ~37 | 2170 B | ~543 | **CLI** | MCP appends AI instructions blob (+500 tokens) |
| `variables list` | — | — | — | — | N/A | Both 403: needs `file_variables:read` scope |

### Input Token Overhead (schema loading)

| Tool | CLI input overhead | MCP input overhead | CLI savings |
|------|-------------------|-------------------|-------------|
| `file get-data` | ~200 tok | ~820 tok | **76%** |
| `styles list` | ~200 tok | ~680 tok | **71%** |
| `comments list` | ~200 tok | ~520 tok | **62%** |
| `design-system summary` | ~200 tok | ~620 tok | **68%** |
| `design-system kit` | ~200 tok | ~1020 tok | **80%** |

> Input overhead is **independent of file size** — it is the same for an empty file and a 500-component design system.

### HTTP Response Times (CLI, debug build)

| Operation | Time |
|-----------|------|
| `file get-data --depth 1` | 2299 ms |
| `file get-data --depth 2` | 1158 ms |
| `styles list` | 766 ms |
| `comments list` | 751 ms |
| `design-system summary` | 595 ms |
| `file get-kit` | 738 ms |

> Times include Figma API network latency. Release build (`cargo build --release`) would be marginally faster due to eliminated debug overhead (I/O bound, not CPU bound).

---

## Bugs & Findings Discovered During Testing

### 1. `styles list` / `figma_get_styles` — REST-only limitation

**Both CLI and MCP** return 0 styles for unpublished local styles. The Figma REST endpoint `/files/:key/styles` only returns styles that have been published to a shared library. Styles created via the plugin or locally are invisible to both tools.

The MCP tool description says *"Get all styles (color, text, effects, grids)"* — this is misleading. It should say *"Get published styles"*.

**Workaround:** Use `figma_execute` (MCP Desktop Bridge) to call `figma.getLocalPaintStyles()` / `figma.getLocalTextStyles()`.

### 2. `figma_get_design_system_kit` vs `figma_get_design_system_summary` — internal inconsistency

`figma_get_design_system_summary` returned **15 components** (found via local file traversal).
`figma_get_design_system_kit` returned **0 components** (uses REST `/files/:key/components` — published only).

These two tools use different data sources for the same concept, with no indication of this difference in their descriptions. The kit is the "preferred" tool but delivers less data for unpublished components.

### 3. `variables list` / `design-system tokens` — scope 403

Both CLI and MCP fail with `403 Forbidden` when querying variables. The Figma REST variables API requires the `file_variables:read` scope, which is only available on **Figma Enterprise plan** tokens. Standard `figd_*` personal access tokens do not include this scope.

### 4. `components search` — returns empty for local components

CLI and MCP both return `[]` for components not published to the Figma component library. The REST endpoint `/files/:key/components` only surfaces published components. This is expected behaviour — not a bug — but worth noting for users expecting to search locally-defined components.

---

## Summary

| Metric | figma-cli | figma-console-mcp |
|--------|-----------|-------------------|
| Avg input overhead/call | ~200 tokens | ~700 tokens |
| Output verbosity control | ✗ raw REST | ✓ summary/standard/full |
| Local styles/components | ✗ (REST only) | ✓ via Desktop Bridge |
| Scriptable / pipeable | ✓ | ✗ |
| Setup | `cargo build` + `init` | zero (MCP protocol) |
| Desktop Bridge ops | stubs only | full |

**CLI wins** for repeated read-only operations in automation contexts (60–80% input token savings).
**MCP wins** for interactive sessions, verbosity-controlled reads, and any Desktop Bridge operations.

---

## Reproducing the Benchmark

```bash
# 1. Install and configure CLI
cd figma-cli
cargo build
./target/debug/figma-cli init global --token <YOUR_TOKEN> \
  --file-url https://www.figma.com/design/4NVpfuQaY95l0BUm6UlbI2/mcp-vs-cli

# 2. Run timed measurements
time ./target/debug/figma-cli --verbose file get-data --depth 1 --output json --quiet
time ./target/debug/figma-cli --verbose comments list --output json --quiet
time ./target/debug/figma-cli --verbose styles list --output json --quiet

# 3. Compare MCP token usage
# In Claude Code with figma-console-mcp connected, run equivalent MCP tool calls
# and check usage_metadata in the API response (input_tokens + output_tokens per call)
```
