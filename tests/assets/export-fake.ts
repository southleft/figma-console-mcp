/**
 * Export additions to the fake Figma in tests/svg/fake-figma.ts: exportAsync
 * (PNG/JPG with real headers, SVG_STRING, PDF), absoluteRenderBounds,
 * getMainComponentAsync, getImageByHash and base64Encode. Patched onto the
 * FNode prototype; jest gives every test file its own module registry, so
 * the import tests never see these.
 */

import { FakeFigma, FNode, runScript } from "../svg/fake-figma";

export { FakeFigma, FNode, runScript };

export interface ExportExtras {
	_svg?: string;
	_pdfBytes?: number;
	_rasterBytes?: number;
	_exportError?: string;
	_renderBounds?: { x: number; y: number; width: number; height: number } | null;
	_main?: FNode | null;
	exportSettings?: unknown[];
	key?: string;
}
export type XNode = FNode & ExportExtras;

export function pngBytes(w: number, h: number, total = 64): Uint8Array {
	const b = new Uint8Array(Math.max(total, 33));
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	const dv = new DataView(b.buffer);
	dv.setUint32(16, w);
	dv.setUint32(20, h);
	return b;
}

export function jpegBytes(w: number, h: number, total = 64): Uint8Array {
	const b = new Uint8Array(Math.max(total, 40));
	// SOI, APP0 (length 16), SOF0 with height/width.
	b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
	b.set([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255], 20);
	return b;
}

export const gifBytes = () => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0]);
export const webpBytes = () => new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0]);

const proto = FNode.prototype as any;
proto.exportAsync = async function (this: XNode, s?: { format?: string; constraint?: { type: string; value: number } }) {
	this.fake.log(`exportAsync:${this.id}:${s?.format ?? "PNG"}`);
	if (this._exportError) throw new Error(this._exportError);
	const w = this.width;
	const h = this.height;
	if (s?.format === "SVG_STRING") {
		return (
			this._svg ??
			`<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" xmlns="http://www.w3.org/2000/svg">\n<path d="M0 0L${w} ${h}" stroke="#1E1E1E" stroke-width="2"/>\n</svg>\n`
		);
	}
	if (s?.format === "PDF") {
		const b = new Uint8Array(this._pdfBytes ?? 1000);
		b.set([0x25, 0x50, 0x44, 0x46]);
		return b;
	}
	const c = s?.constraint ?? { type: "SCALE", value: 1 };
	const k = c.type === "SCALE" ? c.value : c.type === "WIDTH" ? c.value / w : c.value / h;
	const pw = Math.round(w * k);
	const ph = Math.round(h * k);
	return s?.format === "JPG" ? jpegBytes(pw, ph, this._rasterBytes) : pngBytes(pw, ph, this._rasterBytes);
};
Object.defineProperty(proto, "absoluteRenderBounds", {
	configurable: true,
	get(this: XNode) {
		if (this._renderBounds !== undefined) return this._renderBounds;
		return this.type === "PAGE" ? null : this.absoluteBoundingBox;
	},
});
proto.getMainComponentAsync = async function (this: XNode) {
	return this._main ?? null;
};

/** A node with explicit size, placed in a parent. */
export function node(fake: FakeFigma, type: string, name: string, parent: FNode | null, size: [number, number] = [24, 24], extra: Partial<ExportExtras> = {}): XNode {
	const n = new FNode(type, fake) as XNode;
	n.name = name;
	n._w = size[0];
	n._h = size[1];
	if (type === "INSTANCE" && !n.children) n.children = [];
	Object.assign(n, extra);
	if (parent) parent.appendChild(n);
	return n;
}

export interface FakeImage {
	bytes: Uint8Array;
	width: number;
	height: number;
}

/** The plugin API for export scripts: the base fake plus images and base64. */
export function exportApi(fake: FakeFigma, images: Record<string, FakeImage> = {}): any {
	const api = fake.api();
	return Object.assign(api, {
		getImageByHash: (hash: string) => {
			const im = images[hash];
			if (!im) return null;
			return { getBytesAsync: async () => im.bytes, getSizeAsync: async () => ({ width: im.width, height: im.height }) };
		},
		base64Encode: (u8: Uint8Array) => Buffer.from(u8).toString("base64"),
	});
}

export const imagePaint = (hash: string, extra: Record<string, unknown> = {}) => ({ type: "IMAGE", visible: true, opacity: 1, imageHash: hash, scaleMode: "FILL", ...extra });
