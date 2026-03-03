/**
 * Prometheus metrics for Ledger service.
 *
 * Exposes a request counter and a duration histogram with standard
 * HTTP latency buckets (in milliseconds).
 */

/** Histogram bucket boundaries in ms. */
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

interface RequestMetric {
  m: string;
  p: string;
  s: number;
  count: number;
  sum: number;
  /** Cumulative counts for each bucket boundary (same length as BUCKETS). */
  buckets: number[];
}

const metrics = new Map<string, RequestMetric>();

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
    existing.sum += durationMs;
    for (let i = 0; i < BUCKETS.length; i++) {
      if (durationMs <= (BUCKETS[i] ?? Infinity))
        existing.buckets[i] = (existing.buckets[i] ?? 0) + 1;
    }
  } else {
    const buckets = BUCKETS.map((b) => (durationMs <= b ? 1 : 0));
    metrics.set(key, { m: method, p: path, s: status, count: 1, sum: durationMs, buckets });
  }
}

export function getMetrics(): string {
  const lines: string[] = [
    "# HELP ledger_http_requests_total Total number of HTTP requests",
    "# TYPE ledger_http_requests_total counter",
  ];

  for (const { m, p, s, count } of metrics.values()) {
    lines.push(`ledger_http_requests_total{method="${m}",path="${p}",status="${s}"} ${count}`);
  }

  lines.push("# HELP ledger_http_request_duration_ms HTTP request duration in milliseconds");
  lines.push("# TYPE ledger_http_request_duration_ms histogram");

  for (const { m, p, s, count, sum, buckets } of metrics.values()) {
    const base = `{method="${m}",path="${p}",status="${s}"`;
    for (const [i, boundary] of BUCKETS.entries()) {
      lines.push(
        `ledger_http_request_duration_ms_bucket${base},le="${boundary}"} ${buckets[i] ?? 0}`,
      );
    }
    lines.push(`ledger_http_request_duration_ms_bucket${base},le="+Inf"} ${count}`);
    lines.push(`ledger_http_request_duration_ms_sum${base}} ${sum}`);
    lines.push(`ledger_http_request_duration_ms_count${base}} ${count}`);
  }

  return `${lines.join("\n")}\n`;
}

/** Clears all recorded metrics. Exposed for tests only. */
export function resetMetrics(): void {
  metrics.clear();
}
