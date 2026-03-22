---
title: "FigJam Support"
description: "AI agents can now create and read FigJam boards — sticky notes, flowcharts, tables, code blocks, and more. A complete guide to the 9 FigJam tools."
---

# AI Meets Collaborative Whiteboarding

Figma Console MCP now extends beyond Figma Design files into **FigJam** — Figma's collaborative whiteboarding tool used by millions of teams for brainstorming, planning, diagramming, and retrospectives.

This is not a read-only integration. Your AI assistant can **create content on FigJam boards** and **read everything back** — turning FigJam into a programmable canvas for AI-assisted collaboration.

---

## What is FigJam?

FigJam is Figma's whiteboarding product, purpose-built for ideation and team collaboration. Teams use it for brainstorming sessions, user flow diagrams, sprint retrospectives, project planning, and technical architecture discussions. It features sticky notes, shapes, connectors, tables, and more — all in a free-form infinite canvas.

With Figma Console MCP, every one of those elements is now accessible to AI agents.

---

## What's Now Possible

AI assistants connected through Figma Console MCP can now interact with FigJam boards programmatically:

<CardGroup cols={2}>
  <Card title="Create Sticky Notes" icon="note-sticky">
    Place individual stickies or batch-create up to 200 at once, with 9 color options for categorization and visual grouping.
  </Card>
  <Card title="Build Flowcharts" icon="diagram-project">
    Create shapes (rectangles, diamonds, ellipses, engineering symbols) and connect them with labeled connectors to produce complete diagrams.
  </Card>
  <Card title="Generate Tables" icon="table">
    Create structured tables up to 100 rows by 50 columns, pre-populated with cell data — perfect for comparison matrices and planning grids.
  </Card>
  <Card title="Share Code Snippets" icon="code">
    Add code blocks with language-specific syntax highlighting directly to the board for technical reviews and documentation.
  </Card>
  <Card title="Auto-Arrange Layouts" icon="grid">
    Organize elements into grid, horizontal, or vertical layouts with configurable spacing — no manual dragging required.
  </Card>
  <Card title="Read Board Contents" icon="eye">
    Retrieve all board elements with full type-specific serialization, including sticky text, shape types, table data, and connector graphs.
  </Card>
</CardGroup>

---

## The 9 FigJam Tools

Every tool is available in both **Local Mode** and **Cloud Mode**.

| Tool | Description |
|------|-------------|
| `figjam_create_sticky` | Create a single sticky note with text and optional color and position |
| `figjam_create_stickies` | Batch-create up to 200 sticky notes in a single call |
| `figjam_create_connector` | Connect two nodes with a connector line and optional text label |
| `figjam_create_shape_with_text` | Create a labeled shape for flowcharts and diagrams |
| `figjam_create_table` | Create a table with rows, columns, and pre-populated cell data |
| `figjam_create_code_block` | Add a code snippet with language syntax highlighting |
| `figjam_auto_arrange` | Arrange nodes in grid, horizontal, or vertical layouts |
| `figjam_get_board_contents` | Read all content from a FigJam board with type-specific data |
| `figjam_get_connections` | Read the full connection graph — edges, labels, and connected nodes |

### Supported Shapes

The `figjam_create_shape_with_text` tool supports the following shape types for building diagrams:

| Shape | Use Case |
|-------|----------|
| `ROUNDED_RECTANGLE` | Process steps, general-purpose nodes (default) |
| `DIAMOND` | Decision points in flowcharts |
| `ELLIPSE` | Start/end terminators |
| `TRIANGLE_UP` / `TRIANGLE_DOWN` | Directional indicators |
| `PARALLELOGRAM_RIGHT` / `PARALLELOGRAM_LEFT` | Input/output operations |
| `ENG_DATABASE` | Database references |
| `ENG_QUEUE` | Message queues and buffers |
| `ENG_FILE` | File operations |
| `ENG_FOLDER` | Directory or collection references |

### Sticky Note Colors

Nine color options for visual categorization: `YELLOW`, `BLUE`, `GREEN`, `PINK`, `ORANGE`, `PURPLE`, `RED`, `LIGHT_GRAY`, `GRAY`.

