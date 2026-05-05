import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { logger } from "@atlas/logger";
import { aroundEach, describe, expect, it, vi } from "vitest";
import {
  CLEANUP_INTERVAL_MS,
  FINISHED_TTL_MS,
  MAX_EVENTS,
  STALE_TTL_MS,
  type StreamController,
  StreamRegistry,
} from "./stream-registry.ts";

/** Create a minimal test event */
function makeEvent(id: number): AtlasUIMessageChunk {
  return { type: "text-delta", id: `msg-${id}`, delta: `event-${id}` };
}

/** Create a mock stream controller */
function createController(options?: {
  onEnqueue?: (data: Uint8Array) => void;
  onClose?: () => void;
}): StreamController {
  return { enqueue: options?.onEnqueue ?? (() => {}), close: options?.onClose ?? (() => {}) };
}

describe("StreamRegistry", () => {
  let registry: StreamRegistry;

  aroundEach(async (run) => {
    registry = new StreamRegistry();
    await run();
    registry.shutdown();
  });

  describe("createStream", () => {
    it("creates buffer with correct initial state", () => {
      const before = Date.now();
      registry.createStream("chat-1");
      const after = Date.now();

      const buffer = registry.getStream("chat-1");
      expect.assert(buffer !== undefined, "buffer should exist");

      expect(buffer.chatId).toBe("chat-1");
      expect(buffer.events).toHaveLength(0);
      expect(buffer.active).toBe(true);
      expect(buffer.createdAt).toBeGreaterThanOrEqual(before);
      expect(buffer.createdAt).toBeLessThanOrEqual(after);
      expect(buffer.lastEventAt).toBeGreaterThanOrEqual(before);
      expect(buffer.lastEventAt).toBeLessThanOrEqual(after);
      expect(buffer.subscribers.size).toBe(0);
    });

    it("cancels existing stream for same chatId", () => {
      registry.createStream("chat-1");
      const first = registry.getStream("chat-1");

      registry.createStream("chat-1");
      const second = registry.getStream("chat-1");

      // Should be a new buffer (different reference)
      expect(first).not.toBe(second);
      // First should have been marked inactive
      expect(first?.active).toBe(false);
    });

    it("sends [DONE] to old subscribers when cancelling", () => {
      registry.createStream("chat-1");

      const received: Uint8Array[] = [];
      let closeCalled = false;
      const controller = createController({
        onEnqueue: (data) => received.push(data),
        onClose: () => {
          closeCalled = true;
        },
      });
      registry.subscribe("chat-1", controller);

      // Creating a new stream for the same chatId cancels the old one
      registry.createStream("chat-1");

      // Old subscriber should have received [DONE] before close
      const decoder = new TextDecoder();
      const last = received[received.length - 1];
      expect.assert(last !== undefined, "last chunk should exist");
      expect(decoder.decode(last)).toBe("data: [DONE]\n\n");
      expect(closeCalled).toBe(true);
    });
  });

  describe("getStream", () => {
    it("returns undefined for nonexistent chatId", () => {
      const buffer = registry.getStream("nonexistent");
      expect(buffer).toBeUndefined();
    });

    it("returns buffer for existing chatId", () => {
      registry.createStream("chat-1");
      const buffer = registry.getStream("chat-1");
      expect(buffer?.chatId).toBe("chat-1");
    });
  });

  describe("appendEvent", () => {
    it("appends event to buffer and updates lastEventAt", () => {
      registry.createStream("chat-1");
      const beforeAppend = Date.now();

      registry.appendEvent("chat-1", makeEvent(1));

      const buffer = registry.getStream("chat-1");
      expect.assert(buffer !== undefined, "buffer should exist");
      expect(buffer.events).toHaveLength(1);
      expect(buffer.events[0]?.type).toBe("text-delta");
      expect(buffer.lastEventAt).toBeGreaterThanOrEqual(beforeAppend);
    });

    it("returns false for nonexistent stream", () => {
      const result = registry.appendEvent("nonexistent", makeEvent(1));
      expect(result).toBe(false);
    });

    it("returns false for inactive stream", () => {
      registry.createStream("chat-1");
      const buffer = registry.getStream("chat-1");
      if (buffer) buffer.active = false;

      const result = registry.appendEvent("chat-1", makeEvent(1));
      expect(result).toBe(false);
    });

    // Identity check guards against cross-turn event leaks. The chatId-keyed
    // lookup is shared across turns, so an aborted turn's late producer would
    // otherwise write into the next turn's buffer — the UI then sees a
    // text-delta with no preceding text-start and the AI SDK throws.
    it("drops the event when expectedBuffer no longer matches the current buffer", () => {
      const turn1 = registry.createStream("chat-1");
      const turn2 = registry.createStream("chat-1"); // replaces turn1

      const result = registry.appendEvent("chat-1", makeEvent(1), turn1);
      expect(result).toBe(false);
      expect(turn2.events).toHaveLength(0);
    });

    it("appends when expectedBuffer matches the current buffer", () => {
      const turn = registry.createStream("chat-1");
      const result = registry.appendEvent("chat-1", makeEvent(1), turn);
      expect(result).toBe(true);
      expect(turn.events).toHaveLength(1);
    });
  });

  describe("buffer overflow", () => {
    // Overflow policy: once the buffer hits MAX_EVENTS we stop recording
    // new chunks and mark the stream non-replayable. Evicting mid-stream
    // would break `subscribe()`'s replay: dropping a `text-start` while
    // keeping the following `text-delta` chunks crashes the AI SDK v6
    // client with "Received text-delta for missing text part with ID".
    it("stops recording events past MAX_EVENTS and flags replay disabled", () => {
      registry.createStream("chat-1");

      for (let i = 0; i < MAX_EVENTS + 100; i++) {
        registry.appendEvent("chat-1", makeEvent(i));
      }

      const buffer = registry.getStream("chat-1");
      expect.assert(buffer !== undefined, "buffer should exist");
      expect(buffer.events).toHaveLength(MAX_EVENTS);
      expect(buffer.replayDisabled).toBe(true);

      // First event must still be the very first chunk we pushed — the
      // protocol-critical `*-start` events live at the head.
      const firstEvent = buffer.events[0];
      expect.assert(firstEvent !== undefined, "first event should exist");
      expect(firstEvent).toMatchObject({ type: "text-delta", delta: "event-0" });
    });

    it("still broadcasts post-overflow events to already-connected subscribers", () => {
      registry.createStream("chat-1");

      const received: Uint8Array[] = [];
      registry.subscribe("chat-1", createController({ onEnqueue: (d) => received.push(d) }));

      for (let i = 0; i < MAX_EVENTS + 10; i++) {
        registry.appendEvent("chat-1", makeEvent(i));
      }

      // Live subscriber sees every event regardless of buffer overflow —
      // they already processed the earlier chunks via broadcast.
      expect(received).toHaveLength(MAX_EVENTS + 10);
    });

    it("refuses new subscribers once replay is disabled", () => {
      registry.createStream("chat-1");

      for (let i = 0; i < MAX_EVENTS + 1; i++) {
        registry.appendEvent("chat-1", makeEvent(i));
      }

      const result = registry.subscribe("chat-1", createController());
      expect(result).toBe(false);
    });

    // Pin the boundary: exactly MAX_EVENTS appends must be accepted, and the
    // (N+1)th trips replayDisabled. Guards against a `>` → `>=` regression
    // at stream-registry.ts:214 (off-by-one would either silently drop the
    // last legal event or buffer one too many).
    it("accepts exactly MAX_EVENTS appends; the (N+1)th trips replayDisabled", () => {
      registry.createStream("chat-1");

      for (let i = 0; i < MAX_EVENTS; i++) {
        registry.appendEvent("chat-1", makeEvent(i));
      }

      let buffer = registry.getStream("chat-1");
      expect.assert(buffer !== undefined, "buffer should exist");
      expect(buffer.events).toHaveLength(MAX_EVENTS);
      expect(buffer.replayDisabled).toBe(false);

      registry.appendEvent("chat-1", makeEvent(MAX_EVENTS));

      buffer = registry.getStream("chat-1");
      expect.assert(buffer !== undefined, "buffer should exist");
      expect(buffer.events).toHaveLength(MAX_EVENTS);
      expect(buffer.replayDisabled).toBe(true);
    });

    // The `!buffer.replayDisabled &&` guard is the only thing keeping the
    // overflow warning from firing on every post-overflow append. 100 extra
    // appends past the cap must still produce exactly one warn — a regression
    // that dropped the latch would flood logs in long-running daemons.
    it("logs stream_buffer_overflow_replay_disabled exactly once per stream", () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      try {
        registry.createStream("chat-1");

        for (let i = 0; i < MAX_EVENTS + 100; i++) {
          registry.appendEvent("chat-1", makeEvent(i));
        }

        const overflowCalls = warnSpy.mock.calls.filter(
          (call) => call[0] === "stream_buffer_overflow_replay_disabled",
        );
        expect(overflowCalls).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe("subscribe", () => {
    it("replays buffered events to new subscriber with id: lines", () => {
      registry.createStream("chat-1");
      registry.appendEvent("chat-1", makeEvent(1));
      registry.appendEvent("chat-1", makeEvent(2));

      // Collect data sent to controller
      const received: Uint8Array[] = [];
      const controller = createController({ onEnqueue: (data) => received.push(data) });

      registry.subscribe("chat-1", controller);

      // Should have received 2 events (replay)
      expect(received).toHaveLength(2);

      // Each frame starts with `id: <index>\n` (SSE event id line — clients
      // use this for `Last-Event-ID` cursor on resume) and includes the JSON
      // payload on the data line.
      const decoder = new TextDecoder();
      const firstData = decoder.decode(received[0]);
      expect(firstData).toMatch(/^id: 0\ndata: /);
      expect(firstData).toContain('"delta":"event-1"');
      const secondData = decoder.decode(received[1]);
      expect(secondData).toMatch(/^id: 1\ndata: /);
      expect(secondData).toContain('"delta":"event-2"');
    });

    it("replays only events past lastEventId when given a cursor", () => {
      registry.createStream("chat-1");
      registry.appendEvent("chat-1", makeEvent(1));
      registry.appendEvent("chat-1", makeEvent(2));
      registry.appendEvent("chat-1", makeEvent(3));

      const received: Uint8Array[] = [];
      const controller = createController({ onEnqueue: (data) => received.push(data) });

      // Client says "I have id 0, send me only what's after."
      registry.subscribe("chat-1", controller, 0);

      expect(received).toHaveLength(2);
      const decoder = new TextDecoder();
      expect(decoder.decode(received[0])).toMatch(/^id: 1\ndata: /);
      expect(decoder.decode(received[1])).toMatch(/^id: 2\ndata: /);
    });

    it("replays nothing when cursor is at the buffer tail (caught up)", () => {
      registry.createStream("chat-1");
      registry.appendEvent("chat-1", makeEvent(1));
      registry.appendEvent("chat-1", makeEvent(2));

      const received: Uint8Array[] = [];
      const controller = createController({ onEnqueue: (data) => received.push(data) });

      // Client already has id 1 (the last one). Subscribing with that
      // cursor must not replay anything — it just attaches for live events.
      const ok = registry.subscribe("chat-1", controller, 1);
      expect(ok).toBe(true);
      expect(received).toHaveLength(0);

      // Confirms attach worked: a fresh broadcast lands.
      registry.appendEvent("chat-1", makeEvent(3));
      expect(received).toHaveLength(1);
      expect(new TextDecoder().decode(received[0])).toMatch(/^id: 2\ndata: /);
    });

    it("clamps a negative cursor to 0 (full replay)", () => {
      registry.createStream("chat-1");
      registry.appendEvent("chat-1", makeEvent(1));
      registry.appendEvent("chat-1", makeEvent(2));

      const received: Uint8Array[] = [];
      registry.subscribe(
        "chat-1",
        createController({ onEnqueue: (d) => received.push(d) }),
        -5,
      );

      expect(received).toHaveLength(2);
    });

    it("re-emits open *-start chunks before continuing past the cursor", () => {
      // Simulate a turn that was mid tool-call when the connection dropped:
      // text-start (closed) → tool-input-start → some deltas → drop. The
      // client cursor is past the tool-input-start. On resume, the server
      // must re-send tool-input-start so the AI SDK's fresh activeResponse
      // can register the tool before processing the deltas.
      registry.createStream("chat-1");
      registry.appendEvent("chat-1", {
        type: "text-start",
        id: "txt-1",
      } as AtlasUIMessageChunk); // index 0
      registry.appendEvent("chat-1", {
        type: "text-end",
        id: "txt-1",
      } as AtlasUIMessageChunk); // index 1
      registry.appendEvent("chat-1", {
        type: "tool-input-start",
        toolCallId: "tc-1",
        toolName: "do-thing",
      } as AtlasUIMessageChunk); // index 2 — STILL OPEN
      registry.appendEvent("chat-1", {
        type: "tool-input-delta",
        toolCallId: "tc-1",
        inputTextDelta: "{",
      } as AtlasUIMessageChunk); // index 3
      registry.appendEvent("chat-1", {
        type: "tool-input-delta",
        toolCallId: "tc-1",
        inputTextDelta: "}",
      } as AtlasUIMessageChunk); // index 4

      const received: Uint8Array[] = [];
      const controller = createController({ onEnqueue: (d) => received.push(d) });

      // Client says it has up to id 3 (the first delta). It does NOT
      // have tool-input-start in its fresh activeResponse state.
      registry.subscribe("chat-1", controller, 3);

      // Expect: tool-input-start (re-emit) + index 4 delta. The
      // closed text part (txt-1) does NOT get re-emitted.
      expect(received).toHaveLength(2);
      const decoder = new TextDecoder();
      const first = decoder.decode(received[0]);
      const second = decoder.decode(received[1]);
      expect(first).toMatch(/^id: 2\n/);
      expect(first).toContain('"type":"tool-input-start"');
      expect(second).toMatch(/^id: 4\n/);
      expect(second).toContain('"type":"tool-input-delta"');
    });

    it("does not re-emit *-start when no cursor is given (full replay covers it)", () => {
      registry.createStream("chat-1");
      registry.appendEvent("chat-1", {
        type: "tool-input-start",
        toolCallId: "tc-1",
        toolName: "do-thing",
      } as AtlasUIMessageChunk);
      registry.appendEvent("chat-1", {
        type: "tool-input-delta",
        toolCallId: "tc-1",
        inputTextDelta: "{}",
      } as AtlasUIMessageChunk);

      const received: Uint8Array[] = [];
      registry.subscribe("chat-1", createController({ onEnqueue: (d) => received.push(d) }));

      // Full replay sends both events. Re-emit logic only fires when
      // startIdx > 0 — without a cursor we'd otherwise duplicate the
      // tool-input-start (once via re-emit, once via the main loop).
      expect(received).toHaveLength(2);
    });

    it("forgets parts once their close event is recorded", () => {
      registry.createStream("chat-1");
      registry.appendEvent("chat-1", {
        type: "tool-input-start",
        toolCallId: "tc-1",
        toolName: "do-thing",
      } as AtlasUIMessageChunk); // index 0
      registry.appendEvent("chat-1", {
        type: "tool-output-available",
        toolCallId: "tc-1",
        output: "ok",
      } as AtlasUIMessageChunk); // index 1 — CLOSES the part
      registry.appendEvent("chat-1", {
        type: "text-start",
        id: "txt-after",
      } as AtlasUIMessageChunk); // index 2
      registry.appendEvent("chat-1", {
        type: "text-delta",
        id: "txt-after",
        delta: "post",
      } as AtlasUIMessageChunk); // index 3

      const received: Uint8Array[] = [];
      registry.subscribe(
        "chat-1",
        createController({ onEnqueue: (d) => received.push(d) }),
        2,
      );

      // Only text-start (open) gets re-emitted; tool-input-start does
      // NOT, because its close event landed before the cursor.
      // Expected: re-emit text-start at id 2, then text-delta at id 3.
      expect(received).toHaveLength(2);
      const decoder = new TextDecoder();
      expect(decoder.decode(received[0])).toMatch(/^id: 2\ndata: .*"type":"text-start"/);
      expect(decoder.decode(received[1])).toMatch(/^id: 3\ndata: .*"type":"text-delta"/);
    });

    it("replays nothing when cursor is past the buffer tail", () => {
      registry.createStream("chat-1");
      registry.appendEvent("chat-1", makeEvent(1));

      const received: Uint8Array[] = [];
      const ok = registry.subscribe(
        "chat-1",
        createController({ onEnqueue: (d) => received.push(d) }),
        99,
      );

      // Subscribe still succeeds (the buffer is active and replay isn't
      // disabled) — the loop just has nothing to send. Live broadcasts
      // resume from there.
      expect(ok).toBe(true);
      expect(received).toHaveLength(0);
    });

    it("adds controller to subscribers set", () => {
      registry.createStream("chat-1");

      const controller = createController();

      registry.subscribe("chat-1", controller);

      const buffer = registry.getStream("chat-1");
      expect(buffer?.subscribers.has(controller)).toBe(true);
    });

    it("returns false for nonexistent stream", () => {
      const controller = createController();

      const result = registry.subscribe("nonexistent", controller);
      expect(result).toBe(false);
    });

    it("returns false for finished stream", () => {
      registry.createStream("chat-1");
      registry.appendEvent("chat-1", makeEvent(1));
      registry.finishStream("chat-1");

      const controller = createController();
      const result = registry.subscribe("chat-1", controller);
      expect(result).toBe(false);
    });
  });

  describe("unsubscribe", () => {
    it("removes controller from subscribers set", () => {
      registry.createStream("chat-1");

      const controller = createController();

      registry.subscribe("chat-1", controller);
      registry.unsubscribe("chat-1", controller);

      const buffer = registry.getStream("chat-1");
      expect(buffer?.subscribers.has(controller)).toBe(false);
    });
  });

  describe("broadcast", () => {
    it("broadcasts new events to all subscribers", () => {
      registry.createStream("chat-1");

      const received1: Uint8Array[] = [];
      const received2: Uint8Array[] = [];

      registry.subscribe("chat-1", createController({ onEnqueue: (d) => received1.push(d) }));
      registry.subscribe("chat-1", createController({ onEnqueue: (d) => received2.push(d) }));

      registry.appendEvent("chat-1", makeEvent(99));

      // Both subscribers should receive the new event (on top of empty replay)
      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);

      const decoder = new TextDecoder();
      expect(decoder.decode(received1[0])).toContain('"delta":"event-99"');
      expect(decoder.decode(received2[0])).toContain('"delta":"event-99"');
    });

    it("broadcasts new events with monotonic id: lines", () => {
      registry.createStream("chat-1");
      const received: Uint8Array[] = [];
      registry.subscribe("chat-1", createController({ onEnqueue: (d) => received.push(d) }));

      registry.appendEvent("chat-1", makeEvent(1));
      registry.appendEvent("chat-1", makeEvent(2));
      registry.appendEvent("chat-1", makeEvent(3));

      const decoder = new TextDecoder();
      expect(decoder.decode(received[0])).toMatch(/^id: 0\ndata: /);
      expect(decoder.decode(received[1])).toMatch(/^id: 1\ndata: /);
      expect(decoder.decode(received[2])).toMatch(/^id: 2\ndata: /);
    });

    it("omits id: line when buffer is replay-disabled (post-overflow)", () => {
      registry.createStream("chat-1");
      const received: Uint8Array[] = [];
      registry.subscribe("chat-1", createController({ onEnqueue: (d) => received.push(d) }));

      // Force the buffer past MAX_EVENTS to trip replayDisabled. The first
      // MAX_EVENTS frames carry an id; subsequent broadcasts to live
      // subscribers omit it because replay is no longer possible.
      for (let i = 0; i < MAX_EVENTS + 2; i++) {
        registry.appendEvent("chat-1", makeEvent(i));
      }

      const decoder = new TextDecoder();
      // Last frame should be a no-id broadcast since buffer overflowed.
      const lastFrame = decoder.decode(received[received.length - 1]!);
      expect(lastFrame).toMatch(/^data: /);
      expect(lastFrame).not.toMatch(/^id: /);
    });

    it("unsubscribing one does not affect others", () => {
      registry.createStream("chat-1");

      const received1: Uint8Array[] = [];
      const received2: Uint8Array[] = [];

      const controller1 = createController({ onEnqueue: (d) => received1.push(d) });
      const controller2 = createController({ onEnqueue: (d) => received2.push(d) });

      registry.subscribe("chat-1", controller1);
      registry.subscribe("chat-1", controller2);

      registry.unsubscribe("chat-1", controller1);
      registry.appendEvent("chat-1", makeEvent(1));

      expect(received1).toHaveLength(0);
      expect(received2).toHaveLength(1);
    });
  });

  describe("finishStream", () => {
    it("marks stream as inactive", () => {
      registry.createStream("chat-1");
      registry.finishStream("chat-1");

      const buffer = registry.getStream("chat-1");
      expect(buffer?.active).toBe(false);
    });

    it("closes all subscribers", () => {
      registry.createStream("chat-1");

      let closeCalled = false;
      const controller = createController({
        onClose: () => {
          closeCalled = true;
        },
      });

      registry.subscribe("chat-1", controller);
      registry.finishStream("chat-1");

      expect(closeCalled).toBe(true);
    });

    it("clears subscribers set", () => {
      registry.createStream("chat-1");

      const controller = createController();

      registry.subscribe("chat-1", controller);
      registry.finishStream("chat-1");

      const buffer = registry.getStream("chat-1");
      expect(buffer?.subscribers.size).toBe(0);
    });

    it("does nothing for nonexistent stream", () => {
      // Should not throw
      registry.finishStream("nonexistent");
    });

    it("sends [DONE] to subscribers before closing", () => {
      registry.createStream("chat-1");
      registry.appendEvent("chat-1", makeEvent(1));

      const received: Uint8Array[] = [];
      let closeCalled = false;
      const controller = createController({
        onEnqueue: (data) => received.push(data),
        onClose: () => {
          closeCalled = true;
        },
      });

      registry.subscribe("chat-1", controller);
      // received[0] = replay of event-1
      const replayCount = received.length;

      registry.finishStream("chat-1");

      // Should have received [DONE] after the replay events
      expect(received.length).toBe(replayCount + 1);
      const decoder = new TextDecoder();
      const last = received[received.length - 1];
      expect.assert(last !== undefined, "last chunk should exist");
      expect(decoder.decode(last)).toBe("data: [DONE]\n\n");
      expect(closeCalled).toBe(true);
    });
  });

  describe("finishStreamIfCurrent", () => {
    it("closes the stream when the buffer matches", () => {
      const buffer = registry.createStream("chat-1");

      let closeCalled = false;
      const controller = createController({
        onClose: () => {
          closeCalled = true;
        },
      });
      registry.subscribe("chat-1", controller);

      registry.finishStreamIfCurrent("chat-1", buffer);

      expect(closeCalled).toBe(true);
      expect(buffer.active).toBe(false);
    });

    it("no-ops when the buffer has been replaced by a new turn", () => {
      // First turn creates buffer A.
      const bufferA = registry.createStream("chat-1");

      // Second turn arrives and replaces A with B (simulating a queued
      // follow-up POST coming in while the first turn's delayed
      // finishStream is still pending).
      const bufferB = registry.createStream("chat-1");
      expect(bufferA).not.toBe(bufferB);
      expect(bufferA.active).toBe(false);
      expect(bufferB.active).toBe(true);

      // Subscribe a live controller to B (the in-flight turn).
      let closeCalled = false;
      const controller = createController({
        onClose: () => {
          closeCalled = true;
        },
      });
      registry.subscribe("chat-1", controller);

      // The delayed timer from turn A fires, but the chatId now points at
      // buffer B. Guard must skip so B's subscriber stays alive.
      registry.finishStreamIfCurrent("chat-1", bufferA);

      expect(closeCalled).toBe(false);
      expect(bufferB.active).toBe(true);
      expect(bufferB.subscribers.size).toBe(1);
    });
  });

  describe("shutdown", () => {
    it("sends [DONE] to all subscribers before closing", () => {
      registry.createStream("chat-1");
      registry.createStream("chat-2");

      const received1: Uint8Array[] = [];
      let close1 = false;
      const received2: Uint8Array[] = [];
      let close2 = false;

      registry.subscribe(
        "chat-1",
        createController({
          onEnqueue: (d) => received1.push(d),
          onClose: () => {
            close1 = true;
          },
        }),
      );
      registry.subscribe(
        "chat-2",
        createController({
          onEnqueue: (d) => received2.push(d),
          onClose: () => {
            close2 = true;
          },
        }),
      );

      registry.shutdown();

      const decoder = new TextDecoder();
      const last1 = received1[received1.length - 1];
      const last2 = received2[received2.length - 1];
      expect.assert(last1 !== undefined, "chat-1 should receive [DONE]");
      expect.assert(last2 !== undefined, "chat-2 should receive [DONE]");
      expect(decoder.decode(last1)).toBe("data: [DONE]\n\n");
      expect(decoder.decode(last2)).toBe("data: [DONE]\n\n");
      expect(close1).toBe(true);
      expect(close2).toBe(true);
    });
  });

  describe("cleanup", () => {
    aroundEach(async (run) => {
      vi.useFakeTimers();
      await run();
      vi.useRealTimers();
    });

    it("removes finished streams after FINISHED_TTL_MS", () => {
      registry.start();
      registry.createStream("chat-1");
      registry.finishStream("chat-1");

      const buffer = registry.getStream("chat-1");
      if (buffer) {
        buffer.lastEventAt = Date.now() - FINISHED_TTL_MS - 1000;
      }

      vi.advanceTimersByTime(CLEANUP_INTERVAL_MS);

      expect(registry.getStream("chat-1")).toBeUndefined();
    });

    it("removes stale active streams after STALE_TTL_MS", () => {
      registry.start();
      registry.createStream("chat-1");

      const buffer = registry.getStream("chat-1");
      if (buffer) {
        buffer.lastEventAt = Date.now() - STALE_TTL_MS - 1000;
      }

      vi.advanceTimersByTime(CLEANUP_INTERVAL_MS);

      expect(registry.getStream("chat-1")).toBeUndefined();
    });

    it("sends [DONE] to subscribers when cleaning stale active streams", () => {
      registry.start();
      registry.createStream("chat-1");

      const received: Uint8Array[] = [];
      let closeCalled = false;
      registry.subscribe(
        "chat-1",
        createController({
          onEnqueue: (d) => received.push(d),
          onClose: () => {
            closeCalled = true;
          },
        }),
      );

      const buffer = registry.getStream("chat-1");
      if (buffer) {
        buffer.lastEventAt = Date.now() - STALE_TTL_MS - 1000;
      }

      vi.advanceTimersByTime(CLEANUP_INTERVAL_MS);

      const decoder = new TextDecoder();
      const last = received[received.length - 1];
      expect.assert(last !== undefined, "should receive [DONE]");
      expect(decoder.decode(last)).toBe("data: [DONE]\n\n");
      expect(closeCalled).toBe(true);
    });

    it("keeps recent finished streams", () => {
      registry.start();
      registry.createStream("chat-1");
      registry.finishStream("chat-1");

      vi.advanceTimersByTime(CLEANUP_INTERVAL_MS);

      expect(registry.getStream("chat-1")?.chatId).toBe("chat-1");
    });

    it("keeps recent active streams", () => {
      registry.start();
      registry.createStream("chat-1");

      vi.advanceTimersByTime(CLEANUP_INTERVAL_MS);

      expect(registry.getStream("chat-1")?.chatId).toBe("chat-1");
    });
  });
});
