/**
 * Unit tests for the delegate proxy writer.
 *
 * Covers envelope wrapping for both `write()` and `merge()`, pass-through
 * of `nested-chunk` envelopes, `finish` tool drop behaviour, and the silent
 * drop after `close()`.
 */

import type { AtlasUIMessage, AtlasUIMessageChunk } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import type { UIMessageStreamWriter } from "ai";
import { describe, expect, it, vi } from "vitest";

import { createDelegateProxyWriter } from "./proxy-writer.ts";

interface RecordedWrite {
  chunk: AtlasUIMessageChunk;
}

interface MockWriter extends UIMessageStreamWriter<AtlasUIMessage> {
  writes: RecordedWrite[];
  merged: ReadableStream<AtlasUIMessageChunk>[];
}

function makeWriter(): MockWriter {
  const writes: RecordedWrite[] = [];
  const merged: ReadableStream<AtlasUIMessageChunk>[] = [];
  return {
    writes,
    merged,
    write(chunk) {
      writes.push({ chunk });
    },
    merge(stream) {
      merged.push(stream);
    },
    onError: undefined,
  };
}

function makeLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } satisfies Record<keyof Logger, unknown>;
}

async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) out.push(value);
  }
  return out;
}

function streamOf(chunks: AtlasUIMessageChunk[]): ReadableStream<AtlasUIMessageChunk> {
  return new ReadableStream<AtlasUIMessageChunk>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

describe("createDelegateProxyWriter", () => {
  it("write() envelope-wraps a chunk with no toolCallId (e.g. data-tool-progress)", () => {
    const parent = makeWriter();
    const proxy = createDelegateProxyWriter({
      parent,
      delegateToolCallId: "del-1",
      logger: makeLogger(),
    });

    proxy.write({ type: "data-tool-progress", data: { toolName: "X", content: "hello" } });

    expect(parent.writes).toHaveLength(1);
    const env = parent.writes[0]?.chunk;
    expect(env).toBeDefined();
    if (!env || typeof env !== "object" || !("type" in env)) throw new Error("bad envelope");
    // Forwarded as a delegate-chunk envelope, NOT a top-level data-tool-progress part.
    expect(env.type).toBe("data-delegate-chunk");
    expect((env as { data: { delegateToolCallId: string } }).data.delegateToolCallId).toBe("del-1");
    const inner = (env as { data: { chunk: { type: string } } }).data.chunk;
    expect(inner.type).toBe("data-tool-progress");
  });

  it("write() wraps raw tool chunks without namespacing toolCallId", () => {
    const parent = makeWriter();
    const proxy = createDelegateProxyWriter({
      parent,
      delegateToolCallId: "del-1",
      logger: makeLogger(),
    });

    proxy.write({
      type: "tool-input-available",
      toolCallId: "child-x",
      toolName: "web_search",
      input: { q: "z" },
    });

    expect(parent.writes).toHaveLength(1);
    const env = parent.writes[0]?.chunk;
    if (!env || typeof env !== "object" || !("type" in env)) throw new Error("bad envelope");
    expect(env.type).toBe("data-delegate-chunk");
    const inner = (env as { data: { chunk: { toolCallId: string } } }).data.chunk;
    // Must NOT be namespaced.
    expect(inner.toolCallId).toBe("child-x");
  });

  it("write() double-wraps a data-nested-chunk envelope without mutating inner ids", () => {
    const parent = makeWriter();
    const proxy = createDelegateProxyWriter({
      parent,
      delegateToolCallId: "del-1",
      logger: makeLogger(),
    });

    proxy.write({
      type: "data-nested-chunk",
      data: {
        parentToolCallId: "inner-parent",
        chunk: {
          type: "tool-input-available",
          toolCallId: "deep-child",
          toolName: "fetch",
          input: { url: "https://example.com" },
        } as unknown as AtlasUIMessageChunk,
      },
    });

    expect(parent.writes).toHaveLength(1);
    const env = parent.writes[0]?.chunk;
    if (!env || typeof env !== "object" || !("type" in env)) throw new Error("bad envelope");
    expect(env.type).toBe("data-delegate-chunk");

    const outer = env as {
      data: {
        delegateToolCallId: string;
        chunk: { type: string; data: { parentToolCallId: string; chunk: { toolCallId: string } } };
      };
    };
    expect(outer.data.delegateToolCallId).toBe("del-1");
    expect(outer.data.chunk.type).toBe("data-nested-chunk");
    expect(outer.data.chunk.data.parentToolCallId).toBe("inner-parent");
    expect(outer.data.chunk.data.chunk.toolCallId).toBe("deep-child");
  });

  it("merge() forwards a stream of chunks envelope-wrapped in emission order without namespacing", async () => {
    const parent = makeWriter();
    const proxy = createDelegateProxyWriter({
      parent,
      delegateToolCallId: "del-2",
      logger: makeLogger(),
    });

    const source = streamOf([
      { type: "text-start", id: "t1" },
      {
        type: "tool-input-available",
        toolCallId: "child-1",
        toolName: "task_runner",
        input: { ask: "go" },
      },
      { type: "tool-output-available", toolCallId: "child-1", output: { ok: true } },
    ]);

    proxy.merge(source);

    expect(parent.merged).toHaveLength(1);
    const out = parent.merged[0] ? await drain(parent.merged[0]) : [];
    expect(out).toHaveLength(3);
    for (const chunk of out) {
      if (typeof chunk !== "object" || chunk === null || !("type" in chunk)) {
        throw new Error("expected envelope");
      }
      expect(chunk.type).toBe("data-delegate-chunk");
    }
    const innerTypes = out
      .map((c) => (c as { data: { chunk: { type: string } } }).data.chunk.type)
      .filter((t): t is string => typeof t === "string");
    expect(innerTypes).toEqual(["text-start", "tool-input-available", "tool-output-available"]);
    // The middle chunk's toolCallId must NOT be namespaced.
    const second = out[1] as { data: { chunk: { toolCallId?: string } } } | undefined;
    expect(second?.data.chunk.toolCallId).toBe("child-1");
  });

  it("closed state — late write() and merge() silently drop input, no throw, debug logged", async () => {
    const parent = makeWriter();
    const logger = makeLogger();
    const proxy = createDelegateProxyWriter({ parent, delegateToolCallId: "del-3", logger });

    proxy.close();

    // write after close — silently dropped.
    expect(() =>
      proxy.write({ type: "tool-input-available", toolCallId: "x", toolName: "noop", input: {} }),
    ).not.toThrow();

    // merge after close — silently dropped, source must be cancelled so its
    // producer doesn't dangle.
    let cancelled = false;
    const lateSource = new ReadableStream<AtlasUIMessageChunk>({
      start(controller) {
        controller.enqueue({ type: "text-start", id: "t1" });
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(() => proxy.merge(lateSource)).not.toThrow();

    // Allow the cancel microtask to run before assertion.
    await Promise.resolve();
    expect(cancelled).toBe(true);

    // Parent received nothing.
    expect(parent.writes).toEqual([]);
    expect(parent.merged).toEqual([]);

    // Debug log fired exactly once per drop (one for write, one for merge).
    const debugMock = logger.debug as unknown as { mock: { calls: unknown[][] } };
    expect(debugMock.mock.calls).toHaveLength(2);
  });

  it("filters out finish tool chunks even via merge()", async () => {
    const parent = makeWriter();
    const proxy = createDelegateProxyWriter({
      parent,
      delegateToolCallId: "del-5",
      logger: makeLogger(),
    });

    const source = streamOf([
      {
        type: "tool-input-available",
        toolCallId: "fin-1",
        toolName: "finish",
        input: { ok: true, answer: "done" },
      },
      { type: "tool-output-available", toolCallId: "fin-1", output: { ok: true } },
      {
        type: "tool-input-available",
        toolCallId: "child-7",
        toolName: "web_search",
        input: { q: "k" },
      },
    ]);

    proxy.merge(source);
    const out = parent.merged[0] ? await drain(parent.merged[0]) : [];
    expect(out).toHaveLength(1);
    const inner = (out[0] as { data: { chunk: { toolCallId?: string } } }).data.chunk;
    expect(inner.toolCallId).toBe("child-7");
  });
});
