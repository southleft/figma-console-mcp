/**
 * Figma Reconstruction Spec
 *
 * Generates node tree construction specifications compatible with the
 * Figma Component Reconstructor plugin. This format differs from metadata
 * export by providing all properties needed to programmatically recreate
 * components in Figma.
 */

import { logger } from './logger.js';

// Color format used by Figma (0-1 normalized RGB)
interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

// Paint types
interface SolidPaint {
  type: 'SOLID';
  color: FigmaColor;
  opacity: number;
  visible: boolean;
}

interface GradientStop {
  color: FigmaColor;
  position: number;
}

interface GradientPaint {
  type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND';
  gradientStops: GradientStop[];
  opacity: number;
  visible: boolean;
}

interface ImagePaint {
  type: 'IMAGE';
  scaleMode: string;
  imageRef?: string;
  opacity: number;
  visible: boolean;
}

type Paint = SolidPaint | GradientPaint | ImagePaint;

// Effect types
interface ShadowEffect {
  type: 'DROP_SHADOW' | 'INNER_SHADOW';
  color: FigmaColor;
  offset: { x: number; y: number };
  radius: number;
  spread?: number;
  visible: boolean;
}

interface BlurEffect {
  type: 'LAYER_BLUR' | 'BACKGROUND_BLUR';
  radius: number;
  visible: boolean;
}

type Effect = ShadowEffect | BlurEffect;

// Font name structure
interface FontName {
  family: string;
  style: string;
}

// Constraints
interface Constraints {
  horizontal: 'MIN' | 'MAX' | 'CENTER' | 'STRETCH' | 'SCALE';
  vertical: 'MIN' | 'MAX' | 'CENTER' | 'STRETCH' | 'SCALE';
}

// Base node specification
interface BaseNodeSpec {
  name: string;
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  opacity?: number;
  blendMode?: string;
  visible?: boolean;
  locked?: boolean;
  description?: string;
  constraints?: Constraints;
  children?: NodeSpecification[];
}

// Extended specs for specific node types
interface FrameNodeSpec extends BaseNodeSpec {
  type: 'FRAME' | 'COMPONENT' | 'COMPONENT_SET' | 'INSTANCE';
  fills?: Paint[];
  strokes?: Paint[];
  strokeWeight?: number;
  strokeAlign?: string;
  strokeCap?: string;
  strokeJoin?: string;
  strokeMiterLimit?: number;
  cornerRadius?: number;
  rectangleCornerRadii?: [number, number, number, number];
  effects?: Effect[];
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL';
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  itemSpacing?: number;
  counterAxisSpacing?: number;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  primaryAxisSizingMode?: string;
  layoutWrap?: string;
  clipsContent?: boolean;
  variantProperties?: Record<string, string>;
}

interface ShapeNodeSpec extends BaseNodeSpec {
  type: 'RECTANGLE' | 'ELLIPSE' | 'POLYGON' | 'STAR' | 'VECTOR' | 'LINE';
  fills?: Paint[];
  strokes?: Paint[];
  strokeWeight?: number;
  strokeAlign?: string;
  strokeCap?: string;
  strokeJoin?: string;
  cornerRadius?: number;
  rectangleCornerRadii?: [number, number, number, number];
  effects?: Effect[];
}

interface TextNodeSpec extends BaseNodeSpec {
  type: 'TEXT';
  characters: string;
  fontSize?: number;
  fontName?: FontName;
  fontWeight?: number;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  textAutoResize?: string;
  lineHeight?: any;
  letterSpacing?: any;
  fills?: Paint[];
  strokes?: Paint[];
  strokeWeight?: number;
  effects?: Effect[];
}

type NodeSpecification = BaseNodeSpec | FrameNodeSpec | ShapeNodeSpec | TextNodeSpec;

/**
 * Convert Figma paint array to reconstruction spec format
 */
