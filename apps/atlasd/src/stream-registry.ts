/**
 * StreamRegistry - Event buffering for SSE stream resumption
 *
 * Maintains in-memory buffers of streaming events so clients that
 * disconnect can resume without missing messages.
 */

import process from "node:process";
import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { logger } from "@atlas/logger";

/** Minimal interface for stream controllers - what we actually use */
export interface StreamController {
  enqueue(chunk: Uint8Array): void;
  close(): void;
}

/**
 * Parse a positive integer from env or fall back to the default.
 * Rejects non-finite / non-positive values to avoid accidentally disabling
 * the cap with "0" or a typo.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Maximum events to buffer per stream.
 *
 * Picked to comfortably cover real-world turns — long python runs that
 * emit hundreds of stdout chunks, multi-tool plans, etc. — while still
 * bounding memory: 50k events × ~500 bytes ≈ 25 MB per active chat,
 * reaped after {@link FINISHED_TTL_MS} / {@link STALE_TTL_MS}.
 *
 * Previously 1000, which silently truncated the oldest events. That
 * broke `resumeStream()` replay — `text-delta` chunks survived while
 * their `text-start` got evicted, and the client rejected the stream
 * with "Received text-delta for missing text part with ID '0'".
 *
 * Evicting mid-stream is fundamentally unsafe because the UI message
 * protocol is positional (start → delta* → end). We now **stop
 * buffering on overflow** and mark the stream non-replayable, so late
 * subscribers get a clean 204 instead of a corrupt partial replay.
 *
 * Override via `FRIDAY_STREAM_MAX_EVENTS` — tenanted deployments typically
 * want a much smaller cap (e.g. 5000) to bound per-tenant memory.
 */
const MAX_EVENTS = envInt("FRIDAY_STREAM_MAX_EVENTS", 50_000);

/**
 * Hard ceiling on buffered events across every active stream in the
 * process. When appending a chunk would exceed this, the registry marks
 * the target buffer `replayDisabled` and refuses further recording — live
 * subscribers still receive the broadcast, but late reconnects get 204.
 *
 * Single-tenant local daemons can leave the default (10M events, ≈5 GB
 * worst case at 500 B/event); multi-tenant pods should drop it via
 * `FRIDAY_STREAM_TOTAL_EVENT_CEILING`.
 */
const TOTAL_EVENT_CEILING = envInt("FRIDAY_STREAM_TOTAL_EVENT_CEILING", 10_000_000);
/** TTL for finished streams (5 minutes) */
const FINISHED_TTL_MS = 5 * 60 * 1000;
/** TTL for stale active streams (30 minutes) */
const STALE_TTL_MS = 30 * 60 * 1000;
/** Cleanup check interval (1 minute) */
const CLEANUP_INTERVAL_MS = 60 * 1000;

export interface StreamBuffer {
  chatId: string;
  events: AtlasUIMessageChunk[];
  active: boolean;
  /**
   * True when the event buffer grew past {@link MAX_EVENTS} and we stopped
   * recording new chunks. Live subscribers still receive events via the
   * broadcast path, but late reconnects via `subscribe()` get refused so
   * they don't replay a corrupt prefix.
   */
  replayDisabled: boolean;
  createdAt: number;
  lastEventAt: number;
  subscribers: Set<StreamController>;
}

export class StreamRegistry {
  private streams = new Map<string, StreamBuffer>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Running total of events across every buffer in {@link streams}. Kept
   * as a cached counter so `appendEvent` can enforce {@link TOTAL_EVENT_CEILING}
   * without re-summing every stream on the hot path.
   */
  private totalEvents = 0;

  /** Has the total-ceiling warning fired already? Avoids log-spam under overflow. */
  private ceilingWarned = false;

  /** Shared encoder — TextEncoder is stateless, so one instance per process is safe. */
  private static readonly ENCODER = new TextEncoder();

  /** Encode and cache the [DONE] sentinel once */
  private static readonly DONE_CHUNK = StreamRegistry.ENCODER.encode("data: [DONE]\n\n");

  /**
   * Send [DONE] sentinel to all subscribers, close their controllers, and clear the set.
   */
  private static closeSubscribers(subscribers: Set<StreamController>): void {
    for (const controller of subscribers) {
      try {
        controller.enqueue(StreamRegistry.DONE_CHUNK);
      } catch {
        /* closed */
      }
      try {
        controller.close();
      } catch {
        /* closed */
      }
    }
    subscribers.clear();
  }

