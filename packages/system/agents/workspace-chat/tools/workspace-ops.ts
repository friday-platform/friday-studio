/**
 * Workspace operation tools for workspace-chat.
 *
 * - create_workspace: creates an empty workspace from name + optional description
 * - delete_workspace: permanently removes a workspace
 * - delete_agent / delete_signal / delete_job (bound): per-kind delete from
 *   the current workspace (replaces the older `remove_item({kind, id})`).
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
};

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

const DELETE_ITEM_INPUT_SCHEMA = z.object({
  id: z.string().describe("Identifier of the entity to remove."),
  workspaceId: z
    .string()
    .optional()
    .describe("Optional. Target a specific workspace instead of the current session workspace."),
});

export function createWorkspaceOpsTools(logger: Logger): AtlasTools {
  return {
    delete_workspace: tool({
      description:
        "Delete a workspace permanently. Calls DELETE /api/workspaces/:id directly — " +
        "do NOT spawn a claude-code sub-agent for this simple API operation.",
      inputSchema: WORKSPACE_DELETE_INPUT_SCHEMA,
      execute: async ({ workspaceId, force }) => {
        logger.info("delete_workspace tool invoked", { workspaceId, force });

        const result = await parseResult(
          client.workspace[":workspaceId"].$delete({
            param: { workspaceId },
            query: force ? { force: "true" } : {},
          }),
        );

        if (!result.ok) {
          logger.warn("delete_workspace failed", { workspaceId, error: result.error });
          return { success: false, error: result.error };
        }

        logger.info("delete_workspace succeeded", { workspaceId });
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
          workspace: { name, ...(description !== undefined && { description }) },
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

async function deleteWorkspaceItem(
  kind: "agent" | "signal" | "job",
  id: string,
  workspaceId: string,
  logger: Logger,
): Promise<{ ok: true; livePath?: unknown } | { ok: false; error?: unknown }> {
  const op = `delete_${kind}`;
  logger.info(`${op} tool invoked`, { workspaceId, kind, id });

  const res = await client.workspace[":workspaceId"].items[":kind"][":id"].$delete({
    param: { workspaceId, kind, id },
  });

  if (!res.ok) {
    const errorSchema = z.object({ error: z.unknown().optional() });
    let body: z.infer<typeof errorSchema>;
    try {
      body = errorSchema.parse(await res.json());
    } catch {
      body = { error: `${op} failed` };
    }
    logger.warn(`${op} failed`, { workspaceId, kind, id, error: body.error });
    return { ok: false, error: body.error ?? `${op} failed` };
  }

  const data = await res.json();
  logger.info(`${op} succeeded`, { workspaceId, kind, id });
  return { ok: true, livePath: data.livePath };
}

export function createBoundWorkspaceOpsTools(logger: Logger, workspaceId: string): AtlasTools {
  return {
    delete_agent: tool({
      description:
        "Remove an agent from the current workspace's agents list. Pairs with `upsert_agent` " +
        "(the create/update verb). Calls DELETE /items/agent/:id on the live config and refuses " +
        "if the agent is still referenced elsewhere. To remove the agent's installed source from " +
        "the global registry instead, use `delete_agent_from_registry`. Optional: pass " +
        "workspaceId to target a different workspace.",
      inputSchema: DELETE_ITEM_INPUT_SCHEMA,
      execute: ({ id, workspaceId: providedId }) =>
        deleteWorkspaceItem("agent", id, providedId ?? workspaceId, logger),
    }),
    delete_signal: tool({
      description:
        "Remove a signal from the current workspace's signals map. Pairs with `upsert_signal`. " +
        "Calls DELETE /items/signal/:id on the live config and refuses if the signal is still " +
        "referenced elsewhere. Optional: pass workspaceId to target a different workspace.",
      inputSchema: DELETE_ITEM_INPUT_SCHEMA,
      execute: ({ id, workspaceId: providedId }) =>
        deleteWorkspaceItem("signal", id, providedId ?? workspaceId, logger),
    }),
    delete_job: tool({
      description:
        "Remove a job from the current workspace's jobs map. Pairs with `upsert_job`. Calls " +
        "DELETE /items/job/:id on the live config and refuses if the job is still referenced " +
        "elsewhere. Optional: pass workspaceId to target a different workspace.",
      inputSchema: DELETE_ITEM_INPUT_SCHEMA,
      execute: ({ id, workspaceId: providedId }) =>
        deleteWorkspaceItem("job", id, providedId ?? workspaceId, logger),
    }),
  };
}
