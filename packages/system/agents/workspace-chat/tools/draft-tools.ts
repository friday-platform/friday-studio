/**
 * Draft-file tools for workspace-chat.
 *
 * Allows the workspace-chat agent to begin and publish draft workspace
 * configurations. These are thin wrappers over the HTTP endpoints so
 * the agent can stage changes safely and publish them only after
 * server-side validation passes.
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";

export function createDraftTools(_logger: Logger): AtlasTools {
  return {
    begin_draft: tool({
      description:
        "Begin a draft workspace configuration for the current workspace. " +
        "Copies the live workspace.yml to workspace.draft.yml so you can " +
        "stage changes safely. Idempotent — calling again when a draft already " +
        "exists is a no-op.",
      inputSchema: z.object({}),
      execute: async () => {
        return {
          success: false,
          error:
            "begin_draft must be called with a workspaceId context. " +
            "This is handled automatically by the workspace-chat agent.",
        };
      },
    }),

    publish_draft: tool({
      description:
        "Publish the current workspace draft. Validates the draft against " +
        "the full workspace schema and reference validator, then atomically " +
        "renames workspace.draft.yml over workspace.yml. If validation fails, " +
        "the draft is left untouched and you receive a structured error report " +
        "to fix before retrying.",
      inputSchema: z.object({}),
      execute: async () => {
        return {
          success: false,
          error:
            "publish_draft must be called with a workspaceId context. " +
            "This is handled automatically by the workspace-chat agent.",
        };
      },
    }),
  };
}

/**
 * Build draft tools bound to a specific workspaceId.
 *
 * The unbound versions above are placeholders for tool registration;
 * the agent handler calls this factory with the real workspaceId
 * and replaces the execute functions with workspace-scoped HTTP calls.
 */
export function createBoundDraftTools(logger: Logger, workspaceId: string): AtlasTools {
  return {
    begin_draft: tool({
      description:
        "Begin a draft workspace configuration. Copies the live workspace.yml " +
        "to workspace.draft.yml so you can stage changes safely. Idempotent.",
      inputSchema: z.object({}),
      execute: async () => {
        logger.info("begin_draft tool invoked", { workspaceId });

        const result = await parseResult(
          client.workspace[":workspaceId"].draft.begin.$post({ param: { workspaceId } }),
        );

        if (!result.ok) {
          logger.warn("begin_draft failed", { error: result.error, workspaceId });
          return { success: false, error: result.error };
        }

        logger.info("begin_draft succeeded", { workspaceId });
        return { success: true, draftPath: result.data.draftPath };
      },
    }),

    publish_draft: tool({
      description:
        "Publish the current workspace draft. Validates via validateWorkspace, " +
        "refuses if hard-fail errors exist, then atomically renames draft over live. " +
        "Destroys the runtime so the live config is picked up on next access.",
      inputSchema: z.object({}),
      execute: async () => {
        logger.info("publish_draft tool invoked", { workspaceId });

        const result = await parseResult(
          client.workspace[":workspaceId"].draft.publish.$post({ param: { workspaceId } }),
        );

        if (!result.ok) {
          logger.warn("publish_draft failed", { error: result.error, workspaceId });
          return { success: false, error: result.error };
        }

        logger.info("publish_draft succeeded", { workspaceId });
        return {
          success: true,
          livePath: result.data.livePath,
          runtimeReloaded: result.data.runtimeReloaded,
        };
      },
    }),
  };
}
