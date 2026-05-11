/**
 * Phase 8 — runtime enforcement of delegation budgets.
 *
 * Asserts each budget exhaustion path returns the structured failure
 * `{ ok: false, reason: "budget_exhausted: <which>" }` so the parent LLM
 * can route around it. Where the AI SDK's `streamText` is involved, we
 * mock it to drive deterministic behavior:
 *
 *   - max_depth: fails synchronously at execute time when `deps.depth`
 *     already meets `budget.max_depth`. No streamText involvement.
 *   - max_wall_time_ms: the delegate composes parent-abort + wall-clock
 *     timeout into a single signal; we observe it firing via the captured
 *     `args.abortSignal` and `wallTimeSignal.aborted` translating into
 *     the budget reason.
 *   - max_input_tokens: the delegate's `onStepFinish` callback sums
 *     `usage.inputTokens`; we invoke it from the mock with values that
 *     trip the cap and assert the internal abort fires + the result
 *     surfaces the budget reason.
 *   - max_steps_per_call / max_output_tokens: pass-through to streamText —
 *     we assert the captured args reflect the configured values.
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

vi.mock("../mcp-registry/discovery.ts", () => ({ discoverMCPServers: vi.fn() }));
vi.mock("@atlas/mcp", () => ({ createMCPTools: vi.fn(), createMCPToolsWithRetry: vi.fn() }));

import { createDelegateTool, type DelegateResult } from "./index.ts";

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

interface MockWriter extends UIMessageStreamWriter<AtlasUIMessage> {
  writes: Array<{ chunk: AtlasUIMessageChunk }>;
}

function makeWriter(): MockWriter {
  const writes: Array<{ chunk: AtlasUIMessageChunk }> = [];
  return {
    writes,
    write(chunk) {
      writes.push({ chunk });
    },
    merge() {},
    onError: undefined,
  };
}

const dummyTool = tool({
  description: "dummy",
  inputSchema: z.object({}),
  execute: () => Promise.resolve({ ok: true }),
});

interface CapturedStreamTextArgs {
  args: Parameters<typeof mockStreamText>[0] | undefined;
}

/**
 * Drive a single fake step with the given input-token usage. The
 * delegate's `onStepFinish` callback receives `{ usage: { inputTokens } }`
 * after each step in real runs — here we expose a hook so tests can fire
 * arbitrary token tallies during the streamText call.
 */
function setupMockStreamTextForBudget(
  captured: CapturedStreamTextArgs,
  options: {
    perStepInputTokens?: number[];
    finalText?: string;
    /** Whether `result.text` rejects after the abort fires. */
    rejectTextOnAbort?: boolean;
  } = {},
): void {
  mockStreamText.mockImplementation((args: Parameters<typeof mockStreamText>[0]) => {
    captured.args = args;

    const stream = new ReadableStream<AtlasUIMessageChunk>({
      start(controller) {
        controller.close();
      },
    });

    // Drive `onStepFinish` synchronously so the delegate's input-token
    // watchdog can observe each tally before we resolve `text` / `steps`.
    // The real AI SDK calls this between steps; here we fire all steps
    // up front to keep the test deterministic.
    const stepsPromise = (async () => {
      for (const inputTokens of options.perStepInputTokens ?? []) {
        await args.onStepFinish?.({ usage: { inputTokens } });
      }
      return [];
    })();

    return {
      steps: stepsPromise,
      text: stepsPromise.then(() => {
        if (options.rejectTextOnAbort && args.abortSignal?.aborted) {
          throw new Error("aborted");
        }
        return options.finalText ?? "";
      }),
      toUIMessageStream: () => stream,
    };
  });
}

function makeDelegate(
  budget?: import("@atlas/config").DelegationBudget,
  depth = 0,
  abortSignal?: AbortSignal,
) {
  const writer = makeWriter();
  const tools: AtlasTools = { web_search: dummyTool };
  const delegateTool = createDelegateTool(
    {
      writer,
      session: { sessionId: "s1", workspaceId: "w1", streamId: "st1" },
      platformModels: createStubPlatformModels(),
      logger: makeLogger(),
      abortSignal,
      repairToolCall,
      budget,
      depth,
    },
    () => tools,
  );
  return { delegateTool, writer };
}

async function runDelegate(
  delegateTool: ReturnType<typeof createDelegateTool>,
): Promise<DelegateResult> {
  const execute = delegateTool.execute;
  if (!execute) throw new Error("delegate has no execute");
  const result = (await execute(
    { goal: "do work", handoff: "context" },
    { toolCallId: "del-1", messages: [], abortSignal: undefined as unknown as AbortSignal },
  )) as DelegateResult;
  return result;
}

