/**
 * Pure transform for displaying resource declarations in the workspace plan card.
 *
 * Takes raw ResourceDeclaration[] from the blueprint and produces a discriminated
 * union of display items: structured (mini-table), document (icon + description),
 * or external (provider reference).
 */
import type { ValidatedJSONSchema } from "@atlas/schemas/json-schema";
import type { ResourceDeclaration } from "@atlas/schemas/workspace";

// ---------------------------------------------------------------------------
// Display types
// ---------------------------------------------------------------------------

type Column = { name: string; type: string; description?: string };

type NestedTable = { name: string; columns: Column[] };

type StructuredDisplay = {
  kind: "structured";
  name: string;
  description: string;
  columns: Column[];
  nested?: NestedTable[];
};

type DocumentDisplay = { kind: "document"; name: string; description: string };

type ExternalDisplay = {
  kind: "external";
  name: string;
  description: string;
  provider: string;
  ref?: string;
};

export type ResourceDisplayItem = StructuredDisplay | DocumentDisplay | ExternalDisplay;

export type ResourceDisplayResult = {
  items: ResourceDisplayItem[];
  /** Number of resources beyond the display cap (0 when all fit). */
  overflow: number;
};

const DISPLAY_CAP = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts a slug like "cook_time" to title case "Cook Time".
 */
export function humanizeColumnName(slug: string): string {
  return slug
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Maps a JSON Schema property to a friendly type label.
 *
 * Resolution order: enum > format > base type.
 */
function friendlyTypeLabel(schema: ValidatedJSONSchema): string {
  if (schema.enum && schema.enum.length > 0) return "choice";

  const format = (schema as Record<string, unknown>)["format"];
  if (typeof format === "string") {
    const formatLabels: Record<string, string> = {
      date: "date",
      "date-time": "date/time",
      email: "email",
      uri: "link",
    };
    const label = formatLabels[format];
    if (label) return label;
  }

  switch (schema.type) {
    case "string":
      return "text";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "yes/no";
    case "array":
      return "list";
    case "object":
      return "data";
    default:
      return "text";
  }
}

/**
 * Returns true if the property represents a nested object structure that should
 * be extracted as a sub-table (array of objects or object with properties).
 */
function isNestedObjectSchema(
  schema: ValidatedJSONSchema,
): { properties: Record<string, ValidatedJSONSchema> } | null {
  // Array with items.type: "object" and items.properties
  if (schema.type === "array" && schema.items?.type === "object" && schema.items.properties) {
    return { properties: schema.items.properties };
  }
  // Object with properties (but not a bare "object" with no properties)
  if (schema.type === "object" && schema.properties && Object.keys(schema.properties).length > 0) {
    return { properties: schema.properties };
  }
  return null;
}

/**
 * Extracts columns and nested tables from a JSON Schema's properties.
 * Caps nesting at one level — deeper nested structures show as "list" or "data".
 */
function extractColumnsAndNested(properties: Record<string, ValidatedJSONSchema>): {
  columns: Column[];
  nested: NestedTable[];
} {
  const columns: Column[] = [];
  const nested: NestedTable[] = [];

  for (const [key, propSchema] of Object.entries(properties)) {
    const nestedProps = isNestedObjectSchema(propSchema);
    if (nestedProps) {
      const nestedColumns: Column[] = [];
      for (const [nestedKey, nestedSchema] of Object.entries(nestedProps.properties)) {
        const desc = (nestedSchema as Record<string, unknown>)["description"];
        nestedColumns.push({
          name: humanizeColumnName(nestedKey),
          type: friendlyTypeLabel(nestedSchema),
          ...(typeof desc === "string" && desc ? { description: desc } : {}),
        });
      }
      nested.push({ name: humanizeColumnName(key), columns: nestedColumns });
    } else {
      const desc = (propSchema as Record<string, unknown>)["description"];
      columns.push({
        name: humanizeColumnName(key),
        type: friendlyTypeLabel(propSchema),
        ...(typeof desc === "string" && desc ? { description: desc } : {}),
      });
    }
  }

  return { columns, nested };
}

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

/**
 * Transforms raw ResourceDeclaration[] into display-ready items.
 *
 * Three output kinds:
 * - "external" — has a `provider` field (ExternalRefDeclaration)
 * - "document" — table with ≤2 remaining columns, all string-typed
 * - "structured" — everything else (mini-table with columns + optional nested)
 *
 * Caps output at 5 items. Overflow count indicates how many were omitted.
 * Falls back to structured with empty columns on malformed schemas.
 */
export function transformResourcesForDisplay(
  resources: ResourceDeclaration[],
): ResourceDisplayResult {
  const overflow = Math.max(0, resources.length - DISPLAY_CAP);
  const capped = resources.slice(0, DISPLAY_CAP);

  const items = capped.map((resource): ResourceDisplayItem => {
    if (resource.type === "external_ref") {
      const item: ExternalDisplay = {
        kind: "external",
        name: resource.name,
        description: resource.description,
        provider: resource.provider,
      };
      if (resource.ref !== undefined) item.ref = resource.ref;
      return item;
    }

    // Prose and artifact_ref have no user-facing schema — render as document
    if (resource.type === "prose" || resource.type === "artifact_ref") {
      return { kind: "document", name: resource.name, description: resource.description };
    }

    try {
      const schema = resource.schema;
      if (!schema.properties || Object.keys(schema.properties).length === 0) {
        return {
          kind: "structured",
          name: resource.name,
          description: resource.description,
          columns: [],
        };
      }

      const { columns, nested } = extractColumnsAndNested(schema.properties);

      if (
        columns.length <= 2 &&
        columns.length > 0 &&
        columns.every((col) => col.type === "text") &&
        nested.length === 0
      ) {
        return { kind: "document", name: resource.name, description: resource.description };
      }

      const result: StructuredDisplay = {
        kind: "structured",
        name: resource.name,
        description: resource.description,
        columns,
      };
      if (nested.length > 0) {
        result.nested = nested;
      }
      return result;
    } catch {
      return {
        kind: "structured",
        name: resource.name,
        description: resource.description,
        columns: [],
      };
    }
  });

  return { items, overflow };
}
