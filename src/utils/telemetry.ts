import { logger } from "./logger.ts";

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
  attributes?: Record<string, string | number | boolean>;
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
let trace: any = null;
let context: any = null;
let SpanStatusCode: any = null;
let SpanKind: any = null;

/**
 * Atlas Telemetry utilities for OpenTelemetry instrumentation
 *
 * This module provides utilities for creating connected span hierarchies
 * across the Atlas architecture: workspace → supervisor → session → agent
 */
export class AtlasTelemetry {
  private static tracer: any = null;
  private static isEnabled = false;
  private static initPromise: Promise<void> | null = null;

  /**
   * Initialize OpenTelemetry (async to handle dynamic imports)
   */
  private static async initialize(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        // Check if OpenTelemetry should be enabled
        if (Deno.env.get("OTEL_DENO") !== "true") {
          logger.debug("OpenTelemetry disabled - set OTEL_DENO=true to enable");
          return;
        }

        // Dynamic import to avoid worker issues
        const otelApi = await import("npm:@opentelemetry/api@1");
        trace = otelApi.trace;
        context = otelApi.context;
        SpanStatusCode = otelApi.SpanStatusCode;
        SpanKind = otelApi.SpanKind;

        this.tracer = trace.getTracer("atlas", "1.0.0");
        this.isEnabled = true;

        // Set service name if not already set
        if (!Deno.env.get("OTEL_SERVICE_NAME")) {
          Deno.env.set("OTEL_SERVICE_NAME", "atlas");
        }

        logger.info("🔍 OpenTelemetry enabled for Atlas", {
          serviceName: Deno.env.get("OTEL_SERVICE_NAME"),
          endpoint: Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT") || "default",
          protocol: Deno.env.get("OTEL_EXPORTER_OTLP_PROTOCOL") || "http/protobuf",
        });
      } catch (error) {
        logger.warn(
          "Failed to initialize OpenTelemetry (worker environment may not support npm imports)",
          {
            error: String(error),
            workerType: typeof globalThis.WorkerGlobalScope !== "undefined" ? "worker" : "main",
          },
        );
        this.isEnabled = false;
      }
    })();

    return this.initPromise;
  }

  /**
   * Check if telemetry is enabled
   */
  static get enabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Ensure initialization before use
   */
  private static async ensureInitialized(): Promise<boolean> {
    await this.initialize();
    return this.isEnabled;
  }

  /**
   * Execute a function within an active span context
   * This creates proper parent-child relationships automatically
   */
  static async withSpan<T>(
    name: string,
    fn: (span: any) => Promise<T> | T,
    attributes?: Record<string, any>,
    spanKind?: any,
  ): Promise<T> {
    const enabled = await this.ensureInitialized();
    if (!enabled || !this.tracer) {
      return await fn(null);
    }

    const kind = spanKind || SpanKind?.INTERNAL;
    return await this.tracer.startActiveSpan(name, { kind }, async (span: any) => {
      try {
        // Add custom attributes
        if (attributes) {
          for (const [key, value] of Object.entries(attributes)) {
            span.setAttribute(key, value);
          }
        }

        // Execute the function
        const result = await fn(span);

        // Mark span as successful
        span.setStatus({ code: SpanStatusCode?.OK || 1 });

        return result;
      } catch (error) {
        // Record error in span
        if (span.recordException) {
          span.recordException(error as Error);
        }
        span.setStatus({
          code: SpanStatusCode?.ERROR || 2,
          message: String(error),
        });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Create a server span for incoming HTTP requests
   */
  static async withServerSpan<T>(
    operationName: string,
    fn: (span: any) => Promise<T> | T,
    attributes?: Record<string, any>,
  ): Promise<T> {
    await this.ensureInitialized();
    const kind = SpanKind?.SERVER;
    return this.withSpan(operationName, fn, attributes, kind);
  }

  /**
   * Create a client span for outgoing requests/calls
   */
  static async withClientSpan<T>(
    operationName: string,
    fn: (span: any) => Promise<T> | T,
    attributes?: Record<string, any>,
  ): Promise<T> {
    await this.ensureInitialized();
    const kind = SpanKind?.CLIENT;
    return this.withSpan(operationName, fn, attributes, kind);
  }

  /**
   * Add Atlas-specific attributes to a span based on component type
   */
  static addAtlasAttributes(
    span: any,
    component: "workspace" | "supervisor" | "agent" | "signal" | "session",
    attributes: Record<string, any>,
  ) {
    if (!span) return;

    try {
      // Set the component type
      span.setAttribute("atlas.component", component);

      // Add component-specific attributes with proper namespacing
      for (const [key, value] of Object.entries(attributes)) {
        const attributeKey = key.startsWith("atlas.") ? key : `atlas.${component}.${key}`;
        span.setAttribute(attributeKey, value);
      }
    } catch (error) {
      logger.warn(`Failed to add ${component} attributes`, { error: String(error) });
    }
  }

  /**
   * Convenience method for workspace attributes
   */
  static addWorkspaceAttributes(
    span: any,
    workspaceId: string,
    additionalAttributes?: Record<string, any>,
  ) {
    const attributes = { id: workspaceId, ...additionalAttributes };
    this.addAtlasAttributes(span, "workspace", attributes);
  }

  /**
   * Convenience method for supervisor attributes
   */
  static addSupervisorAttributes(
    span: any,
    supervisorType: string,
    sessionId?: string,
    additionalAttributes?: Record<string, any>,
  ) {
    const attributes: Record<string, any> = { type: supervisorType, ...additionalAttributes };
    if (sessionId) {
      attributes["atlas.session.id"] = sessionId;
    }
    this.addAtlasAttributes(span, "supervisor", attributes);
  }

  /**
   * Convenience method for agent attributes
   */
  static addAgentAttributes(
    span: any,
    agentId: string,
    agentType: string,
    additionalAttributes?: Record<string, any>,
  ) {
    const attributes = { id: agentId, type: agentType, ...additionalAttributes };
    this.addAtlasAttributes(span, "agent", attributes);
  }

  /**
   * Convenience method for signal attributes
   */
  static addSignalAttributes(
    span: any,
    signalId: string,
    signalType: string,
    additionalAttributes?: Record<string, any>,
  ) {
    const attributes = { id: signalId, type: signalType, ...additionalAttributes };
    this.addAtlasAttributes(span, "signal", attributes);
  }

  /**
   * Get the current span context for manual propagation
   * This is useful for passing context to workers via MessagePort
   */
  static async getCurrentSpanContext(): Promise<string | null> {
    const enabled = await this.ensureInitialized();
    if (!enabled || !context || !trace) return null;

    try {
      const activeContext = context.active();
      const activeSpan = trace.getSpan(activeContext);

      if (activeSpan) {
        const spanContext = activeSpan.spanContext();
        // Return W3C trace context format for propagation
        return `00-${spanContext.traceId}-${spanContext.spanId}-${
          spanContext.traceFlags.toString(16).padStart(2, "0")
        }`;
      }
    } catch (error) {
      logger.warn("Failed to get span context", { error: String(error) });
    }

    return null;
  }

  /**
   * Start a span with explicit parent context (for worker communication)
   */
  static async withSpanFromContext<T>(
    name: string,
    parentTraceContext: string | null,
    fn: (span: any) => Promise<T> | T,
    attributes?: Record<string, any>,
  ): Promise<T> {
    const enabled = await this.ensureInitialized();
    if (!enabled || !this.tracer) {
      return await fn(null);
    }

    // If we have parent trace context from another worker, extract it manually
    // The OpenTelemetry propagation API doesn't work correctly across Deno workers
    let parentContext = context?.active();

    if (parentTraceContext && context && trace) {
      try {
        // Parse W3C traceparent header: 00-{traceId}-{spanId}-{flags}
        const parts = parentTraceContext.split("-");
        if (parts.length === 4 && parts[0] === "00") {
          const traceId = parts[1];
          const spanId = parts[2];
          const traceFlags = parseInt(parts[3], 16);

          logger.debug("Manually extracting parent trace context", {
            parentTraceContext,
            traceId,
            spanId,
            spanName: name,
          });

          // Create span context manually - this ensures we use the EXACT trace ID from parent
          const parentSpanContext = {
            traceId,
            spanId,
            traceFlags,
            isRemote: true,
          };

          // Set the span context in the parent context to force inheritance
          parentContext = trace.setSpanContext(context.active(), parentSpanContext);

          logger.debug("Successfully set parent span context manually", {
            parentTraceContext,
            traceId,
            spanId,
            spanName: name,
          });
        } else {
          logger.warn("Invalid traceparent format", { parentTraceContext });
        }
      } catch (error) {
        logger.warn("Failed to extract parent trace context manually", {
          parentTraceContext,
          error: String(error),
        });
        // Fall back to current context
      }
    }

    return await this.tracer.startActiveSpan(name, {}, parentContext, async (span: any) => {
      try {
        // Add custom attributes
        if (attributes) {
          for (const [key, value] of Object.entries(attributes)) {
            span.setAttribute(key, value);
          }
        }

        // If we have parent trace context, add it as an attribute for debugging
        if (parentTraceContext) {
          span.setAttribute("atlas.parent.trace_context", parentTraceContext);
        }

        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode?.OK || 1 });
        return result;
      } catch (error) {
        if (span.recordException) {
          span.recordException(error as Error);
        }
        span.setStatus({
          code: SpanStatusCode?.ERROR || 2,
          message: String(error),
        });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Create a trace context header for worker communication
   */
  static async createTraceHeaders(): Promise<Record<string, string>> {
    const enabled = await this.ensureInitialized();
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
          const traceparent = `00-${spanContext.traceId}-${spanContext.spanId}-${
            traceFlags.toString(16).padStart(2, "0")
          }`;

          logger.debug("Created trace headers from active span", {
            traceparent,
            traceId: spanContext.traceId,
            spanId: spanContext.spanId,
          });

          return { traceparent };
        }
      }

      // Try propagation API as fallback
      const propagation = await import("npm:@opentelemetry/api@1").then((m) => m.propagation);
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
  static extractTraceContext(headers: Record<string, any>): string | null {
    return headers?.["traceparent"] || null;
  }

  /**
   * Higher-order function to handle the common worker message pattern:
   * Extract trace context -> Create child span -> Add attributes -> Execute logic
   */
  static async withWorkerSpan<T>(
    context: WorkerSpanContext,
    fn: (span: any) => Promise<T> | T,
  ): Promise<T> {
    // Generate span name from context using array join
    const spanName = [context.component, context.operation, context.agentType].filter(Boolean).join(
      ".",
    );

    // Extract trace context from headers
    const parentTraceContext = this.extractTraceContext(context.traceHeaders || {});

    return await this.withSpanFromContext(
      spanName,
      parentTraceContext,
      async (span) => {
        // Set component type
        span?.setAttribute("atlas.component", context.component);

        // Set all context attributes directly using static mapping (single loop)
        Object.entries(WORKER_ATTRIBUTE_MAPPING).forEach(([contextKey, attributeKey]) => {
          const value = (context as any)[contextKey];
          if (value) {
            span?.setAttribute(attributeKey, value);
          }
        });

        // Set any additional custom attributes
        if (context.attributes) {
          Object.entries(context.attributes).forEach(([key, value]) => {
            span?.setAttribute(key, value);
          });
        }

        // Execute the business logic
        return await fn(span);
      },
    );
  }
}
