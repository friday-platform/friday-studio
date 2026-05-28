import { client, parseResult } from "@atlas/client/v2";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

/**
 * Register MCP tool for loading a bounded-output summary of a chat.
 *
 * Companion to `read_chat` (friday-studio-vp0). Prefer this tool when
 * the source chat is large or you are continuing a prior conversation —
 * the server runs map-reduce summarization and caches per (chatId,
 * updatedAt), so the response stays small regardless of the source
 * chat's length.
 */
export function registerChatSummarizeTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "summarize_chat",
    {
      description:
        "Load a compact, bounded summary of another chat. Prefer this over `read_chat` when continuing a prior conversation — the server runs map-reduce summarization and caches per (chatId, updatedAt) so a stable chat short-circuits. Output stays small regardless of source size. Optional `focus` steers the summary (e.g. 'decisions and open questions').",
      inputSchema: {
        workspace_id: z.string().min(1).describe("Workspace containing the chat"),
        chat_id: z.string().min(1).describe("Chat id to summarize"),
        focus: z.string().max(500).optional().describe("Optional focus area to steer the summary"),
      },
    },
    async ({ workspace_id, chat_id, focus }): Promise<CallToolResult> => {
      ctx.logger.info("MCP summarize_chat called", {
        workspaceId: workspace_id,
        chatId: chat_id,
        hasFocus: Boolean(focus),
      });

      const response = await parseResult(
        client
          .workspaceChat(workspace_id)
          [":chatId"].summarize.$post({ param: { chatId: chat_id }, json: focus ? { focus } : {} }),
      );

      if (!response.ok) {
        return createErrorResponse("Failed to summarize chat", stringifyError(response.error));
      }

      const data = response.data as {
        summary: string;
        messageCount: number;
        modelId: string;
        generatedAt: string;
        cached: boolean;
      };
      return createSuccessResponse({
        summary: data.summary,
        messageCount: data.messageCount,
        modelId: data.modelId,
        generatedAt: data.generatedAt,
        cached: data.cached,
      });
    },
  );
}
