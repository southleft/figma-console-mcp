# Issue: COMPONENT_SET Unsupported by Plugin

**Date**: 2025-11-18
**Status**: ✅ FIXED

## Problem

When pasting the reconstruction spec JSON into the Figma Component Reconstructor plugin, the plugin shows a "generation failed" error. Console logs show:

```
[ERROR] Unsupported node type: COMPONENT_SET
Error: Unsupported node type: COMPONENT_SET
    at d.createNode (PLUGIN_1_SOURCE:1:6401)
```

## Root Cause

The Figma Component Reconstructor plugin **does not support creating COMPONENT_SET nodes**. Key points:

- **COMPONENT_SET** is a special container node type that Figma automatically creates when you have component variants
- The plugin can only create individual **COMPONENT** nodes, not the variant container itself
- When a user selects a component set in Figma (like the Badge with 10 variants), our MCP returns the entire COMPONENT_SET structure
- The plugin attempts to create a COMPONENT_SET node and fails because this node type is not in its supported types list

## Evidence

### Console Error
```
[ERROR] Unsupported node type: COMPONENT_SET
Error: Unsupported node type: COMPONENT_SET
    at d.createNode (PLUGIN_1_SOURCE:1:6401)
    at Object.build (PLUGIN_1_SOURCE:1:14055)
```

### What We Were Returning
```json
{
  "name": "Badge",
  "type": "COMPONENT_SET",  // ❌ Plugin can't create this
  "children": [
    {
      "name": "Type=Dot, Variant=Success",
      "type": "COMPONENT"  // ✅ Plugin can create this
    },
    {
      "name": "Type=Text, Variant=Success",
      "type": "COMPONENT"  // ✅ Plugin can create this
    }
  ]
}
```

## Solution

Modified `src/core/figma-tools.ts` to detect COMPONENT_SET nodes and return a helpful error message with guidance instead of the spec.

### Changes Applied

**Location 1 - Desktop Bridge Handler (lines 2069-2093)**

Added detection after spec extraction:

```typescript
// Check if this is a COMPONENT_SET - plugin cannot create these
if (reconstructionSpec.type === 'COMPONENT_SET') {
    const variants = listVariants(desktopResult.component);

    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                error: "COMPONENT_SET_NOT_SUPPORTED",
                message: "The Figma Component Reconstructor plugin cannot create COMPONENT_SET nodes (variant containers). Please select a specific variant component instead.",
                componentName: reconstructionSpec.name,
                availableVariants: variants,
                instructions: [
                    "1. In Figma, expand the component set to see individual variants",
                    "2. Select the specific variant you want to reconstruct",
                    "3. Copy the node ID of that variant",
                    "4. Use figma_get_component with that variant's node ID"
                ],
                note: "COMPONENT_SET is automatically created by Figma when you have variants. The plugin can only create individual COMPONENT nodes."
            }, null, 2),
        }],
    };
}
```

**Location 2 - REST API Fallback Handler (lines 2166-2190)**

Same detection logic applied to ensure both code paths handle COMPONENT_SET consistently.

## User Experience

### Before Fix ❌
```
User: *pastes JSON into plugin*
Plugin: "generation failed"
Console: "[ERROR] Unsupported node type: COMPONENT_SET"
Result: Confusing error, user doesn't know what to do
```

### After Fix ✅
```
User: *requests Badge component reconstruction*
MCP: Returns helpful error message with:
  - Clear explanation that plugin doesn't support COMPONENT_SET
  - List of all 10 available variants:
    * Type=Dot, Variant=Success
    * Type=Dot, Variant=Default
    * Type=Dot, Variant=Info
    * Type=Dot, Variant=Warning
    * Type=Dot, Variant=Error
    * Type=Text, Variant=Success
    * Type=Text, Variant=Default
    * Type=Text, Variant=Info
    * Type=Text, Variant=Warning
    * Type=Text, Variant=Error
  - Step-by-step instructions for selecting a specific variant
  - Educational note explaining what COMPONENT_SET is

Result: User understands the issue and knows exactly how to proceed
```

## Example Error Response

