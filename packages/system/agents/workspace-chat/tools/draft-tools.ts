/**
 * Draft-file tools for workspace-chat.
 *
 * Allows the workspace-chat agent to begin, publish, validate, and discard
 * draft workspace configurations. These are thin wrappers over the HTTP
 * endpoints so the agent can stage changes safely and publish them only after
 * server-side validation passes.
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import { client } from "@atlas/client/v2";
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

    validate_workspace: tool({
      description:
        "Validate the current workspace configuration. If a draft exists, validates " +
        "the draft; otherwise validates the live config. Returns a full validation " +
        "report with errors and warnings.",
      inputSchema: z.object({}),
      execute: async () => {
        return {
          success: false,
          error:
            "validate_workspace must be called with a workspaceId context. " +
            "This is handled automatically by the workspace-chat agent.",
        };
      },
    }),

    discard_draft: tool({
      description:
        "Discard the current workspace draft without publishing. No-op if no draft exists.",
      inputSchema: z.object({}),
      execute: async () => {
        return {
          success: false,
          error:
            "discard_draft must be called with a workspaceId context. " +
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

        const res = await client.workspace[":workspaceId"].draft.begin.$post({
          param: { workspaceId },
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "begin_draft failed" }));
          logger.warn("begin_draft failed", { error: body.error, workspaceId });
          return { success: false, error: body.error ?? "begin_draft failed" };
        }

        const data = await res.json();
        logger.info("begin_draft succeeded", { workspaceId });
        return { success: true, draftPath: data.draftPath };
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

        const res = await client.workspace[":workspaceId"].draft.publish.$post({
          param: { workspaceId },
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "publish_draft failed" }));
          logger.warn("publish_draft failed", { error: body.error, workspaceId });
          return {
            success: false,
            error: body.error ?? "publish_draft failed",
            report: body.report,
          };
        }

        const data = await res.json();
        logger.info("publish_draft succeeded", { workspaceId });
        return {
          success: true,
          livePath: data.livePath,
          runtimeReloaded: data.runtimeReloaded,
        };
      },
    }),

    validate_workspace: tool({
      description:
        "Validate the current workspace configuration. If a draft exists, validates " +
        "the draft; otherwise validates the live config. Returns a full validation report.",
      inputSchema: z.object({}),
      execute: async () => {
        logger.info("validate_workspace tool invoked", { workspaceId });

        // Try draft validation first
        const draftRes = await client.workspace[":workspaceId"].draft.validate.$post({
          param: { workspaceId },
        });

        if (draftRes.ok) {
          const data = await draftRes.json();
          logger.info("validate_workspace succeeded (draft)", { workspaceId });
          return data.report;
        }

        if (draftRes.status === 409) {
          // No draft — fall back to live config lint
          const lintRes = await client.workspace[":workspaceId"].lint.$post({
            param: { workspaceId },
          });

          if (lintRes.ok) {
            const data = await lintRes.json();
            logger.info("validate_workspace succeeded (live)", { workspaceId });
            return data.report;
          }

          const body = await lintRes.json().catch(() => ({ error: "Live validation failed" }));
          logger.warn("validate_workspace live validation failed", { error: body.error, workspaceId });
          return { success: false, error: body.error ?? "Live validation failed" };
        }

        const body = await draftRes.json().catch(() => ({ error: "Draft validation failed" }));
        logger.warn("validate_workspace draft validation failed", { error: body.error, workspaceId });
        return { success: false, error: body.error ?? "Draft validation failed" };
      },
    }),

    discard_draft: tool({
      description:
        "Discard the current workspace draft without publishing. No-op if no draft exists.",
      inputSchema: z.object({}),
      execute: async () => {
        logger.info("discard_draft tool invoked", { workspaceId });

        const res = await client.workspace[":workspaceId"].draft.$delete({
          param: { workspaceId },
        });

        if (res.ok || res.status === 409) {
          logger.info("discard_draft succeeded", { workspaceId, noOp: res.status === 409 });
          return { success: true, noOp: res.status === 409 };
        }

        const body = await res.json().catch(() => ({ error: "discard_draft failed" }));
        logger.warn("discard_draft failed", { error: body.error, workspaceId });
        return { success: false, error: body.error ?? "discard_draft failed" };
      },
    }),
  };
}
