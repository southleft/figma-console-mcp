/**
 * Figma Style Extractor
 *
 * Extracts style information (colors, typography, spacing) from Figma files
 * using the REST API /files endpoint. This provides an alternative to the
 * Enterprise-only Variables API by parsing style data directly from nodes.
 *
 * Based on the approach used by Figma-Context-MCP
 */

import { logger } from './logger';

interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface FigmaPaint {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: FigmaColor;
}

interface FigmaTypeStyle {
  fontFamily?: string;
  fontPostScriptName?: string;
  fontWeight?: number;
  fontSize?: number;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  letterSpacing?: number;
  lineHeightPx?: number;
  lineHeightPercent?: number;
}

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  opacity?: number;
  fills?: FigmaPaint[];
  strokes?: FigmaPaint[];
  strokeWeight?: number;
  style?: FigmaTypeStyle;
  children?: FigmaNode[];
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  itemSpacing?: number;
  layoutMode?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
}

interface ExtractedVariable {
  id: string;
  name: string;
  value: string;
  type: 'COLOR' | 'TYPOGRAPHY' | 'SPACING' | 'RADIUS' | 'EFFECT';
  category?: string;
  description?: string;
  nodeId?: string;
}

export class FigmaStyleExtractor {
  private extractedVariables: Map<string, ExtractedVariable> = new Map();
  private colorIndex = 0;
  private typographyIndex = 0;
  private spacingIndex = 0;
  private radiusIndex = 0;

  /**
   * Extract style "variables" from Figma file data
   * This mimics what users would see as variables in Figma
   */
  async extractStylesFromFile(fileData: any): Promise<ExtractedVariable[]> {
    try {
      logger.info('Extracting styles from Figma file data');

      this.extractedVariables.clear();
      this.colorIndex = 0;
      this.typographyIndex = 0;
      this.spacingIndex = 0;
      this.radiusIndex = 0;

      // Process the document tree
      if (fileData.document) {
        this.processNode(fileData.document);
      }

      // Also process components for more style data
      if (fileData.components) {
        Object.values(fileData.components).forEach((component: any) => {
          if (component.node) {
            this.processNode(component.node);
          }
        });
      }

      // Process styles if available
      if (fileData.styles) {
        this.processStyles(fileData.styles);
      }

      const variables = Array.from(this.extractedVariables.values());

      logger.info(
        {
          colorCount: variables.filter(v => v.type === 'COLOR').length,
          typographyCount: variables.filter(v => v.type === 'TYPOGRAPHY').length,
          spacingCount: variables.filter(v => v.type === 'SPACING').length,
          radiusCount: variables.filter(v => v.type === 'RADIUS').length,
          totalCount: variables.length
        },
        'Extracted style variables from file'
      );

      return variables;
    } catch (error) {
      logger.error({ error }, 'Failed to extract styles from file');
      throw error;
    }
  }

  /**
   * Process a single node and extract style information
   */
  private processNode(node: FigmaNode, depth: number = 0): void {
    if (!node || depth > 10) return; // Limit depth to prevent infinite recursion

    // Extract colors from fills
    if (node.fills && Array.isArray(node.fills)) {
      node.fills.forEach(fill => {
        if (fill.type === 'SOLID' && fill.color && fill.visible !== false) {
          this.extractColor(fill.color, fill.opacity, node);
        }
      });
    }

    // Extract colors from strokes
    if (node.strokes && Array.isArray(node.strokes)) {
      node.strokes.forEach(stroke => {
        if (stroke.type === 'SOLID' && stroke.color && stroke.visible !== false) {
          this.extractColor(stroke.color, stroke.opacity, node, 'stroke');
        }
      });
    }

    // Extract typography styles
    if (node.type === 'TEXT' && node.style) {
      this.extractTypography(node.style, node);
    }

    // Extract spacing from auto-layout
    if (node.layoutMode) {
      if (node.itemSpacing !== undefined && node.itemSpacing > 0) {
        this.extractSpacing('spacing', node.itemSpacing, node);
      }
      if (node.paddingLeft !== undefined && node.paddingLeft > 0) {
        this.extractSpacing('padding', node.paddingLeft, node);
      }
    }

    // Extract corner radius
    if (node.cornerRadius !== undefined && node.cornerRadius > 0) {
      this.extractRadius(node.cornerRadius, node);
    } else if (node.rectangleCornerRadii && node.rectangleCornerRadii.length > 0) {
      const uniqueRadii = [...new Set(node.rectangleCornerRadii)];
      uniqueRadii.forEach(radius => {
        if (radius > 0) {
          this.extractRadius(radius, node);
        }
      });
    }

    // Process children recursively
    if (node.children && Array.isArray(node.children)) {
      node.children.forEach(child => {
        this.processNode(child, depth + 1);
      });
    }
  }

  /**
   * Extract color variable
   */
  private extractColor(color: FigmaColor, opacity: number = 1, node: FigmaNode, type: string = 'fill'): void {
    const r = Math.round(color.r * 255);
    const g = Math.round(color.g * 255);
    const b = Math.round(color.b * 255);
    const a = opacity * (color.a || 1);

    const hex = '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
    const rgba = a < 1 ? `rgba(${r}, ${g}, ${b}, ${a})` : hex;

    // Create a unique key based on the color value
    const key = `color_${hex}_${a}`;

    if (!this.extractedVariables.has(key)) {
      // Generate a meaningful name based on the node
      const category = this.inferColorCategory(node.name);
      const name = this.generateColorName(category, type, this.colorIndex++);

      this.extractedVariables.set(key, {
        id: key,
        name,
        value: rgba,
        type: 'COLOR',
        category,
        description: `Extracted from ${node.name || 'unnamed node'}`,
        nodeId: node.id
      });
    }
  }

