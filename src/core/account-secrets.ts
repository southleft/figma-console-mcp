import { spawnSync } from "child_process";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "account-secrets" });

const SERVICE_NAME = "figma-console-mcp-account-token";

function runSecurity(args: string[]): { success: boolean; stdout: string; stderr: string } {
	const result = spawnSync("/usr/bin/security", args, {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	return {
		success: result.status === 0,
		stdout: (result.stdout || "").trim(),
		stderr: (result.stderr || "").trim(),
	};
}

export function saveAccountToken(accountId: string, token: string): boolean {
	if (!accountId || !token) return false;
	if (process.platform !== "darwin") return false;

	const out = runSecurity([
		"add-generic-password",
		"-a",
		accountId,
		"-s",
		SERVICE_NAME,
		"-w",
		token,
		"-U",
	]);

	if (!out.success) {
		logger.warn({ accountId, error: out.stderr || "unknown" }, "Failed to save account token to Keychain");
	}
	return out.success;
}

export function getAccountToken(accountId: string): string | null {
	if (!accountId) return null;
	if (process.platform !== "darwin") return null;

	const out = runSecurity([
		"find-generic-password",
		"-a",
		accountId,
		"-s",
		SERVICE_NAME,
		"-w",
	]);

	if (!out.success) return null;
	return out.stdout || null;
}

export function deleteAccountToken(accountId: string): boolean {
	if (!accountId) return false;
	if (process.platform !== "darwin") return false;

	const out = runSecurity([
		"delete-generic-password",
		"-a",
		accountId,
		"-s",
		SERVICE_NAME,
	]);

	if (!out.success) {
		logger.warn({ accountId, error: out.stderr || "unknown" }, "Failed to delete account token from Keychain");
	}
	return out.success;
}

