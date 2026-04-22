import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";
import { resolveNarrativeCorpus } from "./resolve.ts";

const EntryInput = z.object({
  text: z.string().min(1, "entry.text is required"),
  id: z.string().optional().describe("UUID; auto-generated if omitted"),
  author: z.string().optional(),
  createdAt: z.string().optional().describe("ISO 8601; server fills in if omitted"),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** Register MCP tool for appending an entry to a workspace's narrative memory. */
export function registerMemoryNarrativeAppendTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "memory_narrative_append",
    {
      description:
        "Append an entry to a named narrative memory in a workspace. " +
        "The target memory must be declared in workspace.yml under `memory.own` (or reachable via an `rw` mount) — undeclared memories are rejected with the list of declared ones. " +
        "Entries persist across sessions and are auto-injected into future workspace-chat turns via the system prompt. " +
        "Use this for conversational memory (notes the user wants remembered, facts learned, decisions made). " +
        "For session-scoped ephemeral state, use state_append instead.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID (runtime id like `grilled_xylem`)"),
        memoryName: z
          .string()
          .describe("Memory name as declared in `memory.own` or a mount name (e.g. 'notes')"),
        entry: EntryInput.describe("The entry to append"),
      },
    },
    async ({ workspaceId, memoryName, entry }): Promise<CallToolResult> => {
      ctx.logger.info("MCP memory_narrative_append called", { workspaceId, memoryName });

      const resolved = await resolveNarrativeCorpus({
        daemonUrl: ctx.daemonUrl,
        workspaceId,
        memoryName,
        op: "write",
        logger: ctx.logger,
      });
      if (!resolved.ok) {
        return createErrorResponse(resolved.error);
      }

      const { effectiveWorkspaceId, effectiveMemoryName } = resolved.resolved;
      const url = `${ctx.daemonUrl}/api/memory/${encodeURIComponent(effectiveWorkspaceId)}/narrative/${encodeURIComponent(effectiveMemoryName)}`;

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry),
        });
        if (!res.ok) {
          const body = await res.text();
          ctx.logger.error("memory_narrative_append HTTP failed", {
            workspaceId,
            memoryName,
            status: res.status,
            body,
          });
          return createErrorResponse(`memory append failed: HTTP ${res.status}`, body);
        }
        const appended = await res.json();
        return createSuccessResponse({
          appended,
          workspaceId: effectiveWorkspaceId,
          memoryName: effectiveMemoryName,
        });
      } catch (err) {
        ctx.logger.error("memory_narrative_append fetch error", {
          workspaceId,
          memoryName,
          error: err,
        });
        return createErrorResponse("memory append failed: network error", stringifyError(err));
      }
    },
  );
}
