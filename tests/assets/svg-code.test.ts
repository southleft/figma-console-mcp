/**
 * toCodeSvg (spec §3.4 step 6, §8.1 "assets-export"): currentColor for
 * single-color icons, removeSize, and leaving anything else alone.
 */

import { toCodeSvg } from "../../src/core/assets/svg-code";

// Shapes Figma's SVG exporter actually produces.
const STROKE_ICON =
	'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">\n<path d="M19 12H5M5 12L12 19M5 12L12 5" stroke="#1E1E1E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>\n</svg>\n';
const FILL_ICON =
	'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">\n<path fill-rule="evenodd" clip-rule="evenodd" d="M2 2h16v16H2z" fill="black"/>\n<circle cx="10" cy="10" r="3" fill="#000"/>\n</svg>\n';
const TWO_COLOR =
	'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">\n<path d="M1 1h10" stroke="#1E1E1E"/>\n<path d="M1 5h10" fill="#FFB800"/>\n</svg>\n';
const GRADIENT =
	'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">\n<rect width="24" height="24" fill="url(#paint0_linear_1_2)"/>\n<defs>\n<linearGradient id="paint0_linear_1_2" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">\n<stop stop-color="#FF0000"/>\n<stop offset="1" stop-color="#FF0000" stop-opacity="0"/>\n</linearGradient>\n</defs>\n</svg>\n';

describe("toCodeSvg", () => {
	it("a single-color icon gets currentColor (attributes and styles), other attributes untouched", () => {
		const r = toCodeSvg(STROKE_ICON, { currentColor: true });
		expect(r.changed).toBe(true);
		expect(r.notes).toEqual([]);
		expect(r.svg).toContain('stroke="currentColor"');
		expect(r.svg).toContain('fill="none"');
		expect(r.svg).toContain('width="24" height="24" viewBox="0 0 24 24"');
		expect(r.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
		expect(r.svg).not.toContain("#1E1E1E");
		// "black" and "#000" are the same color.
		const f = toCodeSvg(FILL_ICON, { currentColor: true });
		expect(f.svg.match(/fill="currentColor"/g)).toHaveLength(2);
		expect(f.svg).toContain('fill-rule="evenodd"');
		const styled = toCodeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><path d="M0 0" style="fill: #123456; opacity: 0.5"/></svg>', { currentColor: true });
		expect(styled.svg).toContain('style="fill:currentColor;opacity:0.5"');
	});

	it("a two-color icon or a gradient is left with a note", () => {
		for (const svg of [TWO_COLOR, GRADIENT]) {
			const r = toCodeSvg(svg, { currentColor: true });
			expect(r).toEqual({ svg, changed: false, notes: ["multi-color, left as is."] });
		}
		const alpha = toCodeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0" fill="#00000080"/></svg>', { currentColor: true });
		expect(alpha.notes).toEqual(["multi-color, left as is."]);
	});

	it("removeSize drops width/height and keeps the viewBox", () => {
		const r = toCodeSvg(STROKE_ICON, { removeSize: true });
		expect(r.svg.startsWith('<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">')).toBe(true);
		expect(r.svg).toContain('stroke="#1E1E1E"');
		const synth = toCodeSvg('<svg width="32px" height="16" xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>', { removeSize: true });
		expect(synth.svg).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 16"><path d="M0 0"/></svg>');
		const odd = toCodeSvg('<svg width="100%" height="1em" xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>', { removeSize: true });
		expect(odd.changed).toBe(false);
		expect(odd.notes[0]).toMatch(/^removeSize: no viewBox/);
	});

	it("both together; text and entities survive re-serialization", () => {
		const r = toCodeSvg(
			'<svg width="10" height="10" viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><title>A &amp; B &lt;x&gt;</title><use xlink:href="#p" fill="red"/><path id="p" d="M0 0" fill="#f00"/></svg>',
			{ currentColor: true, removeSize: true },
		);
		expect(r.svg).toBe(
			'<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><title>A &amp; B &lt;x></title><use xlink:href="#p" fill="currentColor"/><path id="p" d="M0 0" fill="currentColor"/></svg>',
		);
	});

	it("does nothing without options and leaves unreadable input unchanged", () => {
		expect(toCodeSvg(STROKE_ICON, {})).toEqual({ svg: STROKE_ICON, changed: false, notes: [] });
		const bad = toCodeSvg("<svg><path></svg>", { currentColor: true });
		expect(bad.changed).toBe(false);
		expect(bad.svg).toBe("<svg><path></svg>");
		expect(bad.notes).toEqual(["couldn't re-read Figma's SVG, so it was left as is."]);
		expect(toCodeSvg("<html/>", { removeSize: true }).changed).toBe(false);
	});

	it("an icon that is already currentColor (no solid colors) is left alone without a note", () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0" fill="currentColor"/></svg>';
		expect(toCodeSvg(svg, { currentColor: true })).toEqual({ svg, changed: false, notes: [] });
	});
});

describe("toCodeSvg: clip paths and masks (review fix)", () => {
	// Figma's export of a frame/component with Clip content on.
	const CLIPPED =
		'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">\n<g clip-path="url(#clip0_1_2)">\n<path d="M19 12H5M5 12L12 19" stroke="#1E1E1E" stroke-width="2"/>\n</g>\n<defs>\n<clipPath id="clip0_1_2">\n<rect width="24" height="24" fill="white"/>\n</clipPath>\n</defs>\n</svg>\n';
	// Figma's export of a masked icon (the Material Symbols pattern): <mask> outside <defs>.
	const MASKED =
		'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">\n<mask id="mask0_1_2" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">\n<rect width="24" height="24" fill="#D9D9D9"/>\n</mask>\n<g mask="url(#mask0_1_2)">\n<path d="M4 4h16v16H4z" fill="#1C1B1F"/>\n</g>\n</svg>\n';

	it("a clipped single-color icon gets currentColor; the clip rect stays white", () => {
		const r = toCodeSvg(CLIPPED, { currentColor: true });
		expect(r.notes).toEqual([]);
		expect(r.svg).toContain('stroke="currentColor"');
		expect(r.svg).toContain('<rect width="24" height="24" fill="white"/>');
	});

	it("a masked icon gets currentColor; the mask keeps its #D9D9D9", () => {
		const r = toCodeSvg(MASKED, { currentColor: true });
		expect(r.notes).toEqual([]);
		expect(r.svg).toContain('<path d="M4 4h16v16H4z" fill="currentColor"/>');
		expect(r.svg).toContain('fill="#D9D9D9"');
	});

	it("a luminance mask the same color as the art is left alone (rewriting it would change the mask)", () => {
		const svg = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><mask id="m"><rect width="24" height="24" fill="white"/></mask><path mask="url(#m)" d="M1 1h9" fill="white"/></svg>';
		const r = toCodeSvg(svg, { currentColor: true });
		expect(r.svg).toContain('<rect width="24" height="24" fill="white"/>');
		expect(r.svg).toContain('d="M1 1h9" fill="currentColor"');
	});

	it("a clipped two-color icon is still multi-color", () => {
		const svg = CLIPPED.replace('stroke-width="2"/>', 'stroke-width="2"/>\n<path d="M1 5h9" fill="#FFB800"/>');
		expect(toCodeSvg(svg, { currentColor: true }).notes).toEqual(["multi-color, left as is."]);
	});
});
