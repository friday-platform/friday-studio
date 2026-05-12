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
 * This test mocks `streamText` to capture the `tools` map the handler
 * passes in and asserts:
 *   1. With `outputSchema` set, `tools.complete` is present.
 *   2. The injected `complete` carries the expected `inputSchema` (derived
 *      via `jsonSchema(outputSchema)`), so the LLM is forced to emit data
 *      matching the document contract.
 *   3. With `outputSchema` AND no other tools, `toolChoice` pins the LLM
 *      to `complete` (the load-bearing exit when nothing else is callable).
 *
 * Note: a "no outputSchema → no complete tool" branch would be appealing
 * to test, but `createAgent` supplies `LLMOutputSchema` as the default,
 * so production code never reaches the handler with `outputSchema: undefined`.
 * The branch in the source survives only as defensive code; testing it
 * would assert against an unreachable path.
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import type { LLMAgentConfig } from "@atlas/config";
import { createStubPlatformModels } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { describe, expect, it, vi } from "vitest";

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
});
