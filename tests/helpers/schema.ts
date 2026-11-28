/**
 * Shared JSON Schema checks for Gemini compatibility, used by
 * schema-compatibility.test.ts and the diagram tool tests.
 *
 * Gemini requires strictly typed schemas. z.any() converts to `{}` (an empty
 * schema), which Gemini rejects, so these helpers find empty schemas anywhere
 * in a converted tool schema.
 */

import { z } from "zod";

/** Same conversion the MCP SDK applies to tool schemas (server/zod-json-schema-compat). */
export const zodToJsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7", io: "input" });

/**
 * Check if a JSON Schema represents z.any() - which produces an empty schema
 * z.any() converts to: { "$schema": "..." } with no type or structural properties
 *
 * Valid JSON Schema patterns that look empty but are NOT z.any():
 * - "not": {} - valid negation pattern for optional handling
 * - Schemas with $schema, type, anyOf, oneOf, allOf, properties, etc.
 */
export function isEmptyAnySchema(schema: unknown): boolean {
	if (typeof schema !== "object" || schema === null) {
		return false;
	}

	const obj = schema as Record<string, unknown>;
	const keys = Object.keys(obj);

	// A schema is "empty" (z.any()) if it only has $schema or nothing at all
	// and lacks type, anyOf, oneOf, allOf, properties, items, additionalProperties, etc.
	const structuralKeys = ["type", "anyOf", "oneOf", "allOf", "properties", "items",
		"additionalProperties", "enum", "const", "pattern", "minimum", "maximum"];

	const hasStructure = structuralKeys.some(key => keys.includes(key));
	return !hasStructure && keys.every(k => k === "$schema" || k === "description");
}

/**
 * Recursively check if a JSON Schema contains problematic z.any() patterns
 * Ignores valid JSON Schema constructs like "not": {}
 */
export function containsAnyTypeSchema(schema: unknown, path = ""): string[] {
	const issues: string[] = [];

	if (typeof schema !== "object" || schema === null) {
		return issues;
	}

	const obj = schema as Record<string, unknown>;

	// Skip known valid empty patterns
	if (path.endsWith(".not")) {
		// "not": {} is a valid JSON Schema pattern
		return issues;
	}

	// Check if this looks like z.any() output (empty schema)
	if (isEmptyAnySchema(obj)) {
		issues.push(`Potential z.any() schema found at path: ${path || "root"} - has no type definition`);
		return issues;
	}

	// Recursively check nested schemas
	for (const [key, value] of Object.entries(obj)) {
		if (typeof value === "object" && value !== null) {
			const nestedPath = path ? `${path}.${key}` : key;
			issues.push(...containsAnyTypeSchema(value, nestedPath));
		}
	}

	return issues;
}
