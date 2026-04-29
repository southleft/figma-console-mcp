import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Buzz bootstrap support", () => {
	it("includes buzz in the Desktop Bridge manifest editor types", () => {
		const manifestPath = join(process.cwd(), "figma-desktop-bridge", "manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

		expect(manifest.editorType).toContain("buzz");
	});

	it("skips eager variable bootstrap in buzz mode", () => {
		const codePath = join(process.cwd(), "figma-desktop-bridge", "code.js");
		const code = readFileSync(codePath, "utf8");

		expect(code).toContain("__editorType === 'buzz'");
		expect(code).toContain("mode — skipping variables fetch");
	});
});
