import process from "node:process";
import { PLATFORM_TOOL_NAMES } from "@atlas/agent-sdk";
import { resolvePermissions } from "@atlas/config/permissions";
import { ElicitationStorage } from "@atlas/core/elicitations";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

/**
 * Fallback elicitation TTL when neither `jobTimeoutMs` (runtime-injected)
 * nor a workspace default propagates through scope. 30 minutes is the
 * informational TTL for MVP — the elicitation expires either way; the
 * real lifecycle gate is the parent job's timeout.
 */
const DEFAULT_ELICITATION_TTL_MS = 30 * 60 * 1000;
const DISCOVERY_TOOLS = [
  "list_capabilities",
  "search_mcp_servers",
  "install_mcp_server",
  "enable_mcp_server",
  "disable_mcp_server",
  "create_mcp_server",
  "get_mcp_dependencies",
  "list_mcp_tools",
  "connect_service",
  "connect_communicator",
];
const WAIT_POLL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTerminalElicitation(
  id: string,
  expiresAt: string,
): Promise<{ status: "answered" | "declined" | "expired"; value?: string; note?: string }> {
  while (Date.now() < new Date(expiresAt).getTime()) {
    const got = await ElicitationStorage.get({ id });
    if (!got.ok) throw new Error(got.error);
    const current = got.data;
    if (!current) throw new Error(`Elicitation ${id} disappeared while waiting`);
    if (current.status === "answered") {
      return {
        status: "answered",
        value: current.answer?.value,
        ...(current.answer?.note ? { note: current.answer.note } : {}),
      };
    }
    if (current.status === "declined") {
      return { status: "declined", ...(current.answer?.note ? { note: current.answer.note } : {}) };
    }
    if (current.status === "expired") return { status: "expired" };
    await sleep(WAIT_POLL_MS);
  }
  return { status: "expired" };
}

/**
 * Zod shape for a `PermissionsConfig` mirror. Kept narrow on purpose — the
 * tool only cares about `dangerouslySkipAllowlist` today; future fields
 * land here when other permissions resolve at call time.
 */
const PermissionsShape = z.object({ dangerouslySkipAllowlist: z.boolean().optional() });

/** Pre-resolved permissions shape (review N2 — single source of truth). */
const ResolvedPermissionsShape = z.object({ dangerouslySkipAllowlist: z.boolean() });

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
        // Review N2: prefer pre-resolved permissions when the runtime
        // (fsm-engine.buildTools) has already merged job/workspace/daemon.
        // The raw fields below remain a fall-through for callers that
        // don't have a resolution context handy.
        resolvedPermissions: ResolvedPermissionsShape.optional().describe(
          "(runtime-injected) effective permissions, pre-resolved",
        ),
        jobPermissions: PermissionsShape.optional().describe(
          "(runtime-injected) per-job permissions config (fallback if resolvedPermissions absent)",
        ),
        workspacePermissions: PermissionsShape.optional().describe(
          "(runtime-injected) workspace-level permissions config (fallback)",
        ),
        // Review N3: when set, derives expiresAt = now + jobTimeoutMs so
        // the elicitation TTL matches the job lifetime per the user-
        // resolved Phase 12 policy. Falls back to DEFAULT_ELICITATION_TTL_MS.
        jobTimeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("(runtime-injected) parent job timeout in ms"),
        availableToolNames: z
          .array(z.string())
          .optional()
          .describe("(runtime-injected) catalog of real tools known to this runtime"),
      },
    },
    async ({
      toolName,
      reason,
      workspaceId,
      sessionId,
      actionId,
      resolvedPermissions,
      jobPermissions,
      workspacePermissions,
      jobTimeoutMs,
      availableToolNames,
    }): Promise<CallToolResult> => {
      // Review N2: prefer resolvedPermissions when present. Falls back to
      // resolving from raw fields at call time so callers without a
      // resolution context still work.
      const effective =
        resolvedPermissions ??
        resolvePermissions({
          job: jobPermissions,
          workspace: workspacePermissions,
          daemonDangerouslySkipAllowlist: process.env.FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS === "1",
        });

      const knownTools = new Set([...(availableToolNames ?? []), ...PLATFORM_TOOL_NAMES]);
      if (!knownTools.has(toolName)) {
        ctx.logger.warn("request_tool_access rejected unknown tool", {
          toolName,
          workspaceId,
          sessionId,
          actionId,
        });
        return createSuccessResponse({
          ok: false,
          granted: false,
          reason: "unknown_tool",
          toolName,
          message: `Unknown tool '${toolName}'. Use capability discovery instead of requesting access to a guessed tool name.`,
          discoveryTools: DISCOVERY_TOOLS,
        });
      }

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
      // Review N3: derive expiresAt from job timeout when available so the
      // elicitation TTL matches the job lifetime; else default to 30 min.
      const now = new Date();
      const ttlMs = jobTimeoutMs ?? DEFAULT_ELICITATION_TTL_MS;
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

      // Review N4: warn-log when sessionId fallback fires. The fallback is
      // safe (Activity feed shows "unknown" rather than crashing the
      // create), but it masks bugs where future call sites forget to
      // thread sessionId through scope. Loud log gives operators a
      // bread-crumb without erroring out.
      if (!sessionId) {
        ctx.logger.warn("request_tool_access: missing sessionId in scope — using 'unknown'", {
          toolName,
          workspaceId,
          actionId,
        });
      }

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
        const terminal = await waitForTerminalElicitation(created.data.id, created.data.expiresAt);
        if (terminal.status === "answered") {
          const granted = terminal.value === "allow_once" || terminal.value === "allow_always";
          return createSuccessResponse({
            ok: granted,
            granted,
            elicitationId: created.data.id,
            answer: terminal.value,
            reason: granted ? "answered" : "declined",
            ...(terminal.note ? { note: terminal.note } : {}),
          });
        }
        return createSuccessResponse({
          ok: false,
          granted: false,
          elicitationId: created.data.id,
          reason: terminal.status,
          ...(terminal.note ? { note: terminal.note } : {}),
        });
      } catch (err) {
        ctx.logger.error("request_tool_access threw", { toolName, workspaceId, error: err });
        return createErrorResponse("request_tool_access failed", stringifyError(err));
      }
    },
  );
}
