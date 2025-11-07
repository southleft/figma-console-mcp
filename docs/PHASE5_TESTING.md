# Phase 5 Testing Guide

## Current Status (After Phase 5.2 Task 2.1)

### ✅ What's Implemented
- Enrichment infrastructure (types, resolvers, relationship mapper)
- Enhanced `figma_get_styles()` tool with new parameters
- Code compiles and type-checks

### ⚠️ What's NOT Working Yet
- **Actual enrichment is not functional** - returns empty/placeholder data
- Why: `EnrichmentService.getFileDataForEnrichment()` needs to be wired up to fetch real Figma data via API

## Testing the New Parameters (Partial Test)

Even though enrichment isn't fully working, you can verify the **new parameters are accepted**:

### Test 1: Verify New Parameters

In Claude Desktop, try this:

```
Navigate to the Altitude Design System file and get styles with enrichment enabled.

Use: figma_get_styles with enrich=true
```

**Expected behavior:**
- ✅ Tool accepts `enrich` parameter
- ✅ Returns response with `enriched: true` field
- ❌ Enriched data will be mostly empty (because API wiring is incomplete)

**Response will look like:**
```json
{
  "fileKey": "...",
  "styles": [
    {
      "name": "color/primary",
      "node_id": "123:456",
      // No enriched fields yet - need to wire up API
    }
  ],
  "totalStyles": 10,
  "enriched": true  // ← This confirms parameter was accepted
}
```

### Test 2: Verify Export Format Parameter

```
Get styles with CSS and Tailwind export formats.

Use: figma_get_styles with enrich=true and export_formats=["css", "tailwind"]
```

**Expected:**
- ✅ Parameters accepted
- ❌ No actual export formats yet (need API wiring)

## What Needs to Happen Next

To make enrichment **actually work**, we need to:

1. **Wire up `getFileDataForEnrichment()`** to call Figma API
   - Get full file data (with variables, components, etc.)
   - Parse and store in cache

2. **Test with real Figma data**
   - Use Altitude Design System file
   - Verify variable resolution works
   - Verify relationship tracking works

## Recommended Next Steps

### Option A: Continue Building (Recommended)
Continue with Phase 5.2 tasks to complete the implementation:
- Enhance remaining tools (variables, component, file_data)
- Wire up API calls in EnrichmentService
- **Then test everything together**

### Option B: Test Partial Implementation
We can:
1. Quickly wire up the API calls in `getFileDataForEnrichment()`
2. Test `figma_get_styles()` with real enrichment
3. Then continue with remaining tools

**My recommendation: Option A** - finish the implementation first, then test everything at once. This is more efficient than testing piece by piece.

## Full Test Plan (For After Complete Implementation)

Once API wiring is complete, you can test:

### Test 1: Style Enrichment
```javascript
figma_get_styles({
  fileUrl: "https://www.figma.com/design/LfcfAkdZjP7indUFcLWSE4/Altitude-Design-System",
  enrich: true,
  include_usage: true,
  export_formats: ["css", "tailwind", "typescript"]
})
```

**Expected:**
```json
{
  "styles": [
    {
      "name": "color/background/primary-default",
      "resolved_value": "#4375FF",
      "variable_reference": {
        "id": "VariableID:abc123",
        "name": "color/background/primary-default",
        "collection": "Altitude Design System"
      },
      "used_in_components": [
        {"id": "1791:11519", "name": "Button", "type": "COMPONENT"}
      ],
      "usage_count": 42,
      "export_formats": {
        "css": "var(--color-background-primary-default)",
        "tailwind": "bg-primary",
        "typescript": "tokens.color.background.primaryDefault"
      }
    }
  ]
}
```

### Test 2: Variable Enrichment
```javascript
figma_get_variables({
  enrich: true,
  include_dependencies: true
})
```

**Expected:**
- Resolved values per mode
- Dependency chains (aliases)
- Usage in styles and components

### Test 3: Component Token Coverage
```javascript
figma_get_component({
  nodeId: "1791:11519",  // Dialog component
  enrich: true
})
```

**Expected:**
- Styles used with resolved values
- Token coverage percentage
- Hardcoded values detected

## Bottom Line

**Right now**: You can verify the new parameters are accepted, but enrichment won't return real data yet.

**To get working enrichment**: We need to complete the API wiring in `EnrichmentService.getFileDataForEnrichment()`.

**Recommendation**: Continue implementation → then test everything at once.

---

Want me to:
1. ✅ **Continue building** (finish Phase 5.2, wire up API) - ~30 min
2. ⏸️ **Pause and wire up API now** for immediate testing - ~10 min
3. 📝 **Create a mock test** that simulates enrichment without real API
