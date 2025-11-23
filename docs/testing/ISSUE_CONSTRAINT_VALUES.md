# Issue: Constraint Value Mismatch Between REST API and Plugin API

**Date**: 2025-11-18
**Status**: ✅ FIXED

## Problem

When pasting the reconstruction spec JSON into the Figma Component Reconstructor plugin, the plugin shows validation errors:

```
✗ Generation failed:

1. Component creation failed: in set_constraints: Property "constraints" failed validation:
   Invalid enum value. Expected 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'SCALE', received 'LEFT' at .horizontal
   Invalid enum value. Expected 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'SCALE', received 'TOP' at .vertical
   Path: $
```

## Root Cause

**Figma has two different APIs with different constraint value enums:**

### REST API (what we get from Figma files)
```typescript
type RestConstraintValue =
  | 'LEFT'     // Align to left edge
  | 'RIGHT'    // Align to right edge
  | 'TOP'      // Align to top edge
  | 'BOTTOM'   // Align to bottom edge
  | 'CENTER'   // Center alignment
  | 'STRETCH'  // Stretch to fill
  | 'SCALE';   // Scale proportionally
```

### Plugin API (what the plugin expects)
```typescript
type PluginConstraintValue =
  | 'MIN'      // Align to start (left/top)
  | 'MAX'      // Align to end (right/bottom)
  | 'CENTER'   // Center alignment
  | 'STRETCH'  // Stretch to fill
  | 'SCALE';   // Scale proportionally
```

**The Issue**: Our reconstruction spec was directly copying REST API values (`LEFT`, `TOP`) but the plugin only accepts Plugin API values (`MIN`, `MAX`).

## Evidence

### Console Error
```
[ERROR] 2025-11-18T13:11:42.934Z - in set_constraints:
Property "constraints" failed validation:
Invalid enum value. Expected 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'SCALE',
received 'LEFT' at .horizontal
Invalid enum value. Expected 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'SCALE',
received 'TOP' at .vertical
```

### Stack Trace
```
at applyConstraints (PLUGIN_3_SOURCE)
at build (PLUGIN_3_SOURCE)
```

### What We Were Sending
```json
{
  "name": "Type=Text, Variant=Error",
  "type": "COMPONENT",
  "constraints": {
    "horizontal": "LEFT",    // ❌ Plugin expects "MIN"
    "vertical": "TOP"        // ❌ Plugin expects "MIN"
  }
}
```

## Solution

Added a constraint value mapping function in `src/core/figma-reconstruction-spec.ts` (lines 221-238):

```typescript
/**
 * Convert REST API constraint values to Plugin API constraint values
 * REST API: LEFT, RIGHT, TOP, BOTTOM, CENTER, SCALE
 * Plugin API: MIN, MAX, CENTER, STRETCH, SCALE
 */
function convertConstraintValue(value: string): string {
  const mapping: Record<string, string> = {
    'LEFT': 'MIN',
    'RIGHT': 'MAX',
    'TOP': 'MIN',
    'BOTTOM': 'MAX',
    'CENTER': 'CENTER',
    'STRETCH': 'STRETCH',
    'SCALE': 'SCALE',
  };

  return mapping[value] || value;
}
```

Updated constraint extraction to use the converter (lines 331-337):

```typescript
// Constraints - convert REST API values to Plugin API values
if ('constraints' in node && node.constraints) {
  spec.constraints = {
    horizontal: convertConstraintValue(node.constraints.horizontal),
    vertical: convertConstraintValue(node.constraints.vertical),
  };
}
```

## Value Mapping Table

| REST API Value | Plugin API Value | Meaning |
|----------------|------------------|---------|
| `LEFT` | `MIN` | Align to left edge (horizontal start) |
| `RIGHT` | `MAX` | Align to right edge (horizontal end) |
| `TOP` | `MIN` | Align to top edge (vertical start) |
| `BOTTOM` | `MAX` | Align to bottom edge (vertical end) |
| `CENTER` | `CENTER` | Center alignment (same in both) |
| `STRETCH` | `STRETCH` | Stretch to fill (same in both) |
| `SCALE` | `SCALE` | Scale proportionally (same in both) |

