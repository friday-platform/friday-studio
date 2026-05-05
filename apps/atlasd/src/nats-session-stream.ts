/**
 * NATS-backed session event stream.
 *
 * Persists durable events through the JetStream-backed history adapter
 * (which publishes them to the SESSION_EVENTS stream with per-event
 * `Nats-Msg-Id` dedup). Also maintains an in-memory buffer for fast
 * access by list/get endpoints.
 *
 * Ephemeral chunks (streaming LLM tokens) go to a NATS core subject —
 * live only, no persistence, no replay.
 *
 * @module
 */

import type {
  EphemeralChunk,
  SessionHistoryAdapter,
  SessionStreamEvent,
  SessionSummary,
} from "@atlas/core";
import { logger } from "@atlas/logger";
import type { NatsConnection } from "nats";

export class NatsSessionStream {
  private readonly events: SessionStreamEvent[] = [];
  private active = true;
  private pendingWriteCount = 0;
  private readonly flushResolvers: Array<() => void> = [];

  constructor(
    private readonly sessionId: string,
    private readonly adapter: SessionHistoryAdapter,
    private readonly nc: NatsConnection,
  ) {}

  /**
   * Emit a durable event: buffer it and persist via the history adapter.
   */
  emit(event: SessionStreamEvent): void {
    this.events.push(event);

    this.pendingWriteCount++;
    this.adapter
      .appendEvent(this.sessionId, event)
      .catch((err) => {
        logger.warn("Failed to persist session event", {
          sessionId: this.sessionId,
          eventType: event.type,
          error: String(err),
        });
      })
      .finally(() => {
        this.pendingWriteCount--;
        if (this.pendingWriteCount === 0) {
          for (const resolve of this.flushResolvers) resolve();
          this.flushResolvers.length = 0;
        }
      });
  }

  /**
   * Emit an ephemeral chunk: NATS core publish only (not JetStream).
   * No persistence, no replay — lost if no subscribers are connected.
   */
  emitEphemeral(chunk: EphemeralChunk): void {
    try {
      this.nc.publish(
        `sessions.${this.sessionId}.ephemeral`,
        new TextEncoder().encode(JSON.stringify(chunk)),
      );
    } catch (err) {
      logger.warn("Failed to publish ephemeral chunk to NATS", {
        sessionId: this.sessionId,
        error: String(err),
      });
    }
  }

  /**
   * Wait for all in-flight appendEvent writes to settle.
   */
  flush(): Promise<void> {
    if (this.pendingWriteCount === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.flushResolvers.push(resolve);
    });
  }

  /**
   * Finalize the session: flush pending writes, persist summary to disk.
   * SSE subscribers close themselves when they receive the session:complete event.
   */
  async finalize(summary: SessionSummary): Promise<void> {
    this.active = false;
    await this.flush();
    await this.adapter.save(this.sessionId, [...this.events], summary);
  }

  isActive(): boolean {
    return this.active;
  }

  getBufferedEvents(): SessionStreamEvent[] {
    return [...this.events];
  }
}
