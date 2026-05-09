/**
 * K2 (pt3): the judge agent now routes through the delegate primitive
 * instead of calling `generateObject` directly. These tests cover the
 * three things K2 buys us over the B7 shortcut:
 *
 * 1. Phase 8 budgets are enforced — a tight `max_input_tokens` cap on
 *    the judge's `ctx.config.budget` causes the delegate's input-token
 *    watchdog to fire and the agent surfaces the structured failure to
 *    its caller.
 * 2. `artifacts_get` (and any other tool the runner injects via
 *    `ctx.tools`) is forwarded into the child's tool catalog so the
 *    judge can selectively pull lifted bytes.
 * 3. The structured-output contract is preserved — the child emits the
 *    validation-verdict JSON via the synthetic `finish` tool's `answer`
 *    string, and the agent parses it into a `ValidationVerdict` shape
 *    byte-for-byte identical to what the pre-K2 `generateObject` path
 *    produced.
 */

import type { AgentContext, AtlasUIMessageChunk, Logger } from "@atlas/agent-sdk";
import type { ValidationVerdict } from "@atlas/hallucination";
import { createStubPlatformModels } from "@atlas/llm";
import { tool } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Hoist the `streamText` mock so it's installed before the delegate
// primitive imports `ai`. Same hoist pattern as
// packages/core/src/delegate/budget.test.ts.
const mockStreamText = vi.hoisted(() => vi.fn());
const mockStepCountIs = vi.hoisted(() => vi.fn((n: number) => ({ __stepCountIs: n })));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, streamText: mockStreamText, stepCountIs: mockStepCountIs };
});

// Block the delegate's MCP discovery path — the judge never asks for
// MCP servers but the imports resolve at module load.
vi.mock("@atlas/core/mcp-registry/discovery", () => ({ discoverMCPServers: vi.fn() }));
vi.mock("@atlas/mcp", () => ({ createMCPTools: vi.fn() }));

import { type JudgeInput, judgeAgent } from "./judge-agent.ts";

function makeLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => makeLogger()),
  } satisfies Record<keyof Logger, unknown>;
}

const dummyArtifactsGet = tool({
  description: "Fetch artifact bytes by id.",
  inputSchema: z.object({ artifactId: z.string() }),
  execute: () => Promise.resolve({ ok: true }),
});

interface CapturedStreamTextArgs {
  args: Parameters<typeof mockStreamText>[0] | undefined;
}

/**
 * Drive the mocked streamText through canned per-step input tokens and
 * resolve `result.text` with `finalText`. Mirrors the helper in
 * delegate/budget.test.ts so test scaffolding stays comparable across
 * the two layers under test.
 */
