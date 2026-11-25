/**
 * Elicitation-based confirmations (v2 multi-round-trip model).
 */
import { confirmStep, confirmationsDisabled, supportsForm } from "../src/core/confirm";

const req = { message: "Delete?", fields: { confirm: { type: "boolean" as const } }, required: ["confirm"] };
const server = (caps: unknown) => ({ server: { getClientCapabilities: () => caps } }) as any;
const ctx = (inputResponses?: Record<string, unknown>, envelope?: Record<string, unknown>) => ({
	mcpReq: { inputResponses, envelope },
});

describe("confirmStep", () => {
	const saved = process.env.FIGMA_CONSOLE_CONFIRM_DESTRUCTIVE;
	afterEach(() => {
		if (saved === undefined) delete process.env.FIGMA_CONSOLE_CONFIRM_DESTRUCTIVE;
		else process.env.FIGMA_CONSOLE_CONFIRM_DESTRUCTIVE = saved;
	});

	it("detects form support (empty object = form-only, url-only = no form)", () => {
		expect(supportsForm(undefined)).toBe(false);
		expect(supportsForm({})).toBe(false);
		expect(supportsForm({ elicitation: {} })).toBe(true);
		expect(supportsForm({ elicitation: { form: {}, url: {} } })).toBe(true);
		expect(supportsForm({ elicitation: { url: {} } })).toBe(false);
	});

	it("asks with a form-mode input_required result on the first pass", () => {
		const step = confirmStep(server({ elicitation: { form: {} } }), ctx(), "k", req);
		expect(step.status).toBe("ask");
		expect((step as any).result).toEqual({
			resultType: "input_required",
			inputRequests: {
				k: {
					method: "elicitation/create",
					params: {
						mode: "form",
						message: "Delete?",
						requestedSchema: { type: "object", properties: req.fields, required: ["confirm"] },
					},
				},
			},
		});
	});

	it("reads 2026-07-28 capabilities from the request envelope", () => {
		const env = { "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } } };
		expect(confirmStep(server(undefined), ctx(undefined, env), "k", req).status).toBe("ask");
	});

	it("maps the retried answer", () => {
		const s = server({ elicitation: {} });
		expect(confirmStep(s, ctx({ k: { action: "accept", content: { confirm: true } } }), "k", req)).toEqual({
			status: "accepted",
			content: { confirm: true },
		});
		expect(confirmStep(s, ctx({ k: { action: "decline" } }), "k", req).status).toBe("declined");
		expect(confirmStep(s, ctx({ k: { action: "cancel" } }), "k", req).status).toBe("cancelled");
	});

	it("is unsupported without form support, on the v1 SDK, or when opted out", () => {
		expect(confirmStep(server({}), ctx(), "k", req).status).toBe("unsupported");
		expect(confirmStep(server({ elicitation: {} }), {} as any, "k", req).status).toBe("unsupported");
		expect(confirmStep(server({ elicitation: {} }), undefined, "k", req).status).toBe("unsupported");
		process.env.FIGMA_CONSOLE_CONFIRM_DESTRUCTIVE = "off";
		expect(confirmationsDisabled()).toBe(true);
		expect(confirmStep(server({ elicitation: {} }), ctx(), "k", req).status).toBe("unsupported");
	});
});
