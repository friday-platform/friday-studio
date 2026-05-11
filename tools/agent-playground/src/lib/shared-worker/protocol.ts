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

/** Page → Worker. */
export type ClientMessage =
  | {
      type: "subscribe";
      subscriptionId: string;
      params: SubscribeParams;
    }
  | { type: "unsubscribe"; subscriptionId: string };

/** Worker → Page. */
export type WorkerMessage =
  | { type: "frame"; subscriptionId: string; payload: unknown }
  | { type: "error"; subscriptionId: string; error: string }
  /** Upstream connection state change. Broadcast to every port. */
  | { type: "upstream"; state: "open" | "closed" };
