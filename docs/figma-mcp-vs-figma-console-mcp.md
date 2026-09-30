---
title: "Figma MCP vs. Figma Console MCP"
sidebarTitle: "Figma MCP vs. Console MCP"
description: "How Figma's official MCP server and Figma Console MCP differ, where they overlap, and how to use them together."
---

Figma's official MCP server and Figma Console MCP both connect AI assistants to Figma, and both can read from and write to Figma files. They were built for different jobs, and many teams run both in the same MCP client.

- **The official Figma MCP server** is Figma's hosted server. It focuses on design-to-code context, Code Connect, and creating content in Figma: design files, FigJam diagrams, motion, and shaders.
- **Figma Console MCP** is an open-source server focused on design-system operations: deterministic audits and design-code parity checks, token sync with round-trip IDs, component documentation, version-history diffs, extracting a design system from a codebase, and plugin console debugging.

This page reflects both servers as of September 2026. Figma's server changes often, so check [Figma's documentation](https://developers.figma.com/docs/figma-mcp-server/) for its current capabilities.

---

## At a Glance

<Columns cols={2}>
  <Card title="Figma MCP (Official)" icon="figma">
    **Made by Figma.** A hosted server you sign in to with OAuth. It provides design context for code generation, Code Connect mappings, library search, and writes to Figma through `use_figma`, which runs Plugin API JavaScript. It can also create files, generate FigJam diagrams, and work with motion, shaders, and generative plugins.

    Tool surface: about 40 as of September 2026, including Weave tools for running AI models and tools.
  </Card>
  <Card title="Figma Console MCP" icon="terminal">
    **Made by Southleft.** A design-system-focused server that runs on your machine (or in Cloud Mode) and talks to Figma through the Desktop Bridge plugin and the REST API. Most operations are dedicated, schema-validated tools rather than generated scripts, and it also runs arbitrary Plugin API code through `figma_execute`.

    121 tools. Plugin API + REST API. Open source (MIT).
  </Card>
</Columns>

---

## Shared Ground

Both servers can do the following. How they do it differs: the official server usually does it through a general tool such as `use_figma` plus a skill, and Console MCP usually has a dedicated tool for it.

| Capability | Figma MCP | Console MCP |
|---|---|---|
| Read file structure, components, and styles | `get_metadata`, `get_design_context` | `figma_get_file_data`, `figma_get_component`, `figma_get_styles`, and others |
| Screenshots | `get_screenshot` | `figma_take_screenshot`, `figma_capture_screenshot` |
| Read variables | `get_variable_defs` | `figma_get_variables`, `figma_get_token_values` |
| Search design-system assets | `search_design_system`, `get_libraries` | `figma_search_components`, library component and variable tools |
| Run Plugin API JavaScript (writes to Figma) | `use_figma` | `figma_execute` |
| Read FigJam boards | `get_figjam` | `figjam_get_board_contents`, `figjam_get_connections` |
| Skills (markdown workflow guides for agents) | Yes (`get_figma_skill`, plus skills in Figma's plugin) | Yes |

---

## What the Official Figma MCP Is Built For

These are areas where the official server has first-party capabilities that Console MCP does not provide:

| Capability | Official tools |
|---|---|
| Design context for code generation | `get_design_context`, `get_metadata`, `get_screenshot` |
| Code Connect: map Figma components to code components | `get_code_connect_map`, `add_code_connect_map`, `get_code_connect_suggestions`, `send_code_connect_mappings`, and related tools |
| Create new Figma, FigJam, and Slides files | `create_new_file` |
| Generate FigJam diagrams from Mermaid | `generate_diagram` |
| Motion context and video export | `get_motion_context`, `export_video` |
| Create and edit shaders | `create_shader`, `update_shader`, `get_shader`, `list_shaders`, `list_file_shaders` |
| Generative plugins | `create_generative_plugin`, `update_generative_plugin`, and related tools |
| Upload and download assets | `upload_assets`, `download_assets` |
| Hosted by Figma, OAuth sign-in, no local install | — |

<Note>
Code Connect is the main reason to reach for the official server when generating code. It tells the AI which code component corresponds to each Figma component, so generated code uses your real components instead of recreating them.
</Note>

---

## What Figma Console MCP Is Built For

Console MCP concentrates on operating a design system across Figma and code. Each of these has dedicated tools:

### Deterministic checks

Rule-based checks that return the same result for the same input, so they can gate a merge or a release:

- **Accessibility**: `figma_lint_design` (WCAG checks on the canvas), `figma_audit_component_accessibility` (state, focus, and color-blind scorecard for a component), and `figma_scan_code_accessibility` (axe-core scan of HTML, Local Mode).
- **Design-code parity**: `figma_check_design_parity` compares a Figma component with its code implementation and reports each discrepancy.
- **Design-system health**: `figma_audit_design_system_report` scores naming, token architecture, component metadata, accessibility, consistency, and coverage, and says which findings the MCP can fix.
- **Extracted-system fidelity**: `figma_ds_verify` checks that tokens extracted from a codebase parse, resolve, and are ready to import into Figma.

### Bidirectional token sync

- `figma_export_tokens` writes Figma variables to 10 formats: DTCG JSON (legacy or 2025.10 dialect), CSS custom properties, Tailwind v4 and v3, SCSS, TypeScript, flat and nested JSON, Style Dictionary v3, and Tokens Studio.
- `figma_import_tokens` applies DTCG JSON back to Figma: value updates, new collections and variables, renames matched by the Figma variable ID stored in `$extensions`, alias writes, and deletes only under `strategy: "replace"`.
- Export refuses to overwrite a token file generated from a different Figma file, or one that would lose tokens the export doesn't manage.

### Variables on any Figma plan

Figma's Variables REST API requires an Enterprise plan. Console MCP reads and writes variables through the Plugin API in the Desktop Bridge plugin, so variable tools work on every plan, including batch creates and updates of up to 100 variables per call.

### Component documentation and history

- `figma_generate_component_doc` produces markdown documentation from Figma and your code: anatomy, per-variant color, spacing, and typography tokens, annotations, a design-code parity section, and (with the `history` option) a changelog built from Figma version history and `git log`.
- Version-history tools (`figma_get_file_versions`, `figma_diff_versions`, `figma_generate_changelog`, `figma_blame_node`) diff snapshots and find when, and by whom, a property or variant was introduced.

### Codebase → design system → Figma

Seven `figma_ds_*` tools (Local Mode) analyze a production codebase, extract its styling as DTCG tokens with per-token provenance, scaffold a design-system package with Storybook, and verify it. The extracted tokens import into Figma variables with `figma_import_tokens`.

### Plugin debugging and live file awareness (Local Mode)

Console log capture from the Desktop Bridge plugin (`figma_get_console_logs`, `figma_watch_console`), the current selection (`figma_get_selection`), buffered document changes (`figma_get_design_changes`), multi-file targeting and `figma_execute_across_files`, and a plain-language health check (`figma_diagnose`).

### Other dedicated tools

Structured tools for variables, components and component sets (`figma_create_component_set`), Slots, node editing, annotations, comments, FigJam, and Slides. See the [Tools Reference](/tools).

---

## Structured Tools and Scripted Writes

Both servers can change a Figma file by running Plugin API code: `use_figma` on the official server, `figma_execute` in Console MCP. Console MCP also provides dedicated tools for common operations. For example, `figma_batch_create_variables` takes a JSON array of variables, and `figma_create_component_set` builds a variant set from an axes matrix. Their inputs are schema-validated and their errors name the problem.

Neither approach is universally better. A script is flexible and handles one-off changes. A dedicated tool is predictable and easier to review, which matters most for repeated design-system operations such as syncing hundreds of tokens across modes.

---

## How They Connect to Figma

| | Figma MCP | Console MCP |
|---|---|---|
| **Runs where** | Hosted by Figma | Your machine (`npx` or a git clone), Southleft's hosted Cloud Mode, or your own Cloudflare deployment |
| **Connection to Figma** | Figma's service | Desktop Bridge plugin over WebSocket, plus the Figma REST API |
| **Authentication** | OAuth | Personal access token; OAuth for the hosted remote endpoints |
| **Web AI clients** | Any client that supports remote MCP servers | Cloud Mode: Yes (96 tools) after pairing the Desktop Bridge plugin |
| **Source code** | Operated by Figma | Open source (MIT), self-hostable |

For Figma's current plan requirements and usage limits, see [Figma's documentation](https://developers.figma.com/docs/figma-mcp-server/). Figma Console MCP is free. It calls the Figma REST API with your own token, so Figma's REST API rate limits apply.

---

## Who Should Use Which

<Tabs>
  <Tab title="Product Engineers">
    **The official Figma MCP** fits when:
    - You want design context for implementing a screen or component
    - You use Code Connect to map Figma components to your codebase
    - You want a hosted server with no local install

    **Figma Console MCP** fits when:
    - You need to check whether coded components match their Figma specs
    - You want design tokens exported to your stack's format, or code-side token edits pushed back to Figma
    - You want generated component documentation with token mappings and a design and code changelog
    - You want to self-host or read the source
  </Tab>
  <Tab title="Designers and Design System Teams">
    **The official Figma MCP** fits when:
    - You want an agent to create designs, files, or FigJam diagrams
    - You work with motion or shaders

    **Figma Console MCP** fits when:
    - You maintain token collections with many modes and want batch, schema-validated variable operations
    - You want repeatable accessibility and design-system health audits
    - You want to audit design-code drift
    - You want version-history diffs, changelogs, or blame for components
    - You want to read or write annotations, or post review comments on components
  </Tab>
  <Tab title="Using Both">
    Both servers can be configured in the same MCP client. One workflow:

    1. **Set up the system** with Console MCP: token collections and modes, component sets with variable bindings, and a health audit.
    2. **Generate code** with the official server's `get_design_context` and Code Connect.
    3. **Check the result** with Console MCP's parity and accessibility tools, then fix discrepancies with either server.
    4. **Document** components with `figma_generate_component_doc`.
  </Tab>
</Tabs>

---

## Quick Reference

| Question | Figma MCP | Console MCP |
|---|---|---|
| *Can it read my designs?* | Yes | Yes |
| *Can it write to my designs?* | Yes (`use_figma`) | Yes (dedicated tools and `figma_execute`) |
| *Does it have Code Connect?* | Yes | No |
| *Can it create new files?* | Yes (`create_new_file`) | No |
| *Does it export tokens to code formats and import them back?* | Not as dedicated tools | Yes (10 export formats, DTCG import) |
| *Does it compare a Figma component with its code?* | Not as a dedicated tool | Yes (`figma_check_design_parity`) |
| *Where does it run?* | Hosted by Figma | Your machine, Cloud Mode, or your own deployment |
| *Is the source available?* | See Figma's documentation | Yes (MIT) |
| *Who makes it?* | Figma | Southleft |

---

## How This Page Has Changed

When this comparison was first written, the official Figma MCP was read-only and focused on design-to-code, and write access was the main difference between the two servers. That is no longer true. The official server now writes to Figma, creates files, and covers motion, shaders, and diagrams. Console MCP's focus has narrowed to design-system operations. This page was rewritten in September 2026 to reflect both.

<Note>
**Figma Console MCP** is an open-source project built by [Southleft](https://southleft.com). It is not a Figma product and is not supported by Figma. The official **Figma MCP server** is built and maintained by Figma.
</Note>

---

## Get Started

<Columns cols={2}>
  <Card title="Set Up Figma Console MCP" icon="rocket" href="/setup">
    Full 121 tool access in about 10 minutes.
  </Card>
  <Card title="Set Up Figma MCP (Official)" icon="figma" href="https://developers.figma.com/docs/figma-mcp-server/">
    Figma's documentation for its MCP server.
  </Card>
</Columns>
