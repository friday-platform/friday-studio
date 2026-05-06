/**
 * Runtime gating tests for B2 of melodic-strolling-seal-pt2.
 *
 * Verifies that the resolved `validate:` decision controls whether the
 * external `validateOutput` hook is invoked:
 *   - `external`            → validator runs (today's path).
 *   - `self`                → validator skipped (no-op until B3).
 *   - `skip`                → validator skipped.
 *   - omitted / `"auto"`    → classifier picks `skip` or `self`. Either way
 *                             the external validator is NOT called, since the
 *                             classifier never auto-resolves to `external`.
 *
 * Tests use a mock `validateOutput` that records call count + the LLM provider
 * harness from `llm-validation.test.ts` style.
 */

import type { AgentResult, ToolCall } from "@atlas/agent-sdk";
import type { ValidationVerdict } from "@atlas/hallucination";
import { describe, expect, it } from "vitest";
import { getDocumentStore } from "../../document-store/mod.ts";
import { FSMEngine } from "../fsm-engine.ts";
import type {
  Action,
  FSMDefinition,
  FSMLLMOutput,
  LLMProvider,
  OutputValidator,
  ValidateStrategy,
} from "../types.ts";

function passVerdict(): ValidationVerdict {
  return { status: "pass", confidence: 0.9, threshold: 0.45, issues: [], retryGuidance: "" };
}

interface MockResponse {
  content: string;
  data?: Record<string, unknown>;
  toolCalls?: ToolCall[];
}

function envelope(
  mock: MockResponse,
  agentId: string,
  prompt: string,
): AgentResult<string, FSMLLMOutput> {
  const data: FSMLLMOutput = { response: mock.content, ...mock.data };
  return {
    agentId,
    timestamp: new Date().toISOString(),
    input: prompt,
    ok: true,
    data,
    toolCalls: mock.toolCalls ?? [],
    durationMs: 0,
  };
}

/**
 * Build an FSM with a single LLM action whose `validate`, `tools`,
 * `outputType`, and `inputFrom` shape can be customized so we can exercise
 * both explicit decisions and the classifier-driven `auto` path.
 */
async function runSingleLLMAction(opts: {
  validate?: ValidateStrategy;
  tools?: string[];
  outputType?: string;
  llmResponse: MockResponse;
}): Promise<{ validatorCalls: number; llmCalls: number }> {
  const store = getDocumentStore();
  const uid = crypto.randomUUID();
  const scope = { workspaceId: `ws-${uid}`, sessionId: `sess-${uid}` };

  const action: Action = {
    type: "llm",
    provider: "test",
    model: "test-model",
    prompt: "do thing",
    outputTo: "output",
    ...(opts.tools !== undefined && { tools: opts.tools }),
    ...(opts.outputType !== undefined && { outputType: opts.outputType }),
    ...(opts.validate !== undefined && { validate: opts.validate }),
  };

  const fsm: FSMDefinition = {
    id: "validate-gating-test",
    initial: "pending",
    states: {
      pending: { on: { RUN: { target: "done", actions: [action] } } },
      done: { type: "final" },
    },
    ...(opts.outputType !== undefined && {
      documentTypes: { [opts.outputType]: { type: "object" } },
    }),
  };

  let llmCalls = 0;
  const provider: LLMProvider = {
    call: (params) => {
      llmCalls++;
      return Promise.resolve(envelope(opts.llmResponse, params.agentId, params.prompt));
    },
  };

  let validatorCalls = 0;
  const validator: OutputValidator = () => {
    validatorCalls++;
    return Promise.resolve({ verdict: passVerdict() });
  };

  const engine = new FSMEngine(fsm, {
    documentStore: store,
    scope,
    llmProvider: provider,
    validateOutput: validator,
  });
  await engine.initialize();
  await engine.signal({ type: "RUN" });

  expect(engine.state).toEqual("done");
  return { validatorCalls, llmCalls };
}

describe("LLM action validate-gating (B2)", () => {
  it("validate: 'external' → external validator IS called", async () => {
    const { validatorCalls, llmCalls } = await runSingleLLMAction({
      validate: "external",
      llmResponse: { content: "hello" },
    });
    expect(validatorCalls).toEqual(1);
    expect(llmCalls).toEqual(1);
  });

  it("validate: 'skip' → external validator is NOT called", async () => {
    const { validatorCalls, llmCalls } = await runSingleLLMAction({
      validate: "skip",
      llmResponse: { content: "hello" },
    });
    expect(validatorCalls).toEqual(0);
    expect(llmCalls).toEqual(1);
  });

  it("validate: 'self' → external validator is NOT called (no-op until B3)", async () => {
    const { validatorCalls } = await runSingleLLMAction({
      validate: "self",
      llmResponse: { content: "hello" },
    });
    expect(validatorCalls).toEqual(0);
  });

  it("validate omitted (auto) — read-only-fetcher shape → external NOT called (auto → skip)", async () => {
    // declared tools all read-only + outputType present ⇒ classifier returns "skip".
    const { validatorCalls } = await runSingleLLMAction({
      validate: undefined,
      tools: ["search_messages", "get_gmail_thread"],
      outputType: "FetcherOutput",
      llmResponse: { content: "fetched" },
    });
    expect(validatorCalls).toEqual(0);
  });

  it("validate omitted (auto) — mutating-tool shape → external NOT called (auto → self → no-op)", async () => {
    // a mutating tool in the declared list ⇒ classifier returns "self";
    // self is a no-op in B2 so the external validator still doesn't run.
    const { validatorCalls } = await runSingleLLMAction({
      validate: undefined,
      tools: ["send_email"],
      llmResponse: { content: "sent" },
    });
    expect(validatorCalls).toEqual(0);
  });

  it("validate: 'auto' (explicit) → routes through classifier the same as omitted", async () => {
    const { validatorCalls } = await runSingleLLMAction({
      validate: "auto",
      tools: ["send_email"],
      llmResponse: { content: "sent" },
    });
    expect(validatorCalls).toEqual(0);
  });

  it("validate: object { strategy: 'external' } → external validator IS called", async () => {
    const { validatorCalls } = await runSingleLLMAction({
      validate: { strategy: "external" },
      llmResponse: { content: "hello" },
    });
    expect(validatorCalls).toEqual(1);
  });

  it("validate: object { strategy: 'self' } → external validator is NOT called", async () => {
    const { validatorCalls } = await runSingleLLMAction({
      validate: { strategy: "self" },
      llmResponse: { content: "hello" },
    });
    expect(validatorCalls).toEqual(0);
  });
});
