/**
 * Daemon-level routing for session-cancel commands.
 *
 * In-memory `sessionId → AbortController` table backed by one wildcard NATS
 * subscription. The subscription sits at `daemon.cancel.sessions.>` —
 * deliberately outside `sessions.>`, which the SESSION_EVENTS stream
 * captures, so cancel commands don't persist into the event log.
 *
 * Lifecycle:
 *   - `start()` registers the subscription and flushes — a publish that lands
 *     before the flush completes wouldn't have a live subscriber and would
 *     be dropped silently. After flush, the subscription is server-side
 *     guaranteed live for every subsequent dispatch.
 *   - `register()` adds a `(sessionId → controller)` entry. The dispatch
 *     calls this synchronously when it constructs the AbortController.
 *   - `deregister()` clears the entry on session settle.
 *   - `cancel()` is a static helper that publishes onto the cancel subject;
 *     callers that want to cancel a session via NATS use this rather than
 *     reaching into a runtime singleton.
 *   - `stop()` unsubscribes; called from daemon shutdown.
 *
 * `register()` does not write the inflight KV marker — that's the
 * adapter's job, written from `appendEvent` on the start event so
 * crash-recovery (`markInterruptedSessions`) finds sessions whose
 * dispatch never registered.
 */

import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import type { NatsConnection, Subscription } from "nats";

const CANCEL_SUBJECT_PREFIX = "daemon.cancel.sessions";

const SAFE_TOKEN_RE = /[^A-Za-z0-9_-]/g;
function sanitize(s: string): string {
  return s.replace(SAFE_TOKEN_RE, "_");
}

export function sessionCancelSubject(sessionId: string): string {
  return `${CANCEL_SUBJECT_PREFIX}.${sanitize(sessionId)}`;
}

interface RegistryEntry {
  controller: AbortController;
  workspaceId: string;
  signalId: string;
}

/**
 * Cancel reason payload. Subject already encodes the sessionId; the body
 * carries the optional human-readable reason that ends up on the
 * AbortError.
 */
export interface SessionCancelPayload {
  reason?: string;
}

/**
 * Publish a cancel for `sessionId`. Buffered + flushed so the caller can
 * be sure the broker has accepted the frame before tearing down its own
 * state. The cancel is fire-and-forget at the broker level — if no
 * subscriber is live (e.g. the session settled while the publish was in
 * flight) it's silently dropped, which is the right behaviour.
 */
export async function publishSessionCancel(
  nc: NatsConnection,
  sessionId: string,
  reason?: string,
): Promise<void> {
  const payload: SessionCancelPayload = reason ? { reason } : {};
  nc.publish(sessionCancelSubject(sessionId), new TextEncoder().encode(JSON.stringify(payload)));
  await nc.flush();
}

export class SessionDispatchRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private subscription: Subscription | null = null;
  private loop: Promise<void> | null = null;

  constructor(private readonly nc: NatsConnection) {}

  /**
   * Subscribe to the cancel-subject wildcard and flush. The flush is
   * non-negotiable: NATS subscribe() returns before the server has
   * registered the subscription, so a publish that beats the subscribe
   * round-trip would be silently dropped.
   */
  async start(): Promise<void> {
    if (this.subscription) return;
    this.subscription = this.nc.subscribe(`${CANCEL_SUBJECT_PREFIX}.>`);
    await this.nc.flush();

    const sub = this.subscription;
    this.loop = (async () => {
      const dec = new TextDecoder();
      for await (const msg of sub) {
        const sessionId = msg.subject.slice(`${CANCEL_SUBJECT_PREFIX}.`.length);
        let reason: string | undefined;
        try {
          if (msg.data.length > 0) {
            const body = JSON.parse(dec.decode(msg.data)) as Partial<SessionCancelPayload>;
            if (typeof body.reason === "string") {
              reason = body.reason;
            }
          }
        } catch {
          // Malformed body still cancels by subject — the sessionId is
          // authoritative.
        }
        this.handleCancel(sessionId, reason);
      }
    })();
    this.loop.catch((err) => {
      logger.debug("session cancel subscription ended", { error: stringifyError(err) });
    });
  }

  async stop(): Promise<void> {
    if (!this.subscription) return;
    try {
      this.subscription.unsubscribe();
    } catch {
      // already gone
    }
    this.subscription = null;
    if (this.loop) {
      try {
        await this.loop;
      } catch {
        // best-effort
      }
      this.loop = null;
    }
    this.entries.clear();
  }

  register(
    sessionId: string,
    controller: AbortController,
    ctx: { workspaceId: string; signalId: string },
  ): void {
    this.entries.set(sessionId, { controller, ...ctx });
  }

  deregister(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  /** Whether the registry is tracking an in-flight controller for the session. */
  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /** Locate the workspace owning an active session — used for authz on cancel. */
  workspaceOf(sessionId: string): string | undefined {
    return this.entries.get(sessionId)?.workspaceId;
  }

  /** Snapshot of currently-tracked sessions; used for shutdown drain. */
  list(): Array<{ sessionId: string; workspaceId: string; signalId: string }> {
    return Array.from(this.entries.entries()).map(([sessionId, e]) => ({
      sessionId,
      workspaceId: e.workspaceId,
      signalId: e.signalId,
    }));
  }

  private handleCancel(sessionId: string, reason: string | undefined): void {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      // Two ways this is normal: (1) session is on a different daemon
      // (cross-instance cancel), (2) session settled between publish and
      // delivery. Debug-level so we don't spam in either case.
      logger.debug("session cancel for untracked session", { sessionId });
      return;
    }
    // Use a named AbortError so classifySessionError routes this to CANCELLED.
    const abortReason = new Error(reason ?? "Session cancelled");
    abortReason.name = "AbortError";
    entry.controller.abort(abortReason);
    logger.info("session cancelled via NATS", {
      sessionId,
      workspaceId: entry.workspaceId,
      signalId: entry.signalId,
      reason,
    });
  }
}
