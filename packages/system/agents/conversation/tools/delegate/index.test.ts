/**
 * Tracer-bullet tests for the `delegate` tool.
 *
 * Mocks `streamText` to drive the delegate through canned chunk sequences,
 * captures the parent UIMessageStreamWriter to assert envelope-wrapped output,
 * and asserts the discriminated-union return value to the parent LLM.
 */

import type { AtlasTools, AtlasUIMessage, AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { repairToolCall } from "@atlas/agent-sdk";
import { createStubPlatformModels } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import type { UIMessageStreamWriter } from "ai";
import { tool } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mockStreamText = vi.hoisted(() => vi.fn());
const mockStepCountIs = vi.hoisted(() => vi.fn((n: number) => ({ __stepCountIs: n })));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, streamText: mockStreamText, stepCountIs: mockStepCountIs };
});

import { createDelegateTool, type DelegateResult } from "./index.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

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

interface CapturedStreamTextArgs {
  args: Parameters<typeof mockStreamText>[0] | undefined;
}

interface FakeStepInput {
  toolCalls?: Array<{ toolCallId: string; toolName: string; input?: unknown }>;
  toolErrors?: Array<{ toolCallId: string; toolName: string; input?: unknown; error?: unknown }>;
  finish?: { ok: true; answer: string } | { ok: false; reason: string };
}

interface FakeRunOptions {
  steps: FakeStepInput[];
  finalText: string;
  /** Extra envelope-bound chunks to push into `toUIMessageStream`. */
  streamChunks?: AtlasUIMessageChunk[];
  /** When set, `result.text` rejects with this error. */
  throwOnText?: Error;
}

