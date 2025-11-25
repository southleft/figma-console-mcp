/**
 * Code to Figma Spec Converter
 *
 * Converts rendered HTML + computed CSS styles into Figma-compatible specification JSON.
 * This is the core logic that powers the Code → Figma workflow.
 *
 * Usage:
 *   const spec = convertToFigmaSpec(htmlString, computedStyles);
 *
 * The Storybook addon captures DOM + styles and sends them here for processing.
 */

import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "code-to-spec" });

// ============================================================================
// TYPES
// ============================================================================

export interface ComputedStyleMap {
  [selector: string]: {
    [property: string]: string;
  };
}

export interface ConversionOptions {
  /** Name for the root component */
  componentName?: string;
  /** Include metadata about token mappings */
  includeMetadata?: boolean;
  /** Token definitions for reverse-mapping values to tokens */
  tokens?: Record<string, string>;
}

export interface FigmaSpec {
  name: string;
  type: string;
  [key: string]: any;
}

// ============================================================================
// COLOR UTILITIES
// ============================================================================

/**
 * Parse CSS color string to Figma RGBA (0-1 range)
 */
function parseColor(cssColor: string): { r: number; g: number; b: number; a: number } | null {
  if (!cssColor || cssColor === "transparent" || cssColor === "none") {
    return null;
  }

  // Handle rgb/rgba
  const rgbMatch = cssColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (rgbMatch) {
    return {
      r: parseInt(rgbMatch[1]) / 255,
      g: parseInt(rgbMatch[2]) / 255,
      b: parseInt(rgbMatch[3]) / 255,
      a: rgbMatch[4] ? parseFloat(rgbMatch[4]) : 1,
    };
  }

  // Handle hex colors
  const hexMatch = cssColor.match(/^#([a-fA-F0-9]{6}|[a-fA-F0-9]{3})$/);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    return {
      r: parseInt(hex.slice(0, 2), 16) / 255,
      g: parseInt(hex.slice(2, 4), 16) / 255,
      b: parseInt(hex.slice(4, 6), 16) / 255,
      a: 1,
    };
  }

  // Named colors (common ones)
  const namedColors: Record<string, { r: number; g: number; b: number }> = {
    white: { r: 1, g: 1, b: 1 },
    black: { r: 0, g: 0, b: 0 },
    red: { r: 1, g: 0, b: 0 },
    green: { r: 0, g: 0.502, b: 0 },
    blue: { r: 0, g: 0, b: 1 },
    gray: { r: 0.502, g: 0.502, b: 0.502 },
    grey: { r: 0.502, g: 0.502, b: 0.502 },
  };

  const named = namedColors[cssColor.toLowerCase()];
  if (named) {
    return { ...named, a: 1 };
  }

  return null;
}

/**
 * Create Figma fill from CSS color
 * Note: Plugin expects color.a inside the color object (not as separate opacity)
 */
function createFill(cssColor: string): any[] {
  const color = parseColor(cssColor);
  if (!color) return [];

  return [
    {
      type: "SOLID",
      color: { r: color.r, g: color.g, b: color.b, a: color.a },
      visible: true,
    },
  ];
}

/**
 * Create Figma stroke from CSS border
 * Note: Plugin expects color.a inside the color object (not as separate opacity)
 */
function createStroke(cssBorder: string): { strokes: any[]; strokeWeight: number } | null {
  if (!cssBorder || cssBorder === "none" || cssBorder === "0px none") {
    return null;
  }

  // Parse "1px solid #e5e7eb" format
  const match = cssBorder.match(/^([\d.]+)px\s+(\w+)\s+(.+)$/);
  if (!match) return null;

  const [, width, style, colorStr] = match;
  if (style === "none") return null;

  const color = parseColor(colorStr.trim());
  if (!color) return null;

  return {
    strokes: [
      {
        type: "SOLID",
        color: { r: color.r, g: color.g, b: color.b, a: color.a },
        visible: true,
      },
    ],
    strokeWeight: parseFloat(width),
  };
}

