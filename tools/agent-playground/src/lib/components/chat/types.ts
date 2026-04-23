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

/**
 * Flattened tool-call shape extracted from a message's `parts` array at
 * render time. Covers both static `tool-<name>` parts and the `dynamic-tool`
 * fallback. The chat message list renders these as inline status cards so
 * the user can see tool activity live instead of staring at a long pause
 * while Friday fetches URLs or runs Python.
 *
 * See AI SDK v6's `ToolUIPart<TOOLS>` and `DynamicToolUIPart` types for the
 * canonical source — we flatten to a single string-based shape because the
 * rendering component doesn't need type-level tool discrimination.
 */
export interface ToolCallDisplay {
  toolCallId: string;
  toolName: string;
  state:
    | "input-streaming"
    | "input-available"
    | "approval-requested"
    | "approval-responded"
    | "output-available"
    | "output-error"
    | "output-denied";
  /** Tool arguments (may be partial during `input-streaming`). */
  input?: unknown;
  /** Tool result once `state === "output-available"`. */
  output?: unknown;
  /** Error message when `state === "output-error"`. */
  errorText?: string;
}

export interface ImageDisplay {
  url: string;
  filename?: string;
  mediaType: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  scheduleProposal?: ScheduleProposal;
  /**
   * Tool calls emitted by the assistant for this message, in stream order.
   * Non-empty means the chat message list should render a status card for
   * each call before the text content — this is what gives the user
   * visibility into "Friday is fetching the WoW news page" instead of
   * a silent 4-second pause. Ignored for user and system messages.
   */
  toolCalls?: ToolCallDisplay[];
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
   * agent + model" section. All fields are optional because legacy
   * messages won't carry them.
   */
  metadata?: {
    agentId?: string;
    jobName?: string;
    provider?: string;
    modelId?: string;
    sessionId?: string;
  };
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
