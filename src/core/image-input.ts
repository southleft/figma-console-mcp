import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

/** Figma's `createImage` accepts PNG, JPEG, and GIF only. */
const IMAGE_EXT = /\.(png|jpe?g|gif)$/i;

/** Keep websocket payloads bounded; Figma also rejects very large images. */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export type ResolvedImageInput = {
	base64: string;
	source: "base64" | "data-url" | "file";
	filePath?: string;
	name?: string;
};

/**
 * True when `value` is a filesystem path (or file URL) to a PNG/JPEG/GIF —
 * including Windows paths (`C:\...`) and `file://` URLs.
 *
 * JPEG base64 starts with `/9j/` and has no filename extension, so it is not
 * treated as a path. PNG base64 (`iVBORw0KGgo...`) also has no extension.
 */
export function looksLikeImageFilePath(value: string): boolean {
	const s = stripWrappingQuotes(value.trim());
	if (!s || /^data:/i.test(s)) return false;
	if (/^file:/i.test(s)) return true;
	return IMAGE_EXT.test(s);
}

/**
 * Normalize tool input into raw base64 for the Desktop Bridge.
 * Reads local files in Local Mode; Cloud Mode cannot see the user's disk.
 */
export function resolveImageInput(imageData: string): ResolvedImageInput {
	if (typeof imageData !== "string" || !imageData.trim()) {
		throw new Error(
			"imageData is required. Pass an absolute PNG/JPEG/GIF file path (Local Mode) or base64-encoded image bytes.",
		);
	}

	const trimmed = stripWrappingQuotes(imageData.trim());

	const dataUrl = /^data:image\/[a-zA-Z0-9+.-]+;base64,([\s\S]+)$/i.exec(
		trimmed,
	);
	if (dataUrl) {
		const base64 = normalizeBase64(dataUrl[1]);
		return { base64, source: "data-url" };
	}

	if (looksLikeImageFilePath(trimmed)) {
		return readImageFile(trimmed);
	}

	return { base64: normalizeBase64(trimmed), source: "base64" };
}

function stripWrappingQuotes(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function normalizeBase64(value: string): string {
	const base64 = value.replace(/\s/g, "");
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	const decodedBytes = Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
	assertImageSize(decodedBytes);
	return base64;
}

function assertImageSize(bytes: number): void {
	if (bytes > MAX_IMAGE_BYTES) {
		throw new Error(
			`Image is too large (${Math.ceil(bytes / (1024 * 1024))}MB). Maximum is ${MAX_IMAGE_BYTES / (1024 * 1024)}MB.`,
		);
	}
}

function readImageFile(rawPath: string): ResolvedImageInput {
	let filePath = rawPath;

	if (/^file:/i.test(filePath)) {
		try {
			filePath = fileURLToPath(filePath);
		} catch {
			throw new Error(`Invalid file URL: ${rawPath}`);
		}
	}

	if (filePath.startsWith("~")) {
		const home = process.env.USERPROFILE || process.env.HOME;
		if (home) {
			filePath = home + filePath.slice(1);
		}
	}

	let exists = false;
	try {
		exists = existsSync(filePath);
	} catch {
		exists = false;
	}

	if (!exists) {
		throw new Error(
			`Image file not found: ${filePath}. File paths only work in Local Mode (the MCP server must run on the same machine as the file). In Cloud Mode, pass base64 PNG/JPEG data instead. Clipboard paste is not supported.`,
		);
	}

	const ext = extname(filePath);
	if (!IMAGE_EXT.test(ext)) {
		throw new Error(
			`Unsupported image type "${ext || "(none)"}". Figma accepts PNG, JPEG, or GIF.`,
		);
	}

	const stat = statSync(filePath);
	assertImageSize(stat.size);

	return {
		base64: readFileSync(filePath).toString("base64"),
		source: "file",
		filePath,
		name: basename(filePath, ext),
	};
}
