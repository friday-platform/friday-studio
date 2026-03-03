import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "@db/sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "./index.ts";
import { getMetrics, recordRequest, resetMetrics } from "./metrics.ts";
import { SQLiteAdapter } from "./sqlite-adapter.ts";

afterEach(() => resetMetrics());

// ---------------------------------------------------------------------------
// Unit tests — metrics module
// ---------------------------------------------------------------------------

describe("recordRequest", () => {
  test("aggregates counts for the same method/path/status", () => {
    recordRequest("GET", "/v1/resources/:id", 200, 10);
    recordRequest("GET", "/v1/resources/:id", 200, 20);

    const output = getMetrics();
    expect(output).toContain(
      'ledger_http_requests_total{method="GET",path="/v1/resources/:id",status="200"} 2',
    );
  });

  test("separates different status codes", () => {
    recordRequest("GET", "/v1/resources/:id", 200, 5);
    recordRequest("GET", "/v1/resources/:id", 404, 3);

    const output = getMetrics();
    expect(output).toContain(
      'ledger_http_requests_total{method="GET",path="/v1/resources/:id",status="200"} 1',
    );
    expect(output).toContain(
      'ledger_http_requests_total{method="GET",path="/v1/resources/:id",status="404"} 1',
    );
  });
});

describe("histogram buckets", () => {
  const label = 'method="POST",path="/v1/query",status="200"';

  test("counts observations in correct cumulative buckets", () => {
    // 3ms → falls in le=5, le=10, le=25, ...
    recordRequest("POST", "/v1/query", 200, 3);
    // 75ms → falls in le=100, le=250, ...
    recordRequest("POST", "/v1/query", 200, 75);

    const output = getMetrics();

    // le="5" — only the 3ms request
    expect(output).toContain(`ledger_http_request_duration_ms_bucket{${label},le="5"} 1`);
    // le="50" — still only the 3ms request
    expect(output).toContain(`ledger_http_request_duration_ms_bucket{${label},le="50"} 1`);
    // le="100" — both requests
    expect(output).toContain(`ledger_http_request_duration_ms_bucket{${label},le="100"} 2`);
    // +Inf always equals total count
    expect(output).toContain(`ledger_http_request_duration_ms_bucket{${label},le="+Inf"} 2`);
  });

  test("tracks sum of all durations", () => {
    recordRequest("GET", "/health", 200, 7);
    recordRequest("GET", "/health", 200, 13);

    const output = getMetrics();
    expect(output).toContain(
      'ledger_http_request_duration_ms_sum{method="GET",path="/health",status="200"} 20',
    );
    expect(output).toContain(
      'ledger_http_request_duration_ms_count{method="GET",path="/health",status="200"} 2',
    );
  });

  test("large durations only land in +Inf when exceeding all boundaries", () => {
    recordRequest("GET", "/slow", 200, 99999);

    const output = getMetrics();
    expect(output).toContain(
      'ledger_http_request_duration_ms_bucket{method="GET",path="/slow",status="200",le="10000"} 0',
    );
    expect(output).toContain(
      'ledger_http_request_duration_ms_bucket{method="GET",path="/slow",status="200",le="+Inf"} 1',
    );
  });
});

describe("multi-key aggregation", () => {
  test("emits counter and histogram lines for all distinct route/method/status combinations", () => {
    recordRequest("GET", "/v1/resources/:workspaceId", 200, 5);
    recordRequest("POST", "/v1/resources/:workspaceId/provision", 201, 12);
    recordRequest("GET", "/v1/resources/:workspaceId", 404, 2);

    const output = getMetrics();

    // Counter lines for all three keys
    expect(output).toContain(
      'ledger_http_requests_total{method="GET",path="/v1/resources/:workspaceId",status="200"} 1',
    );
    expect(output).toContain(
      'ledger_http_requests_total{method="POST",path="/v1/resources/:workspaceId/provision",status="201"} 1',
    );
    expect(output).toContain(
      'ledger_http_requests_total{method="GET",path="/v1/resources/:workspaceId",status="404"} 1',
    );

    // Histogram lines for all three keys
    expect(output).toContain(
      'ledger_http_request_duration_ms_bucket{method="GET",path="/v1/resources/:workspaceId",status="200",le="5"} 1',
    );
    expect(output).toContain(
      'ledger_http_request_duration_ms_bucket{method="POST",path="/v1/resources/:workspaceId/provision",status="201",le="25"} 1',
    );
    expect(output).toContain(
      'ledger_http_request_duration_ms_bucket{method="GET",path="/v1/resources/:workspaceId",status="404",le="5"} 1',
    );
  });
});

describe("getMetrics output format", () => {
  test("includes HELP and TYPE lines", () => {
    const output = getMetrics();
    expect(output).toContain("# HELP ledger_http_requests_total Total number of HTTP requests");
    expect(output).toContain("# TYPE ledger_http_requests_total counter");
    expect(output).toContain(
      "# HELP ledger_http_request_duration_ms HTTP request duration in milliseconds",
    );
    expect(output).toContain("# TYPE ledger_http_request_duration_ms histogram");
  });

  test("ends with a trailing newline", () => {
    recordRequest("GET", "/test", 200, 1);
    const output = getMetrics();
    expect(output.endsWith("\n")).toBe(true);
  });

  test("returns only headers when no requests recorded", () => {
    const output = getMetrics();
    const lines = output.trim().split("\n");
    expect(lines).toHaveLength(4); // 2 HELP + 2 TYPE
  });
});

// ---------------------------------------------------------------------------
// Integration test — /metrics route wiring
// ---------------------------------------------------------------------------

describe("/metrics endpoint", () => {
  let tempDir: string;
  let db: Database;
  let adapter: SQLiteAdapter;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ledger-metrics-test-"));
    db = new Database(join(tempDir, "test.db"));
    adapter = new SQLiteAdapter(db);
    await adapter.init();
    app = createApp(() => adapter);
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // Already closed
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns 200 with Prometheus content type", async () => {
    const res = await app.request("/metrics");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
  });

  test("response body contains HELP and TYPE headers", async () => {
    const res = await app.request("/metrics");
    const body = await res.text();

    expect(body).toContain("# HELP ledger_http_requests_total");
    expect(body).toContain("# TYPE ledger_http_request_duration_ms histogram");
  });

  test("records metrics from prior requests", async () => {
    // Hit a route that gets recorded
    await app.request("/v1/skill");

    const res = await app.request("/metrics");
    const body = await res.text();

    expect(body).toContain('ledger_http_requests_total{method="GET"');
  });
});
