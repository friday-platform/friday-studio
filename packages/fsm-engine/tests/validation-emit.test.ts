/**
 * Phase B6 (melodic-strolling-seal-pt2). Validates that every `type: llm`
 * (and `case "agent" → type: llm`) action's session-event side-channel
 * carries a structured `validation` block — three resolved strategies →
 * three emit shapes:
 *
 *   skip     → { strategy: "skip", skipReason }
 *   self     → { strategy: "self", verdict?, issues? }   (record_validation)
 *   external → { strategy: "external", verdict?, issues? } (judge-derived)
 *
 * Tests inspect `FSMActionExecutionEvent.data.llmResult.validation` directly
 * rather than `step:complete` because the `step:complete` mapping lives in
 * `@atlas/core/session/event-emission-mapper.ts`. The shapes are identical;
 * the mapper test in core asserts the field rides through. End-to-end
 * coverage on the runtime → step:complete edge lives separately.
 */

import type { AgentResult, ToolCall } from "@atlas/agent-sdk";
import type { ValidationVerdict } from "@atlas/hallucination";
import { describe, expect, it } from "vitest";
import { getDocumentStore } from "../../document-store/mod.ts";
import { type AgentExecutorOptions, FSMEngine } from "../fsm-engine.ts";
import type {
  Action,
  FSMActionExecutionEvent,
  FSMDefinition,
  FSMEvent,
  FSMLLMOutput,
  LLMProvider,
  OutputValidator,
  ValidateStrategy,
} from "../types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

interface MockLLMResponse {
  content: string;
  toolCalls?: ToolCall[];
}

function envelope(
  mock: MockLLMResponse,
  agentId: string,
  prompt: string,
): AgentResult<string, FSMLLMOutput> {
  return {
    agentId,
    timestamp: new Date().toISOString(),
    input: prompt,
    ok: true,
    data: { response: mock.content },
    toolCalls: mock.toolCalls ?? [],
    durationMs: 0,
  };
}

function recordValidationCall(args: {
  verdict: "pass" | "advisory" | "blocking";
  issues?: Array<{ claim: string; category?: string }>;
}): ToolCall {
  return {
    type: "tool-call",
    toolCallId: `tc-rv-${crypto.randomUUID().slice(0, 6)}`,
    toolName: "record_validation",
    input: args,
  };
}

function passVerdict(): ValidationVerdict {
  return { verdict: "pass" };
}

function uncertainVerdict(): ValidationVerdict {
  return {
    verdict: "advisory",
    issues: [
      {
        category: "judge-uncertain",
        severity: "info",
        claim: "claim-x",
        reasoning: "could not verify",
        citation: null,
      },
    ],
  };
}

