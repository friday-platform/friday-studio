import type { CoreMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Single boundary mock: registry resolution + provider options
const mockLanguageModel = vi.fn();
vi.mock("@atlas/llm", () => ({
  registry: { languageModel: mockLanguageModel },
  getDefaultProviderOpts: () => ({}),
}));

const { AtlasLLMProviderAdapter } = await import("../llm-provider-adapter.ts");

/** Minimal LanguageModelV2 mock — avoids ai/test's msw peer dependency */
function createMockModel() {
  type CallRecord = { prompt: Array<{ role: string; content: unknown[] }> };
  const doGenerateCalls: CallRecord[] = [];
  return {
    model: {
      specificationVersion: "v2",
      provider: "mock-provider",
      modelId: "mock-model",
      supportedUrls: {},
      doGenerate: (options: CallRecord) => {
        doGenerateCalls.push(options);
        return {
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          content: [{ type: "text", text: "response text" }],
          warnings: [],
        };
      },
      doStream: () => {
        throw new Error("Not implemented");
      },
    },
    doGenerateCalls,
  };
}

describe("AtlasLLMProviderAdapter", () => {
  let doGenerateCalls: ReturnType<typeof createMockModel>["doGenerateCalls"];

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockModel();
    doGenerateCalls = mock.doGenerateCalls;
    mockLanguageModel.mockReturnValue(mock.model);
  });

  it("uses prompt when messages is absent", async () => {
    const adapter = new AtlasLLMProviderAdapter("default-model");

    const result = await adapter.call({
      agentId: "test-agent",
      model: "claude-sonnet-4-5-20250929",
      prompt: "do the thing",
    });

    expect(result).toMatchObject({
      agentId: "test-agent",
      input: "do the thing",
      ok: true,
      data: { response: "response text" },
      toolCalls: [],
      toolResults: [],
    });
  });

  it("uses messages with image parts when present", async () => {
    const adapter = new AtlasLLMProviderAdapter("default-model");

    const messages: CoreMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this image" },
          { type: "image", image: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
        ],
      },
    ];

    const result = await adapter.call({
      agentId: "test-agent",
      model: "claude-sonnet-4-5-20250929",
      prompt: "fallback prompt",
      messages,
    });

    expect(result).toMatchObject({
      agentId: "test-agent",
      input: "fallback prompt",
      ok: true,
      data: { response: "response text" },
    });

    // Verify messages were forwarded to generateText (not prompt string).
    // AI SDK normalizes ImagePart → FilePart internally, so type is "file" at doGenerate.
    expect(doGenerateCalls).toHaveLength(1);
    expect(doGenerateCalls[0]).toHaveProperty(
      "prompt",
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "describe this image" }),
            expect.objectContaining({
              type: "file",
              mediaType: "image/png",
              data: new Uint8Array([1, 2, 3]),
            }),
          ]),
        }),
      ]),
    );
  });
});
