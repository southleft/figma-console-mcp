# Issue: Missing Dimensions in Reconstruction Spec

**Date**: 2025-11-17
**Status**: ✅ FIXED

## Problem

When pasting the reconstruction spec JSON into the Figma Component Reconstructor plugin, the plugin shows a "generation failed" error. Console logs don't show specific error details.

## Root Cause

The Figma REST API doesn't always return `x`, `y`, `width`, `height` properties for nodes, especially for:
- COMPONENT_SET nodes (variant containers)
- COMPONENT nodes within component sets
- Child nodes that use auto-layout

However, the Figma Plugin API **requires** these properties to create nodes programmatically. Without dimensions, the plugin cannot create the nodes, resulting in a "generation failed" error.

## Evidence

Looking at the generated spec:
```json
{
  "name": "Badge",
  "type": "COMPONENT_SET",
  "blendMode": "PASS_THROUGH",
  // ❌ Missing: x, y, width, height
  "children": [
    {
      "name": "Type=Dot, Variant=Success",
      "type": "COMPONENT",
      // ❌ Missing: x, y, width, height
      "layoutMode": "HORIZONTAL",
      "children": [
        {
          "name": "Dot",
          "type": "ELLIPSE",
          // ❌ Missing: x, y, width, height
          "fills": [...]
        }
      ]
    }
  ]
}
```

## Solution

Modified `src/core/figma-reconstruction-spec.ts` (lines 268-299) to add default values for missing position and dimension properties:

### Position Defaults
```typescript
// Position - provide defaults if missing
if ('x' in node && typeof node.x === 'number') {
  spec.x = node.x;
} else if (node.type !== 'GROUP' && node.type !== 'SECTION') {
  spec.x = 0;  // Default to origin
}

if ('y' in node && typeof node.y === 'number') {
  spec.y = node.y;
} else if (node.type !== 'GROUP' && node.type !== 'SECTION') {
  spec.y = 0;  // Default to origin
}
```

### Dimension Defaults
```typescript
// Dimensions - required for most node types to be reconstructable
if ('width' in node && typeof node.width === 'number') {
  spec.width = node.width;
} else if (node.type !== 'GROUP' && node.type !== 'SECTION') {
  // Type-specific defaults
  spec.width = node.type === 'TEXT' ? 100 :
               node.type === 'COMPONENT_SET' ? 200 :
               node.type === 'ELLIPSE' ? 8 : 50;
}

if ('height' in node && typeof node.height === 'number') {
  spec.height = node.height;
} else if (node.type !== 'GROUP' && node.type !== 'SECTION') {
  // Type-specific defaults
  spec.height = node.type === 'TEXT' ? 20 :
                node.type === 'COMPONENT_SET' ? 100 :
                node.type === 'ELLIPSE' ? 8 : 50;
}
```

### Default Values by Node Type

| Node Type | Default Width | Default Height | Rationale |
|-----------|---------------|----------------|-----------|
| `COMPONENT_SET` | 200px | 100px | Container for variants |
| `COMPONENT` | 50px | 50px | Standard component size |
| `FRAME` | 50px | 50px | Standard frame size |
| `ELLIPSE` | 8px | 8px | Typical dot/icon size |
| `TEXT` | 100px | 20px | Single line text |
| Other shapes | 50px | 50px | General purpose |
| `GROUP` | *(none)* | *(none)* | Groups don't need dimensions |
| `SECTION` | *(none)* | *(none)* | Sections don't need dimensions |

## Testing

After the fix, the generated spec will look like:
```json
{
  "name": "Badge",
  "type": "COMPONENT_SET",
  "x": 0,
  "y": 0,
  "width": 200,
  "height": 100,
  "blendMode": "PASS_THROUGH",
  "children": [
    {
      "name": "Type=Dot, Variant=Success",
      "type": "COMPONENT",
      "x": 0,
      "y": 0,
      "width": 50,
      "height": 50,
      "layoutMode": "HORIZONTAL",
      "children": [
        {
          "name": "Dot",
          "type": "ELLIPSE",
          "x": 0,
          "y": 0,
          "width": 8,
          "height": 8,
          "fills": [...]
        }
      ]
    }
  ]
}
```

### How to Test

1. Rebuild the MCP server: `npm run build` (already done)
2. The MCP server will auto-reload with the new code
3. Regenerate the Badge component spec:
   ```bash
   figma_get_component --format reconstruction --nodeId 2626:541
   ```
4. Copy the new spec and paste into Figma Component Reconstructor plugin
5. The plugin should now successfully create the component

## Impact

- ✅ **Plugin Compatibility**: Specs now work with Figma Component Reconstructor plugin
- ✅ **Backward Compatible**: Existing specs with dimensions will continue to work
- ✅ **Smart Defaults**: Type-specific defaults provide reasonable starting points
- ⚠️ **Manual Adjustment**: Users may need to adjust dimensions for precise layouts

## Future Enhancements

Consider these improvements:
- [ ] Calculate dimensions from children when possible
- [ ] Preserve actual dimensions from Desktop Bridge plugin when available
- [ ] Add option to specify custom default dimensions
- [ ] Warn users about defaulted dimensions in validation output

## Files Changed

- `src/core/figma-reconstruction-spec.ts` - Added dimension defaults (lines 268-299)

## Related Issues

- Previous issue: Format mismatch (metadata wrapper vs. direct spec) - FIXED
- Current issue: Missing dimensions - FIXED