  /**
   * Start the cleanup interval
   */
  start(): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    logger.info("StreamRegistry started");
  }

  /**
   * Shutdown the registry - clear interval, close subscribers, clear streams
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Send [DONE] to all subscribers and clear streams
    for (const buffer of this.streams.values()) {
      StreamRegistry.closeSubscribers(buffer.subscribers);
    }
    this.streams.clear();
    this.totalEvents = 0;
    this.ceilingWarned = false;
    logger.info("StreamRegistry shutdown");
  }

  /**
   * Create a new stream buffer. Cancels existing stream for same chatId.
   */
  createStream(chatId: string): StreamBuffer {
    // Cancel existing stream if present — send [DONE] so clients exit cleanly
    const existing = this.streams.get(chatId);
    if (existing) {
      existing.active = false;
      StreamRegistry.closeSubscribers(existing.subscribers);
      // Releasing the old buffer's events: reclaim their quota before the
      // replacement buffer starts filling, so TOTAL_EVENT_CEILING doesn't
      // double-count a chat that keeps being restarted (e.g. a user in a
      // send-regenerate loop).
      this.totalEvents = Math.max(0, this.totalEvents - existing.events.length);
    }

    const now = Date.now();
    const buffer: StreamBuffer = {
      chatId,
      events: [],
      active: true,
      replayDisabled: false,
      createdAt: now,
      lastEventAt: now,
      subscribers: new Set(),
    };

    this.streams.set(chatId, buffer);
    logger.debug("Created stream buffer", { chatId });
    return buffer;
  }

  /**
   * Get stream buffer by chatId
   */
  getStream(chatId: string): StreamBuffer | undefined {
    return this.streams.get(chatId);
  }

  /**
   * Append event to buffer. Broadcasts to subscribers.
   * Returns false if stream doesn't exist or is inactive.
   *
   * Pass `expectedBuffer` to scope the write to a specific turn's buffer:
   * if a follow-up turn has replaced the buffer for this chatId, the stale
   * producer's late events are dropped instead of leaking into the new
   * turn's stream (where they'd arrive without a matching `text-start` and
   * trip the AI SDK's UI-message protocol validator).
   *
   * Buffer overflow policy: we never evict recorded events. Dropping the
   * oldest chunk of a `text-start → text-delta* → text-end` triple breaks
   * the UI message protocol for any late subscriber that tries to replay.
   * Instead, once we hit {@link MAX_EVENTS} we stop appending and flag
   * the buffer as non-replayable; live subscribers keep receiving events
   * via the broadcast below, but `subscribe()` refuses new joiners.
   */
  appendEvent(chatId: string, event: AtlasUIMessageChunk, expectedBuffer?: StreamBuffer): boolean {
    const buffer = this.streams.get(chatId);
    if (!buffer?.active) {
      return false;
    }
    if (expectedBuffer && buffer !== expectedBuffer) {
      return false;
    }

    // Two separate caps: per-buffer (MAX_EVENTS) guards a single runaway
    // chat; process-wide (TOTAL_EVENT_CEILING) guards the aggregate under
    // multi-tenant workloads. Either trip flips `replayDisabled` on this
    // buffer so late `subscribe()` callers get 204 instead of a corrupt
    // partial replay; live subscribers continue via the broadcast below.
    if (!buffer.replayDisabled) {
      if (buffer.events.length >= MAX_EVENTS) {
        buffer.replayDisabled = true;
        logger.warn("stream_buffer_overflow_replay_disabled", {
          chatId,
          bufferedEvents: buffer.events.length,
          limit: MAX_EVENTS,
        });
      } else if (this.totalEvents >= TOTAL_EVENT_CEILING) {
        buffer.replayDisabled = true;
        if (!this.ceilingWarned) {
          this.ceilingWarned = true;
          logger.warn("stream_registry_total_ceiling_hit_replay_disabled", {
            chatId,
            totalEvents: this.totalEvents,
            ceiling: TOTAL_EVENT_CEILING,
            activeStreams: this.streams.size,
          });
        }
      }
    }
    if (!buffer.replayDisabled) {
      buffer.events.push(event);
      this.totalEvents++;
    }
    buffer.lastEventAt = Date.now();

    // Broadcast to all subscribers regardless of buffer state — they've
    // already seen every prior event and can keep processing this one.
    const data = StreamRegistry.ENCODER.encode(`data: ${JSON.stringify(event)}\n\n`);

    for (const controller of buffer.subscribers) {
      try {
        controller.enqueue(data);
      } catch {
        // Controller may be closed - will be cleaned up on unsubscribe
      }
    }

    return true;
  }

  /**
   * Subscribe a controller to a stream. Replays all buffered events immediately.
   * Returns false if stream doesn't exist, is already finished, or replay was
   * disabled after a buffer overflow (replay would corrupt the UI message
   * protocol state on the joining client).
   */
  subscribe(chatId: string, controller: StreamController): boolean {
    const buffer = this.streams.get(chatId);
    if (!buffer?.active || buffer.replayDisabled) {
      return false;
    }

    // Replay buffered events to this subscriber
    for (const event of buffer.events) {
      try {
        const data = StreamRegistry.ENCODER.encode(`data: ${JSON.stringify(event)}\n\n`);
        controller.enqueue(data);
      } catch {
        // Controller closed during replay
        return false;
      }
    }

    buffer.subscribers.add(controller);
    logger.debug("Subscriber added", { chatId, subscriberCount: buffer.subscribers.size });
    return true;
  }

  /**
   * Unsubscribe a controller from a stream.
   */
  unsubscribe(chatId: string, controller: StreamController): void {
    const buffer = this.streams.get(chatId);
    if (buffer) {
      buffer.subscribers.delete(controller);
      logger.debug("Subscriber removed", { chatId, subscriberCount: buffer.subscribers.size });
    }
  }

  /**
   * Mark stream as finished. Sends [DONE] sentinel to all subscribers, then closes them.
   * Buffer is retained until TTL cleanup but not replayable after finish — the AI SDK's
   * resumeStream() creates a new message on full replay, causing duplicates. Late
   * reconnectors get 204 and rely on page reload for data consistency.
   */
  finishStream(chatId: string): void {
    const buffer = this.streams.get(chatId);
    if (!buffer) {
      return;
    }

    // Close subscribers first so they receive [DONE] while still in the set.
    // Setting active=false afterward prevents new subscriptions via subscribe().
    StreamRegistry.closeSubscribers(buffer.subscribers);
    buffer.active = false;

    logger.debug("Stream finished", { chatId, eventCount: buffer.events.length });
  }

  /**
   * Finish a stream only if it matches the given buffer reference. Used by
   * adapters that schedule a delayed close: if a new turn has replaced the
   * buffer since the timer was set, this is a no-op so the in-flight turn
   * doesn't get its subscribers ripped out from under it.
   */
  finishStreamIfCurrent(chatId: string, expected: StreamBuffer): void {
    const current = this.streams.get(chatId);
    if (current !== expected) {
      return;
    }
    this.finishStream(chatId);
  }

  /**
   * Remove finished and stale streams
   */
  private cleanup(): void {
    const now = Date.now();
    let removed = 0;
    let eventsFreed = 0;

    for (const [chatId, buffer] of this.streams) {
      const age = now - buffer.lastEventAt;

      // Remove finished streams after TTL
      if (!buffer.active && age > FINISHED_TTL_MS) {
        eventsFreed += buffer.events.length;
        this.streams.delete(chatId);
        removed++;
        continue;
      }

      // Remove stale active streams after longer TTL
      if (buffer.active && age > STALE_TTL_MS) {
        StreamRegistry.closeSubscribers(buffer.subscribers);
        eventsFreed += buffer.events.length;
        this.streams.delete(chatId);
        removed++;
      }
    }

    if (eventsFreed > 0) {
      this.totalEvents = Math.max(0, this.totalEvents - eventsFreed);
      // Reset the warn-once latch when we're back below the ceiling so a
      // future overflow re-logs. Anything else would eat repeat-incident
      // signal in long-running daemons.
      if (this.ceilingWarned && this.totalEvents < TOTAL_EVENT_CEILING) {
        this.ceilingWarned = false;
      }
    }

    if (removed > 0) {
      logger.debug("Cleaned up streams", {
        removed,
        remaining: this.streams.size,
        totalEvents: this.totalEvents,
      });
    }
  }
}

// Export constants for testing
export { CLEANUP_INTERVAL_MS, FINISHED_TTL_MS, MAX_EVENTS, STALE_TTL_MS };
