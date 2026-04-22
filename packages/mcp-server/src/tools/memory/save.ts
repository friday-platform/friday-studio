import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";
import { resolveCorpus } from "./resolve.ts";

/** Register MCP tool for saving an entry to a workspace memory corpus. */
export function registerMemorySaveTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "memory_save",
    {
      description:
        "Save an entry to a named memory corpus in a workspace. " +
        "The corpus must be declared in workspace.yml under `memory.own` (or reachable via an `rw` mount) — undeclared corpora are rejected with the list of declared ones. " +
        "The corpus strategy (narrative, retrieval, dedup, kv) is resolved from the workspace config — you do not need to know the adapter type. " +
        "Entries persist across sessions. Use for facts, decisions, and notes the agent should remember long-term. " +
        "For session-scoped ephemeral state, use state_append instead.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID (runtime id like `grilled_xylem`)"),
        memoryName: z
          .string()
          .describe("Corpus name as declared in `memory.own` or a mount alias (e.g. 'notes')"),
        text: z.string().min(1, "text is required"),
        id: z.string().optional().describe("UUID; auto-generated if omitted"),
        author: z.string().optional(),
        createdAt: z.string().optional().describe("ISO 8601; server fills in if omitted"),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({
      workspaceId,
      memoryName,
      text,
      id,
      author,
      createdAt,
      metadata,
    }): Promise<CallToolResult> => {
      ctx.logger.info("MCP memory_save called", { workspaceId, memoryName });

      const resolved = await resolveCorpus({
        daemonUrl: ctx.daemonUrl,
        workspaceId,
        memoryName,
        op: "write",
        logger: ctx.logger,
      });
      if (!resolved.ok) {
        return createErrorResponse(resolved.error);
      }

      const { effectiveWorkspaceId, effectiveMemoryName, strategy } = resolved.resolved;

      if (strategy !== "narrative") {
        return createErrorResponse(
          `memory_save currently only supports narrative corpora. Corpus '${memoryName}' has strategy '${strategy}'. Use the strategy-specific tools (memory_${strategy}_*) for now.`,
        );
      }

      const url = `${ctx.daemonUrl}/api/memory/${encodeURIComponent(effectiveWorkspaceId)}/narrative/${encodeURIComponent(effectiveMemoryName)}`;

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, id, author, createdAt, metadata }),
        });
        if (!res.ok) {
          const body = await res.text();
          ctx.logger.error("memory_save HTTP failed", {
            workspaceId,
            memoryName,
            status: res.status,
            body,
          });
          return createErrorResponse(`memory save failed: HTTP ${res.status}`, body);
        }
        const appended = await res.json();
        return createSuccessResponse({
          saved: appended,
          workspaceId: effectiveWorkspaceId,
          memoryName: effectiveMemoryName,
        });
      } catch (err) {
        ctx.logger.error("memory_save fetch error", { workspaceId, memoryName, error: err });
        return createErrorResponse("memory save failed: network error", stringifyError(err));
      }
    },
  );
}
