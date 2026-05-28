/**
 * summarize_chat — agent tool that loads a *bounded-output* summary of
 * another chat (friday-studio-g6q, parent friday-studio-0cc).
 *
 * The workspace-chat agent prefers this over `read_chat` when the
 * caller is continuing a prior conversation (e.g. the source chat ran
 * out of context and the user opened a new chat with an @-mention).
 * Server-side map-reduce keeps the response small regardless of source
 * size; the agent never has to ingest 100k tokens of raw transcript.
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { stringifyError } from "@atlas/utils";
import { tool } from "ai";
import { z } from "zod";

export function createSummarizeChatTool(logger: Logger): AtlasTools {
  return {
    summarize_chat: tool({
      description:
        "Load a compact, bounded summary of another chat. Prefer this over `read_chat` when you " +
        "are continuing a prior conversation — e.g. the user @-mentioned an older chat that ran " +
        "out of context. The server runs a map-reduce summarization and caches per (chatId, " +
        "updatedAt), so a stable chat short-circuits. Output stays small regardless of source " +
        "size; use this when read_chat would return more transcript than you can fit. " +
        "Optional `focus` steers the summary (e.g. 'decisions and open questions').",
      inputSchema: z.object({
        workspace_id: z
          .string()
          .min(1)
          .describe("Workspace containing the chat — same value the @-mention used."),
        chat_id: z.string().min(1).describe("Chat id to summarize."),
        focus: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Optional focus area to steer the summary (e.g. 'decisions and open questions').",
          ),
      }),
      execute: async ({ workspace_id, chat_id, focus }) => {
        const url = `${getAtlasDaemonUrl()}/api/workspaces/${encodeURIComponent(
          workspace_id,
        )}/chat/${encodeURIComponent(chat_id)}/summarize`;
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(focus ? { focus } : {}),
          });
          if (!res.ok) {
            const text = await res.text();
            logger.warn("summarize_chat failed", { url, status: res.status });
            return {
              ok: false as const,
              error: `summarize_chat failed: HTTP ${res.status}${text ? `: ${text}` : ""}`,
            };
          }
          const body = (await res.json()) as {
            summary?: string;
            messageCount?: number;
            modelId?: string;
            generatedAt?: string;
            cached?: boolean;
          };
          return {
            ok: true as const,
            summary: body.summary ?? "",
            messageCount: body.messageCount ?? 0,
            modelId: body.modelId ?? "",
            generatedAt: body.generatedAt ?? "",
            cached: body.cached ?? false,
          };
        } catch (err) {
          logger.warn("summarize_chat threw", { url, error: stringifyError(err) });
          return { ok: false as const, error: "summarize_chat failed: network error" };
        }
      },
    }),
  };
}