describe("delegate budget enforcement", () => {
  beforeEach(() => {
    mockStreamText.mockReset();
    mockStepCountIs.mockClear();
  });

  describe("max_depth", () => {
    it("returns budget_exhausted: max_depth without spawning streamText when depth >= max_depth", async () => {
      const { delegateTool } = makeDelegate({ max_depth: 1 }, 1);
      const result = await runDelegate(delegateTool);

      expect(result).toEqual({ ok: false, reason: "budget_exhausted: max_depth", toolsUsed: [] });
      expect(mockStreamText).not.toHaveBeenCalled();
    });

    it("runs the child when depth < max_depth", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      setupMockStreamTextForBudget(captured, { finalText: "ok" });

      const { delegateTool } = makeDelegate({ max_depth: 2 }, 1);
      const result = await runDelegate(delegateTool);

      expect(result.ok).toBe(true);
    });

    it("strips delegate from the child tool set when child's depth+1 hits max_depth", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      setupMockStreamTextForBudget(captured, { finalText: "ok" });

      // Inherited tool set includes delegate; assert it was stripped.
      const writer = makeWriter();
      const inheritedTools: AtlasTools = { web_search: dummyTool, delegate: dummyTool };
      const delegateTool = createDelegateTool(
        {
          writer,
          session: { sessionId: "s1", workspaceId: "w1", streamId: "st1" },
          platformModels: createStubPlatformModels(),
          logger: makeLogger(),
          repairToolCall,
          budget: { max_depth: 1 },
          depth: 0,
        },
        () => inheritedTools,
      );
      await runDelegate(delegateTool);

      const childTools = captured.args?.tools as Record<string, unknown> | undefined;
      expect(childTools).toBeDefined();
      expect("delegate" in (childTools ?? {})).toBe(false);
      // finish + web_search remain.
      expect("finish" in (childTools ?? {})).toBe(true);
      expect("web_search" in (childTools ?? {})).toBe(true);
    });

    it("keeps delegate in the child tool set when depth+1 < max_depth", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      setupMockStreamTextForBudget(captured, { finalText: "ok" });

      const writer = makeWriter();
      const inheritedTools: AtlasTools = { web_search: dummyTool, delegate: dummyTool };
      const delegateTool = createDelegateTool(
        {
          writer,
          session: { sessionId: "s1", workspaceId: "w1", streamId: "st1" },
          platformModels: createStubPlatformModels(),
          logger: makeLogger(),
          repairToolCall,
          budget: { max_depth: 3 },
          depth: 0,
        },
        () => inheritedTools,
      );
      await runDelegate(delegateTool);

      const childTools = captured.args?.tools as Record<string, unknown> | undefined;
      expect(childTools).toBeDefined();
      expect("delegate" in (childTools ?? {})).toBe(true);
    });
  });

  describe("max_steps_per_call (pass-through to streamText)", () => {
    it("forwards the configured step budget into stepCountIs", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      setupMockStreamTextForBudget(captured, { finalText: "ok" });

      const { delegateTool } = makeDelegate({ max_steps_per_call: 7 });
      await runDelegate(delegateTool);

      expect(mockStepCountIs).toHaveBeenCalledWith(7);
    });

    it("falls back to the historical default of 40 when unset", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      setupMockStreamTextForBudget(captured, { finalText: "ok" });

      const { delegateTool } = makeDelegate(); // no budget at all
      await runDelegate(delegateTool);

      expect(mockStepCountIs).toHaveBeenCalledWith(40);
    });
  });

  describe("max_output_tokens (pass-through to streamText)", () => {
    it("forwards the configured value", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      setupMockStreamTextForBudget(captured, { finalText: "ok" });

      const { delegateTool } = makeDelegate({ max_output_tokens: 1234 });
      await runDelegate(delegateTool);

      expect(captured.args?.maxOutputTokens).toBe(1234);
    });

    it("falls back to the historical default of 20000", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      setupMockStreamTextForBudget(captured, { finalText: "ok" });

      const { delegateTool } = makeDelegate();
      await runDelegate(delegateTool);

      expect(captured.args?.maxOutputTokens).toBe(20000);
    });
  });

  describe("max_input_tokens", () => {
    it("aborts and returns budget_exhausted: max_input_tokens when cumulative input tokens exceed the cap", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      // Two steps: 600 then 500 = 1100 cumulative, which exceeds 1000.
      // The watchdog flips the internal abort after the second step;
      // `result.text` then rejects (as it would on a real abort).
      setupMockStreamTextForBudget(captured, {
        perStepInputTokens: [600, 500],
        finalText: "should-not-arrive",
        rejectTextOnAbort: true,
      });

      const { delegateTool } = makeDelegate({ max_input_tokens: 1000 });
      const result = await runDelegate(delegateTool);

      expect(result).toEqual({
        ok: false,
        reason: "budget_exhausted: max_input_tokens",
        toolsUsed: [],
      });
      // The composed signal handed to streamText is aborted by the watchdog.
      expect((captured.args?.abortSignal as AbortSignal).aborted).toBe(true);
    });

    it("does not fire when cumulative input tokens stay below the cap", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      setupMockStreamTextForBudget(captured, { perStepInputTokens: [100, 200], finalText: "ok" });

      const { delegateTool } = makeDelegate({ max_input_tokens: 1000 });
      const result = await runDelegate(delegateTool);

      expect(result.ok).toBe(true);
    });
  });

  describe("max_wall_time_ms", () => {
    it("returns budget_exhausted: max_wall_time_ms when the wall-clock signal fires", async () => {
      // We can't easily race a 1ms timer against the synchronous mock
      // streamText, so we drive the wall-clock branch by aborting the
      // composed signal via the `AbortSignal.timeout` it creates. The
      // delegate's `finally` checks `wallTimeSignal.aborted`; it's true
      // after `await new Promise(r => setTimeout(r, ...))`.
      const captured: CapturedStreamTextArgs = { args: undefined };
      // The original gap (5ms timeout vs 25ms work) flaked on busy CI
      // runners with GC pauses. Using `vi.useFakeTimers` against
      // `AbortSignal.timeout` is unreliable across Node versions, so we
      // widen the gap instead — 50ms timeout vs 250ms work gives enough
      // slack that any reasonable runner reliably aborts before the work
      // completes. The branch under test is "wall-clock fires" — gap
      // size is irrelevant to the assertion, only that the timeout
      // settles before the steps resolve.
      mockStreamText.mockImplementation((args: Parameters<typeof mockStreamText>[0]) => {
        captured.args = args;
        const stepsPromise = new Promise<unknown[]>((resolve) => {
          setTimeout(() => resolve([]), 250);
        });
        return {
          steps: stepsPromise,
          text: stepsPromise.then(() => {
            if (args.abortSignal?.aborted) throw new Error("aborted");
            return "";
          }),
          toUIMessageStream: () =>
            new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
        };
      });

      const { delegateTool } = makeDelegate({ max_wall_time_ms: 50 });
      const result = await runDelegate(delegateTool);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.reason).toBe("budget_exhausted: max_wall_time_ms");
    });

    it("does not fire when the call completes in time", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      setupMockStreamTextForBudget(captured, { finalText: "fast" });

      const { delegateTool } = makeDelegate({ max_wall_time_ms: 60_000 });
      const result = await runDelegate(delegateTool);

      expect(result.ok).toBe(true);
    });
  });

  describe("budget exhaustion takes precedence over caller abort", () => {
    it("input-token exhaustion is reported as budget_exhausted, not generic abort", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      setupMockStreamTextForBudget(captured, {
        perStepInputTokens: [2000],
        finalText: "should-not-arrive",
        rejectTextOnAbort: true,
      });

      const ac = new AbortController();
      const { delegateTool } = makeDelegate({ max_input_tokens: 500 }, 0, ac.signal);
      const result = await runDelegate(delegateTool);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.reason).toBe("budget_exhausted: max_input_tokens");
    });
  });

  describe("default budgets when no `budget` is provided", () => {
    it("uses the back-compat defaults (depth=1, steps=40, output=20000, time=Infinity, input=Infinity)", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      setupMockStreamTextForBudget(captured, {
        perStepInputTokens: [1_000_000_000],
        finalText: "ok",
      });

      const { delegateTool } = makeDelegate();
      const result = await runDelegate(delegateTool);

      expect(result.ok).toBe(true);
      expect(mockStepCountIs).toHaveBeenCalledWith(40);
      expect(captured.args?.maxOutputTokens).toBe(20000);
      // No wall-clock signal was added (single internal-abort signal only)
      // — captured signal is not aborted because nothing fired.
      expect((captured.args?.abortSignal as AbortSignal).aborted).toBe(false);
    });
  });
});
