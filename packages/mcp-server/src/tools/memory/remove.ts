import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";
import { resolveStore } from "./resolve.ts";

/** Register MCP tool for removing a specific entry from a memory store. */
export function registerMemoryRemoveTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "memory_remove",
    {
      description:
        "Remove a single entry from a named memory store by its id. " +
        "Requires the store to be in `memory.own` or an `rw` mount — read-only mounts are rejected. " +
        "Use sparingly; narrative memory is append-only by design and removing entries breaks audit trails.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID (runtime id like `grilled_xylem`)"),
        memoryName: z.string().describe("Store name as declared in `memory.own` or a mount alias"),
        entryId: z.string().describe("The id field of the entry to remove"),
      },
    },
    async ({ workspaceId, memoryName, entryId }): Promise<CallToolResult> => {
      ctx.logger.info("MCP memory_remove called", { workspaceId, memoryName, entryId });

      const resolved = await resolveStore({
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
          return createErrorResponse("memory remove not implemented by the memory adapter");
        }
        if (!res.ok) {
          return createErrorResponse(`memory remove failed: HTTP ${res.status}`);
        }
        return createSuccessResponse({
          success: true,
          workspaceId: effectiveWorkspaceId,
          memoryName: effectiveMemoryName,
          entryId,
        });
      } catch (err) {
        ctx.logger.error("memory_remove fetch error", {
          workspaceId,
          memoryName,
          entryId,
          error: err,
        });
        return createErrorResponse("memory remove failed: network error", stringifyError(err));
      }
    },
  );
}
