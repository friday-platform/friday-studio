import type {
  Attributes,
  AttributeValue,
  Link,
  Span,
  SpanOptions,
  SpanStatus,
  TimeInput,
  Tracer,
} from "@opentelemetry/api";
import { z } from "zod";

/**
 * Collects telemetry from AI SDK by implementing OpenTelemetry's Tracer interface.
 * Tracks tool executions, errors, token usage, and execution traces.
 *
 * @see https://ai-sdk.dev/docs/ai-sdk-core/telemetry
 */

/** Tool execution with timing and error tracking */
interface ToolExecution {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  error?: string;
  args?: unknown;
  result?: unknown;
}

/** Span data for execution trace */
export interface ExecutionSpan {
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  attributes: Record<string, unknown>;
  status: { code: number; message?: string };
}

/** All metrics collected during AI SDK operations */
export interface CollectedMetrics {
  tools: ToolExecution[];
  errors: Array<{ message: string; context: string; timestamp: number; stack?: string }>;
  warnings: Array<{ message: string; timestamp: number }>;
  tokens: { prompt: number; completion: number; total: number };
  trace: ExecutionSpan[];
}

/** Internal span metadata */
interface SpanMeta {
  name: string;
  startTime: number;
  toolName: string | undefined;
  toolIndex?: number;
  traceIndex: number;
  parentSpanId?: string;
}

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
    "ai.toolCall.args": z.string().optional(),
    "ai.toolCall.result": z.string().optional(),
    "ai.response.toolCalls": z.array(z.object({ toolName: z.string() })).optional(),
  })
  .passthrough();

export class AgentTelemetryCollector implements Tracer {
  private tools: ToolExecution[] = [];
  private errors: CollectedMetrics["errors"] = [];
  private warnings: CollectedMetrics["warnings"] = [];
  private tokens = { prompt: 0, completion: 0, total: 0 };
  private executionTrace: ExecutionSpan[] = [];
  private activeSpans = new Map<string, SpanMeta>();
  private readonly traceId = crypto.randomUUID(); // Single traceId for entire execution

  /**
   * Starts a span and runs a callback within its context.
   * Handles OpenTelemetry's overloaded signatures.
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

  /** Parses startActiveSpan overloads: (name, fn), (name, options, fn), (name, options, context, fn) */
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

  /** Record an error on a span */
  private recordSpanError(span: Span, error: unknown): void {
    if (error instanceof Error) {
      span.recordException(error);
      span.setStatus({ code: 1, message: error.message });
    } else {
      span.setStatus({ code: 1, message: String(error) });
    }
  }

  /** Creates and tracks a span for metrics extraction */
  startSpan(name: string, options?: SpanOptions): Span {
    const spanId = crypto.randomUUID();
    const startTime = Date.now();

    // Find current active parent span (if any)
    const parentSpanId = this.getCurrentParentSpanId();

    const executionSpan: ExecutionSpan = {
      spanId,
      parentSpanId,
      name,
      startTime,
      attributes: options?.attributes || {},
      status: { code: 0 },
    };
    this.executionTrace.push(executionSpan);
    const traceIndex = this.executionTrace.length - 1;

    const spanMeta: SpanMeta = { name, startTime, toolName: undefined, traceIndex, parentSpanId };
    this.activeSpans.set(spanId, spanMeta);

    // Track tool calls from ai.toolCall spans
    if (name === "ai.toolCall" && options?.attributes) {
      const attrs = ToolCallAttributesSchema.safeParse(options.attributes);
      if (attrs.success && attrs.data["ai.toolCall.name"]) {
        const toolName = attrs.data["ai.toolCall.name"];
        spanMeta.toolName = toolName;

        const toolExecution: ToolExecution = { name: toolName, startTime };

        // Parse and store args if available
        if (attrs.data["ai.toolCall.args"]) {
          try {
            toolExecution.args = JSON.parse(attrs.data["ai.toolCall.args"]);
          } catch {
            toolExecution.args = attrs.data["ai.toolCall.args"];
          }
        }

        this.tools.push(toolExecution);
        spanMeta.toolIndex = this.tools.length - 1;
      }
    }

    return this.createMinimalSpan(spanId, name);
  }

  /** Get all collected metrics */
  getMetrics(): CollectedMetrics {
    return {
      tools: [...this.tools],
      errors: [...this.errors],
      warnings: [...this.warnings],
      tokens: { ...this.tokens },
      trace: [...this.executionTrace],
    };
  }

  /** Clear all metrics and traces */
  reset(): void {
    this.tools = [];
    this.errors = [];
    this.warnings = [];
    this.tokens = { prompt: 0, completion: 0, total: 0 };
    this.executionTrace = [];
    this.activeSpans.clear();
  }

  /** Get the current parent span ID (for nested spans) */
  private getCurrentParentSpanId(): string | undefined {
    // Find the most recently started span that hasn't ended yet
    // This will be the parent for the new span
    let parentSpanId: string | undefined;
    let latestStartTime = 0;

    for (const [spanId, meta] of this.activeSpans) {
      if (meta.startTime > latestStartTime) {
        latestStartTime = meta.startTime;
        parentSpanId = spanId;
      }
    }

    return parentSpanId;
  }

