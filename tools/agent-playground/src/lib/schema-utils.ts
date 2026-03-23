/**
 * Utilities for flattening JSON Schema objects into renderable table rows.
 *
 * Used by the SchemaPropertyTable component. Extracted here for testability.
 *
 * @module
 */

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
  const props = schemaObj.properties;
  if (!props || typeof props !== "object") return [];

  const rows: SchemaRow[] = [];
  const entries = Object.entries(props as Record<string, Record<string, unknown>>);

  for (const [key, def] of entries) {
    const fullName = prefix ? `${prefix}.${key}` : key;
    const rawType = typeof def?.type === "string" ? def.type : "unknown";
    const description = typeof def?.description === "string" ? def.description : "";
    const isRequired = requiredSet.has(key);

    if (rawType === "object" && def?.properties && depth < 1) {
      // Parent row for the nested object
      rows.push({ name: fullName, type: "object", description, required: isRequired, depth });

      // Recurse into nested properties
      const nestedRequired = new Set<string>(
        Array.isArray(def.required) ? (def.required as string[]) : [],
      );
      rows.push(...flattenSchema(def as Record<string, unknown>, fullName, nestedRequired, depth + 1));
    } else if (rawType === "array") {
      const items = def?.items as Record<string, unknown> | undefined;
      const itemType = typeof items?.type === "string" ? items.type : "unknown";
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
  const s = schema as Record<string, unknown>;
  if (!s.properties || typeof s.properties !== "object") return [];

  const requiredSet = new Set<string>(
    Array.isArray(s.required) ? (s.required as string[]) : [],
  );
  return flattenSchema(s, "", requiredSet, 0);
}