  /**
   * Extract typography variable
   */
  private extractTypography(style: FigmaTypeStyle, node: FigmaNode): void {
    const key = `typography_${style.fontFamily}_${style.fontSize}_${style.fontWeight}`;

    if (!this.extractedVariables.has(key)) {
      const name = this.generateTypographyName(node.name, this.typographyIndex++);

      const value = [
        `font-family: "${style.fontFamily || 'Inter'}"`,
        style.fontSize ? `font-size: ${style.fontSize}px` : '',
        style.fontWeight ? `font-weight: ${style.fontWeight}` : '',
        style.lineHeightPx ? `line-height: ${style.lineHeightPx}px` : '',
        style.letterSpacing ? `letter-spacing: ${style.letterSpacing}px` : ''
      ].filter(Boolean).join(', ');

      this.extractedVariables.set(key, {
        id: key,
        name,
        value,
        type: 'TYPOGRAPHY',
        category: 'text',
        description: `Extracted from ${node.name || 'unnamed text'}`,
        nodeId: node.id
      });
    }
  }

  /**
   * Extract spacing variable
   */
  private extractSpacing(type: string, value: number, node: FigmaNode): void {
    const key = `spacing_${type}_${value}`;

    if (!this.extractedVariables.has(key)) {
      const name = `${type}/${Math.round(value / 4) * 4 || value}`; // Round to nearest 4px

      this.extractedVariables.set(key, {
        id: key,
        name,
        value: `${value}px`,
        type: 'SPACING',
        category: type,
        description: `Extracted from ${node.name || 'unnamed node'}`,
        nodeId: node.id
      });
    }
  }

  /**
   * Extract radius variable
   */
  private extractRadius(value: number, node: FigmaNode): void {
    const key = `radius_${value}`;

    if (!this.extractedVariables.has(key)) {
      const name = `radius/${this.categorizeRadius(value)}`;

      this.extractedVariables.set(key, {
        id: key,
        name,
        value: `${value}px`,
        type: 'RADIUS',
        category: 'border',
        description: `Extracted from ${node.name || 'unnamed node'}`,
        nodeId: node.id
      });
    }
  }

  /**
   * Process Figma styles object
   */
  private processStyles(styles: any): void {
    Object.entries(styles).forEach(([styleId, styleData]: [string, any]) => {
      const { name, description, styleType } = styleData;

      if (styleType === 'FILL' || styleType === 'TEXT') {
        // These are named styles that could be considered variables
        const variable: ExtractedVariable = {
          id: styleId,
          name: name || styleId,
          value: styleId, // We don't have the actual value here
          type: styleType === 'FILL' ? 'COLOR' : 'TYPOGRAPHY',
          description: description || `Style: ${name}`,
          category: 'style'
        };

        this.extractedVariables.set(`style_${styleId}`, variable);
      }
    });
  }

  /**
   * Helper to infer color category from node name
   */
  private inferColorCategory(nodeName?: string): string {
    if (!nodeName) return 'color';

    const name = nodeName.toLowerCase();

    if (name.includes('background') || name.includes('bg')) return 'background';
    if (name.includes('text') || name.includes('label') || name.includes('title')) return 'text';
    if (name.includes('border') || name.includes('stroke')) return 'border';
    if (name.includes('primary') || name.includes('secondary') || name.includes('accent')) return 'theme';
    if (name.includes('success') || name.includes('error') || name.includes('warning')) return 'semantic';

    return 'color';
  }

  /**
   * Generate a meaningful color name
   */
  private generateColorName(category: string, type: string, index: number): string {
    const tier = index < 5 ? 'primary' : index < 10 ? 'secondary' : 'tertiary';
    return `${category}/${tier}-${type}`;
  }

  /**
   * Generate a meaningful typography name
   */
  private generateTypographyName(nodeName: string | undefined, index: number): string {
    if (nodeName) {
      const name = nodeName.toLowerCase();
      if (name.includes('heading') || name.includes('h1') || name.includes('h2')) {
        return `heading/${name.replace(/[^a-z0-9]/g, '-')}`;
      }
      if (name.includes('body') || name.includes('paragraph')) {
        return `body/${name.replace(/[^a-z0-9]/g, '-')}`;
      }
      if (name.includes('caption') || name.includes('label')) {
        return `caption/${name.replace(/[^a-z0-9]/g, '-')}`;
      }
    }

    return `text/style-${index}`;
  }

  /**
   * Categorize radius values
   */
  private categorizeRadius(value: number): string {
    if (value === 0) return 'none';
    if (value <= 2) return 'xs';
    if (value <= 4) return 'sm';
    if (value <= 8) return 'md';
    if (value <= 16) return 'lg';
    if (value <= 24) return 'xl';
    return 'xxl';
  }

  /**
   * Format the extracted variables for output
   */
  formatVariablesAsOutput(variables: ExtractedVariable[]): any {
    // Group variables by type and category
    const grouped: Record<string, any> = {};

    variables.forEach(variable => {
      const key = variable.name;
      grouped[key] = variable.value;
    });

    // Add metadata about extraction method
    grouped['_metadata'] = {
      extractionMethod: 'REST_API_STYLES',
      note: 'These are extracted style properties, not true Figma Variables (which require Enterprise)',
      timestamp: new Date().toISOString(),
      counts: {
        colors: variables.filter(v => v.type === 'COLOR').length,
        typography: variables.filter(v => v.type === 'TYPOGRAPHY').length,
        spacing: variables.filter(v => v.type === 'SPACING').length,
        radius: variables.filter(v => v.type === 'RADIUS').length,
        total: variables.length
      }
    };

    return grouped;
  }
}