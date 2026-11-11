/**
 * Tests for the Buzz field serializers in figma-desktop-bridge/code.js.
 *
 * The helpers are evaluated straight from the plugin source, so a property
 * dropped from the copy list fails here instead of silently vanishing from
 * figma_buzz_get_text_content / figma_buzz_get_media_content output.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const codeJs = readFileSync(join(process.cwd(), "figma-desktop-bridge", "code.js"), "utf8");

const start = codeJs.indexOf("function __serializeBuzzNode(");
const end = codeJs.indexOf("// Immediately fetch and send variables data to UI");
if (start === -1 || end === -1 || end <= start) {
	throw new Error("Could not locate the Buzz serializer helpers in code.js");
}

const serializeBuzzField = new Function(`${codeJs.slice(start, end)}; return __serializeBuzzField;`)() as (
	field: Record<string, unknown>,
	index: number,
) => Record<string, unknown>;

describe("Buzz field serialization (plugin-side)", () => {
	it("keeps the image hash on media fields", () => {
		const node = { id: "1:2", type: "RECTANGLE", name: "Hero image", x: 0, y: 0, width: 1080, height: 1080 };
		const result = serializeBuzzField({ type: "IMAGE", hash: "abc123", node }, 0);

		expect(result).toMatchObject({
			index: 0,
			type: "IMAGE",
			hash: "abc123",
			node: { id: "1:2", type: "RECTANGLE", name: "Hero image", width: 1080, height: 1080 },
		});
	});

	it("keeps a null hash on empty media fields", () => {
		const result = serializeBuzzField({ type: null, hash: null, node: null }, 1);

		expect(result).toMatchObject({ index: 1, type: null, hash: null });
		expect(result.node).toBeUndefined();
	});

	it("keeps the value on text fields", () => {
		const node = { id: "3:4", type: "TEXT", name: "Headline" };
		const result = serializeBuzzField({ value: "Summer sale", node }, 0);

		expect(result).toMatchObject({ index: 0, value: "Summer sale", node: { id: "3:4", type: "TEXT", name: "Headline" } });
	});

	it("drops non-serializable values", () => {
		const result = serializeBuzzField({ value: "Hi", setValueAsync: () => Promise.resolve(), extra: { nested: true } }, 0);

		expect(result.value).toBe("Hi");
		expect(result).not.toHaveProperty("setValueAsync");
		expect(result).not.toHaveProperty("extra");
	});
});
