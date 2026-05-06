import process from "node:process";
import { resolvePermissions } from "@atlas/config";
import { ElicitationStorage } from "@atlas/core/elicitations";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

/**
 * Default elicitation TTL when the runtime doesn't pass one through.
 *
 * MVP scope (Phase 12.C): no auto-suspend / resume — the LLM that calls
 * `request_tool_access` gets a structured denial back synchronously and
 * `failStep`s. The user re-runs the job after answering. So `expiresAt` is
 * informational; the real lifecycle gate is the parent job's timeout.
 */
const DEFAULT_ELICITATION_TTL_MS = 30 * 60 * 1000;

/**
 * Zod shape for a `PermissionsConfig` mirror. Kept narrow on purpose — the
 * tool only cares about `dangerouslySkipAllowlist` today; future fields
 * land here when other permissions resolve at call time.
 */
const PermissionsShape = z.object({ dangerouslySkipAllowlist: z.boolean().optional() });

/**
 * Register the `request_tool_access` platform tool.
 *
 * **Phase 12.C + 1.C of the Bucket-3 plan.** The LLM calls this when it
 * wants to invoke a tool that isn't in its allowlist. The tool resolves
 * effective permissions (job > workspace > daemon env) and either:
 *
 * 1. **Bypass branch (Phase 1.C)** — `dangerouslySkipAllowlist` resolves
 *    `true` → returns `{ ok: true, granted: true, reason: "bypass" }` and
 *    logs at info level so operators can see it in the global log.
 * 2. **Elicitation branch (Phase 12.C)** — emits a `tool-allowlist`
 *    elicitation via `ElicitationStorage.create` and returns
 *    `{ ok: false, granted: false, elicitationId, reason: "pending_user_approval" }`.
 *    The LLM sees the structured denial; it can `failStep` or route around.
 *
 * MVP scope: no runtime auto-suspend on answered elicitations — the user
 * re-runs the job after answering. Suspend/resume is a follow-on phase.
 *
 * Scope injection: `workspaceId`, `sessionId`, `actionId`, `jobPermissions`,
 * and `workspacePermissions` are filled in by `wrapPlatformToolsWithScope`
 * at the AI-SDK boundary. They appear in the input schema because the
 * wrapper merges them into args before MCP-side Zod validation runs.
 */
export function registerRequestToolAccessTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "request_tool_access",
    {
      description:
        "Request permission to call a tool that isn't in your allowlist. " +
        "Use this when you need a capability you don't currently have. " +
        'Returns immediately with `{ granted: true, reason: "bypass" }` if the ' +
        "current job/workspace has `permissions.dangerouslySkipAllowlist`. " +
        "Otherwise emits a user-facing elicitation and returns " +
        '`{ granted: false, reason: "pending_user_approval", elicitationId }` — ' +
        "the LLM should `failStep` or route around the missing capability " +
        "(the user re-runs the job after answering).",
      inputSchema: {
        toolName: z.string().min(1).describe("Name of the tool you want to call"),
        reason: z
          .string()
          .min(1)
          .describe("Short rationale for the user — why you need this tool right now"),
        // ── Scope-injected fields (do not provide; runtime overrides) ─────
        workspaceId: z.string().describe("(runtime-injected) workspace identity"),
        sessionId: z.string().optional().describe("(runtime-injected) session identity"),
        actionId: z.string().optional().describe("(runtime-injected) FSM action id"),
        jobPermissions: PermissionsShape.optional().describe(
          "(runtime-injected) per-job permissions config",
        ),
        workspacePermissions: PermissionsShape.optional().describe(
          "(runtime-injected) workspace-level permissions config",
        ),
      },
    },
    async ({
      toolName,
      reason,
      workspaceId,
      sessionId,
      actionId,
      jobPermissions,
      workspacePermissions,
    }): Promise<CallToolResult> => {
      const daemonDangerouslySkipAllowlist =
        process.env.FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS === "1";

      const effective = resolvePermissions({
        job: jobPermissions,
        workspace: workspacePermissions,
        daemonDangerouslySkipAllowlist,
      });

      if (effective.dangerouslySkipAllowlist) {
        // Phase 1.C — bypass branch. Operators read this in
        // ~/.atlas/logs/global.log to spot which jobs run unsandboxed.
        ctx.logger.info("request_tool_access bypass", {
          toolName,
          reason,
          workspaceId,
          sessionId,
          actionId,
        });
        return createSuccessResponse({ ok: true, granted: true, reason: "bypass" });
      }

      // Phase 12.C — elicitation branch. Emit a tool-allowlist elicitation
      // and surface a structured denial so the LLM can fail-step cleanly.
      const now = new Date();
      const expiresAt = new Date(now.getTime() + DEFAULT_ELICITATION_TTL_MS).toISOString();

      try {
        const created = await ElicitationStorage.create({
          workspaceId,
          sessionId: sessionId ?? "unknown",
          ...(actionId && { actionId }),
          kind: "tool-allowlist",
          question: `Allow agent to call \`${toolName}\`? ${reason}`,
          options: [
            { label: "Allow once", value: "allow_once" },
            { label: "Allow always", value: "allow_always" },
            { label: "Deny", value: "deny" },
          ],
          pendingTool: { name: toolName, args: {} },
          expiresAt,
        });
        if (!created.ok) {
          ctx.logger.error("request_tool_access elicitation create failed", {
            toolName,
            workspaceId,
            error: created.error,
          });
          return createErrorResponse("Failed to create elicitation", created.error);
        }
        ctx.logger.info("request_tool_access elicitation created", {
          toolName,
          reason,
          workspaceId,
          sessionId,
          actionId,
          elicitationId: created.data.id,
        });
        return createSuccessResponse({
          ok: false,
          granted: false,
          elicitationId: created.data.id,
          reason: "pending_user_approval",
        });
      } catch (err) {
        ctx.logger.error("request_tool_access threw", { toolName, workspaceId, error: err });
        return createErrorResponse("request_tool_access failed", stringifyError(err));
      }
    },
  );
}
