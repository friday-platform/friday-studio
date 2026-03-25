import { env } from "node:process";
import type { Span, Tracer } from "@opentelemetry/api";

export type { Span };

let _tracerPromise: Promise<Tracer | null> | undefined;

function getTracer(): Promise<Tracer | null> {
  if (!_tracerPromise) {
    _tracerPromise = resolveTracer();
  }
  return _tracerPromise;
}

async function resolveTracer(): Promise<Tracer | null> {
  if (env.OTEL_DENO !== "true") return null;
  try {
    const { trace } = await import("@opentelemetry/api");
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
          `Ensure OTEL_DENO=true is set BEFORE the Deno process starts.\n`,
      );
      return null;
    }

    return tracer;
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
  const tracer = await getTracer();
  if (!tracer) return fn(null);
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
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
  const tracer = await getTracer();
  if (!tracer) return null;
  return tracer.startSpan(name, { attributes });
}
