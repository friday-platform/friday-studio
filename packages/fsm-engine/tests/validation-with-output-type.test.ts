/**
 * Phase E1 (melodic-strolling-seal-pt2). Regression coverage for the
 * structured-output + self-validation interaction. B6 unconditionally
 * injected `record_validation` when `decision === "self"` and switched
 * `toolChoice` from `{type:"tool", toolName:"complete"}` to `"auto"` —
 * which let the LLM stop calling `complete` on structured-output actions
 * and emit free-form prose instead. E1 skips `record_validation`
 * injection when the action declares an `outputType:` resolving to a
 * defined schema. The structured schema IS the validation contract;
 * verdict is implicit pass on successful complete-tool emission. E1.1
 * (melodic-strolling-seal-pt3): the skill body is also skipped on this
 * path — leaving "you MUST call record_validation" in the prompt while
 * suppressing the tool gave the LLM contradictory instructions and
 * made it bail into prose instead of calling `complete`.
 */
import type { AgentResult, ToolCall } from "@atlas/agent-sdk";
import { _setSkillStorageForTest, type SkillStorageAdapter } from "@atlas/skills";
import { afterEach, describe, expect, it } from "vitest";
import { getDocumentStore } from "../../document-store/mod.ts";
import { FSMEngine } from "../fsm-engine.ts";
import type {
  Action,
  FSMActionExecutionEvent,
  FSMDefinition,
  FSMEvent,
  FSMLLMOutput,
  LLMProvider,
  ValidateStrategy,
} from "../types.ts";

const SENTINEL_BODY = "<<<E1-VALIDATING-LLM-OUTPUTS-SKILL-BODY>>>";

function envelope(args: {
  prompt: string;
  agentId: string;
  toolCalls?: ToolCall[];
}): AgentResult<string, FSMLLMOutput> {
  return {
    agentId: args.agentId,
    timestamp: new Date().toISOString(),
    input: args.prompt,
    ok: true,
    data: { response: "" },
    toolCalls: args.toolCalls ?? [],
    durationMs: 0,
  };
}

function completeCall(input: Record<string, unknown>): ToolCall {
  return { type: "tool-call", toolCallId: "tc-complete", toolName: "complete", input };
}

function stubSkillAdapter(): SkillStorageAdapter {
  return {
    create: () => Promise.resolve({ ok: true, data: { skillId: "s" } }),
    publish: () =>
      Promise.resolve({ ok: true, data: { id: "i", version: 1, name: "n", skillId: "s" } }),
    get: (namespace, name) =>
      Promise.resolve({
        ok: true,
        data: {
          id: `id-${name}`,
          skillId: `sid-${name}`,
          namespace,
          name,
          version: 1,
          description: "",
          descriptionManual: false,
          disabled: false,
          frontmatter: {},
          instructions: SENTINEL_BODY,
          archive: null,
          createdBy: "system",
          createdAt: new Date(),
        },
      }),
    getById: () => Promise.resolve({ ok: true, data: null }),
    getBySkillId: () => Promise.resolve({ ok: true, data: null }),
    list: () => Promise.resolve({ ok: true, data: [] }),
    listVersions: () => Promise.resolve({ ok: true, data: [] }),
    deleteVersion: () => Promise.resolve({ ok: true, data: undefined }),
    setDisabled: () => Promise.resolve({ ok: true, data: undefined }),
    deleteSkill: () => Promise.resolve({ ok: true, data: undefined }),
    listAssigned: () => Promise.resolve({ ok: true, data: [] }),
    assignSkill: () => Promise.resolve({ ok: true, data: undefined }),
    unassignSkill: () => Promise.resolve({ ok: true, data: undefined }),
    listAssignments: () => Promise.resolve({ ok: true, data: [] }),
    assignToJob: () => Promise.resolve({ ok: true, data: undefined }),
    unassignFromJob: () => Promise.resolve({ ok: true, data: undefined }),
    listAssignmentsForJob: () => Promise.resolve({ ok: true, data: [] }),
    listJobOnlySkillIds: () => Promise.resolve({ ok: true, data: [] }),
  };
}

interface CapturedCall {
  tools: string[];
  toolChoice: unknown;
  prompt: string;
}

