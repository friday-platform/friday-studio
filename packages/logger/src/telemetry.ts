import { env } from "node:process";
import type {
  Attributes,
  Context,
  ContextAPI,
  Span,
  SpanKind,
  SpanStatusCode,
  TraceAPI,
  Tracer,
} from "@opentelemetry/api";
import { z } from "zod";
import { logger } from "./logger.ts";

// Zod schemas for runtime validation

/**
 * Schema for OpenTelemetry attribute values
 * Attribute values may be any non-nullish primitive value except an object.
 */
const AttributeValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number()),
  z.array(z.boolean()),
]);

/**
 * Schema for OpenTelemetry attributes object
 */
const AttributesSchema = z.record(z.string(), AttributeValueSchema).optional();

/**
 * Schema for component types in the Atlas architecture
 */
const ComponentSchema = z.enum(["workspace", "session", "agent", "supervisor", "signal"]);

/**
 * Schema for W3C traceparent header format: 00-{traceId}-{spanId}-{flags}
 */
const TraceParentSchema = z
  .string()
  .regex(
    /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
    "Invalid W3C traceparent format. Expected: 00-{32-char-trace-id}-{16-char-span-id}-{2-char-flags}",
  );

/**
 * Schema for trace headers from worker communication
 */
const TraceHeadersSchema = z.record(z.string(), z.string()).optional();

/**
 * Schema for worker span context used in cross-worker communication
 */
const WorkerSpanContextSchema = z.object({
  operation: z.string().min(1, "Operation name cannot be empty"),
  component: z.enum(["workspace", "session", "agent"]),
  traceHeaders: TraceHeadersSchema,
  workerId: z.string().optional(),
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  agentType: z.string().optional(),
  workspaceId: z.string().optional(),
  signalId: z.string().optional(),
  signalType: z.string().optional(),
  attributes: AttributesSchema,
});

/**
 * Schema for LLM operation attributes
 */
const LLMAttributesSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    temperature: z.number().optional(),
    maxTokens: z.number().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    costEstimate: z.number().optional(),
    finishReason: z.string().optional(),
    maxSteps: z.number().optional(),
    retryCount: z.number().optional(),
    errorCategory: z.string().optional(),
  })
  .partial();

/**
 * Validation utility functions
 *
 * @FIXME this should be simplified dramatically and likely changed into a
 * set of helper functions.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: see above.
class TelemetryValidation {
  /**
   * Validate attributes for OpenTelemetry compatibility
   */
  static validateAttributes(attributes: unknown): Attributes | undefined {
    if (attributes === undefined || attributes === null) {
      return undefined;
    }

    const result = AttributesSchema.safeParse(attributes);
    if (result.success) {
      return result.data;
    }

    logger.warn("Invalid telemetry attributes", {
      error: result.error.issues,
      providedAttributes: attributes,
    });
    return undefined;
  }

  /**
   * Validate trace parent header format
   */
  static validateTraceParent(traceParent: unknown): string | null {
    if (traceParent === null || traceParent === undefined) {
      return null;
    }

    const result = TraceParentSchema.safeParse(traceParent);
    if (result.success) {
      return result.data;
    }

    logger.warn("Invalid traceparent header format", { traceParent, error: result.error.issues });
    return null;
  }

  /**
   * Validate worker span context
   */
  static validateWorkerContext(context: unknown): WorkerSpanContext {
    const result = WorkerSpanContextSchema.safeParse(context);
    if (result.success) {
      return result.data;
    }

    logger.error("Invalid worker span context", { context, error: result.error.issues });
    throw new Error(
      `Invalid worker span context: ${result.error.issues.map((e) => e.message).join(", ")}`,
    );
  }

  /**
   * Validate component type
   */
  static validateComponent(
    component: unknown,
  ): "workspace" | "supervisor" | "agent" | "signal" | "session" {
    const result = ComponentSchema.safeParse(component);
    if (result.success) {
      return result.data;
    }

    logger.warn("Invalid component type, defaulting to 'agent'", {
      component,
      error: result.error.issues,
    });
    return "agent";
  }
}

/**
 * Context object for worker span operations
 */
