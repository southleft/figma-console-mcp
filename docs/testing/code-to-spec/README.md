# Code to Spec Testing

This directory contains a proof-of-concept for the **Code → Spec → Figma** workflow.

## The Vision

```
┌─────────────────────────────────────────────────────────────────────┐
│  PRODUCTION WORKFLOW                                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  React Component + CSS/Tokens                                        │
│         │                                                            │
│         ▼                                                            │
│  Code Scanner (analyzes JSX + computed styles)                       │
│         │                                                            │
│         ▼                                                            │
│  Figma Spec JSON (this format)                                       │
│         │                                                            │
│         ▼                                                            │
│  Figma Component Reconstructor Plugin                                │
│         │                                                            │
│         ▼                                                            │
│  Figma Canvas ("sketchpad" for designers)                            │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Files in This Directory

### Source Code (What Code Scanner Would Parse)

| File | Description |
|------|-------------|
| `tokens.css` | Design tokens as CSS custom properties |
| `Button.tsx` | React component using CSS modules |
| `button.module.css` | CSS module with token references |
| `button-rendered.html` | Browser-rendered output (DOM + computed styles) |

### Generated Specs (What Code Scanner Would Output)

| File | Description |
|------|-------------|
| `button-primary-md-spec.json` | Figma spec for Primary/Medium button |
| `button-secondary-md-spec.json` | Figma spec for Secondary/Medium button |

## CSS → Figma Property Mapping

This is the core translation a Code Scanner must perform:

### Layout
| CSS | Figma |
|-----|-------|
| `display: flex` | `layoutMode: "HORIZONTAL"` or `"VERTICAL"` |
| `flex-direction: column` | `layoutMode: "VERTICAL"` |
| `align-items: center` | `counterAxisAlignItems: "CENTER"` |
| `justify-content: center` | `primaryAxisAlignItems: "CENTER"` |
| `gap: 8px` | `itemSpacing: 8` |

### Spacing
| CSS | Figma |
|-----|-------|
| `padding: 12px 16px` | `paddingTop: 12, paddingRight: 16, paddingBottom: 12, paddingLeft: 16` |
| `padding-left: 16px` | `paddingLeft: 16` |

### Sizing
| CSS | Figma |
|-----|-------|
| `width: auto` (content-based) | `layoutSizingHorizontal: "HUG"` |
| `width: 100%` (fill parent) | `layoutSizingHorizontal: "FILL"` |
| `width: 200px` (fixed) | `layoutSizingHorizontal: "FIXED"`, `width: 200` |

### Visual
| CSS | Figma |
|-----|-------|
| `background-color: #2563eb` | `fills: [{ type: "SOLID", color: { r: 0.145, g: 0.388, b: 0.922 } }]` |
| `border: 1px solid #e5e7eb` | `strokes: [...], strokeWeight: 1` |
| `border-radius: 6px` | `cornerRadius: 6` |

### Typography
| CSS | Figma |
|-----|-------|
| `font-family: 'Inter'` | `fontName: { family: "Inter", style: "..." }` |
| `font-size: 16px` | `fontSize: 16` |
| `font-weight: 600` | `fontName: { ..., style: "Semi Bold" }` |
| `color: #ffffff` | `fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }]` (on TEXT node) |
| `text-align: center` | `textAlignHorizontal: "CENTER"` |

## Token Resolution

The `_metadata.tokenMappings` field shows how tokens resolve:

```
--color-primary → --color-blue-500 → #2563eb
     ↑                  ↑               ↑
 Semantic token    Primitive token   Actual value
```

This chain is important for:
1. Design system consistency
2. Theme switching
3. Documentation/traceability

## Testing This Spec

1. Copy the JSON spec content
2. Open Figma with the Component Reconstructor plugin
3. Paste the spec into the plugin input
4. Click "Reconstruct"
5. Verify the button looks correct

## Next Steps

1. **Code Scanner Development**: Build a tool that parses React + CSS and outputs this spec format
2. **Storybook Integration**: Add a "Figma Spec" tab that auto-generates specs for each component
3. **Bidirectional Sync**: Read designer changes from Figma and update code

## Notes

- Specs are generated **per-variant** (Primary/MD, Secondary/MD, etc.)
- The plugin creates editable Figma nodes, not instances
- Designers can modify freely; changes inform code updates
- Code remains the source of truth
