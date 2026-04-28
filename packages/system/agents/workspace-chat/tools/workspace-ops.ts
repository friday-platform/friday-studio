/**
 * Workspace operation tools for workspace-chat.
 *
 * - create_workspace: creates an empty workspace from name + optional description
 * - workspace_delete: permanently removes a workspace
 * - remove_item (bound): deletes an agent/signal/job from the current workspace
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type { Logger } from "@atlas/logger";
import { jsonSchema, tool } from "ai";
import { z } from "zod";

const CREATE_WORKSPACE_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    name: {
      type: "string" as const,
      description: "Human-readable workspace name. Will be slugified for the directory name.",
    },
    description: {
      type: "string" as const,
      description: "Optional short description of the workspace purpose.",
    },
  },
  required: ["name"],
} as const;

const WORKSPACE_DELETE_INPUT_SCHEMA = z.object({
  workspaceId: z
    .string()
    .describe("Unique identifier of the workspace to permanently remove from the system"),
  force: z
    .boolean()
    .optional()
    .describe(
      "Bypass safety checks and force deletion even if workspace is canonical or has active sessions",
    ),
});

const REMOVE_ITEM_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    kind: {
      type: "string" as const,
      enum: ["agent", "signal", "job"] as const,
      description: "Type of entity to remove",
    },
    id: {
      type: "string" as const,
      description: "Unique identifier of the entity to remove",
    },
    workspaceId: {
      type: "string" as const,
      description: "Optional. Target a specific workspace instead of the current session workspace.",
    },
  },
  required: ["kind", "id"],
} as const;

export function createWorkspaceOpsTools(logger: Logger): AtlasTools {
  return {
    workspace_delete: tool({
      description:
        "Delete a workspace permanently. Calls DELETE /api/workspaces/:id directly — " +
        "do NOT spawn a claude-code sub-agent for this simple API operation.",
      inputSchema: WORKSPACE_DELETE_INPUT_SCHEMA,
      execute: async ({ workspaceId, force }) => {
        logger.info("workspace_delete tool invoked", { workspaceId, force });

        const result = await parseResult(
          client.workspace[":workspaceId"].$delete({
            param: { workspaceId },
            query: force ? { force: "true" } : {},
          }),
        );

        if (!result.ok) {
          logger.warn("workspace_delete failed", { workspaceId, error: result.error });
          return { success: false, error: result.error };
        }

        logger.info("workspace_delete succeeded", { workspaceId });
        return { success: true, message: result.data.message };
      },
    }),

    create_workspace: tool({
      description:
        "Create a new empty workspace with just a name and optional description. " +
        "The daemon creates the directory, default memory config, and registers the workspace. " +
        "Returns the new workspace id, name, and path.",
      inputSchema: jsonSchema(CREATE_WORKSPACE_INPUT_SCHEMA),
      execute: async ({ name, description }: { name: string; description?: string }) => {
        logger.info("create_workspace tool invoked", { name, description });

        const config = {
          version: "1.0" as const,
          workspace: {
            name,
            ...(description !== undefined && { description }),
          },
        };

        const result = await parseResult(
          client.workspace.create.$post({
            json: { config, workspaceName: undefined, ephemeral: false },
          }),
        );

        if (!result.ok) {
          logger.warn("create_workspace failed", { name, error: result.error });
          return { success: false, error: result.error };
        }

        logger.info("create_workspace succeeded", { name });
        return {
          success: true,
          workspace: {
            id: result.data.workspace.id,
            name: result.data.workspace.name,
            path: result.data.workspacePath,
          },
        };
      },
    }),
  };
}

export function createBoundWorkspaceOpsTools(logger: Logger, workspaceId: string): AtlasTools {
  return {
    remove_item: tool({
      description:
        "Remove an agent, signal, or job from the current workspace. " +
        "Calls DELETE /items/:kind/:id on the live config. " +
        "Refuses the operation if the item is still referenced by other workspace entities. " +
        "Optional: pass workspaceId to target a different workspace (e.g. after create_workspace).",
      inputSchema: jsonSchema(REMOVE_ITEM_INPUT_SCHEMA),
      execute: async ({ kind, id, workspaceId: providedId }: { kind: "agent" | "signal" | "job"; id: string; workspaceId?: string }) => {
        const targetId = providedId ?? workspaceId;
        logger.info("remove_item tool invoked", { workspaceId: targetId, kind, id });

        const res = await client.workspace[":workspaceId"].items[":kind"][":id"].$delete({
          param: { workspaceId: targetId, kind, id },
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "remove_item failed" }));
          logger.warn("remove_item failed", { workspaceId: targetId, kind, id, error: body.error });
          return { ok: false, error: body.error ?? "remove_item failed" };
        }

        const data = await res.json();
        logger.info("remove_item succeeded", { workspaceId: targetId, kind, id });
        return {
          ok: true,
          livePath: data.livePath,
          runtimeReloaded: data.runtimeReloaded,
        };
      },
    }),
  };
}
