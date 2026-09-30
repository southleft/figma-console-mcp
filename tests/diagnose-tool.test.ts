import { registerDiagnoseTool, type DiagnoseToolOptions } from "../src/core/diagnose-tool";

async function report(opts: DiagnoseToolOptions): Promise<string> {
	let handler: any;
	const server: any = { tool: (_n: string, _d: string, _s: unknown, h: any) => { handler = h; } };
	registerDiagnoseTool(server, opts);
	const res = await handler({ verbose: false });
	return JSON.parse(res.content[0].text).report as string;
}

describe("figma_diagnose", () => {
	it("cloud, never paired: tells the user to call figma_pair_plugin", async () => {
		const r = await report({ mode: "cloud", getServerVersion: () => "1.2.3", getPluginState: () => null, getTokenState: () => ({ hasToken: true, source: "bearer" }) });
		expect(r).toContain("Server version: 1.2.3");
		expect(r).toContain("figma_pair_plugin");
		expect(r).not.toContain("No WebSocket server");
		expect(r).toContain("Figma access token detected (source: bearer)");
		expect(r).not.toContain("No Figma access token detected");
	});

	it("cloud, paired but plugin offline: gives cloud reconnect advice, not local advice", async () => {
		const r = await report({ mode: "cloud", getServerVersion: () => "1", getPluginState: () => ({ connected: false }) });
		expect(r).toContain("not connected to the cloud relay");
		expect(r).not.toContain("close and reopen it once");
	});

	it("cloud, connected: names the relay and the file", async () => {
		const r = await report({ mode: "cloud", getServerVersion: () => "1", getPluginState: () => ({ connected: true, fileName: "Tokens", fileKey: "abc" }) });
		expect(r).toContain("connected through the cloud relay");
		expect(r).not.toContain("connected on connected");
		expect(r).toContain("Active file: **Tokens**");
	});

	it("local, disconnected: keeps the local advice", async () => {
		const r = await report({ mode: "local", getServerVersion: () => "1", getPluginState: () => ({ connected: false, port: 9223 }) });
		expect(r).toContain("listening on port 9223");
		expect(r).toContain("close and reopen it once");
	});
});
