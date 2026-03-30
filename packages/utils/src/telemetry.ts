import { env } from "node:process";
import type { Context, Span, Tracer } from "@opentelemetry/api";

export type { Span };

interface OtelRuntime {
  tracer: Tracer;
  activeContext: () => Context;
}

let _runtimePromise: Promise<OtelRuntime | null> | undefined;

function getRuntime(): Promise<OtelRuntime | null> {
  if (!_runtimePromise) {
    _runtimePromise = resolveRuntime();
  }
  return _runtimePromise;
}

async function resolveRuntime(): Promise<OtelRuntime | null> {
  if (env.OTEL_DENO !== "true") return null;
  try {
    const { context, trace } = await import("@opentelemetry/api");
    const tracer = trace.getTracer("atlas", "1.0.0");

    // Verify the tracer produces recording spans. Deno auto-registers its
    // TracerProvider with @opentelemetry/api, but if registration fails
    // (version mismatch, missing OTEL_DENO at startup), the default
    // ProxyTracerProvider returns NonRecordingSpan instances that silently
    // discard all attributes and events.
    const probe = tracer.startSpan("atlas.probe");
    const recording = probe.isRecording();
    probe.end();
    if (!recording) {
      const provider = trace.getTracerProvider();
      const { stderr } = await import("node:process");
      stderr.write(
        `[atlas/telemetry] OTEL_DENO=true but TracerProvider is ${provider.constructor.name} ` +
          `(spans are NonRecordingSpan). Custom spans will be silently dropped. ` +
          `Ensure OTEL_DENO=true is set BEFORE the Deno process starts ` +
          `and otel-bootstrap.ts is used as the entry point.\n`,
      );
      return null;
    }

    return { tracer, activeContext: () => context.active() };
  } catch {
    return null;
  }
}

/**
 * Execute `fn` inside an OTEL span when telemetry is enabled (OTEL_DENO=true).
 * When disabled, calls `fn(null)` directly with zero overhead.
 * The span is started as an active span so child spans inherit the trace context.
 */
export async function withOtelSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span | null) => Promise<T>,
): Promise<T> {
  const rt = await getRuntime();
  if (!rt) return fn(null);
  return rt.tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      return result;
    } catch (err) {
      if (err instanceof Error) span.recordException(err);
      span.setStatus({ code: 2 /* SpanStatusCode.ERROR */, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Start an OTEL span and return it for manual lifecycle management.
 * Caller is responsible for calling `span.end()`.
 * Returns null when telemetry is disabled.
 *
 * Use instead of `withOtelSpan` when the span must outlive the setup
 * function — e.g. streaming, where the span should cover the full
 * stream consumption, not just stream setup.
 */
export async function startOtelSpan(
  name: string,
  attributes: Record<string, string | number | boolean>,
): Promise<Span | null> {
  const rt = await getRuntime();
  if (!rt) return null;
  // Pass the active context so the span inherits the current trace,
  // unlike startSpan() with no context arg which creates a root span.
  return rt.tracer.startSpan(name, { attributes }, rt.activeContext());
}

/**
 * Execute `fn` inside an active OTEL span but do NOT auto-end the span.
 * The span is activated in context (so child spans nest correctly) and
 * passed to `fn` — the caller is responsible for calling `span.end()`.
 *
 * Use for streaming where the span must outlive the setup callback:
 * the span is correctly parented via `startActiveSpan`, but its
 * lifetime extends beyond the callback into the stream consumer.
 */
export async function withManualOtelSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span | null) => Promise<T>,
): Promise<T> {
  const rt = await getRuntime();
  if (!rt) return fn(null);
  return rt.tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      if (err instanceof Error) span.recordException(err);
      span.setStatus({ code: 2 /* SpanStatusCode.ERROR */, message: String(err) });
      span.end();
      throw err;
    }
    // No finally { span.end() } — caller manages span lifecycle
  });
}
