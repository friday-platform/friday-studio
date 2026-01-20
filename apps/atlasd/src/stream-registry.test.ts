import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FINISHED_TTL_MS,
  MAX_EVENTS,
  STALE_TTL_MS,
  StreamController,
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

  beforeEach(() => {
    registry = new StreamRegistry();
  });

  afterEach(() => {
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
  });

  describe("buffer overflow", () => {
    it("drops oldest events when buffer exceeds MAX_EVENTS", () => {
      registry.createStream("chat-1");

      // Fill buffer beyond max
      for (let i = 0; i < MAX_EVENTS + 100; i++) {
        registry.appendEvent("chat-1", makeEvent(i));
      }

      const buffer = registry.getStream("chat-1");
      expect.assert(buffer !== undefined, "buffer should exist");
      expect(buffer.events).toHaveLength(MAX_EVENTS);

      // First event should be event-100 (dropped 0-99)
      const firstEvent = buffer.events[0];
      expect.assert(firstEvent !== undefined, "first event should exist");
      expect(firstEvent).toMatchObject({ type: "text-delta", delta: "event-100" });
    });
  });

  describe("subscribe", () => {
    it("replays buffered events to new subscriber", () => {
      registry.createStream("chat-1");
      registry.appendEvent("chat-1", makeEvent(1));
      registry.appendEvent("chat-1", makeEvent(2));

      // Collect data sent to controller
      const received: Uint8Array[] = [];
      const controller = createController({ onEnqueue: (data) => received.push(data) });

      registry.subscribe("chat-1", controller);

      // Should have received 2 events (replay)
      expect(received).toHaveLength(2);

      // Verify the replayed data is SSE-formatted JSON
      const decoder = new TextDecoder();
      const firstData = decoder.decode(received[0]);
      expect(firstData).toMatch(/^data: /);
      expect(firstData).toContain('"delta":"event-1"');
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
  });

  describe("cleanup", () => {
    it("removes finished streams after FINISHED_TTL_MS", () => {
      registry.createStream("chat-1");
      registry.finishStream("chat-1");

      const buffer = registry.getStream("chat-1");
      if (buffer) {
        // Simulate time passing beyond TTL
        buffer.lastEventAt = Date.now() - FINISHED_TTL_MS - 1000;
      }

      // Trigger cleanup via the exposed method
      registry.triggerCleanup();

      expect(registry.getStream("chat-1")).toBeUndefined();
    });

    it("removes stale active streams after STALE_TTL_MS", () => {
      registry.createStream("chat-1");

      const buffer = registry.getStream("chat-1");
      if (buffer) {
        // Simulate time passing beyond stale TTL
        buffer.lastEventAt = Date.now() - STALE_TTL_MS - 1000;
      }

      registry.triggerCleanup();

      expect(registry.getStream("chat-1")).toBeUndefined();
    });

    it("keeps recent finished streams", () => {
      registry.createStream("chat-1");
      registry.finishStream("chat-1");

      // Stream is finished but recent - should not be cleaned up
      registry.triggerCleanup();

      expect(registry.getStream("chat-1")?.chatId).toBe("chat-1");
    });

    it("keeps recent active streams", () => {
      registry.createStream("chat-1");

      // Stream is active and recent - should not be cleaned up
      registry.triggerCleanup();

      expect(registry.getStream("chat-1")?.chatId).toBe("chat-1");
    });
  });
});
