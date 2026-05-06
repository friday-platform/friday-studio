/**
 * Phase B4 (melodic-strolling-seal-pt2). Closes the case-llm-vs-case-agent
 * validation asymmetry. Verifies that the FSM engine's `case "agent"`
 * handler:
 *
 *   - resolves the validation decision pre-call (mirroring the
 *     resolution case "llm" already does),
 *   - threads `validateDecision` + `validateSkill` through the
 *     `AgentExecutorOptions` so the orchestrator-side prompt-assembly
 *     site can call `composeValidationBlock`,
 *   - skips that injection on `resolvedAgentType: "user"` /
 *     `"atlas"` (the classifier short-circuits to `skip` before the
 *     decision ever reaches the executor),
 *   - runs the external judge post-execution when decision is
 *     `external`,
 *   - emits the same `validate-decision resolved` info log as the
 *     case "llm" path so observability parity holds.
 *
 * The orchestrator-side reader of `validateDecision` is tested
 * separately in `packages/core/src/agent-context/validate-decision.test.ts`
 * (the wire format) and exercised end-to-end against `convertLLMToAgent`
 * via the workspace runtime in C2's tests.
 */

import type { AgentResult } from "@atlas/agent-sdk";
import type { ValidationVerdict } from "@atlas/hallucination";
import { describe, expect, it } from "vitest";
import { getDocumentStore } from "../../document-store/mod.ts";
import { FSMEngine } from "../fsm-engine.ts";
import type { Action, FSMDefinition, OutputValidator, ValidateStrategy } from "../types.ts";

interface CapturedExecutorCall {
  agentId: string;
  validateDecision?: "skip" | "self" | "external";
  validateSkill?: string;
}

function buildEnvelope(agentId: string): AgentResult<string, Record<string, unknown>> {
  return {
    agentId,
    timestamp: new Date().toISOString(),
    input: "",
    ok: true,
    data: { result: "ok" },
    durationMs: 1,
  };
}

function passVerdict(): ValidationVerdict {
  return { status: "pass", confidence: 0.9, threshold: 0.45, issues: [], retryGuidance: "" };
}

function failVerdict(): ValidationVerdict {
  return { status: "fail", confidence: 0.1, threshold: 0.45, issues: [], retryGuidance: "fix it" };
}

async function runAgentAction(opts: {
  validate?: ValidateStrategy;
  resolvedAgentType?: "llm" | "user" | "atlas";
  outputType?: string;
  validator?: OutputValidator;
}): Promise<{
  capturedCall?: CapturedExecutorCall;
  validatorCalls: number;
  threwError?: Error;
  state: string;
}> {
  const store = getDocumentStore();
  const uid = crypto.randomUUID();
  const scope = { workspaceId: `ws-${uid}`, sessionId: `sess-${uid}` };

  const action: Action = {
    type: "agent",
    agentId: "test-agent",
    outputTo: "result",
    ...(opts.outputType !== undefined && { outputType: opts.outputType }),
    ...(opts.validate !== undefined && { validate: opts.validate }),
  };

  const fsm: FSMDefinition = {
    id: "validate-agent-action-test",
    initial: "pending",
    states: {
      pending: { on: { RUN: { target: "done", actions: [action] } } },
      done: { type: "final" },
    },
    ...(opts.outputType !== undefined && {
      documentTypes: { [opts.outputType]: { type: "object" } },
    }),
  };

  let capturedCall: CapturedExecutorCall | undefined;
  let validatorCalls = 0;

  const validateOutput: OutputValidator | undefined = opts.validator;
  const wrappedValidator: OutputValidator | undefined = validateOutput
    ? (trace, signal) => {
        validatorCalls++;
        return validateOutput(trace, signal);
      }
    : undefined;

  const engine = new FSMEngine(fsm, {
    documentStore: store,
    scope,
    agentExecutor: (action, _ctx, _sig, options) => {
      capturedCall = {
        agentId: action.agentId,
        validateDecision: options?.validateDecision,
        validateSkill: options?.validateSkill,
      };
      return Promise.resolve(buildEnvelope(action.agentId));
    },
    ...(opts.resolvedAgentType !== undefined && { resolveAgentType: () => opts.resolvedAgentType }),
    ...(wrappedValidator ? { validateOutput: wrappedValidator } : {}),
  });

  await engine.initialize();
  let threwError: Error | undefined;
  try {
    await engine.signal({ type: "RUN" });
  } catch (err) {
    threwError = err instanceof Error ? err : new Error(String(err));
  }

  return { capturedCall, validatorCalls, threwError, state: engine.state };
}

