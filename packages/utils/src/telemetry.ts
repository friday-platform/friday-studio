import type { Attributes, Tracer } from "@opentelemetry/api";

export function withSpan<T>(
  tracer: Tracer | undefined,
  spanName: string,
  attributes: Attributes,
  fn: () => Promise<T>,
): Promise<T> {
  if (tracer) {
    return tracer.startActiveSpan(spanName, { attributes }, fn);
  }
  return fn();
}