  /** Creates a minimal Span that extracts metrics from AI SDK calls */
  private createMinimalSpan(spanId: string, name: string): Span {
    const spanMeta = this.activeSpans.get(spanId);
    if (!spanMeta) {
      throw new Error(`Span ${spanId} not found in active spans`);
    }

    const span: Span = {
      setAttribute: (key: string, value: AttributeValue) => {
        this.processAttribute(key, value, name, spanMeta);
        const traceSpan = this.executionTrace[spanMeta.traceIndex];
        if (traceSpan) {
          traceSpan.attributes[key] = value;
        }

        // Capture tool call result
        if (
          key === "ai.toolCall.result" &&
          spanMeta.toolIndex !== undefined &&
          typeof value === "string"
        ) {
          const tool = this.tools[spanMeta.toolIndex];
          if (tool) {
            try {
              tool.result = JSON.parse(value);
            } catch {
              tool.result = value;
            }
          }
        }

        return span;
      },

      setAttributes: (attributes: Attributes) => {
        const traceSpan = this.executionTrace[spanMeta.traceIndex];
        if (traceSpan) {
          Object.assign(traceSpan.attributes, attributes);
        }

        const parsed = TokenAttributesSchema.safeParse(attributes);
        if (parsed.success) {
          const inputTokens = parsed.data["ai.usage.inputTokens"];
          const outputTokens = parsed.data["ai.usage.outputTokens"];
          const totalTokens = parsed.data["ai.usage.totalTokens"];

          // SDK provides either inputTokens/outputTokens or promptTokens/completionTokens
          const promptTokens = inputTokens || parsed.data["ai.usage.promptTokens"] || 0;
          const completionTokens = outputTokens || parsed.data["ai.usage.completionTokens"] || 0;

          if (promptTokens > 0 || completionTokens > 0) {
            this.tokens.prompt += promptTokens;
            this.tokens.completion += completionTokens;
            this.tokens.total += totalTokens || promptTokens + completionTokens;
          }
        }

        const toolAttrs = ToolCallAttributesSchema.safeParse(attributes);
        if (toolAttrs.success) {
          // Handle tool result being set
          if (toolAttrs.data["ai.toolCall.result"] && spanMeta.toolIndex !== undefined) {
            const tool = this.tools[spanMeta.toolIndex];
            if (tool) {
              try {
                tool.result = JSON.parse(toolAttrs.data["ai.toolCall.result"]);
              } catch {
                tool.result = toolAttrs.data["ai.toolCall.result"];
              }
            }
          }

          // Handle response tool calls
          if (toolAttrs.data["ai.response.toolCalls"]) {
            for (const call of toolAttrs.data["ai.response.toolCalls"]) {
              this.tools.push({ name: call.toolName, startTime: Date.now() });
            }
          }
        }

        return span;
      },

      addEvent: (eventName: string, attributesOrStartTime?: Attributes | TimeInput) => {
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
            stack: eventAttributes?.["exception.stack"]
              ? String(eventAttributes["exception.stack"])
              : undefined,
          });
        } else if (eventName.includes("warning")) {
          this.warnings.push({
            message: String(eventAttributes?.message || eventName),
            timestamp: Date.now(),
          });
        }
        return span;
      },

      setStatus: (status: SpanStatus) => {
        const traceSpan = this.executionTrace[spanMeta.traceIndex];
        if (traceSpan) {
          traceSpan.status = status;
        }

        if (status.code === 1 && spanMeta.toolIndex !== undefined) {
          const tool = this.tools[spanMeta.toolIndex];
          if (tool) {
            tool.error = status.message || "Error";
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

        if (spanMeta.toolIndex !== undefined) {
          const tool = this.tools[spanMeta.toolIndex];
          if (tool && !tool.endTime) {
            tool.endTime = endTime;
            tool.duration = endTime - tool.startTime;
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
      spanContext: () => ({ traceId: this.traceId, spanId, traceFlags: 0 }),
      addLink: (_link: Link) => span,
      addLinks: (_links: Link[]) => span,
    };

    return span;
  }

  /** Extract tool names and token usage from span attributes */
  private processAttribute(
    key: string,
    value: unknown,
    _spanName: string,
    spanMeta: SpanMeta,
  ): void {
    if (key === "ai.toolCall.name" && typeof value === "string") {
      // Only create a new tool if we don't already have one for this span
      if (!spanMeta.toolName) {
        spanMeta.toolName = value;
        const toolExecution: ToolExecution = { name: value, startTime: spanMeta.startTime };
        this.tools.push(toolExecution);
        spanMeta.toolIndex = this.tools.length - 1;
      }
    }

    if (
      key === "ai.toolCall.args" &&
      typeof value === "string" &&
      spanMeta.toolIndex !== undefined
    ) {
      const tool = this.tools[spanMeta.toolIndex];
      if (tool) {
        try {
          tool.args = JSON.parse(value);
        } catch {
          tool.args = value;
        }
      }
    }

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
          // Total is already the sum, don't double-count
          break;
      }
    }
  }
}