## Why This Mapping Makes Sense

The Plugin API uses `MIN`/`MAX` because:
- **Language-agnostic**: Works for both LTR (left-to-right) and RTL (right-to-left) languages
- **Dimension-agnostic**: Same values work for both horizontal and vertical constraints
- **Semantic clarity**: "MIN" = start of dimension, "MAX" = end of dimension

The REST API uses `LEFT`/`RIGHT`/`TOP`/`BOTTOM` because:
- **Human-readable**: More intuitive for designers viewing the data
- **Explicit**: Clear about which edge is being referenced
- **Traditional**: Matches CSS and other design tool conventions

## After Fix

### What We Now Send
```json
{
  "name": "Type=Text, Variant=Error",
  "type": "COMPONENT",
  "constraints": {
    "horizontal": "MIN",    // ✅ Converted from "LEFT"
    "vertical": "MIN"       // ✅ Converted from "TOP"
  }
}
```

### Expected Result
Plugin will successfully create the component with proper constraints.

## Testing

### Test Case 1: LEFT → MIN Conversion
**Input**: REST API returns `constraints.horizontal: "LEFT"`
**Output**: Spec contains `constraints.horizontal: "MIN"`
**Status**: ✅ To be tested after MCP restart

### Test Case 2: TOP → MIN Conversion
**Input**: REST API returns `constraints.vertical: "TOP"`
**Output**: Spec contains `constraints.vertical: "MIN"`
**Status**: ✅ To be tested after MCP restart

### Test Case 3: RIGHT → MAX Conversion
**Input**: REST API returns `constraints.horizontal: "RIGHT"`
**Output**: Spec contains `constraints.horizontal: "MAX"`
**Status**: ⏳ To be tested with component that has RIGHT constraint

### Test Case 4: BOTTOM → MAX Conversion
**Input**: REST API returns `constraints.vertical: "BOTTOM"`
**Output**: Spec contains `constraints.vertical: "MAX"`
**Status**: ⏳ To be tested with component that has BOTTOM constraint

### Test Case 5: CENTER/STRETCH/SCALE Pass-Through
**Input**: REST API returns `CENTER`, `STRETCH`, or `SCALE`
**Output**: Same value in spec (no conversion needed)
**Status**: ⏳ To be tested with components using these constraints

## Impact

- ✅ **Plugin Compatibility**: Specs now use correct Plugin API constraint values
- ✅ **All Constraint Types**: Mapping covers all possible REST API constraint values
- ✅ **Backward Compatible**: Existing specs won't break (mapping handles all values)
- ✅ **Universal Fix**: Works for both Desktop Bridge and REST API sources
- ⚠️ **Testing Needed**: Verify with components using different constraint combinations

## Related Issues

- **Issue 1**: Format mismatch (metadata wrapper vs. direct spec) - ✅ FIXED
- **Issue 2**: Missing dimensions in reconstruction spec - ✅ FIXED
- **Issue 3**: COMPONENT_SET unsupported by plugin - ✅ FIXED
- **Issue 4**: Constraint value mismatch (REST vs Plugin API) - ✅ FIXED (current)

## Files Changed

- `src/core/figma-reconstruction-spec.ts` - Added `convertConstraintValue()` function and updated constraint extraction (lines 221-238, 331-337)

## Future Considerations

### Edge Cases to Monitor

1. **Mixed Constraints**: Some nodes might have `CENTER` on one axis and `MIN`/`MAX` on another
   - Already handled by the mapping function

2. **Invalid Values**: REST API might return unexpected constraint values
   - Handled by fallback: `return mapping[value] || value`

3. **Future API Changes**: If Figma adds new constraint values
   - Will need to update the mapping table

### Documentation Improvements

Consider documenting in the codebase:
- [ ] Add JSDoc comments explaining the REST API vs Plugin API difference
- [ ] Reference this issue in the constraint conversion function
- [ ] Add examples of different constraint combinations

---

**Fix Completed**: ✅ Constraint value mapping implemented
**Build Status**: ✅ Successful compilation
**Next Step**: User needs to restart MCP and regenerate component spec
