---
title: "Use Cases"
description: "Real-world scenarios for plugin debugging, design system extraction, component implementation, and AI-assisted design creation."
---

# Use Cases & Scenarios

This guide shows real-world scenarios for using Figma Console MCP in your workflow.

## 🐛 Plugin Development & Debugging

### Scenario 1: Simple Plugin Debugging (Local Mode - Easiest!)

**Your situation:** You're developing a Figma plugin and want to see console output.

**One-time setup:** Quit Figma Desktop and relaunch with:
- **macOS:** `open -a "Figma" --args --remote-debugging-port=9222`
- **Windows:** `cmd /c "%LOCALAPPDATA%\Figma\Figma.exe" --remote-debugging-port=9222`

Then open your design file and run your plugin.

**What to say to your AI assistant:**

```
"Check the last 20 console logs"
```

Then run your plugin in Figma Desktop, and say:

```
"Check the last 20 console logs again"
```

**What happens:**
1. AI retrieves current console logs (likely empty initially)
2. You run your plugin in Figma Desktop
3. AI retrieves logs again - now showing ALL plugin output: `[Main]`, `[Swapper]`, `[Serializer]`, etc.
4. You see errors, warnings, and log statements with timestamps

**Follow-up prompts:**
- "Show me just the error logs"
- "What does this stack trace mean?"
- "Help me fix this error"

**Why this works:** In local mode, the MCP automatically monitors Figma Desktop. No navigation needed!

---

### Scenario 2: Debug Console Errors in Plugin (Cloud Mode)

**Your situation:** You're using cloud mode or need to debug a specific Figma file URL.

**What to say to your AI assistant:**

```
"Navigate to my Figma file at https://figma.com/design/abc123 and watch console logs for 30 seconds while I test my plugin"
```

**What happens:**
1. AI navigates to your Figma file
2. Starts monitoring console logs in real-time
3. Captures any errors, warnings, or log statements
4. Reports back with timestamped logs and stack traces

**Follow-up prompts:**
- "Show me just the error logs"
- "What does this stack trace mean?"
- "Help me fix this error"

---

### Scenario 3: Monitor Plugin Performance

**Your situation:** You want to see what your plugin is logging during execution.

**What to say:**

```
"Navigate to https://figma.com/design/abc123 and watch console for 60 seconds. Show me all console.log statements"
```

**What happens:**
1. AI monitors all console output for 60 seconds
2. Captures every console.log(), console.info(), console.warn()
3. Shows you a timeline of what your plugin is doing

---

### Scenario 4: Debug Plugin with Screenshots

**Your situation:** Plugin UI isn't rendering correctly.

**What to say:**

```
"Navigate to my plugin file, take a screenshot of the plugin UI, then show me console errors"
```

**What happens:**
1. AI navigates to your file
2. Takes screenshot showing the current state
3. Retrieves console errors
4. You can see both visual state and error logs together

---

## 🎨 Design System Extraction

### Scenario 5: Extract Design Tokens

**Your situation:** You need to extract all design variables from your Figma design system.

**What to say:**

```
"Get all design variables from https://figma.com/design/abc123 and export them as CSS custom properties"
```

**What happens:**
1. AI extracts all variables using Figma API
2. Formats them as CSS custom properties
3. Provides organized, ready-to-use CSS code

**Example output:**
```css
:root {
  /* Colors */
  --color-primary-default: #4375FF;
  --color-primary-hover: #2563EB;

  /* Spacing */
  --spacing-xs: 4px;
  --spacing-sm: 8px;

  /* Typography */
  --font-size-body: 16px;
  --line-height-body: 24px;
}
```

---

### Scenario 6: Generate Tailwind Config

**Your situation:** You want to sync your Figma variables to Tailwind CSS.

**What to say:**

```
"Get variables from https://figma.com/design/abc123 and export as Tailwind config"
```

**What happens:**
1. AI extracts variables
2. Converts to Tailwind format
3. Provides `tailwind.config.js` code

---

### Scenario 7: Audit Design System Usage

**Your situation:** You want to see which components are using specific design tokens.

**What to say:**

```
"Get all variables from my design system and show me where each one is used"
```

**What happens:**
1. AI extracts variables with enrichment enabled
2. Shows usage analysis
3. Lists which styles/components use each variable

---

## 🔧 Component Implementation

### Scenario 8: Implement Component from Figma

**Your situation:** You need to implement a Tooltip component from your design file.

**What to say:**

```
"Get the Tooltip component from https://figma.com/design/abc123?node-id=695-313 and help me implement it in React"
```

**What happens:**
1. AI fetches component data with visual reference image
2. Extracts layout, styling, and property information
3. Helps you implement with accurate spacing, colors, and behavior

**AI will provide:**
- Component image for visual reference
- Layout properties (padding, spacing, auto-layout)
- Color and typography specs
- Implementation guidance

---

### Scenario 9: Get Component Specifications

**Your situation:** You just need the specs for a component, not implementation help.

**What to say:**

```
"Get visual reference and layout specs for the Button component at node-id=123:456"
```