// ============================================================================
// CSS → FIGMA PROPERTY MAPPING
// ============================================================================

/**
 * Parse CSS value to number (strips px, em, etc.)
 */
function parseNumericValue(value: string): number {
  const num = parseFloat(value);
  return isNaN(num) ? 0 : num;
}

/**
 * Map CSS font-weight to Figma font style
 */
function mapFontWeight(weight: string): string {
  const weightMap: Record<string, string> = {
    "100": "Thin",
    "200": "Extra Light",
    "300": "Light",
    "400": "Regular",
    "500": "Medium",
    "600": "Semi Bold",
    "700": "Bold",
    "800": "Extra Bold",
    "900": "Black",
    normal: "Regular",
    bold: "Bold",
  };
  return weightMap[weight] || "Regular";
}

/**
 * Map CSS text-align to Figma textAlignHorizontal
 */
function mapTextAlign(align: string): string {
  const alignMap: Record<string, string> = {
    left: "LEFT",
    center: "CENTER",
    right: "RIGHT",
    justify: "JUSTIFIED",
    start: "LEFT",
    end: "RIGHT",
  };
  return alignMap[align] || "LEFT";
}

/**
 * Map CSS align-items to Figma counterAxisAlignItems
 */
function mapAlignItems(align: string): string {
  const alignMap: Record<string, string> = {
    "flex-start": "MIN",
    start: "MIN",
    "flex-end": "MAX",
    end: "MAX",
    center: "CENTER",
    baseline: "BASELINE",
    stretch: "STRETCH",
  };
  return alignMap[align] || "MIN";
}

/**
 * Map CSS justify-content to Figma primaryAxisAlignItems
 */
function mapJustifyContent(justify: string): string {
  const justifyMap: Record<string, string> = {
    "flex-start": "MIN",
    start: "MIN",
    "flex-end": "MAX",
    end: "MAX",
    center: "CENTER",
    "space-between": "SPACE_BETWEEN",
    "space-around": "SPACE_AROUND",
    "space-evenly": "SPACE_EVENLY",
  };
  return justifyMap[justify] || "MIN";
}

// ============================================================================
// HTML PARSING (Simple DOM-like structure)
// ============================================================================

interface ParsedElement {
  tagName: string;
  id?: string;
  className?: string;
  textContent?: string;
  children: ParsedElement[];
  styles: Record<string, string>;
}

/**
 * Simple HTML parser that extracts structure
 * Note: In production, this would receive pre-parsed DOM from the browser
 */
function parseHTML(html: string): ParsedElement | null {
  // For MVP, we expect a simplified structure
  // In production, the Storybook addon would send already-parsed DOM

  const trimmed = html.trim();
  if (!trimmed) return null;

  // Check for pure text content
  if (!trimmed.startsWith("<")) {
    return {
      tagName: "#text",
      textContent: trimmed,
      children: [],
      styles: {},
    };
  }

  // Extract opening tag
  const openTagMatch = trimmed.match(/^<(\w+)([^>]*)>/);
  if (!openTagMatch) return null;

  const [openTag, tagName, attributes] = openTagMatch;
  const tagNameLower = tagName.toLowerCase();

  // Handle self-closing tags
  if (trimmed.endsWith("/>") || ["br", "hr", "img", "input"].includes(tagNameLower)) {
    return {
      tagName: tagNameLower,
      id: attributes.match(/id="([^"]+)"/)?.[1],
      className: attributes.match(/class="([^"]+)"/)?.[1],
      children: [],
      styles: {},
    };
  }

  // Find matching closing tag by counting nested tags
  const closeTag = `</${tagName}>`;
  let depth = 1;
  let searchPos = openTag.length;
  let closePos = -1;

  while (depth > 0 && searchPos < trimmed.length) {
    const nextOpen = trimmed.indexOf(`<${tagName}`, searchPos);
    const nextClose = trimmed.indexOf(closeTag, searchPos);

    if (nextClose === -1) break;

    // Check if there's an opening tag before the next closing tag
    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Check if it's actually an opening tag (not </tag or <tagName with more chars)
      const afterOpen = trimmed[nextOpen + tagName.length + 1];
      if (afterOpen === " " || afterOpen === ">" || afterOpen === "/") {
        depth++;
        searchPos = nextOpen + 1;
        continue;
      }
    }

    depth--;
    if (depth === 0) {
      closePos = nextClose;
    } else {
      searchPos = nextClose + closeTag.length;
    }
  }

  if (closePos === -1) return null;

  const innerContent = trimmed.slice(openTag.length, closePos);

  // Extract id and class from attributes
  const idMatch = attributes.match(/id="([^"]+)"/);
  const classMatch = attributes.match(/class="([^"]+)"/);

  const element: ParsedElement = {
    tagName: tagNameLower,
    id: idMatch?.[1],
    className: classMatch?.[1],
    children: [],
    styles: {},
  };

  // Check for direct text content vs child elements
  const hasChildElements = /<\w+/.test(innerContent);
  if (!hasChildElements && innerContent.trim()) {
    element.textContent = innerContent.trim();
  } else {
    // Parse child elements
    const children = extractChildElements(innerContent);
    for (const childHtml of children) {
      const child = parseHTML(childHtml);
      if (child) {
        element.children.push(child);
      }
    }
  }

  return element;
}

