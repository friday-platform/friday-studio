/**
 * Orchestrator-side `complete` injection regression test.
 *
 * `convertLLMToAgent` is the runtime path for FSM `case "agent"` actions
 * invoking a `type: llm` agent. When the action declares `outputTo`, the
 * runtime threads an `outputSchema` through `AgentContext`; the handler
 * must inject a `complete` tool with that schema as its `inputSchema` so
 * the LLM has a contracted exit. The `validation-removed` promptfoo eval
 * pins the source string `"complete: {"` — but a static substring check
 * cannot catch a regression where `hasRuntimeOutputSchema` flips falsey
 * unexpectedly, the spread is broken, or a future refactor moves the
 * injection site without keeping the literal.
 *
 * This test mocks `streamText` to capture the `tools` map and `toolChoice`
 * the handler passes in and asserts both branches of the
 * `hasRuntimeOutputSchema` ternary at `from-llm.ts:73-83`:
 *   1. With `outputSchema` set, `tools.complete` is present with the
 *      expected `inputSchema` (derived via `jsonSchema(outputSchema)`).
 *   2. With `outputSchema` AND no other tools, `toolChoice` pins the LLM
 *      to `complete` (the load-bearing exit when nothing else is callable).
 *   3. With `outputSchema` undefined, `tools.complete` is absent and
 *      `toolChoice` falls through to the configured default. The
 *      false-branch is reachable in production: Pattern A signals (no
 *      `outputTo`), `case "agent"` actions where `outputTo` is unset, and
 *      `type: agent` references whose resolved agent type is not `llm` all
 *      hit the handler with `context.outputSchema === undefined` (FSM
 *      omits the field unconditionally per `fsm-engine.ts:1812`).
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import type { LLMAgentConfig } from "@atlas/config";
import { createStubPlatformModels } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockStreamText = vi.hoisted(() => vi.fn());
const mockStepCountIs = vi.hoisted(() => vi.fn((n: number) => ({ __stepCountIs: n })));
const mockHasToolCall = vi.hoisted(() => vi.fn((name: string) => ({ __hasToolCall: name })));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: mockStreamText,
    stepCountIs: mockStepCountIs,
    hasToolCall: mockHasToolCall,
  };
});

import { convertLLMToAgent } from "./from-llm.ts";

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

function makeConfig(): LLMAgentConfig {
  return {
    type: "llm",
    description: "test agent",
    config: {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      prompt: "you are a test agent",
      temperature: 0,
    },
  };
}

function makeStreamTextResult() {
  // The handler awaits `result.text`, `result.reasoningText`,
  // `result.toolCalls`, `result.toolResults`, `result.steps`,
  // `result.usage` in parallel. Promise-resolve each so the `Promise.all`
  // settles and the handler proceeds to the post-call extraction. Returns
  // a minimal-but-valid shape so the handler's response-resolution path
  // (the `findCompleteToolArgs` extraction at the bottom) doesn't NPE.
  return {
    text: Promise.resolve("synthetic-final-text"),
    reasoningText: Promise.resolve(undefined),
    toolCalls: Promise.resolve([
      {
        toolCallId: "call_complete",
        toolName: "complete",
        input: { response: "synthetic-final-text" },
      },
    ]),
    toolResults: Promise.resolve([]),
    steps: Promise.resolve([]),
    usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
  };
}

function makeContext(opts: { tools?: AtlasTools; outputSchema?: Record<string, unknown> } = {}) {
  return {
    tools: opts.tools ?? ({} as AtlasTools),
    session: { sessionId: "sess-test", workspaceId: "ws-test", streamId: "stream-test" },
    env: {},
    config: undefined,
    outputSchema: opts.outputSchema,
    skills: [],
    stream: undefined,
    logger: makeLogger(),
    platformModels: createStubPlatformModels(),
  };
}

describe("convertLLMToAgent — orchestrator-side complete injection", () => {
  // `vi.hoisted()` mocks aren't reset by `vi.restoreAllMocks()` and the
  // global `clearMocks` flag isn't set — without this, `mock.calls[0]`
  // and `toHaveBeenCalledOnce()` would silently leak state across tests
  // and pass only because the suite runs in declaration order.
  beforeEach(() => {
    mockStreamText.mockReset();
    mockStepCountIs.mockClear();
    mockHasToolCall.mockClear();
  });

  it("injects a `complete` tool when outputSchema is set", async () => {
    mockStreamText.mockReturnValue(makeStreamTextResult());

    const agent = convertLLMToAgent(makeConfig(), "test-agent", makeLogger());
    const outputSchema = {
      type: "object",
      properties: { response: { type: "string" } },
      required: ["response"],
    };
    await agent.execute("synthetic prompt", makeContext({ outputSchema }));

    expect(mockStreamText).toHaveBeenCalledOnce();
    const callArgs = mockStreamText.mock.calls[0]?.[0] as {
      tools?: Record<string, { description?: string; inputSchema?: unknown }>;
      toolChoice?: unknown;
    };
    expect(callArgs.tools).toBeDefined();
    expect(callArgs.tools?.complete).toBeDefined();
    expect(callArgs.tools?.complete?.description).toMatch(/store the final output/);
    // `inputSchema` should be wrapped via `jsonSchema(outputSchema)`. The
    // helper stamps a `jsonSchema: true` marker on the value, so we just
    // assert it exists rather than deep-equal the schema (which would
    // couple to AI-SDK internals).
    expect(callArgs.tools?.complete?.inputSchema).toBeDefined();
  });

  it("pins toolChoice to `complete` when outputSchema is set and there are no other tools", async () => {
    mockStreamText.mockReturnValue(makeStreamTextResult());

    const agent = convertLLMToAgent(makeConfig(), "test-agent", makeLogger());
    await agent.execute(
      "prompt",
      makeContext({ tools: {} as AtlasTools, outputSchema: { type: "object", properties: {} } }),
    );

    const callArgs = mockStreamText.mock.calls[0]?.[0] as {
      toolChoice?: { type?: string; toolName?: string };
    };
    expect(callArgs.toolChoice).toEqual({ type: "tool", toolName: "complete" });
  });

  it("does NOT inject `complete` and falls through to the default toolChoice when outputSchema is omitted", async () => {
    // Omit `complete` from the synthetic toolCalls — handler's post-call
    // resolution looks for it via `findCompleteToolArgs`; without it the
    // handler falls back to `{ response: resolvedText }` rather than
    // throwing.
    mockStreamText.mockReturnValue({ ...makeStreamTextResult(), toolCalls: Promise.resolve([]) });

    const agent = convertLLMToAgent(makeConfig(), "test-agent", makeLogger());
    // No `outputSchema` in the context — this is what Pattern A FSM
    // signals and `case "agent"` actions without `outputTo` produce.
    await agent.execute("prompt", makeContext({ outputSchema: undefined }));

    const callArgs = mockStreamText.mock.calls[0]?.[0] as {
      tools?: Record<string, unknown>;
      toolChoice?: unknown;
    };
    expect(callArgs.tools?.complete).toBeUndefined();
    // `toolChoice` should fall through to `config.config.tool_choice ||
    // "auto"` per from-llm.ts:108-110. The fixture config doesn't set
    // tool_choice, so the default is `"auto"`.
    expect(callArgs.toolChoice).toBe("auto");
  });
});
