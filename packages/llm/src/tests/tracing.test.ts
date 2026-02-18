import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { enterTraceScope, type TraceEntry, traceModel } from "../tracing.ts";

const MINIMAL_OPTS: Pick<LanguageModelV2CallOptions, "prompt"> = {
  prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

function opts(
  prompt: LanguageModelV2CallOptions["prompt"],
): Pick<LanguageModelV2CallOptions, "prompt"> {
  return { prompt };
}

/** Get first element or throw — use after toHaveLength assertion. */
function first<T>(arr: T[]): T {
  const item = arr[0];
  if (item === undefined) throw new Error("expected non-empty array");
  return item;
}

function createMockModel(overrides?: { modelId?: string }): LanguageModelV2 {
  const modelId = overrides?.modelId ?? "test-provider:test-model";
  return {
    specificationVersion: "v2",
    provider: "test-provider",
    modelId,
    supportedUrls: {},
    // deno-lint-ignore require-await
    doGenerate: async () => ({
      content: [
        { type: "text" as const, text: "Hello world" },
        {
          type: "tool-call" as const,
          toolCallId: "call-1",
          toolName: "get_weather",
          input: '{"city":"Tokyo"}',
        },
      ],
      finishReason: "stop" as const,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      warnings: [],
    }),
    // deno-lint-ignore require-await
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "Hello " });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "world" });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({ type: "tool-input-start", id: "tc1", toolName: "get_weather" });
          controller.enqueue({ type: "tool-input-delta", id: "tc1", delta: '{"city":' });
          controller.enqueue({ type: "tool-input-delta", id: "tc1", delta: '"Tokyo"}' });
          controller.enqueue({ type: "tool-input-end", id: "tc1" });
          controller.enqueue({
            type: "finish",
            usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 },
            finishReason: "stop",
          });
          controller.close();
        },
      }),
    }),
  };
}

/** Consume a ReadableStream to completion */
async function drainStream(stream: ReadableStream<LanguageModelV2StreamPart>): Promise<void> {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    // consume
  }
}

