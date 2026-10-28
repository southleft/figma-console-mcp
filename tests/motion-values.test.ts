import { MOTION_VALUE_JS } from "../src/core/write-tools";

const motionValue = new Function(`${MOTION_VALUE_JS}; return motionValue;`)() as (type: string, value: unknown) => unknown;

describe("motionValue (plugin-side TIMING/EASING conversion)", () => {
	it("reads TIMING as seconds, from numbers or ms/s strings", () => {
		expect(motionValue("TIMING", 0.3)).toBe(0.3);
		expect(motionValue("TIMING", "300ms")).toBe(0.3);
		expect(motionValue("TIMING", "0.25s")).toBe(0.25);
		expect(motionValue("TIMING", "1.5")).toBe(1.5);
		expect(() => motionValue("TIMING", "fast")).toThrow(/not a duration/);
	});

	it("reads EASING from cubic-bezier(), spring() and Figma names", () => {
		expect(motionValue("EASING", "cubic-bezier(0.2, 0, 0, 1)")).toEqual({
			type: "CUSTOM_CUBIC_BEZIER",
			easingFunctionCubicBezier: { x1: 0.2, y1: 0, x2: 0, y2: 1 },
		});
		expect(motionValue("EASING", "spring(0.4)")).toEqual({ type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: 0.4 } });
		expect(motionValue("EASING", "ease_out")).toEqual({ type: "EASE_OUT" });
		expect(motionValue("EASING", "BOUNCY")).toEqual({ type: "BOUNCY" });
		expect(() => motionValue("EASING", "cubic-bezier(1, 2)")).toThrow(/Invalid cubic-bezier/);
		expect(() => motionValue("EASING", "wobbly")).toThrow(/not cubic-bezier/);
	});

	it("passes other types through", () => {
		expect(motionValue("FLOAT", 4)).toBe(4);
		expect(motionValue("STRING", "x")).toBe("x");
	});
});
