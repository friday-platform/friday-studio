import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";
import { resolveNarrativeCorpus } from "./resolve.ts";

/** Register MCP tool for removing a specific entry from a narrative memory. */
export function registerMemoryNarrativeForgetTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "memory_narrative_forget",
    {
      description:
        "Remove a single entry from a named narrative memory by its id. " +
        "Requires the memory to be in `memory.own` or an `rw` mount — read-only mounts are rejected. " +
        "Use sparingly; narrative memory is append-only by design and forgetting specific entries breaks audit trails.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID"),
        memoryName: z.string().describe("Memory name as declared in `memory.own` or a mount name"),
        entryId: z.string().describe("The id field of the entry to forget"),
      },
    },
    async ({ workspaceId, memoryName, entryId }): Promise<CallToolResult> => {
      ctx.logger.info("MCP memory_narrative_forget called", { workspaceId, memoryName, entryId });

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
      const url = `${ctx.daemonUrl}/api/memory/${encodeURIComponent(effectiveWorkspaceId)}/narrative/${encodeURIComponent(effectiveMemoryName)}/${encodeURIComponent(entryId)}`;

      try {
        const res = await fetch(url, { method: "DELETE" });
        if (res.status === 501) {
          return createErrorResponse("memory forget not implemented by the memory adapter");
        }
        if (!res.ok) {
          return createErrorResponse(`memory forget failed: HTTP ${res.status}`);
        }
        return createSuccessResponse({
          success: true,
          workspaceId: effectiveWorkspaceId,
          memoryName: effectiveMemoryName,
          entryId,
        });
      } catch (err) {
        ctx.logger.error("memory_narrative_forget fetch error", {
          workspaceId,
          memoryName,
          entryId,
          error: err,
        });
        return createErrorResponse("memory forget failed: network error", stringifyError(err));
      }
    },
  );
}
