import { AsyncLocalStorage } from "node:async_hooks";
import type { LanguageModelV2, LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";

/**
 * A single LLM call captured during an eval trace scope.
 * Both generate and stream traces use the same normalized output shape.
 */
export interface TraceEntry {
  /** "generate" for generateText, "stream" for streamText */
  type: "generate" | "stream";
  /** Model identifier (e.g., "anthropic:claude-sonnet-4-5") */
  modelId: string;
  /** Input messages sent to the model */
  input: Array<{ role: string; content: unknown }>;
  /** Model output — normalized to same shape for both generate and stream */
  output: { text: string; toolCalls: Array<{ name: string; input: unknown }> };
  /** Token usage */
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** Timing relative to trace scope start */
  startMs: number;
  endMs: number;
}

interface TraceStore {
  traces: TraceEntry[];
  scopeStartTime: number;
}

const traceStorage = new AsyncLocalStorage<TraceStore>();

/** Parse JSON, falling back to the raw string on malformed input. */
function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Runs `fn` within an ALS scope that collects traces from traceModel-wrapped models.
 * Nested calls shadow the outer scope — inner traces go to the inner collector.
 */
export function enterTraceScope<T>(traces: TraceEntry[], fn: () => Promise<T>): Promise<T> {
  return traceStorage.run({ traces, scopeStartTime: performance.now() }, fn);
}

/**
 * Wraps a LanguageModelV2 with trace-capturing middleware.
 * When called inside an enterTraceScope, captures input/output/usage/timing/modelId.
 * When called outside a scope, passes through with zero overhead beyond the middleware check.
 */
export function traceModel(model: LanguageModelV2): LanguageModelV2 {
  return wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ doGenerate, params, model }) => {
        const store = traceStorage.getStore();
        if (!store) return doGenerate();

        const startMs = performance.now() - store.scopeStartTime;
        const result = await doGenerate();
        const endMs = performance.now() - store.scopeStartTime;

        const text = result.content
          .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
          .map((c) => c.text)
          .join("");

        const toolCalls = result.content
          .filter((c): c is Extract<typeof c, { type: "tool-call" }> => c.type === "tool-call")
          .map((c) => ({ name: c.toolName, input: c.input ? tryParseJson(c.input) : {} }));

        store.traces.push({
          type: "generate",
          modelId: model.modelId,
          input: params.prompt.map((m) => ({ role: m.role, content: m.content })),
          output: { text, toolCalls },
          usage: {
            inputTokens: result.usage.inputTokens ?? 0,
            outputTokens: result.usage.outputTokens ?? 0,
            totalTokens: result.usage.totalTokens ?? 0,
          },
          startMs,
          endMs,
        });

        return result;
      },

      wrapStream: async ({ doStream, params, model }) => {
        const store = traceStorage.getStore();
        if (!store) return doStream();

        const startMs = performance.now() - store.scopeStartTime;
        const result = await doStream();

        let text = "";
        const toolCallOrder: string[] = [];
        const toolCallsById = new Map<string, { name: string; inputJson: string }>();

        const transform = new TransformStream<LanguageModelV2StreamPart, LanguageModelV2StreamPart>(
          {
            transform(chunk, controller) {
              switch (chunk.type) {
                case "text-delta":
                  text += chunk.delta;
                  break;
                case "tool-input-start":
                  toolCallOrder.push(chunk.id);
                  toolCallsById.set(chunk.id, { name: chunk.toolName, inputJson: "" });
                  break;
                case "tool-input-delta": {
                  const tc = toolCallsById.get(chunk.id);
                  if (tc) tc.inputJson += chunk.delta;
                  break;
                }
                case "finish": {
                  const endMs = performance.now() - store.scopeStartTime;
                  store.traces.push({
                    type: "stream",
                    modelId: model.modelId,
                    input: params.prompt.map((m) => ({ role: m.role, content: m.content })),
                    output: {
                      text,
                      toolCalls: toolCallOrder.map((id) => {
                        const tc = toolCallsById.get(id);
                        return {
                          name: tc?.name ?? "unknown",
                          input: tc?.inputJson ? tryParseJson(tc.inputJson) : {},
                        };
                      }),
                    },
                    usage: {
                      inputTokens: chunk.usage.inputTokens ?? 0,
                      outputTokens: chunk.usage.outputTokens ?? 0,
                      totalTokens: chunk.usage.totalTokens ?? 0,
                    },
                    startMs,
                    endMs,
                  });
                  break;
                }
              }
              controller.enqueue(chunk);
            },
          },
        );

        return { ...result, stream: result.stream.pipeThrough(transform) };
      },
    },
  });
}
