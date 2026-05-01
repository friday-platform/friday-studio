import type { AgentResult, ToolCall } from "@atlas/agent-sdk";
import type { ResourceStorageAdapter } from "@atlas/ledger";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryDocumentStore } from "../../document-store/node.ts";
import { FSMEngine } from "../fsm-engine.ts";
import type { FSMDefinition, FSMLLMOutput, LLMProvider } from "../types.ts";

const mockBatchGet = vi.hoisted(() => vi.fn());

vi.mock("@atlas/client/v2", () => ({
  client: { artifactsStorage: { "batch-get": { $post: mockBatchGet } } },
  parseResult: async (promise: Promise<unknown>) => {
    const result = await promise;
    return result;
  },
}));

vi.mock("@atlas/skills", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@atlas/skills")>();
  const empty = () => Promise.resolve({ ok: true, data: [] });
  return {
    ...actual,
    SkillStorage: {
      list: empty,
      listAssigned: empty,
      listAssignmentsForJob: empty,
      listJobOnlySkillIds: empty,
    },
  };
});

/** Convert simple mock data into the AgentResult envelope the engine expects. */
function mockLLMEnvelope(
  agentId: string,
  prompt: string,
  toolCalls: ToolCall[] = [],
): AgentResult<string, FSMLLMOutput> {
  return {
    agentId,
    timestamp: new Date().toISOString(),
    input: prompt,
    ok: true,
    data: { response: "done" },
    toolCalls,
    durationMs: 0,
  };
}

/** Scaffold an engine with a mock LLM provider that captures prompts. */
async function createLLMEngine(fsm: FSMDefinition) {
  const store = new InMemoryDocumentStore();
  const scope = { workspaceId: "test", sessionId: "test-session" };

  const capturedPrompts: string[] = [];

  const mockLLMProvider: LLMProvider = {
    call: (params) => {
      capturedPrompts.push(params.prompt);
      return Promise.resolve(mockLLMEnvelope(params.agentId, params.prompt));
    },
  };

  const engine = new FSMEngine(fsm, { documentStore: store, scope, llmProvider: mockLLMProvider });
  await engine.initialize();

  return { engine, store, scope, capturedPrompts };
}

