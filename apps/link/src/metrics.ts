/**
 * Simple Prometheus metrics for Link service.
 */

const metrics = new Map<string, { m: string; p: string; s: number; count: number; ms: number }>();

export function recordRequest(
  method: string,
  path: string,
  status: number,
  durationMs: number,
): void {
  const key = `${method}:${path}:${status}`;
  const existing = metrics.get(key);
  if (existing) {
    existing.count++;
    existing.ms += durationMs;
  } else {
    metrics.set(key, { m: method, p: path, s: status, count: 1, ms: durationMs });
  }
}

export function getMetrics(): string {
  const lines = [
    "# TYPE link_http_requests_total counter",
    "# TYPE link_http_request_duration_ms_total counter",
  ];
  for (const { m, p, s, count, ms } of metrics.values()) {
    const labels = `{method="${m}",path="${p}",status="${s}"}`;
    lines.push(`link_http_requests_total${labels} ${count}`);
    lines.push(`link_http_request_duration_ms_total${labels} ${ms}`);
  }
  return `${lines.join("\n")}\n`;
}
