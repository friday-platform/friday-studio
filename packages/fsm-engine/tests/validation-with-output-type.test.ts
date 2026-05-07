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

  it("structured + self → step:complete.validation = { strategy: 'self' } (no verdict)", async () => {
    _setSkillStorageForTest(stubSkillAdapter());
    const { completionEvent } = await runStructuredAction({
      validate: "self",
      withOutputType: true,
      llmToolCalls: [completeCall({ ticket_id: "X-1", priority: "high" })],
    });

    const validation = completionEvent?.data.llmResult?.validation;
    expect(validation?.strategy).toBe("self");
    expect(validation?.verdict).toBeUndefined();
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

  it("free-form + self → record_validation IS injected (B6 regression guard)", async () => {
    _setSkillStorageForTest(stubSkillAdapter());
    const { captured } = await runStructuredAction({ validate: "self", withOutputType: false });

    const call = captured[0];
    if (!call) throw new Error("expected captured call");
    expect(call.tools).toContain("record_validation");
    // Free-form path must allow the LLM to call record_validation, so toolChoice
    // is `auto` (not pinned to `complete` because no complete tool exists here).
    expect(call.toolChoice).toBe("auto");
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
 * H3 (melodic-strolling-seal-pt3). B6's commit message claimed the
 * `toolChoice` resolution rule:
 *
 *   - `completeToolInjected && !recordValidationInjected` → pin to
 *     `{ type: "tool", toolName: "complete" }`
 *   - otherwise → `"auto"` (so the LLM can sequence record_validation
 *     before complete or skip both)
 *
 * E1 + E1.1 narrowed the second branch by skipping `record_validation`
 * (and the skill body) on the structured + self path. The `structured + *`
 * crossings above pin the `complete` branch. The free-form crossings
 * below pin the `auto` branch — none of these assertions existed before
 * H3 (the B3 skill-injection tests only checked prompt body, not
 * toolChoice; B6's regression guard at line ~235 hand-waved the
 * free-form-self case).
 *
 * Together with the structured cases above, this covers all six
 * structured/free-form × skip/self/external crossings on the FSM
 * `case "llm"` inline path. The orchestrator `case "agent"` path is
 * covered by `packages/core/src/agent-conversion/from-llm.test.ts`.
 */
describe("H3: free-form toolChoice resolution at FSM case 'llm' (B6 audit)", () => {
  afterEach(() => {
    _setSkillStorageForTest(null);
  });

  it("free-form + skip → no record_validation, no skill body, toolChoice 'auto'", async () => {
    _setSkillStorageForTest(stubSkillAdapter());
    const { captured } = await runStructuredAction({ validate: "skip", withOutputType: false });

    const call = captured[0];
    if (!call) throw new Error("expected captured call");
    expect(call.tools).not.toContain("record_validation");
    expect(call.tools).not.toContain("complete");
    expect(call.prompt).not.toContain(SENTINEL_BODY);
    // No structured-output forcing, no record_validation injection;
    // B6's rule degenerates to `auto` (the engine's only other branch).
    expect(call.toolChoice).toBe("auto");
  });

  it("free-form + external → no record_validation, no skill body, toolChoice 'auto'", async () => {
    _setSkillStorageForTest(stubSkillAdapter());
    const { captured } = await runStructuredAction({ validate: "external", withOutputType: false });

    const call = captured[0];
    if (!call) throw new Error("expected captured call");
    expect(call.tools).not.toContain("record_validation");
    expect(call.tools).not.toContain("complete");
    expect(call.prompt).not.toContain(SENTINEL_BODY);
    expect(call.toolChoice).toBe("auto");
  });

  it("free-form + self → record_validation IS injected, skill body composed, toolChoice 'auto'", async () => {
    // Pins the full free-form + self triple: tool injection + body
    // composition + auto toolChoice. The earlier B6 regression guard
    // only checked tool injection; this asserts the full set so future
    // refactors can't silently drop one piece.
    _setSkillStorageForTest(stubSkillAdapter());
    const { captured } = await runStructuredAction({ validate: "self", withOutputType: false });

    const call = captured[0];
    if (!call) throw new Error("expected captured call");
    expect(call.tools).toContain("record_validation");
    expect(call.tools).not.toContain("complete");
    expect(call.prompt).toContain(SENTINEL_BODY);
    // record_validation injected → toolChoice cannot pin to complete
    // (no complete tool here either) → falls to auto.
    expect(call.toolChoice).toBe("auto");
  });
});
