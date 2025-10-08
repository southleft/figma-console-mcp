# Use Cases & Scenarios

This guide shows real-world scenarios for using Figma Console MCP in your workflow.

## 🐛 Plugin Development & Debugging

### Scenario 1: Debug Console Errors in Plugin

**Your situation:** You're developing a Figma plugin and seeing errors in the Figma console.

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

### Scenario 2: Monitor Plugin Performance

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

### Scenario 3: Debug Plugin with Screenshots

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

### Scenario 4: Extract Design Tokens

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

### Scenario 5: Generate Tailwind Config

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

### Scenario 6: Audit Design System Usage

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

### Scenario 7: Implement Component from Figma

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

### Scenario 8: Get Component Specifications

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

### Scenario 9: Compare Multiple Component Variants

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

## 🔍 Visual Debugging Workflows

### Scenario 10: Document Plugin State

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

### Scenario 11: Monitor Visual Changes

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

### Scenario 12: Full Design System Export

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

### Scenario 13: Plugin Development Sprint

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

### Scenario 14: Design Token Migration

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
- [Tool Documentation](TOOLS.md) - Complete API reference for all 14 tools
- [Example Prompts](../README.md#example-prompts) - Quick prompt examples
- [Troubleshooting](TROUBLESHOOTING.md) - Solutions to common issues
