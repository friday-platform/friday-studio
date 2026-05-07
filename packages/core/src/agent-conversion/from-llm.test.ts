/**
 * H3 (melodic-strolling-seal-pt3). Audit of B6's `toolChoice` claims at
 * the orchestrator side — the `case "agent"` execution path that flows
 * `case "agent"` (FSM) → `convertLLMToAgent` (here). B6 (1d57456)
 * introduced the `record_validation` tool injection + `toolChoice`
 * resolution rule symmetrically across both call sites, but no test
 * pinned the orchestrator side: `validate-agent-action.test.ts` only
 * verifies decision threading (not what the orchestrator does with it),
 * and `validate-decision.test.ts` only covers the wire format.
 *
 * E1 (1c8edab) added `hasOutputType` to skip `record_validation`
 * injection on the structured + self path. E1.1 (3aa8796) extended the
 * skip to the validation skill body. This test pins both:
 *
 *   - The injection rule (`record_validation` only when self && !outputType)
 *   - The skill body composition rule (skip body on self && outputType)
 *
 * The case "llm" inline path (FSM-side) is covered by
 * `packages/fsm-engine/tests/validation-with-output-type.test.ts`.
 *
 * Note on toolChoice: the orchestrator (this file) sets
 * `toolChoice: config.config.tool_choice || "auto"` independent of the
 * validation decision — structured-output forcing happens via
 * `outputSchema` wired into the agent's `outputSchema` field, NOT via
 * toolChoice pinning the way the FSM `case "llm"` site does. So at the
 * orchestrator boundary the `toolChoice` story is uniform: whatever the
 * author configured, default `auto`. The structured/free-form contrast
 * lives in the *tool-set* (record_validation present or not) and the
 * *system prompt* (skill body composed or not). Tests below assert
 * those two, and assert toolChoice equals the author's config across
 * all six crossings to confirm the orchestrator does not silently
 * override it on any validation path.
 */

import type { AgentContext, StreamEmitter } from "@atlas/agent-sdk";
import type { LLMAgentConfig } from "@atlas/config";
import { createStubPlatformModels } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { _setSkillStorageForTest, type SkillStorageAdapter } from "@atlas/skills";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildValidateDecisionConfig } from "../agent-context/validate-decision.ts";

const SENTINEL_BODY = "<<<H3-VALIDATING-LLM-OUTPUTS-SKILL-BODY>>>";

const mockStreamText = vi.hoisted(() => vi.fn());
const mockRegistryLanguageModel = vi.hoisted(() => vi.fn(() => "mock-model"));
const mockTraceModel = vi.hoisted(() => vi.fn((m: unknown) => m));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, streamText: mockStreamText };
});

vi.mock("@atlas/llm", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    registry: { languageModel: mockRegistryLanguageModel },
    traceModel: mockTraceModel,
  };
});

// Imported AFTER mocks land — `convertLLMToAgent` captures `streamText`
// at module-eval time inside its handler closure, so the mock must be
// registered before the import resolves.
const { convertLLMToAgent } = await import("./from-llm.ts");

function makeMockStreamTextResult() {
  return {
    text: Promise.resolve(""),
    reasoningText: Promise.resolve(""),
    toolCalls: Promise.resolve([]),
    toolResults: Promise.resolve([]),
    steps: Promise.resolve([]),
    usage: Promise.resolve({ promptTokens: 0, completionTokens: 0 }),
  };
}

function makeLogger(): Logger {
  const noop = () => {};
  const logger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
}

function makeStreamEmitter(): StreamEmitter {
  return { emit: () => {}, end: () => {}, error: () => {} };
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
  systemPrompt: string;
}

function buildLLMConfig(): LLMAgentConfig {
  return {
    type: "llm",
    description: "test agent",
    config: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      prompt: "you are a test agent",
      temperature: 0.3,
    },
  };
}

function buildContext(opts: {
  decision: "skip" | "self" | "external";
  hasOutputType: boolean;
  skill?: string;
}): AgentContext {
  const validateConfig = buildValidateDecisionConfig(opts.decision, opts.skill, opts.hasOutputType);
  return {
    tools: {},
    session: { sessionId: "h3-sess", workspaceId: "h3-ws" },
    env: {},
    config: validateConfig,
    stream: makeStreamEmitter(),
    logger: makeLogger(),
    platformModels: createStubPlatformModels(),
  };
}

