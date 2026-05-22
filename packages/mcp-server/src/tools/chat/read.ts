import { client, parseResult } from "@atlas/client/v2";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

/**
 * Register MCP tool for reading another chat's recent messages.
 *
 * Used by agents to expand an @-mention's frozen snapshot into the full
 * transcript on demand — the resolver injects only a title + summary at
 * send time (see friday-studio-ivt), and this tool lets the agent load
 * more when the summary is insufficient.
 *
 * The HTTP route gates on workspace membership, so a chat in a workspace
 * the caller can't access returns 404 / forbidden.
 */
export function registerChatReadTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "read_chat",
    {
      description:
        "Read the recent messages of another chat by workspace and chat id. Returns the chat title plus the last messages (up to `limit`, capped at 100). Use this to expand an @-mention beyond the title+summary snapshot that was injected at send time.",
      inputSchema: {
        workspace_id: z.string().min(1).describe("Workspace containing the chat"),
        chat_id: z.string().min(1).describe("Chat id to load"),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .default(100)
          .describe("Max messages to return (most recent first kept; default 100, hard cap 100)"),
      },
    },
    async ({ workspace_id, chat_id, limit }): Promise<CallToolResult> => {
      ctx.logger.info("MCP read_chat called", {
        workspaceId: workspace_id,
        chatId: chat_id,
        limit,
      });

      const response = await parseResult(
        client
          .workspaceChat(workspace_id)
          [":chatId"].$get({ param: { chatId: chat_id }, query: {} }),
      );

      if (!response.ok) {
        return createErrorResponse("Failed to read chat", stringifyError(response.error));
      }

      const { chat, messages, totalMessageCount } = response.data as {
        chat: { id: string; title?: string | null; workspaceId: string };
        messages: unknown[];
        totalMessageCount?: number;
      };
      const trimmed = messages.slice(-limit);
      // Use the route's totalMessageCount when available so `truncated`
      // reflects the source chat, not the slice the route returned.
      // See friday-studio-ns4.
      const total = typeof totalMessageCount === "number" ? totalMessageCount : messages.length;
      return createSuccessResponse({
        chat: { id: chat.id, title: chat.title ?? null, workspaceId: chat.workspaceId },
        messages: trimmed,
        count: trimmed.length,
        totalMessageCount: total,
        truncated: total > trimmed.length,
      });
    },
  );
}
