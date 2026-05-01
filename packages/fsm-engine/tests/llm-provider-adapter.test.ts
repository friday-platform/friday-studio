import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import type { ModelMessage } from "ai";
import { jsonSchema, tool } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Single boundary mock: registry resolution + provider options + tracing
const mockLanguageModel = vi.fn();
const mockTraceModel = vi.fn((model: unknown) => model);
const REGISTRY_PROVIDERS = ["anthropic", "claude-code", "google", "groq", "openai"] as const;
vi.mock("@atlas/llm", () => ({
  registry: { languageModel: mockLanguageModel },
  getDefaultProviderOpts: () => ({}),
  traceModel: (model: unknown) => mockTraceModel(model),
  isRegistryProvider: (p: string) => (REGISTRY_PROVIDERS as readonly string[]).includes(p),
  buildRegistryModelId: (provider: string, model: string) => `${provider}:${model}`,
}));

const { AtlasLLMProviderAdapter } = await import("../llm-provider-adapter.ts");

/** Minimal LanguageModelV3 mock — avoids ai/test's msw peer dependency */
function createMockModel(opts?: {
  chunks?: LanguageModelV3StreamPart[];
  provider?: string;
  modelId?: string;
}): { model: LanguageModelV3; doStreamCalls: LanguageModelV3CallOptions[] } {
  const doStreamCalls: LanguageModelV3CallOptions[] = [];
  const defaultChunks: LanguageModelV3StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "response text" },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      usage: {
        inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: undefined, reasoning: undefined },
      },
      finishReason: { unified: "stop", raw: undefined } satisfies LanguageModelV3FinishReason,
    },
  ];
  const parts = opts?.chunks ?? defaultChunks;
  const model: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: opts?.provider ?? "anthropic",
    modelId: opts?.modelId ?? "mock-model",
    supportedUrls: {},
    // deno-lint-ignore require-await
    doGenerate: async () => {
      throw new Error("Not implemented — adapter uses streamText");
    },
    // deno-lint-ignore require-await
    doStream: async (options: LanguageModelV3CallOptions) => {
      doStreamCalls.push(options);
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
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
  return { model, doStreamCalls };
}

