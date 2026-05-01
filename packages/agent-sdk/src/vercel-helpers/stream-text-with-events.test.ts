import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEmitter } from "../types.ts";
import { streamTextWithEvents } from "./stream-text-with-events.ts";

const mockStreamText = vi.hoisted(() => vi.fn());

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, streamText: mockStreamText };
});

function makeMockStreamTextResult(chunks: unknown[]) {
  const fullStream = (async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();

  return {
    fullStream,
    text: Promise.resolve("hello world"),
    finishReason: Promise.resolve("stop" as const),
    usage: Promise.resolve({ promptTokens: 10, completionTokens: 5 }),
    totalUsage: Promise.resolve({ promptTokens: 10, completionTokens: 5 }),
    steps: Promise.resolve([]),
    toolCalls: Promise.resolve([]),
    toolResults: Promise.resolve([]),
  };
}

function makeStreamEmitter(): StreamEmitter & { events: unknown[] } {
  const events: unknown[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
    },
    end() {},
    error() {},
  };
}

describe("streamTextWithEvents", () => {
  beforeEach(() => {
    mockStreamText.mockReset();
  });

  it("forwards tool-call and tool-result chunks through the stream emitter", async () => {
    mockStreamText.mockReturnValue(
      makeMockStreamTextResult([
        {
          type: "tool-call",
          toolCallId: "tc-1",
          toolName: "fetch",
          input: { url: "https://example.com" },
        },
        { type: "tool-result", toolCallId: "tc-1", output: "fetched content" },
      ]),
    );

    const emitter = makeStreamEmitter();
    const result = await streamTextWithEvents({ params: {} as never, stream: emitter });

    expect(result.text).toBe("hello world");
    expect(emitter.events).toEqual([
      {
        type: "tool-input-available",
        toolCallId: "tc-1",
        toolName: "fetch",
        input: { url: "https://example.com" },
      },
      { type: "data-tool-timing", data: { toolCallId: "tc-1", durationMs: expect.any(Number) } },
      { type: "tool-output-available", toolCallId: "tc-1", output: "fetched content" },
    ]);
  });

  it("accumulates reasoning-delta and returns it on the result", async () => {
    mockStreamText.mockReturnValue(
      makeMockStreamTextResult([
        { type: "reasoning-start", id: "r-1" },
        { type: "reasoning-delta", id: "r-1", text: "Let me think" },
        { type: "reasoning-delta", id: "r-1", text: " about this..." },
        { type: "reasoning-end", id: "r-1" },
      ]),
    );

    const emitter = makeStreamEmitter();
    const result = await streamTextWithEvents({ params: {} as never, stream: emitter });

    expect(result.reasoning).toBe("Let me think about this...");
    expect(emitter.events).toEqual([
      { type: "reasoning-start", id: "r-1" },
      { type: "reasoning-delta", id: "r-1", delta: "Let me think" },
      { type: "reasoning-delta", id: "r-1", delta: " about this..." },
      { type: "reasoning-end", id: "r-1" },
    ]);
  });

  it("emits data-tool-timing after tool-result with durationMs", async () => {
    mockStreamText.mockReturnValue(
      makeMockStreamTextResult([
        {
          type: "tool-call",
          toolCallId: "tc-1",
          toolName: "fetch",
          input: { url: "https://example.com" },
        },
        { type: "tool-result", toolCallId: "tc-1", output: "fetched content" },
      ]),
    );

    const emitter = makeStreamEmitter();
    const result = await streamTextWithEvents({ params: {} as never, stream: emitter });

    expect(result.text).toBe("hello world");
    expect(emitter.events).toEqual([
      {
        type: "tool-input-available",
        toolCallId: "tc-1",
        toolName: "fetch",
        input: { url: "https://example.com" },
      },
      { type: "data-tool-timing", data: { toolCallId: "tc-1", durationMs: expect.any(Number) } },
      { type: "tool-output-available", toolCallId: "tc-1", output: "fetched content" },
    ]);
    const timingEvent = emitter.events.find(
      (e) => (e as { type: string }).type === "data-tool-timing",
    );
    expect(timingEvent).toMatchObject({ data: { durationMs: expect.any(Number) } });
    expect(
      (timingEvent as { data: { durationMs: number } }).data.durationMs,
    ).toBeGreaterThanOrEqual(0);
  });

  it("does not emit or accumulate reasoning when no stream is provided", async () => {
    mockStreamText.mockReturnValue(
      makeMockStreamTextResult([{ type: "reasoning-delta", id: "r-1", text: "ignored" }]),
    );

    const result = await streamTextWithEvents({ params: {} as never, stream: undefined });

    expect(result.reasoning).toBe("");
  });
});