async function runStructuredAction(opts: {
  validate?: ValidateStrategy;
  llmToolCalls?: ToolCall[];
  withOutputType: boolean;
}): Promise<{
  events: FSMEvent[];
  completionEvent?: FSMActionExecutionEvent;
  captured: CapturedCall[];
}> {
  const store = getDocumentStore();
  const uid = crypto.randomUUID();
  const scope = { workspaceId: `ws-${uid}`, sessionId: `sess-${uid}` };

  const action: Action = {
    type: "llm",
    provider: "test",
    model: "test-model",
    prompt: "Extract structured info",
    outputTo: "result",
    ...(opts.withOutputType ? { outputType: "TicketResult" } : {}),
    ...(opts.validate !== undefined ? { validate: opts.validate } : {}),
  };

  const fsm: FSMDefinition = {
    id: "e1-structured-validation-test",
    initial: "pending",
    states: {
      pending: { on: { RUN: { target: "done", actions: [action] } } },
      done: { type: "final" },
    },
    ...(opts.withOutputType
      ? {
          documentTypes: {
            TicketResult: {
              type: "object",
              properties: {
                ticket_id: { type: "string" },
                priority: { type: "string", enum: ["low", "medium", "high"] },
              },
            },
          },
        }
      : {}),
  };

  const captured: CapturedCall[] = [];
  const provider: LLMProvider = {
    call: (params) => {
      captured.push({
        tools: Object.keys(params.tools ?? {}),
        toolChoice: params.toolChoice,
        prompt: params.prompt,
      });
      return Promise.resolve(
        envelope({
          prompt: params.prompt,
          agentId: params.agentId,
          ...(opts.llmToolCalls !== undefined ? { toolCalls: opts.llmToolCalls } : {}),
        }),
      );
    },
  };

  const engine = new FSMEngine(fsm, { documentStore: store, scope, llmProvider: provider });
  await engine.initialize();

  const events: FSMEvent[] = [];
  await engine.signal(
    { type: "RUN" },
    { sessionId: scope.sessionId, workspaceId: scope.workspaceId, onEvent: (e) => events.push(e) },
  );

  const completionEvent = events
    .filter((e): e is FSMActionExecutionEvent => e.type === "data-fsm-action-execution")
    .find((e) => e.data.actionType === "llm" && e.data.status === "completed");

  return { events, completionEvent, captured };
}

describe("E1: structured-output + self validation interaction", () => {
  afterEach(() => {
    _setSkillStorageForTest(null);
  });

  it("structured + self → does NOT inject record_validation; pins toolChoice to complete", async () => {
    _setSkillStorageForTest(stubSkillAdapter());
    const { captured } = await runStructuredAction({
      validate: "self",
      withOutputType: true,
      llmToolCalls: [completeCall({ ticket_id: "X-1", priority: "high" })],
    });

    expect(captured).toHaveLength(1);
    const call = captured[0];
    if (!call) throw new Error("expected captured call");
    expect(call.tools).toContain("complete");
    expect(call.tools).not.toContain("record_validation");
    expect(call.toolChoice).toEqual({ type: "tool", toolName: "complete" });
  });

  it("structured + self → step:complete.validation = { strategy: 'self', verdict: 'pass' } (B5 implicit pass)", async () => {
    // B5 (review-2): structured + self path is implicit-pass on successful
    // complete-tool emission. Pre-B5 this returned bare `{strategy: "self"}`,
    // which made step:complete.validation telemetry silently empty for
    // every structured action; downstream consumers couldn't distinguish
    // "self resolved, LLM emitted nothing" from "self resolved, structured
    // emit succeeded." Now the runtime synthesizes a pass verdict so the
    // stream event is honest about what happened.
    _setSkillStorageForTest(stubSkillAdapter());
    const { completionEvent } = await runStructuredAction({
      validate: "self",
      withOutputType: true,
      llmToolCalls: [completeCall({ ticket_id: "X-1", priority: "high" })],
    });

    const validation = completionEvent?.data.llmResult?.validation;
    expect(validation?.strategy).toBe("self");
    expect(validation?.verdict).toBe("pass");
  });

  it("structured + self → skill body NOT composed into the prompt (E1.1)", async () => {
    // E1.1 (melodic-strolling-seal-pt3): the skill body must also skip on
    // the structured + self path. E1 left it in the prompt while
    // suppressing the `record_validation` tool, which gave the LLM
    // contradictory instructions ("you MUST call record_validation" in
    // the body, no such tool in the catalog) and made it bail into prose
    // instead of calling `complete`. Verdict on this path is implicit
    // pass on successful structured emission; the skill body adds
    // nothing actionable.
    _setSkillStorageForTest(stubSkillAdapter());
    const { captured } = await runStructuredAction({
      validate: "self",
      withOutputType: true,
      llmToolCalls: [completeCall({ ticket_id: "X-1", priority: "high" })],
    });

    const call = captured[0];
    if (!call) throw new Error("expected captured call");
    expect(call.prompt).not.toContain(SENTINEL_BODY);
  });

  it("untyped outputTo + self → complete contract suppresses record_validation", async () => {
    _setSkillStorageForTest(stubSkillAdapter());
    const { captured } = await runStructuredAction({
      validate: "self",
      withOutputType: false,
      llmToolCalls: [completeCall({ response: "done" })],
    });

    const call = captured[0];
    if (!call) throw new Error("expected captured call");
    expect(call.tools).toContain("complete");
    expect(call.tools).not.toContain("record_validation");
    expect(call.toolChoice).toEqual({ type: "tool", toolName: "complete" });
  });

  it("structured + skip → no record_validation, no skill body", async () => {
    _setSkillStorageForTest(stubSkillAdapter());
    const { captured } = await runStructuredAction({
      validate: "skip",
      withOutputType: true,
      llmToolCalls: [completeCall({ ticket_id: "X-1", priority: "high" })],
    });

    const call = captured[0];
    if (!call) throw new Error("expected captured call");
    expect(call.tools).not.toContain("record_validation");
    expect(call.prompt).not.toContain(SENTINEL_BODY);
    expect(call.toolChoice).toEqual({ type: "tool", toolName: "complete" });
  });

  it("structured + external → no record_validation, no skill body, toolChoice still complete", async () => {
    _setSkillStorageForTest(stubSkillAdapter());
    const { captured } = await runStructuredAction({
      validate: "external",
      withOutputType: true,
      llmToolCalls: [completeCall({ ticket_id: "X-1", priority: "high" })],
    });

    const call = captured[0];
    if (!call) throw new Error("expected captured call");
    expect(call.tools).not.toContain("record_validation");
    expect(call.prompt).not.toContain(SENTINEL_BODY);
    expect(call.toolChoice).toEqual({ type: "tool", toolName: "complete" });
  });
});