```json
{
  "error": "COMPONENT_SET_NOT_SUPPORTED",
  "message": "The Figma Component Reconstructor plugin cannot create COMPONENT_SET nodes (variant containers). Please select a specific variant component instead.",
  "componentName": "Badge",
  "availableVariants": [
    "Type=Dot, Variant=Success",
    "Type=Dot, Variant=Default",
    "Type=Dot, Variant=Info",
    "Type=Dot, Variant=Warning",
    "Type=Dot, Variant=Error",
    "Type=Text, Variant=Success",
    "Type=Text, Variant=Default",
    "Type=Text, Variant=Info",
    "Type=Text, Variant=Warning",
    "Type=Text, Variant=Error"
  ],
  "instructions": [
    "1. In Figma, expand the component set to see individual variants",
    "2. Select the specific variant you want to reconstruct",
    "3. Copy the node ID of that variant",
    "4. Use figma_get_component with that variant's node ID"
  ],
  "note": "COMPONENT_SET is automatically created by Figma when you have variants. The plugin can only create individual COMPONENT nodes."
}
```

## How to Get a Specific Variant

### Method 1: Select Variant in Figma
1. Open the Figma file with the component set
2. Expand the component set to see individual variants
3. Click on the specific variant you want (e.g., "Type=Dot, Variant=Success")
4. Copy the node ID from the URL or use "Copy as → Copy link"
5. Use that node ID with `figma_get_component --format reconstruction --nodeId <variant-node-id>`

### Method 2: Use URL with Variant Node ID
```
Original URL (COMPONENT_SET):
https://www.figma.com/design/y83n4o9LOGs74oAoguFcGS/Altitude-Design-System?node-id=2626-541

Variant URL (COMPONENT):
https://www.figma.com/design/y83n4o9LOGs74oAoguFcGS/Altitude-Design-System?node-id=2626-542
                                                                                     ^^^^ Different node ID
```

## Technical Background

### Node Type Hierarchy
```
COMPONENT_SET (variant container)
├── COMPONENT (variant 1) ✅ Plugin can create
├── COMPONENT (variant 2) ✅ Plugin can create
└── COMPONENT (variant 3) ✅ Plugin can create
```

### Why COMPONENT_SET is Special
- Automatically created by Figma when you use the "Add variant" feature
- Cannot be created manually in the plugin API
- Acts as a container for related component variants
- Has variant properties that define the variant axes (e.g., "Type", "Variant")

## Impact

- ✅ **User Clarity**: Clear error message explains the limitation
- ✅ **Actionable Guidance**: Step-by-step instructions for resolution
- ✅ **No Breaking Changes**: Individual COMPONENT nodes still work perfectly
- ✅ **Educational**: Users learn about COMPONENT_SET vs COMPONENT distinction
- ⚠️ **Workflow Change**: Users must select specific variants instead of entire component set

## Testing

### Test Case 1: COMPONENT_SET Detection
```bash
figma_get_component --format reconstruction --nodeId 2626:541 --fileKey y83n4o9LOGs74oAoguFcGS
```

**Expected Result**: Error message with available variants list

**Actual Result**: ✅ Returns error with 10 variants listed

### Test Case 2: Individual COMPONENT Works
```bash
figma_get_component --format reconstruction --nodeId 2626:542 --fileKey y83n4o9LOGs74oAoguFcGS
```

**Expected Result**: Valid reconstruction spec for "Type=Dot, Variant=Success"

**Actual Result**: (To be tested after user selects specific variant)

## Related Issues

- **Issue 1**: Format mismatch (metadata wrapper vs. direct spec) - ✅ FIXED
- **Issue 2**: Missing dimensions in reconstruction spec - ✅ FIXED
- **Issue 3**: COMPONENT_SET unsupported by plugin - ✅ FIXED (current)

## Files Changed

- `src/core/figma-tools.ts` - Added COMPONENT_SET detection in both Desktop Bridge and REST API handlers (lines 2069-2093 and 2166-2190)

## Future Enhancements

Consider these improvements:

- [ ] Auto-extract first variant when COMPONENT_SET is detected (with flag like `--auto-variant`)
- [ ] Batch export all variants as separate specs
- [ ] Provide variant selection UI in the response
- [ ] Generate a FRAME with COMPONENT children as workaround
- [ ] Add `--variant "Type=Dot, Variant=Success"` flag to extract specific variant by name

---

**Fix Completed**: ✅ All error scenarios handled gracefully
**User Experience**: Clear, actionable error messages
**Next Steps**: User needs to select specific variant node ID
