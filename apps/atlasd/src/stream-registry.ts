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

/** Maximum events to buffer per stream */
const MAX_EVENTS = 1000;
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
  createdAt: number;
  lastEventAt: number;
  subscribers: Set<StreamController>;
}

export class StreamRegistry {
  private streams = new Map<string, StreamBuffer>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

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

    // Close all subscribers and clear streams
    for (const buffer of this.streams.values()) {
      for (const controller of buffer.subscribers) {
        try {
          controller.close();
        } catch {
          // Controller may already be closed
        }
      }
      buffer.subscribers.clear();
    }
    this.streams.clear();
    logger.info("StreamRegistry shutdown");
  }

  /**
   * Create a new stream buffer. Cancels existing stream for same chatId.
   */
  createStream(chatId: string): StreamBuffer {
    // Cancel existing stream if present
    const existing = this.streams.get(chatId);
    if (existing) {
      existing.active = false;
      for (const controller of existing.subscribers) {
        try {
          controller.close();
        } catch {
          // Controller may already be closed
        }
      }
      existing.subscribers.clear();
    }

    const now = Date.now();
    const buffer: StreamBuffer = {
      chatId,
      events: [],
      active: true,
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
   */
  appendEvent(chatId: string, event: AtlasUIMessageChunk): boolean {
    const buffer = this.streams.get(chatId);
    if (!buffer || !buffer.active) {
      return false;
    }

    buffer.events.push(event);
    buffer.lastEventAt = Date.now();

    // Enforce buffer limit - drop oldest events
    if (buffer.events.length > MAX_EVENTS) {
      const overflow = buffer.events.length - MAX_EVENTS;
      buffer.events.splice(0, overflow);
    }

    // Broadcast to all subscribers
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
   * Returns false if stream doesn't exist.
   */
  subscribe(chatId: string, controller: StreamController): boolean {
    const buffer = this.streams.get(chatId);
    if (!buffer) {
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
   * Mark stream as finished. Closes all subscribers but keeps buffer for replay.
   */
  finishStream(chatId: string): void {
    const buffer = this.streams.get(chatId);
    if (!buffer) {
      return;
    }

    buffer.active = false;

    // Close all subscribers
    for (const controller of buffer.subscribers) {
      try {
        controller.close();
      } catch {
        // Controller may already be closed
      }
    }
    buffer.subscribers.clear();

    logger.debug("Stream finished", { chatId, eventCount: buffer.events.length });
  }

  /**
   * Manually trigger cleanup (for testing)
   */
  triggerCleanup(): void {
    this.cleanup();
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
        // Close subscribers before removing
        for (const controller of buffer.subscribers) {
          try {
            controller.close();
          } catch {
            // Controller may already be closed
          }
        }
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
export { FINISHED_TTL_MS, MAX_EVENTS, STALE_TTL_MS };
