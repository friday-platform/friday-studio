import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  enterTraceScope,
  enterUsageScope,
  getActiveUsageCounter,
  type TraceEntry,
  traceModel,
  type UsageCounter,
} from "../tracing.ts";

const MINIMAL_OPTS: Pick<LanguageModelV3CallOptions, "prompt"> = {
  prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

function opts(
  prompt: LanguageModelV3CallOptions["prompt"],
): Pick<LanguageModelV3CallOptions, "prompt"> {
  return { prompt };
}

/** Get first element or throw — use after toHaveLength assertion. */
function first<T>(arr: T[]): T {
  const item = arr[0];
  if (item === undefined) throw new Error("expected non-empty array");
  return item;
}

function createMockModel(overrides?: { modelId?: string }): LanguageModelV3 {
  const modelId = overrides?.modelId ?? "test-provider:test-model";
  return {
    specificationVersion: "v3",
    provider: "test-provider",
    modelId,
    supportedUrls: {},
    // deno-lint-ignore require-await
    doGenerate: async () => {
      const content: LanguageModelV3Content[] = [
        { type: "text", text: "Hello world" },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "get_weather",
          input: '{"city":"Tokyo"}',
        },
      ];
      return {
        content,
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: {
            total: 100,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 50, text: undefined, reasoning: undefined },
        },
        warnings: [],
      };
    },
    // deno-lint-ignore require-await
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
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
            usage: {
              inputTokens: {
                total: 80,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 40, text: undefined, reasoning: undefined },
            },
            finishReason: { unified: "stop" as const, raw: undefined },
          });
          controller.close();
        },
      }),
    }),
  };
}

