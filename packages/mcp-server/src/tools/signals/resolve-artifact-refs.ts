/**
 * Resolve and validate artifact references in signal payloads.
 *
 * Signal schemas can declare `format: "artifact-ref"` on string fields
 * (or `items: { format: "artifact-ref" }` on array fields) to indicate
 * that the value should be an artifact ID from the current chat.
 *
 * This function validates LLM-provided IDs against actual chat artifacts
 * and auto-fills omitted fields when unambiguous.
 */

type ArtifactRefResult =
  | { success: true; payload: Record<string, unknown> }
  | { success: false; error: string };

interface SchemaProperty {
  type?: string;
  format?: string;
  items?: { format?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Prefixes that LLMs sometimes hallucinate onto artifact IDs. */
const ARTIFACT_ID_PREFIXES = ["artifact:", "cortex://"] as const;

/** Strip known prefixes from an artifact ID string. */
export function stripArtifactIdPrefix(value: string): string {
  for (const prefix of ARTIFACT_ID_PREFIXES) {
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return value;
}

/** Check whether a schema has any top-level artifact-ref fields. */
export function hasArtifactRefFields(schema: Record<string, unknown>): boolean {
  const properties = schema.properties as Record<string, SchemaProperty> | undefined;
  if (!properties) return false;
  return Object.values(properties).some((prop) => {
    if (prop.format === "artifact-ref") return true;
    return (
      prop.type === "array" &&
      typeof prop.items === "object" &&
      prop.items !== null &&
      prop.items.format === "artifact-ref"
    );
  });
}

/**
 * Resolve artifact-ref fields in a signal payload against chat artifacts.
 *
 * Only walks top-level `properties` in the schema. Nested object properties
 * are intentionally not resolved (pass through as-is).
 */
export function resolveArtifactRefs(
  schema: Record<string, unknown>,
  payload: Record<string, unknown>,
  artifacts: Array<{ id: string; [key: string]: unknown }>,
): ArtifactRefResult {
  const properties = schema.properties as Record<string, SchemaProperty> | undefined;
  if (!properties) {
    return { success: true, payload };
  }

  const resolved = { ...payload };
  const artifactIds = artifacts.map((a) => a.id);
  const required = Array.isArray(schema.required)
    ? schema.required.filter((r): r is string => typeof r === "string")
    : [];

  for (const [field, prop] of Object.entries(properties)) {
    const isSingleRef = prop.format === "artifact-ref";
    const isArrayRef =
      prop.type === "array" &&
      typeof prop.items === "object" &&
      prop.items !== null &&
      prop.items.format === "artifact-ref";

    if (!isSingleRef && !isArrayRef) continue;

    const value = resolved[field];

    if (isSingleRef) {
      if (value !== undefined && value !== null) {
        // LLM provided a value -- validate it
        if (typeof value !== "string") {
          return { success: false, error: `Field '${field}' must be a string artifact ID` };
        }
        const cleaned = stripArtifactIdPrefix(value);
        if (!artifactIds.includes(cleaned)) {
          return {
            success: false,
            error: `Field '${field}': artifact ID '${value}' not found in chat. Valid artifact IDs: ${artifactIds.join(", ") || "(none)"}`,
          };
        }
        // Replace with cleaned ID (strips any hallucinated prefix)
        resolved[field] = cleaned;
      } else if (required.includes(field)) {
        // LLM omitted a required field -- auto-fill
        if (artifacts.length === 0) {
          return {
            success: false,
            error: `Field '${field}' requires an artifact reference, but no artifacts are attached to this chat`,
          };
        }
        if (artifacts.length > 1) {
          return {
            success: false,
            error: `Field '${field}' requires a single artifact reference, but ${artifacts.length} artifacts are attached. Specify one of: ${artifactIds.join(", ")}`,
          };
        }
        resolved[field] = artifacts[0]!.id;
      }
      // Optional field omitted -- leave it alone
    }

    if (isArrayRef) {
      if (value !== undefined && value !== null) {
        // LLM provided a value -- validate each element
        if (!Array.isArray(value)) {
          return { success: false, error: `Field '${field}' must be an array of artifact IDs` };
        }
        const cleanedItems: string[] = [];
        for (const item of value) {
          if (typeof item !== "string") {
            return {
              success: false,
              error: `Field '${field}': expected string artifact ID, got ${typeof item}`,
            };
          }
          const cleaned = stripArtifactIdPrefix(item);
          if (!artifactIds.includes(cleaned)) {
            return {
              success: false,
              error: `Field '${field}': artifact ID '${item}' not found in chat. Valid artifact IDs: ${artifactIds.join(", ") || "(none)"}`,
            };
          }
          cleanedItems.push(cleaned);
        }
        // Replace with cleaned IDs (strips any hallucinated prefixes)
        resolved[field] = cleanedItems;
      } else if (required.includes(field)) {
        // LLM omitted a required array field -- auto-fill with all artifacts
        if (artifacts.length === 0) {
          return {
            success: false,
            error: `Field '${field}' requires artifact references, but no artifacts are attached to this chat`,
          };
        }
        resolved[field] = artifactIds;
      }
      // Optional array field omitted -- leave it alone
    }
  }

  return { success: true, payload: resolved };
}
