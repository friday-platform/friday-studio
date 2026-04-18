import { AsyncLocalStorage } from "node:async_hooks";
import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { logger } from "@atlas/logger";
import { type Span, withManualOtelSpan, withOtelSpan } from "@atlas/utils/telemetry.server";
import { wrapLanguageModel } from "ai";

/** Record error and end a manually-managed span. */
function endSpanWithError(span: Span | null, err: unknown): void {
  if (!span) return;
  if (err instanceof Error) span.recordException(err);
  span.setStatus({ code: 2 /* SpanStatusCode.ERROR */, message: String(err) });
  span.end();
}

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
  usage: { inputTokens: number; outputTokens: number };
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
 * Wraps a LanguageModelV3 with trace-capturing middleware.
 * When called inside an enterTraceScope, captures input/output/usage/timing/modelId.
 * When called outside a scope, passes through with zero overhead beyond the middleware check.
 */
export function traceModel(model: LanguageModelV3): LanguageModelV3 {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3" as const,
      // deno-lint-ignore require-await
      wrapGenerate: async ({ doGenerate, params, model }) => {
        return withOtelSpan(
          "llm.generate",
          {
            "llm.model": model.modelId,
            "llm.provider": model.provider,
            "llm.operation": "generate",
          },
          async (span) => {
            const store = traceStorage.getStore();
            const t0 = performance.now();
            const result = await doGenerate();
            const latencyMs = performance.now() - t0;

            const inTok = result.usage.inputTokens.total ?? 0;
            const outTok = result.usage.outputTokens.total ?? 0;

            if (span) {
              span.setAttributes({
                "llm.input_tokens": inTok,
                "llm.output_tokens": outTok,
                "llm.generation_latency_ms": latencyMs,
              });
            }

            logger.info("LLM call", {
              operation: "generate",
              provider: model.provider,
              modelId: model.modelId,
              inputTokens: inTok,
              outputTokens: outTok,
              latencyMs: Math.round(latencyMs),
            });

            if (store) {
              const startMs = t0 - store.scopeStartTime;
              const text = result.content
                .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
                .map((c) => c.text)
                .join("");

              const toolCalls = result.content
                .filter(
                  (c): c is Extract<typeof c, { type: "tool-call" }> => c.type === "tool-call",
                )
                .map((c) => ({ name: c.toolName, input: c.input ? tryParseJson(c.input) : {} }));

              store.traces.push({
                type: "generate",
                modelId: model.modelId,
                input: params.prompt.map((m) => ({ role: m.role, content: m.content })),
                output: { text, toolCalls },
                usage: { inputTokens: inTok, outputTokens: outTok },
                startMs,
                endMs: startMs + latencyMs,
              });
            }

            return result;
          },
        );
      },

      // deno-lint-ignore require-await
      wrapStream: async ({ doStream, params, model }) => {
        // withManualOtelSpan activates the span in context (so it nests
        // under the parent fsm.action/agent.execute span) but does NOT
        // auto-end it — the transform stream handles span.end().
        return withManualOtelSpan(
          "llm.stream",
          { "llm.model": model.modelId, "llm.provider": model.provider, "llm.operation": "stream" },
          async (span) => {
            const store = traceStorage.getStore();
            const t0 = performance.now();

            let result: Awaited<ReturnType<typeof doStream>>;
            try {
              result = await doStream();
            } catch (err) {
              endSpanWithError(span, err);
              throw err;
            }

            let text = "";
            let spanEnded = false;
            const toolCallOrder: string[] = [];
            const toolCallsById = new Map<string, { name: string; inputJson: string }>();

            // Extracted to a variable so TypeScript skips excess-property checking.
            // The cancel() callback is part of the WHATWG Streams spec and works at
            // runtime in Deno, but some TS lib versions used by svelte-check omit
            // it from the Transformer interface definition.
            const transformer = {
              transform(
                chunk: LanguageModelV3StreamPart,
                controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
              ) {
                if (store) {
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
                  }
                }

                if (chunk.type === "finish") {
                  const latencyMs = performance.now() - t0;
                  const finishInTok = chunk.usage.inputTokens.total ?? 0;
                  const finishOutTok = chunk.usage.outputTokens.total ?? 0;
                  if (span && !spanEnded) {
                    span.setAttributes({
                      "llm.input_tokens": finishInTok,
                      "llm.output_tokens": finishOutTok,
                      "llm.generation_latency_ms": latencyMs,
                    });
                    span.end();
                    spanEnded = true;
                  }
                  logger.info("LLM call", {
                    operation: "stream",
                    provider: model.provider,
                    modelId: model.modelId,
                    inputTokens: finishInTok,
                    outputTokens: finishOutTok,
                    latencyMs: Math.round(latencyMs),
                  });
                  if (store) {
                    const startMs = t0 - store.scopeStartTime;
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
                      usage: { inputTokens: finishInTok, outputTokens: finishOutTok },
                      startMs,
                      endMs: startMs + latencyMs,
                    });
                  }
                }

                controller.enqueue(chunk);
              },
              flush() {
                if (!spanEnded) span?.end();
              },
              cancel(reason?: unknown) {
                if (!spanEnded) {
                  if (reason) endSpanWithError(span, reason);
                  else span?.end();
                  spanEnded = true;
                }
              },
            };
            const transform = new TransformStream<
              LanguageModelV3StreamPart,
              LanguageModelV3StreamPart
            >(transformer);

            return { ...result, stream: result.stream.pipeThrough(transform) };
          },
        );
      },
    },
  });
}
