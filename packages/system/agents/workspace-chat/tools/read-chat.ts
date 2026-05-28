/**
 * read_chat — agent tool that loads the recent messages of another chat
 * by workspace + chat id. Powers the on-demand expansion of an @-mention
 * snapshot (see friday-studio-4j7 / friday-studio-ivt).
 *
 * The platform MCP server also registers a `read_chat` tool of the same
 * name (packages/mcp-server/src/tools/chat/read.ts), but the
 * workspace-chat agent draws from this AtlasTools registry rather than
 * the MCP server's tool list — hence this parallel definition.
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { stringifyError } from "@atlas/utils";
import { tool } from "ai";
import { z } from "zod";

export function createReadChatTool(logger: Logger): AtlasTools {
  return {
    read_chat: tool({
      description:
        "Load the recent messages of another chat by workspace + chat id. Use this to " +
        "expand an @-mention beyond the title+summary snapshot that was injected at send " +
        "time. The route returns the most-recent 100 messages of the referenced chat; " +
        "`limit` lets you keep fewer.",
      inputSchema: z.object({
        workspace_id: z
          .string()
          .min(1)
          .describe("Workspace containing the chat — same value the @-mention used."),
        chat_id: z.string().min(1).describe("Chat id to load."),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .default(100)
          .optional()
          .describe("Max messages to keep (most recent). Default + hard cap 100."),
      }),
      execute: async ({ workspace_id, chat_id, limit }) => {
        const url = `${getAtlasDaemonUrl()}/api/workspaces/${encodeURIComponent(
          workspace_id,
        )}/chat/${encodeURIComponent(chat_id)}`;
        try {
          const res = await fetch(url);
          if (!res.ok) {
            const text = await res.text();
            logger.warn("read_chat failed", { url, status: res.status });
            return {
              ok: false as const,
              error: `read_chat failed: HTTP ${res.status}${text ? `: ${text}` : ""}`,
            };
          }
          const body = (await res.json()) as {
            chat?: { id?: string; title?: string | null; workspaceId?: string };
            messages?: unknown[];
            totalMessageCount?: number;
          };
          const all = Array.isArray(body.messages) ? body.messages : [];
          const cap = limit ?? 100;
          const trimmed = all.slice(-cap);
          // `totalMessageCount` reflects messages in the source chat
          // regardless of any route-side trim (server caps at 100 by
          // default). Without it the agent would conclude
          // truncated=false when the route already dropped older
          // messages. See friday-studio-ns4.
          const total =
            typeof body.totalMessageCount === "number" ? body.totalMessageCount : all.length;
          return {
            ok: true as const,
            chat: {
              id: body.chat?.id ?? chat_id,
              title: body.chat?.title ?? null,
              workspaceId: body.chat?.workspaceId ?? workspace_id,
            },
            messages: trimmed,
            count: trimmed.length,
            totalMessageCount: total,
            truncated: total > trimmed.length,
          };
        } catch (err) {
          logger.warn("read_chat threw", { url, error: stringifyError(err) });
          return { ok: false as const, error: "read_chat failed: network error" };
        }
      },
    }),
  };
}
