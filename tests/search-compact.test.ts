import { compactSearchResult, descriptionTeaser, isPrivateOrRetiredName } from "../src/core/design-system-manifest";

describe("compact component search results", () => {
	it("keeps the first sentence, capped", () => {
		expect(descriptionTeaser("A button. It has variants.")).toBe("A button.");
		expect(descriptionTeaser("x".repeat(300))?.length).toBe(118);
		expect(descriptionTeaser(undefined)).toBeUndefined();
	});
	it("drops fields the name already carries", () => {
		const r = compactSearchResult({ name: "Atoms/Button", key: "k", category: "Atoms", description: "One. Two.", descriptionTruncated: true });
		expect(r).toEqual({ name: "Atoms/Button", key: "k", description: "One." });
	});
	it("recognises private and retired components by name", () => {
		for (const n of [".Calendar", "Atoms/_Base", "Archive/Old Card", "Deprecated Button", "Card (do not use)", "Legacy/Modal", "Button [deprecated]"]) expect(isPrivateOrRetiredName(n)).toBe(true);
		for (const n of ["Atoms/Button", "Molecules/Date.Picker", "Card", "Icons/Archive", "Archive Button", "Icon / Archive Box", "Old Paper Texture"]) expect(isPrivateOrRetiredName(n)).toBe(false);
	});
});
