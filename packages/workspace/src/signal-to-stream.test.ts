import { describe, expect, it, vi } from "vitest";
import type { TriggerFn } from "./signal-to-stream.ts";
import { signalToStream } from "./signal-to-stream.ts";

describe("signalToStream", () => {
  it("yields chunks in order, taps each one, and forwards the trigger args", async () => {
    const triggerFn: TriggerFn = vi.fn((_signal, _payload, _streamId, onStreamEvent) => {
      onStreamEvent({ type: "text-delta", data: "hello " });
      onStreamEvent({ type: "text-delta", data: "world" });
      return Promise.resolve({ sessionId: "sess-1" });
    });

    const tapped: unknown[] = [];
    const stream = signalToStream(triggerFn, "chat", { chatId: "c1" }, "stream-1", (chunk) => {
      tapped.push(chunk);
    });

    const results: unknown[] = [];
    for await (const chunk of stream) {
      results.push(chunk);
    }

    const chunks = [
      { type: "text-delta", data: "hello " },
      { type: "text-delta", data: "world" },
    ];
    expect(results).toEqual(chunks);
    expect(tapped).toEqual(chunks);
    expect(triggerFn).toHaveBeenCalledWith(
      "chat",
      { chatId: "c1" },
      "stream-1",
      expect.any(Function),
      undefined,
    );
  });

  it("forwards an abortSignal to triggerFn so per-turn cancellation reaches the FSM", async () => {
    // Regression: the chat web adapter sources a per-turn AbortSignal from
    // ChatTurnRegistry; if signalToStream drops it on the floor, follow-up
    // chat messages can't cancel the prior turn's in-flight model call.
    const triggerFn: TriggerFn = vi.fn((_signal, _payload, _streamId, _onStreamEvent) =>
      Promise.resolve({ sessionId: "sess-1" }),
    );

    const controller = new AbortController();
    const stream = signalToStream(
      triggerFn,
      "chat",
      { chatId: "c1" },
      "stream-1",
      undefined,
      controller.signal,
    );
    for await (const _ of stream) {
      // drain
    }
    expect(triggerFn).toHaveBeenCalledWith(
      "chat",
      { chatId: "c1" },
      "stream-1",
      expect.any(Function),
      controller.signal,
    );
  });

  it("propagates triggerFn rejection through the iterable", async () => {
    const triggerFn: TriggerFn = vi.fn(() => Promise.reject(new Error("signal failed")));

    const stream = signalToStream(triggerFn, "chat", {}, "stream-1");

    await expect(async () => {
      for await (const _ of stream) {
        // drain
      }
    }).rejects.toThrow("signal failed");
  });
});
