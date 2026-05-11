/**
 * Message protocol shared by the SharedWorker entry and the page-side
 * client. Both sides import these types; the worker is the source of
 * truth for runtime semantics.
 *
 * Channels are an enumerable list rather than free-form subject patterns
 * because every consumer the playground has today fits one of five
 * shapes. Adding a channel is a deliberate act — the corresponding
 * filter function lives in `filters.ts`.
 *
 * @module
 */

/**
 * A frame pumped from `/api/me/stream`. Mirrors the
 * `ParsedFrame` shape the daemon emits in `apps/atlasd/routes/me/stream.ts`.
 */
export interface UpstreamFrame {
  kind: "elicitation" | "workspace-event" | "instance";
  workspaceId?: string;
  subject: string;
  payload: unknown;
}

/** Subscribe parameters per channel. Only the channels that need scoping have params. */
export type SubscribeParams =
  | { channel: "cascade" }
  | { channel: "global-elicitations" }
  | { channel: "workspace-elicitations"; workspaceId: string }
  | { channel: "schedule-events" }
  | { channel: "session-events"; sessionId: string };

/**
 * Per-turn fetch the chat transport routes through the worker. The
 * worker holds the socket; the page-side `WorkerChatTransport`
 * reconstructs a `Response` from the streamed bytes and hands it to
 * the AI SDK as if nothing changed. Cursor tracking (Last-Event-ID
 * resume) stays on the page so SSE parsing can stay on main as well —
 * this isolates the socket lifecycle from the UI thread without
 * forking the SDK's stream parser.
 */
export interface ChatTurnInit {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  credentials?: RequestCredentials;
}

/** Page → Worker. */
export type ClientMessage =
  | {
      type: "subscribe";
      subscriptionId: string;
      params: SubscribeParams;
    }
  | { type: "unsubscribe"; subscriptionId: string }
  /**
   * Open a chat turn fetch in the worker. Each turn gets its own
   * `MessageChannel`; the worker posts response metadata, body
   * chunks, and an end marker back over `port`. Cancel via
   * `chat-turn-abort`.
   */
  | {
      type: "chat-turn-open";
      turnId: string;
      init: ChatTurnInit;
    }
  | { type: "chat-turn-abort"; turnId: string };

/** Worker → Page. */
export type WorkerMessage =
  | { type: "frame"; subscriptionId: string; payload: unknown }
  | { type: "error"; subscriptionId: string; error: string }
  /** Upstream connection state change. Broadcast to every port. */
  | { type: "upstream"; state: "open" | "closed" }
  /** Chat-turn lifecycle messages. All correlated by `turnId`. */
  | {
      type: "chat-turn-response";
      turnId: string;
      status: number;
      statusText: string;
      headers: Record<string, string>;
    }
  | {
      type: "chat-turn-chunk";
      turnId: string;
      chunk: ArrayBuffer;
    }
  | { type: "chat-turn-end"; turnId: string }
  | { type: "chat-turn-error"; turnId: string; error: string };
