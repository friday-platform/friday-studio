import { describe, expect, it } from "vitest";
import { createSSEStream } from "./sse.ts";

/** Drain a ReadableStream<Uint8Array> into a string. */
async function readAll(response: Response): Promise<string> {
  if (!response.body) throw new Error("Response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

/** Parse raw SSE text into structured events. */
function parseSSE(raw: string): Array<{ event: string; data: string }> {
  return raw
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split("\n");
      const event =
        lines
          .find((l) => l.startsWith("event:"))
          ?.slice(6)
          .trim() ?? "";
      const data =
        lines
          .find((l) => l.startsWith("data:"))
          ?.slice(5)
          .trim() ?? "";
      return { event, data };
    });
}

describe("createSSEStream", () => {
  it("returns a Response with correct SSE headers", () => {
    const response = createSSEStream(async () => { await Promise.resolve(); });
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("Connection")).toBe("keep-alive");
  });

  it("formats events as SSE wire protocol", async () => {
    const response = createSSEStream(async (emitter) => {
      await Promise.resolve();
      emitter.send("ping", { ts: 1 });
    });
    const raw = await readAll(response);
    const events = parseSSE(raw);
    expect(events).toEqual([{ event: "ping", data: JSON.stringify({ ts: 1 }) }]);
  });

  it("emits typed convenience methods as named SSE events", async () => {
    const response = createSSEStream(async (emitter) => {
      await Promise.resolve();
      emitter.progress({ type: "text", textContent: "hello" } as never);
      emitter.log({ level: "info", message: "step done" });
      emitter.trace({ spanId: "s1", name: "llm-call", durationMs: 42 });
      emitter.result({ answer: 42 });
      emitter.done({ durationMs: 100, totalTokens: 500, stepCount: 3 });
    });
    const raw = await readAll(response);
    const events = parseSSE(raw);

    expect(events).toHaveLength(5);
    const [ev0, ev1, ev2, ev3, ev4] = events;
    if (!ev0 || !ev1 || !ev2 || !ev3 || !ev4) throw new Error("expected 5 events");
    expect(ev0.event).toBe("progress");
    expect(ev1.event).toBe("log");
    expect(ev2.event).toBe("trace");
    expect(ev3.event).toBe("result");
    expect(ev4.event).toBe("done");

    expect(JSON.parse(ev4.data)).toEqual({ durationMs: 100, totalTokens: 500, stepCount: 3 });
  });

  it("emits error event when executor throws", async () => {
    const response = createSSEStream(async () => {
      await Promise.resolve();
      throw new Error("boom");
    });
    const raw = await readAll(response);
    const events = parseSSE(raw);

    const errorEvent = events.find((e) => e.event === "error");
    if (!errorEvent) throw new Error("Expected error event");
    expect(JSON.parse(errorEvent.data)).toEqual({ error: "boom" });
  });

  it("stream closes cleanly after executor completes", async () => {
    const response = createSSEStream(async (emitter) => {
      await Promise.resolve();
      emitter.send("test", { value: 1 });
    });
    const raw = await readAll(response);
    // readAll completing without hanging = stream closed
    expect(raw).toContain("event: test");
  });

  it("provides an AbortSignal to the executor", async () => {
    let receivedSignal: AbortSignal | undefined;
    const response = createSSEStream(async (_emitter, signal) => {
      await Promise.resolve();
      receivedSignal = signal;
    });
    await readAll(response);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  it("emits error event for non-Error throws", async () => {
    const response = createSSEStream(async () => {
      await Promise.resolve();
      throw "string error";
    });
    const raw = await readAll(response);
    const events = parseSSE(raw);
    const errorEvent = events.find((e) => e.event === "error");
    if (!errorEvent) throw new Error("Expected error event");
    expect(JSON.parse(errorEvent.data)).toEqual({ error: "string error" });
  });
});
