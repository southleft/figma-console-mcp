/**
 * Property comparison primitives.
 *
 * Pure helper functions used by both the design-code parity tools and
 * the version diff engine. Moved here from src/core/design-code-tools.ts
 * so multiple consumers can share without circular dependencies.
 */

/** Convert Figma RGBA (0-1 floats) to hex string */
export function figmaRGBAToHex(color: { r: number; g: number; b: number; a?: number }): string {
	const r = Math.round(color.r * 255);
	const g = Math.round(color.g * 255);
	const b = Math.round(color.b * 255);
	const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase();
	if (color.a !== undefined && color.a < 1) {
		const a = Math.round(color.a * 255);
		return `${hex}${a.toString(16).padStart(2, "0")}`;
	}
	return hex;
}

/** Normalize a color string for comparison (uppercase hex without alpha if fully opaque) */
export function normalizeColor(color: string): string {
	let c = color.trim().toUpperCase();
	// Strip alpha if fully opaque (FF)
	if (c.length === 9 && c.endsWith("FF")) {
		c = c.slice(0, 7);
	}
	// Expand shorthand (#RGB -> #RRGGBB)
	if (/^#[0-9A-F]{3}$/.test(c)) {
		c = `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
	}
	return c;
}

/** Compare numeric values with a tolerance */
export function numericClose(a: number, b: number, tolerance = 1): boolean {
	return Math.abs(a - b) <= tolerance;
}