export function convertFills(fills: any): Paint[] {
  if (!fills || fills === 'mixed') return [];

  return fills
    .filter((fill: any) => fill.visible !== false)
    .map((fill: any) => {
      if (fill.type === 'SOLID') {
        return {
          type: 'SOLID',
          color: {
            r: fill.color?.r ?? 0,
            g: fill.color?.g ?? 0,
            b: fill.color?.b ?? 0,
            a: fill.opacity ?? 1,
          },
          opacity: fill.opacity ?? 1,
          visible: fill.visible ?? true,
        } as SolidPaint;
      }

      if (fill.type.startsWith('GRADIENT')) {
        return {
          type: fill.type,
          gradientStops: fill.gradientStops?.map((stop: any) => ({
            color: {
              r: stop.color?.r ?? 0,
              g: stop.color?.g ?? 0,
              b: stop.color?.b ?? 0,
              a: stop.color?.a ?? 1,
            },
            position: stop.position ?? 0,
          })) || [],
          opacity: fill.opacity ?? 1,
          visible: fill.visible ?? true,
        } as GradientPaint;
      }

      if (fill.type === 'IMAGE') {
        return {
          type: 'IMAGE',
          scaleMode: fill.scaleMode || 'FILL',
          imageRef: fill.imageRef,
          opacity: fill.opacity ?? 1,
          visible: fill.visible ?? true,
        } as ImagePaint;
      }

      // Default fallback
      return null;
    })
    .filter((f: any) => f !== null);
}

/**
 * Convert Figma stroke array to reconstruction spec format
 */
export function convertStrokes(strokes: any): Paint[] {
  // Strokes use same format as fills
  return convertFills(strokes);
}

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

/**
 * Convert Figma effects array to reconstruction spec format
 */
export function convertEffects(effects: any): Effect[] {
  if (!effects || effects === 'mixed') return [];

  return effects
    .filter((effect: any) => effect.visible !== false)
    .map((effect: any) => {
      if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
        return {
          type: effect.type,
          color: {
            r: effect.color?.r ?? 0,
            g: effect.color?.g ?? 0,
            b: effect.color?.b ?? 0,
            a: effect.color?.a ?? 1,
          },
          offset: effect.offset || { x: 0, y: 0 },
          radius: effect.radius ?? 0,
          spread: effect.spread,
          visible: effect.visible ?? true,
        } as ShadowEffect;
      }

      if (effect.type === 'LAYER_BLUR' || effect.type === 'BACKGROUND_BLUR') {
        return {
          type: effect.type,
          radius: effect.radius ?? 0,
          visible: effect.visible ?? true,
        } as BlurEffect;
      }

      return null;
    })
    .filter((e: any) => e !== null);
}

/**
 * Recursively extract node specification for reconstruction
 */
