/**
 * Convert JSON Schema definitions to Zod validators
 */

import { z } from "zod";
import type { JSONSchema } from "./types.ts";

/**
 * Convert a JSON Schema definition to a Zod validator
 * Supports basic JSON Schema features commonly used for document validation
 */
export function jsonSchemaToZod(schema: JSONSchema): z.ZodType {
  // Handle enum first (works for any type)
  if (schema.enum) {
    if (schema.enum.length === 0) {
      throw new Error("JSON Schema enum must have at least one value");
    }
    // Type assertion needed because Zod expects at least 2 values for enum
    if (schema.enum.length === 1) {
      return z.literal(schema.enum[0] as string | number | boolean);
    }

    // Check if all enum values are strings
    const allStrings = schema.enum.every((v) => typeof v === "string");
    if (allStrings) {
      return z.enum(schema.enum as [string, ...string[]]);
    }

    // Mixed types or numbers - use union of literals
    return z.union([
      z.literal(schema.enum[0] as string | number | boolean),
      z.literal(schema.enum[1] as string | number | boolean),
      ...schema.enum.slice(2).map((v) => z.literal(v as string | number | boolean)),
    ] as [
      z.ZodLiteral<string | number | boolean>,
      z.ZodLiteral<string | number | boolean>,
      ...z.ZodLiteral<string | number | boolean>[],
    ]);
  }

  // Handle by type
  switch (schema.type) {
    case "string": {
      let validator = z.string();
      if (schema.minLength !== undefined) {
        validator = validator.min(schema.minLength);
      }
      if (schema.maxLength !== undefined) {
        validator = validator.max(schema.maxLength);
      }
      if (schema.pattern !== undefined) {
        validator = validator.regex(new RegExp(schema.pattern));
      }
      return validator;
    }

    case "number": {
      let validator = z.number();
      if (schema.minimum !== undefined) {
        validator = validator.min(schema.minimum);
      }
      if (schema.maximum !== undefined) {
        validator = validator.max(schema.maximum);
      }
      return validator;
    }

    case "boolean":
      return z.boolean();

    case "null":
      return z.null();

    case "array": {
      if (!schema.items) {
        // Array of unknown items
        return z.array(z.unknown());
      }
      const itemValidator = jsonSchemaToZod(schema.items as JSONSchema);
      return z.array(itemValidator);
    }

    case "object": {
      if (!schema.properties) {
        // Object with unknown properties
        return z.record(z.string(), z.unknown());
      }

      const shape: Record<string, z.ZodType> = {};
      const required = new Set(schema.required || []);

      for (const [key, propSchema] of Object.entries(schema.properties)) {
        let propValidator = jsonSchemaToZod(propSchema as JSONSchema);

        // Make optional if not in required list
        if (!required.has(key)) {
          propValidator = propValidator.optional();
        }

        shape[key] = propValidator;
      }

      let validator = z.object(shape);

      // Handle additionalProperties
      if (schema.additionalProperties === false) {
        validator = validator.strict();
      } else if (typeof schema.additionalProperties === "object") {
        // Allow additional properties with schema validation
        // Zod doesn't directly support this, so we use passthrough
        validator = validator.passthrough();
      } else {
        // additionalProperties: true or undefined - allow any additional props
        validator = validator.passthrough();
      }

      return validator;
    }

    default:
      // No type specified - accept anything
      return z.unknown();
  }
}

/**
 * Validate that a JSON Schema is valid and supported
 * Throws descriptive error if schema uses unsupported features
 */
export function validateJSONSchema(schema: JSONSchema, path = "schema"): void {
  if (schema.type === "object" && schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      validateJSONSchema(propSchema as JSONSchema, `${path}.properties.${key}`);
    }
  }

  if (schema.type === "array" && schema.items) {
    validateJSONSchema(schema.items as JSONSchema, `${path}.items`);
  }

  // Check for unsupported features
  const unsupportedKeys = Object.keys(schema).filter(
    (key) =>
      ![
        "type",
        "properties",
        "items",
        "required",
        "enum",
        "minimum",
        "maximum",
        "minLength",
        "maxLength",
        "pattern",
        "additionalProperties",
        "description",
      ].includes(key),
  );

  if (unsupportedKeys.length > 0) {
    throw new Error(
      `Unsupported JSON Schema features at ${path}: ${unsupportedKeys.join(", ")}. ` +
        `Supported: type, properties, items, required, enum, minimum, maximum, minLength, maxLength, pattern, additionalProperties, description`,
    );
  }
}