<Tip>
For full parameter details, default values, and return types, see the [FigJam Tools reference](/tools#figjam-tools).
</Tip>

---

## Use Cases

These are real-world scenarios where FigJam support transforms AI-assisted workflows. Each example includes a prompt you can try with your AI assistant.

### Affinity Mapping from Meeting Notes

Turn unstructured meeting notes into an organized affinity map — instantly.

```
Generate an affinity map from these meeting notes on a FigJam board.
Group related ideas using colored stickies: BLUE for product features,
GREEN for technical requirements, PINK for user feedback, and ORANGE
for open questions. Arrange each group in a grid layout.
```

The AI uses `figjam_create_stickies` to batch-create all notes, assigns colors by category, and calls `figjam_auto_arrange` to lay them out in clean groups.

### User Flow Diagrams

Build complete flowcharts from a verbal description of a user journey.

```
Create a user flow diagram for the checkout process on our FigJam board.
Start with "View Cart", then decision diamond "Has Account?", branching
to "Sign In" and "Guest Checkout", merging at "Enter Shipping", then
"Payment", and ending at "Order Confirmed".
```

The AI creates shapes with `figjam_create_shape_with_text` (rounded rectangles for steps, diamonds for decisions, ellipses for start/end) and wires them together with `figjam_create_connector` using descriptive labels like "Yes" and "No" on the branches.

### Sprint Retrospective Board

Set up a structured retro board in seconds, ready for the team to fill in.

```
Create a sprint retrospective board with three sections:
- GREEN stickies column: "What went well" with 3 placeholder items
- PINK stickies column: "What to improve" with 3 placeholder items
- BLUE stickies column: "Action items" with 3 placeholder items
Arrange each column vertically with clear spacing between groups.
```

### Summarize an Existing Board

Read a brainstorming board and extract actionable insights.

```
Read this FigJam brainstorming board and summarize the themes.
Group the sticky notes by topic, identify the most common ideas,
and list any action items or decisions that were captured.
```

The AI calls `figjam_get_board_contents` to retrieve all elements, then analyzes the text content to produce a structured summary — no manual reading required.

### Comparison Tables

Create structured decision matrices for stakeholder review.

```
Create a comparison table on this FigJam board for our 3 platform
options: AWS, GCP, and Azure. Include rows for: Compute pricing,
Database options, CDN performance, Developer experience, and
Enterprise support. Fill in what you know.
```

The AI uses `figjam_create_table` to generate a pre-populated table that the team can review and annotate collaboratively.

### Code Review on the Board

Share code directly on the whiteboard for collaborative technical discussion.

```
Add this TypeScript function to the FigJam board as a code block
so the team can review it during our architecture session:

async function processOrder(order: Order): Promise<Receipt> {
  const validated = await validateOrder(order);
  const payment = await chargePayment(validated);
  return generateReceipt(payment);
}
```

The AI uses `figjam_create_code_block` with `TYPESCRIPT` syntax highlighting to render the snippet with proper formatting.

### Analyze a Flowchart

Understand the structure and relationships in an existing diagram.

```
What are all the connections in this flowchart? Show me the full
graph of how elements are connected, including any labels on
the connector lines.
```

The AI calls `figjam_get_connections` to return the complete edge list with start/end nodes and labels, then presents the graph structure in a readable format — useful for documenting existing flows or identifying missing connections.

---

## How It Works

### Editor Type Detection

The Desktop Bridge plugin reports `figma.editorType` when it connects to the MCP server. When the plugin is running inside a FigJam board, the server automatically makes all 9 FigJam tools available. When running in a Figma Design file, the FigJam tools are hidden and runtime guards prevent accidental use.

This means there is no configuration toggle or mode switch. The tools appear based on context.

### Same Plugin, New Canvas

FigJam support uses the **same Desktop Bridge plugin** you already have installed. There is no separate plugin for FigJam. Open any FigJam board, run the Desktop Bridge plugin, and the FigJam tools become available alongside the standard toolset.

### Runtime Safety

If a FigJam tool is called while connected to a Figma Design file, it returns a clear error message explaining that FigJam tools require a FigJam board. This prevents accidental misuse and gives the AI assistant enough context to guide the user.

### Compatibility

| Mode | FigJam Support |
|------|---------------|
| Local (NPX/Git) | Full support |
| Cloud Mode | Full support |
| Remote (Read-Only) | Not available (requires Desktop Bridge) |

---

## Getting Started

<Steps>
  <Step title="Open a FigJam Board">
    Open any FigJam board in Figma Desktop. You can create a new board from the Figma home screen or open an existing one.
  </Step>
  <Step title="Run the Desktop Bridge Plugin">
    Launch the Desktop Bridge plugin from **Plugins > Development > Figma Desktop Bridge**. The plugin connects to the MCP server and reports that the editor type is FigJam.
  </Step>
  <Step title="Ask Your AI Assistant to Create">
    Start with a simple prompt like *"Create a yellow sticky note that says Hello from AI"* to verify the connection, then move on to more complex workflows like flowcharts, tables, and batch operations.
  </Step>
</Steps>

<Info>
If you have not set up the Desktop Bridge plugin yet, follow the [Setup Guide](/setup) first. The same plugin installation works for both Figma Design files and FigJam boards.
</Info>

---

## Community Contributors

FigJam support was built by the community and merged into the main project. Recognition goes to the contributors who made this possible:

- **klgral (G Klas)** — Authored the original FigJam write tools: sticky notes, batch stickies, connectors, shapes, tables, code blocks, and auto-arrange.
- **lukemoderwell (Luke Moderwell)** — Authored the FigJam read tools (`figjam_get_board_contents` and `figjam_get_connections`) and contributed documentation.

<Note>
Figma Console MCP is open source. If you want to contribute new tools or improvements, visit the [GitHub repository](https://github.com/southleft/figma-console-mcp).
</Note>