/**
 * Extract top-level child elements from HTML content
 */
function extractChildElements(html: string): string[] {
  const children: string[] = [];
  let pos = 0;
  const content = html.trim();

  while (pos < content.length) {
    // Skip whitespace
    while (pos < content.length && /\s/.test(content[pos])) pos++;
    if (pos >= content.length) break;

    // Check if we're at a tag
    if (content[pos] !== "<") {
      // Text node - skip for now (handled by parent)
      const nextTag = content.indexOf("<", pos);
      if (nextTag === -1) break;
      pos = nextTag;
      continue;
    }

    // Check for comment
    if (content.slice(pos, pos + 4) === "<!--") {
      const endComment = content.indexOf("-->", pos);
      if (endComment === -1) break;
      pos = endComment + 3;
      continue;
    }

    // Extract tag name
    const tagMatch = content.slice(pos).match(/^<(\w+)/);
    if (!tagMatch) {
      pos++;
      continue;
    }

    const tagName = tagMatch[1];
    const closeTag = `</${tagName}>`;

    // Find matching close tag
    let depth = 1;
    let searchPos = pos + tagMatch[0].length;
    let endPos = -1;

    // First, find end of opening tag
    const openTagEnd = content.indexOf(">", pos);
    if (openTagEnd === -1) break;

    // Check for self-closing
    if (content[openTagEnd - 1] === "/" || ["br", "hr", "img", "input"].includes(tagName.toLowerCase())) {
      children.push(content.slice(pos, openTagEnd + 1));
      pos = openTagEnd + 1;
      continue;
    }

    searchPos = openTagEnd + 1;

    while (depth > 0 && searchPos < content.length) {
      const nextOpen = content.indexOf(`<${tagName}`, searchPos);
      const nextClose = content.indexOf(closeTag, searchPos);

      if (nextClose === -1) break;

      if (nextOpen !== -1 && nextOpen < nextClose) {
        const afterOpen = content[nextOpen + tagName.length + 1];
        if (afterOpen === " " || afterOpen === ">" || afterOpen === "/") {
          depth++;
          searchPos = nextOpen + 1;
          continue;
        }
      }

      depth--;
      if (depth === 0) {
        endPos = nextClose + closeTag.length;
      } else {
        searchPos = nextClose + closeTag.length;
      }
    }

    if (endPos !== -1) {
      children.push(content.slice(pos, endPos));
      pos = endPos;
    } else {
      pos++;
    }
  }

  return children;
}

// ============================================================================
// MAIN CONVERSION LOGIC
// ============================================================================

/**
 * Convert a parsed element to Figma spec
 */
