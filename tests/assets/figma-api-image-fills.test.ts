/**
 * FigmaAPI.getImageFills (spec §5 item 5): GET /v1/files/:key/images, the same
 * request() path as getImages, and the token never reaches a log line.
 */

const mockLog = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
jest.mock("../../src/core/logger", () => ({ createChildLogger: () => mockLog, logger: mockLog }));

import { FigmaAPI, requiredScopeFor } from "../../src/core/figma-api";

const TOKEN = "figd_TOPSECRET_image_fills";

afterEach(() => {
	jest.restoreAllMocks();
	jest.clearAllMocks();
});

describe("FigmaAPI.getImageFills", () => {
	it("calls GET /v1/files/:key/images with the token header and returns meta.images", async () => {
		const payload = { error: false, status: 200, meta: { images: { ["a".repeat(40)]: "https://s3/a" } } };
		const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
		const api = new FigmaAPI({ accessToken: TOKEN });
		const res = await api.getImageFills("FILEKEY");
		expect(res).toEqual(payload);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.figma.com/v1/files/FILEKEY/images");
		expect((init.headers as Record<string, string>)["X-Figma-Token"]).toBe(TOKEN);
		expect(mockLog.info).toHaveBeenCalledWith({ fileKey: "FILEKEY" }, "Fetching image fill URLs");
		const logged = JSON.stringify([mockLog.info.mock.calls, mockLog.debug.mock.calls, mockLog.error.mock.calls]);
		expect(logged).not.toContain("TOPSECRET");
	});

	it("errors keep the load-bearing status prefix and name the scope, without the token", async () => {
		jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Forbidden", { status: 403 }));
		const err = await new FigmaAPI({ accessToken: TOKEN }).getImageFills("K").catch((e: Error) => e);
		expect((err as Error).message).toMatch(/^Figma API error \(403\): Forbidden — GET \/v1\/files\/K\/images needs the file_content:read scope/);
		expect((err as Error).message).not.toContain("TOPSECRET");
		expect(requiredScopeFor("GET", "https://api.figma.com/v1/files/K/images")).toBe("file_content:read");
	});
});