describe("LLM prompt: input-only from prepare result", () => {
  beforeEach(() => {
    mockBatchGet.mockReset();
  });

  it("prompt includes temporal grounding before base prompt", async () => {
    const fsm: FSMDefinition = {
      id: "llm-datetime-test",
      initial: "idle",
      states: {
        idle: {
          on: {
            START: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  prompt: "Scan today's calendar",
                  model: "test-model",
                  outputTo: "result",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
    };

    const { engine, capturedPrompts } = await createLLMEngine(fsm);
    await engine.signal({ type: "START" });

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0];
    if (!prompt) throw new Error("Expected captured prompt");

    // Context Facts section with temporal grounding appears before the base prompt
    expect(prompt).toMatch(/^## Context Facts/);
    expect(prompt).toContain("Current Date:");
    expect(prompt).toContain("Current Time:");
    expect(prompt).toContain("Timestamp:");

    // Base prompt follows the facts section
    expect(prompt).toContain("Scan today's calendar");
    expect(prompt.indexOf("## Context Facts")).toBeLessThan(
      prompt.indexOf("Scan today's calendar"),
    );
  });

  it("prompt has no Input section when no prepare result", async () => {
    const fsm: FSMDefinition = {
      id: "llm-no-input-test",
      initial: "idle",
      states: {
        idle: {
          on: {
            START: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  prompt: "Do something",
                  model: "test-model",
                  outputTo: "result",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
    };

    const { engine, capturedPrompts } = await createLLMEngine(fsm);
    await engine.signal({ type: "START" });

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0];
    if (!prompt) throw new Error("Expected captured prompt");

    expect(prompt).not.toContain("Input:\n");
    expect(prompt).not.toContain("Available Documents:");
  });
});

describe("LLM prompt: workspace resource context", () => {
  /** Creates a ResourceStorageAdapter with all methods stubbed. */
  function createMockResourceAdapter(
    overrides: Partial<ResourceStorageAdapter> = {},
  ): ResourceStorageAdapter {
    return {
      init: vi.fn(),
      destroy: vi.fn(),
      provision: vi.fn(),
      query: vi.fn(),
      mutate: vi.fn(),
      publish: vi.fn<ResourceStorageAdapter["publish"]>().mockResolvedValue({ version: null }),
      replaceVersion: vi.fn(),
      listResources: vi.fn<ResourceStorageAdapter["listResources"]>().mockResolvedValue([]),
      getResource: vi.fn<ResourceStorageAdapter["getResource"]>().mockResolvedValue(null),
      deleteResource: vi.fn(),
      linkRef: vi.fn(),
      resetDraft: vi.fn(),
      publishAllDirty: vi.fn<ResourceStorageAdapter["publishAllDirty"]>().mockResolvedValue([]),
      getSkill: vi.fn<ResourceStorageAdapter["getSkill"]>().mockResolvedValue(""),
      ...overrides,
    };
  }

  it("includes resource tables in prompt when resourceAdapter is provided", async () => {
    const fsm: FSMDefinition = {
      id: "llm-resource-ctx-test",
      initial: "idle",
      states: {
        idle: {
          on: {
            START: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  prompt: "Update the application status",
                  model: "test-model",
                  outputTo: "result",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
    };

    const store = new InMemoryDocumentStore();
    const scope = { workspaceId: "test-ws", sessionId: "test-session" };
    const capturedPrompts: string[] = [];

    const mockLLMProvider: LLMProvider = {
      call: (params) => {
        capturedPrompts.push(params.prompt);
        return Promise.resolve(mockLLMEnvelope(params.agentId, params.prompt));
      },
    };

    const mockResourceAdapter = createMockResourceAdapter({
      listResources: vi.fn<ResourceStorageAdapter["listResources"]>().mockResolvedValue([
        {
          slug: "job_postings",
          type: "document",
          name: "Job Postings",
          description: "Job applications",
          id: "r1",
          userId: "u1",
          workspaceId: "test-ws",
          currentVersion: 1,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
        {
          slug: "contacts",
          type: "document",
          name: "Contacts",
          description: "Contact list",
          id: "r2",
          userId: "u1",
          workspaceId: "test-ws",
          currentVersion: 1,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
      ]),
      getSkill: vi
        .fn<ResourceStorageAdapter["getSkill"]>()
        .mockResolvedValue("# Resource Data Access (SQLite)\n\nMock skill text"),
    });

    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      llmProvider: mockLLMProvider,
      resourceAdapter: mockResourceAdapter,
    });
    await engine.initialize();

    await engine.signal({ type: "START" }, { sessionId: "test-session", workspaceId: "test-ws" });

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0];
    if (!prompt) throw new Error("Expected captured prompt");

    expect(prompt).toContain("## Workspace Resources");
    expect(prompt).toContain("resource_read for queries");
    expect(prompt).toContain("resource_write for mutations");
    expect(prompt).toContain("- job_postings: Job applications");
    expect(prompt).toContain("- contacts: Contact list");
    expect(prompt).toContain("# Resource Data Access (SQLite)");
    expect(mockResourceAdapter.getSkill).toHaveBeenCalledOnce();
  });

  it("omits resource section when no resources exist", async () => {
    const fsm: FSMDefinition = {
      id: "llm-no-resources-test",
      initial: "idle",
      states: {
        idle: {
          on: {
            START: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  prompt: "Do a thing",
                  model: "test-model",
                  outputTo: "result",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
    };

    const store = new InMemoryDocumentStore();
    const scope = { workspaceId: "test-ws", sessionId: "test-session" };
    const capturedPrompts: string[] = [];

    const mockLLMProvider: LLMProvider = {
      call: (params) => {
        capturedPrompts.push(params.prompt);
        return Promise.resolve(mockLLMEnvelope(params.agentId, params.prompt));
      },
    };

    const mockResourceAdapter = createMockResourceAdapter();

    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      llmProvider: mockLLMProvider,
      resourceAdapter: mockResourceAdapter,
    });
    await engine.initialize();

    await engine.signal({ type: "START" }, { sessionId: "test-session", workspaceId: "test-ws" });

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0];
    if (!prompt) throw new Error("Expected captured prompt");

    expect(prompt).not.toContain("## Workspace Resources");
  });
});