async function runOrchestrator(opts: {
  decision: "skip" | "self" | "external";
  hasOutputType: boolean;
}): Promise<CapturedCall> {
  let captured: CapturedCall | undefined;
  mockStreamText.mockImplementation((params: Record<string, unknown>) => {
    const messages = params.messages as Array<{ role: string; content: unknown }> | undefined;
    const systemMsg = messages?.find((m) => m.role === "system");
    const systemPrompt = typeof systemMsg?.content === "string" ? systemMsg.content : "";
    captured = {
      tools: Object.keys((params.tools as Record<string, unknown>) ?? {}),
      toolChoice: params.toolChoice,
      systemPrompt,
    };
    return makeMockStreamTextResult();
  });

  const agent = convertLLMToAgent(buildLLMConfig(), "h3-test-agent", makeLogger());
  const context = buildContext(opts);
  const result = await agent.execute("hello", context);
  if (!result.ok) {
    throw new Error(`agent.execute failed: ${result.error}`);
  }
  if (!captured) throw new Error("streamText was not invoked");
  return captured;
}

describe("H3: convertLLMToAgent toolChoice + tool injection audit (B6 / E1 / E1.1)", () => {
  beforeEach(() => {
    mockStreamText.mockReset();
    _setSkillStorageForTest(stubSkillAdapter());
  });

  afterEach(() => {
    _setSkillStorageForTest(null);
  });

  // -------------------------------------------------------------------
  // Structured (hasOutputType: true) crossings — E1 + E1.1 enforced
  // -------------------------------------------------------------------

  it("structured + skip → no record_validation, no skill body, toolChoice 'auto'", async () => {
    const call = await runOrchestrator({ decision: "skip", hasOutputType: true });
    expect(call.tools).not.toContain("record_validation");
    expect(call.systemPrompt).not.toContain(SENTINEL_BODY);
    // Author didn't set tool_choice; orchestrator defaults to "auto".
    expect(call.toolChoice).toBe("auto");
  });

  it("structured + self → no record_validation (E1), no skill body (E1.1), toolChoice 'auto'", async () => {
    const call = await runOrchestrator({ decision: "self", hasOutputType: true });
    // E1: structured-output skip suppresses tool injection.
    expect(call.tools).not.toContain("record_validation");
    // E1.1: skill body is also skipped on this path (would otherwise tell
    // the LLM to call a tool that doesn't exist).
    expect(call.systemPrompt).not.toContain(SENTINEL_BODY);
    expect(call.toolChoice).toBe("auto");
  });

  it("structured + external → no record_validation, no skill body, toolChoice 'auto'", async () => {
    const call = await runOrchestrator({ decision: "external", hasOutputType: true });
    expect(call.tools).not.toContain("record_validation");
    expect(call.systemPrompt).not.toContain(SENTINEL_BODY);
    expect(call.toolChoice).toBe("auto");
  });

  // -------------------------------------------------------------------
  // Free-form (hasOutputType: false) crossings — B6 baseline
  // -------------------------------------------------------------------

  it("free-form + skip → no record_validation, no skill body, toolChoice 'auto'", async () => {
    const call = await runOrchestrator({ decision: "skip", hasOutputType: false });
    expect(call.tools).not.toContain("record_validation");
    expect(call.systemPrompt).not.toContain(SENTINEL_BODY);
    expect(call.toolChoice).toBe("auto");
  });

  it("free-form + self → record_validation IS injected, skill body composed, toolChoice 'auto'", async () => {
    const call = await runOrchestrator({ decision: "self", hasOutputType: false });
    expect(call.tools).toContain("record_validation");
    expect(call.systemPrompt).toContain(SENTINEL_BODY);
    expect(call.toolChoice).toBe("auto");
  });

  it("free-form + external → no record_validation, no skill body, toolChoice 'auto'", async () => {
    const call = await runOrchestrator({ decision: "external", hasOutputType: false });
    expect(call.tools).not.toContain("record_validation");
    expect(call.systemPrompt).not.toContain(SENTINEL_BODY);
    expect(call.toolChoice).toBe("auto");
  });
});
