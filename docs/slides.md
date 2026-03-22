---
title: "Figma Slides Support"
description: "AI agents can now manage entire presentations — create slides, set transitions, reorder decks, and add content. A complete guide to the 15 Slides tools."
---

# AI-Powered Presentations

Figma Console MCP now extends beyond Design files and FigJam boards into **Figma Slides** — Figma's presentation tool built directly on the design canvas. Teams use it for pitch decks, design reviews, sprint demos, conference talks, and stakeholder presentations.

This is not a read-only integration. Your AI assistant can **create and manage entire presentations** — adding slides, setting transitions, reordering decks, and placing content — turning Figma Slides into a programmable stage for AI-assisted storytelling.

---

## What is Figma Slides?

Figma Slides is Figma's native presentation tool, built on the same canvas you already use for design work. Unlike standalone slide apps, your presentations live alongside your design files, share the same components and styles, and update in real time as your design system evolves. Teams use it for everything from internal sprint demos to polished client-facing pitch decks.

With Figma Console MCP, every part of your presentation is now accessible to AI agents.

---

## What's Now Possible

AI assistants connected through Figma Console MCP can now manage presentations programmatically:

<CardGroup cols={2}>
  <Card title="Create and Manage Slides" icon="layer-plus">
    Create new slides, duplicate existing ones, delete slides you no longer need, and reorder your deck — all through natural language prompts.
  </Card>
  <Card title="Read Slide Content" icon="eye">
    Retrieve the full content of any slide — text, shapes, frames, the entire node tree — so your AI assistant can analyze, summarize, or audit your presentation.
  </Card>
  <Card title="Set Transitions" icon="wand-magic-sparkles">
    Apply any of 22 transition styles with 8 easing curves and configurable duration. Set a consistent feel across the whole deck or fine-tune individual slides.
  </Card>
  <Card title="Control Presentation Flow" icon="presentation-screen">
    Skip slides that are not ready, navigate between slides, and switch between grid and single-slide view — all without touching the mouse.
  </Card>
  <Card title="Add Content to Slides" icon="text">
    Place text and shapes directly onto slides. Quickly scaffold title cards, section dividers, and content placeholders.
  </Card>
  <Card title="See the Big Picture" icon="grid-2">
    Read the 2D slide grid layout to understand how your deck is structured, then switch to grid view for a bird's-eye overview.
  </Card>
</CardGroup>

---

## The 15 Slides Tools

Every tool is available in both **Local Mode** and **Cloud Mode**.

### Read Tools

| Tool | What It Does |
|------|-------------|
| `figma_list_slides` | List all slides in the presentation with their order, names, and skip status |
| `figma_get_slide_content` | Read the full content of a specific slide — text, shapes, frames, everything |
| `figma_get_slide_grid` | Read the 2D grid layout to understand the spatial arrangement of your deck |
| `figma_get_slide_transition` | Check what transition style, easing, and duration are set on a slide |
| `figma_get_focused_slide` | See which slide is currently selected in the editor |

### Write Tools

| Tool | What It Does |
|------|-------------|
| `figma_create_slide` | Add a new blank slide to the presentation |
| `figma_delete_slide` | Remove a slide from the deck |
| `figma_duplicate_slide` | Copy an existing slide, preserving all its content and formatting |
| `figma_reorder_slides` | Move slides to new positions in the deck |
| `figma_set_slide_transition` | Apply a transition style with easing and duration to a slide |
| `figma_skip_slide` | Mark a slide to be skipped during presentation mode |
| `figma_add_text_to_slide` | Place a text element on a slide with configurable size and position |
| `figma_add_shape_to_slide` | Add a shape element to a slide for visual structure |

### Navigation Tools

| Tool | What It Does |
|------|-------------|
| `figma_set_slides_view_mode` | Switch between grid view and single-slide view |
| `figma_focus_slide` | Navigate to a specific slide in the editor |

### Transition System

The transition support is comprehensive. You have full control over how each slide enters during a presentation.

**22 Transition Styles:**

| Category | Styles |
|----------|--------|
| Basic | `NONE`, `DISSOLVE`, `SMART_ANIMATE` |
| Slide In | `SLIDE_FROM_LEFT`, `SLIDE_FROM_RIGHT`, `SLIDE_FROM_TOP`, `SLIDE_FROM_BOTTOM` |
| Push | `PUSH_FROM_LEFT`, `PUSH_FROM_RIGHT`, `PUSH_FROM_TOP`, `PUSH_FROM_BOTTOM` |
| Move In | `MOVE_FROM_LEFT`, `MOVE_FROM_RIGHT`, `MOVE_FROM_TOP`, `MOVE_FROM_BOTTOM` |
| Slide Out | `SLIDE_OUT_TO_LEFT`, `SLIDE_OUT_TO_RIGHT`, `SLIDE_OUT_TO_TOP`, `SLIDE_OUT_TO_BOTTOM` |
| Move Out | `MOVE_OUT_TO_LEFT`, `MOVE_OUT_TO_RIGHT`, `MOVE_OUT_TO_TOP`, `MOVE_OUT_TO_BOTTOM` |

**8 Easing Curves:** `LINEAR`, `EASE_IN`, `EASE_OUT`, `EASE_IN_AND_OUT`, `GENTLE`, `QUICK`, `BOUNCY`, `SLOW`

**Duration:** Configurable from 0.01 to 10 seconds.

<Tip>
`DISSOLVE` with `EASE_IN_AND_OUT` at 0.5 seconds is a clean default for most presentations. `SMART_ANIMATE` works best when consecutive slides share similar elements — Figma automatically animates the differences.
</Tip>

