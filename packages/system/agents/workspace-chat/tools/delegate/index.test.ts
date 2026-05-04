/**
 * Tracer-bullet tests for the `delegate` tool.
 *
 * Mocks `streamText` to drive the delegate through canned chunk sequences,
 * captures the parent UIMessageStreamWriter to assert envelope-wrapped output,
 * and asserts the discriminated-union return value to the parent LLM.
 */

import type { AtlasTools, AtlasUIMessage, AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { repairToolCall, validateAtlasUIMessages } from "@atlas/agent-sdk";
import type { WorkspaceConfig } from "@atlas/config";
import type { MCPServerCandidate } from "@atlas/core/mcp-registry/discovery";
import { createStubPlatformModels } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import type { UIMessageStreamWriter } from "ai";
import { tool } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mockStreamText = vi.hoisted(() => vi.fn());
const mockStepCountIs = vi.hoisted(() => vi.fn((n: number) => ({ __stepCountIs: n })));
const mockDiscoverMCPServers = vi.hoisted(() => vi.fn());
const mockCreateMCPTools = vi.hoisted(() => vi.fn());

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, streamText: mockStreamText, stepCountIs: mockStepCountIs };
});

vi.mock("@atlas/core/mcp-registry/discovery", () => ({
  discoverMCPServers: mockDiscoverMCPServers,
}));

vi.mock("@atlas/mcp", () => ({ createMCPTools: mockCreateMCPTools }));

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

function makeDelegate(
  overrideTools?: AtlasTools,
  writer?: MockWriter,
  abortSignal?: AbortSignal,
  logger?: Logger,
  depsOverrides?: Record<string, unknown>,
) {
  const w = writer ?? makeWriter();
  const tools: AtlasTools = overrideTools ?? {
    web_search: dummyTool,
    task_runner: dummyTool,
    delegate: dummyTool, // intentionally present to verify it gets stripped
  };
  const log = logger ?? makeLogger();
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
      logger: log,
      abortSignal,
      repairToolCall,
      ...depsOverrides,
    },
    () => tools,
  );
  return { delegateTool, writer: w, logger: log };
}

