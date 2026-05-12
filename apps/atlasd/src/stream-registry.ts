/**
 * StreamRegistry - Event buffering for SSE stream resumption
 *
 * Maintains in-memory buffers of streaming events so clients that
 * disconnect can resume without missing messages.
 *
 * Buffers are keyed by `(workspaceId, chatId)` rather than `chatId`
 * alone. Chat ids are client-supplied opaque strings — without
 * workspace scoping, a member of workspace A could create / read /
 * finish a stream buffer that workspace B owns by guessing or leaking
 * the chat id. Every public method takes both args; internally the
 * map key is `${workspaceId}:${chatId}`.
 */

import process from "node:process";
import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { logger } from "@atlas/logger";

/** Composite key — `${workspaceId}:${chatId}`. */
function key(workspaceId: string, chatId: string): string {
  return `${workspaceId}:${chatId}`;
}

/** Minimal interface for stream controllers - what we actually use */
export interface StreamController {
  enqueue(chunk: Uint8Array): void;
  close(): void;
}

/** Rejects 0/NaN so a typo can't accidentally disable the cap. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Per-stream event cap (~25 MB at 500 B/event). On overflow we stop
 * buffering and flag {@link StreamBuffer.replayDisabled} — evicting
 * mid-stream would break the positional UI message protocol
 * (start → delta* → end) for late subscribers.
 */
const MAX_EVENTS = envInt("FRIDAY_STREAM_MAX_EVENTS", 50_000);

/** Process-wide cap for multi-tenant pods. Default leaves single-tenant alone. */
const TOTAL_EVENT_CEILING = envInt("FRIDAY_STREAM_TOTAL_EVENT_CEILING", 10_000_000);
/** TTL for finished streams (5 minutes) */
const FINISHED_TTL_MS = 5 * 60 * 1000;
/** TTL for stale active streams (30 minutes) */
const STALE_TTL_MS = 30 * 60 * 1000;
/** Cleanup check interval (1 minute) */
const CLEANUP_INTERVAL_MS = 60 * 1000;

export interface StreamBuffer {
  workspaceId: string;
  chatId: string;
  events: AtlasUIMessageChunk[];
  active: boolean;
  /** Set on overflow; live subscribers keep going, late reconnects get refused. */
  replayDisabled: boolean;
  createdAt: number;
  lastEventAt: number;
  subscribers: Set<StreamController>;
  /**
   * `${kind}:${id}` → events-index of the `*-start` for in-flight parts.
   * The AI SDK's `resumeStream()` creates a fresh `activeResponse` with
   * empty `activeToolInputs`/`activeTextParts` maps, so a `*-delta` past
   * the cursor without a re-emitted `*-start` trips the SDK's
   * "delta for missing part" validator.
   */
  openParts: Map<string, number>;
}

/**
 * Structural type guard — used at the `Message.raw` boundary in the chat
 * SDK handler where the value comes back as `unknown`. A bare cast there
 * would silently accept any object shape; if a buggy adapter ever stuffed
 * the wrong thing into `raw.turnBuffer`, the identity check in
 * `appendEvent` would just always mismatch and events would silently
 * drop. Better to validate the shape and short-circuit cleanly.
 */
export function isStreamBuffer(value: unknown): value is StreamBuffer {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<Record<keyof StreamBuffer, unknown>>;
  return (
    typeof v.workspaceId === "string" &&
    typeof v.chatId === "string" &&
    typeof v.active === "boolean" &&
    Array.isArray(v.events) &&
    v.subscribers instanceof Set &&
    v.openParts instanceof Map
  );
}

/**
 * Map a chunk to its slot in {@link StreamBuffer.openParts}.
 *
 * `tool-input-available` is also an opener: it carries the fully-formed
 * tool input, and a cursor landing between `-available` and
 * `-output-available` would otherwise leave the resumed client stuck in
 * `input-streaming`. Also covers tools that skip `-start` entirely
 * (non-streaming inputs).
 *
 * `start-step`/`finish-step` are not tracked — they don't carry state any
 * AI SDK validator checks; missing one only loses a UI marker.
 */
function partKey(event: AtlasUIMessageChunk): { key: string; opens: boolean } | null {
  switch (event.type) {
    case "text-start":
      return { key: `text:${event.id}`, opens: true };
    case "text-end":
      return { key: `text:${event.id}`, opens: false };
    case "reasoning-start":
      return { key: `reasoning:${event.id}`, opens: true };
    case "reasoning-end":
      return { key: `reasoning:${event.id}`, opens: false };
    case "tool-input-start":
    case "tool-input-available":
      return { key: `tool:${event.toolCallId}`, opens: true };
    case "tool-output-available":
    case "tool-output-error":
      return { key: `tool:${event.toolCallId}`, opens: false };
    default:
      return null;
  }
}