interface WorkerSpanContext {
  /** The operation being performed (e.g., "initialize", "processSignal", "invoke") */
  operation: string;
  /** The worker component type */
  component: "workspace" | "session" | "agent";
  /** Trace headers from parent worker */
  traceHeaders?: Record<string, string>;
  /** Worker-specific identifier */
  workerId?: string;
  /** Session identifier (for session and agent workers) */
  sessionId?: string;
  /** Agent identifier (for agent workers) */
  agentId?: string;
  /** Agent type (for agent workers) */
  agentType?: string;
  /** Workspace identifier (for workspace workers) */
  workspaceId?: string;
  /** Signal identifier (for signal processing) */
  signalId?: string;
  /** Signal type/provider (for signal processing) */
  signalType?: string;
  /** Any additional custom attributes */
  attributes?: Attributes;
}

/**
 * LLM operation attributes
 */
interface LLMAttributes {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  costEstimate?: number;
  finishReason?: string;
  maxSteps?: number;
  retryCount?: number;
  errorCategory?: string;
}

// Static mapping for worker context properties to atlas attributes
const WORKER_ATTRIBUTE_MAPPING = {
  sessionId: "atlas.session.id",
  workerId: "atlas.worker.id",
  workspaceId: "atlas.workspace.id",
  agentId: "atlas.agent.id",
  agentType: "atlas.agent.type",
  signalId: "atlas.signal.id",
  signalType: "atlas.signal.type",
} as const;

// Dynamic imports for OpenTelemetry to avoid worker import issues
let trace: TraceAPI | null = null;
let context: ContextAPI | null = null;
let statusCodes: typeof SpanStatusCode | null = null;
let spanKinds: typeof SpanKind | null = null;