describe("AtlasLLMProviderAdapter", () => {
  let defaultMock: ReturnType<typeof createMockModel>;
  let doStreamCalls: ReturnType<typeof createMockModel>["doStreamCalls"];

  beforeEach(() => {
    vi.clearAllMocks();
    defaultMock = createMockModel();
    doStreamCalls = defaultMock.doStreamCalls;
    mockLanguageModel.mockReturnValue(defaultMock.model);
  });

  it("uses prompt when messages is absent", async () => {
    const adapter = new AtlasLLMProviderAdapter(defaultMock.model);

    const result = await adapter.call({ agentId: "test-agent", model: "", prompt: "do the thing" });

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
    const adapter = new AtlasLLMProviderAdapter(defaultMock.model);

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
      model: "",
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
    const toolChunks: LanguageModelV3StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "tool-input-start", id: "tc1", toolName: "get_weather" },
      { type: "tool-input-delta", id: "tc1", delta: '{"city":"Tokyo"}' },
      { type: "tool-input-end", id: "tc1" },
      { type: "tool-call", toolCallId: "tc1", toolName: "get_weather", input: '{"city":"Tokyo"}' },
      {
        type: "finish",
        usage: {
          inputTokens: {
            total: 10,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 20, text: undefined, reasoning: undefined },
        },
        finishReason: {
          unified: "tool-calls",
          raw: undefined,
        } satisfies LanguageModelV3FinishReason,
      },
    ];
    const textChunks: LanguageModelV3StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "The weather is nice" },
      { type: "text-end", id: "t1" },
      {
        type: "finish",
        usage: {
          inputTokens: {
            total: 5,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 10, text: undefined, reasoning: undefined },
        },
        finishReason: { unified: "stop", raw: undefined } satisfies LanguageModelV3FinishReason,
      },
    ];

    let callCount = 0;
    const mockModel: LanguageModelV3 = {
      specificationVersion: "v3",
      provider: "anthropic",
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
          stream: new ReadableStream<LanguageModelV3StreamPart>({
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

    const adapter = new AtlasLLMProviderAdapter(mockModel);
    const receivedChunks: AtlasUIMessageChunk[] = [];

    const result = await adapter.call({
      agentId: "test-agent",
      model: "",
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

  it("default-model path: uses the stored instance directly when params.model is empty", async () => {
    const stored = createMockModel({ provider: "anthropic", modelId: "stored-model" });
    const adapter = new AtlasLLMProviderAdapter(stored.model);

    const result = await adapter.call({ agentId: "test-agent", model: "", prompt: "hello" });

    expect(result.ok).toBe(true);
    // The stored model's own doStream was invoked — not a registry-resolved override.
    expect(stored.doStreamCalls).toHaveLength(1);
    // Registry was never asked, because no override was requested.
    expect(mockLanguageModel).not.toHaveBeenCalled();
  });

  it("per-call override path: resolves `${params.provider}:${params.model}` via registry + traceModel", async () => {
    const stored = createMockModel({ provider: "anthropic", modelId: "stored-model" });
    const override = createMockModel({ provider: "anthropic", modelId: "claude-opus-4-6" });
    mockLanguageModel.mockReturnValue(override.model);

    const adapter = new AtlasLLMProviderAdapter(stored.model);

    const result = await adapter.call({
      agentId: "test-agent",
      model: "claude-opus-4-6",
      provider: "anthropic",
      prompt: "hello",
    });

    expect(result.ok).toBe(true);
    expect(mockLanguageModel).toHaveBeenCalledWith("anthropic:claude-opus-4-6");
    // The override (not the stored model) was the one streamText invoked.
    expect(override.doStreamCalls).toHaveLength(1);
    expect(stored.doStreamCalls).toHaveLength(0);
    // traceModel was applied to the override result.
    expect(mockTraceModel).toHaveBeenCalledWith(override.model);
  });

  it("forwards providerOptions from constructor opts to streamText", async () => {
    const stored = createMockModel({ provider: "anthropic", modelId: "stored-model" });
    const adapter = new AtlasLLMProviderAdapter(stored.model, {
      providerOptions: { temperature: 0.42, topP: 0.9 },
    });

    const result = await adapter.call({ agentId: "test-agent", model: "", prompt: "hello" });

    expect(result.ok).toBe(true);
    expect(stored.doStreamCalls).toHaveLength(1);
    // Verify constructor providerOptions are forwarded through streamText to doStream
    expect(stored.doStreamCalls[0]?.temperature).toBe(0.42);
    expect(stored.doStreamCalls[0]?.topP).toBe(0.9);
  });

  it("per-call override uses provider param to resolve model", async () => {
    // AI SDK providers set .provider to surface-qualified names like "anthropic.messages",
    // not bare registry keys like "anthropic". The adapter must use the explicit
    // params.provider for override resolution, not this.defaultModel.provider.
    const stored = createMockModel({ provider: "anthropic.messages", modelId: "stored-model" });
    const override = createMockModel({
      provider: "anthropic.messages",
      modelId: "claude-opus-4-6",
    });
    mockLanguageModel.mockReturnValue(override.model);

    const adapter = new AtlasLLMProviderAdapter(stored.model);

    const result = await adapter.call({
      agentId: "test-agent",
      model: "claude-opus-4-6",
      provider: "anthropic",
      prompt: "hello",
    });

    expect(result.ok).toBe(true);
    expect(mockLanguageModel).toHaveBeenCalledWith("anthropic:claude-opus-4-6");
    expect(override.doStreamCalls).toHaveLength(1);
    expect(stored.doStreamCalls).toHaveLength(0);
  });
});