async function runDelegate(
  delegateTool: ReturnType<typeof createDelegateTool>,
  toolCallId = "del-call-1",
  overrides?: Partial<{ goal: string; handoff: string; mcpServers: string[] }>,
): Promise<DelegateResult> {
  // The AI SDK's tool() wraps execute; invoke directly via the typed handle.
  const execute = delegateTool.execute;
  if (!execute) throw new Error("delegate has no execute");
  const result = (await execute(
    {
      goal: overrides?.goal ?? "summarize a webpage",
      handoff: overrides?.handoff ?? "the user wants a one-paragraph summary",
      ...overrides,
    },
    { toolCallId, messages: [], abortSignal: undefined as unknown as AbortSignal },
  )) as DelegateResult;
  return result;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("createDelegateTool", () => {
  beforeEach(() => {
    mockStreamText.mockReset();
    mockStepCountIs.mockClear();
    mockDiscoverMCPServers.mockReset();
    mockCreateMCPTools.mockReset();
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

    // The delegate forwards each child chunk via writer.write() (not merge)
    // so the synthetic delegate-end terminator emitted in `finally` lands
    // strictly after all child chunks. Inspect those writes for envelope
    // wrapping + namespacing.
    const delegateChunks = writer.writes
      .map((w) => w.chunk)
      .filter(
        (c) =>
          typeof c === "object" && c !== null && "type" in c && c.type === "data-delegate-chunk",
      );
    // At least one envelope (the child tool chunks) plus the terminator.
    expect(delegateChunks.length).toBeGreaterThan(1);
    const envelopedToolCallIds = delegateChunks
      .map((c) => extractInnerToolCallId(c))
      .filter((v): v is string => v !== undefined);
    // Inner toolCallIds are forwarded unchanged (the parent reads them via
    // the `delegateToolCallId` on the envelope to disambiguate). `finish`
    // chunks are dropped.
    expect(envelopedToolCallIds).toContain("child-1");
    expect(envelopedToolCallIds.every((id) => id !== "finish-id")).toBe(true);
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

    const { delegateTool, writer } = makeDelegate();
    const result = await runDelegate(delegateTool);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("boom");
      expect(result.toolsUsed).toEqual([{ name: "web_search", outcome: "success" }]);
    }
    // execute() did not throw — assertion above implies that.

    // The `finally` block in `execute()` must always emit a delegate-end
    // terminator and a delegate-ledger event, even when result.text rejects.
    const terminators = writer.writes.map((w) => w.chunk).filter((c) => isDelegateEndTerminator(c));
    expect(terminators).toHaveLength(1);
    const ledgerWrites = writer.writes
      .map((w) => w.chunk)
      .filter(
        (c) =>
          typeof c === "object" && c !== null && "type" in c && c.type === "data-delegate-ledger",
      );
    expect(ledgerWrites).toHaveLength(1);
  });

  it("strips delegate from the child tool set and injects finish", async () => {
    const captured: CapturedStreamTextArgs = { args: undefined };
    setupMockStreamText(captured, {
      steps: [{ finish: { ok: true, answer: "done" } }],
      finalText: "",
    });

    const { delegateTool } = makeDelegate({
      web_search: dummyTool,
      task_runner: dummyTool,
      delegate: dummyTool,
      file_read: dummyTool,
    });
    await runDelegate(delegateTool);

    const tools = captured.args?.tools as Record<string, unknown> | undefined;
    expect(tools).toBeDefined();
    expect(Object.keys(tools ?? {}).sort()).toEqual(
      ["task_runner", "file_read", "finish", "web_search"].sort(),
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
    // Child must be instructed to stay terse — no conversational filler.
    expect(system).toContain("terse back-end agent");
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

  it("emits data-delegate-ledger with all seven fields while result.toolsUsed stays outline-only", async () => {
    const captured: CapturedStreamTextArgs = { args: undefined };
    setupMockStreamText(captured, {
      steps: [
        {
          toolCalls: [
            { toolCallId: "c1", toolName: "web_search", input: { query: "foo" } },
            { toolCallId: "c2", toolName: "web_fetch", input: { url: "https://x" } },
          ],
          // Provide per-call tool-result parts so the step walker can fill summary.
          // (setupMockStreamText only produces finish's tool-result, not per-call —
          // but tool-call alone is enough for the ledger to have outcome:success.)
        },
        {
          toolCalls: [{ toolCallId: "c3", toolName: "task_runner", input: { ask: "summarize" } }],
          finish: { ok: true, answer: "done" },
        },
      ],
      finalText: "",
      streamChunks: [
        {
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: "web_search",
          input: { query: "foo" },
        },
        { type: "tool-output-available", toolCallId: "c1", output: { hits: 3 } },
        {
          type: "tool-input-available",
          toolCallId: "c2",
          toolName: "web_fetch",
          input: { url: "https://x" },
        },
        { type: "tool-output-available", toolCallId: "c2", output: { status: 200 } },
        {
          type: "tool-input-available",
          toolCallId: "c3",
          toolName: "task_runner",
          input: { ask: "summarize" },
        },
        { type: "tool-output-available", toolCallId: "c3", output: { summary: "ok" } },
      ],
    });

    const { delegateTool, writer } = makeDelegate();
    const result = await runDelegate(delegateTool);

    // Outline projection — only name + outcome, no other fields.
    expect(result.toolsUsed).toHaveLength(3);
    for (const entry of result.toolsUsed) {
      expect(Object.keys(entry).sort()).toEqual(["name", "outcome"]);
    }
    expect(result.toolsUsed.map((e) => e.name).sort()).toEqual(
      ["task_runner", "web_fetch", "web_search"].sort(),
    );
    for (const entry of result.toolsUsed) {
      expect(entry.outcome).toBe("success");
    }

    // Exactly one data-delegate-ledger event with all seven fields per entry.
    const ledgerWrites = writer.writes
      .map((w) => w.chunk)
      .filter(
        (c): c is AtlasUIMessageChunk & { type: "data-delegate-ledger" } =>
          typeof c === "object" && c !== null && "type" in c && c.type === "data-delegate-ledger",
      );
    expect(ledgerWrites).toHaveLength(1);
    const ledger = ledgerWrites[0];
    if (!ledger) throw new Error("unreachable");
    const ledgerData = extractLedgerData(ledger);
    expect(ledgerData?.delegateToolCallId).toBe("del-call-1");
    expect(ledgerData?.toolsUsed).toHaveLength(3);
    for (const entry of ledgerData?.toolsUsed ?? []) {
      expect(Object.keys(entry).sort()).toEqual(
        ["durationMs", "input", "name", "outcome", "stepIndex", "summary", "toolCallId"].sort(),
      );
      expect(typeof entry.durationMs).toBe("number");
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    }
    // Outline and full ledger agree on counts, names, and outcomes.
    const outlineSorted = [...result.toolsUsed].sort((a, b) => a.name.localeCompare(b.name));
    const fullSorted = [...(ledgerData?.toolsUsed ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    expect(outlineSorted.map((e) => e.name)).toEqual(fullSorted.map((e) => e.name));
    expect(outlineSorted.map((e) => e.outcome)).toEqual(fullSorted.map((e) => e.outcome));

    // stepIndex reflects mock step ordering: c1,c2 in step 0, c3 in step 1.
    const byId = new Map(ledgerData?.toolsUsed.map((e) => [e.toolCallId, e]));
    expect(byId.get("c1")?.stepIndex).toBe(0);
    expect(byId.get("c2")?.stepIndex).toBe(0);
    expect(byId.get("c3")?.stepIndex).toBe(1);

    // `finish` tool never appears in the ledger.
    expect(ledgerData?.toolsUsed.some((e) => e.name === "finish")).toBe(false);
  });

  it("ledger wire shape matches what a reducer would reconstruct from forwarded data-delegate-chunk envelopes", async () => {
    // Same fixture sequence used both for direct ledger emission and for
    // downstream reducers that replay data-delegate-chunk envelopes. The shape
    // the ledger carries must be what the reducer can reconstruct on
    // `{tools called, ordering, toolCallId, stepIndex, outcomes}`.
    const captured: CapturedStreamTextArgs = { args: undefined };
    setupMockStreamText(captured, {
      steps: [
        { toolCalls: [{ toolCallId: "c1", toolName: "web_search", input: { q: "a" } }] },
        {
          toolCalls: [{ toolCallId: "c2", toolName: "web_fetch", input: { u: "b" } }],
          toolErrors: [{ toolCallId: "c2", toolName: "web_fetch", error: "boom" }],
          finish: { ok: false, reason: "upstream 404" },
        },
      ],
      finalText: "",
      streamChunks: [
        {
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: "web_search",
          input: { q: "a" },
        },
        { type: "tool-output-available", toolCallId: "c1", output: { hits: 1 } },
        {
          type: "tool-input-available",
          toolCallId: "c2",
          toolName: "web_fetch",
          input: { u: "b" },
        },
        { type: "tool-output-error", toolCallId: "c2", errorText: "boom" },
      ],
    });

    const { delegateTool, writer } = makeDelegate();
    const result = await runDelegate(delegateTool);

    expect(result.ok).toBe(false);
    expect(result.toolsUsed).toEqual(
      expect.arrayContaining([
        { name: "web_search", outcome: "success" },
        { name: "web_fetch", outcome: "error" },
      ]),
    );

    const ledgerWrite = writer.writes.find(
      (w) =>
        typeof w.chunk === "object" &&
        w.chunk !== null &&
        "type" in w.chunk &&
        w.chunk.type === "data-delegate-ledger",
    );
    if (!ledgerWrite) throw new Error("expected ledger write");
    const ledgerData = extractLedgerData(ledgerWrite.chunk);

    // What the reducer reconstructs from forwarded envelopes — delegate now
    // forwards each child chunk via writer.write() so we mine those.
    const forwardedEnvelopes = writer.writes
      .map((w) => w.chunk)
      .filter(
        (c) =>
          typeof c === "object" && c !== null && "type" in c && c.type === "data-delegate-chunk",
      );
    const reconstructed = reconstructFromEnvelopes(forwardedEnvelopes);

    expect(ledgerData).toBeDefined();
    if (!ledgerData) throw new Error("unreachable");

    // Agreement on the shape the reducer can reconstruct.
    const ledgerSorted = [...ledgerData.toolsUsed].sort((a, b) =>
      a.toolCallId.localeCompare(b.toolCallId),
    );
    const reconstructedSorted = [...reconstructed].sort((a, b) =>
      a.toolCallId.localeCompare(b.toolCallId),
    );
    expect(ledgerSorted.map((e) => e.toolCallId)).toEqual(
      reconstructedSorted.map((e) => e.toolCallId),
    );
    expect(ledgerSorted.map((e) => e.name)).toEqual(reconstructedSorted.map((e) => e.name));
    expect(ledgerSorted.map((e) => e.outcome)).toEqual(reconstructedSorted.map((e) => e.outcome));
    // stepIndex agreement: reducer derives it from the chunk ordering; the
    // ledger derives it from step walking. For this fixture both end up with
    // c1 at the 0th call and c2 at the 1st.
    const ledgerOrdering = ledgerSorted.map((e) => ({ id: e.toolCallId, step: e.stepIndex }));
    expect(ledgerOrdering).toEqual([
      { id: "c1", step: 0 },
      { id: "c2", step: 1 },
    ]);
  });

  it("clean-finish persistence round-trip: ledger survives validateAtlasUIMessages", async () => {
    // Run the delegate with a clean finish, gather the writer's writes into a
    // synthetic message's parts[], then validate via validateAtlasUIMessages
    // (the same path chat persistence uses on load) and assert the
    // data-delegate-ledger part round-trips intact.
    const captured: CapturedStreamTextArgs = { args: undefined };
    setupMockStreamText(captured, {
      steps: [
        {
          toolCalls: [{ toolCallId: "c1", toolName: "web_search", input: { q: "x" } }],
          finish: { ok: true, answer: "all good" },
        },
      ],
      finalText: "",
      streamChunks: [
        {
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: "web_search",
          input: { q: "x" },
        },
        { type: "tool-output-available", toolCallId: "c1", output: { hits: 7 } },
      ],
    });

    const { delegateTool, writer } = makeDelegate();
    const result = await runDelegate(delegateTool);
    expect(result.ok).toBe(true);

    // Both the forwarded envelopes and the ledger now land in writer.writes —
    // delegate forwards each child chunk via writer.write() so we walk those
    // in order to reconstruct what chat-storage would persist.
    const dataParts: Array<Record<string, unknown>> = [];
    for (const w of writer.writes) {
      const chunk = w.chunk;
      if (
        typeof chunk === "object" &&
        chunk !== null &&
        "type" in chunk &&
        "data" in chunk &&
        typeof chunk.type === "string" &&
        chunk.type.startsWith("data-")
      ) {
        dataParts.push({ type: chunk.type, data: chunk.data });
      }
    }

    const messages = [
      {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "text", text: "delegated" }, ...dataParts],
        metadata: {},
      },
    ];

    const validated = await validateAtlasUIMessages(messages);
    expect(validated).toHaveLength(1);
    const reloaded = validated[0];
    if (!reloaded) throw new Error("expected reloaded message");
    const ledgerParts = reloaded.parts.filter((p) => p.type === "data-delegate-ledger");
    expect(ledgerParts).toHaveLength(1);
    const ledgerPart = ledgerParts[0];
    if (ledgerPart?.type !== "data-delegate-ledger") throw new Error("type mismatch");
    expect(ledgerPart.data.delegateToolCallId).toBe("del-call-1");
    expect(ledgerPart.data.toolsUsed).toHaveLength(1);
    const entry = ledgerPart.data.toolsUsed[0];
    if (!entry) throw new Error("expected ledger entry");
    expect(entry.toolCallId).toBe("c1");
    expect(entry.name).toBe("web_search");
    expect(entry.outcome).toBe("success");
    expect(entry.stepIndex).toBe(0);
    expect(typeof entry.durationMs).toBe("number");
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("abort cascade — parent abort flushes delegate-end with the in-flight child id and a partial ledger", async () => {
    const captured: CapturedStreamTextArgs = { args: undefined };
    // Stream emits one tool-input-available for c1 then closes WITHOUT a
    // terminal chunk for c1 — simulating the streamText call being cut short
    // by the parent's abort signal. The mocked `result.text` rejects with the
    // abort error the AI SDK would surface in real life.
    setupMockStreamText(captured, {
      // Steps include c1 so the ledger walker can pick up name + outcome.
      steps: [{ toolCalls: [{ toolCallId: "c1", toolName: "web_search", input: { q: "x" } }] }],
      finalText: "",
      throwOnText: new Error("aborted"),
      streamChunks: [
        {
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: "web_search",
          input: { q: "x" },
        },
        // No tool-output-available / tool-output-error for c1 — c1 is in-flight.
      ],
    });

    const ac = new AbortController();
    const { delegateTool, writer } = makeDelegate(undefined, undefined, ac.signal);
    // Fire the abort before invoking — emulates the parent's signal having
    // already flipped by the time `finally` checks `aborted`.
    ac.abort();
    const result = await runDelegate(delegateTool);

    // (a) Child's streamText received the abort signal.
    expect(captured.args?.abortSignal).toBe(ac.signal);

    // (b) Proxy received a delegate-end terminator with no payload.
    // Simplified crash recovery: when delegate-end fires, all non-terminal
    // children under this delegate are promoted to output-error.
    const terminators = writer.writes.map((w) => w.chunk).filter((c) => isDelegateEndTerminator(c));
    expect(terminators).toHaveLength(1);

    // (c) data-delegate-ledger event was written with the partial ledger.
    const ledgerWrites = writer.writes
      .map((w) => w.chunk)
      .map((c) => extractLedgerData(c))
      .filter((d): d is LedgerData => d !== undefined);
    expect(ledgerWrites).toHaveLength(1);
    expect(ledgerWrites[0]?.toolsUsed.map((e) => e.toolCallId)).toEqual(["c1"]);

    // (d) Delegate returned ok=false without throwing.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Either the captured abort reason or the textError message is acceptable —
      // both are exercised by this fixture. Either way: a non-empty reason.
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.toolsUsed).toEqual([{ name: "web_search", outcome: "success" }]);
    }
  });

  it("aborted persistence round-trip: reloaded message has exactly one delegate-end with the in-flight ids", async () => {
    const captured: CapturedStreamTextArgs = { args: undefined };
    setupMockStreamText(captured, {
      // Two children started; only c1 terminates. c2 is in-flight at "abort" time.
      steps: [
        {
          toolCalls: [
            { toolCallId: "c1", toolName: "web_search", input: { q: "ok" } },
            { toolCallId: "c2", toolName: "web_fetch", input: { url: "u" } },
          ],
        },
      ],
      finalText: "",
      throwOnText: new Error("aborted"),
      streamChunks: [
        {
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: "web_search",
          input: { q: "ok" },
        },
        { type: "tool-output-available", toolCallId: "c1", output: { hits: 2 } },
        {
          type: "tool-input-available",
          toolCallId: "c2",
          toolName: "web_fetch",
          input: { url: "u" },
        },
        // No terminal chunk for c2.
      ],
    });

    const ac = new AbortController();
    const { delegateTool, writer } = makeDelegate(undefined, undefined, ac.signal);
    ac.abort();
    const result = await runDelegate(delegateTool);
    expect(result.ok).toBe(false);

    // Compose the persisted message exactly as chat-storage would build it
    // from data-* chunks observed on the wire — delegate forwards every child
    // chunk via writer.write() (not merge) so they all live in writer.writes.
    const dataParts: Array<Record<string, unknown>> = [];
    for (const w of writer.writes) {
      const chunk = w.chunk;
      if (
        typeof chunk === "object" &&
        chunk !== null &&
        "type" in chunk &&
        "data" in chunk &&
        typeof chunk.type === "string" &&
        chunk.type.startsWith("data-")
      ) {
        dataParts.push({ type: chunk.type, data: chunk.data });
      }
    }

    const messages = [
      {
        id: "msg-abort-1",
        role: "assistant",
        parts: [{ type: "text", text: "delegated and aborted" }, ...dataParts],
        metadata: {},
      },
    ];

    const validated = await validateAtlasUIMessages(messages);
    expect(validated).toHaveLength(1);
    const reloaded = validated[0];
    if (!reloaded) throw new Error("expected reloaded message");

    // Exactly one delegate-end chunk after reload, with no payload.
    // Simplified crash recovery promotes all non-terminal children.
    const delegateChunks = reloaded.parts.filter((p) => p.type === "data-delegate-chunk");
    const reloadedTerminators = delegateChunks.filter((p) => {
      if (p.type !== "data-delegate-chunk") return false;
      const inner = p.data?.chunk;
      if (typeof inner !== "object" || inner === null) return false;
      if (!("type" in inner) || inner.type !== "delegate-end") return false;
      return !("pendingToolCallIds" in inner);
    });
    expect(reloadedTerminators).toHaveLength(1);

    // Ledger present after reload, listing both children.
    const ledgerParts = reloaded.parts.filter((p) => p.type === "data-delegate-ledger");
    expect(ledgerParts).toHaveLength(1);
    const ledgerPart = ledgerParts[0];
    if (ledgerPart?.type !== "data-delegate-ledger") throw new Error("type mismatch");
    expect(ledgerPart.data.toolsUsed.map((e) => e.toolCallId).sort()).toEqual(["c1", "c2"]);
  });

  it("delegate-end is the last data-delegate-chunk written for the delegateToolCallId on the happy path", async () => {
    const captured: CapturedStreamTextArgs = { args: undefined };
    setupMockStreamText(captured, {
      steps: [
        {
          toolCalls: [{ toolCallId: "c1", toolName: "web_search" }],
          finish: { ok: true, answer: "ok" },
        },
      ],
      finalText: "",
      streamChunks: [
        { type: "tool-input-available", toolCallId: "c1", toolName: "web_search", input: {} },
        { type: "tool-output-available", toolCallId: "c1", output: { hits: 1 } },
      ],
    });
    const { delegateTool, writer } = makeDelegate();
    await runDelegate(delegateTool);

    // All envelopes land in writer.writes in chronological order. The
    // terminator must be the last data-delegate-chunk written for this
    // delegateToolCallId.
    const allDelegateChunks = writer.writes
      .map((w) => w.chunk)
      .filter(
        (c) =>
          typeof c === "object" && c !== null && "type" in c && c.type === "data-delegate-chunk",
      );
    const lastDelegateChunk = allDelegateChunks[allDelegateChunks.length - 1];
    expect(lastDelegateChunk).toBeDefined();
    if (!lastDelegateChunk) throw new Error("expected last delegate chunk");
    expect(isDelegateEndTerminator(lastDelegateChunk)).toBe(true);
  });

  it("rejects unknown or unconfigured MCP server IDs with ok=false", async () => {
    mockDiscoverMCPServers.mockResolvedValue([
      {
        metadata: {
          id: "known",
          name: "Known",
          source: "workspace",
          securityRating: "unverified",
          configTemplate: { transport: { type: "stdio", command: "cmd" } },
        },
        mergedConfig: { transport: { type: "stdio", command: "cmd" } },
        configured: true,
      },
      {
        metadata: {
          id: "unconfigured",
          name: "Unconfigured",
          source: "workspace",
          securityRating: "unverified",
          configTemplate: { transport: { type: "stdio", command: "cmd" } },
        },
        mergedConfig: { transport: { type: "stdio", command: "cmd" } },
        configured: false,
      },
    ] satisfies MCPServerCandidate[]);

    const { delegateTool } = makeDelegate(undefined, undefined, undefined, undefined, {
      workspaceConfig: {} as unknown as WorkspaceConfig,
    });
    const result = await runDelegate(delegateTool, "del-call-1", {
      mcpServers: ["unknown", "unconfigured"],
    });

    expect(result).toEqual({
      ok: false,
      reason: "Unknown or unconfigured MCP server(s): unknown, unconfigured",
      toolsUsed: [],
    });
    expect(mockCreateMCPTools).not.toHaveBeenCalled();
  });

  it("connects a single MCP server without tool prefix", async () => {
    mockDiscoverMCPServers.mockResolvedValue([
      {
        metadata: {
          id: "server-a",
          name: "A",
          source: "workspace",
          securityRating: "unverified",
          configTemplate: { transport: { type: "stdio", command: "a" } },
        },
        mergedConfig: { transport: { type: "stdio", command: "a" } },
        configured: true,
      },
    ] satisfies MCPServerCandidate[]);
    const mockDispose = vi.fn();
    mockCreateMCPTools.mockResolvedValue({ tools: { tool_a: dummyTool }, dispose: mockDispose });

    const captured: CapturedStreamTextArgs = { args: undefined };
    setupMockStreamText(captured, {
      steps: [{ finish: { ok: true, answer: "done" } }],
      finalText: "",
    });

    const { delegateTool } = makeDelegate(undefined, undefined, undefined, undefined, {
      workspaceConfig: {} as unknown as WorkspaceConfig,
    });
    const result = await runDelegate(delegateTool, "del-call-1", { mcpServers: ["server-a"] });

    expect(result.ok).toBe(true);
    expect("serverFailures" in result).toBe(false);
    expect(mockCreateMCPTools).toHaveBeenCalledWith(
      { "server-a": { transport: { type: "stdio", command: "a" } } },
      expect.any(Object),
      // The delegate now plumbs a `scrubResult` post-processor so MCP tool
      // outputs get oversized binary lifted to artifacts at the boundary
      // (see scrub-tool-output.ts). Asserted as a function here; behavior
      // is covered in scrub-tool-output.test.ts.
      { signal: undefined, toolPrefix: undefined, scrubResult: expect.any(Function) },
    );
    const tools = captured.args?.tools as Record<string, unknown> | undefined;
    expect(tools?.tool_a).toBeDefined();
    expect(tools?.finish).toBeDefined();
    expect(mockDispose).toHaveBeenCalled();
  });

  it("connects multiple MCP servers with prefixed tool names", async () => {
    mockDiscoverMCPServers.mockResolvedValue([
      {
        metadata: {
          id: "s1",
          name: "S1",
          source: "workspace",
          securityRating: "unverified",
          configTemplate: { transport: { type: "stdio", command: "s1" } },
        },
        mergedConfig: { transport: { type: "stdio", command: "s1" } },
        configured: true,
      },
      {
        metadata: {
          id: "s2",
          name: "S2",
          source: "workspace",
          securityRating: "unverified",
          configTemplate: { transport: { type: "stdio", command: "s2" } },
        },
        mergedConfig: { transport: { type: "stdio", command: "s2" } },
        configured: true,
      },
    ] satisfies MCPServerCandidate[]);
    const dispose1 = vi.fn();
    const dispose2 = vi.fn();
    mockCreateMCPTools
      .mockResolvedValueOnce({ tools: { tool_x: dummyTool }, dispose: dispose1 })
      .mockResolvedValueOnce({ tools: { tool_y: dummyTool }, dispose: dispose2 });

    const captured: CapturedStreamTextArgs = { args: undefined };
    setupMockStreamText(captured, {
      steps: [{ finish: { ok: true, answer: "done" } }],
      finalText: "",
    });

    const { delegateTool } = makeDelegate(undefined, undefined, undefined, undefined, {
      workspaceConfig: {} as unknown as WorkspaceConfig,
    });
    const result = await runDelegate(delegateTool, "del-call-1", { mcpServers: ["s1", "s2"] });

    expect(result.ok).toBe(true);
    expect(mockCreateMCPTools).toHaveBeenCalledTimes(2);
    expect(mockCreateMCPTools).toHaveBeenNthCalledWith(
      1,
      { s1: { transport: { type: "stdio", command: "s1" } } },
      expect.any(Object),
      { signal: undefined, toolPrefix: "s1", scrubResult: expect.any(Function) },
    );
    expect(mockCreateMCPTools).toHaveBeenNthCalledWith(
      2,
      { s2: { transport: { type: "stdio", command: "s2" } } },
      expect.any(Object),
      { signal: undefined, toolPrefix: "s2", scrubResult: expect.any(Function) },
    );

    const tools = captured.args?.tools as Record<string, unknown> | undefined;
    expect(tools?.tool_x).toBeDefined();
    expect(tools?.tool_y).toBeDefined();
    expect(dispose1).toHaveBeenCalled();
    expect(dispose2).toHaveBeenCalled();
  });

  it("proceeds when at least one MCP server connects", async () => {
    mockDiscoverMCPServers.mockResolvedValue([
      {
        metadata: {
          id: "good",
          name: "Good",
          source: "workspace",
          securityRating: "unverified",
          configTemplate: { transport: { type: "stdio", command: "good" } },
        },
        mergedConfig: { transport: { type: "stdio", command: "good" } },
        configured: true,
      },
      {
        metadata: {
          id: "bad",
          name: "Bad",
          source: "workspace",
          securityRating: "unverified",
          configTemplate: { transport: { type: "stdio", command: "bad" } },
        },
        mergedConfig: { transport: { type: "stdio", command: "bad" } },
        configured: true,
      },
    ] satisfies MCPServerCandidate[]);
    const disposeGood = vi.fn();
    mockCreateMCPTools
      .mockResolvedValueOnce({ tools: { tool_good: dummyTool }, dispose: disposeGood })
      .mockRejectedValueOnce(new Error("Connection refused"));

    const captured: CapturedStreamTextArgs = { args: undefined };
    setupMockStreamText(captured, {
      steps: [{ finish: { ok: true, answer: "done" } }],
      finalText: "",
    });

    const { delegateTool, logger } = makeDelegate(undefined, undefined, undefined, undefined, {
      workspaceConfig: {} as unknown as WorkspaceConfig,
    });
    const result = await runDelegate(delegateTool, "del-call-1", { mcpServers: ["good", "bad"] });

    expect(result.ok).toBe(true);
    expect(result.serverFailures).toEqual([{ serverId: "bad", reason: "Connection refused" }]);
    expect(mockCreateMCPTools).toHaveBeenCalledTimes(2);
    const tools = captured.args?.tools as Record<string, unknown> | undefined;
    expect(tools?.tool_good).toBeDefined();
    expect(tools?.bad_tool_good).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "MCP server connection failed in delegate",
      expect.objectContaining({ serverId: "bad" }),
    );
    expect(disposeGood).toHaveBeenCalled();
  });

  it("returns ok=false when all MCP servers fail to connect", async () => {
    mockDiscoverMCPServers.mockResolvedValue([
      {
        metadata: {
          id: "a",
          name: "A",
          source: "workspace",
          securityRating: "unverified",
          configTemplate: { transport: { type: "stdio", command: "a" } },
        },
        mergedConfig: { transport: { type: "stdio", command: "a" } },
        configured: true,
      },
      {
        metadata: {
          id: "b",
          name: "B",
          source: "workspace",
          securityRating: "unverified",
          configTemplate: { transport: { type: "stdio", command: "b" } },
        },
        mergedConfig: { transport: { type: "stdio", command: "b" } },
        configured: true,
      },
    ] satisfies MCPServerCandidate[]);
    mockCreateMCPTools.mockRejectedValue(new Error("boom"));

    const { delegateTool } = makeDelegate(undefined, undefined, undefined, undefined, {
      workspaceConfig: {} as unknown as WorkspaceConfig,
    });
    const result = await runDelegate(delegateTool, "del-call-1", { mcpServers: ["a", "b"] });

    expect(result).toEqual({
      ok: false,
      reason: "All requested MCP servers failed to connect.",
      toolsUsed: [],
      serverFailures: [
        { serverId: "a", reason: "boom" },
        { serverId: "b", reason: "boom" },
      ],
    });
  });

  it("disposes MCP connections in finally even when child stream throws", async () => {
    mockDiscoverMCPServers.mockResolvedValue([
      {
        metadata: {
          id: "mcp",
          name: "MCP",
          source: "workspace",
          securityRating: "unverified",
          configTemplate: { transport: { type: "stdio", command: "mcp" } },
        },
        mergedConfig: { transport: { type: "stdio", command: "mcp" } },
        configured: true,
      },
    ] satisfies MCPServerCandidate[]);
    const mockDispose = vi.fn();
    mockCreateMCPTools.mockResolvedValue({ tools: { mcp_tool: dummyTool }, dispose: mockDispose });

    const captured: CapturedStreamTextArgs = { args: undefined };
    setupMockStreamText(captured, {
      steps: [{ toolCalls: [{ toolCallId: "c1", toolName: "web_search" }] }],
      finalText: "",
      throwOnText: new Error("boom"),
    });

    const { delegateTool } = makeDelegate(undefined, undefined, undefined, undefined, {
      workspaceConfig: {} as unknown as WorkspaceConfig,
    });
    const result = await runDelegate(delegateTool, "del-call-1", { mcpServers: ["mcp"] });

    expect(result.ok).toBe(false);
    expect(mockDispose).toHaveBeenCalled();
  });
});

// ─── Local helpers (after the test for readability) ─────────────────────────

/**
 * Returns `true` if the envelope is a `data-delegate-chunk` whose inner chunk
 * is the synthetic `delegate-end` terminator with no payload. Returns `false`
 * for any other chunk shape (text deltas, regular tool chunks, ledger, or a
 * terminator that carries a legacy `pendingToolCallIds` payload).
 */
function isDelegateEndTerminator(envelope: AtlasUIMessageChunk): boolean {
  if (typeof envelope !== "object" || envelope === null) return false;
  if (!("type" in envelope) || envelope.type !== "data-delegate-chunk") return false;
  const data = (envelope as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return false;
  const inner = (data as { chunk?: unknown }).chunk;
  if (typeof inner !== "object" || inner === null) return false;
  if (!("type" in inner) || inner.type !== "delegate-end") return false;
  return !("pendingToolCallIds" in inner);
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

interface LedgerData {
  delegateToolCallId: string;
  toolsUsed: Array<{
    toolCallId: string;
    name: string;
    input: unknown;
    outcome: "success" | "error";
    summary?: string;
    stepIndex: number;
    durationMs: number;
  }>;
}

function extractLedgerData(chunk: AtlasUIMessageChunk): LedgerData | undefined {
  if (typeof chunk !== "object" || chunk === null) return undefined;
  if (!("type" in chunk) || chunk.type !== "data-delegate-ledger") return undefined;
  if (!("data" in chunk)) return undefined;
  const data = chunk.data;
  if (typeof data !== "object" || data === null) return undefined;
  if (!("delegateToolCallId" in data) || typeof data.delegateToolCallId !== "string") {
    return undefined;
  }
  if (!("toolsUsed" in data) || !Array.isArray(data.toolsUsed)) return undefined;
  return { delegateToolCallId: data.delegateToolCallId, toolsUsed: data.toolsUsed };
}

/**
 * Mimics the per-delegate accumulator the playground reducer (Task 3) will
 * run on forwarded `data-delegate-chunk` envelopes. Returns one entry per
 * unique inner toolCallId carrying `{toolCallId, name, outcome, stepIndex}`
 * — the subset the ledger and the reducer must agree on.
 */
function reconstructFromEnvelopes(
  envelopes: AtlasUIMessageChunk[],
): Array<{ toolCallId: string; name: string; outcome: "success" | "error"; stepIndex: number }> {
  const calls = new Map<
    string,
    { toolCallId: string; name: string; outcome: "success" | "error"; stepIndex: number }
  >();
  let nextStepIndex = 0;
  for (const envelope of envelopes) {
    if (typeof envelope !== "object" || envelope === null) continue;
    if (!("type" in envelope) || envelope.type !== "data-delegate-chunk") continue;
    const data = (envelope as { data?: unknown }).data;
    if (typeof data !== "object" || data === null) continue;
    const inner = (data as { chunk?: unknown }).chunk;
    if (typeof inner !== "object" || inner === null) continue;
    if (!("type" in inner) || !("toolCallId" in inner)) continue;
    const innerType = inner.type;
    const namespacedId = inner.toolCallId;
    if (typeof innerType !== "string" || typeof namespacedId !== "string") continue;
    // Strip the `${delegateToolCallId}-` prefix to get back to the original
    // child toolCallId for direct comparison with the ledger.
    const delegateId = (data as { delegateToolCallId?: unknown }).delegateToolCallId;
    const prefix = typeof delegateId === "string" ? `${delegateId}-` : null;
    const childId =
      prefix && namespacedId.startsWith(prefix) ? namespacedId.slice(prefix.length) : namespacedId;
    if (innerType === "tool-input-available") {
      const toolName =
        "toolName" in inner && typeof inner.toolName === "string" ? inner.toolName : "";
      if (toolName === "finish") continue;
      if (!calls.has(childId)) {
        calls.set(childId, {
          toolCallId: childId,
          name: toolName,
          outcome: "success",
          stepIndex: nextStepIndex++,
        });
      }
    } else if (innerType === "tool-output-error") {
      const entry = calls.get(childId);
      if (entry) entry.outcome = "error";
    }
  }
  return [...calls.values()];
}
