/**
 * Elicitation-based confirmations for destructive operations.
 */
import { askUser, clientSupportsElicitation, confirmationsDisabled } from "../src/core/confirm";

function fakeServer(caps: unknown, elicit?: (p: any, o: any) => Promise<any>) {
	return {
		server: {
			getClientCapabilities: () => caps,
			elicitInput: elicit ?? (async () => ({ action: "accept", content: {} })),
		},
	} as any;
}

const req = { message: "Delete?", fields: { confirm: { type: "boolean" as const } } };

describe("confirm", () => {
	const saved = process.env.FIGMA_CONSOLE_CONFIRM_DESTRUCTIVE;
	afterEach(() => {
		if (saved === undefined) delete process.env.FIGMA_CONSOLE_CONFIRM_DESTRUCTIVE;
		else process.env.FIGMA_CONSOLE_CONFIRM_DESTRUCTIVE = saved;
	});

	it("detects form support (empty object = form-only, url-only = no form)", () => {
		expect(clientSupportsElicitation(fakeServer(undefined))).toBe(false);
		expect(clientSupportsElicitation(fakeServer({}))).toBe(false);
		expect(clientSupportsElicitation(fakeServer({ elicitation: {} }))).toBe(true);
		expect(clientSupportsElicitation(fakeServer({ elicitation: { form: {}, url: {} } }))).toBe(true);
		expect(clientSupportsElicitation(fakeServer({ elicitation: { url: {} } }))).toBe(false);
	});

	it("returns unsupported when the client can't show a form", async () => {
		const elicit = jest.fn();
		expect(await askUser(fakeServer({}, elicit), req)).toEqual({ status: "unsupported" });
		expect(elicit).not.toHaveBeenCalled();
		expect(await askUser(undefined, req)).toEqual({ status: "unsupported" });
	});

	it("honors the opt-out env var", async () => {
		process.env.FIGMA_CONSOLE_CONFIRM_DESTRUCTIVE = "off";
		expect(confirmationsDisabled()).toBe(true);
		const elicit = jest.fn();
		expect(await askUser(fakeServer({ elicitation: {} }, elicit), req)).toEqual({ status: "unsupported" });
		expect(elicit).not.toHaveBeenCalled();
	});

	it("maps accept / decline / cancel", async () => {
		const accept = fakeServer({ elicitation: {} }, async () => ({ action: "accept", content: { confirm: true } }));
		expect(await askUser(accept, req)).toEqual({ status: "accepted", content: { confirm: true } });
		const decline = fakeServer({ elicitation: {} }, async () => ({ action: "decline" }));
		expect((await askUser(decline, req)).status).toBe("declined");
		const cancel = fakeServer({ elicitation: {} }, async () => ({ action: "cancel" }));
		expect((await askUser(cancel, req)).status).toBe("cancelled");
	});

	it("never proceeds when the prompt fails or times out", async () => {
		const timeout = fakeServer({ elicitation: {} }, async () => {
			throw new Error("Request timed out");
		});
		expect((await askUser(timeout, req)).status).toBe("timeout");
		const broken = fakeServer({ elicitation: {} }, async () => {
			throw new Error("connection closed");
		});
		expect((await askUser(broken, req)).status).toBe("error");
	});

	it("sends a form-mode request with a long timeout", async () => {
		const elicit = jest.fn(async () => ({ action: "decline" }));
		await askUser(fakeServer({ elicitation: { form: {} } }, elicit), { ...req, required: ["confirm"] });
		const [params, opts] = (elicit.mock.calls[0] as unknown) as [any, any];
		expect(params.mode).toBe("form");
		expect(params.requestedSchema).toEqual({ type: "object", properties: req.fields, required: ["confirm"] });
		expect(opts.timeout).toBeGreaterThanOrEqual(60_000);
	});
});