export class StreamRegistry {
  private streams = new Map<string, StreamBuffer>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /** Cached so `appendEvent` doesn't re-sum every buffer on the hot path. */
  private totalEvents = 0;

  /** Warn-once latch; reset by {@link cleanup} when totals fall back below ceiling. */
  private ceilingWarned = false;

  private static readonly ENCODER = new TextEncoder();
  private static readonly DONE_CHUNK = StreamRegistry.ENCODER.encode("data: [DONE]\n\n");

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

  start(): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    logger.info("StreamRegistry started");
  }

  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    for (const buffer of this.streams.values()) {
      StreamRegistry.closeSubscribers(buffer.subscribers);
    }
    this.streams.clear();
    this.totalEvents = 0;
    this.ceilingWarned = false;
    logger.info("StreamRegistry shutdown");
  }

  /** Replaces any existing stream for the same (workspace, chat). */
  createStream(workspaceId: string, chatId: string): StreamBuffer {
    const k = key(workspaceId, chatId);
    const existing = this.streams.get(k);
    if (existing) {
      existing.active = false;
      StreamRegistry.closeSubscribers(existing.subscribers);
      // Reclaim quota so a send-regenerate loop doesn't double-count.
      this.totalEvents = Math.max(0, this.totalEvents - existing.events.length);
    }

    const now = Date.now();
    const buffer: StreamBuffer = {
      workspaceId,
      chatId,
      events: [],
      active: true,
      replayDisabled: false,
      createdAt: now,
      lastEventAt: now,
      subscribers: new Set(),
      openParts: new Map(),
    };

    this.streams.set(k, buffer);
    logger.debug("Created stream buffer", { workspaceId, chatId });
    return buffer;
  }

  getStream(workspaceId: string, chatId: string): StreamBuffer | undefined {
    return this.streams.get(key(workspaceId, chatId));
  }

  /**
   * Append and broadcast. Returns false if stream is gone, inactive, or
   * `expectedBuffer` doesn't match the current buffer (stale producer
   * after a turn replaced it — its late events would arrive without a
   * matching `text-start` and trip the SDK validator).
   *
   * On overflow we flag {@link StreamBuffer.replayDisabled} and stop
   * recording (live subscribers continue via broadcast). We never evict —
   * dropping the oldest of a `text-start → text-delta* → text-end` triple
   * corrupts the UI message protocol for any future replay.
   */
  appendEvent(
    workspaceId: string,
    chatId: string,
    event: AtlasUIMessageChunk,
    expectedBuffer?: StreamBuffer,
  ): boolean {
    const buffer = this.streams.get(key(workspaceId, chatId));
    if (!buffer?.active) {
      return false;
    }
    if (expectedBuffer && buffer !== expectedBuffer) {
      return false;
    }

    if (!buffer.replayDisabled) {
      if (buffer.events.length >= MAX_EVENTS) {
        buffer.replayDisabled = true;
        logger.warn("stream_buffer_overflow_replay_disabled", {
          workspaceId,
          chatId,
          bufferedEvents: buffer.events.length,
          limit: MAX_EVENTS,
        });
      } else if (this.totalEvents >= TOTAL_EVENT_CEILING) {
        buffer.replayDisabled = true;
        if (!this.ceilingWarned) {
          this.ceilingWarned = true;
          logger.warn("stream_registry_total_ceiling_hit_replay_disabled", {
            workspaceId,
            chatId,
            totalEvents: this.totalEvents,
            ceiling: TOTAL_EVENT_CEILING,
            activeStreams: this.streams.size,
          });
        }
      }
    }
    let frameId: number | undefined;
    if (!buffer.replayDisabled) {
      buffer.events.push(event);
      this.totalEvents++;
      // events[] index is the monotonic SSE `id:` clients send back as
      // `Last-Event-ID` for cursored resume. Full replay would re-emit
      // text-delta chunks the SDK already merged → duplicated content.
      frameId = buffer.events.length - 1;

      const part = partKey(event);
      if (part !== null) {
        if (part.opens) {
          buffer.openParts.set(part.key, frameId);
        } else {
          buffer.openParts.delete(part.key);
        }
      }
    }
    buffer.lastEventAt = Date.now();

    // Replay-disabled buffers omit `id:` — the cursor would never be honored.
    // Side effect: any frame broadcast after the flag trips is unrecoverable —
    // a live subscriber that drops here advances no cursor, and the next GET
    // returns 410. The user sees the unrecoverable banner without a partial-
    // truncation indicator for whatever shipped between flag-trip and drop.
    const data = StreamRegistry.ENCODER.encode(
      frameId !== undefined
        ? `id: ${frameId}\ndata: ${JSON.stringify(event)}\n\n`
        : `data: ${JSON.stringify(event)}\n\n`,
    );

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
   * Replays events past `lastEventId` (or all when omitted), then attaches
   * for live broadcast. Returns false on missing/finished/replay-disabled
   * buffers — full replay of a finished stream would re-merge text-deltas
   * into the SDK's existing message and produce duplicates.
   */
  subscribe(
    workspaceId: string,
    chatId: string,
    controller: StreamController,
    lastEventId?: number,
  ): boolean {
    const buffer = this.streams.get(key(workspaceId, chatId));
    if (!buffer?.active || buffer.replayDisabled) {
      return false;
    }

    const startIdx =
      lastEventId !== undefined && Number.isFinite(lastEventId) ? Math.max(0, lastEventId + 1) : 0;

    // On cursored resume, re-emit any open `*-start` whose index is before
    // the cursor. The SDK's resumeStream() rebuilds `activeResponse` empty,
    // so without this a `*-delta` past the cursor trips "delta for missing
    // part". Original frame ids preserved so the tracker's monotonicity
    // guard sees them as a no-op.
    if (startIdx > 0) {
      const openIndicesBeforeCursor: number[] = [];
      for (const startIndex of buffer.openParts.values()) {
        if (startIndex < startIdx) openIndicesBeforeCursor.push(startIndex);
      }
      // Ascending order so nested parts open in original sequence.
      openIndicesBeforeCursor.sort((a, b) => a - b);
      for (const i of openIndicesBeforeCursor) {
        const event = buffer.events[i];
        if (event === undefined) continue;
        try {
          const data = StreamRegistry.ENCODER.encode(
            `id: ${i}\ndata: ${JSON.stringify(event)}\n\n`,
          );
          controller.enqueue(data);
        } catch {
          return false;
        }
      }
    }

    for (let i = startIdx; i < buffer.events.length; i++) {
      const event = buffer.events[i];
      if (event === undefined) continue;
      try {
        const data = StreamRegistry.ENCODER.encode(`id: ${i}\ndata: ${JSON.stringify(event)}\n\n`);
        controller.enqueue(data);
      } catch {
        // Controller closed during replay
        return false;
      }
    }

    buffer.subscribers.add(controller);
    logger.debug("Subscriber added", {
      workspaceId,
      chatId,
      subscriberCount: buffer.subscribers.size,
      replayedFrom: startIdx,
      replayedThrough: buffer.events.length - 1,
      reEmittedOpenParts: startIdx > 0 ? buffer.openParts.size : 0,
    });
    return true;
  }

  unsubscribe(workspaceId: string, chatId: string, controller: StreamController): void {
    const buffer = this.streams.get(key(workspaceId, chatId));
    if (buffer) {
      buffer.subscribers.delete(controller);
      logger.debug("Subscriber removed", {
        workspaceId,
        chatId,
        subscriberCount: buffer.subscribers.size,
      });
    }
  }

  /**
   * Send [DONE], close subscribers, mark inactive. Buffer kept for TTL but
   * not replayable — full replay would re-merge text-deltas into the SDK's
   * existing message. Late reconnects get 204 + page reload.
   */
  finishStream(workspaceId: string, chatId: string): void {
    const buffer = this.streams.get(key(workspaceId, chatId));
    if (!buffer) {
      return;
    }

    StreamRegistry.closeSubscribers(buffer.subscribers);
    buffer.active = false;

    logger.debug("Stream finished", { workspaceId, chatId, eventCount: buffer.events.length });
  }

  /**
   * No-op if a new turn has replaced the buffer since the caller scheduled
   * this — avoids ripping subscribers out from under an in-flight turn.
   */
  finishStreamIfCurrent(workspaceId: string, chatId: string, expected: StreamBuffer): void {
    const current = this.streams.get(key(workspaceId, chatId));
    if (current !== expected) {
      return;
    }
    this.finishStream(workspaceId, chatId);
  }

  private cleanup(): void {
    const now = Date.now();
    let removed = 0;
    let eventsFreed = 0;

    for (const [k, buffer] of this.streams) {
      const age = now - buffer.lastEventAt;

      if (!buffer.active && age > FINISHED_TTL_MS) {
        eventsFreed += buffer.events.length;
        this.streams.delete(k);
        removed++;
        continue;
      }

      if (buffer.active && age > STALE_TTL_MS) {
        StreamRegistry.closeSubscribers(buffer.subscribers);
        eventsFreed += buffer.events.length;
        this.streams.delete(k);
        removed++;
      }
    }

    if (eventsFreed > 0) {
      this.totalEvents = Math.max(0, this.totalEvents - eventsFreed);
      // Re-arm the warn-once latch so a fresh overflow re-logs.
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
