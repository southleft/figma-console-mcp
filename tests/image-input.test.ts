import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	MAX_IMAGE_BYTES,
	looksLikeImageFilePath,
	resolveImageInput,
} from "../src/core/image-input";

/** 1×1 PNG */
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

describe("looksLikeImageFilePath", () => {
	it("detects Windows, Unix, UNC, and file:// paths", () => {
		expect(looksLikeImageFilePath("C:\\Users\\me\\photo.png")).toBe(true);
		expect(looksLikeImageFilePath("C:/Users/me/photo.jpg")).toBe(true);
		expect(looksLikeImageFilePath("/tmp/hero-image.jpeg")).toBe(true);
		expect(looksLikeImageFilePath("\\\\server\\share\\shot.gif")).toBe(true);
		expect(looksLikeImageFilePath("file:///C:/Users/me/photo.png")).toBe(true);
		expect(looksLikeImageFilePath("photo.png")).toBe(true);
		expect(looksLikeImageFilePath("C:\\Users\\me\\hero#final.png")).toBe(true);
		expect(looksLikeImageFilePath("/tmp/hero?final.png")).toBe(true);
	});

	it("does not treat JPEG or PNG base64 as a path", () => {
		expect(looksLikeImageFilePath("/9j/4AAQSkZJRgABAQAAAQABAAD")).toBe(false);
		expect(looksLikeImageFilePath(PNG_BASE64)).toBe(false);
	});

	it("ignores data URLs and unsupported extensions", () => {
		expect(looksLikeImageFilePath(`data:image/png;base64,${PNG_BASE64}`)).toBe(
			false,
		);
		expect(looksLikeImageFilePath("/tmp/vector.svg")).toBe(false);
		expect(looksLikeImageFilePath("C:\\Users\\me\\photo.webp")).toBe(false);
	});
});

describe("resolveImageInput", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "figma-image-input-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("passes through base64", () => {
		const resolved = resolveImageInput(`  ${PNG_BASE64}  \n`);
		expect(resolved.source).toBe("base64");
		expect(resolved.base64).toBe(PNG_BASE64);
	});

	it("strips a data URL prefix", () => {
		const resolved = resolveImageInput(`data:image/png;base64,${PNG_BASE64}`);
		expect(resolved.source).toBe("data-url");
		expect(resolved.base64).toBe(PNG_BASE64);
	});

	it("reads a local PNG and names the layer after the file", () => {
		const filePath = join(dir, "hero-image.png");
		writeFileSync(filePath, PNG_BYTES);

		const resolved = resolveImageInput(filePath);
		expect(resolved.source).toBe("file");
		expect(resolved.base64).toBe(PNG_BASE64);
		expect(resolved.name).toBe("hero-image");
		expect(resolved.filePath).toBe(filePath);
	});

	it("reads image paths containing a hash character", () => {
		const filePath = join(dir, "hero#final.png");
		writeFileSync(filePath, PNG_BYTES);

		const resolved = resolveImageInput(filePath);
		expect(resolved.source).toBe("file");
		expect(resolved.base64).toBe(PNG_BASE64);
		expect(resolved.name).toBe("hero#final");
	});

	it("reads a file:// URL and strips wrapping quotes", () => {
		const filePath = join(dir, "quoted.png");
		writeFileSync(filePath, PNG_BYTES);
		const url = pathToFileURL(filePath).href;

		const resolved = resolveImageInput(`"${url}"`);
		expect(resolved.source).toBe("file");
		expect(resolved.base64).toBe(PNG_BASE64);
	});

	it("throws a Local Mode hint when the file is missing", () => {
		expect(() =>
			resolveImageInput("C:\\Users\\nobody\\missing-photo.png"),
		).toThrow(/Image file not found/);
		expect(() =>
			resolveImageInput("C:\\Users\\nobody\\missing-photo.png"),
		).toThrow(/Local Mode/);
	});

	it("rejects empty input", () => {
		expect(() => resolveImageInput("   ")).toThrow(/imageData is required/);
	});

	it("rejects oversized raw base64 and data URLs", () => {
		const oversizedBase64 = Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64");

		expect(() => resolveImageInput(oversizedBase64)).toThrow(/Image is too large/);
		expect(() =>
			resolveImageInput(`data:image/png;base64,${oversizedBase64}`),
		).toThrow(/Image is too large/);
	});
});
