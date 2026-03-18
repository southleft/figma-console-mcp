/**
 * withTimeout Tests
 *
 * Tests the promise timeout wrapper utility.
 * Includes a regression test for the unhandled rejection bug
 * where promise.finally() created an uncaught rejection branch.
 */

import { withTimeout } from "../src/core/figma-api";

describe("withTimeout", () => {
	it("resolves when promise completes before timeout", async () => {
		const result = await withTimeout(Promise.resolve("done"), 1000, "test");
		expect(result).toBe("done");
	});

	it("rejects with timeout error when promise is too slow", async () => {
		const slow = new Promise((resolve) => setTimeout(resolve, 5000));
		await expect(withTimeout(slow, 50, "slow-op")).rejects.toThrow(
			"slow-op timed out after 50ms"
		);
	});

	it("includes label and duration in timeout error message", async () => {
		const slow = new Promise((resolve) => setTimeout(resolve, 5000));
		await expect(withTimeout(slow, 10, "fetch-variables")).rejects.toThrow(
			"fetch-variables timed out after 10ms"
		);
	});

	it("clears timeout when promise resolves quickly (no lingering timers)", async () => {
		// If the timeout isn't cleared, this test would leave a dangling timer
		// that Jest's --detectOpenHandles would flag
		const result = await withTimeout(
			new Promise((resolve) => setTimeout(() => resolve("fast"), 5)),
			10000,
			"test"
		);
		expect(result).toBe("fast");
	});

	/**
	 * Regression test: withTimeout must not cause unhandled rejection
	 * when the wrapped promise rejects.
	 *
	 * Before the fix, promise.finally(() => clearTimeout(timeoutId))
	 * returned a new promise that inherited the rejection. Since nobody
	 * caught that branch, Node.js raised an unhandled rejection and
	 * crashed the process.
	 */
	it("does not cause unhandled rejection when promise rejects", async () => {
		const failing = new Promise((_, reject) => {
			setTimeout(() => reject(new Error("API down")), 5);
		});

		// If the bug is present, this test crashes the Jest worker
		// instead of catching the rejection normally
		await expect(withTimeout(failing, 1000, "test")).rejects.toThrow(
			"API down"
		);
	});

	it("propagates rejection from the original promise (not timeout)", async () => {
		const failing = new Promise((_, reject) => {
			setTimeout(() => reject(new Error("Network failure")), 5);
		});

		try {
			await withTimeout(failing, 1000, "api-call");
			fail("Should have thrown");
		} catch (err: any) {
			// Should get the original error, not a timeout error
			expect(err.message).toBe("Network failure");
			expect(err.message).not.toContain("timed out");
		}
	});
});
