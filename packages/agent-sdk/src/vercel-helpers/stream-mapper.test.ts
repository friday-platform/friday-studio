import { describe, expect, it, vi } from "vitest";
import type { AtlasUIMessageChunk, StreamEmitter } from "../types.ts";
import { decodeUnicodeEscapes, pipeUIMessageStream } from "./stream-mapper.ts";

describe("decodeUnicodeEscapes", () => {
  it("decodes \\u2014 to em dash", () => {
    expect(decodeUnicodeEscapes("hello\\u2014world")).toBe("hello\u2014world");
  });

  it("decodes \\u2013 to en dash", () => {
    expect(decodeUnicodeEscapes("hello\\u2013world")).toBe("hello\u2013world");
  });

  it("leaves normal text unchanged", () => {
    expect(decodeUnicodeEscapes("hello world")).toBe("hello world");
  });

  it("handles mixed content", () => {
    expect(decodeUnicodeEscapes("a\\u2014b\\u2013c")).toBe("a\u2014b\u2013c");
  });

  it("handles uppercase hex", () => {
    expect(decodeUnicodeEscapes("\\u00E9")).toBe("\u00E9");
  });

  it("does not double-decode actual unicode characters", () => {
    // An actual em dash should pass through unchanged
    expect(decodeUnicodeEscapes("\u2014")).toBe("\u2014");
  });
});

describe("pipeUIMessageStream", () => {
  function makeStream(chunks: AtlasUIMessageChunk[]): ReadableStream<AtlasUIMessageChunk> {
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
  }

  function makeEmitter(): StreamEmitter & { emitted: AtlasUIMessageChunk[] } {
    const emitted: AtlasUIMessageChunk[] = [];
    return {
      emitted,
      emit: (event: AtlasUIMessageChunk) => emitted.push(event),
      end: vi.fn(),
      error: vi.fn(),
    };
  }

  it("decodes unicode escapes in text-delta chunks", async () => {
    const chunks: AtlasUIMessageChunk[] = [
      { type: "text-delta", id: "1", delta: "hello\\u2014world" },
    ];
    const emitter = makeEmitter();

    await pipeUIMessageStream(makeStream(chunks), emitter);

    expect(emitter.emitted).toHaveLength(1);
    const emitted = emitter.emitted[0];
    expect(emitted).toHaveProperty("type", "text-delta");
    expect(emitted).toHaveProperty("delta", "hello\u2014world");
  });

  it("passes text-delta chunks without escapes unchanged", async () => {
    const chunks: AtlasUIMessageChunk[] = [{ type: "text-delta", id: "1", delta: "normal text" }];
    const emitter = makeEmitter();

    await pipeUIMessageStream(makeStream(chunks), emitter);

    expect(emitter.emitted).toHaveLength(1);
    expect(emitter.emitted[0]).toHaveProperty("delta", "normal text");
  });

  it("passes non-text chunks unchanged", async () => {
    const chunks: AtlasUIMessageChunk[] = [
      { type: "text-start", id: "1" },
      { type: "text-end", id: "1" },
    ];
    const emitter = makeEmitter();

    await pipeUIMessageStream(makeStream(chunks), emitter);

    expect(emitter.emitted).toHaveLength(2);
    expect(emitter.emitted[0]).toEqual({ type: "text-start", id: "1" });
    expect(emitter.emitted[1]).toEqual({ type: "text-end", id: "1" });
  });

  it("skips emission when no emitter provided", async () => {
    const chunks: AtlasUIMessageChunk[] = [{ type: "text-delta", id: "1", delta: "hello" }];

    // Should not throw
    await pipeUIMessageStream(makeStream(chunks), undefined);
  });
});