export function extractNodeSpec(node: any): NodeSpecification {
  const spec: any = {
    name: node.name,
    type: node.type,
  };

  // INSTANCE → FRAME conversion for plugin compatibility
  // Plugin cannot create instance nodes, so we convert them to frames
  // This preserves visual properties and children for the "sketchpad" workflow
  if (spec.type === 'INSTANCE') {
    spec.type = 'FRAME';
    // All visual properties (fills, strokes, layout) will be copied from the instance
    // Children will be processed recursively and also converted if needed
  }

  // Position - provide defaults if missing
  if ('x' in node && typeof node.x === 'number') {
    spec.x = node.x;
  } else if (node.type !== 'GROUP' && node.type !== 'SECTION') {
    spec.x = 0;
  }

  if ('y' in node && typeof node.y === 'number') {
    spec.y = node.y;
  } else if (node.type !== 'GROUP' && node.type !== 'SECTION') {
    spec.y = 0;
  }

  // Layout sizing for children in auto-layout parents
  // These properties tell the plugin HOW the child should size itself (HUG content vs FIXED vs FILL)
  if ('layoutSizingHorizontal' in node) {
    spec.layoutSizingHorizontal = node.layoutSizingHorizontal;
  }
  if ('layoutSizingVertical' in node) {
    spec.layoutSizingVertical = node.layoutSizingVertical;
  }

  // Dimensions - required for most node types to be reconstructable
  // IMPORTANT: Skip explicit dimensions for children with HUG sizing in auto-layout
  // The plugin will calculate dimensions based on sizing mode + content
  const hasHugSizing = node.layoutSizingHorizontal === 'HUG' || node.layoutSizingVertical === 'HUG';
  const isParentNode = node.type === 'COMPONENT' || node.type === 'FRAME' || node.type === 'INSTANCE';
  const skipDimensions = hasHugSizing && !isParentNode;

  if (!skipDimensions) {
    // Check both direct properties (Desktop Bridge) and absoluteBoundingBox (REST API)
    if ('width' in node && typeof node.width === 'number') {
      spec.width = node.width;
    } else if ('absoluteBoundingBox' in node && node.absoluteBoundingBox && typeof node.absoluteBoundingBox.width === 'number') {
      spec.width = node.absoluteBoundingBox.width;
    } else if (node.type !== 'GROUP' && node.type !== 'SECTION') {
      // Default width for nodes that need it
      spec.width = node.type === 'TEXT' ? 100 :
                   node.type === 'COMPONENT_SET' ? 200 :
                   node.type === 'ELLIPSE' ? 8 : 50;
    }

    if ('height' in node && typeof node.height === 'number') {
      spec.height = node.height;
    } else if ('absoluteBoundingBox' in node && node.absoluteBoundingBox && typeof node.absoluteBoundingBox.height === 'number') {
      spec.height = node.absoluteBoundingBox.height;
    } else if (node.type !== 'GROUP' && node.type !== 'SECTION') {
      // Default height for nodes that need it
      spec.height = node.type === 'TEXT' ? 20 :
                    node.type === 'COMPONENT_SET' ? 100 :
                    node.type === 'ELLIPSE' ? 8 : 50;
    }
  }

  // Visual properties (only include what plugin spec needs)
  if ('opacity' in node && typeof node.opacity === 'number' && node.opacity !== 1) {
    spec.opacity = node.opacity;
  }

  // Fills (only include if present and non-empty)
  if ('fills' in node && node.fills !== 'mixed') {
    const convertedFills = convertFills(node.fills);
    if (convertedFills.length > 0) {
      spec.fills = convertedFills;
    }
  }

  // Strokes (only include if present and non-empty)
  if ('strokes' in node && node.strokes !== 'mixed') {
    const convertedStrokes = convertStrokes(node.strokes);
    if (convertedStrokes.length > 0) {
      spec.strokes = convertedStrokes;
      // Only include stroke weight if there are strokes
      if ('strokeWeight' in node && typeof node.strokeWeight === 'number') {
        spec.strokeWeight = node.strokeWeight;
      }
    }
  }

  // Effects (only include if present and non-empty)
  if ('effects' in node && node.effects !== 'mixed') {
    const convertedEffects = convertEffects(node.effects);
    if (convertedEffects.length > 0) {
      spec.effects = convertedEffects;
    }
  }

  // Corner radius
  if ('cornerRadius' in node && typeof node.cornerRadius === 'number') {
    spec.cornerRadius = node.cornerRadius;
  }
  if ('rectangleCornerRadii' in node && Array.isArray(node.rectangleCornerRadii)) {
    spec.rectangleCornerRadii = node.rectangleCornerRadii;
  }

  // Layout properties (for FRAME, COMPONENT, INSTANCE)
  // Plugin spec requires: layoutMode, primaryAxisSizingMode, counterAxisSizingMode, itemSpacing, padding*
  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    spec.layoutMode = node.layoutMode;

    // Sizing modes (REQUIRED for plugin spec)
    if ('primaryAxisSizingMode' in node) spec.primaryAxisSizingMode = node.primaryAxisSizingMode;
    if ('counterAxisSizingMode' in node) spec.counterAxisSizingMode = node.counterAxisSizingMode;

    // Spacing
    if ('itemSpacing' in node) spec.itemSpacing = node.itemSpacing;

    // Padding (all four sides)
    if ('paddingLeft' in node) spec.paddingLeft = node.paddingLeft;
    if ('paddingRight' in node) spec.paddingRight = node.paddingRight;
    if ('paddingTop' in node) spec.paddingTop = node.paddingTop;
    if ('paddingBottom' in node) spec.paddingBottom = node.paddingBottom;
  }

  // TEXT node specific properties
  // REST API returns text styling in a 'style' object
  if (node.type === 'TEXT') {
    if ('characters' in node) spec.characters = node.characters;

    // Check both direct properties (Plugin API) and style object (REST API)
    if ('fontSize' in node && typeof node.fontSize === 'number') {
      spec.fontSize = node.fontSize;
    } else if (node.style?.fontSize && typeof node.style.fontSize === 'number') {
      spec.fontSize = node.style.fontSize;
    }

    if ('fontName' in node) {
      spec.fontName = node.fontName;
    } else if (node.style?.fontFamily && node.style?.fontWeight) {
      spec.fontName = {
        family: node.style.fontFamily,
        style: node.style.fontWeight
      };
    }

    if ('textAlignHorizontal' in node) {
      spec.textAlignHorizontal = node.textAlignHorizontal;
    } else if (node.style?.textAlignHorizontal) {
      spec.textAlignHorizontal = node.style.textAlignHorizontal;
    }

    if ('textAlignVertical' in node) {
      spec.textAlignVertical = node.textAlignVertical;
    } else if (node.style?.textAlignVertical) {
      spec.textAlignVertical = node.style.textAlignVertical;
    }

    if ('letterSpacing' in node) {
      spec.letterSpacing = node.letterSpacing;
    } else if (node.style?.letterSpacing) {
      spec.letterSpacing = node.style.letterSpacing;
    }

    if ('lineHeight' in node) {
      spec.lineHeight = node.lineHeight;
    } else if (node.style?.lineHeight) {
      spec.lineHeight = node.style.lineHeight;
    }
  }

  // Variant properties (for COMPONENT in a COMPONENT_SET)
  if (node.type === 'COMPONENT' && 'variantProperties' in node && node.variantProperties) {
    spec.variantProperties = node.variantProperties;
  }

  // Children (recursive)
  if ('children' in node && Array.isArray(node.children)) {
    spec.children = node.children.map((child: any) => extractNodeSpec(child));
  }

  return spec;
}

