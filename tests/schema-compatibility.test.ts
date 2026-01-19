import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Schema Compatibility Tests
 *
 * These tests ensure that the MCP tool schemas are strictly typed and compatible
 * with LLMs that require explicit JSON Schema types (like Gemini).
 *
 * The key issue: Gemini models require strictly typed schemas. When z.any() is used,
 * it converts to `{}` (empty schema) in JSON Schema, which Gemini rejects.
 *
 * These tests verify:
 * 1. No schemas produce empty objects `{}` indicating loose typing
 * 2. Schemas accept valid inputs for all supported types
 * 3. Schemas correctly reject invalid inputs
 */

// Define the schemas exactly as they appear in local.ts
const schemas = {
	// figma_update_variable - value parameter
	updateVariableValue: z.union([z.string(), z.number(), z.boolean()]).describe(
		"The new value. For COLOR: hex string like '#FF0000'. For FLOAT: number. For STRING: text. For BOOLEAN: true/false."
	),

	// figma_create_variable - valuesByMode parameter
	createVariableValuesByMode: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe(
		"Optional initial values by mode ID. Example: { '1:0': '#FF0000', '1:1': '#0000FF' }"
	),

	// figma_instantiate_component - overrides parameter
	instantiateComponentOverrides: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe(
		"Property overrides (e.g., { 'Button Label': 'Click Me' })"
	),

	// figma_add_component_property - defaultValue parameter
	addComponentPropertyDefaultValue: z.union([z.string(), z.number(), z.boolean()]).describe(
		"Default value for the property. BOOLEAN: true/false, TEXT: string, INSTANCE_SWAP: component key, VARIANT: variant value"
	),

	// figma_edit_component_property - newValue parameter
	editComponentPropertyNewValue: z.object({
		name: z.string().optional().describe("New name for the property"),
		defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional().describe("New default value"),
		preferredValues: z.array(z.object({
			type: z.enum(["COMPONENT", "COMPONENT_SET"]).describe("Type of preferred value"),
			key: z.string().describe("Component or component set key"),
		})).optional().describe("Preferred values (INSTANCE_SWAP only)"),
	}).describe("Object with the values to update"),
};

/**
 * Check if a JSON Schema represents z.any() - which produces an empty schema
 * z.any() converts to: { "$schema": "..." } with no type or structural properties
 *
 * Valid JSON Schema patterns that look empty but are NOT z.any():
 * - "not": {} - valid negation pattern for optional handling
 * - Schemas with $schema, type, anyOf, oneOf, allOf, properties, etc.
 */