function elementToSpec(
  element: ParsedElement,
  styles: Record<string, string>,
  isRoot: boolean = false,
  allStyles?: ComputedStyleMap
): FigmaSpec {
  const spec: FigmaSpec = {
    name: element.className || element.id || element.tagName,
    type: isRoot ? "COMPONENT" : "FRAME",
  };

  // Handle pure text nodes (not elements with text content)
  if (element.tagName === "#text") {
    spec.type = "TEXT";
    spec.characters = element.textContent || "";
    spec.layoutSizingHorizontal = "HUG";
    spec.layoutSizingVertical = "HUG";

    // Text-specific styles
    if (styles.fontSize) {
      spec.fontSize = parseNumericValue(styles.fontSize);
    }
    if (styles.fontFamily) {
      const family = styles.fontFamily.split(",")[0].replace(/['"]/g, "").trim();
      spec.fontName = {
        family: family || "Inter",
        style: mapFontWeight(styles.fontWeight || "400"),
      };
    }
    if (styles.color) {
      spec.fills = createFill(styles.color);
    }
    if (styles.textAlign) {
      spec.textAlignHorizontal = mapTextAlign(styles.textAlign);
    }
    spec.textAlignVertical = "CENTER";

    return spec;
  }

  // For elements like <button>, <span>, <div> WITH text content,
  // we'll create a container with text child below

  // Position (for non-auto-layout scenarios)
  spec.x = 0;
  spec.y = 0;

  // Layout mode - ALL frames need layoutMode for children to use layoutSizing properties
  // Default to VERTICAL (stacking) unless CSS specifies flex-direction: row
  const display = styles.display || "block";
  const flexDirection = styles.flexDirection || "column";

  // Always set layoutMode - required for children to have layoutSizing properties
  spec.layoutMode = flexDirection === "row" ? "HORIZONTAL" : "VERTICAL";
  spec.primaryAxisSizingMode = "AUTO";
  spec.counterAxisSizingMode = "AUTO";

  if (display === "flex" || display === "inline-flex") {
    // Alignment (only meaningful for flex containers)
    if (styles.alignItems) {
      spec.counterAxisAlignItems = mapAlignItems(styles.alignItems);
    }
    if (styles.justifyContent) {
      spec.primaryAxisAlignItems = mapJustifyContent(styles.justifyContent);
    }

    // Gap / item spacing
    if (styles.gap) {
      spec.itemSpacing = parseNumericValue(styles.gap);
    }
  }

  // Sizing
  spec.layoutSizingHorizontal = "HUG";
  spec.layoutSizingVertical = "HUG";

  if (styles.width) {
    const width = styles.width;
    if (width === "100%" || width === "fill") {
      spec.layoutSizingHorizontal = "FILL";
    } else if (width !== "auto" && width !== "fit-content") {
      spec.layoutSizingHorizontal = "FIXED";
      spec.width = parseNumericValue(width);
    }
  }

  if (styles.height) {
    const height = styles.height;
    if (height === "100%" || height === "fill") {
      spec.layoutSizingVertical = "FILL";
    } else if (height !== "auto" && height !== "fit-content") {
      spec.layoutSizingVertical = "FIXED";
      spec.height = parseNumericValue(height);
    }
  }

  // Padding
  if (styles.padding) {
    const parts = styles.padding.split(/\s+/).map(parseNumericValue);
    if (parts.length === 1) {
      spec.paddingTop = spec.paddingRight = spec.paddingBottom = spec.paddingLeft = parts[0];
    } else if (parts.length === 2) {
      spec.paddingTop = spec.paddingBottom = parts[0];
      spec.paddingLeft = spec.paddingRight = parts[1];
    } else if (parts.length === 4) {
      [spec.paddingTop, spec.paddingRight, spec.paddingBottom, spec.paddingLeft] = parts;
    }
  }
  // Individual padding overrides
  if (styles.paddingTop) spec.paddingTop = parseNumericValue(styles.paddingTop);
  if (styles.paddingRight) spec.paddingRight = parseNumericValue(styles.paddingRight);
  if (styles.paddingBottom) spec.paddingBottom = parseNumericValue(styles.paddingBottom);
  if (styles.paddingLeft) spec.paddingLeft = parseNumericValue(styles.paddingLeft);

  // Background
  if (styles.backgroundColor) {
    spec.fills = createFill(styles.backgroundColor);
  }

  // Border
  if (styles.border) {
    const stroke = createStroke(styles.border);
    if (stroke) {
      spec.strokes = stroke.strokes;
      spec.strokeWeight = stroke.strokeWeight;
    }
  }

  // Border radius
  if (styles.borderRadius) {
    spec.cornerRadius = parseNumericValue(styles.borderRadius);
  }

  // Process children
  if (element.children.length > 0) {
    // Check if children can be flattened (single-text-child elements become TEXT directly)
    spec.children = element.children.map((child) => {
      const childStyles = allStyles ? findStylesForElement(child, allStyles) : {};

      // FLATTEN: If child element only contains text and has no frame-requiring styles,
      // convert it directly to a TEXT node instead of FRAME > TEXT
      if (child.textContent && child.children.length === 0 && !needsFrameWrapper(childStyles)) {
        return createTextNode(
          child.className || child.id || child.textContent.substring(0, 20),
          child.textContent,
          childStyles
        );
      }

      return elementToSpec(child, childStyles, false, allStyles);
    });
  } else if (element.textContent) {
    // Element has direct text content - create text child
    spec.children = [
      createTextNode("#text", element.textContent, {
        fontSize: styles.fontSize,
        fontFamily: styles.fontFamily,
        fontWeight: styles.fontWeight,
        color: styles.color,
        textAlign: styles.textAlign,
      }),
    ];
  }

  return spec;
}

/**
 * Check if an element needs a FRAME wrapper (has padding, background, border, etc.)
 * If false, element can be flattened to just a TEXT node
 */
function needsFrameWrapper(styles: Record<string, string>): boolean {
  const frameRequiringProps = [
    'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'backgroundColor', 'background',
    'border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft',
    'borderRadius',
    'display', // flex containers need frames
    'gap',
  ];

  return frameRequiringProps.some(prop => {
    const value = styles[prop];
    return value && value !== '0' && value !== '0px' && value !== 'none' && value !== 'transparent';
  });
}

/**
 * Create a TEXT node spec directly (no FRAME wrapper)
 */
function createTextNode(name: string, text: string, styles: Record<string, string>): FigmaSpec {
  const spec: FigmaSpec = {
    name,
    type: "TEXT",
    characters: text,
    layoutSizingHorizontal: "HUG",
    layoutSizingVertical: "HUG",
    textAlignVertical: "CENTER",
  };

  if (styles.fontSize) {
    spec.fontSize = parseNumericValue(styles.fontSize);
  }
  if (styles.fontFamily) {
    const family = styles.fontFamily.split(",")[0].replace(/['"]/g, "").trim();
    spec.fontName = {
      family: family || "Inter",
      style: mapFontWeight(styles.fontWeight || "400"),
    };
  }
  if (styles.color) {
    spec.fills = createFill(styles.color);
  }
  if (styles.textAlign) {
    spec.textAlignHorizontal = mapTextAlign(styles.textAlign);
  }

  return spec;
}

// ============================================================================
// PUBLIC API
// ============================================================================

export interface CodeToSpecInput {
  /** HTML string or pre-parsed DOM structure */
  html: string;
  /** Computed styles keyed by selector or element ID */
  styles: ComputedStyleMap;
  /** Conversion options */
  options?: ConversionOptions;
}

export interface CodeToSpecResult {
  success: boolean;
  spec?: FigmaSpec;
  error?: string;
  metadata?: {
    source: string;
    elementsProcessed: number;
    conversionTime: number;
  };
}

/**
 * Convert HTML + computed styles to Figma specification
 *
 * @param input - HTML string and computed styles
 * @returns Figma spec JSON ready for the plugin
 */
/**
 * Convert hyphenated CSS property names to camelCase
 * e.g., "background-color" -> "backgroundColor"
 */
function normalizeCSSPropertyName(prop: string): string {
  return prop.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Normalize style object keys from hyphenated to camelCase
 */
function normalizeStyles(styles: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(styles)) {
    normalized[normalizeCSSPropertyName(key)] = value;
  }
  return normalized;
}

/**
 * Find styles for an element by trying multiple selector formats
 */
function findStylesForElement(
  element: ParsedElement,
  styles: ComputedStyleMap
): Record<string, string> {
  let rawStyles: Record<string, string> = {};

  // Try class selector with dot (.button-primary)
  if (element.className) {
    const withDot = `.${element.className}`;
    if (styles[withDot]) {
      rawStyles = styles[withDot];
    } else if (styles[element.className]) {
      rawStyles = styles[element.className];
    }
  }

  // Try ID selector with hash (#myButton)
  if (!Object.keys(rawStyles).length && element.id) {
    const withHash = `#${element.id}`;
    if (styles[withHash]) {
      rawStyles = styles[withHash];
    } else if (styles[element.id]) {
      rawStyles = styles[element.id];
    }
  }

  // Try tag name
  if (!Object.keys(rawStyles).length && styles[element.tagName]) {
    rawStyles = styles[element.tagName];
  }

  // Try "root" as fallback
  if (!Object.keys(rawStyles).length && styles["root"]) {
    rawStyles = styles["root"];
  }

  // Normalize hyphenated keys to camelCase
  return normalizeStyles(rawStyles);
}

export function convertCodeToFigmaSpec(input: CodeToSpecInput): CodeToSpecResult {
  const startTime = Date.now();

  try {
    logger.info({ htmlLength: input.html.length }, "Starting code to Figma spec conversion");

    // Parse HTML structure
    const rootElement = parseHTML(input.html);
    if (!rootElement) {
      return {
        success: false,
        error: "Failed to parse HTML - no valid element found",
      };
    }

    // Get root styles - try multiple selector formats
    const rootStyles = findStylesForElement(rootElement, input.styles);

    // Convert to Figma spec (pass full styles for child lookups)
    const spec = elementToSpec(rootElement, rootStyles, true, input.styles);

    // Apply component name if provided
    if (input.options?.componentName) {
      spec.name = input.options.componentName;
    }

    const conversionTime = Date.now() - startTime;

    logger.info(
      { componentName: spec.name, conversionTime },
      "Code to Figma spec conversion complete"
    );

    return {
      success: true,
      spec,
      metadata: input.options?.includeMetadata
        ? {
            source: "code-to-spec",
            elementsProcessed: countElements(rootElement),
            conversionTime,
          }
        : undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage }, "Code to Figma spec conversion failed");

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Count elements in parsed tree
 */
function countElements(element: ParsedElement): number {
  let count = 1;
  for (const child of element.children) {
    count += countElements(child);
  }
  return count;
}

/**
 * Validate a Figma spec for completeness
 */
export function validateSpec(spec: FigmaSpec): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  if (!spec.name) issues.push("Missing 'name' property");
  if (!spec.type) issues.push("Missing 'type' property");

  if (spec.type === "TEXT") {
    if (!spec.characters) issues.push("TEXT node missing 'characters' property");
    if (!spec.fontSize) issues.push("TEXT node missing 'fontSize' property");
  }

  if (spec.type === "FRAME" || spec.type === "COMPONENT") {
    if (spec.layoutMode && !["HORIZONTAL", "VERTICAL", "NONE"].includes(spec.layoutMode)) {
      issues.push(`Invalid layoutMode: ${spec.layoutMode}`);
    }
  }

  // Validate children recursively
  if (spec.children) {
    for (const child of spec.children) {
      const childResult = validateSpec(child);
      issues.push(...childResult.issues.map((i) => `Child "${child.name}": ${i}`));
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
