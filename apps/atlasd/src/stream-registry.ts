/**
 * StreamRegistry - Event buffering for SSE stream resumption
 *
 * Maintains in-memory buffers of streaming events so clients that
 * disconnect can resume without missing messages.
 */

import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { logger } from "@atlas/logger";

/** Minimal interface for stream controllers - what we actually use */
export interface StreamController {
  enqueue(chunk: Uint8Array): void;
  close(): void;
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
 */
const MAX_EVENTS = 50_000;
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

  /** Encode and cache the [DONE] sentinel once */
  private static readonly DONE_CHUNK = new TextEncoder().encode("data: [DONE]\n\n");

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
   * Buffer overflow policy: we never evict recorded events. Dropping the
   * oldest chunk of a `text-start → text-delta* → text-end` triple breaks
   * the UI message protocol for any late subscriber that tries to replay.
   * Instead, once we hit {@link MAX_EVENTS} we stop appending and flag
   * the buffer as non-replayable; live subscribers keep receiving events
   * via the broadcast below, but `subscribe()` refuses new joiners.
   */
  appendEvent(chatId: string, event: AtlasUIMessageChunk): boolean {
    const buffer = this.streams.get(chatId);
    if (!buffer?.active) {
      return false;
    }

    if (!buffer.replayDisabled && buffer.events.length >= MAX_EVENTS) {
      buffer.replayDisabled = true;
      logger.warn("stream_buffer_overflow_replay_disabled", {
        chatId,
        bufferedEvents: buffer.events.length,
        limit: MAX_EVENTS,
      });
    }
    if (!buffer.replayDisabled) {
      buffer.events.push(event);
    }
    buffer.lastEventAt = Date.now();

    // Broadcast to all subscribers regardless of buffer state — they've
    // already seen every prior event and can keep processing this one.
    const encoder = new TextEncoder();
    const data = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

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
    const encoder = new TextEncoder();
    for (const event of buffer.events) {
      try {
        const data = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
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
   * Remove finished and stale streams
   */
  private cleanup(): void {
    const now = Date.now();
    let removed = 0;

    for (const [chatId, buffer] of this.streams) {
      const age = now - buffer.lastEventAt;

      // Remove finished streams after TTL
      if (!buffer.active && age > FINISHED_TTL_MS) {
        this.streams.delete(chatId);
        removed++;
        continue;
      }

      // Remove stale active streams after longer TTL
      if (buffer.active && age > STALE_TTL_MS) {
        StreamRegistry.closeSubscribers(buffer.subscribers);
        this.streams.delete(chatId);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug("Cleaned up streams", { removed, remaining: this.streams.size });
    }
  }
}

// Export constants for testing
export { CLEANUP_INTERVAL_MS, FINISHED_TTL_MS, MAX_EVENTS, STALE_TTL_MS };