/**
 * Untyped outputTo actions still produce documents, so they use the same
 * complete-tool mechanical contract as explicit outputType actions. This
 * guards the real failure class where validate:self terminated on
 * record_validation and persisted `{ response: "" }`.
 */
describe("untyped outputTo contract at FSM case 'llm'", () => {
  afterEach(() => {
    _setSkillStorageForTest(null);
  });

  it("untyped outputTo + skip → complete pinned, no validation tool/body", async () => {
    _setSkillStorageForTest(stubSkillAdapter());
    const { captured } = await runStructuredAction({
      validate: "skip",
      withOutputType: false,
      llmToolCalls: [completeCall({ response: "done" })],
    });

    const call = captured[0];
    if (!call) throw new Error("expected captured call");
    expect(call.tools).not.toContain("record_validation");
    expect(call.tools).toContain("complete");
    expect(call.prompt).not.toContain(SENTINEL_BODY);
    expect(call.toolChoice).toEqual({ type: "tool", toolName: "complete" });
  });

  it("untyped outputTo + external → complete pinned, no validation tool/body", async () => {
    _setSkillStorageForTest(stubSkillAdapter());
    const { captured } = await runStructuredAction({
      validate: "external",
      withOutputType: false,
      llmToolCalls: [completeCall({ response: "done" })],
    });

    const call = captured[0];
    if (!call) throw new Error("expected captured call");
    expect(call.tools).not.toContain("record_validation");
    expect(call.tools).toContain("complete");
    expect(call.prompt).not.toContain(SENTINEL_BODY);
    expect(call.toolChoice).toEqual({ type: "tool", toolName: "complete" });
  });

  it("untyped outputTo + self → complete pinned, no validation tool/body", async () => {
    _setSkillStorageForTest(stubSkillAdapter());
    const { captured } = await runStructuredAction({
      validate: "self",
      withOutputType: false,
      llmToolCalls: [completeCall({ response: "done" })],
    });

    const call = captured[0];
    if (!call) throw new Error("expected captured call");
    expect(call.tools).not.toContain("record_validation");
    expect(call.tools).toContain("complete");
    expect(call.prompt).not.toContain(SENTINEL_BODY);
    expect(call.toolChoice).toEqual({ type: "tool", toolName: "complete" });
  });
});