/**
 * Validate that the reconstruction spec has required fields
 */
export function validateReconstructionSpec(spec: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Required fields
  if (!spec.name || typeof spec.name !== 'string') {
    errors.push('Missing or invalid required field: name');
  }

  if (!spec.type || typeof spec.type !== 'string') {
    errors.push('Missing or invalid required field: type');
  }

  // Valid node types
  const validTypes = [
    'FRAME',
    'COMPONENT',
    'COMPONENT_SET',
    'INSTANCE',
    'TEXT',
    'RECTANGLE',
    'ELLIPSE',
    'POLYGON',
    'STAR',
    'VECTOR',
    'LINE',
    'GROUP',
    'SECTION',
    'SLICE',
    'BOOLEAN_OPERATION',
  ];

  if (spec.type && !validTypes.includes(spec.type)) {
    errors.push(`Invalid node type: ${spec.type}. Must be one of: ${validTypes.join(', ')}`);
  }

  // Validate dimensions if present
  if ('width' in spec && (typeof spec.width !== 'number' || spec.width < 0)) {
    errors.push('Invalid width: must be a non-negative number');
  }

  if ('height' in spec && (typeof spec.height !== 'number' || spec.height < 0)) {
    errors.push('Invalid height: must be a non-negative number');
  }

  // Validate opacity if present
  if ('opacity' in spec && (typeof spec.opacity !== 'number' || spec.opacity < 0 || spec.opacity > 1)) {
    errors.push('Invalid opacity: must be a number between 0 and 1');
  }

  // Validate colors in fills
  if (spec.fills && Array.isArray(spec.fills)) {
    spec.fills.forEach((fill: any, index: number) => {
      if (fill.type === 'SOLID' && fill.color) {
        const { r, g, b, a } = fill.color;
        if (
          typeof r !== 'number' || r < 0 || r > 1 ||
          typeof g !== 'number' || g < 0 || g > 1 ||
          typeof b !== 'number' || b < 0 || b > 1 ||
          typeof a !== 'number' || a < 0 || a > 1
        ) {
          errors.push(`Invalid color in fills[${index}]: RGB values must be between 0 and 1`);
        }
      }
    });
  }

  // Recursively validate children
  if (spec.children && Array.isArray(spec.children)) {
    spec.children.forEach((child: any, index: number) => {
      const childValidation = validateReconstructionSpec(child);
      if (!childValidation.valid) {
        errors.push(`Errors in children[${index}]: ${childValidation.errors.join(', ')}`);
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Extract a specific variant from a COMPONENT_SET by name
 */
export function extractVariant(componentSet: any, variantName: string): NodeSpecification {
  if (!componentSet.children || !Array.isArray(componentSet.children)) {
    throw new Error('Invalid COMPONENT_SET: no children array');
  }

  const variant = componentSet.children.find(
    (child: any) => child.type === 'COMPONENT' && child.name === variantName
  );

  if (!variant) {
    const availableVariants = componentSet.children
      .filter((c: any) => c.type === 'COMPONENT')
      .map((c: any) => c.name);
    throw new Error(
      `Variant "${variantName}" not found. Available variants: ${availableVariants.join(', ')}`
    );
  }

  return extractNodeSpec(variant);
}

/**
 * Get list of available variants in a COMPONENT_SET
 */
export function listVariants(componentSet: any): string[] {
  if (!componentSet.children || !Array.isArray(componentSet.children)) {
    return [];
  }

  return componentSet.children
    .filter((child: any) => child.type === 'COMPONENT')
    .map((child: any) => child.name);
}
