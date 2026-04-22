import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";
import { resolveNarrativeCorpus } from "./resolve.ts";

/** Register MCP tool for reading entries from a workspace's narrative memory. */
export function registerMemoryNarrativeReadTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "memory_narrative_read",
    {
      description:
        "Read entries from a named narrative memory in a workspace, newest-first by default. " +
        "The target memory must be declared in workspace.yml under `memory.own` or as a mount — undeclared memories are rejected. " +
        "Note: narrative memory is also auto-injected into workspace-chat system prompts; calling this tool is only necessary for explicit lookup, filtering by time, or reading more entries than the default prompt window exposes.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID (runtime id like `grilled_xylem`)"),
        memoryName: z.string().describe("Memory name as declared in `memory.own` or a mount name"),
        since: z
          .string()
          .optional()
          .describe("ISO 8601 — return only entries created after this timestamp"),
        limit: z.number().int().positive().optional().describe("Max entries to return"),
      },
    },
    async ({ workspaceId, memoryName, since, limit }): Promise<CallToolResult> => {
      ctx.logger.info("MCP memory_narrative_read called", {
        workspaceId,
        memoryName,
        since,
        limit,
      });

      const resolved = await resolveNarrativeCorpus({
        daemonUrl: ctx.daemonUrl,
        workspaceId,
        memoryName,
        op: "read",
        logger: ctx.logger,
      });
      if (!resolved.ok) {
        return createErrorResponse(resolved.error);
      }

      const { effectiveWorkspaceId, effectiveMemoryName } = resolved.resolved;
      const queryParams = new URLSearchParams();
      if (since) queryParams.set("since", since);
      if (limit !== undefined) queryParams.set("limit", String(limit));
      const query = queryParams.toString();
      const url = `${ctx.daemonUrl}/api/memory/${encodeURIComponent(effectiveWorkspaceId)}/narrative/${encodeURIComponent(effectiveMemoryName)}${query ? `?${query}` : ""}`;

      try {
        const res = await fetch(url);
        if (!res.ok) {
          return createErrorResponse(`memory read failed: HTTP ${res.status}`);
        }
        const entries = await res.json();
        return createSuccessResponse({
          entries,
          count: Array.isArray(entries) ? entries.length : 0,
          workspaceId: effectiveWorkspaceId,
          memoryName: effectiveMemoryName,
        });
      } catch (err) {
        ctx.logger.error("memory_narrative_read fetch error", {
          workspaceId,
          memoryName,
          error: err,
        });
        return createErrorResponse("memory read failed: network error", stringifyError(err));
      }
    },
  );
}
