/**
 * Resource tools for the workspace-chat agent.
 *
 * Provides `resource_read` and `resource_write` with built-in type guards
 * that reject non-document resources with structured guidance errors.
 *
 * Exported as a factory returning pre-typed `AtlasTools` to avoid TS2589
 * deep type instantiation when spread into `streamText`'s tools parameter.
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import type { ResourceStorageAdapter } from "@atlas/ledger";
import type { ResourceEntry } from "@atlas/resources";
import { stringifyError } from "@atlas/utils";
import { jsonSchema, tool } from "ai";

/** Tool names used by the workspace-chat agent for resource access. */
export const RESOURCE_CHAT_TOOL_NAMES = ["resource_read", "resource_write"] as const;

type ResourceMetadataMap = Map<string, ResourceEntry>;

type ResourceToolInput = { slug: string; sql: string; params?: unknown[] };

const inputSchema = jsonSchema<ResourceToolInput>({
  type: "object",
  properties: {
    slug: { type: "string", description: "Resource slug to query" },
    sql: { type: "string", description: "SQL query to execute against the draft CTE" },
    params: { type: "array", items: {}, description: "Bind parameters for the query (optional)" },
  },
  required: ["slug", "sql"],
});

/**
 * Checks resource type from metadata and returns a guidance error for
 * non-document resources. Returns `null` if the resource is a document
 * or unknown (should forward to Ledger).
 */
function getTypeGuardError(
  slug: string,
  metadata: ResourceMetadataMap,
): { error: string; hint?: string } | null {
  const entry = metadata.get(slug);

  // Unknown slug — forward to Ledger (handles mid-conversation creation)
  if (!entry) return null;

  switch (entry.type) {
    case "document":
      return null;
    case "external_ref":
      return {
        error: `"${slug}" is an external resource (${entry.provider}). Use delegate or an agent_<id> tool to interact with it.`,
        hint: `Example: delegate({ goal: '...' })`,
      };
    case "artifact_ref":
      return {
        error: `"${slug}" is a read-only file. Use artifacts_get to access it.`,
      };
    default:
      entry satisfies never;
      return null;
  }
}

/**
 * Creates resource_read and resource_write tools for the workspace-chat agent.
 *
 * @param adapter - Ledger resource storage adapter for query/mutate operations
 * @param metadata - Map of slug to ResourceEntry for type guard checks
 * @param workspaceId - Workspace ID for Ledger calls
 */
export function createResourceChatTools(
  adapter: ResourceStorageAdapter,
  metadata: ResourceMetadataMap,
  workspaceId: string,
): AtlasTools {
  const resource_read = tool({
    description:
      "Read from a workspace resource. SELECT queries only. Returns rows as JSON. " +
      "SQL runs against a CTE called `draft` — see resource skill for patterns.",
    inputSchema,
    execute: async ({ slug, sql, params }) => {
      const guardError = getTypeGuardError(slug, metadata);
      if (guardError) return guardError;

      try {
        return await adapter.query(workspaceId, slug, sql, params);
      } catch (err) {
        return { error: stringifyError(err) };
      }
    },
  });

  const resource_write = tool({
    description:
      "Write to a workspace resource. Your SELECT query computes the new value for the draft — " +
      "the system applies it. See resource skill for mutation patterns.",
    inputSchema,
    execute: async ({ slug, sql, params }) => {
      const guardError = getTypeGuardError(slug, metadata);
      if (guardError) return guardError;

      try {
        return await adapter.mutate(workspaceId, slug, sql, params);
      } catch (err) {
        return { error: stringifyError(err) };
      }
    },
  });

  const tools: AtlasTools = { resource_read, resource_write };
  return tools;
}