function isEmptyAnySchema(schema: unknown): boolean {
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
function containsAnyTypeSchema(schema: unknown, path = ""): string[] {
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

describe("Schema Compatibility Tests", () => {
	describe("JSON Schema Strict Typing", () => {
		it("updateVariableValue should not contain any empty schemas", () => {
			const jsonSchema = zodToJsonSchema(schemas.updateVariableValue);
			const issues = containsAnyTypeSchema(jsonSchema);
			expect(issues).toEqual([]);
		});

		it("createVariableValuesByMode should not contain any empty schemas", () => {
			const jsonSchema = zodToJsonSchema(schemas.createVariableValuesByMode);
			const issues = containsAnyTypeSchema(jsonSchema);
			expect(issues).toEqual([]);
		});

		it("instantiateComponentOverrides should not contain any empty schemas", () => {
			const jsonSchema = zodToJsonSchema(schemas.instantiateComponentOverrides);
			const issues = containsAnyTypeSchema(jsonSchema);
			expect(issues).toEqual([]);
		});

		it("addComponentPropertyDefaultValue should not contain any empty schemas", () => {
			const jsonSchema = zodToJsonSchema(schemas.addComponentPropertyDefaultValue);
			const issues = containsAnyTypeSchema(jsonSchema);
			expect(issues).toEqual([]);
		});

		it("editComponentPropertyNewValue should not contain any empty schemas", () => {
			const jsonSchema = zodToJsonSchema(schemas.editComponentPropertyNewValue);
			const issues = containsAnyTypeSchema(jsonSchema);
			expect(issues).toEqual([]);
		});
	});

	describe("JSON Schema Structure Validation", () => {
		it("updateVariableValue should produce explicit type array for union", () => {
			const jsonSchema = zodToJsonSchema(schemas.updateVariableValue) as Record<string, unknown>;
			// zod-to-json-schema produces type: ["string", "number", "boolean"] for unions of primitives
			const typeArray = jsonSchema.type;
			expect(Array.isArray(typeArray)).toBe(true);
			expect(typeArray).toContain("string");
			expect(typeArray).toContain("number");
			expect(typeArray).toContain("boolean");
		});

		it("createVariableValuesByMode should have explicit additionalProperties type", () => {
			const jsonSchema = zodToJsonSchema(schemas.createVariableValuesByMode) as Record<string, unknown>;
			// Should have type or anyOf structure (optional produces anyOf)
			expect(jsonSchema.type || jsonSchema.anyOf).toBeDefined();
		});

		it("editComponentPropertyNewValue preferredValues should have explicit object schema", () => {
			const jsonSchema = zodToJsonSchema(schemas.editComponentPropertyNewValue) as Record<string, unknown>;
			const properties = jsonSchema.properties as Record<string, unknown>;
			expect(properties.preferredValues).toBeDefined();
		});
	});

	describe("Zod Schema Validation - Valid Inputs", () => {
		describe("updateVariableValue", () => {
			it("should accept string values (COLOR)", () => {
				expect(() => schemas.updateVariableValue.parse("#FF0000")).not.toThrow();
				expect(() => schemas.updateVariableValue.parse("hello")).not.toThrow();
			});

			it("should accept number values (FLOAT)", () => {
				expect(() => schemas.updateVariableValue.parse(42)).not.toThrow();
				expect(() => schemas.updateVariableValue.parse(3.14)).not.toThrow();
				expect(() => schemas.updateVariableValue.parse(0)).not.toThrow();
				expect(() => schemas.updateVariableValue.parse(-100)).not.toThrow();
			});

			it("should accept boolean values (BOOLEAN)", () => {
				expect(() => schemas.updateVariableValue.parse(true)).not.toThrow();
				expect(() => schemas.updateVariableValue.parse(false)).not.toThrow();
			});
		});

		describe("createVariableValuesByMode", () => {
			it("should accept undefined (optional)", () => {
				expect(() => schemas.createVariableValuesByMode.parse(undefined)).not.toThrow();
			});

			it("should accept valid record with string values", () => {
				expect(() => schemas.createVariableValuesByMode.parse({
					"1:0": "#FF0000",
					"1:1": "#0000FF",
				})).not.toThrow();
			});

			it("should accept valid record with number values", () => {
				expect(() => schemas.createVariableValuesByMode.parse({
					"1:0": 16,
					"1:1": 24,
				})).not.toThrow();
			});

			it("should accept valid record with boolean values", () => {
				expect(() => schemas.createVariableValuesByMode.parse({
					"1:0": true,
					"1:1": false,
				})).not.toThrow();
			});

			it("should accept valid record with mixed value types", () => {
				expect(() => schemas.createVariableValuesByMode.parse({
					"color": "#FF0000",
					"size": 16,
					"enabled": true,
				})).not.toThrow();
			});
		});

		describe("instantiateComponentOverrides", () => {
			it("should accept undefined (optional)", () => {
				expect(() => schemas.instantiateComponentOverrides.parse(undefined)).not.toThrow();
			});

			it("should accept valid override object", () => {
				expect(() => schemas.instantiateComponentOverrides.parse({
					"Button Label": "Click Me",
					"Show Icon": true,
					"Icon Size": 24,
				})).not.toThrow();
			});
		});

		describe("addComponentPropertyDefaultValue", () => {
			it("should accept string values", () => {
				expect(() => schemas.addComponentPropertyDefaultValue.parse("Default Text")).not.toThrow();
				expect(() => schemas.addComponentPropertyDefaultValue.parse("component-key-123")).not.toThrow();
			});

			it("should accept boolean values", () => {
				expect(() => schemas.addComponentPropertyDefaultValue.parse(true)).not.toThrow();
				expect(() => schemas.addComponentPropertyDefaultValue.parse(false)).not.toThrow();
			});

			it("should accept number values", () => {
				expect(() => schemas.addComponentPropertyDefaultValue.parse(0)).not.toThrow();
				expect(() => schemas.addComponentPropertyDefaultValue.parse(100)).not.toThrow();
			});
		});

		describe("editComponentPropertyNewValue", () => {
			it("should accept object with just name", () => {
				expect(() => schemas.editComponentPropertyNewValue.parse({
					name: "New Property Name",
				})).not.toThrow();
			});

			it("should accept object with defaultValue", () => {
				expect(() => schemas.editComponentPropertyNewValue.parse({
					defaultValue: "new default",
				})).not.toThrow();
				expect(() => schemas.editComponentPropertyNewValue.parse({
					defaultValue: true,
				})).not.toThrow();
				expect(() => schemas.editComponentPropertyNewValue.parse({
					defaultValue: 42,
				})).not.toThrow();
			});

			it("should accept object with preferredValues for INSTANCE_SWAP", () => {
				expect(() => schemas.editComponentPropertyNewValue.parse({
					preferredValues: [
						{ type: "COMPONENT", key: "component-key-123" },
						{ type: "COMPONENT_SET", key: "component-set-456" },
					],
				})).not.toThrow();
			});

			it("should accept object with all fields", () => {
				expect(() => schemas.editComponentPropertyNewValue.parse({
					name: "Updated Name",
					defaultValue: "new default",
					preferredValues: [
						{ type: "COMPONENT", key: "key-123" },
					],
				})).not.toThrow();
			});

			it("should accept empty object (all fields optional)", () => {
				expect(() => schemas.editComponentPropertyNewValue.parse({})).not.toThrow();
			});
		});
	});

	describe("Zod Schema Validation - Invalid Inputs", () => {
		describe("updateVariableValue", () => {
			it("should reject null", () => {
				expect(() => schemas.updateVariableValue.parse(null)).toThrow();
			});

			it("should reject undefined", () => {
				expect(() => schemas.updateVariableValue.parse(undefined)).toThrow();
			});

			it("should reject objects", () => {
				expect(() => schemas.updateVariableValue.parse({ value: "test" })).toThrow();
			});

			it("should reject arrays", () => {
				expect(() => schemas.updateVariableValue.parse(["test"])).toThrow();
			});
		});

		describe("createVariableValuesByMode", () => {
			it("should reject records with invalid value types", () => {
				expect(() => schemas.createVariableValuesByMode.parse({
					"1:0": { nested: "object" },
				})).toThrow();
			});

			it("should reject records with array values", () => {
				expect(() => schemas.createVariableValuesByMode.parse({
					"1:0": [1, 2, 3],
				})).toThrow();
			});

			it("should reject records with null values", () => {
				expect(() => schemas.createVariableValuesByMode.parse({
					"1:0": null,
				})).toThrow();
			});
		});

		describe("editComponentPropertyNewValue", () => {
			it("should reject preferredValues with invalid type enum", () => {
				expect(() => schemas.editComponentPropertyNewValue.parse({
					preferredValues: [
						{ type: "INVALID_TYPE", key: "key-123" },
					],
				})).toThrow();
			});

			it("should reject preferredValues without key", () => {
				expect(() => schemas.editComponentPropertyNewValue.parse({
					preferredValues: [
						{ type: "COMPONENT" },
					],
				})).toThrow();
			});

			it("should reject preferredValues without type", () => {
				expect(() => schemas.editComponentPropertyNewValue.parse({
					preferredValues: [
						{ key: "key-123" },
					],
				})).toThrow();
			});

			it("should reject defaultValue with object type", () => {
				expect(() => schemas.editComponentPropertyNewValue.parse({
					defaultValue: { nested: "object" },
				})).toThrow();
			});
		});
	});

	describe("Gemini Compatibility Simulation", () => {
		/**
		 * Simulates what Gemini expects: explicit types in JSON Schema
		 * Gemini fails when it encounters schemas like `{}` or schemas without explicit type
		 */
		it("all schemas should have explicit types (not empty objects)", () => {
			const allSchemas = [
				{ name: "updateVariableValue", schema: schemas.updateVariableValue },
				{ name: "createVariableValuesByMode", schema: schemas.createVariableValuesByMode },
				{ name: "instantiateComponentOverrides", schema: schemas.instantiateComponentOverrides },
				{ name: "addComponentPropertyDefaultValue", schema: schemas.addComponentPropertyDefaultValue },
				{ name: "editComponentPropertyNewValue", schema: schemas.editComponentPropertyNewValue },
			];

			for (const { name, schema } of allSchemas) {
				const jsonSchema = zodToJsonSchema(schema);
				const issues = containsAnyTypeSchema(jsonSchema);

				if (issues.length > 0) {
					throw new Error(`Schema "${name}" has empty schema issues:\n${issues.join("\n")}`);
				}
			}
		});

		it("JSON Schema should have explicit type array for primitive unions", () => {
			const unionSchemas = [
				{ name: "updateVariableValue", schema: schemas.updateVariableValue },
				{ name: "addComponentPropertyDefaultValue", schema: schemas.addComponentPropertyDefaultValue },
			];

			for (const { name, schema } of unionSchemas) {
				const jsonSchema = zodToJsonSchema(schema) as Record<string, unknown>;
				// zod-to-json-schema produces type: ["string", "number", "boolean"] for primitive unions
				const typeArray = jsonSchema.type;
				expect(Array.isArray(typeArray)).toBe(true);
				expect((typeArray as string[]).length).toBeGreaterThan(1);
			}
		});
	});
});
