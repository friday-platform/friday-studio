import { describe, expect, it } from "vitest";
import { nextQueueStep } from "./chat-queue.ts";

describe("nextQueueStep", () => {
  const READY = { streaming: false, hasChat: true };

  it("returns null and empty remainder when queue is empty", () => {
    const step = nextQueueStep([], READY);
    expect(step.toSend).toBeNull();
    expect(step.remainder).toEqual([]);
  });

  it("holds the queue when streaming is true", () => {
    const queue = ["a", "b", "c"];
    const step = nextQueueStep(queue, { streaming: true, hasChat: true });
    expect(step.toSend).toBeNull();
    expect(step.remainder).toEqual(queue);
  });

  it("holds the queue when there's no Chat instance", () => {
    const queue = ["a", "b"];
    const step = nextQueueStep(queue, { streaming: false, hasChat: false });
    expect(step.toSend).toBeNull();
    expect(step.remainder).toEqual(queue);
  });

  it("pops the head when ready", () => {
    const step = nextQueueStep(["a", "b", "c"], READY);
    expect(step.toSend).toBe("a");
    expect(step.remainder).toEqual(["b", "c"]);
  });

  it("preserves order across repeated steps", () => {
    // Simulate the drain loop: each step's remainder is the next step's input.
    let queue: readonly string[] = ["a", "b", "c"];
    const sent: string[] = [];
    while (true) {
      const step = nextQueueStep(queue, READY);
      if (step.toSend === null) break;
      sent.push(step.toSend);
      queue = step.remainder;
    }
    expect(sent).toEqual(["a", "b", "c"]);
    expect(queue).toEqual([]);
  });

  it("never aliases the input array in the remainder", () => {
    // The drain loop assigns `remainder` back into a reactive $state. If the
    // reducer returned the input by reference, mutating the input under
    // Svelte's proxy would skip the deep-equality check and lose updates.
    const input = ["a"];
    const holding = nextQueueStep(input, { streaming: true, hasChat: true });
    expect(holding.remainder).not.toBe(input);
    const sending = nextQueueStep(input, READY);
    expect(sending.remainder).not.toBe(input);
  });

  it("does not mutate the input queue on any branch", () => {
    const input = ["a", "b"];
    const snapshot = [...input];
    nextQueueStep(input, READY);
    nextQueueStep(input, { streaming: true, hasChat: true });
    nextQueueStep(input, { streaming: false, hasChat: false });
    expect(input).toEqual(snapshot);
  });

  it("works with arbitrary payload shapes (structural T)", () => {
    // The runtime uses Array<{ type: 'text' | 'file'; ... }>; the reducer
    // is generic — assert it stays structural without unsafe casts.
    interface Msg {
      type: "text";
      text: string;
    }
    const queue: Msg[] = [
      { type: "text", text: "hi" },
      { type: "text", text: "there" },
    ];
    const step = nextQueueStep(queue, READY);
    expect(step.toSend).toEqual({ type: "text", text: "hi" });
    expect(step.remainder).toEqual([{ type: "text", text: "there" }]);
  });

  it("safely no-ops when queue has only undefined-y entries", () => {
    // Defensive: Svelte 5 noUncheckedIndexedAccess leaves arr[0] typed as
    // T | undefined. A corrupted queue (shouldn't happen in practice, but
    // cheap to guard) must not crash the drain loop.
    const queue = [undefined as unknown as string];
    const step = nextQueueStep(queue, READY);
    expect(step.toSend).toBeNull();
    expect(step.remainder).toEqual(queue);
  });
});
