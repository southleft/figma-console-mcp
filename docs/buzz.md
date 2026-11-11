---
title: 'Figma Buzz Support'
description: 'AI agents can now work with Figma Buzz assets and canvas grids — create frames, manage asset types, move assets in the grid, and extract Buzz text/media fields.'
---

Figma Console MCP now extends beyond Design files, FigJam boards, and Slides presentations into **Figma Buzz** — Figma's workflow for high-volume brand and campaign asset production.

This first Buzz release focuses on the core asset workflow: **canvas grid navigation, frame creation, asset metadata, smart resizing, and field extraction**. It intentionally does not include Buzz-native instance creation or text/media mutation yet.

## What is Figma Buzz?

Figma Buzz is built for teams producing large sets of marketing and social assets. Instead of treating every frame as an isolated design artifact, Buzz organizes work around assets, placements, reusable templates, and structured content fields. That makes it a strong fit for AI-assisted production workflows where agents need to understand both the asset grid and the metadata attached to each asset.

With Figma Console MCP, AI assistants can now:

- Inspect the Buzz canvas grid and focused asset state
- Create Buzz-native frames in the canvas grid
- Move assets between grid coordinates
- Read and update Buzz asset types
- Smart-resize Buzz assets for new formats
- Extract serialized Buzz text and media field metadata

## The 13 Buzz Tools

| Tool                             | What it does                                                         |
| -------------------------------- | -------------------------------------------------------------------- |
| `figma_buzz_get_canvas_grid`     | Read the current Buzz canvas grid structure                          |
| `figma_buzz_create_canvas_row`   | Create a new row in the Buzz canvas grid                             |
| `figma_buzz_move_nodes_to_coord` | Move one or more assets to a target grid coordinate                  |
| `figma_buzz_get_canvas_view`     | Read whether Buzz is in `grid` or `single-asset` view                |
| `figma_buzz_set_canvas_view`     | Switch between `grid` and `single-asset` view                        |
| `figma_buzz_get_focused_asset`   | Read the currently focused Buzz asset                                |
| `figma_buzz_focus_asset`         | Focus a specific asset and switch to single-asset view               |
| `figma_buzz_create_frame`        | Create a Buzz-native frame with optional row, column, name, and size |
| `figma_buzz_get_asset_type`      | Read the Buzz asset type assigned to a node                          |
| `figma_buzz_set_asset_type`      | Set the Buzz asset type on a node                                    |
| `figma_buzz_smart_resize`        | Resize a Buzz asset using Buzz's native resize logic                 |
| `figma_buzz_get_text_content`    | Extract serialized Buzz text field metadata                          |
| `figma_buzz_get_media_content`   | Extract serialized Buzz media field metadata                         |

## Example Workflows

### Inspect the asset grid

```
Read the Buzz canvas grid and tell me which assets are in each row
```

The AI calls `figma_buzz_get_canvas_grid` and returns a structured row/column view, which is useful for batch operations and layout auditing.

### Create a new Buzz asset in the grid

```
Create a new Buzz frame in row 1 column 2 called Spring Launch Story at 1080 by 1920
```

The AI uses `figma_buzz_create_frame` so the new frame is created as a Buzz-native asset instead of a generic design frame.

### Reformat an asset for a new placement

```
Set this asset to INSTAGRAM_POST and smart resize it to 1080 by 1350
```

The AI combines `figma_buzz_set_asset_type` and `figma_buzz_smart_resize` to adapt the asset to a new channel or campaign format.

### Extract structured Buzz fields

```
Read the text and media content fields from this Buzz asset
```

The AI uses `figma_buzz_get_text_content` and `figma_buzz_get_media_content` to return serialized field metadata that is safe to inspect in chat or pass into downstream workflows.

## Runtime Safeguards

Buzz tools only work when the Desktop Bridge plugin is running inside a **Figma Buzz file**.

If a Buzz tool is called while connected to a Design file, FigJam board, or Slides presentation, it returns a clear Buzz-only error. Missing nodes, invalid focus targets, unsupported asset types, and smart-resize failures also surface the underlying runtime message so the AI can explain what went wrong.

This first Buzz release also follows the same bootstrap strategy used for FigJam and Slides:

- the plugin recognizes `editorType === 'buzz'`
- eager variables bootstrap is skipped on startup
- Buzz-specific behavior is exposed through dedicated `figma_buzz_*` tools

## Setup

Buzz support uses the **same Desktop Bridge plugin** you already use for Design, FigJam, and Slides.

<Steps>
  <Step title="Open a Figma Buzz file">
    Open an existing Buzz file in Figma Desktop.
  </Step>
  <Step title="Run the Desktop Bridge plugin">
    Launch **Plugins > Development > Figma Desktop Bridge**. The plugin reports the editor type to the MCP server automatically.
  </Step>
  <Step title="Verify with a simple Buzz prompt">
    Start with something like *"Read the Buzz canvas grid"* or *"Get the focused Buzz asset"* to confirm the connection.
  </Step>
</Steps>

If you have not set up the Desktop Bridge plugin yet, follow the [Setup Guide](/setup) first.

## Current Scope and Deferred Work

Buzz support is intentionally scoped for a clean v1:

- Included: grid operations, frame creation, focus/view control, asset typing, smart resize, field extraction
- Deferred: Buzz-native `createInstance`
- Deferred: text/media mutation tools
- Deferred: tighter enum validation for asset types once the public Buzz API surface stabilizes further
