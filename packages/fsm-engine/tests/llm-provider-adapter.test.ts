import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import type { ModelMessage } from "ai";
import { jsonSchema, tool } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Stream part shape matching StreamPart without importing @ai-sdk/provider */
type StreamPart = { type: string; [key: string]: unknown };

// Single boundary mock: registry resolution + provider options
const mockLanguageModel = vi.fn();
vi.mock("@atlas/llm", () => ({
  registry: { languageModel: mockLanguageModel },
  getDefaultProviderOpts: () => ({}),
  traceModel: (model: unknown) => model,
}));

const { AtlasLLMProviderAdapter } = await import("../llm-provider-adapter.ts");

/** Minimal LanguageModelV3 mock — avoids ai/test's msw peer dependency */
function createMockModel(chunks?: StreamPart[]) {
  type CallRecord = { prompt: Array<{ role: string; content: unknown[] }> };
  const doStreamCalls: CallRecord[] = [];
  const defaultChunks: StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "response text" },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      finishReason: "stop",
    },
  ];
  const parts = chunks ?? defaultChunks;
  return {
    model: {
      specificationVersion: "v3",
      provider: "mock-provider",
      modelId: "mock-model",
      supportedUrls: {},
      // deno-lint-ignore require-await
      doGenerate: async () => {
        throw new Error("Not implemented — adapter uses streamText");
      },
      // deno-lint-ignore require-await
      doStream: async (options: CallRecord) => {
        doStreamCalls.push(options);
        return {
          stream: new ReadableStream<StreamPart>({
            start(controller) {
              for (const part of parts) {
                controller.enqueue(part);
              }
              controller.close();
            },
          }),
        };
      },
    },
    doStreamCalls,
  };
}

describe("AtlasLLMProviderAdapter", () => {
  let doStreamCalls: ReturnType<typeof createMockModel>["doStreamCalls"];

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockModel();
    doStreamCalls = mock.doStreamCalls;
    mockLanguageModel.mockReturnValue(mock.model);
  });

  it("uses prompt when messages is absent", async () => {
    const adapter = new AtlasLLMProviderAdapter("default-model");

    const result = await adapter.call({
      agentId: "test-agent",
      model: "claude-sonnet-4-6",
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

    const messages: ModelMessage[] = [
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
      model: "claude-sonnet-4-6",
      prompt: "fallback prompt",
      messages,
    });

    expect(result).toMatchObject({
      agentId: "test-agent",
      input: "fallback prompt",
      ok: true,
      data: { response: "response text" },
    });

    // Verify messages were forwarded to streamText (not prompt string).
    // AI SDK normalizes ImagePart -> FilePart internally, so type is "file" at doStream.
    expect(doStreamCalls).toHaveLength(1);
    expect(doStreamCalls[0]).toHaveProperty(
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

  it("onStreamEvent receives tool-input-available and tool-output-available", async () => {
    // Model streams a tool call on first call, then text on second call.
    // streamText loops: step 1 produces tool-call, executes tool, step 2 produces text.
    const toolChunks: StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "tool-input-start", id: "tc1", toolName: "get_weather" },
      { type: "tool-input-delta", id: "tc1", delta: '{"city":"Tokyo"}' },
      { type: "tool-input-end", id: "tc1" },
      { type: "tool-call", toolCallId: "tc1", toolName: "get_weather", input: '{"city":"Tokyo"}' },
      {
        type: "finish",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        finishReason: "tool-calls",
      },
    ];
    const textChunks: StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "The weather is nice" },
      { type: "text-end", id: "t1" },
      {
        type: "finish",
        usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
        finishReason: "stop",
      },
    ];

    let callCount = 0;
    const mockModel = {
      specificationVersion: "v3",
      provider: "mock-provider",
      modelId: "mock-model",
      supportedUrls: {},
      // deno-lint-ignore require-await
      doGenerate: async () => {
        throw new Error("Not implemented — adapter uses streamText");
      },
      // deno-lint-ignore require-await
      doStream: async () => {
        const parts = callCount === 0 ? toolChunks : textChunks;
        callCount++;
        return {
          stream: new ReadableStream<StreamPart>({
            start(controller) {
              for (const part of parts) {
                controller.enqueue(part);
              }
              controller.close();
            },
          }),
        };
      },
    };
    mockLanguageModel.mockReturnValue(mockModel);

    const adapter = new AtlasLLMProviderAdapter("default-model");
    const receivedChunks: AtlasUIMessageChunk[] = [];

    const result = await adapter.call({
      agentId: "test-agent",
      model: "claude-sonnet-4-6",
      prompt: "what is the weather?",
      tools: {
        get_weather: tool({
          description: "Get weather",
          inputSchema: jsonSchema({ type: "object", properties: { city: { type: "string" } } }),
          execute: () => Promise.resolve({ temperature: 72 }),
        }),
      },
      onStreamEvent: (chunk) => {
        receivedChunks.push(chunk);
      },
    });

    expect(result.ok).toBe(true);

    const inputChunk = receivedChunks.find((c) => c.type === "tool-input-available");
    expect(inputChunk).toMatchObject({
      type: "tool-input-available",
      toolCallId: expect.any(String),
      toolName: "get_weather",
      input: { city: "Tokyo" },
    });

    const outputChunk = receivedChunks.find((c) => c.type === "tool-output-available");
    expect(outputChunk).toMatchObject({
      type: "tool-output-available",
      toolCallId: expect.any(String),
      output: { temperature: 72 },
    });
  });
});
