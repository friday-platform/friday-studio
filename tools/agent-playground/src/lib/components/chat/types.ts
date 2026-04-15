/**
 * Playground-local chat types. The backend (Ken's chat-unification — see
 * docs/plans/2026-04-15-chat-unification.md) always routes into the single
 * `user` workspace via Chat SDK per-workspace, so there's no "global chat"
 * matching or per-conversation workspace creation — those concepts from the
 * old design were removed during the @ai-sdk/svelte migration.
 *
 * AI SDK's `Chat` instance owns the real chat state (messages, streaming,
 * errors). The types here are just the thin wrappers used by:
 *
 *   1. `ChatMessage` — render-time shape for the message list, which
 *      flattens AtlasUIMessage's `parts` array into a single text string
 *      and carries an optional schedule-proposal side-channel.
 *   2. `ScheduleProposal` — payload shown in the confirm/cancel card when
 *      the user types `/schedule <nl>`.
 *   3. `GetChatResponseSchema` — Zod shape of the rehydrate endpoint so the
 *      component can recover from a page reload.
 *
 * @module
 */

import { z } from "zod";

export interface ScheduleProposal {
  taskId: string;
  text: string;
  taskBrief: string;
  priority: number;
  kind: "feature" | "improvement" | "bugfix";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  scheduleProposal?: ScheduleProposal;
}

/**
 * Schema for `GET /api/workspaces/user/chat/:chatId` — used to rehydrate
 * messages after a page reload. Messages are typed as `z.unknown()` since
 * the component parses their `parts` array structurally at render time.
 */
export const GetChatResponseSchema = z.object({
  chat: z.object({
    id: z.string(),
    userId: z.string(),
    workspaceId: z.string(),
    source: z.string(),
    title: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  messages: z.array(z.unknown()),
  systemPromptContext: z
    .object({
      timestamp: z.string(),
      systemMessages: z.array(z.string()),
    })
    .nullable(),
});
