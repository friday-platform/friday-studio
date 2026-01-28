/**
 * Utilities for working with JSON schemas in the FSM engine.
 */

import type { JSONSchema } from "./types.ts";

/**
 * Type guard that checks if a value is a non-null object (record).
 * Used to safely narrow `unknown` types from LLM tool call args.
 *
 * @param value - The value to check
 * @returns `true` if value is a non-null object, `false` otherwise
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Determines whether a JSON schema defines meaningful properties that warrant
 * structured output enforcement via the `complete` tool.
 *
 * Returns `true` when the schema has at least one property defined.
 * Returns `false` for:
 * - Empty schemas (undefined or no type)
 * - Catch-all schemas (`additionalProperties: true` without properties)
 * - Schemas with empty properties object (`properties: {}`)
 *
 * @param schema - The JSON schema to check
 * @returns `true` if schema has defined properties, `false` otherwise
 */
export function hasDefinedSchema(schema: JSONSchema | undefined): boolean {
  if (!schema) {
    return false;
  }

  if (!schema.properties) {
    return false;
  }

  return Object.keys(schema.properties).length > 0;
}
