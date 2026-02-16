import type { AgentResult, ToolCall } from "@atlas/agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { InMemoryDocumentStore } from "../../document-store/node.ts";
import { FSMEngine } from "../fsm-engine.ts";
import type { FSMDefinition, FSMLLMOutput, LLMProvider } from "../types.ts";

vi.mock("@atlas/client/v2", () => {
  const mockBatchGet = vi.fn();
  return {
    client: { artifactsStorage: { "batch-get": { $post: mockBatchGet } } },
    parseResult: async (promise: Promise<unknown>) => {
      const result = await promise;
      return result;
    },
    __mockBatchGet: mockBatchGet,
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
    const { __mockBatchGet } = (await import("@atlas/client/v2")) as unknown as {
      __mockBatchGet: ReturnType<typeof vi.fn>;
    };
    __mockBatchGet.mockResolvedValueOnce({
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
