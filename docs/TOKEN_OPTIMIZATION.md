# Token Optimization Guide

This document explains the token optimization features in Figma Console MCP to help you work efficiently with AI assistants.

## Problem

Some MCP tools were consuming excessive tokens:
- **figma_take_screenshot**: ~575k tokens (base64 in JSON)
- **figma_get_styles**: ~11k tokens (full style objects)
- **figma_get_variables**: ~11.5k tokens (full variable metadata)

## Solutions Implemented

### 1. Screenshot Token Elimination (~575k → ~100 tokens)

**Tool:** `figma_take_screenshot`

**Change:** Screenshots now use Figma's REST API `getImages()` endpoint instead of Puppeteer browser screenshots.

**Impact:** Returns image URLs instead of base64 data - **~99.98% token reduction**.

```typescript
// Before: 575k tokens (base64-encoded screenshot from Puppeteer)
{
  "base64Data": "iVBORw0KGgoAAAANS..." // massive string
}

// After: ~100 tokens (Figma API image URL)
{
  "imageUrl": "https://figma-alpha-api.s3.us-west-2.amazonaws.com/...",
  "fileKey": "abc123",
  "nodeId": "123:456",
  "format": "png",
  "scale": 2,
  "expiresIn": "30 days"
}
```

**Benefits:**
- Zero base64 encoding overhead
- Faster response times (no browser rendering)
- Image URLs valid for 30 days
- More reliable than browser screenshots
- Matches official Figma MCP approach

### 2. Styles Verbosity Control (~11k → ~1.5k tokens)

**Tool:** `figma_get_styles`

**New Parameter:** `verbosity` (default: `"standard"`)

**Options:**
- `"summary"`: Names/types only (~85% reduction) - Use for browsing/listing
- `"standard"`: Essential properties (~40% reduction) - **Default**, balanced
- `"full"`: Everything (original behavior) - Use only when needed

**Example:**
```typescript
// Efficient: Get style names to see what's available
figma_get_styles({ verbosity: "summary" })
// Returns: { key, name, style_type } only

// Balanced: Get styles for implementation (default)
figma_get_styles({ verbosity: "standard" })
// Returns: key, name, description, style_type, remote

// Complete: Get all metadata
figma_get_styles({ verbosity: "full" })
// Returns: Everything
```

### 3. Variables Verbosity Control (~11.5k → ~2k tokens)

**Tool:** `figma_get_variables`

**New Parameter:** `verbosity` (default: `"standard"`)

**Options:**
- `"summary"`: Names/values only (~80% reduction) - Use for browsing
- `"standard"`: Essential properties (~45% reduction) - **Default**, good for most use cases
- `"full"`: Everything (original behavior) - Use for detailed analysis

**Example:**
```typescript
// Efficient: See what variables exist
figma_get_variables({ verbosity: "summary" })
// Returns: { id, name, resolvedType, valuesByMode }

// Balanced: Get variables for implementation (default)
figma_get_variables({ verbosity: "standard" })
// Returns: id, name, resolvedType, valuesByMode, description, variableCollectionId, scopes

// Complete: Get all metadata
figma_get_variables({ verbosity: "full" })
// Returns: Everything
```

## Best Practices

### Progressive Disclosure Pattern

Use the verbosity levels strategically:

1. **Discovery** (`summary`): Browse and understand what's available
2. **Implementation** (`standard`): Get what you need for coding (default)
3. **Deep Analysis** (`full`): Only when you need complete metadata

**Example Workflow:**

```typescript
// Step 1: See what styles exist (minimal tokens)
const styles = await figma_get_styles({
  fileUrl: "...",
  verbosity: "summary"
});
// Returns 50 styles with just names → ~500 tokens

// Step 2: Get specific styles you need with standard detail
const buttonStyles = await figma_get_styles({
  fileUrl: "...",
  verbosity: "standard"  // default
});
// Returns essential properties → ~3k tokens

// Step 3: Only if you need complete data
const fullStyleData = await figma_get_styles({
  fileUrl: "...",
  verbosity: "full"
});
// Returns everything → ~11k tokens
```

### Screenshot Usage

Screenshots now use minimal tokens (just the URL response):

```typescript
// Before: Avoid screenshots due to 575k token cost
// After: Use screenshots freely - returns URL instead of base64

await figma_take_screenshot({
  nodeId: "123:456",  // Optional, extracts from URL if not provided
  format: "png",
  scale: 2
});
// Returns image URL, ~100 tokens consumed
// URL valid for 30 days
```

## Token Savings Summary

| Tool | Before | After (default) | Savings |
|------|--------|-----------------|---------|
| `figma_take_screenshot` | ~575k | ~100 | ~99.98% |
| `figma_get_styles` | ~11k | ~6.5k | ~40% |
| `figma_get_variables` | ~11.5k | ~6.3k | ~45% |

## Migration Guide

### No Breaking Changes

All changes are **backward compatible**:
- Default `verbosity: "standard"` provides good detail reduction
- Existing code works without changes
- Screenshots automatically use new Figma REST API (returns URLs instead of base64)

### Recommended Updates

If you're hitting token limits, update your calls:

```typescript
// Old (still works, but uses more tokens)
figma_get_styles({ fileUrl })

// New (recommended, uses ~40% fewer tokens)
figma_get_styles({
  fileUrl,
  verbosity: "standard"  // explicit, but this is default
})

// Minimal (for browsing, uses ~85% fewer tokens)
figma_get_styles({
  fileUrl,
  verbosity: "summary"
})
```

## When to Use Each Verbosity Level

### Use `"summary"` when:
- Browsing available styles/variables
- Generating lists or tables
- Checking if something exists
- You only need names and IDs

### Use `"standard"` (default) when:
- Implementing components
- Writing code from design tokens
- Most development tasks
- You need balanced detail

### Use `"full"` when:
- Debugging complex issues
- Need complete metadata
- Analyzing design system structure
- Exporting/migrating data

## Technical Details

### Image Format

Screenshots use Figma REST API's `getImages()` endpoint:

```typescript
// API call: GET /v1/images/:file_key?ids=:node_id&format=png&scale=2
// Response format:
{
  content: [
    {
      type: "text",
      text: JSON.stringify({
        fileKey: "abc123",
        nodeId: "123:456",
        imageUrl: "https://figma-alpha-api.s3.us-west-2.amazonaws.com/...",
        scale: 2,
        format: "png",
        expiresIn: "30 days"
      })
    }
  ]
}
```

**Implementation Details:**
- Uses Figma REST API instead of Puppeteer browser screenshots
- Extracts node ID from browser URL if not provided (converts `node-id=123-456` to `123:456`)
- Supports png, jpg, svg, pdf formats
- Scale range: 0.01-4 (default: 2 for high quality)
- Image URLs are temporary (valid for 30 days)
- Removed all Puppeteer screenshot code from BrowserManager classes

### Filtering Strategy

Verbosity filtering removes properties by importance:

**Summary:** Absolute minimum (IDs, names, types)
**Standard:** Essential for development (+ descriptions, relationships)
**Full:** Everything from API (no filtering)

## Questions?

See the tool documentation for complete parameter details:
- `figma_take_screenshot` in `src/index.ts:187`
- `figma_get_styles` in `src/core/figma-tools.ts:752`
- `figma_get_variables` in `src/core/figma-tools.ts:247`
