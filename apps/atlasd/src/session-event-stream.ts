/**
 * SessionEventStream — in-memory buffer for a single active session.
 *
 * Buffers durable events, broadcasts to SSE subscribers with full replay,
 * handles ephemeral chunks (broadcast-only, no persistence), and finalizes
 * sessions to the storage adapter.
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
import type { StreamController } from "./stream-registry.ts";

/**
 * Per-session event stream. Manages the lifecycle of a single session's
 * event buffer and SSE subscriber connections.
 */
export class SessionEventStream {
  private readonly sessionId: string;
  private readonly adapter: SessionHistoryAdapter;
  private readonly events: SessionStreamEvent[] = [];
  private readonly subscribers = new Set<StreamController>();
  private active = true;

  constructor(sessionId: string, adapter: SessionHistoryAdapter) {
    this.sessionId = sessionId;
    this.adapter = adapter;
  }

  /**
   * Emit a durable event: buffer it, broadcast to subscribers,
   * and fire-and-forget persist to the adapter.
   */
  emit(event: SessionStreamEvent): void {
    this.events.push(event);
    this.broadcast(event);
    this.adapter.appendEvent(this.sessionId, event).catch((err) => {
      logger.warn("Failed to persist session event", {
        sessionId: this.sessionId,
        eventType: event.type,
        error: String(err),
      });
    });
  }

  /**
   * Emit an ephemeral chunk: broadcast to subscribers only.
   * Not buffered, not persisted — lost if no subscribers are connected.
   */
  emitEphemeral(chunk: EphemeralChunk): void {
    this.broadcast(chunk);
  }

  /**
   * Subscribe a controller. Replays all buffered durable events immediately.
   * If the stream is finalized, replays then closes the connection.
   */
  subscribe(controller: StreamController): void {
    // Replay buffered events
    for (const event of this.events) {
      try {
        this.send(controller, event);
      } catch {
        return; // Controller closed during replay
      }
    }

    if (!this.active) {
      // Stream already finalized — close after replay
      try {
        controller.close();
      } catch {
        // Already closed
      }
      return;
    }

    this.subscribers.add(controller);
  }

  /** Remove a subscriber. */
  unsubscribe(controller: StreamController): void {
    this.subscribers.delete(controller);
  }

  /**
   * Finalize the session: persist all events + summary, close all subscribers.
   */
  async finalize(summary: SessionSummary): Promise<void> {
    this.active = false;

    await this.adapter.save(this.sessionId, [...this.events], summary);

    for (const controller of this.subscribers) {
      try {
        controller.close();
      } catch {
        // Already closed
      }
    }
    this.subscribers.clear();
  }

  /** Returns true while the session is still active (not finalized). */
  isActive(): boolean {
    return this.active;
  }

  /** Returns a copy of the buffered durable events. */
  getBufferedEvents(): SessionStreamEvent[] {
    return [...this.events];
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private broadcast(data: SessionStreamEvent | EphemeralChunk): void {
    for (const controller of this.subscribers) {
      try {
        this.send(controller, data);
      } catch {
        // Controller may be closed — will be cleaned up on unsubscribe
      }
    }
  }

  private send(controller: StreamController, data: SessionStreamEvent | EphemeralChunk): void {
    const isEphemeral = "chunk" in data;
    const prefix = isEphemeral ? "event: ephemeral\n" : "";
    const encoded = new TextEncoder().encode(`${prefix}data: ${JSON.stringify(data)}\n\n`);
    controller.enqueue(encoded);
  }
}
