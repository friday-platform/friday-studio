import type { Attributes, Link, Span, SpanOptions, TimeInput, Tracer } from "@opentelemetry/api";
import { z } from "zod";

/**
 * Telemetry collector implementing OpenTelemetry's Tracer interface for AI SDK integration.
 *
 * Captures metrics from the AI SDK's instrumentation system to track:
 * - Tool executions in order with timing
 * - Errors and warnings with context
 * - Token usage (prompt/completion/total)
 * - Raw span data for execution traces
 *
 * The AI SDK automatically instruments LLM calls and tool usage when provided a tracer.
 * This collector extracts the relevant data from the OpenTelemetry spans.
 *
 * @see https://ai-sdk.dev/docs/ai-sdk-core/telemetry
 */

export interface ToolExecution {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  error?: string;
}

export interface ExecutionSpan {
  spanId: string;
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  attributes: Record<string, unknown>;
  status: { code: number; message?: string };
}

export interface CollectedMetrics {
  tools: ToolExecution[];
  errors: Array<{ message: string; context: string; timestamp: number; stack?: string }>;
  warnings: Array<{ message: string; timestamp: number }>;
  tokens: { prompt: number; completion: number; total: number };
}

// AI SDK token usage attributes from model spans
const TokenAttributesSchema = z
  .object({
    "ai.usage.promptTokens": z.number().optional(),
    "ai.usage.completionTokens": z.number().optional(),
    "ai.usage.inputTokens": z.number().optional(),
    "ai.usage.outputTokens": z.number().optional(),
    "ai.usage.totalTokens": z.number().optional(),
  })
  .passthrough();

const ToolCallAttributesSchema = z
  .object({
    "ai.toolCall.name": z.string().optional(),
    "ai.response.toolCalls": z.array(z.object({ toolName: z.string() })).optional(),
  })
  .passthrough();

/**
 * Collects telemetry from AI SDK by implementing OpenTelemetry's Tracer interface.
 * The AI SDK calls this tracer during LLM operations and tool invocations.
 */
export class AgentTelemetryCollector implements Tracer {
  private tools: ToolExecution[] = [];
  private errors: CollectedMetrics["errors"] = [];
  private warnings: CollectedMetrics["warnings"] = [];
  private tokens = { prompt: 0, completion: 0, total: 0 };
  private executionTrace: ExecutionSpan[] = [];
  private activeSpans = new Map<
    string,
    { name: string; startTime: number; toolName?: string; traceIndex: number }
  >();

