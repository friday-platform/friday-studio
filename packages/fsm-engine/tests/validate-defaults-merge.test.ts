/**
 * Phase B5 (melodic-strolling-seal-pt2). Verifies that workspace- and
 * job-level `validation:` defaults flow through `FSMEngineOptions` and
 * are merged with action-level `validate:` at decision-resolution time
 * inside the engine.
 *
 * Precedence (asserted here):
 *   action.validate
 *     > job.validation.default
 *     > workspace.validation.default
 *     > "auto"  (the B1 classifier)
 *
 * Skill name follows the same merge.
 */

import type { AgentResult, ToolCall } from "@atlas/agent-sdk";
import type { ValidationDefaults } from "@atlas/config";
import type { ValidationVerdict } from "@atlas/hallucination";
import { _setSkillStorageForTest, type SkillStorageAdapter } from "@atlas/skills";
import { afterEach, describe, expect, it } from "vitest";
import { getDocumentStore } from "../../document-store/mod.ts";
import { FSMEngine } from "../fsm-engine.ts";
import type {
  Action,
  FSMDefinition,
  FSMLLMOutput,
  JudgeAgentRunner,
  LLMProvider,
  ValidateStrategy,
} from "../types.ts";

const SENTINEL_BODY = "<<<MERGED-DEFAULTS-VALIDATING-SKILL-BODY>>> sentinel for B5 tests";

function passVerdict(): ValidationVerdict {
  return { verdict: "pass" };
}

function envelope(
  agentId: string,
  prompt: string,
  toolCalls: ToolCall[] = [],
): AgentResult<string, FSMLLMOutput> {
  return {
    agentId,
    timestamp: new Date().toISOString(),
    input: prompt,
    ok: true,
    data: { response: "ok" },
    toolCalls,
    durationMs: 0,
  };
}