/**
 * Atlas Telemetry utilities for OpenTelemetry instrumentation
 *
 * This module provides utilities for creating connected span hierarchies
 * across the Atlas architecture: workspace → supervisor → session → agent
 *
 * @FIXME this should be simplified dramatically and likely changed into a
 * set of helper functions.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: see above.
export class AtlasTelemetry {
  private static tracer: Tracer | null = null;
  private static isEnabled = false;
  private static initPromise: Promise<void> | null = null;

  /**
   * Initialize OpenTelemetry (async to handle dynamic imports)
   */
  private static initialize(): Promise<void> {
    if (AtlasTelemetry.initPromise) {
      return AtlasTelemetry.initPromise;
    }

    AtlasTelemetry.initPromise = (async () => {
      try {
        // Check if OpenTelemetry should be enabled
        if (env.OTEL_DENO !== "true") {
          logger.debug("OpenTelemetry disabled - set OTEL_DENO=true to enable");
          return;
        }

        // Dynamic import to avoid worker issues
        const otel = await import("@opentelemetry/api");
        trace = otel.trace;
        context = otel.context;
        statusCodes = otel.SpanStatusCode;
        spanKinds = otel.SpanKind;

        AtlasTelemetry.tracer = trace.getTracer("atlas", "1.0.0");
        AtlasTelemetry.isEnabled = true;

        // Set service name if not already set
        if (!env.OTEL_SERVICE_NAME) {
          env.OTEL_SERVICE_NAME = "atlas";
        }

        logger.info("🔍 OpenTelemetry enabled for Atlas", {
          serviceName: env.OTEL_SERVICE_NAME,
          endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || "default",
          protocol: env.OTEL_EXPORTER_OTLP_PROTOCOL || "http/protobuf",
        });
      } catch (error) {
        logger.warn(
          "Failed to initialize OpenTelemetry (worker environment may not support npm imports)",
          { error: String(error) },
        );
        AtlasTelemetry.isEnabled = false;
      }
    })();

    return AtlasTelemetry.initPromise;
  }

  /**
   * Check if telemetry is enabled
   */
  static get enabled(): boolean {
    return AtlasTelemetry.isEnabled;
  }

  /**
   * Ensure initialization before use
   */
  private static async ensureInitialized(): Promise<boolean> {
    await AtlasTelemetry.initialize();
    return AtlasTelemetry.isEnabled;
  }

  /**
   * Internal unified span creation method
   */
  private static async createSpan<T>(
    name: string,
    fn: (span: Span | null) => Promise<T> | T,
    options: {
      attributes?: Attributes;
      spanKind?: SpanKind;
      parentContext?: Context | null;
      parentTraceContext?: string | null;
    } = {},
  ): Promise<T> {
    const enabled = await AtlasTelemetry.ensureInitialized();
    if (!enabled || !AtlasTelemetry.tracer) {
      return await fn(null);
    }

    const { attributes: rawAttributes, spanKind, parentContext, parentTraceContext } = options;

    // Validate and sanitize attributes
    const attributes = TelemetryValidation.validateAttributes(rawAttributes);

    const kind = spanKind || spanKinds?.INTERNAL;

    // Determine the context to use
    let contextToUse: Context | undefined;
    if (parentContext) {
      contextToUse = parentContext;
    } else if (parentTraceContext && context && trace) {
      // Parse W3C traceparent header and create context manually
      contextToUse = AtlasTelemetry.parseTraceContext(parentTraceContext);
    }

    // Create span with appropriate context
    const tracer = AtlasTelemetry.tracer;
    if (!tracer) {
      return await fn(null);
    }

    const spanCreator = contextToUse
      ? (callback: (span: Span) => Promise<T>) =>
          tracer.startActiveSpan(name, { kind }, contextToUse, callback)
      : (callback: (span: Span) => Promise<T>) => tracer.startActiveSpan(name, { kind }, callback);

    return await spanCreator(async (span: Span) => {
      return await AtlasTelemetry.executeSpanLogic(
        span,
        attributes,
        parentTraceContext || null,
        fn,
      );
    });
  }

  /**
   * Parse W3C trace context and create OpenTelemetry context
   */
  private static parseTraceContext(parentTraceContext: string): Context | undefined {
    if (!context || !trace) return undefined;

    // Validate the traceparent format first
    const validatedTraceContext = TelemetryValidation.validateTraceParent(parentTraceContext);
    if (!validatedTraceContext) {
      return undefined;
    }

    try {
      const parts = validatedTraceContext.split("-");
      const traceId = parts[1];
      const spanId = parts[2];
      const traceFlagsStr = parts[3];

      if (!traceId || !spanId || !traceFlagsStr) {
        logger.warn("Invalid trace context parts", { parentTraceContext: validatedTraceContext });
        return undefined;
      }

      const traceFlags = parseInt(traceFlagsStr, 16);

      logger.debug("Manually extracting parent trace context", {
        parentTraceContext: validatedTraceContext,
        traceId,
        spanId,
      });

      const parentSpanContext = { traceId, spanId, traceFlags, isRemote: true };

      return trace.setSpanContext(context.active(), parentSpanContext);
    } catch (error) {
      logger.warn("Failed to extract parent trace context manually", {
        parentTraceContext: validatedTraceContext,
        error: String(error),
      });
    }

    return undefined;
  }

  /**
   * Execute a function within an active span context
   * This creates proper parent-child relationships automatically
   */
  static withSpan<T>(
    name: string,
    fn: (span: Span | null) => Promise<T> | T,
    attributes?: Attributes,
    spanKind?: SpanKind,
  ): Promise<T> {
    return AtlasTelemetry.createSpan(name, fn, { attributes, spanKind });
  }

  /**
   * Create a server span for incoming HTTP requests
   */
  static async withServerSpan<T>(
    operationName: string,
    fn: (span: Span | null) => Promise<T> | T,
    attributes?: Attributes,
  ): Promise<T> {
    await AtlasTelemetry.ensureInitialized();
    const kind = spanKinds?.SERVER;
    return AtlasTelemetry.withSpan(operationName, fn, attributes, kind);
  }

  /**
   * Create a client span for outgoing requests/calls
   */
  static async withClientSpan<T>(
    operationName: string,
    fn: (span: Span | null) => Promise<T> | T,
    attributes?: Attributes,
  ): Promise<T> {
    await AtlasTelemetry.ensureInitialized();
    const kind = spanKinds?.CLIENT;
    return AtlasTelemetry.withSpan(operationName, fn, attributes, kind);
  }

  /**
   * Add Atlas-specific attributes to a span based on component type
   */
  static addAtlasAttributes(span: Span | null, component: unknown, attributes: unknown) {
    if (!span) return;

    try {
      // Validate component type
      const validatedComponent = TelemetryValidation.validateComponent(component);
      span.setAttribute("atlas.component", validatedComponent);

      // Validate and sanitize attributes
      const validatedAttributes = TelemetryValidation.validateAttributes(attributes);
      if (!validatedAttributes) return;

      // Add component-specific attributes with proper namespacing
      for (const [key, value] of Object.entries(validatedAttributes)) {
        if (value !== undefined) {
          const attributeKey = key.startsWith("atlas.")
            ? key
            : `atlas.${validatedComponent}.${key}`;
          span.setAttribute(attributeKey, value);
        }
      }
    } catch (error) {
      logger.warn(`Failed to add ${component} attributes`, { error: String(error) });
    }
  }

  /**
   * Add component-specific attributes with Atlas namespacing
   * Consolidates all the convenience methods into a single parameterized approach
   */
  static addComponentAttributes(
    span: Span | null,
    component: unknown,
    componentAttributes: { id?: string; type?: string; sessionId?: string; [key: string]: unknown },
    additionalAttributes?: unknown,
  ) {
    // Build the final attributes object
    const baseAttributes: Record<string, unknown> = { ...componentAttributes };

    // Merge additional attributes if provided
    if (additionalAttributes && typeof additionalAttributes === "object") {
      Object.assign(baseAttributes, additionalAttributes);
    }

    AtlasTelemetry.addAtlasAttributes(span, component, baseAttributes);
  }

  /**
   * Get the current span context for manual propagation
   * This is useful for passing context to workers via MessagePort
   */
  static async getCurrentSpanContext(): Promise<string | null> {
    const enabled = await AtlasTelemetry.ensureInitialized();
    if (!enabled || !context || !trace) return null;

    try {
      const activeContext = context.active();
      const activeSpan = trace.getSpan(activeContext);

      if (activeSpan) {
        const spanContext = activeSpan.spanContext();
        // Return W3C trace context format for propagation
        return `00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags
          .toString(16)
          .padStart(2, "0")}`;
      }
    } catch (error) {
      logger.warn("Failed to get span context", { error: String(error) });
    }

    return null;
  }

  /**
   * Start a span with explicit parent context (for worker communication)
   */
  static withSpanFromContext<T>(
    name: string,
    parentTraceContext: string | null,
    fn: (span: Span | null) => Promise<T> | T,
    attributes?: Attributes,
  ): Promise<T> {
    return AtlasTelemetry.createSpan(name, fn, { attributes, parentTraceContext });
  }

  private static async executeSpanLogic<T>(
    span: Span,
    attributes: Attributes | undefined,
    parentTraceContext: string | null,
    fn: (span: Span | null) => Promise<T> | T,
  ): Promise<T> {
    try {
      // Add custom attributes
      if (attributes) {
        for (const [key, value] of Object.entries(attributes)) {
          if (value !== undefined) {
            span.setAttribute(key, value);
          }
        }
      }

      // If we have parent trace context, add it as an attribute for debugging
      if (parentTraceContext) {
        span.setAttribute("atlas.parent.trace_context", parentTraceContext);
      }

      const result = await fn(span);
      span.setStatus({ code: statusCodes?.OK || 1 });
      return result;
    } catch (error) {
      if (span.recordException && error instanceof Error) {
        span.recordException(error);
      }
      span.setStatus({ code: statusCodes?.ERROR || 2, message: String(error) });
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Create a trace context header for worker communication
   */
  static async createTraceHeaders(): Promise<Record<string, string>> {
    const enabled = await AtlasTelemetry.ensureInitialized();
    if (!enabled || !context || !trace) {
      return {};
    }

    try {
      // Get current active span and its context
      const activeContext = context.active();
      const activeSpan = trace.getSpan(activeContext);

      if (activeSpan) {
        const spanContext = activeSpan.spanContext();
        if (spanContext.traceId && spanContext.spanId) {
          // Create W3C traceparent header manually since propagation API is failing
          const traceFlags = spanContext.traceFlags || 0;
          const traceparent = `00-${spanContext.traceId}-${spanContext.spanId}-${traceFlags
            .toString(16)
            .padStart(2, "0")}`;

          logger.debug("Created trace headers from active span", {
            traceparent,
            traceId: spanContext.traceId,
            spanId: spanContext.spanId,
          });

          return { traceparent };
        }
      }

      // Try propagation API as fallback
      const propagation = await import("@opentelemetry/api").then((m) => m.propagation);
      if (propagation) {
        const carrier: Record<string, string> = {};
        propagation.inject(activeContext, carrier);

        if (carrier.traceparent) {
          logger.debug("Created trace headers using propagation API fallback", {
            traceparent: carrier.traceparent,
          });
          return carrier;
        }
      }
    } catch (error) {
      logger.warn("Failed to create trace headers", { error: String(error) });
    }

    logger.debug("No active span context found, returning empty headers");
    return {};
  }

  /**
   * Extract trace context from headers
   */
  static extractTraceContext(headers: Record<string, unknown>): string | null {
    const traceparent = headers?.traceparent;
    return typeof traceparent === "string" ? traceparent : null;
  }

  /**
   * Higher-order function to handle the common worker message pattern:
   * Extract trace context -> Create child span -> Add attributes -> Execute logic
   */
  static async withWorkerSpan<T>(
    context: unknown,
    fn: (span: Span | null) => Promise<T> | T,
  ): Promise<T> {
    // Validate worker context
    const validatedContext = TelemetryValidation.validateWorkerContext(context);

    // Generate span name from context using array join
    const spanName = [
      validatedContext.component,
      validatedContext.operation,
      validatedContext.agentType,
    ]
      .filter(Boolean)
      .join(".");

    // Extract trace context from headers
    const parentTraceContext = AtlasTelemetry.extractTraceContext(
      validatedContext.traceHeaders || {},
    );

    return await AtlasTelemetry.withSpanFromContext(spanName, parentTraceContext, async (span) => {
      // Set component type
      span?.setAttribute("atlas.component", validatedContext.component);

      // Set all context attributes directly using static mapping (single loop)
      (
        Object.keys(WORKER_ATTRIBUTE_MAPPING) as Array<keyof typeof WORKER_ATTRIBUTE_MAPPING>
      ).forEach((contextKey) => {
        const attributeKey = WORKER_ATTRIBUTE_MAPPING[contextKey];
        const value = validatedContext[contextKey];
        if (value !== undefined && typeof value === "string") {
          span?.setAttribute(attributeKey, value);
        }
      });

      // Set any additional custom attributes (already validated by context validation)
      if (validatedContext.attributes) {
        Object.entries(validatedContext.attributes).forEach(([key, value]) => {
          if (value !== undefined) {
            span?.setAttribute(key, value);
          }
        });
      }

      // Execute the business logic
      return await fn(span);
    });
  }

  /**
   * Create a span for LLM operations with detailed telemetry
   */
  static async withLLMSpan<T>(
    provider: string,
    model: string,
    operation: "generate_text" | "generate_with_tools",
    fn: (span: Span | null) => Promise<T>,
    additionalAttributes?: Partial<LLMAttributes>,
  ): Promise<T> {
    const baseAttributes: LLMAttributes = { provider, model, ...additionalAttributes };

    // Validate LLM attributes
    const validatedAttributes = LLMAttributesSchema.safeParse(baseAttributes);
    if (!validatedAttributes.success) {
      logger.warn("Invalid LLM attributes", {
        error: validatedAttributes.error.issues,
        providedAttributes: baseAttributes,
      });
    }

    const attributes = validatedAttributes.success ? validatedAttributes.data : baseAttributes;

    // Create standardized LLM attributes with proper namespacing
    const llmAttributes: Attributes = {};
    Object.entries(attributes).forEach(([key, value]) => {
      if (value !== undefined) {
        llmAttributes[`llm.${key}`] = value;
      }
    });

    // Add operation type
    llmAttributes["llm.operation"] = operation;

    const spanName = `llm.${operation}`;

    return await AtlasTelemetry.withClientSpan(
      spanName,
      async (span) => {
        // Add LLM-specific attributes
        if (span) {
          Object.entries(llmAttributes).forEach(([key, value]) => {
            if (value !== undefined) {
              span.setAttribute(key, value);
            }
          });
        }

        const startTime = Date.now();

        try {
          const result = await fn(span);

          // Record generation latency
          const latency = Date.now() - startTime;
          span?.setAttribute("llm.generation_latency", latency);

          return result;
        } catch (error) {
          // Record error category if possible
          const errorCategory = error instanceof Error ? error.constructor.name : "Unknown";
          span?.setAttribute("llm.error_category", errorCategory);
          throw error;
        }
      },
      llmAttributes,
    );
  }
}