function setupMockStreamText(captured: CapturedStreamTextArgs, run: FakeRunOptions): void {
  mockStreamText.mockImplementation((args: Parameters<typeof mockStreamText>[0]) => {
    captured.args = args;

    const buildSteps = () => {
      return run.steps.map((s) => {
        const content: Array<Record<string, unknown>> = [];
        for (const c of s.toolCalls ?? []) {
          content.push({
            type: "tool-call",
            toolCallId: c.toolCallId,
            toolName: c.toolName,
            input: c.input ?? {},
            dynamic: false,
          });
        }
        for (const e of s.toolErrors ?? []) {
          content.push({
            type: "tool-error",
            toolCallId: e.toolCallId,
            toolName: e.toolName,
            input: e.input ?? {},
            error: e.error ?? "boom",
            dynamic: false,
          });
        }
        if (s.finish) {
          content.push({
            type: "tool-result",
            toolCallId: `finish-${Math.random()}`,
            toolName: "finish",
            input: s.finish,
            output: s.finish,
            dynamic: false,
          });
        }
        return { content };
      });
    };

    const stream = new ReadableStream<AtlasUIMessageChunk>({
      start(controller) {
        for (const chunk of run.streamChunks ?? []) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    return {
      steps: Promise.resolve(buildSteps()),
      text: run.throwOnText ? Promise.reject(run.throwOnText) : Promise.resolve(run.finalText),
      toUIMessageStream: () => stream,
    };
  });
}

const dummyTool = tool({
  description: "dummy",
  inputSchema: z.object({}),
  execute: () => Promise.resolve({ ok: true }),
});

function makeDelegate(overrideTools?: AtlasTools, writer?: MockWriter) {
  const w = writer ?? makeWriter();
  const tools: AtlasTools = overrideTools ?? {
    web_search: dummyTool,
    do_task: dummyTool,
    delegate: dummyTool, // intentionally present to verify it gets stripped
  };
  const delegateTool = createDelegateTool(
    {
      writer: w,
      session: {
        sessionId: "s1",
        workspaceId: "w1",
        streamId: "st1",
        datetime: {
          timezone: "UTC",
          timestamp: "2026-04-22T00:00:00Z",
          localDate: "2026-04-22",
          localTime: "00:00",
          timezoneOffset: "+00:00",
        },
      },
      platformModels: createStubPlatformModels(),
      logger: makeLogger(),
      abortSignal: undefined,
      repairToolCall,
    },
    () => tools,
  );
  return { delegateTool, writer: w };
}

async function runDelegate(
  delegateTool: ReturnType<typeof createDelegateTool>,
  toolCallId = "del-call-1",
): Promise<DelegateResult> {
  // The AI SDK's tool() wraps execute; invoke directly via the typed handle.
  const execute = delegateTool.execute;
  if (!execute) throw new Error("delegate has no execute");
  const result = (await execute(
    { goal: "summarize a webpage", handoff: "the user wants a one-paragraph summary" },
    { toolCallId, messages: [], abortSignal: undefined as unknown as AbortSignal },
  )) as DelegateResult;
  return result;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("createDelegateTool", () => {
  beforeEach(() => {
    mockStreamText.mockReset();
    mockStepCountIs.mockClear();
  });

  it("happy path — finish ok=true drives answer, envelopes carry namespaced toolCallIds", async () => {
    const captured: CapturedStreamTextArgs = { args: undefined };
    setupMockStreamText(captured, {
      steps: [
        {
          toolCalls: [{ toolCallId: "child-1", toolName: "web_search" }],
          finish: { ok: true, answer: "hi" },
        },
      ],
      finalText: "ignored when finish is called",
      streamChunks: [
        { type: "text-start", id: "t1" },
        {
          type: "tool-input-available",
          toolCallId: "child-1",
          toolName: "web_search",
          input: { query: "hello" },
        },
        { type: "tool-output-available", toolCallId: "child-1", output: { results: [] } },
        // Finish should be filtered out by the proxy.
        {
          type: "tool-input-available",
          toolCallId: "finish-id",
          toolName: "finish",
          input: { ok: true, answer: "hi" },
        },
        {
          type: "tool-output-available",
          toolCallId: "finish-id",
          output: { ok: true, answer: "hi" },
        },
      ],
    });

    const { delegateTool, writer } = makeDelegate();
    const result = await runDelegate(delegateTool);

    expect(result).toEqual({
      ok: true,
      answer: "hi",
      toolsUsed: [{ name: "web_search", outcome: "success" }],
    });

    // Drain the merged stream so we can inspect what the proxy forwarded.
    expect(writer.merged.length).toBe(1);
    const [mergedStream] = writer.merged;
    if (!mergedStream) throw new Error("expected merged stream");
    const drained = await drain(mergedStream);

    // Every forwarded chunk must be a data-delegate-chunk envelope.
    for (const chunk of drained) {
      expect(chunk.type).toBe("data-delegate-chunk");
    }
    const envelopedToolCallIds = drained
      .map((c) => extractInnerToolCallId(c))
      .filter((v): v is string => v !== undefined);
    // `web_search` chunks get namespaced; `finish` chunks are dropped.
    expect(envelopedToolCallIds).toContain("del-call-1::child-1");
    expect(envelopedToolCallIds.every((id) => !id.endsWith("::finish-id"))).toBe(true);
  });

  it("falls back to final streamed text when child does not call finish", async () => {
    const captured: CapturedStreamTextArgs = { args: undefined };
    setupMockStreamText(captured, {
      steps: [{ toolCalls: [{ toolCallId: "c1", toolName: "web_search" }] }],
      finalText: "the final assistant text",
    });

    const { delegateTool } = makeDelegate();
    const result = await runDelegate(delegateTool);

    expect(result).toEqual({
      ok: true,
      answer: "the final assistant text",
      toolsUsed: [{ name: "web_search", outcome: "success" }],
    });
  });

  it("returns ok=false when finish reports failure", async () => {
    const captured: CapturedStreamTextArgs = { args: undefined };
    setupMockStreamText(captured, {
      steps: [
        {
          toolCalls: [{ toolCallId: "c1", toolName: "web_search" }],
          finish: { ok: false, reason: "rate limited" },
        },
      ],
      finalText: "",
    });

    const { delegateTool } = makeDelegate();
    const result = await runDelegate(delegateTool);

    expect(result).toEqual({
      ok: false,
      reason: "rate limited",
      toolsUsed: [{ name: "web_search", outcome: "success" }],
    });
  });

  it("returns ok=false with the exception message when child throws, populating toolsUsed from steps", async () => {
    const captured: CapturedStreamTextArgs = { args: undefined };
    setupMockStreamText(captured, {
      steps: [{ toolCalls: [{ toolCallId: "c1", toolName: "web_search" }] }],
      finalText: "",
      throwOnText: new Error("boom"),
    });

    const { delegateTool } = makeDelegate();
    const result = await runDelegate(delegateTool);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("boom");
      expect(result.toolsUsed).toEqual([{ name: "web_search", outcome: "success" }]);
    }
    // execute() did not throw — assertion above implies that.
  });

  it("strips delegate from the child tool set and injects finish", async () => {
    const captured: CapturedStreamTextArgs = { args: undefined };
    setupMockStreamText(captured, {
      steps: [{ finish: { ok: true, answer: "done" } }],
      finalText: "",
    });

    const { delegateTool } = makeDelegate({
      web_search: dummyTool,
      do_task: dummyTool,
      delegate: dummyTool,
      file_read: dummyTool,
    });
    await runDelegate(delegateTool);

    const tools = captured.args?.tools as Record<string, unknown> | undefined;
    expect(tools).toBeDefined();
    expect(Object.keys(tools ?? {}).sort()).toEqual(
      ["do_task", "file_read", "finish", "web_search"].sort(),
    );
    expect("delegate" in (tools ?? {})).toBe(false);
  });

  it("inherits parent's repair function and uses an independent step budget without connectServiceSucceeded", async () => {
    const captured: CapturedStreamTextArgs = { args: undefined };
    setupMockStreamText(captured, {
      steps: [{ finish: { ok: true, answer: "done" } }],
      finalText: "",
    });

    const { delegateTool } = makeDelegate();
    await runDelegate(delegateTool);

    expect(captured.args?.experimental_repairToolCall).toBe(repairToolCall);

    const stopWhen = captured.args?.stopWhen as unknown[];
    expect(Array.isArray(stopWhen)).toBe(true);
    expect(stopWhen).toHaveLength(1);
    expect(mockStepCountIs).toHaveBeenCalledWith(40);

    const system = captured.args?.system as string;
    expect(system).toContain("Goal:");
    expect(system).toContain("Handoff:");
    // Must NOT contain a parent-prompt marker.
    expect(system).not.toContain("Workspaces may have");
    expect(system).not.toContain("<capabilities>");
  });

  it("records outcome:error when a child tool surfaces a tool-error", async () => {
    const captured: CapturedStreamTextArgs = { args: undefined };
    setupMockStreamText(captured, {
      steps: [
        {
          toolCalls: [
            { toolCallId: "c1", toolName: "web_search" },
            { toolCallId: "c2", toolName: "web_fetch" },
          ],
          toolErrors: [{ toolCallId: "c2", toolName: "web_fetch", error: "404" }],
          finish: { ok: true, answer: "partial" },
        },
      ],
      finalText: "",
    });

    const { delegateTool } = makeDelegate();
    const result = await runDelegate(delegateTool);

    expect(result.ok).toBe(true);
    expect(result.toolsUsed).toEqual(
      expect.arrayContaining([
        { name: "web_search", outcome: "success" },
        { name: "web_fetch", outcome: "error" },
      ]),
    );
  });
});

// ─── Local helpers (after the test for readability) ─────────────────────────

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

/**
 * Reach into a `data-delegate-chunk` envelope and pull the embedded chunk's
 * `toolCallId` (after the proxy has namespaced it). Returns undefined when
 * the chunk doesn't have one (e.g. text deltas).
 */
function extractInnerToolCallId(envelope: AtlasUIMessageChunk): string | undefined {
  if (typeof envelope !== "object" || envelope === null) return undefined;
  if (!("type" in envelope) || envelope.type !== "data-delegate-chunk") return undefined;
  const data = (envelope as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const inner = (data as { chunk?: unknown }).chunk;
  if (typeof inner !== "object" || inner === null) return undefined;
  const id = (inner as { toolCallId?: unknown }).toolCallId;
  return typeof id === "string" ? id : undefined;
}
