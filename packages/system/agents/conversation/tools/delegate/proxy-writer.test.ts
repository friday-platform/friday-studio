/**
 * Unit tests for the delegate proxy writer.
 *
 * Covers the three-state lifecycle (open / merging / closed), envelope
 * wrapping for both `write()` and `merge()`, and the silent-drop behavior
 * after `close()`.
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

  it("write() namespaces toolCallId fields and wraps in envelope", () => {
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
    expect(inner.toolCallId).toBe("del-1::child-x");
  });

  it("merge() forwards a stream of chunks envelope-wrapped in emission order", async () => {
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
        toolName: "do_task",
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
    // The middle chunk's toolCallId got namespaced.
    const second = out[1] as { data: { chunk: { toolCallId?: string } } } | undefined;
    expect(second?.data.chunk.toolCallId).toBe("del-2::child-1");
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

  it("state getter reports open / merging / closed correctly", async () => {
    const parent = makeWriter();
    const proxy = createDelegateProxyWriter({
      parent,
      delegateToolCallId: "del-4",
      logger: makeLogger(),
    });

    expect(proxy.state).toBe("open");

    // Inject a never-finishing source so we can observe `merging` state mid-flight.
    let controllerRef: ReadableStreamDefaultController<AtlasUIMessageChunk> | undefined;
    const blocker = new ReadableStream<AtlasUIMessageChunk>({
      start(controller) {
        controllerRef = controller;
      },
    });
    proxy.merge(blocker);
    // Force the consumer (parent.merged stream's reader) to start pulling from
    // the proxy's transform — without this, the transform never wires up to
    // the source and `state` would still report "open".
    if (parent.merged[0]) {
      const reader = parent.merged[0].getReader();
      // Poke the reader so the pipeThrough installs its source-pull plumbing,
      // then immediately release without consuming chunks.
      const pending = reader.read();
      // Surrender event-loop turn so the transform runs.
      await new Promise((r) => setTimeout(r, 0));
      expect(proxy.state).toBe("merging");
      // Close the source so the transform's flush runs and merge counter drops.
      controllerRef?.close();
      await pending;
      // Drain remaining chunks (none) so flush fires.
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
      reader.releaseLock();
    }
    // After flush, back to open.
    expect(proxy.state).toBe("open");

    proxy.close();
    expect(proxy.state).toBe("closed");
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
    expect(inner.toolCallId).toBe("del-5::child-7");
  });
});
