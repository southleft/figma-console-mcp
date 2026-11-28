---
title: "Import & Export"
description: "Bring SVG icons, illustrations and images into Figma as editable layers and icon components, and export renders, icon SVGs and original images as files for code."
---

# Import & Export

This guide covers moving assets between Figma and your code:

- **[Icons and SVG](#icons-and-svg)**: SVG markup, files or a whole icon folder become editable vectors, icon components and variant sets, with their color bound to a token. Re-importing updates the existing icons in place.
- **[Images](#images)**: PNG, JPEG and GIF files become image layers, or the fill of layers you already have.
- **[Export for code](#export-for-code)**: PNG, JPG, SVG and PDF renders of layers, the icon SVGs inside a screen, and the original image files behind image fills, written to a folder in your repo.

Everything runs through the Desktop Bridge plugin you already have. No plugin re-import, no extra install, and no Figma token, except for export links (`output: "urls"`).

| Tool | What it does |
|---|---|
| `figma_import_svg` | SVG markup, `.svg` files or a folder → vectors, icon components, variant sets |
| `figma_import_image` | PNG, JPEG or GIF → new image layers, or the fill of existing layers |
| `figma_export_assets` | Renders, icon SVGs and original images → files, inline content, or Figma-hosted links |

---

## Before you start

**Local Mode** starts with the core tools only. The import and export tools are in the `assets` toolset. Ask your AI assistant to import an icon and it switches the toolset on with:

```javascript
figma_enable_toolsets({ toolsets: ["assets"] })
```

Or preload it by adding `assets` to the `FIGMA_TOOLSETS` environment variable in your MCP config (for example `FIGMA_TOOLSETS=assets`).

`figma_import_svg` and `figma_export_assets` can overwrite (component artwork and files), so they can't run through `figma_call`. Call them by name. If your client doesn't refresh its tool list after `figma_enable_toolsets`, restart the client or set `FIGMA_TOOLSETS`. `figma_import_image` only adds layers or replaces fills, so it also runs through `figma_call`.

**Cloud Mode** lists every tool from the start. It has no filesystem, so you pass SVG markup and image data inline (see [Local Mode and Cloud Mode](#local-mode-and-cloud-mode)).

---

## Icons and SVG

### Import one icon

```javascript
figma_import_svg({
  svgs: [{ name: "search", markup: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"m20 20-3.5-3.5\"/></svg>" }],
  size: 24
})
```

The SVG becomes a frame of editable vector layers on the current page, in clear space next to your existing content. `size` fits the art inside a 24×24 box, keeping its aspect ratio. `width` or `height` fit within one side instead. `parentId` puts the result inside a frame, section, group, page or slide. In Local Mode, pass `paths` (absolute paths to `.svg` files) instead of `svgs`.

Layer names come from `svgs[i].name`, then the file name, then the SVG's `<title>`, then "SVG". `namePrefix: "Icon/"` files them in a folder.

### Draw an icon or illustration

There is no separate generator. The AI writes the SVG itself and imports it, so nothing costs AI credits and the result can go straight into your icon set:

```javascript
figma_import_svg({
  svgs: [{ name: "rocket", markup: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"…\"/></svg>" }],
  asComponent: true,
  size: 24,
  namePrefix: "Icon/",
  color: { variable: "icon/default" },
  flatten: true
})
```

For an illustration, leave out `asComponent` and give it room:

```javascript
figma_import_svg({
  svgs: [{ name: "Empty state – mountains", markup: "<svg viewBox=\"0 0 1024 768\">…</svg>" }],
  width: 1024,
  parentId: "12:34"
})
```

SVG that imports cleanly has a `viewBox`, uses paths instead of `<text>`, and uses `currentColor` for the color of a single-color icon. Quality depends on the model's SVG skill, so check the result with a screenshot and ask for changes.

### Icon components

`asComponent: true` makes each SVG a component (Design files only). Its artwork scales with the instance, so an instance resized to 48×48 draws a 48×48 icon. With `size`, the component frame is exactly `size × size` and wide or tall art is centered in it.

`flatten: true` merges an icon into one vector named `Vector` when all its layers share the same paint and stroke. A flattened icon keeps the same layer structure from one version to the next, so later updates keep instance overrides.

### A folder of icons

In Local Mode, point the tool at a folder:

```javascript
figma_import_svg({
  directory: "/Users/me/app/src/icons",
  recursive: true,
  asComponent: true,
  size: 24,
  namePrefix: "Icon/",
  color: { variable: "icon/default" }
})
```

Components land in a section named "Icons" (vectors without components go in an auto-layout frame named "SVG import"; `layout.containerName` changes the name and an existing section or frame with that name is reused). `recursive` includes subfolders up to six levels deep. Hidden files, symbolic links inside the folder and nested `node_modules` folders are skipped.

A large folder imports in pages. When the response has `remaining.nextOffset`, run the same call again with `offset` set to it. `limit` sets roughly how many files go in one call; variant sets are never split across pages.

### Variant sets from file names

`variants.pattern` turns file names (or paths relative to `directory`, without `.svg`) into component sets. `{name}` is the set name and each `{Axis}` becomes a variant property:

| Your files | Pattern | Result |
|---|---|---|
| `arrow-16.svg`, `arrow-24.svg` | `{name}-{Size}` | Set `arrow` with `Size=16`, `Size=24` |
| `bell_outline.svg`, `bell_solid.svg` | `{name}_{Style}` | Set `bell` with `Style=outline`, `Style=solid` |
| `24/outline/arrow-left.svg`, `16/solid/arrow-left.svg` | `{Size}/{Style}/{name}` | Set `arrow-left` with `Size` × `Style` variants |

```javascript
figma_import_svg({
  directory: "/Users/me/app/src/icons",
  recursive: true,
  variants: {
    pattern: "{Size}/{Style}/{name}",
    axes: [
      { name: "Size", values: ["16", "24"] },
      { name: "Style", values: ["outline", "solid"] }
    ]
  },
  namePrefix: "Icon/",
  color: { variable: "icon/default" }
})
```

`axes` is optional. It lists the allowed values in display order (the first value is the default variant) and settles ambiguous names. A file that doesn't match the pattern becomes a standalone component, with a note. Sets are laid out as a variant matrix with Figma's purple dashed border.

### Color and tokens

`color` recolors the icon:

- `color.variable`: a local COLOR variable by name (`icon/default` or `Icons/icon/default`) or id.
- `color.variableKey`: the key of a COLOR variable in a library the file uses (from `figma_get_library_variables`). It is imported into the file automatically.
- `color.value`: a literal color (hex or any CSS color) instead of a variable.

By default (`color.apply: "auto"`) only the paints that were `currentColor` in the SVG are bound, or every paint when the SVG is a single color. A two-tone icon with a fixed accent keeps its accent. `apply: "currentColor"` binds only `currentColor` paints; `apply: "all"` recolors every solid paint. `color.targets` limits it to `fills` or `strokes`.

### Re-importing: updates in place

Re-run the same import after your icons change in code. A component or set with the same name is updated in place by default (`onExisting: "update"`), so every instance gets the new artwork:

- Icons whose artwork didn't change since the last import are reported `unchanged` and not touched (`force: true` re-applies them anyway, for example after manual edits in Figma).
- Where the layer structure is the same, the geometry is swapped in place and instance overrides survive, in this file and in files that use the library. Where it changed, the artwork is replaced and overrides on the old layers reset. `keepOverrides: true` only updates icons whose structure is unchanged and skips the rest.
- A component is only updated when it is plain vector artwork: no text layers (unless the SVG had text), no instances, no auto layout, and no component properties other than variants. Anything else that shares the name is reported as a conflict and left alone.
- The color binding an icon already had carries over.

**What you're asked first.** When an icon to update has instances, or its library is published, you are asked before anything changes. The question names the file, how many components and instances, and whether the library is published. You can replace the artwork, update only where instance overrides are kept, or leave existing components alone and import only new icons. A version named "Before SVG import (Figma Console MCP)" is saved to the file's version history first, so you can restore it. If that version can't be saved, existing components aren't changed.

Clients that can't show the question (and Cloud Mode) skip those updates and say why, unless you passed `onExisting: "update"` yourself. `FIGMA_CONSOLE_CONFIRM_DESTRUCTIVE=off` turns the question off.

`onExisting: "skip"` leaves existing components alone; `"duplicate"` creates new ones beside them. `matchScope: "page"` looks for existing components on the target page only (faster in a big file).

**Preview first.** `dryRun: true` reports the names, sets, updates, conflicts and the question a real run would ask, without changing Figma.

### FigJam and Slides

Both import plain vectors. Components and variant sets are Design-only.

- **FigJam:** a batch lands in a section; a single SVG goes on the board at clear space (or inside the section you name with `parentId`). Binding to variables isn't available in FigJam (it has no variables), so pass `color.value` instead of `color.variable`.
- **Slides:** with no `parentId` the result goes on the focused slide. Pass a slide id as `parentId` to target another one. Variable binding works.

Dev Mode is read-only, so imports are refused there.

### Long imports and interruptions

Big batches are sent to Figma in chunks. In Local Mode, a client that supports MCP Tasks gets a task handle and the import keeps running past the client's request timeout.

If a call stops early (Figma didn't answer in time, the time budget ran out, or you cancelled), the response has `incomplete` with a `runId` and the items not yet sent. Nothing more is sent to Figma in that call. When Figma is idle, run the same call again with `resumeRunId`: icons that run already imported are recognized instead of imported twice, and components update in place as usual.

### What gets removed

Every SVG is treated as untrusted, whoever wrote it. Scripts, event handlers, `<foreignObject>`, external links and references (`href`s to other files or URLs, `url(https://…)` in styles), animation elements and editor metadata (Inkscape, Illustrator, Sketch) are removed before Figma sees the markup, and the response counts what was removed. Filters that use effects Figma can't import are removed whole. SVGs that are malformed, too large (5 MB per SVG), or that expand into too many elements through `<use>` are reported with the reason and the rest of the batch still imports. See [Security](/security#svg-and-image-import).

Illustrator and Inkscape exports, `<svg:svg>` prefixes, `<style>` class colors, percentage gradients and `width="1em"` sizes are handled. Figma itself reports some SVGs it can't read (for example a degenerate gradient); those come back with Figma's message.

---

## Images

`figma_import_image` brings PNG, JPEG and GIF images in as layers with an image fill:

```javascript
// One image, base64 (a data: URL works too)
figma_import_image({ images: [{ name: "hero", data: "iVBORw0KGgo…" }] })

// Local Mode: files and folders
figma_import_image({ images: [{ path: "/Users/me/app/public/hero@2x.png" }] })
figma_import_image({ directory: "/Users/me/app/public/photos", width: 320 })
```

- New layers are rectangles (`nodeType: "frame"` for frames) at the image's size. A `@2x` or `@3x` file name, or `density`, places a high-resolution image at 1x.
- `width` and `height` fit new layers; with both, `fit: "contain"` (default) keeps the aspect ratio and `fit: "exact"` makes the layer exactly that size.
- `scaleMode` (`FILL`, `FIT`, `CROP`, `TILE`) sets how the image sits in its layer, as in Figma's fill panel.
- Several images are laid out in a grid frame named "Images" (a section in FigJam).

**Fill existing layers** instead of creating new ones:

```javascript
figma_import_image({ images: [{ path: "/Users/me/app/public/avatar.jpg", nodeIds: ["12:40", "12:41"] }], scaleMode: "FILL" })
```

The image replaces those layers' fills; they aren't moved or selected. A detached fill style or replaced fill variable is mentioned in the notes.

Limits: 8 MB and 4096 px per side per image. The type is read from the file's bytes, not its extension. WebP, HEIC, AVIF, BMP, TIFF and SVG aren't accepted (Figma's plugin API takes PNG, JPEG and GIF; use `figma_import_svg` for SVG). Images that can't be read are reported and the rest still import. `dryRun: true` checks formats, sizes and targets without changing Figma.

For a single image onto layers you already have, `figma_set_image_fill` (in the `inspect` toolset) does the same with less to fill in.

---

## Export for code

`figma_export_assets` exports what your code needs. Renders come from the live file through the Desktop Bridge: any plan, no token, and unsaved changes included.

### Renders

```javascript
// The current selection, using each layer's Export panel settings (PNG 1x when it has none)
figma_export_assets({})

// Explicit format and scale win over the Export panel
figma_export_assets({ nodeIds: ["12:41"], format: "PNG", scale: 2, outputDir: "/Users/me/app/public/img" })
```

Up to 50 nodes per call, in PNG, JPG, SVG or PDF. `scale` (0.01–4), `width` or `height` size PNG and JPG renders. With no `format` or `scale`, each node is exported once per setting in its Export panel, with Figma's suffixes (`@2x`), the same way Figma's own export does.

### Icons as code-ready SVG

```javascript
figma_export_assets({
  nodeIds: ["12:39"],                 // an icon set, or a frame of icons
  vectors: "only",
  svg: { currentColor: true, removeSize: true },
  outputDir: "/Users/me/app/src/icons",
  fileName: "{set}/{variant}"
})
```

`vectors: "only"` exports each icon inside the set or frame as its own SVG, so a set `arrow-left` with `Size` and `Style` variants becomes `arrow-left/24-outline.svg`, `arrow-left/16-solid.svg` and so on. Standalone icons get their own name. Vectors are always SVG, so there's no `format`. With `format: "SVG"` and no `vectors`, the set itself is rendered as one SVG of the whole set. To export particular icons, pass the variant ids with `format: "SVG"` instead.

- `svg.currentColor` replaces the color of a single-color SVG with `currentColor`, so CSS can recolor it. Multi-color art is left as is, with a note.
- `svg.removeSize` drops the root `width` and `height` and keeps the `viewBox`, so CSS sets the size.
- `svg.outlineText`, `svg.includeIds` and `svg.simplifyStroke` match Figma's SVG export options.

### Icons and images inside a screen

```javascript
// The screen render plus every icon and logo inside it, as separate SVGs
figma_export_assets({ nodeIds: ["40:2"], vectors: "include" })

// Only the original photos behind image fills, at their full resolution
figma_export_assets({ nodeIds: ["40:2"], images: "only" })
```

`vectors` finds the layers best kept as SVG (icons, logos, simple vector art), one per main component when the same icon appears many times. Background rectangles, text and photos aren't vectors. `images` exports the original image files used in fills, with the right extension. `imageHashes` exports images by hash directly.

### Where the output goes

| `output` | What you get | Modes |
|---|---|---|
| `files` | Files written to `outputDir` (absolute), or to a new folder in the OS temp directory. Paths come back in the response | Local Mode (default) |
| `inline` | PNG and JPG as images the AI can see, SVG as text (96 KB per call by default, `inlineSvgKB` up to 512), small PDFs | Local and Cloud (Cloud default) |
| `urls` | Figma-hosted links. Needs a Figma token, renders the last saved version, and links expire (renders and vectors after 30 days, image files within 14) | Local (with `FIGMA_ACCESS_TOKEN`) and Cloud |

**File names.** `fileName` is a template without extension. Tokens: `{name}` (layer name; variants as set name plus values), `{path}` (the name with `/` kept, so `Icon/arrow-left` becomes a subfolder), `{leaf}` (the part after the last `/`), `{set}`, `{variant}`, `{id}`, `{page}`. A `/` in the template makes subfolders. Names are cleaned for every operating system, and two assets that would get the same name (ignoring case) get `-2`, `-3`.

**Existing files are kept.** A file that already exists is skipped with a note unless you pass `overwrite: true`. Files are only ever written inside `outputDir`, never through a symbolic link. See [Security](/security#asset-export-files).

Renders larger than 16,384 px on a side are skipped with the largest scale that works. To just look at a design, use `figma_capture_screenshot` instead.

---

## Local Mode and Cloud Mode

| | Local Mode | Cloud Mode |
|---|---|---|
| SVG import | Markup (up to 200 per call), `.svg` files and folders | Markup only, up to 100 SVGs per call |
| Image import | Base64, files and folders | Base64 only, up to 50 images per call |
| Export | Files (default), inline, urls | Inline (default), urls |
| `fileKey` (target another open file) | Yes | No (Cloud pairs with one file) |
| Asking before updating icons | Yes, when the client can show the question | No: risky updates are skipped unless you pass `onExisting: "update"` |
| Long runs | MCP task when the client supports it (up to 15 minutes), otherwise up to 4 minutes per call | Up to 2 minutes per call |

`FIGMA_CONSOLE_ASSET_TIMEOUT_SCALE` (Local Mode) multiplies the time each step waits for Figma, from 0.05 to 10. Raise it on a slow machine or for a very large file.

---

## What to check after an import

1. **Look at it.** The response's `hint` names the node to screenshot with `figma_capture_screenshot`. Check alignment, size and color.
2. **Read the problems first.** `items` lists failed, conflicting, skipped and updated icons first, with the reason. Created and unchanged ones are listed compactly below.
3. **Check token bindings.** Each item's `color` says whether a variable was applied and how many paints it bound.
4. **Publish the library** if you updated icons in a library file, so other files get the new artwork when they accept the update.
5. **Continue a partial run** with `remaining.nextOffset` (folder paging) or `resumeRunId` (an interrupted call).
