/**
 * Phase B7 (melodic-strolling-seal-pt2). Verifies the FSM engine's
 * external-validation branch invokes the injected `runJudge` callback
 * (replacing the deleted `validateOutput` retry hook), forwards the
 * verdict onto `step:complete.validation`, and synthesizes an advisory
 * verdict when the judge delegate fails.
 */

import type { AgentResult } from "@atlas/agent-sdk";
import type { ValidationVerdict } from "@atlas/hallucination";
import { describe, expect, it } from "vitest";
import { getDocumentStore } from "../../document-store/mod.ts";
import { buildJudgeHandoff, FSMEngine } from "../fsm-engine.ts";
import type {
  Action,
  FSMActionExecutionEvent,
  FSMDefinition,
  FSMEvent,
  FSMLLMOutput,
  JudgeAgentRunner,
  LLMActionTrace,
  LLMProvider,
  ValidateStrategy,
} from "../types.ts";

function envelope(
  content: string,
  agentId: string,
  prompt: string,
): AgentResult<string, FSMLLMOutput> {
  return {
    agentId,
    timestamp: new Date().toISOString(),
    input: prompt,
    ok: true,
    data: { response: content },
    toolCalls: [],
    toolResults: [],
    durationMs: 0,
  };
}

interface RunOpts {
  validate: ValidateStrategy;
  runJudge?: JudgeAgentRunner;
  expectThrow?: boolean;
}