function setupMockStreamText(
  captured: CapturedStreamTextArgs,
  options: { perStepInputTokens?: number[]; finalText?: string; rejectTextOnAbort?: boolean } = {},
): void {
  mockStreamText.mockImplementation((args: Parameters<typeof mockStreamText>[0]) => {
    captured.args = args;

    const stream = new ReadableStream<AtlasUIMessageChunk>({
      start(controller) {
        controller.close();
      },
    });

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

interface BuildContextOpts {
  config?: Record<string, unknown>;
  tools?: AgentContext["tools"];
  stream?: AgentContext["stream"];
}

function buildContext(opts: BuildContextOpts = {}): AgentContext {
  return {
    tools: opts.tools ?? {},
    session: { sessionId: "test-session", workspaceId: "test-workspace" },
    env: {},
    ...(opts.config ? { config: opts.config } : {}),
    stream: opts.stream,
    logger: makeLogger(),
    platformModels: createStubPlatformModels(),
  };
}

const sampleInput: JudgeInput = {
  actionInput: "Summarize the user's recent emails.",
  actionOutput: "You have 3 unread emails from Acme.",
  toolCalls: [
    {
      toolName: "gmail_list",
      args: { folder: "inbox" },
      resultInline: '[{"from":"acme","subject":"Q1 numbers"}]',
    },
  ],
};

describe("judgeAgent — delegate-routed (K2)", () => {
  beforeEach(() => {
    mockStreamText.mockReset();
    mockStepCountIs.mockClear();
  });

  describe("structured-output contract preservation", () => {
    it("parses a verdict-shaped finish answer into the ValidationVerdict shape", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      const verdict: ValidationVerdict = {
        verdict: "advisory",
        issues: [{ claim: "unsourced count of 3", category: "sourcing" }],
      };
      setupMockStreamText(captured, { finalText: JSON.stringify(verdict) });
      // The delegate also walks `result.steps` for a `finish` tool-result
      // to populate the answer; our mock returns an empty steps array, so
      // we lean on the `finalText` fallback path. That path lives in the
      // delegate primitive and exercises the same DelegateResult.answer
      // surface.

      const result = await judgeAgent.execute(sampleInput, buildContext());

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.verdict).toBe("advisory");
      expect(result.data.issues).toHaveLength(1);
      expect(result.data.issues?.[0]?.claim).toBe("unsourced count of 3");
    });

    it("strips Markdown fences the LLM may wrap the verdict JSON in", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      setupMockStreamText(captured, {
        finalText: "```json\n" + JSON.stringify({ verdict: "pass" }) + "\n```",
      });

      const result = await judgeAgent.execute(sampleInput, buildContext());

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.verdict).toBe("pass");
    });

    it("returns err when the finish answer cannot be parsed as a validation-verdict", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      setupMockStreamText(captured, { finalText: "this is not json" });

      const result = await judgeAgent.execute(sampleInput, buildContext());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toContain("did not parse");
    });
  });

  describe("Phase 8 budget enforcement", () => {
    it("returns the structured budget_exhausted reason when max_input_tokens trips", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      // Two steps: 600 + 500 = 1100 cumulative > 1000 cap. After the
      // second step the delegate's watchdog flips the internal abort
      // signal; `result.text` then rejects, but the delegate translates
      // that into `budget_exhausted: max_input_tokens` ahead of any
      // generic abort/text-error path.
      setupMockStreamText(captured, { perStepInputTokens: [600, 500], rejectTextOnAbort: true });

      const result = await judgeAgent.execute(
        sampleInput,
        buildContext({ config: { budget: { max_input_tokens: 1000 } } }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe("budget_exhausted: max_input_tokens");
      // Sanity-check the delegate's composed signal saw the abort.
      expect((captured.args?.abortSignal as AbortSignal).aborted).toBe(true);
    });

    it("forwards max_steps_per_call into the child stepCountIs config", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      setupMockStreamText(captured, { finalText: JSON.stringify({ verdict: "pass" }) });

      await judgeAgent.execute(
        sampleInput,
        buildContext({ config: { budget: { max_steps_per_call: 3 } } }),
      );

      expect(mockStepCountIs).toHaveBeenCalledWith(3);
    });

    it("falls through to the delegate primitive's defaults when no budget is configured", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      setupMockStreamText(captured, { finalText: JSON.stringify({ verdict: "pass" }) });

      await judgeAgent.execute(sampleInput, buildContext());

      // Default = DEFAULT_MAX_STEPS_PER_CALL (40). Asserting via the
      // delegate's call into stepCountIs keeps the test framed at the
      // judge → delegate boundary without re-importing the constant.
      expect(mockStepCountIs).toHaveBeenCalledWith(40);
    });
  });

  describe("tool catalog forwarding", () => {
    it("includes artifacts_get from ctx.tools in the child's tool catalog", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      setupMockStreamText(captured, { finalText: JSON.stringify({ verdict: "pass" }) });

      await judgeAgent.execute(
        sampleInput,
        buildContext({ tools: { artifacts_get: dummyArtifactsGet } }),
      );

      const childTools = captured.args?.tools as Record<string, unknown> | undefined;
      expect(childTools).toBeDefined();
      // The delegate adds `finish` synthetically; `artifacts_get` arrives
      // via ctx.tools forwarded by the judge agent.
      expect("artifacts_get" in (childTools ?? {})).toBe(true);
      expect("finish" in (childTools ?? {})).toBe(true);
    });

    it("strips delegate from the child catalog even if accidentally injected", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      setupMockStreamText(captured, { finalText: JSON.stringify({ verdict: "pass" }) });

      const dummyDelegate = tool({
        description: "should be stripped",
        inputSchema: z.object({}),
        execute: () => Promise.resolve({ ok: true }),
      });
      await judgeAgent.execute(
        sampleInput,
        buildContext({ tools: { artifacts_get: dummyArtifactsGet, delegate: dummyDelegate } }),
      );

      const childTools = captured.args?.tools as Record<string, unknown> | undefined;
      // Delegate primitive's depth=0 + max_depth=1 default means the
      // child cannot re-delegate; the parent's delegate tool is stripped
      // before the child sees it.
      expect("delegate" in (childTools ?? {})).toBe(false);
      expect("artifacts_get" in (childTools ?? {})).toBe(true);
    });
  });

  describe("Phase 11 provenance", () => {
    it("emits delegate envelopes through the agent's StreamEmitter when present", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      setupMockStreamText(captured, { finalText: JSON.stringify({ verdict: "pass" }) });

      const emitted: AtlasUIMessageChunk[] = [];
      const stream: AgentContext["stream"] = {
        emit: (chunk) => emitted.push(chunk),
        end: () => {},
        error: () => {},
      };

      await judgeAgent.execute(sampleInput, buildContext({ stream }));

      // The delegate's `finally` always emits one `data-delegate-chunk`
      // (the synthetic `delegate-end` terminator) and one
      // `data-delegate-ledger`. Both ride the StreamEmitter we passed
      // in — that's what makes the judge invocation surface in
      // agentBlocks downstream.
      const types = emitted.map((c) => (typeof c === "object" && c && "type" in c ? c.type : ""));
      expect(types).toContain("data-delegate-chunk");
      expect(types).toContain("data-delegate-ledger");
    });

    it("no-ops cleanly when ctx.stream is undefined (detached judge runner path)", async () => {
      const captured: CapturedStreamTextArgs = { args: undefined };
      setupMockStreamText(captured, { finalText: JSON.stringify({ verdict: "pass" }) });

      const result = await judgeAgent.execute(sampleInput, buildContext());

      expect(result.ok).toBe(true);
    });
  });
});