describe("tracing", () => {
  describe("enterTraceScope", () => {
    it("makes collector available within scope", async () => {
      const traces: TraceEntry[] = [];
      const model = traceModel(createMockModel());

      await enterTraceScope(traces, async () => {
        await model.doGenerate(MINIMAL_OPTS);
      });

      expect(traces).toHaveLength(1);
    });
  });

  describe("wrapGenerate", () => {
    it("captures input, output, usage, timing, and modelId", async () => {
      const traces: TraceEntry[] = [];
      const model = traceModel(createMockModel({ modelId: "anthropic:claude-sonnet-4-5" }));

      await enterTraceScope(traces, async () => {
        await model.doGenerate(
          opts([
            { role: "system", content: "You are helpful" },
            { role: "user", content: [{ type: "text", text: "What's the weather?" }] },
          ]),
        );
      });

      expect(traces).toHaveLength(1);
      const trace = first(traces);

      expect(trace.type).toBe("generate");
      expect(trace.modelId).toBe("anthropic:claude-sonnet-4-5");
      expect(trace.input).toEqual([
        { role: "system", content: "You are helpful" },
        { role: "user", content: [{ type: "text", text: "What's the weather?" }] },
      ]);
      expect(trace.output.text).toBe("Hello world");
      expect(trace.output.toolCalls).toEqual([{ name: "get_weather", input: { city: "Tokyo" } }]);
      expect(trace.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
      expect(trace.startMs).toBeGreaterThanOrEqual(0);
      expect(trace.endMs).toBeGreaterThanOrEqual(trace.startMs);
    });
  });

  describe("wrapStream", () => {
    it("captures aggregated output after stream completion", async () => {
      const traces: TraceEntry[] = [];
      const model = traceModel(createMockModel({ modelId: "groq:llama-3" }));

      await enterTraceScope(traces, async () => {
        const { stream } = await model.doStream(MINIMAL_OPTS);
        await drainStream(stream);
      });

      expect(traces).toHaveLength(1);
      const trace = first(traces);

      expect(trace.type).toBe("stream");
      expect(trace.modelId).toBe("groq:llama-3");
      expect(trace.output.text).toBe("Hello world");
      expect(trace.output.toolCalls).toEqual([{ name: "get_weather", input: { city: "Tokyo" } }]);
      expect(trace.usage).toEqual({ inputTokens: 80, outputTokens: 40, totalTokens: 120 });
      expect(trace.startMs).toBeGreaterThanOrEqual(0);
      expect(trace.endMs).toBeGreaterThanOrEqual(trace.startMs);
    });
  });

  describe("no-op outside scope", () => {
    it("passes through without error when no scope is active", async () => {
      const model = traceModel(createMockModel());

      const result = await model.doGenerate(MINIMAL_OPTS);

      expect(result.content).toHaveLength(2);
      expect(result.content[0]).toEqual({ type: "text", text: "Hello world" });
    });

    it("stream passes through without error when no scope is active", async () => {
      const model = traceModel(createMockModel());

      const { stream } = await model.doStream(MINIMAL_OPTS);
      await drainStream(stream);
      // No error = pass
    });
  });

  describe("multiple calls in one scope", () => {
    it("collects all traces in order", async () => {
      const traces: TraceEntry[] = [];
      const model = traceModel(createMockModel());

      await enterTraceScope(traces, async () => {
        await model.doGenerate(
          opts([{ role: "user", content: [{ type: "text", text: "first" }] }]),
        );
        await model.doGenerate(
          opts([{ role: "user", content: [{ type: "text", text: "second" }] }]),
        );
      });

      expect(traces).toHaveLength(2);
      expect(traces[0]?.input[0]).toEqual({
        role: "user",
        content: [{ type: "text", text: "first" }],
      });
      expect(traces[1]?.input[0]).toEqual({
        role: "user",
        content: [{ type: "text", text: "second" }],
      });
    });
  });

  describe("interleaved stream tool calls", () => {
    it("correlates deltas by id, not position", async () => {
      const traces: TraceEntry[] = [];
      const model = traceModel({
        specificationVersion: "v2",
        provider: "test-provider",
        modelId: "test-provider:test-model",
        supportedUrls: {},
        // deno-lint-ignore require-await
        doGenerate: async () => {
          throw new Error("not used");
        },
        // deno-lint-ignore require-await
        doStream: async () => ({
          stream: new ReadableStream<LanguageModelV2StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              // Two tool calls with interleaved chunks
              controller.enqueue({ type: "tool-input-start", id: "tc1", toolName: "get_weather" });
              controller.enqueue({ type: "tool-input-start", id: "tc2", toolName: "get_time" });
              controller.enqueue({ type: "tool-input-delta", id: "tc1", delta: '{"city":' });
              controller.enqueue({ type: "tool-input-delta", id: "tc2", delta: '{"tz":' });
              controller.enqueue({ type: "tool-input-delta", id: "tc1", delta: '"Paris"}' });
              controller.enqueue({ type: "tool-input-delta", id: "tc2", delta: '"UTC"}' });
              controller.enqueue({ type: "tool-input-end", id: "tc1" });
              controller.enqueue({ type: "tool-input-end", id: "tc2" });
              controller.enqueue({
                type: "finish",
                usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
                finishReason: "stop",
              });
              controller.close();
            },
          }),
        }),
      });

      await enterTraceScope(traces, async () => {
        const { stream } = await model.doStream(MINIMAL_OPTS);
        await drainStream(stream);
      });

      expect(traces).toHaveLength(1);
      const trace = first(traces);
      expect(trace.output.toolCalls).toEqual([
        { name: "get_weather", input: { city: "Paris" } },
        { name: "get_time", input: { tz: "UTC" } },
      ]);
    });
  });

  describe("malformed tool call JSON", () => {
    it("generate still returns result and captures trace with raw input", async () => {
      const traces: TraceEntry[] = [];
      const model = traceModel({
        specificationVersion: "v2",
        provider: "test-provider",
        modelId: "test-provider:test-model",
        supportedUrls: {},
        // deno-lint-ignore require-await
        doGenerate: async () => ({
          content: [
            { type: "text" as const, text: "result" },
            {
              type: "tool-call" as const,
              toolCallId: "call-1",
              toolName: "broken_tool",
              input: "not valid json {{{",
            },
          ],
          finishReason: "stop" as const,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          warnings: [],
        }),
        // deno-lint-ignore require-await
        doStream: async () => {
          throw new Error("not used");
        },
      });

      await enterTraceScope(traces, async () => {
        const result = await model.doGenerate(MINIMAL_OPTS);
        expect(result.content).toHaveLength(2);
      });

      expect(traces).toHaveLength(1);
      const trace = first(traces);
      expect(trace.output.text).toBe("result");
      expect(trace.output.toolCalls[0]?.name).toBe("broken_tool");
      expect(trace.output.toolCalls[0]?.input).toBe("not valid json {{{");
    });

    it("stream still completes and captures trace with raw input", async () => {
      const traces: TraceEntry[] = [];
      const model = traceModel({
        specificationVersion: "v2",
        provider: "test-provider",
        modelId: "test-provider:test-model",
        supportedUrls: {},
        // deno-lint-ignore require-await
        doGenerate: async () => {
          throw new Error("not used");
        },
        // deno-lint-ignore require-await
        doStream: async () => ({
          stream: new ReadableStream<LanguageModelV2StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "tool-input-start", id: "tc1", toolName: "broken_tool" });
              controller.enqueue({
                type: "tool-input-delta",
                id: "tc1",
                delta: "not valid json {{{",
              });
              controller.enqueue({ type: "tool-input-end", id: "tc1" });
              controller.enqueue({
                type: "finish",
                usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
                finishReason: "stop",
              });
              controller.close();
            },
          }),
        }),
      });

      await enterTraceScope(traces, async () => {
        const { stream } = await model.doStream(MINIMAL_OPTS);
        await drainStream(stream);
      });

      expect(traces).toHaveLength(1);
      const trace = first(traces);
      expect(trace.output.toolCalls[0]?.name).toBe("broken_tool");
      expect(trace.output.toolCalls[0]?.input).toBe("not valid json {{{");
    });
  });

  describe("error propagation", () => {
    it("propagates doGenerate error and records no trace", async () => {
      const traces: TraceEntry[] = [];
      const model = traceModel({
        specificationVersion: "v2",
        provider: "test-provider",
        modelId: "test-provider:test-model",
        supportedUrls: {},
        // deno-lint-ignore require-await
        doGenerate: async () => {
          throw new Error("model exploded");
        },
        // deno-lint-ignore require-await
        doStream: async () => {
          throw new Error("not used");
        },
      });

      await enterTraceScope(traces, async () => {
        await expect(model.doGenerate(MINIMAL_OPTS)).rejects.toThrow("model exploded");
      });

      expect(traces).toHaveLength(0);
    });
  });

  describe("nested scope isolation", () => {
    it("inner scope traces go to inner collector only", async () => {
      const outer: TraceEntry[] = [];
      const inner: TraceEntry[] = [];
      const model = traceModel(createMockModel());

      await enterTraceScope(outer, async () => {
        await model.doGenerate(
          opts([{ role: "user", content: [{ type: "text", text: "outer" }] }]),
        );

        await enterTraceScope(inner, async () => {
          await model.doGenerate(
            opts([{ role: "user", content: [{ type: "text", text: "inner" }] }]),
          );
        });

        await model.doGenerate(
          opts([{ role: "user", content: [{ type: "text", text: "outer again" }] }]),
        );
      });

      expect(outer).toHaveLength(2);
      expect(inner).toHaveLength(1);
      expect(inner[0]?.input[0]).toEqual({
        role: "user",
        content: [{ type: "text", text: "inner" }],
      });
    });
  });
});
