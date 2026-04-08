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
  return { ...actual, SkillStorage: { list: empty, listUnassigned: empty, listAssigned: empty } };
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

  it("prompt contains Input section from prepare result and no Available Documents", async () => {
    const fsm: FSMDefinition = {
      id: "llm-input-test",
      initial: "idle",
      states: {
        idle: {
          on: {
            START: {
              target: "done",
              actions: [
                { type: "code", function: "prepare" },
                {
                  type: "llm",
                  provider: "test",
                  prompt: "Analyze the data",
                  model: "test-model",
                  outputTo: "result",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      functions: {
        prepare: {
          type: "action",
          code: `export default function prepare() { return { task: "Analyze", config: { format: "csv" } }; }`,
        },
      },
    };

    const { engine, capturedPrompts } = await createLLMEngine(fsm);
    await engine.signal({ type: "START" });

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0];
    if (!prompt) throw new Error("Expected captured prompt");

    // Should contain Input section with the prepare result JSON
    expect(prompt).toContain("Input:\n");
    expect(prompt).toContain('"task"');
    expect(prompt).toContain('"Analyze"');
    expect(prompt).toContain('"format"');
    expect(prompt).toContain('"csv"');

    // Should NOT contain the old Available Documents section
    expect(prompt).not.toContain("Available Documents:");
  });

  it("artifact refs in prepare result are expanded in Input section", async () => {
    // Set up mock to return artifact content
    mockBatchGet.mockResolvedValueOnce({
      ok: true,
      data: {
        artifacts: [
          { id: "art-123", data: { type: "report", version: 1, data: "Full report content here" } },
        ],
      },
    });

    const fsm: FSMDefinition = {
      id: "llm-artifact-test",
      initial: "idle",
      states: {
        idle: {
          on: {
            START: {
              target: "done",
              actions: [
                { type: "code", function: "prepare" },
                {
                  type: "llm",
                  provider: "test",
                  prompt: "Summarize the report",
                  model: "test-model",
                  outputTo: "result",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      functions: {
        prepare: {
          type: "action",
          code: `export default function prepare() {
            return {
              task: "Summarize",
              artifactRefs: [{ id: "art-123", type: "report", summary: "A report" }],
            };
          }`,
        },
      },
    };

    const { engine, capturedPrompts } = await createLLMEngine(fsm);
    await engine.signal({ type: "START" });

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0];
    if (!prompt) throw new Error("Expected captured prompt");

    // Expanded artifact content should appear in the Input section
    expect(prompt).toContain("Input:\n");
    expect(prompt).toContain("artifactContent");
    expect(prompt).toContain("Full report content here");
    expect(prompt).not.toContain("Available Documents:");
  });

  it("agent artifactRefs in context.results are merged into LLM prompt when prepare result omits them", async () => {
    // Reproduces: https://github.com/tempestteam/atlas/issues/dried-mushroom
    // Scenario: code action returns prepareResult with only .response/.config,
    // but a preceding agent action stored artifactRefs in context.results.
    // The LLM step should still see the expanded artifact content.
    mockBatchGet.mockResolvedValueOnce({
      ok: true,
      data: {
        artifacts: [
          {
            id: "agent-art-456",
            data: {
              mentions: [
                { title: "G2 Review", source: "G2", url: "https://g2.com/bucketlist" },
                {
                  title: "ADP Listing",
                  source: "ADP Marketplace",
                  url: "https://apps.adp.com/bucketlist",
                },
              ],
            },
          },
        ],
      },
    });

    const fsm: FSMDefinition = {
      id: "agent-artifact-to-llm-test",
      initial: "idle",
      states: {
        idle: {
          on: {
            START: {
              target: "done",
              actions: [
                // 1. Agent returns structured data in artifact, prose in .response
                {
                  type: "agent",
                  agentId: "search",
                  outputTo: "search-result",
                  prompt: "Search for brand mentions",
                },
                // 2. Prepare function reads only .response (mimics compiled workspace pattern)
                { type: "code", function: "prepare" },
                // 3. LLM should see BOTH prepare config AND agent's artifact content
                {
                  type: "llm",
                  provider: "test",
                  prompt: "Format the verified mentions into a digest",
                  model: "test-model",
                  outputTo: "digest",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      functions: {
        prepare: {
          type: "action",
          code: `export default function prepare(context) {
            const config = {};
            config['verifiedMentions'] = context.results['search-result']?.response;
            return { task: 'Format mentions into digest', config };
          }`,
        },
      },
    };

    const store = new InMemoryDocumentStore();
    const scope = { workspaceId: "test", sessionId: "test-session" };
    const capturedPrompts: string[] = [];

    const mockLLMProvider: LLMProvider = {
      call: (params) => {
        capturedPrompts.push(params.prompt);
        return Promise.resolve(mockLLMEnvelope(params.agentId, params.prompt));
      },
    };

    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      llmProvider: mockLLMProvider,
      agentExecutor: (action: { agentId: string }) =>
        Promise.resolve({
          agentId: action.agentId,
          timestamp: new Date().toISOString(),
          input: "",
          ok: true as const,
          data: { response: "All 9 URLs confirmed valid. No broken links found." },
          artifactRefs: [{ id: "agent-art-456", type: "web-search", summary: "Verified mentions" }],
          durationMs: 100,
        } as AgentResult<string, Record<string, unknown>>),
    });
    await engine.initialize();

    await engine.signal({ type: "START" });

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0];
    if (!prompt) throw new Error("Expected captured prompt");

    // Prepare result's config should be present
    expect(prompt).toContain("Input:\n");
    expect(prompt).toContain("verifiedMentions");

    // Agent's artifact content should ALSO be expanded in the prompt
    expect(prompt).toContain("artifactContent");
    expect(prompt).toContain("agent-art-456");
    expect(prompt).toContain("G2 Review");
    expect(prompt).toContain("https://g2.com/bucketlist");
  });

  it("agent artifactRefs are NOT merged when prepare result already includes its own", async () => {
    // Only the prepare's artifact should be fetched — not the agent's
    mockBatchGet.mockResolvedValueOnce({
      ok: true,
      data: {
        artifacts: [{ id: "prepare-art-789", data: { curated: "Hand-picked top 3 mentions" } }],
      },
    });

    const fsm: FSMDefinition = {
      id: "agent-artifact-no-override-test",
      initial: "idle",
      states: {
        idle: {
          on: {
            START: {
              target: "done",
              actions: [
                {
                  type: "agent",
                  agentId: "search",
                  outputTo: "search-result",
                  prompt: "Search for brand mentions",
                },
                { type: "code", function: "prepare" },
                {
                  type: "llm",
                  provider: "test",
                  prompt: "Format the curated mentions",
                  model: "test-model",
                  outputTo: "digest",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      functions: {
        prepare: {
          type: "action",
          code: `export default function prepare(context) {
            return {
              task: 'Format curated mentions',
              config: { source: context.results['search-result']?.response },
              artifactRefs: [{ id: "prepare-art-789", type: "curated", summary: "Curated list" }],
            };
          }`,
        },
      },
    };

    const store = new InMemoryDocumentStore();
    const scope = { workspaceId: "test", sessionId: "test-session" };
    const capturedPrompts: string[] = [];

    const mockLLMProvider: LLMProvider = {
      call: (params) => {
        capturedPrompts.push(params.prompt);
        return Promise.resolve(mockLLMEnvelope(params.agentId, params.prompt));
      },
    };

    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      llmProvider: mockLLMProvider,
      agentExecutor: (action: { agentId: string }) =>
        Promise.resolve({
          agentId: action.agentId,
          timestamp: new Date().toISOString(),
          input: "",
          ok: true as const,
          data: { response: "Found 9 mentions" },
          artifactRefs: [
            { id: "agent-art-456", type: "web-search", summary: "Raw search results" },
          ],
          durationMs: 100,
        } as AgentResult<string, Record<string, unknown>>),
    });
    await engine.initialize();

    await engine.signal({ type: "START" });

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0];
    if (!prompt) throw new Error("Expected captured prompt");

    // Prepare's artifact should be expanded
    expect(prompt).toContain("prepare-art-789");
    expect(prompt).toContain("Hand-picked top 3 mentions");

    // Agent's artifact should NOT appear — prepare explicitly provided its own refs
    expect(prompt).not.toContain("agent-art-456");
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
