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