async function runActionAndCapture(
  opts: RunOpts,
): Promise<{
  events: FSMEvent[];
  completionEvent?: FSMActionExecutionEvent;
  judgeCalls: Array<{ agentId: string; handoff: unknown }>;
}> {
  const store = getDocumentStore();
  const uid = crypto.randomUUID();
  const scope = { workspaceId: `ws-${uid}`, sessionId: `sess-${uid}` };

  const action: Action = {
    type: "llm",
    provider: "test",
    model: "test-model",
    prompt: "do thing",
    outputTo: "output",
    validate: opts.validate,
  };
  const fsm: FSMDefinition = {
    id: "external-via-delegate-test",
    initial: "pending",
    states: {
      pending: { on: { RUN: { target: "done", actions: [action] } } },
      done: { type: "final" },
    },
  };

  const provider: LLMProvider = {
    call: (params) => Promise.resolve(envelope("agent draft", params.agentId, params.prompt)),
  };

  const judgeCalls: Array<{ agentId: string; handoff: unknown }> = [];
  const wrappedJudge: JudgeAgentRunner | undefined = opts.runJudge
    ? (input) => {
        judgeCalls.push({ agentId: input.agentId, handoff: input.handoff });
        return opts.runJudge!(input);
      }
    : undefined;

  const engine = new FSMEngine(fsm, {
    documentStore: store,
    scope,
    llmProvider: provider,
    ...(wrappedJudge ? { runJudge: wrappedJudge } : {}),
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

  return { events, completionEvent, judgeCalls };
}

describe("external validation via runJudge delegate (B7)", () => {
  it("validate: 'external' invokes the runJudge callback with judge-agent default", async () => {
    const verdict: ValidationVerdict = { verdict: "pass" };
    const { judgeCalls, completionEvent } = await runActionAndCapture({
      validate: "external",
      runJudge: () => Promise.resolve({ ok: true, verdict }),
    });
    expect(judgeCalls).toHaveLength(1);
    expect(judgeCalls[0]?.agentId).toBe("judge-agent");
    expect(completionEvent?.data.llmResult?.validation?.strategy).toBe("external");
    expect(completionEvent?.data.llmResult?.validation?.verdict).toBe("pass");
  });

  it("validate: { strategy: 'external', agent: 'fin-judge' } picks the override agent id", async () => {
    const { judgeCalls } = await runActionAndCapture({
      validate: { strategy: "external", agent: "fin-judge" },
      runJudge: () => Promise.resolve({ ok: true, verdict: { verdict: "pass" } }),
    });
    expect(judgeCalls[0]?.agentId).toBe("fin-judge");
  });

  it("blocking verdict throws and the FSM does not transition", async () => {
    const { events } = await runActionAndCapture({
      validate: "external",
      runJudge: () =>
        Promise.resolve({
          ok: true,
          verdict: { verdict: "blocking", issues: [{ claim: "fabricated stat" }] },
        }),
      expectThrow: true,
    });
    const failEvent = events
      .filter((e): e is FSMActionExecutionEvent => e.type === "data-fsm-action-execution")
      .find((e) => e.data.status === "failed");
    expect(failEvent).toBeDefined();
  });

  it("advisory verdict carries issues onto step:complete (no throw)", async () => {
    const { completionEvent } = await runActionAndCapture({
      validate: "external",
      runJudge: () =>
        Promise.resolve({
          ok: true,
          verdict: {
            verdict: "advisory",
            issues: [{ claim: "uncertain timezone", category: "judge-uncertain" }],
          },
        }),
    });
    expect(completionEvent?.data.llmResult?.validation?.verdict).toBe("advisory");
    expect(completionEvent?.data.llmResult?.validation?.issues?.length).toBeGreaterThan(0);
  });

  it("delegate failure synthesizes an advisory verdict with judge-error issue", async () => {
    const { completionEvent } = await runActionAndCapture({
      validate: "external",
      runJudge: () => Promise.resolve({ ok: false, error: "budget_exhausted: max_steps_per_call" }),
    });
    const validation = completionEvent?.data.llmResult?.validation;
    expect(validation?.strategy).toBe("external");
    expect(validation?.verdict).toBe("advisory");
    expect(validation?.issues?.[0]?.category).toBe("judge-error");
    expect(validation?.issues?.[0]?.reasoning).toContain("budget_exhausted");
  });

  it("auto-classified actions never invoke the judge (external requires opt-in)", async () => {
    const { judgeCalls } = await runActionAndCapture({
      validate: "auto",
      runJudge: () => Promise.resolve({ ok: true, verdict: { verdict: "pass" } }),
    });
    expect(judgeCalls).toHaveLength(0);
  });
});

describe("buildJudgeHandoff", () => {
  it("includes inline tool results for non-lifted payloads", () => {
    const trace: LLMActionTrace = {
      content: "agent draft",
      prompt: "do thing",
      model: "test-model",
      toolCalls: [
        { type: "tool-call", toolCallId: "call-1", toolName: "search", input: { q: "x" } },
      ],
      toolResults: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "search",
          input: { q: "x" },
          output: "raw text",
        },
      ],
    };
    const handoff = buildJudgeHandoff(trace);
    expect(handoff.toolCalls).toHaveLength(1);
    expect(handoff.toolCalls[0]?.toolName).toBe("search");
    expect(handoff.toolCalls[0]?.resultInline).toBe("raw text");
    expect(handoff.toolCalls[0]?.resultArtifactId).toBeUndefined();
  });

  it("substitutes resultArtifactId + summary for scrubber-lifted (A2) results", () => {
    const lifted =
      "[attachment lifted to artifact art-123 (12 KB, image/png, from gmail/get_attachment) — use display_artifact or artifacts_get to read]";
    const trace: LLMActionTrace = {
      content: "agent draft",
      prompt: "do thing",
      model: "test-model",
      toolCalls: [
        { type: "tool-call", toolCallId: "call-1", toolName: "get_attachment", input: {} },
      ],
      toolResults: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "get_attachment",
          input: {},
          output: lifted,
        },
      ],
    };
    const handoff = buildJudgeHandoff(trace);
    expect(handoff.toolCalls[0]?.resultArtifactId).toBe("art-123");
    expect(handoff.toolCalls[0]?.resultSummary).toContain("image/png");
    expect(handoff.toolCalls[0]?.resultInline).toBeUndefined();
  });
});
