/**
 * Generates an example JSON payload from a JSON Schema object.
 *
 * Walks the schema's `properties` and `required` fields to produce a
 * representative object. Falls back to sensible defaults per type.
 *
 * @module
 */

type SchemaObject = Record<string, unknown>;

/**
 * Generate an example value from a JSON Schema node.
 *
 * @param schema - JSON Schema object (or sub-schema)
 * @returns A representative value matching the schema
 */
export function generateExamplePayload(schema: SchemaObject | undefined): Record<string, unknown> {
  if (!schema) return {};
  if (schema.type !== "object") return {};

  if (typeof schema.properties !== "object" || schema.properties === null) return {};
  const properties = schema.properties;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!isSchemaObject(value)) continue;
    result[key] = generateValueForProperty(value);
  }
  return result;
}

function isSchemaObject(value: unknown): value is SchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function generateValueForProperty(prop: SchemaObject): unknown {
  if (prop.default !== undefined) return prop.default;
  if (prop.example !== undefined) return prop.example;

  const type = typeof prop.type === "string" ? prop.type : undefined;
  const desc = typeof prop.description === "string" ? prop.description : undefined;
  switch (type) {
    case "string":
      return desc
        ? `<${(desc.split("(")[0] ?? desc).trim().toLowerCase()}>`
        : "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return generateExamplePayload(prop);
    default:
      return null;
  }
}
