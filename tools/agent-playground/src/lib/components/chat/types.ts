/**
 * Playground-local chat types. The backend always routes into the single
 * `user` workspace via Chat SDK per-workspace, so there's no "global chat"
 * matching or per-conversation workspace creation.
 *
 * AI SDK's `Chat` instance owns the real chat state (messages, streaming,
 * errors). The types here are just the thin wrappers used by:
 *
 *   1. `ChatMessage` — render-time shape for the message list, which
 *      flattens AtlasUIMessage's `parts` array into a single text string.
 *   2. `GetChatResponseSchema` — Zod shape of the rehydrate endpoint so the
 *      component can recover from a page reload.
 *
 * @module
 */

import { z } from "zod";

/**
 * Render-shape types live in `@atlas/core/chat/export/render` so the chat
 * export route in `apps/atlasd` can reuse them. Re-exported here so existing
 * agent-playground imports continue to resolve.
 */
import type {
  ImageDisplay,
  Segment,
  ToolCallDisplay,
} from "@atlas/core/chat/export/render";
export type { ImageDisplay, Segment, ToolCallDisplay };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  /**
   * Chronological stream segments for this message.  For assistant
   * messages this preserves the true interleaving of text and tool
   * activity from `msg.parts[]`.  For user and system messages this
   * is typically a single `text` segment.
   */
  segments: Segment[];
  timestamp: number;
  /** Image attachments from the user (data URLs from drag-drop / paste). */
  images?: ImageDisplay[];
  /**
   * Error text surfaced for this turn — sourced from `data-error` /
   * `data-agent-error` / `data-agent-timeout` chunks. Rendered as a visible
   * red bubble so session failures that produced no text content don't
   * leave the thinking indicator as the only feedback.
   */
  errorText?: string;
  /**
   * Provider/model/agent metadata stamped by workspace-chat on the
   * outgoing stream. Powers the chat-inspector Context tab's "Active
   * agent + model" section, and the per-message timestamp menu. All
   * fields are optional because legacy messages won't carry them.
   */
  metadata?: {
    agentId?: string;
    jobName?: string;
    provider?: string;
    modelId?: string;
    sessionId?: string;
    /**
     * Per-turn token + cache usage. Populated by workspace-chat from
     * `streamText.totalUsage` so the inline usage badge can render
     * without re-fetching session events. Cache fields are absent when
     * the provider didn't surface them (e.g. some non-Anthropic
     * non-OpenAI providers).
     */
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    /** ISO timestamp when the model began emitting output for this
     *  turn. Pairs with `endTimestamp` to compute turn duration.
     *  Preferred for display when present. */
    startTimestamp?: string;
    /** ISO timestamp from any single-shot message that doesn't span a
     *  stream (used by the chat export route when no stream-start was
     *  recorded). */
    timestamp?: string;
    /** ISO timestamp when the model's terminal finish event landed. */
    endTimestamp?: string;
  };
}

/**
 * Schema for `GET /api/workspaces/user/chat/:chatId` — used to rehydrate
 * messages after a page reload. Messages are typed as `z.unknown()` since
 * the component parses their `parts` array structurally at render time.
 *
 * Also reused by the chat-export orchestrator route. The inner `chat`
 * object uses `.passthrough()` so future daemon-side fields don't break
 * either consumer (the live UI only reads known fields; the export path
 * forwards the full object into `chat.json`).
 */
export const GetChatResponseSchema = z.object({
  chat: z
    .object({
      id: z.string(),
      userId: z.string(),
      workspaceId: z.string(),
      source: z.string(),
      title: z.string().optional(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .passthrough(),
  messages: z.array(z.unknown()),
  systemPromptContext: z
    .object({
      timestamp: z.string(),
      systemMessages: z.array(z.string()),
    })
    .nullable(),
});
