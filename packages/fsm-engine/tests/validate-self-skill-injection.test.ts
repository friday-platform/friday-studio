/**
 * Phase B3 (melodic-strolling-seal-pt2). Verifies that when a `case "llm"`
 * action's resolved `validate` decision is `"self"`, the FSM engine composes
 * the bundled `validating-llm-outputs` system skill into the action's
 * system prompt — and that decisions of `"skip"` / `"external"` leave the
 * prompt untouched. The test stubs `SkillStorage` so it returns a sentinel
 * skill body and asserts the body appears (or doesn't) in the prompt the
 * mock LLM provider receives.
 */

import type { AgentResult } from "@atlas/agent-sdk";
import { _setSkillStorageForTest, type SkillStorageAdapter } from "@atlas/skills";
import { afterEach, describe, expect, it } from "vitest";
import { getDocumentStore } from "../../document-store/mod.ts";
import { FSMEngine } from "../fsm-engine.ts";
import type {
  Action,
  FSMDefinition,
  FSMLLMOutput,
  LLMProvider,
  ValidateStrategy,
} from "../types.ts";

const SENTINEL_BODY =
  "<<<VALIDATING-LLM-OUTPUTS-SKILL-BODY>>> self-check the draft before emitting.";

function envelope(
  prompt: string,
  agentId: string,
  opts: { complete?: boolean } = {},
): AgentResult<string, FSMLLMOutput> {
  return {
    agentId,
    timestamp: new Date().toISOString(),
    input: prompt,
    ok: true,
    data: { response: opts.complete ? "" : "ok" },
    toolCalls: opts.complete
      ? [
          {
            type: "tool-call",
            toolCallId: "tc-complete",
            toolName: "complete",
            input: { ok: true },
          },
        ]
      : [],
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

async function runAndCapturePrompt(opts: {
  validate?: ValidateStrategy;
  tools?: string[];
  outputType?: string;
}): Promise<{ capturedPrompt: string }> {
  const store = getDocumentStore();
  const uid = crypto.randomUUID();
  const scope = { workspaceId: `ws-${uid}`, sessionId: `sess-${uid}` };

  const action: Action = {
    type: "llm",
    provider: "test",
    model: "test-model",
    prompt: "do thing",
    ...(opts.outputType !== undefined && { outputTo: "output" }),
    ...(opts.tools !== undefined && { tools: opts.tools }),
    ...(opts.outputType !== undefined && { outputType: opts.outputType }),
    ...(opts.validate !== undefined && { validate: opts.validate }),
  };

  const fsm: FSMDefinition = {
    id: "validate-self-skill-injection-test",
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
      capturedPrompt = params.prompt;
      return Promise.resolve(
        envelope(params.prompt, params.agentId, { complete: !!opts.outputType }),
      );
    },
  };

  const engine = new FSMEngine(fsm, { documentStore: store, scope, llmProvider: provider });
  await engine.initialize();
  await engine.signal({ type: "RUN" });
  expect(engine.state).toEqual("done");

  return { capturedPrompt };
}

describe("LLM action validate=self skill injection (B3)", () => {
  afterEach(() => {
    _setSkillStorageForTest(null);
  });

  it("validate: 'self' → composes the default validating-llm-outputs skill body into the prompt", async () => {
    _setSkillStorageForTest(stubSkillAdapter({ expectedName: "validating-llm-outputs" }));
    const { capturedPrompt } = await runAndCapturePrompt({ validate: "self" });
    expect(capturedPrompt).toContain(SENTINEL_BODY);
  });

  it("validate: 'external' → skill body NOT in prompt", async () => {
    _setSkillStorageForTest(stubSkillAdapter({}));
    const { capturedPrompt } = await runAndCapturePrompt({ validate: "external" });
    expect(capturedPrompt).not.toContain(SENTINEL_BODY);
  });

  it("validate: 'skip' → skill body NOT in prompt", async () => {
    _setSkillStorageForTest(stubSkillAdapter({}));
    const { capturedPrompt } = await runAndCapturePrompt({ validate: "skip" });
    expect(capturedPrompt).not.toContain(SENTINEL_BODY);
  });

  it("validate: { strategy: 'self', skill: 'custom-skill' } → loads the custom skill", async () => {
    _setSkillStorageForTest(stubSkillAdapter({ expectedName: "custom-skill" }));
    const { capturedPrompt } = await runAndCapturePrompt({
      validate: { strategy: "self", skill: "custom-skill" },
    });
    expect(capturedPrompt).toContain(SENTINEL_BODY);
  });

  it("validate omitted (auto) — read-only-fetcher shape → classifier picks 'skip', no skill body", async () => {
    _setSkillStorageForTest(stubSkillAdapter({}));
    const { capturedPrompt } = await runAndCapturePrompt({
      tools: ["search_messages", "get_gmail_thread"],
      outputType: "FetcherOutput",
    });
    expect(capturedPrompt).not.toContain(SENTINEL_BODY);
  });

  it("validate omitted (auto) — mutating-tool shape → classifier picks 'self', skill body injected", async () => {
    _setSkillStorageForTest(stubSkillAdapter({ expectedName: "validating-llm-outputs" }));
    const { capturedPrompt } = await runAndCapturePrompt({ tools: ["send_email"] });
    expect(capturedPrompt).toContain(SENTINEL_BODY);
  });
});
