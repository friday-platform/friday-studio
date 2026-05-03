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
 * UI-side mirror of @atlas/mcp's DisconnectedIntegration. Defined locally
 * because the playground bundles into a static SvelteKit build and pulling in
 * @atlas/mcp drags Node FFI deps into the browser. The shape is validated on
 * the wire by AtlasDataEventSchemas["integration-disconnected"].
 */
export interface DisconnectedIntegrationNotice {
  serverId: string;
  provider?: string;
  kind:
    | "credential_not_found"
    | "credential_expired"
    | "credential_refresh_failed"
    | "no_default_credential";
  message: string;
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
  /**
   * Nested tool calls reconstructed from `data-delegate-chunk` envelopes
   * forwarded by the `delegate` tool's proxy writer. Present only on
   * top-level `tool-delegate` entries; child IDs are namespaced as
   * `${delegateToolCallId}::${childToolCallId}`.
   */
  children?: ToolCallDisplay[];
  /**
   * Accumulated reasoning text from `reasoning-delta` chunks observed inside
   * `data-delegate-chunk` envelopes. Only populated for delegate/agent tool
   * entries that produced reasoning during their execution.
   */
  reasoning?: string;
  /**
   * Ephemeral progress lines from `data-tool-progress` events observed
   * inside delegate envelopes (e.g. "Analyzing query..." from the web agent).
   */
  progress?: string[];
  /**
   * Accumulated text response from `text-delta` chunks observed inside
   * `data-delegate-chunk` envelopes. This is the delegate agent's prose
   * output (e.g. a markdown summary table) rendered inline when the
   * delegate card is expanded.
   */
  delegateText?: string;
  /**
   * Server-reported duration in milliseconds for this tool call. Populated
   * from `data-delegate-ledger` entries when available. For nested agent
   * calls (e.g., fetch under agent_web), duration may be absent — the UI
   * falls back to client-side elapsed-time tracking.
   */
  durationMs?: number;
}

export interface ImageDisplay {
  url: string;
  filename?: string;
  mediaType: string;
}

/**
 * A segment within a {@link ChatMessage} that preserves the chronological
 * order of the assistant's stream.  Consecutive text parts are coalesced
 * into a single `text` segment; consecutive tool calls (and any reasoning
 * that arrived between them) are grouped into a `tool-burst` segment.
 *
 * This replaces the old split of `content: string` + `toolCalls[]` and
 * lets the UI render prose and tool activity in the order they actually
 * happened.
 */
export type Segment =
  | { type: "text"; content: string }
  | {
      type: "tool-burst";
      /** Deterministic id so open/closed state is stable across renders. */
      id: string;
      calls: ToolCallDisplay[];
      /** Coalesced reasoning text from `reasoning-delta` chunks observed inside this burst. */
      reasoning?: string;
    };

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
   * Non-fatal "this MCP integration is disconnected, reconnect to use it"
   * notices, sourced from `data-integration-disconnected` chunks. Rendered as
   * an info chip so the user can resolve the credential without the session
   * being treated as failed.
   */
  disconnectedIntegrations?: DisconnectedIntegrationNotice[];
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
