import { ElicitationStorage } from "@atlas/core/elicitations";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { deriveElicitationExpiresAt } from "../elicitations/wait.ts";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";
import { EnvScopeSchema, isSecretKey, MASKED_VALUE } from "./shared.ts";

/**
 * Register the `env_set` platform tool.
 *
 * `env_set` does NOT write directly. A chat turn cannot pause and wait for
 * human input, so the tool raises an `env-write` elicitation, returns
 * immediately as `pending_confirmation`, and the *daemon* commits the write
 * server-side when the user confirms the chat card (see the `env-write`
 * branch in `apps/atlasd/routes/elicitations`). The model never blocks on it
 * and never sees the values written in the same turn — to verify, call
 * `env_get` on a later turn.
 *
 * Scope-injected: `workspaceId` is the *current* workspace — a `workspace`
 * write only ever targets it (an agent can't write a foreign workspace's
 * `.env`). `global` writes the daemon's `.env`.
 */
export function registerEnvSetTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "env_set",
    {
      description:
        "Propose setting one or more environment variables. Does NOT write immediately — it " +
        "raises a confirmation card in chat; the user reviews the keys and values and confirms " +
        "or denies, and the daemon applies the write on confirm. `workspace` scope writes the " +
        "current workspace's `.env`; `global` writes the daemon's `.env`. The workspace `.env` " +
        "is for non-secret values — route real credentials through a connected integration " +
        "(Link) instead. Returns immediately as `pending_confirmation`; call `env_get` on a " +
        "later turn to verify.",
      inputSchema: {
        scope: EnvScopeSchema.default("workspace").describe(
          "'workspace' (default, the current workspace's .env) or 'global' (the daemon's .env)",
        ),
        vars: z
          .record(
            z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "env var keys must be POSIX identifiers"),
            z.string().regex(/^[^\r\n]*$/, "env var values must not contain newlines"),
          )
          .refine((v) => Object.keys(v).length > 0, "provide at least one env var to set")
          .describe("Environment variables to set, as a { KEY: value } map"),
        // ── Scope-injected (do not provide; runtime overrides) ───────────
        workspaceId: z.string().describe("(runtime-injected) current workspace identity"),
        sessionId: z.string().optional().describe("(runtime-injected) session identity"),
        actionId: z.string().optional().describe("(runtime-injected) FSM action id"),
        jobTimeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("(runtime-injected) parent job timeout in ms"),
      },
    },
    async ({
      scope,
      vars,
      workspaceId,
      sessionId,
      actionId,
      jobTimeoutMs,
    }): Promise<CallToolResult> => {
      const keys = Object.keys(vars);
      ctx.logger.info("MCP env_set called", { scope, workspaceId, keys });

      if (scope === "workspace" && !workspaceId) {
        return createErrorResponse(
          "workspaceId is missing from scope — cannot target 'workspace' env.",
        );
      }

      // Reads of secret-looking keys come back masked as `********`. An agent
      // doing read-modify-write would otherwise propose writing the mask
      // sentinel as the real value — refuse it rather than corrupt the `.env`.
      const maskedKeys = keys.filter((k) => vars[k] === MASKED_VALUE);
      if (maskedKeys.length > 0) {
        return createErrorResponse(
          `Refusing to write the masked sentinel (${MASKED_VALUE}) as a value for ` +
            `${maskedKeys.join(", ")}. env_get masks secret-looking keys — you can't round-trip ` +
            "a masked read into a write. Supply the real value, or leave the key unchanged.",
        );
      }

      const secretLookingKeys = keys.filter(isSecretKey);
      const where = scope === "global" ? "the global" : "this workspace's";
      const question =
        keys.length === 1
          ? `Set \`${keys[0]}\` in ${where} env?`
          : `Set ${keys.length} env vars (${keys.join(", ")}) in ${where} env?`;

      try {
        const created = await ElicitationStorage.create({
          // The elicitation lives in the session's workspace so the chat card
          // can find it; the write target is carried in `pendingTool.args`.
          workspaceId,
          sessionId: sessionId ?? "unknown",
          ...(actionId ? { actionId } : {}),
          kind: "env-write",
          question,
          options: [
            { label: "Confirm", value: "confirm" },
            { label: "Deny", value: "deny" },
          ],
          pendingTool: { name: "env_set", args: { scope, vars, workspaceId } },
          expiresAt: deriveElicitationExpiresAt(jobTimeoutMs),
        });
        if (!created.ok) {
          ctx.logger.error("env_set elicitation create failed", { scope, error: created.error });
          return createErrorResponse("Failed to create env-set confirmation", created.error);
        }

        // Non-blocking: the chat turn cannot wait. The daemon commits the
        // write when the user answers the card.
        return createSuccessResponse({
          status: "pending_confirmation",
          elicitationId: created.data.id,
          scope,
          keys,
          message:
            "Awaiting user confirmation in chat — nothing is written until the user confirms. " +
            "Call env_get on a later turn to verify.",
          ...(secretLookingKeys.length > 0
            ? {
                secretLookingKeys,
                note:
                  "Some keys look secret-bearing. The workspace .env is for non-secret values — " +
                  "consider connecting an integration (Link) for real credentials.",
              }
            : {}),
        });
      } catch (err) {
        ctx.logger.error("env_set threw", { scope, workspaceId, error: err });
        return createErrorResponse("env set failed", stringifyError(err));
      }
    },
  );
}