function stubSkillAdapter(opts: { expectedName?: string; body?: string }): SkillStorageAdapter {
  return {
    create: () => Promise.resolve({ ok: true, data: { skillId: "s" } }),
    publish: () =>
      Promise.resolve({ ok: true, data: { id: "i", version: 1, name: "n", skillId: "s" } }),
    get: (namespace, name) => {
      if (opts.expectedName && name !== opts.expectedName) {
        return Promise.resolve({ ok: true, data: null });
      }
      return Promise.resolve({
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
          instructions: opts.body ?? SENTINEL_BODY,
          archive: null,
          createdBy: "system",
          createdAt: new Date(),
        },
      });
    },
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

interface RunResult {
  validatorCalls: number;
  capturedPrompt: string;
}

async function runWithDefaults(opts: {
  validate?: ValidateStrategy;
  tools?: string[];
  outputType?: string;
  workspaceValidation?: ValidationDefaults;
  jobValidation?: ValidationDefaults;
}): Promise<RunResult> {
  const store = getDocumentStore();
  const uid = crypto.randomUUID();
  const scope = { workspaceId: `ws-${uid}`, sessionId: `sess-${uid}` };

  const action: Action = {
    type: "llm",
    provider: "test",
    model: "test-model",
    prompt: "do thing",
    ...(opts.tools !== undefined && { tools: opts.tools }),
    ...(opts.outputType !== undefined && { outputType: opts.outputType }),
    ...(opts.validate !== undefined && { validate: opts.validate }),
  };

  const fsm: FSMDefinition = {
    id: "validate-defaults-merge-test",
    initial: "pending",
    states: {
      pending: { on: { RUN: { target: "done", actions: [action] } } },
      done: { type: "final" },
    },
    ...(opts.outputType !== undefined && {
      documentTypes: { [opts.outputType]: { type: "object" } },
    }),
  };

  let capturedPrompt = "";
  const provider: LLMProvider = {
    call: (params) => {
      // Capture system + user-message body together so substring asserts
      // work regardless of whether content lands in the cacheable system
      // surface or the volatile user preface.
      capturedPrompt = `${params.system ?? ""}\n\n${params.prompt ?? ""}`;
      return Promise.resolve(envelope(params.agentId, params.prompt));
    },
  };

  // O2 (review-2): test-side scaffold ports to `runJudge` directly.
  let validatorCalls = 0;
  const runJudge: JudgeAgentRunner = () => {
    validatorCalls++;
    return Promise.resolve({ ok: true, verdict: passVerdict() });
  };

  const engine = new FSMEngine(fsm, {
    documentStore: store,
    scope,
    llmProvider: provider,
    runJudge,
    ...(opts.workspaceValidation && { workspaceValidation: opts.workspaceValidation }),
    ...(opts.jobValidation && { jobValidation: opts.jobValidation }),
  });
  await engine.initialize();
  await engine.signal({ type: "RUN" });

  expect(engine.state).toEqual("done");
  return { validatorCalls, capturedPrompt };
}

describe("validate defaults merge (B5)", () => {
  afterEach(() => {
    _setSkillStorageForTest(null);
  });

  it("workspace default 'external' + no job + no action → external validator runs", async () => {
    _setSkillStorageForTest(stubSkillAdapter({}));
    const { validatorCalls } = await runWithDefaults({
      workspaceValidation: { default: "external" },
    });
    expect(validatorCalls).toEqual(1);
  });

  it("workspace default 'self' + action 'skip' → action wins, validator NOT called", async () => {
    _setSkillStorageForTest(stubSkillAdapter({}));
    const { validatorCalls, capturedPrompt } = await runWithDefaults({
      validate: "skip",
      workspaceValidation: { default: "self" },
    });
    expect(validatorCalls).toEqual(0);
    expect(capturedPrompt).not.toContain(SENTINEL_BODY);
  });

  it("job 'skip' + workspace 'external' → job wins, validator NOT called", async () => {
    _setSkillStorageForTest(stubSkillAdapter({}));
    const { validatorCalls } = await runWithDefaults({
      jobValidation: { default: "skip" },
      workspaceValidation: { default: "external" },
    });
    expect(validatorCalls).toEqual(0);
  });

  it("workspace skill override + workspace default 'self' → custom skill body appears in prompt", async () => {
    _setSkillStorageForTest(stubSkillAdapter({ expectedName: "@my/skill" }));
    const { capturedPrompt } = await runWithDefaults({
      workspaceValidation: { default: "self", skill: "@my/skill" },
    });
    expect(capturedPrompt).toContain(SENTINEL_BODY);
  });

  it("job skill override beats workspace skill", async () => {
    _setSkillStorageForTest(stubSkillAdapter({ expectedName: "@job/skill" }));
    const { capturedPrompt } = await runWithDefaults({
      jobValidation: { default: "self", skill: "@job/skill" },
      workspaceValidation: { default: "self", skill: "@ws/skill" },
    });
    expect(capturedPrompt).toContain(SENTINEL_BODY);
  });

  it("no defaults at any level → preserves pre-B5 behavior (auto classifier)", async () => {
    _setSkillStorageForTest(stubSkillAdapter({}));
    // Read-only-fetcher shape: classifier returns "skip" → no validator.
    const { validatorCalls } = await runWithDefaults({
      tools: ["search_messages"],
      outputType: "FetcherOutput",
    });
    expect(validatorCalls).toEqual(0);
  });

  it("no defaults + auto classifier picks 'self' → skill body appears in prompt (default skill)", async () => {
    _setSkillStorageForTest(stubSkillAdapter({ expectedName: "validating-llm-outputs" }));
    // Mutating tool ⇒ classifier returns "self" ⇒ default skill loaded.
    const { capturedPrompt } = await runWithDefaults({ tools: ["send_email"] });
    expect(capturedPrompt).toContain(SENTINEL_BODY);
  });

  it("workspace default 'external' + action object { strategy: 'self' } → action wins, validator NOT called", async () => {
    _setSkillStorageForTest(stubSkillAdapter({}));
    const { validatorCalls } = await runWithDefaults({
      validate: { strategy: "self" },
      workspaceValidation: { default: "external" },
    });
    expect(validatorCalls).toEqual(0);
  });
});
