/**
 * Image bytes for the figma_import_image tests, built in code (no binary
 * fixtures to license or keep in sync), and a FakeFigma with the image half
 * of the Plugin API: base64Decode, createImage (+ getSizeAsync) and
 * createRectangle.
 */

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { identifyImage, imagePixelSize } from "../../src/core/assets/image-plan";
import { FakeFigma, FNode, solid } from "../svg/fake-figma";

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(td));
	return Buffer.concat([len, td, crc]);
}

/** A valid RGBA PNG (all transparent). Pixel data is generated only for small images; `headerOnly` stops after IHDR. */
export function png(w: number, h: number, o: { headerOnly?: boolean; seed?: number } = {}): Uint8Array {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr)];
	if (!o.headerOnly) {
		const raw = Buffer.alloc(w * h <= 1_000_000 ? h * (1 + 4 * w) : 1);
		if (o.seed !== undefined) raw[raw.length - 1] = o.seed & 0xff;
		parts.push(pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0)));
	}
	return new Uint8Array(Buffer.concat(parts));
}

/** A JPEG header (SOI, APP0, optional large APP1 segments, SOF0, EOI): enough for the size parser and the fake. */
export function jpeg(w: number, h: number, o: { appBytes?: number } = {}): Uint8Array {
	const seg = (marker: number, body: Buffer) => {
		const head = Buffer.from([0xff, marker, 0, 0]);
		head.writeUInt16BE(body.length + 2, 2);
		return Buffer.concat([head, body]);
	};
	const parts = [Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from("JFIF\u0000\u0001\u0001\u0000\u0000\u0001\u0000\u0001\u0000\u0000", "latin1"))];
	let left = o.appBytes ?? 0;
	while (left > 0) {
		const n = Math.min(left, 65_000);
		parts.push(seg(0xe1, Buffer.alloc(n, 0x41)));
		left -= n;
	}
	const sof = Buffer.alloc(15);
	sof[0] = 8;
	sof.writeUInt16BE(h, 1);
	sof.writeUInt16BE(w, 3);
	sof[5] = 3;
	parts.push(seg(0xc0, sof), Buffer.from([0xff, 0xd9]));
	return new Uint8Array(Buffer.concat(parts));
}

export function gif(w: number, h: number, version: "87a" | "89a" = "89a"): Uint8Array {
	const b = Buffer.alloc(14);
	b.write(`GIF${version}`, 0, "ascii");
	b.writeUInt16LE(w, 6);
	b.writeUInt16LE(h, 8);
	b[13] = 0x3b;
	return new Uint8Array(b);
}

export function webp(): Uint8Array {
	const b = Buffer.alloc(30);
	b.write("RIFF", 0, "ascii");
	b.writeUInt32LE(22, 4);
	b.write("WEBPVP8 ", 8, "ascii");
	return new Uint8Array(b);
}

export function ftyp(brand: string): Uint8Array {
	const b = Buffer.alloc(24);
	b.writeUInt32BE(24, 0);
	b.write(`ftyp${brand}`, 4, "ascii");
	return new Uint8Array(b);
}

export const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

export class ImageFake extends FakeFigma {
	/** Return a message to make createImage throw for an image of that size. */
	createImageFails: (size: { width: number; height: number }) => string | null = () => null;
	/** Figma's own reading of the size (e.g. EXIF rotation), when it differs from the header. */
	sizeOverride: { width: number; height: number } | null = null;
	noImageApi = false;

	api(): any {
		const a = super.api();
		const f = this;
		if (this.noImageApi) return a;
		a.base64Decode = (s: string) => {
			f.log("base64Decode");
			if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error("Invalid base64 string");
			return new Uint8Array(Buffer.from(s, "base64"));
		};
		a.createImage = (bytes: Uint8Array) => {
			f.log("createImage");
			const id = identifyImage(bytes);
			if (!id.ok) throw new Error("Image type is unsupported");
			const size = imagePixelSize(bytes, id.format) as { width: number; height: number };
			const fail = f.createImageFails(size);
			if (fail) throw new Error(fail);
			const hash = createHash("sha1").update(bytes).digest("hex");
			return { hash, getSizeAsync: async () => f.sizeOverride ?? size, getBytesAsync: async () => bytes };
		};
		a.createRectangle = () => {
			f.log("createRectangle");
			const r = new FNode("RECTANGLE", f);
			r._w = 100;
			r._h = 100;
			r.fills = [solid("#d9d9d9")];
			f.currentPage.appendChild(r);
			return r;
		};
		return a;
	}
}
