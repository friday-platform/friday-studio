/**
 * JSON Schema field path validation.
 *
 * Walks a JSON schema to check if a dot-path (e.g. "items[].name") resolves
 * to a valid property. Used by the compiler to validate prepare mapping sources
 * against document contract schemas.
 */

import type { ValidatedJSONSchema } from "@atlas/core/artifacts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

type ValidateFieldPathResult =
  | { valid: true; type: string }
  | { valid: false; available: string[] };

/**
 * Walk a JSON schema to check if a dot-path resolves.
 *
 * @returns `{ valid: true, type }` when the path resolves to a leaf,
 *          `{ valid: false, available }` listing sibling fields at the
 *          point of failure.
 */
export function validateFieldPath(
  schema: ValidatedJSONSchema,
  path: string,
): ValidateFieldPathResult {
  let current = schema;

  for (const segment of parsePathSegments(path)) {
    if (segment === "[]") {
      if (current.type !== "array" || !current.items) {
        return { valid: false, available: availableKeys(current) };
      }
      current = current.items;
      continue;
    }

    const next = current.properties?.[segment];
    if (!next) {
      return { valid: false, available: availableKeys(current) };
    }
    current = next;
  }

  return { valid: true, type: current.type ?? "unknown" };
}

/**
 * Walk a JSON schema down a dot-path and return the sub-schema at that location.
 *
 * @returns The resolved sub-schema, or undefined if the path doesn't resolve.
 *          Returns the root schema if the path is empty.
 */
export function resolveFieldPath(
  schema: ValidatedJSONSchema,
  path: string,
): ValidatedJSONSchema | undefined {
  if (!path) return schema;

  let current = schema;

  for (const segment of parsePathSegments(path)) {
    if (segment === "[]") {
      if (current.type !== "array" || !current.items) return undefined;
      current = current.items;
      continue;
    }

    const next = current.properties?.[segment];
    if (!next) return undefined;
    current = next;
  }

  return current;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a dot-path into segments, normalising array access.
 * `"queries[].sql"` → `["queries", "[]", "sql"]`
 * `"queries.0.sql"` → `["queries", "[]", "sql"]`
 * `"data.summary"`  → `["data", "summary"]`
 */
function parsePathSegments(path: string): string[] {
  const segments: string[] = [];
  for (const raw of path.split(".")) {
    // "queries[]" → push "queries" then "[]"
    const bracketMatch = raw.match(/^(.+)\[\]$/);
    if (bracketMatch?.[1]) {
      segments.push(bracketMatch[1]);
      segments.push("[]");
      continue;
    }
    // Numeric index treated as array item access
    if (/^\d+$/.test(raw)) {
      segments.push("[]");
      continue;
    }
    segments.push(raw);
  }
  return segments;
}

function availableKeys(schema: ValidatedJSONSchema): string[] {
  return schema.properties ? Object.keys(schema.properties) : [];
}
