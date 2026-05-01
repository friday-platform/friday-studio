/**
 * Validates resource declaration schemas before they reach provisioning.
 *
 * Catches malformed JSON Schemas early in the pipeline so errors surface
 * at planning time rather than workspace creation time.
 */

import type { ResourceDeclaration } from "@atlas/schemas/workspace";

const SUPPORTED_TYPES = new Set(["string", "integer", "number", "boolean", "array", "object"]);

/**
 * Validate resource schemas from the blueprint.
 *
 * Only document resources are validated (they carry JSON schemas).
 * Prose, artifact_ref, and external_ref are skipped — they have no user-defined schema.
 *
 * @param resources - Resource declarations from the blueprint.
 * @throws {Error} If any resource schema is malformed.
 */
export function validateResourceSchemas(resources: ResourceDeclaration[]): void {
  for (const resource of resources) {
    if (resource.type !== "document") continue;

    const { slug, schema } = resource;

    if (schema.type !== "object") {
      throw new Error(`Resource "${slug}": top-level type must be "object", got "${schema.type}"`);
    }

    if (!schema.properties || Object.keys(schema.properties).length === 0) {
      throw new Error(`Resource "${slug}": properties must be present and non-empty`);
    }

    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      if (!propName.trim()) {
        throw new Error(`Resource "${slug}": property name must be non-empty`);
      }

      if (propSchema.type && !SUPPORTED_TYPES.has(propSchema.type)) {
        throw new Error(
          `Resource "${slug}": property "${propName}" has unsupported type "${propSchema.type}"`,
        );
      }
    }
  }
}