**What happens:**
1. AI renders component as high-res image
2. Extracts layout measurements
3. Lists color values and typography
4. You implement it yourself with accurate specs

---

### Scenario 10: Compare Multiple Component Variants

**Your situation:** You have a Button component with Primary, Secondary, and Tertiary variants.

**What to say:**

```
"Get component data for these three button variants: node-id=1:2, node-id=1:3, node-id=1:4. Show me the differences"
```

**What happens:**
1. AI fetches all three variants
2. Compares their properties
3. Highlights what changes between variants (colors, borders, padding, etc.)

---

## ✏️ Design Creation (Local Mode)

These scenarios require Local Mode with the Desktop Bridge plugin installed. They enable AI-assisted design creation directly in Figma.

### Scenario 11: Create Component Variants with Variables

**Your situation:** You want to create a complete button component set with multiple variants, sizes, and states—all bound to design system variables.

**Prerequisites:**
- Local mode with Desktop Bridge plugin running
- Design system variables defined (colors, spacing, radius)

**What to say:**

```
"Create a button component with:
- 4 types: primary, secondary, outline, ghost
- 3 sizes: small, medium, large
- 5 states: default, hover, active, focus, disabled

Bind the colors to my design system variables (piccolo for primary, beerus for secondary, etc.) and use the spacing/radius variables for padding and border-radius."
```

**What happens:**
1. AI loads required fonts
2. Creates individual component variants (60 total: 4×3×5)
3. Applies variable bindings for colors, padding, and border-radius
4. Combines into a component set
5. Calls `figma_arrange_component_set` to organize with labels and proper layout
6. Takes a screenshot to verify the result

**Follow-up prompts:**
- "Add descriptions to each variant"
- "Adjust the hover states to use darker colors"
- "Create a similar set for icon buttons"

---

### Scenario 12: Build a Design System from Scratch

**Your situation:** You're starting a new project and need to set up design system foundations.

**What to say:**

```
"Create a design system with:
1. A color variable collection with:
   - Primary colors (piccolo, beerus, goten)
   - Neutral colors (bulma, trunks, goku)
   - Semantic colors (success, warning, error)
2. A spacing variable collection with xs (4px) through 2xl (48px)
3. A radius variable collection with none, sm, md, lg, full

Then create a basic button component using these variables."
```

**What happens:**
1. AI creates variable collections
2. Adds variables with appropriate values
3. Creates a button component bound to the variables
4. Provides a screenshot of the result

---

### Scenario 13: Organize Existing Component Set

**Your situation:** You have a messy component set that needs proper organization with labels.

**What to say:**

```
"Find my 'Button' component set on the current page and arrange it with:
- Proper variant labels
- Purple dashed border container
- Full-width frame"
```

**What happens:**
1. AI finds the component set by name
2. Calls `figma_arrange_component_set` with your specifications
3. Variants are organized in a grid with row/column labels
4. Everything is wrapped in a properly styled container

---

### Scenario 14: Create Component with Auto-Layout

**Your situation:** You need a card component with proper auto-layout settings.

**What to say:**

```
"Create a card component with:
- Vertical auto-layout, 16px gap
- 24px padding all around
- Rounded corners (12px)
- Contains: image placeholder, title text, description text, action button
- Bind padding to my spacing variables"
```

**What happens:**
1. AI executes Plugin API code to create the frame
2. Sets up auto-layout with specified settings
3. Creates child elements (image, text, button)
4. Binds padding to design system variables
5. Converts to component

---

### Scenario 15: Add Documentation to Components

**Your situation:** You want to add descriptions to your components for design system documentation.

**What to say:**

```
"Add a description to my Button component explaining:
- When to use each variant
- Accessibility requirements
- Usage guidelines

Use markdown formatting."
```

**What happens:**
1. AI finds the Button component
2. Calls `figma_set_description` with markdown-formatted documentation
3. Description appears in Figma's component panel

---

### Scenario 16: Clone and Modify Existing Design

**Your situation:** You want to create variations of an existing component.

**What to say:**

```
"Clone my 'Card/Default' component 3 times and modify each:
1. 'Card/Compact' - reduce padding to 12px
2. 'Card/Featured' - add a colored top border
3. 'Card/Minimal' - remove the image placeholder"
```

**What happens:**
1. AI clones the component using `figma_clone_node`
2. Modifies each clone using node manipulation tools
3. Renames using `figma_rename_node`
4. Takes a screenshot to show all variations

---

### Scenario 17: Variable Mode Management

**Your situation:** You need to add a dark mode to your design system variables.

**What to say:**

```
"Add a 'Dark' mode to my colors collection and set up the dark mode values:
- piccolo: #60A5FA (lighter blue)
- beerus: #A78BFA (lighter purple)
- background: #1F2937 (dark gray)
- text: #F9FAFB (light gray)"
```

**What happens:**
1. AI finds the colors collection
2. Adds a new mode using `figma_add_mode`
3. Updates each variable with dark mode values using `figma_update_variable`
4. Confirms the changes

