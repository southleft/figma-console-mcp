---
title: "Reconstruction Format"
description: "Generate node tree specifications for programmatic component creation with the Figma Component Reconstructor plugin."
---

# Reconstruction Format Guide

The reconstruction format generates node tree construction specifications compatible with the Figma Component Reconstructor plugin, enabling programmatic component creation.

## Overview

### Two Export Formats

**Metadata Format (Default)**
- Comprehensive documentation of component properties
- Ideal for style guides, design systems, and documentation
- Includes variant information, design tokens, and quality metrics

**Reconstruction Format** ⭐ NEW
- Complete node tree specification for programmatic creation
- All properties needed to recreate components in Figma
- Compatible with Figma Component Reconstructor plugin

## Usage

### Basic Usage

```javascript
// Get reconstruction specification
const result = await figma_get_component({
  fileUrl: 'https://figma.com/design/abc123',
  nodeId: '123:456',
  format: 'reconstruction'
});
```

### Output Structure

The reconstruction format returns the node specification directly at the root level (compatible with Figma Component Reconstructor plugin):

```json
{
  "name": "Badge Success Dot",
  "type": "ELLIPSE",
  "width": 8,
  "height": 8,
  "x": 0,
  "y": 0,
  "fills": [{
    "type": "SOLID",
    "color": { "r": 0.21, "g": 0.70, "b": 0.44, "a": 1.0 },
    "opacity": 1,
    "visible": true
  }],
  "strokes": [],
  "effects": [],
  "opacity": 1,
  "blendMode": "NORMAL",
  "children": []
}
```

**Note:** Unlike the metadata format which wraps the response with `fileKey`, `nodeId`, and `source` fields, the reconstruction format returns the raw spec for direct plugin compatibility.

## Supported Node Types

The reconstruction format supports all major Figma node types:

- **Layout Containers**: `FRAME`, `COMPONENT`, `COMPONENT_SET`, `INSTANCE`, `GROUP`, `SECTION`
- **Shapes**: `RECTANGLE`, `ELLIPSE`, `POLYGON`, `STAR`, `VECTOR`, `LINE`
- **Text**: `TEXT` (with font properties)
- **Special**: `BOOLEAN_OPERATION`, `SLICE`

## Properties Extracted

### Common Properties (All Nodes)
- `name` - Node name
- `type` - Node type
- `x`, `y` - Position
- `width`, `height` - Dimensions
- `opacity` - Opacity (0-1)
- `blendMode` - Blend mode
- `visible` - Visibility flag
- `locked` - Lock status
- `description` - Node description
- `constraints` - Layout constraints

### Visual Properties
- `fills` - Fill paints (solid, gradient, image)
- `strokes` - Stroke paints
- `strokeWeight` - Stroke thickness
- `strokeAlign` - Stroke alignment
- `effects` - Shadow and blur effects
- `cornerRadius` - Corner radius
- `rectangleCornerRadii` - Individual corner radii

### Layout Properties (Frames/Components)
- `layoutMode` - Auto-layout mode (`NONE`, `HORIZONTAL`, `VERTICAL`)
- `paddingLeft`, `paddingRight`, `paddingTop`, `paddingBottom` - Padding
- `itemSpacing` - Gap between items
- `primaryAxisAlignItems` - Main axis alignment
- `counterAxisAlignItems` - Cross axis alignment
- `clipsContent` - Clipping flag

### Text Properties
- `characters` - Text content
- `fontSize` - Font size
- `fontName` - Font family and style
- `textAlignHorizontal` - Horizontal alignment
- `textAlignVertical` - Vertical alignment
- `lineHeight` - Line height
- `letterSpacing` - Letter spacing

## Color Format

Colors are in Figma's normalized 0-1 RGB format (NOT 0-255):

```json
{
  "color": {
    "r": 0.21,  // Red:   0.0 to 1.0
    "g": 0.70,  // Green: 0.0 to 1.0
    "b": 0.44,  // Blue:  0.0 to 1.0
    "a": 1.0    // Alpha: 0.0 to 1.0
  }
}
```

## Working with Component Sets

For `COMPONENT_SET` nodes (variants), the response includes available variants:

```json
{
  "spec": {
    "type": "COMPONENT_SET",
    "name": "Button",
    "children": [...]
  },
  "availableVariants": [
    "Type=Primary, Size=Medium",
    "Type=Secondary, Size=Medium",
    "Type=Primary, Size=Large"
  ],
  "note": "This is a COMPONENT_SET with multiple variants..."
}
```

To extract a specific variant, you can filter the children array or use a custom implementation.

## Validation

Reconstruction specs are validated server-side against plugin requirements. Invalid specs will return error messages. The spec itself doesn't include validation fields - it's just the raw node specification.

### Validation Checks
- ✅ Required fields (name, type)
- ✅ Valid node types
- ✅ Dimension constraints (width/height ≥ 0)
- ✅ Opacity range (0-1)
- ✅ Color value range (0-1 for RGB)
- ✅ Recursive validation of children