/** Consume a ReadableStream to completion */
async function drainStream(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<void> {
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
      expect(trace.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
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
      expect(trace.usage).toEqual({ inputTokens: 80, outputTokens: 40 });
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
        specificationVersion: "v3",
        provider: "test-provider",
        modelId: "test-provider:test-model",
        supportedUrls: {},
        // deno-lint-ignore require-await
        doGenerate: async () => {
          throw new Error("not used");
        },
        // deno-lint-ignore require-await
        doStream: async () => ({
          stream: new ReadableStream<LanguageModelV3StreamPart>({
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
                usage: {
                  inputTokens: {
                    total: 50,
                    noCache: undefined,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: { total: 30, text: undefined, reasoning: undefined },
                },
                finishReason: { unified: "stop" as const, raw: undefined },
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
        specificationVersion: "v3",
        provider: "test-provider",
        modelId: "test-provider:test-model",
        supportedUrls: {},
        // deno-lint-ignore require-await
        doGenerate: async () => {
          const content: LanguageModelV3Content[] = [
            { type: "text", text: "result" },
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "broken_tool",
              input: "not valid json {{{",
            },
          ];
          return {
            content,
            finishReason: { unified: "stop" as const, raw: undefined },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
            warnings: [],
          };
        },
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
        specificationVersion: "v3",
        provider: "test-provider",
        modelId: "test-provider:test-model",
        supportedUrls: {},
        // deno-lint-ignore require-await
        doGenerate: async () => {
          throw new Error("not used");
        },
        // deno-lint-ignore require-await
        doStream: async () => ({
          stream: new ReadableStream<LanguageModelV3StreamPart>({
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
                usage: {
                  inputTokens: {
                    total: 10,
                    noCache: undefined,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: { total: 5, text: undefined, reasoning: undefined },
                },
                finishReason: { unified: "stop" as const, raw: undefined },
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
        specificationVersion: "v3",
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

  describe("enterUsageScope", () => {
    const freshCounter = (): UsageCounter => ({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    /** Model that emits cache token fields and supports a synthetic doGenerate error. */
    function createUsageMockModel(opts?: {
      inputTotal?: number;
      outputTotal?: number;
      cacheRead?: number;
      cacheWrite?: number;
      doGenerateError?: Error;
      doStreamError?: Error;
    }): LanguageModelV3 {
      const inputTotal = opts?.inputTotal ?? 100;
      const outputTotal = opts?.outputTotal ?? 50;
      const cacheRead = opts?.cacheRead ?? 0;
      const cacheWrite = opts?.cacheWrite ?? 0;
      return {
        specificationVersion: "v3",
        provider: "test-provider",
        modelId: "test-provider:test-model",
        supportedUrls: {},
        // deno-lint-ignore require-await
        doGenerate: async () => {
          if (opts?.doGenerateError) throw opts.doGenerateError;
          return {
            content: [{ type: "text", text: "ok" }] as LanguageModelV3Content[],
            finishReason: { unified: "stop" as const, raw: undefined },
            usage: {
              inputTokens: { total: inputTotal, noCache: undefined, cacheRead, cacheWrite },
              outputTokens: { total: outputTotal, text: undefined, reasoning: undefined },
            },
            warnings: [],
          };
        },
        // deno-lint-ignore require-await
        doStream: async () => {
          if (opts?.doStreamError) throw opts.doStreamError;
          return {
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({
                  type: "finish",
                  usage: {
                    inputTokens: { total: inputTotal, noCache: undefined, cacheRead, cacheWrite },
                    outputTokens: { total: outputTotal, text: undefined, reasoning: undefined },
                  },
                  finishReason: { unified: "stop" as const, raw: undefined },
                });
                controller.close();
              },
            }),
          };
        },
      };
    }

    it("getActiveUsageCounter returns the counter inside scope and undefined outside", async () => {
      const counter = freshCounter();
      expect(getActiveUsageCounter()).toBeUndefined();
      await enterUsageScope(counter, () => {
        expect(getActiveUsageCounter()).toBe(counter);
        return Promise.resolve();
      });
      expect(getActiveUsageCounter()).toBeUndefined();
    });

    it("wrapGenerate mutates the counter for in-scope calls", async () => {
      const counter = freshCounter();
      const model = traceModel(createUsageMockModel({ inputTotal: 120, outputTotal: 70 }));

      await enterUsageScope(counter, async () => {
        await model.doGenerate(MINIMAL_OPTS);
      });

      expect(counter).toEqual({
        inputTokens: 120,
        outputTokens: 70,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });

    it("wrapStream mutates the counter on the finish chunk", async () => {
      const counter = freshCounter();
      const model = traceModel(createUsageMockModel({ inputTotal: 80, outputTotal: 40 }));

      await enterUsageScope(counter, async () => {
        const { stream } = await model.doStream(MINIMAL_OPTS);
        await drainStream(stream);
      });

      expect(counter).toEqual({
        inputTokens: 80,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });

    it("cache token fields under inputTokens flow into cacheReadTokens/cacheWriteTokens", async () => {
      const counter = freshCounter();
      const model = traceModel(
        createUsageMockModel({
          inputTotal: 1000,
          outputTotal: 50,
          cacheRead: 600,
          cacheWrite: 200,
        }),
      );

      await enterUsageScope(counter, async () => {
        await model.doGenerate(MINIMAL_OPTS);
        const { stream } = await model.doStream(MINIMAL_OPTS);
        await drainStream(stream);
      });

      // Two calls × 1000 input each, 50 output each, 600 cacheRead, 200 cacheWrite
      expect(counter).toEqual({
        inputTokens: 2000,
        outputTokens: 100,
        cacheReadTokens: 1200,
        cacheWriteTokens: 400,
      });
    });

    it("nested calls all credit to the same counter", async () => {
      const counter = freshCounter();
      const model = traceModel(createUsageMockModel({ inputTotal: 10, outputTotal: 5 }));

      await enterUsageScope(counter, async () => {
        await model.doGenerate(MINIMAL_OPTS);
        // Simulate a tool-execute fan-out: nested awaits inside the same scope
        await Promise.all([
          model.doGenerate(MINIMAL_OPTS),
          model.doGenerate(MINIMAL_OPTS),
          (async () => {
            const { stream } = await model.doStream(MINIMAL_OPTS);
            await drainStream(stream);
          })(),
        ]);
      });

      expect(counter.inputTokens).toBe(40);
      expect(counter.outputTokens).toBe(20);
    });

    it("captures the counter reference at scope entry — drained outside scope still credits", async () => {
      // The wrapStream middleware reads `usageStorage.getStore()` at scope
      // entry (when doStream is called) and closes over it. When the
      // consumer drains the stream later — possibly in a different async
      // context — the captured closure must keep mutating the original
      // counter, not look up ALS at finish-chunk time.
      const counter = freshCounter();
      const model = traceModel(createUsageMockModel({ inputTotal: 80, outputTotal: 40 }));

      let stream: ReadableStream<LanguageModelV3StreamPart> | undefined;
      await enterUsageScope(counter, async () => {
        const result = await model.doStream(MINIMAL_OPTS);
        stream = result.stream;
      });

      // We're now outside the scope.
      expect(getActiveUsageCounter()).toBeUndefined();
      expect(counter.inputTokens).toBe(0); // finish chunk not yet processed

      if (!stream) throw new Error("stream not captured");
      await drainStream(stream);

      // The finish chunk fired outside the ALS scope — but the closure
      // reference is intact, so the counter is still mutated.
      expect(counter.inputTokens).toBe(80);
      expect(counter.outputTokens).toBe(40);
    });

    it("calls outside any scope do not throw or accumulate", async () => {
      const model = traceModel(createUsageMockModel());
      await expect(model.doGenerate(MINIMAL_OPTS)).resolves.toBeDefined();
      const { stream } = await model.doStream(MINIMAL_OPTS);
      await expect(drainStream(stream)).resolves.toBeUndefined();
    });

    it("errored doGenerate does not mutate the counter", async () => {
      const counter = freshCounter();
      const model = traceModel(createUsageMockModel({ doGenerateError: new Error("boom") }));

      await enterUsageScope(counter, async () => {
        await expect(model.doGenerate(MINIMAL_OPTS)).rejects.toThrow("boom");
      });

      expect(counter).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });

    it("errored doStream (rejects before stream) does not mutate the counter", async () => {
      const counter = freshCounter();
      const model = traceModel(createUsageMockModel({ doStreamError: new Error("boom") }));

      await enterUsageScope(counter, async () => {
        await expect(model.doStream(MINIMAL_OPTS)).rejects.toThrow("boom");
      });

      expect(counter.inputTokens).toBe(0);
    });

    it("nested enterUsageScope shadows the outer counter (inner calls credit inner only)", async () => {
      const outer = freshCounter();
      const inner = freshCounter();
      const model = traceModel(createUsageMockModel({ inputTotal: 10, outputTotal: 5 }));

      await enterUsageScope(outer, async () => {
        await model.doGenerate(MINIMAL_OPTS);
        await enterUsageScope(inner, async () => {
          await model.doGenerate(MINIMAL_OPTS);
        });
        await model.doGenerate(MINIMAL_OPTS);
      });

      expect(outer.inputTokens).toBe(20);
      expect(inner.inputTokens).toBe(10);
    });
  });
});
