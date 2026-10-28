import { isFigmaPAT, validateFigmaPAT } from "../src/core/figma-pat";

const reply = (status: number, body: unknown = {}) =>
	(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("validateFigmaPAT", () => {
	it("returns the user for a token Figma accepts", async () => {
		const user = { id: "1", handle: "tj", email: "x@y.z" };
		expect(await validateFigmaPAT("figd_ok", reply(200, user))).toEqual(user);
	});

	it("rejects a token Figma doesn't recognize (401)", async () => {
		expect(await validateFigmaPAT("figd_bad", reply(401, { status: 401, err: "Invalid token" }))).toBeNull();
	});

	it("accepts a real token that lacks current_user:read (403)", async () => {
		const user = await validateFigmaPAT("figd_noscope", reply(403, { status: 403, err: "Forbidden" }));
		expect(user).not.toBeNull();
		expect(user?.handle).toContain("current_user:read");
	});

	it("rejects when Figma can't be reached", async () => {
		const failing = (async () => {
			throw new Error("network");
		}) as unknown as typeof fetch;
		expect(await validateFigmaPAT("figd_x", failing)).toBeNull();
	});
});

describe("isFigmaPAT", () => {
	it("tells PATs from OAuth tokens", () => {
		expect(isFigmaPAT("figd_abc")).toBe(true);
		expect(isFigmaPAT("figu_abc")).toBe(false);
	});
});

import { requiredScopeFor } from "../src/core/figma-api";

describe("requiredScopeFor", () => {
	const api = "https://api.figma.com";
	it.each([
		["GET", "/v1/files/abc", "file_content:read"],
		["GET", "/v1/files/abc/nodes?ids=1:2", "file_content:read"],
		["GET", "/v1/images/abc?ids=1:2", "file_content:read"],
		["GET", "/v1/files/abc/versions", "file_versions:read"],
		["GET", "/v1/files/abc/components", "library_content:read"],
		["GET", "/v1/files/abc/styles", "library_content:read"],
		["GET", "/v1/components/key123", "library_assets:read"],
		["GET", "/v1/component_sets/key123", "library_assets:read"],
		["GET", "/v1/files/abc/comments", "file_comments:read"],
		["POST", "/v1/files/abc/comments", "file_comments:write"],
		["DELETE", "/v1/files/abc/comments/9", "file_comments:write"],
		["GET", "/v1/files/abc/variables/local", "file_variables:read"],
		["GET", "/v1/me", "current_user:read"],
	])("%s %s needs %s", (method, path, scope) => {
		expect(requiredScopeFor(method, api + path)).toBe(scope);
	});
	it("returns null for endpoints it doesn't know", () => {
		expect(requiredScopeFor("GET", api + "/v1/webhooks")).toBeNull();
	});
});

import { FigmaAPI } from "../src/core/figma-api";

describe("FigmaAPI 403 messages", () => {
	const realFetch = global.fetch;
	afterEach(() => {
		global.fetch = realFetch;
	});
	const respond403 = (body: string) => {
		global.fetch = (async () => new Response(body, { status: 403 })) as unknown as typeof fetch;
	};

	it("names the request and the missing scope, keeping the load-bearing prefix", async () => {
		respond403(JSON.stringify({ status: 403, err: "Forbidden" }));
		const api = new FigmaAPI({ accessToken: "figd_test" });
		await expect(api.getComponents("abc")).rejects.toThrow(
			/^Figma API error \(403\):.*GET \/v1\/files\/abc\/components needs the library_content:read scope/,
		);
	});

	it("explains the Enterprise gate for variables", async () => {
		respond403(JSON.stringify({ status: 403, err: "Forbidden" }));
		const api = new FigmaAPI({ accessToken: "figd_test" });
		await expect(api.getLocalVariables("abc")).rejects.toThrow(/file_variables:read scope, which Figma only grants on Enterprise plans/);
	});

	it("leaves token failures to the expired/invalid guidance", async () => {
		respond403(JSON.stringify({ status: 403, err: "Invalid token" }));
		const api = new FigmaAPI({ accessToken: "figd_test" });
		await expect(api.getComponents("abc")).rejects.toThrow(/expired or invalid/);
	});
});
