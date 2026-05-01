/**
 * Resolve and validate artifact references in signal payloads.
 *
 * @deprecated The `format: "artifact-ref"` pipeline is deprecated. Signals are
 * now pure triggers — the data-analyst discovers data through the resource
 * catalog. These functions are retained as no-ops for backwards compatibility
 * with existing workspace YAMLs.
 */

import { createLogger } from "@atlas/logger";

const logger = createLogger({ component: "resolve-artifact-refs" });

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
 * @deprecated Passes payload through unchanged. The artifact-ref resolution
 * pipeline is deprecated — signals are pure triggers, and data discovery
 * happens through the resource catalog.
 *
 * Logs a deprecation warning when artifact-ref fields are encountered.
 */
export function resolveArtifactRefs(
  schema: Record<string, unknown>,
  payload: Record<string, unknown>,
  _artifacts: Array<{ id: string; [key: string]: unknown }>,
): ArtifactRefResult {
  if (hasArtifactRefFields(schema)) {
    logger.warn(
      "resolveArtifactRefs is deprecated — artifact-ref fields are no longer resolved. " +
        "Signals should be pure triggers. Data discovery uses the resource catalog.",
    );
  }

  return { success: true, payload };
}