---

## Use Cases

These are real-world scenarios where Slides support transforms your presentation workflow. Each example includes a prompt you can try with your AI assistant.

### Presentation Review

Get an instant overview of your deck before the big meeting.

```
List all slides in my presentation and tell me which ones
are skipped. Summarize the overall structure.
```

The AI calls `figma_list_slides` to retrieve the full deck, identifies any skipped slides, and provides a summary so you can verify everything is in order.

### Quick Additions

Need a closing slide? Add it without breaking your flow.

```
Add a new slide at the end with the title "Thank You" in
72px text, centered on the slide.
```

The AI uses `figma_create_slide` to add the slide, then `figma_add_text_to_slide` to place the title — done in seconds.

### Batch Transition Formatting

Set a consistent visual rhythm across your entire presentation in one prompt.

```
Set a DISSOLVE transition on all slides with 0.5 second
duration and EASE_IN_AND_OUT easing.
```

The AI calls `figma_list_slides` to get every slide, then applies `figma_set_slide_transition` to each one. No more clicking through slides one at a time.

### Design Iteration

Quickly create variations for stakeholder review.

```
Duplicate slide 5 and add a shape overlay for the A/B
comparison version.
```

The AI uses `figma_duplicate_slide` to create the copy and `figma_add_shape_to_slide` to place the overlay — keeping your original intact while you explore alternatives.

### Content Audit

Let your AI assistant read through the deck and flag issues.

```
Read slide 3 and tell me what text elements are on it.
Check if there are any placeholder texts that need updating.
```

The AI calls `figma_get_slide_content` to retrieve the full node tree, then analyzes every text element to surface anything that still says "Lorem ipsum" or "Replace me."

### Presentation Prep

Hide unfinished slides before a client presentation without deleting them.

```
Skip slides 8 and 9 — they're not ready for the client
presentation yet.
```

The AI uses `figma_skip_slide` on each slide. They stay in your deck but will not appear during presentation mode. Unskip them later when they are ready.

### Deck Restructuring

Reorder your narrative without dragging slides around manually.

```
Reorder my slides so the conclusion comes before the Q&A
section.
```

The AI calls `figma_list_slides` to understand the current order, identifies the relevant slides, and uses `figma_reorder_slides` to move them into position.

### Navigation and Overview

Switch views to see the big picture or zero in on a specific slide.

```
Switch to grid view so I can see the overall flow of the
presentation.
```

The AI uses `figma_set_slides_view_mode` to switch to grid view, giving you a bird's-eye look at your entire deck layout.

### Checking Animation Settings

Verify how a specific slide will transition before presenting.

```
What transitions are set on my title slide? I want to make
sure it has a clean entrance.
```

The AI calls `figma_get_slide_transition` and reports the transition style, easing curve, and duration — so you know exactly what the audience will see.

### Scaffolding a New Section

Quickly set up the structure for a new part of your presentation.

```
Create 5 new blank slides for our brainstorming section.
Add the title "Brainstorm" to the first one.
```

The AI creates the slides with `figma_create_slide` and adds the section title with `figma_add_text_to_slide`, giving you a clean scaffold to build on.

---

## How It Works

### Editor Type Detection

The Desktop Bridge plugin reports `figma.editorType` when it connects to the MCP server. When the plugin is running inside a Figma Slides presentation, the server automatically makes all 15 Slides tools available. When running in a Figma Design file or FigJam board, the Slides tools are hidden and runtime guards prevent accidental use.

This means there is no configuration toggle or mode switch. The tools appear based on context.

### Same Plugin, New Canvas

Slides support uses the **same Desktop Bridge plugin** you already have installed. There is no separate plugin for Slides. Open any Figma Slides presentation, run the Desktop Bridge plugin, and the Slides tools become available alongside the standard toolset.

### Runtime Safety

If a Slides tool is called while connected to a Figma Design file or FigJam board, it returns a clear error message explaining that Slides tools require a Slides presentation. This prevents accidental misuse and gives the AI assistant enough context to guide you back on track.

### Compatibility

| Mode | Slides Support |
|------|---------------|
| Local (NPX/Git) | Full support |
| Cloud Mode | Full support |
| Remote (Read-Only) | Not available (requires Desktop Bridge) |

---

## Getting Started

<Steps>
  <Step title="Open a Figma Slides Presentation">
    Open any Figma Slides presentation in Figma Desktop. You can create a new presentation from the Figma home screen or open an existing one.
  </Step>
  <Step title="Run the Desktop Bridge Plugin">
    Launch the Desktop Bridge plugin from **Plugins > Development > Figma Desktop Bridge**. The plugin connects to the MCP server and reports that the editor type is Slides.
  </Step>
  <Step title="Ask Your AI Assistant to Help">
    Start with a simple prompt like *"List all slides in my presentation"* to verify the connection, then move on to more complex workflows like setting transitions, restructuring decks, and adding content.
  </Step>
</Steps>

<Info>
If you have not set up the Desktop Bridge plugin yet, follow the [Setup Guide](/setup) first. The same plugin installation works for Figma Design files, FigJam boards, and Slides presentations.
</Info>

---

## Community Contributors

Figma Slides support was inspired by community contributions and merged into the main project:

- **Toni Haidamous** — Authored the original Slides tool design (PR #11) that laid the groundwork for this integration.

<Note>
Figma Console MCP is open source. If you want to contribute new tools or improvements, visit the [GitHub repository](https://github.com/southleft/figma-console-mcp).
</Note>
