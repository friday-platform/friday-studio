/**
 * Resource provisioning for workspace creation.
 *
 * Called after workspace registration to materialize resource declarations
 * into the Ledger resource storage service.
 */

import type { ResourceStorageAdapter } from "@atlas/ledger";
import type { ResourceDeclaration } from "@atlas/schemas/workspace";
import type { Result } from "@atlas/utils";

/**
 * @description Maps a ResourceDeclaration to the Ledger resource type.
 * Prose declarations are stored as "document" type in the Ledger.
 */
function toLedgerType(
  type: ResourceDeclaration["type"],
): "document" | "artifact_ref" | "external_ref" {
  switch (type) {
    case "document":
    case "prose":
      return "document";
    case "artifact_ref":
      return "artifact_ref";
    case "external_ref":
      return "external_ref";
  }
}

/**
 * @description Builds the initial data payload for a resource based on its declaration type.
 * Document types get empty arrays; prose gets empty string; ref types get their ref metadata.
 */
function toInitialData(resource: ResourceDeclaration): unknown {
  switch (resource.type) {
    case "document":
      return [];
    case "prose":
      return "";
    case "artifact_ref":
      return { artifact_id: resource.artifactId };
    case "external_ref":
      return {
        provider: resource.provider,
        ...(resource.ref !== undefined && { ref: resource.ref }),
        ...(resource.metadata !== undefined && { metadata: resource.metadata }),
      };
  }
}

/**
 * @description Builds the JSON Schema for a resource based on its declaration type.
 * Document has an explicit schema; prose uses a markdown string schema.
 */
function toSchema(resource: ResourceDeclaration): unknown {
  switch (resource.type) {
    case "document":
      return resource.schema;
    case "prose":
      return { type: "string", format: "markdown" };
    case "artifact_ref":
    case "external_ref":
      return {};
  }
}

/**
 * @description Provisions all declared resources for a workspace via the Ledger API.
 * Iterates resources by type, mapping each declaration to a Ledger provision call.
 * Skips provisioning when resources array is empty.
 *
 * @param adapter - Ledger resource storage adapter
 * @param workspaceId - Workspace to provision resources for
 * @param userId - User ID for resource ownership
 * @param resources - Resource declarations from the blueprint
 * @returns Result indicating success or descriptive failure
 */
export async function provisionResources(
  adapter: ResourceStorageAdapter,
  workspaceId: string,
  userId: string,
  resources: ResourceDeclaration[],
): Promise<Result<void, string>> {
  if (resources.length === 0) {
    return { ok: true, data: undefined };
  }

  for (const resource of resources) {
    try {
      await adapter.provision(
        workspaceId,
        {
          userId,
          slug: resource.slug,
          name: resource.name,
          description: resource.description,
          type: toLedgerType(resource.type),
          schema: toSchema(resource),
        },
        toInitialData(resource),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Failed to provision "${resource.slug}": ${message}` };
    }
  }

  return { ok: true, data: undefined };
}