**Follow-up prompts:**
- "Show me all variables with their light and dark values"
- "Create a preview frame showing both modes"

---

### Scenario 18: Batch Component Creation

**Your situation:** You need to create a set of icon buttons with consistent styling.

**What to say:**

```
"Create icon button components for these actions:
- Edit (pencil icon)
- Delete (trash icon)
- Copy (duplicate icon)
- Share (share icon)

Each should have 3 sizes (24px, 32px, 40px) and use the same variable bindings as my regular buttons."
```

**What happens:**
1. AI creates each icon button variant
2. Applies consistent styling and variable bindings
3. Combines into a component set
4. Organizes with `figma_arrange_component_set`
5. Takes a final screenshot

---

### Scenario 19: Interactive Iteration Workflow

**Your situation:** You're creating a component and want to refine it based on visual feedback.

**What to say:**

```
"Create a navigation bar component with a logo, menu items, and a CTA button. After each step, show me a screenshot so I can give feedback."
```

**What happens:**
1. AI creates initial navigation structure → takes screenshot
2. You provide feedback ("make the menu items larger")
3. AI modifies → takes screenshot
4. Continue iterating until you're satisfied

This workflow leverages the screenshot feedback loop for precise design control.

---

## 🔍 Visual Debugging Workflows

### Scenario 20: Document Plugin State

**Your situation:** You want to show someone what your plugin looks like at a specific point.

**What to say:**

```
"Navigate to my plugin, take a full-page screenshot, and save it as 'plugin-error-state'"
```

**What happens:**
1. AI takes full-page screenshot
2. Saves with your custom filename
3. You can share the visual state with your team

---

### Scenario 21: Monitor Visual Changes

**Your situation:** Testing if plugin UI updates correctly.

**What to say:**

```
"Take a screenshot, then I'll make a change, then take another screenshot"
```

**What happens:**
1. AI takes "before" screenshot
2. You make your changes
3. AI takes "after" screenshot
4. You can compare the two states

---

## 🚀 Advanced Workflows

### Scenario 22: Full Design System Export

**Your situation:** Migrating from Figma to code.

**What to say:**

```
"Extract everything from my design system:
1. Get all variables and export as CSS
2. Get all text styles and export as Tailwind
3. Get all color styles as Sass variables
4. List all components"
```

**What happens:**
1. AI systematically extracts all design system data
2. Provides multiple export formats
3. Organizes everything for your codebase

---

### Scenario 23: Plugin Development Sprint

**Your situation:** Rapid plugin development with continuous debugging.

**Workflow:**

```
1. "Watch console for 5 minutes while I develop"
   → AI monitors in background

2. "Show me any errors from the last 2 minutes"
   → AI filters recent error logs

3. "Take a screenshot of current state"
   → Visual checkpoint

4. "Reload the plugin and clear console"
   → Fresh start

5. Repeat...
```

---

### Scenario 24: Design Token Migration

**Your situation:** Moving from Figma Styles to Variables.

**What to say:**

```
"Compare my old styles with new variables. Show me what changed and generate migration scripts"
```

**What happens:**
1. AI gets both styles and variables
2. Maps old → new
3. Identifies breaking changes
4. Suggests migration approach

---

## 💡 Tips for Effective Prompts

### ✅ Good Prompts

- **Be specific:** "Get the primary button component from https://figma.com/design/abc123?node-id=1:2"
- **Include URL:** Always provide your Figma file URL
- **State intent:** "...and help me implement it in React" (tells AI what you'll do with the data)
- **Request format:** "export as CSS" vs "export as Tailwind"

### ❌ Avoid Vague Prompts

- ❌ "Get my design system" (which file?)
- ❌ "Help with my plugin" (what specifically?)
- ❌ "Show me components" (which ones? what data?)

### 🎯 Pro Tips

1. **Chain operations:** "Navigate to X, watch console for 30s, then screenshot"
2. **Use filters:** "Show me only error logs from the last minute"
3. **Be specific about formats:** "Export as Tailwind v4 syntax"
4. **Request enrichment explicitly:** "Get variables with CSS exports and usage information"

---

## 🔄 Integration with Other Tools

### With Figma Official Dev Mode MCP

**Workflow:**
1. Use Figma Dev Mode MCP to generate component code
2. Use Figma Console MCP to get design token values
3. Replace hardcoded values with tokens
4. Use Console MCP to debug when integrated

**Example:**
```
// Step 1: Dev Mode MCP generates
<Button className="bg-[#4375ff]">Click me</Button>

// Step 2: Console MCP provides token
--color-primary: #4375FF

// Step 3: You refactor
<Button className="bg-primary">Click me</Button>
```

---

## 📚 More Examples

See also:
- [Tool Documentation](TOOLS.md) - Complete API reference for all 40+ tools
- [Architecture Overview](ARCHITECTURE.md) - Understanding deployment modes
- [Example Prompts](../README.md#example-prompts) - Quick prompt examples
- [Troubleshooting](TROUBLESHOOTING.md) - Solutions to common issues
