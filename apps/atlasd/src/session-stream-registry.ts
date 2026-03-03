/**
 * SessionStreamRegistry — manages lifecycle of SessionEventStream instances.
 *
 * Creates/gets streams by sessionId, lists active streams, and handles
 * TTL eviction of finalized and stale streams. Mirrors StreamRegistry
 * pattern for chat streams.
 *
 * @module
 */

import type { SessionHistoryAdapter } from "@atlas/core";
import { logger } from "@atlas/logger";
import { SessionEventStream } from "./session-event-stream.ts";

/** TTL for finalized streams (5 minutes) */
const FINALIZED_TTL_MS = 5 * 60 * 1000;
/** TTL for stale active streams (30 minutes) */
const STALE_TTL_MS = 30 * 60 * 1000;
/** Cleanup check interval (1 minute) */
const CLEANUP_INTERVAL_MS = 60 * 1000;

interface StreamEntry {
  stream: SessionEventStream;
  createdAt: number;
  lastActivityAt: number;
}

/**
 * Registry for active session event streams. Singleton on the daemon,
 * accessed by route handlers for SSE subscriptions and event emission.
 */
export class SessionStreamRegistry {
  private streams = new Map<string, StreamEntry>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /** Start the cleanup interval. */
  start(): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    logger.info("SessionStreamRegistry started");
  }

  /** Shutdown: flush pending writes, clear all streams, stop cleanup. */
  async shutdown(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    await Promise.allSettled([...this.streams.values()].map((entry) => entry.stream.flush()));
    this.streams.clear();
    logger.info("SessionStreamRegistry shutdown");
  }

  /**
   * Create a new stream for a session. Replaces any existing stream
   * for the same sessionId.
   */
  create(sessionId: string, adapter: SessionHistoryAdapter): SessionEventStream {
    const now = Date.now();
    const stream = new SessionEventStream(sessionId, adapter);
    this.streams.set(sessionId, { stream, createdAt: now, lastActivityAt: now });
    return stream;
  }

  /** Get a stream by sessionId. */
  get(sessionId: string): SessionEventStream | undefined {
    return this.streams.get(sessionId)?.stream;
  }

  /** List only active (non-finalized) streams. */
  listActive(): SessionEventStream[] {
    const active: SessionEventStream[] = [];
    for (const entry of this.streams.values()) {
      if (entry.stream.isActive()) {
        active.push(entry.stream);
      }
    }
    return active;
  }

  /** Remove finalized streams after TTL, stale active streams after longer TTL. */
  private async cleanup(): Promise<void> {
    const now = Date.now();
    const toEvict: string[] = [];

    for (const [sessionId, entry] of this.streams) {
      const age = now - entry.lastActivityAt;

      if (!entry.stream.isActive() && age > FINALIZED_TTL_MS) {
        toEvict.push(sessionId);
        continue;
      }

      if (entry.stream.isActive() && age > STALE_TTL_MS) {
        toEvict.push(sessionId);
      }
    }

    if (toEvict.length > 0) {
      await Promise.allSettled(
        toEvict.map((id) => this.streams.get(id)?.stream.flush() ?? Promise.resolve()),
      );
      for (const id of toEvict) {
        this.streams.delete(id);
      }
      logger.debug("SessionStreamRegistry cleanup", {
        removed: toEvict.length,
        remaining: this.streams.size,
      });
    }
  }
}
