/**
 * Utilities for flattening JSON Schema objects into renderable table rows.
 *
 * Used by the SchemaPropertyTable component. Extracted here for testability.
 *
 * @module
 */

import { z } from "zod";

/** Zod shape for a single JSON Schema property definition. */
export const JsonSchemaPropertyShape = z.object({
  type: z.string().optional(),
  description: z.string().optional(),
  enum: z.array(z.unknown()).optional(),
  default: z.unknown().optional(),
  items: z.object({ type: z.string().optional() }).passthrough().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
});

/** Zod shape for a top-level JSON Schema object (type: "object" with properties). */
export const JsonSchemaObjectShape = z.object({
  type: z.literal("object").optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
  description: z.string().optional(),
});

export interface SchemaRow {
  /** Dot-notated property name (e.g. "data.path" for nested) */
  name: string;
  /** Type label (e.g. "string", "object", "string[]") */
  type: string;
  /** Property description from schema */
  description: string;
  /** Whether the property is in the parent's required array */
  required: boolean;
  /** Nesting depth (0 = top-level, 1 = nested) */
  depth: number;
}

/**
 * Flatten a JSON Schema's properties into table rows.
 * Recurses one level into nested objects, producing dot-notation names.
 *
 * @param schemaObj - A JSON Schema-like object with `properties`
 * @param prefix - Dot-notation prefix for nested properties
 * @param requiredSet - Set of property names required at this level
 * @param depth - Current nesting depth (stops recursing at depth >= 1)
 * @returns Flat array of schema rows
 */
export function flattenSchema(
  schemaObj: Record<string, unknown>,
  prefix: string,
  requiredSet: Set<string>,
  depth: number,
): SchemaRow[] {
  const parsed = JsonSchemaObjectShape.safeParse(schemaObj);
  if (!parsed.success || !parsed.data.properties) return [];

  const rows: SchemaRow[] = [];
  const entries = Object.entries(parsed.data.properties);

  for (const [key, rawDef] of entries) {
    const propResult = JsonSchemaPropertyShape.safeParse(rawDef);
    const def = propResult.success ? propResult.data : undefined;

    const fullName = prefix ? `${prefix}.${key}` : key;
    const rawType = def?.type ?? "unknown";
    const description = def?.description ?? "";
    const isRequired = requiredSet.has(key);

    if (rawType === "object" && def?.properties && depth < 1) {
      // Parent row for the nested object
      rows.push({ name: fullName, type: "object", description, required: isRequired, depth });

      // Recurse into nested properties
      const nestedRequired = new Set<string>(def.required ?? []);
      rows.push(
        ...flattenSchema(
          { properties: def.properties, required: def.required },
          fullName,
          nestedRequired,
          depth + 1,
        ),
      );
    } else if (rawType === "array") {
      const itemType = def?.items?.type ?? "unknown";
      rows.push({
        name: fullName,
        type: `${itemType}[]`,
        description,
        required: isRequired,
        depth,
      });
    } else {
      rows.push({ name: fullName, type: rawType, description, required: isRequired, depth });
    }
  }

  return rows;
}

/**
 * Convert a JSON Schema object to flat rows for table rendering.
 * Returns an empty array for null/invalid schemas.
 */
export function schemaToRows(schema: object | null): SchemaRow[] {
  if (!schema) return [];

  const parsed = JsonSchemaObjectShape.safeParse(schema);
  if (!parsed.success || !parsed.data.properties) return [];

  const requiredSet = new Set<string>(parsed.data.required ?? []);
  return flattenSchema({ ...parsed.data }, "", requiredSet, 0);
}