async function runLLMActionAndCaptureEvents(opts: {
  validate?: ValidateStrategy;
  tools?: string[];
  outputType?: string;
  llmResponse: MockLLMResponse;
  validator?: OutputValidator;
  expectThrow?: boolean;
}): Promise<{ events: FSMEvent[]; completionEvent?: FSMActionExecutionEvent }> {
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
    id: "validation-emit-test",
    initial: "pending",
    states: {
      pending: { on: { RUN: { target: "done", actions: [action] } } },
      done: { type: "final" },
    },
    ...(opts.outputType !== undefined && {
      documentTypes: { [opts.outputType]: { type: "object" } },
    }),
  };

  const provider: LLMProvider = {
    call: (params) => Promise.resolve(envelope(opts.llmResponse, params.agentId, params.prompt)),
  };

  const engine = new FSMEngine(fsm, {
    documentStore: store,
    scope,
    llmProvider: provider,
    ...(opts.validator && { validateOutput: opts.validator }),
  });
  await engine.initialize();

  const events: FSMEvent[] = [];
  const sendSignal = () =>
    engine.signal(
      { type: "RUN" },
      {
        sessionId: scope.sessionId,
        workspaceId: scope.workspaceId,
        onEvent: (e) => events.push(e),
      },
    );

  if (opts.expectThrow) {
    await expect(sendSignal()).rejects.toBeDefined();
  } else {
    await sendSignal();
  }

  const completionEvent = events
    .filter((e): e is FSMActionExecutionEvent => e.type === "data-fsm-action-execution")
    .find(
      (e) =>
        e.data.actionType === "llm" &&
        (e.data.status === "completed" || e.data.status === "failed"),
    );

  return { events, completionEvent };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("LLM action validation emit (B6)", () => {
  it("skip → step:complete carries { strategy: 'skip', skipReason }", async () => {
    const { completionEvent } = await runLLMActionAndCaptureEvents({
      validate: "skip",
      llmResponse: { content: "hello" },
    });
    const validation = completionEvent?.data.llmResult?.validation;
    expect(validation?.strategy).toBe("skip");
    expect(validation?.skipReason).toBeDefined();
    expect(validation?.verdict).toBeUndefined();
  });

  it("auto → read-only-fetcher → step:complete carries { strategy: 'skip', skipReason: 'read-only-fetcher' }", async () => {
    const { completionEvent } = await runLLMActionAndCaptureEvents({
      tools: ["search_messages", "get_gmail_thread"],
      outputType: "FetcherOutput",
      llmResponse: { content: "fetched" },
    });
    const validation = completionEvent?.data.llmResult?.validation;
    expect(validation?.strategy).toBe("skip");
    expect(validation?.skipReason).toContain("read-only");
  });

  it("self path with record_validation called (pass) → validation reflects args", async () => {
    const { completionEvent } = await runLLMActionAndCaptureEvents({
      validate: "self",
      llmResponse: { content: "ok", toolCalls: [recordValidationCall({ verdict: "pass" })] },
    });
    const validation = completionEvent?.data.llmResult?.validation;
    expect(validation?.strategy).toBe("self");
    expect(validation?.verdict).toBe("pass");
  });

  it("self path with record_validation advisory + issues → issues round-trip", async () => {
    const { completionEvent } = await runLLMActionAndCaptureEvents({
      validate: "self",
      llmResponse: {
        content: "ok",
        toolCalls: [
          recordValidationCall({
            verdict: "advisory",
            issues: [{ claim: "stat could not be sourced", category: "sourcing" }],
          }),
        ],
      },
    });
    const validation = completionEvent?.data.llmResult?.validation;
    expect(validation?.strategy).toBe("self");
    expect(validation?.verdict).toBe("advisory");
    expect(validation?.issues).toHaveLength(1);
    expect(validation?.issues?.[0]?.claim).toBe("stat could not be sourced");
  });

  it("self path WITHOUT record_validation called → { strategy: 'self' } (no verdict)", async () => {
    const { completionEvent } = await runLLMActionAndCaptureEvents({
      validate: "self",
      llmResponse: { content: "ok" },
    });
    const validation = completionEvent?.data.llmResult?.validation;
    expect(validation?.strategy).toBe("self");
    expect(validation?.verdict).toBeUndefined();
  });

  it("self path with verdict 'blocking' → action fails; FSM does not transition", async () => {
    const store = getDocumentStore();
    const uid = crypto.randomUUID();
    const scope = { workspaceId: `ws-${uid}`, sessionId: `sess-${uid}` };
    const action: Action = {
      type: "llm",
      provider: "test",
      model: "test-model",
      prompt: "do thing",
      outputTo: "output",
      validate: "self",
    };
    const fsm: FSMDefinition = {
      id: "validation-emit-blocking-test",
      initial: "pending",
      states: {
        pending: { on: { RUN: { target: "done", actions: [action] } } },
        done: { type: "final" },
      },
    };
    const provider: LLMProvider = {
      call: (params) =>
        Promise.resolve(
          envelope(
            {
              content: "should not emit",
              toolCalls: [
                recordValidationCall({
                  verdict: "blocking",
                  issues: [{ claim: "uncited stat", category: "sourcing" }],
                }),
              ],
            },
            params.agentId,
            params.prompt,
          ),
        ),
    };
    const engine = new FSMEngine(fsm, { documentStore: store, scope, llmProvider: provider });
    await engine.initialize();
    const events: FSMEvent[] = [];
    await expect(
      engine.signal(
        { type: "RUN" },
        {
          sessionId: scope.sessionId,
          workspaceId: scope.workspaceId,
          onEvent: (e) => events.push(e),
        },
      ),
    ).rejects.toThrow(/blocking/i);

    // FSM stays at the pre-transition state (`pending` was the source).
    expect(engine.state).toBe("pending");
    const completionEvent = events
      .filter((e): e is FSMActionExecutionEvent => e.type === "data-fsm-action-execution")
      .find((e) => e.data.status === "failed");
    expect(completionEvent).toBeDefined();
    expect(completionEvent?.data.error).toMatch(/blocking/i);
  });

  it("external path → validation = { strategy: 'external', verdict, issues } from judge", async () => {
    const { completionEvent } = await runLLMActionAndCaptureEvents({
      validate: "external",
      llmResponse: { content: "researched" },
      validator: () => Promise.resolve({ verdict: passVerdict() }),
    });
    const validation = completionEvent?.data.llmResult?.validation;
    expect(validation?.strategy).toBe("external");
    expect(validation?.verdict).toBe("pass");
  });

  it("external path with uncertain verdict → emits as 'advisory' with issues", async () => {
    const { completionEvent } = await runLLMActionAndCaptureEvents({
      validate: "external",
      llmResponse: { content: "researched" },
      validator: () => Promise.resolve({ verdict: uncertainVerdict() }),
    });
    const validation = completionEvent?.data.llmResult?.validation;
    expect(validation?.strategy).toBe("external");
    expect(validation?.verdict).toBe("advisory");
    expect(validation?.issues?.length).toBeGreaterThan(0);
  });

  it("external path keeps existing step:validation events firing on success (back-compat)", async () => {
    const { events } = await runLLMActionAndCaptureEvents({
      validate: "external",
      llmResponse: { content: "researched" },
      validator: () => Promise.resolve({ verdict: passVerdict() }),
    });
    const validationEvents = events.filter((e) => e.type === "data-fsm-validation-attempt");
    expect(validationEvents.length).toBeGreaterThanOrEqual(1);
  });
});