  /**
   * Creates a span and executes a callback within its context.
   * Required by OpenTelemetry Tracer interface - handles multiple overloaded signatures.
   */
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    optionsOrFn?: SpanOptions | F,
    fnOrContext?: F | unknown,
    maybeFn?: F,
  ): ReturnType<F> {
    const { options, fn } = this.parseStartActiveSpanArgs(optionsOrFn, fnOrContext, maybeFn);

    const span = this.startSpan(name, options);

    try {
      const result = fn(span);

      if (result instanceof Promise) {
        return result.then(
          (value) => {
            span.end();
            return value;
          },
          (error) => {
            this.recordSpanError(span, error);
            span.end();
            throw error;
          },
        ) as ReturnType<F>;
      }

      span.end();
      return result as ReturnType<F>;
    } catch (error) {
      this.recordSpanError(span, error);
      span.end();
      throw error;
    }
  }

  /**
   * Parses OpenTelemetry's overloaded startActiveSpan signatures.
   * Handles: (name, fn), (name, options, fn), (name, options, context, fn)
   */
  private parseStartActiveSpanArgs<F extends (span: Span) => unknown>(
    arg1?: SpanOptions | F,
    arg2?: F | unknown,
    arg3?: F,
  ): { options?: SpanOptions; fn: F } {
    if (typeof arg1 === "function") {
      return { fn: arg1 as F };
    }
    if (typeof arg2 === "function") {
      return { options: arg1 as SpanOptions, fn: arg2 as F };
    }
    if (typeof arg3 === "function") {
      return { options: arg1 as SpanOptions, fn: arg3 };
    }

    throw new Error("startActiveSpan requires a callback function");
  }

  private recordSpanError(span: Span, error: unknown): void {
    if (error instanceof Error) {
      span.recordException(error);
      span.setStatus({ code: 1, message: error.message });
    } else {
      span.setStatus({ code: 1, message: String(error) });
    }
  }

  /**
   * Creates a new span and tracks it for metrics extraction.
   * Called by AI SDK when starting operations like tool calls or model invocations.
   */
  startSpan(name: string, options?: SpanOptions): Span {
    const spanId = crypto.randomUUID();
    const startTime = Date.now();

    const executionSpan: ExecutionSpan = {
      spanId,
      name,
      startTime,
      attributes: options?.attributes || {},
      status: { code: 0 },
    };
    this.executionTrace.push(executionSpan);
    const traceIndex = this.executionTrace.length - 1;

    const spanMeta = { name, startTime, toolName: undefined as string | undefined, traceIndex };
    this.activeSpans.set(spanId, spanMeta);

    // AI SDK uses "ai.toolCall" spans for tool invocations
    if (name === "ai.toolCall" && options?.attributes) {
      const attrs = ToolCallAttributesSchema.safeParse(options.attributes);
      if (attrs.success && attrs.data["ai.toolCall.name"]) {
        const toolName = attrs.data["ai.toolCall.name"];
        spanMeta.toolName = toolName;
        this.tools.push({ name: toolName, startTime });
      }
    }

    return this.createMinimalSpan(spanId, name, options);
  }

  /**
   * Returns captured metrics for the current session.
   */
  getMetrics(): CollectedMetrics {
    return {
      tools: [...this.tools],
      errors: [...this.errors],
      warnings: [...this.warnings],
      tokens: { ...this.tokens },
    };
  }

  /**
   * Returns all spans in execution order for debugging.
   */
  getExecutionTrace(): ExecutionSpan[] {
    return [...this.executionTrace];
  }

  /**
   * Clears all collected metrics and traces.
   */
  reset(): void {
    this.tools = [];
    this.errors = [];
    this.warnings = [];
    this.tokens = { prompt: 0, completion: 0, total: 0 };
    this.executionTrace = [];
    this.activeSpans.clear();
  }

  /**
   * Creates a minimal Span implementation that extracts metrics from AI SDK calls.
   * Only implements methods the AI SDK actually uses.
   */
  private createMinimalSpan(spanId: string, name: string, _options?: SpanOptions): Span {
    const spanMeta = this.activeSpans.get(spanId);
    if (!spanMeta) {
      throw new Error(`Span ${spanId} not found in active spans`);
    }

    const span: Span = {
      setAttribute: (key: string, value: unknown) => {
        this.processAttribute(key, value, name, spanMeta);
        const traceSpan = this.executionTrace[spanMeta.traceIndex];
        if (traceSpan) {
          traceSpan.attributes[key] = value;
        }
        return span;
      },

      setAttributes: (attributes: Record<string, unknown>) => {
        const traceSpan = this.executionTrace[spanMeta.traceIndex];
        if (traceSpan) {
          Object.assign(traceSpan.attributes, attributes);
        }

        // AI SDK reports token usage in various spans (doStream, streamText, etc.)
        const parsed = TokenAttributesSchema.safeParse(attributes);
        if (parsed.success) {
          const inputTokens = parsed.data["ai.usage.inputTokens"];
          const outputTokens = parsed.data["ai.usage.outputTokens"];
          const totalTokens = parsed.data["ai.usage.totalTokens"];

          // AI SDK may provide inputTokens/outputTokens or promptTokens/completionTokens
          const promptTokens = inputTokens || parsed.data["ai.usage.promptTokens"] || 0;
          const completionTokens = outputTokens || parsed.data["ai.usage.completionTokens"] || 0;

          if (promptTokens > 0 || completionTokens > 0) {
            this.tokens.prompt += promptTokens;
            this.tokens.completion += completionTokens;
            // Use provided total or calculate it
            this.tokens.total += totalTokens || promptTokens + completionTokens;
          }
        }

        // AI SDK includes tool calls in response attributes
        const toolAttrs = ToolCallAttributesSchema.safeParse(attributes);
        if (toolAttrs.success && toolAttrs.data["ai.response.toolCalls"]) {
          for (const call of toolAttrs.data["ai.response.toolCalls"]) {
            this.tools.push({ name: call.toolName, startTime: Date.now() });
          }
        }

        return span;
      },

      addEvent: (
        eventName: string,
        attributesOrStartTime?: Attributes | TimeInput,
        _startTime?: TimeInput,
      ) => {
        const eventAttributes =
          attributesOrStartTime &&
          typeof attributesOrStartTime === "object" &&
          !Array.isArray(attributesOrStartTime) &&
          !(attributesOrStartTime instanceof Date)
            ? (attributesOrStartTime as Attributes)
            : undefined;
        if (eventName === "exception") {
          this.errors.push({
            message: String(eventAttributes?.["exception.message"] || "Unknown error"),
            context: name,
            timestamp: Date.now(),
            stack: eventAttributes?.["exception.stack"] as string | undefined,
          });
        } else if (eventName.includes("warning")) {
          this.warnings.push({
            message: String(eventAttributes?.message || eventName),
            timestamp: Date.now(),
          });
        }
        return span;
      },

      setStatus: (status: { code: number; message?: string }) => {
        const traceSpan = this.executionTrace[spanMeta.traceIndex];
        if (traceSpan) {
          traceSpan.status = status;
        }

        if (status.code === 1 && spanMeta.toolName) {
          const toolIndex = this.tools.findIndex((t) => t.name === spanMeta.toolName && !t.endTime);
          if (toolIndex !== -1 && this.tools[toolIndex]) {
            this.tools[toolIndex].error = status.message || "Error";
          }
        }
        return span;
      },

      end: () => {
        const endTime = Date.now();

        const traceSpan = this.executionTrace[spanMeta.traceIndex];
        if (traceSpan) {
          traceSpan.endTime = endTime;
          traceSpan.duration = endTime - traceSpan.startTime;
        }

        if (spanMeta.toolName) {
          const toolIndex = this.tools.findIndex(
            (t) => t.name === spanMeta.toolName && t.startTime === spanMeta.startTime && !t.endTime,
          );
          if (toolIndex !== -1 && this.tools[toolIndex]) {
            this.tools[toolIndex].endTime = endTime;
            this.tools[toolIndex].duration = endTime - spanMeta.startTime;
          }
        }

        this.activeSpans.delete(spanId);
      },

      isRecording: () => this.activeSpans.has(spanId),

      recordException: (error: Error) => {
        this.errors.push({
          message: error.message,
          context: name,
          timestamp: Date.now(),
          stack: error.stack,
        });
      },

      updateName: () => span,
      spanContext: () => ({ traceId: "", spanId, traceFlags: 0 }),
      addLink: (_link: Link) => span,
      addLinks: (_links: Link[]) => span,
    };

    return span;
  }

  /**
   * Processes individual span attributes to extract tool names and token usage.
   */
  private processAttribute(
    key: string,
    value: unknown,
    _spanName: string,
    spanMeta: { name: string; startTime: number; toolName?: string; traceIndex: number },
  ): void {
    if (key === "ai.toolCall.name" && typeof value === "string") {
      spanMeta.toolName = value;
      this.tools.push({ name: value, startTime: spanMeta.startTime });
    }

    // Handle individual token attributes
    if (typeof value === "number") {
      switch (key) {
        case "ai.usage.inputTokens":
        case "ai.usage.promptTokens":
          this.tokens.prompt += value;
          this.tokens.total += value;
          break;
        case "ai.usage.outputTokens":
        case "ai.usage.completionTokens":
          this.tokens.completion += value;
          this.tokens.total += value;
          break;
        case "ai.usage.totalTokens":
          // Don't add to total here as it's already the sum
          break;
      }
    }
  }
}