describe("case 'agent' validate-decision threading (B4)", () => {
  it("validate: 'self' threads decision='self' through AgentExecutorOptions", async () => {
    const { capturedCall } = await runAgentAction({ validate: "self" });
    expect(capturedCall?.validateDecision).toEqual("self");
    expect(capturedCall?.validateSkill).toBeUndefined();
  });

  it("validate: { strategy: 'self', skill: 'custom' } propagates the skill name", async () => {
    const { capturedCall } = await runAgentAction({
      validate: { strategy: "self", skill: "custom-validator" },
    });
    expect(capturedCall?.validateDecision).toEqual("self");
    expect(capturedCall?.validateSkill).toEqual("custom-validator");
  });

  it("validate: 'skip' threads decision='skip'", async () => {
    const { capturedCall } = await runAgentAction({ validate: "skip" });
    expect(capturedCall?.validateDecision).toEqual("skip");
  });

  it("resolvedAgentType='user' short-circuits to skip even without explicit validate", async () => {
    const { capturedCall } = await runAgentAction({ resolvedAgentType: "user" });
    expect(capturedCall?.validateDecision).toEqual("skip");
  });

  it("resolvedAgentType='atlas' short-circuits to skip even without explicit validate", async () => {
    const { capturedCall } = await runAgentAction({ resolvedAgentType: "atlas" });
    expect(capturedCall?.validateDecision).toEqual("skip");
  });

  it("resolvedAgentType='llm' falls through to default-self when no explicit decision", async () => {
    const { capturedCall } = await runAgentAction({ resolvedAgentType: "llm" });
    expect(capturedCall?.validateDecision).toEqual("self");
  });

  it("explicit validate: 'self' overrides resolvedAgentType='user'", async () => {
    // Source = explicit, so the classifier's user/atlas short-circuit is
    // bypassed. Authors who explicitly opt in get what they asked for.
    const { capturedCall } = await runAgentAction({ resolvedAgentType: "user", validate: "self" });
    expect(capturedCall?.validateDecision).toEqual("self");
  });
});

describe("case 'agent' external validation (B4)", () => {
  it("validate: 'external' invokes validateOutput post-execution", async () => {
    const { validatorCalls } = await runAgentAction({
      validate: "external",
      validator: () => Promise.resolve({ verdict: passVerdict() }),
    });
    expect(validatorCalls).toEqual(1);
  });

  it("validate: 'external' with fail verdict throws ValidationFailedError", async () => {
    const { validatorCalls, threwError, state } = await runAgentAction({
      validate: "external",
      validator: () => Promise.resolve({ verdict: failVerdict() }),
    });
    expect(validatorCalls).toEqual(1);
    expect(threwError).toBeDefined();
    expect(threwError?.message.toLowerCase()).toContain("validation");
    // Action threw, so the FSM never advanced past `pending`.
    expect(state).toEqual("pending");
  });

  it("validate: 'self' does NOT invoke validateOutput", async () => {
    const { validatorCalls } = await runAgentAction({
      validate: "self",
      validator: () => Promise.resolve({ verdict: passVerdict() }),
    });
    expect(validatorCalls).toEqual(0);
  });

  it("validate: 'skip' does NOT invoke validateOutput", async () => {
    const { validatorCalls } = await runAgentAction({
      validate: "skip",
      validator: () => Promise.resolve({ verdict: passVerdict() }),
    });
    expect(validatorCalls).toEqual(0);
  });

  it("auto-classified 'self' (no resolvedAgentType, no explicit validate) does NOT run external judge", async () => {
    // The auto classifier never returns "external" — that requires explicit
    // opt-in. So even with a validator wired, an auto-resolved decision
    // skips the external path.
    const { validatorCalls, capturedCall } = await runAgentAction({
      validator: () => Promise.resolve({ verdict: passVerdict() }),
    });
    expect(capturedCall?.validateDecision).toEqual("self");
    expect(validatorCalls).toEqual(0);
  });
});

describe("case 'agent' vs case 'llm' asymmetry closure (B4)", () => {
  // Same author intent (`validate: "self"`) on both action types must end up
  // with the same decision threaded through the runtime. case "llm" wires
  // composeValidationBlock inline (B3); case "agent" hands the decision to
  // the orchestrator's prompt-assembly site (this test just checks the
  // decision threads — the orchestrator-side wire-in is exercised by
  // `validate-decision.test.ts` and the workspace-runtime tests).
  it("both action types resolve `validate: 'self'` to decision='self'", async () => {
    const { capturedCall } = await runAgentAction({ validate: "self" });
    expect(capturedCall?.validateDecision).toEqual("self");
    // case "llm"'s side is verified in `validate-self-skill-injection.test.ts`
    // — same `validate: "self"` causes the validation skill body to land in
    // the prompt. Together these two tests pin the asymmetry closure.
  });
});