// ── case "agent" → type: llm coverage ────────────────────────────────────

describe("Agent action validation emit (B6, case 'agent')", () => {
  /**
   * Builds a stub `agentExecutor` that returns the given AgentResult (with
   * an optional `record_validation` tool call) and records the
   * AgentExecutorOptions it received. Used to exercise the agent path's
   * post-execution validation capture.
   */
  async function runAgentActionAndCaptureEvents(opts: {
    validate?: ValidateStrategy;
    resolvedAgentType?: "llm" | "user" | "atlas";
    toolCalls?: ToolCall[];
    validator?: OutputValidator;
  }): Promise<{
    events: FSMEvent[];
    completionEvent?: FSMActionExecutionEvent;
    capturedOptions?: AgentExecutorOptions;
  }> {
    const store = getDocumentStore();
    const uid = crypto.randomUUID();
    const scope = { workspaceId: `ws-${uid}`, sessionId: `sess-${uid}` };
    const action: Action = {
      type: "agent",
      agentId: "test-agent",
      outputTo: "result",
      ...(opts.validate !== undefined && { validate: opts.validate }),
    };
    const fsm: FSMDefinition = {
      id: "validation-emit-agent-test",
      initial: "pending",
      states: {
        pending: { on: { RUN: { target: "done", actions: [action] } } },
        done: { type: "final" },
      },
    };
    let capturedOptions: AgentExecutorOptions | undefined;
    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      agentExecutor: (_action, _ctx, _sig, options) => {
        capturedOptions = options;
        return Promise.resolve({
          agentId: "test-agent",
          timestamp: new Date().toISOString(),
          input: "",
          ok: true,
          data: { result: "ok" },
          toolCalls: opts.toolCalls ?? [],
          durationMs: 1,
        });
      },
      ...(opts.resolvedAgentType !== undefined && {
        resolveAgentType: () => opts.resolvedAgentType,
      }),
      ...(opts.validator && { validateOutput: opts.validator }),
    });
    await engine.initialize();
    const events: FSMEvent[] = [];
    await engine.signal(
      { type: "RUN" },
      {
        sessionId: scope.sessionId,
        workspaceId: scope.workspaceId,
        onEvent: (e) => events.push(e),
      },
    );
    const completionEvent = events
      .filter((e): e is FSMActionExecutionEvent => e.type === "data-fsm-action-execution")
      .find((e) => e.data.actionType === "agent" && e.data.status === "completed");
    return { events, completionEvent, capturedOptions };
  }

  it("agent + validate: skip → completion event carries skip strategy", async () => {
    const { completionEvent } = await runAgentActionAndCaptureEvents({ validate: "skip" });
    const validation = completionEvent?.data.llmResult?.validation;
    expect(validation?.strategy).toBe("skip");
  });

  it("agent + validate: self + record_validation pass → completion event carries verdict", async () => {
    const { completionEvent, capturedOptions } = await runAgentActionAndCaptureEvents({
      validate: "self",
      toolCalls: [recordValidationCall({ verdict: "pass" })],
    });
    expect(capturedOptions?.validateDecision).toBe("self");
    const validation = completionEvent?.data.llmResult?.validation;
    expect(validation?.strategy).toBe("self");
    expect(validation?.verdict).toBe("pass");
  });

  it("agent + validate: self + no record_validation call → { strategy: 'self' }", async () => {
    const { completionEvent } = await runAgentActionAndCaptureEvents({
      validate: "self",
      toolCalls: [],
    });
    const validation = completionEvent?.data.llmResult?.validation;
    expect(validation?.strategy).toBe("self");
    expect(validation?.verdict).toBeUndefined();
  });

  it("agent + resolvedAgentType: 'user' → classifier short-circuits to skip", async () => {
    const { completionEvent } = await runAgentActionAndCaptureEvents({ resolvedAgentType: "user" });
    const validation = completionEvent?.data.llmResult?.validation;
    expect(validation?.strategy).toBe("skip");
    expect(validation?.skipReason).toContain("non-llm-agent-type:user");
  });

  it("agent + validate: external pass → carries judge verdict", async () => {
    const { completionEvent } = await runAgentActionAndCaptureEvents({
      validate: "external",
      validator: () => Promise.resolve({ verdict: passVerdict() }),
    });
    const validation = completionEvent?.data.llmResult?.validation;
    expect(validation?.strategy).toBe("external");
    expect(validation?.verdict).toBe("pass");
  });
});
