import type { ValidatedJSONSchema } from "@atlas/core/artifacts";

/**
 * Generates a deterministic stub value from a JSON schema.
 *
 * Rules:
 * - `string` → `"mock_{fieldName}"` (or `"mock_value"` if no field name)
 * - `number` → `42`
 * - `boolean` → `true`
 * - `null` → `null`
 * - `array` → single-element array with stubbed item (empty if no items schema)
 * - `object` → recurse into properties (only required fields if `required` is set)
 * - `enum` → first enum value
 *
 * @param schema - A JSON schema object
 * @param fieldName - Optional field name for string stub generation
 * @returns A deterministic value conforming to the schema
 */
export function generateStubFromSchema(schema: ValidatedJSONSchema, fieldName?: string): unknown {
  // Enum takes priority — use first value regardless of type
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum[0];
  }

  // Infer type from presence of properties if type is missing
  const type = schema.type ?? (schema.properties ? "object" : undefined);

  switch (type) {
    case "string":
      return fieldName ? `mock_${fieldName}` : "mock_value";

    case "number":
      return 42;

    case "boolean":
      return true;

    case "null":
      return null;

    case "array": {
      if (!schema.items) return [];
      return [generateStubFromSchema(schema.items)];
    }

    case "object": {
      if (!schema.properties) return {};

      const keys =
        schema.required && schema.required.length > 0
          ? schema.required
          : Object.keys(schema.properties);

      const result: Record<string, unknown> = {};
      for (const key of keys) {
        const propSchema = schema.properties[key];
        if (propSchema) {
          result[key] = generateStubFromSchema(propSchema, key);
        }
      }
      return result;
    }

    default:
      return undefined;
  }
}