## Use Cases

### 1. Version Control for Components
Export component specifications to JSON files for version control:

```bash
# Export component spec
figma_get_component --format reconstruction > button-v1.json

# Track changes over time
git add button-v1.json
git commit -m "Update button component"
```

### 2. Component Migration
Migrate components between files or projects:

```javascript
// Export from source file
const sourceSpec = await figma_get_component({
  fileUrl: 'https://figma.com/design/source',
  nodeId: '123:456',
  format: 'reconstruction'
});

// Import to target file using Figma Component Reconstructor plugin
// Use sourceSpec.spec with the plugin
```

### 3. Programmatic Component Generation
Generate components from code or design systems:

```javascript
// Generate button variants programmatically
const variants = ['primary', 'secondary', 'tertiary'];
const sizes = ['small', 'medium', 'large'];

for (const variant of variants) {
  for (const size of sizes) {
    const spec = generateButtonSpec(variant, size);
    // Use spec with Figma Component Reconstructor plugin
  }
}
```

### 4. Design System Synchronization
Keep design systems in sync between tools:

```javascript
// Export design system components
const components = ['Button', 'Input', 'Card', 'Badge'];
const specs = {};

for (const component of components) {
  specs[component] = await figma_get_component({
    nodeId: componentIds[component],
    format: 'reconstruction'
  });
}

// Store or sync with external design system
await designSystem.sync(specs);
```

## Comparison: Metadata vs Reconstruction

| Feature | Metadata Format | Reconstruction Format |
|---------|----------------|----------------------|
| **Purpose** | Documentation, references | Programmatic creation |
| **Enrichment** | ✅ Design tokens, quality metrics | ❌ Not applicable |
| **File Size** | Larger (includes metadata) | Smaller (spec only) |
| **Color Format** | Various formats | Normalized 0-1 RGB |
| **Validation** | ❌ Not validated | ✅ Validated against plugin |
| **Use With** | Style guides, docs | Component Reconstructor plugin |
| **Best For** | Understanding, documenting | Building, migrating |

## Limitations

### Current Limitations
1. **Font Loading**: TEXT nodes may require font availability in target file
2. **Image References**: IMAGE fills reference images by URL (may need re-uploading)
3. **Plugin Data**: Custom plugin data is not included in reconstruction spec
4. **Complex Vectors**: Complex vector paths may lose some detail
5. **Instances**: INSTANCE nodes reference component IDs (must exist in target)

### Best Practices
- ✅ Test reconstruction with simple shapes first (RECTANGLE, ELLIPSE)
- ✅ Verify color values are in 0-1 range
- ✅ Check validation output before using spec
- ✅ Handle COMPONENT_SET children appropriately
- ✅ Ensure fonts are available when reconstructing TEXT nodes
- ✅ Store specs in version control for tracking changes

## Examples

### Simple Shape

```javascript
// Export a simple rectangle
const rect = await figma_get_component({
  nodeId: '1:2',
  format: 'reconstruction'
});

// Output spec
{
  "name": "Background",
  "type": "RECTANGLE",
  "width": 200,
  "height": 100,
  "x": 0,
  "y": 0,
  "fills": [{
    "type": "SOLID",
    "color": { "r": 0.95, "g": 0.95, "b": 0.95, "a": 1 },
    "opacity": 1,
    "visible": true
  }],
  "cornerRadius": 8
}
```

### Auto-Layout Frame

```javascript
// Export a frame with auto-layout
const frame = await figma_get_component({
  nodeId: '2:3',
  format: 'reconstruction'
});

// Output spec
{
  "name": "Card",
  "type": "FRAME",
  "width": 320,
  "height": 200,
  "layoutMode": "VERTICAL",
  "paddingTop": 16,
  "paddingBottom": 16,
  "paddingLeft": 16,
  "paddingRight": 16,
  "itemSpacing": 12,
  "primaryAxisAlignItems": "MIN",
  "counterAxisAlignItems": "CENTER",
  "fills": [{
    "type": "SOLID",
    "color": { "r": 1, "g": 1, "b": 1, "a": 1 },
    "opacity": 1,
    "visible": true
  }],
  "effects": [{
    "type": "DROP_SHADOW",
    "color": { "r": 0, "g": 0, "b": 0, "a": 0.1 },
    "offset": { "x": 0, "y": 2 },
    "radius": 8,
    "visible": true
  }],
  "children": [...]
}
```

## Support

For issues or questions about the reconstruction format:

1. Check validation errors in the response
2. Verify node types are supported
3. Ensure color values are in 0-1 range
4. Review [Figma Component Reconstructor plugin documentation](https://github.com/southleft/figma-console-mcp)
5. [Open an issue](https://github.com/southleft/figma-console-mcp/issues) with example spec

## Future Enhancements

Planned improvements:
- [ ] Support for variant property extraction
- [ ] Advanced vector path reconstruction
- [ ] Image embedding options
- [ ] Component property definitions
- [ ] Instance overrides support
- [ ] Batch export for multiple components
