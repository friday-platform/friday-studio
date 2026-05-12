/**
 * Pure functions mapping an `UpstreamFrame` from `/api/me/stream` onto
 * the channel subscriptions that should receive it. Pulled into its own
 * module because the worker and its tests both need them, and a worker
 * module can't be imported from a unit test directly (no SharedWorker
 * scope in vitest).
 *
 * @module
 */

import type { SubscribeParams, UpstreamFrame } from "./protocol.ts";

/**
 * Does `frame` belong on `params`'s wire? The discriminated union over
 * `params.channel` means each branch can narrow `params` for params
 * type-safety.
 *
 * Cascade: instance-kind frames whose subject is under
 *   `instance.cascade.` — covers `queue_saturated`/`queue_drained`/
 *   `queue_timeout`/`replaced`. Other instance subjects (daemon health,
 *   future categories) shouldn't bleed into the cascade banner's view.
 *
 * Global elicitations: every elicitation the firehose carries. The
 *   daemon already filters down to workspaces the user has access to,
 *   so "global" really means "every accessible elicitation."
 *
 * Workspace elicitations: elicitations narrowed to one workspace id.
 *
 * Schedule events: workspace-event frames whose subject ends in
 *   `.schedule.<something>` (today only `.schedule.missed`, future:
 *   `.schedule.paused`). Other workspace events (signal lifecycle, etc.)
 *   don't show up on /schedules.
 *
 * Session events: served by a separate legacy route until the firehose
 *   absorbs `sessions.<sid>.events` — the worker's filter here is
 *   intentionally unreachable so wrappers can fall through to the
 *   legacy SSE without the worker thinking it's lost a message.
 */
export function matches(frame: UpstreamFrame, params: SubscribeParams): boolean {
  switch (params.channel) {
    case "cascade":
      return frame.kind === "instance" && frame.subject.startsWith("instance.cascade.");
    case "global-elicitations":
      return frame.kind === "elicitation";
    case "workspace-elicitations":
      return frame.kind === "elicitation" && frame.workspaceId === params.workspaceId;
    case "schedule-events":
      return frame.kind === "workspace-event" && /\.schedule\./.test(frame.subject);
    case "session-events":
      // Legacy route — see file-level doc.
      return false;
  }
}
