import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { httpRequestDuration, registry } from "./metrics";

describe("metrics", () => {
  afterAll(() => {
    registry.clear();
  });

  beforeEach(() => {
    registry.resetMetrics();
  });

  it("exposes histogram with configured latency buckets", async () => {
    httpRequestDuration.observe({ method: "GET", route: "/", status: "200" }, 0.05);
    const text = await registry.metrics();
    expect(text).toContain("http_request_duration_seconds_bucket{");
    expect(text).toContain('le="0.005"');
    expect(text).toContain('le="0.05"');
    expect(text).toContain('le="0.25"');
    expect(text).toContain('le="10"');
  });

  it("tracks request count and duration with labels", async () => {
    httpRequestDuration.observe({ method: "GET", route: "/", status: "200" }, 0.05);
    httpRequestDuration.observe({ method: "POST", route: "/api", status: "201" }, 0.1);

    const text = await registry.metrics();
    expect(text).toContain(
      'http_request_duration_seconds_count{service="friday-website",method="GET",route="/",status="200"} 1',
    );
    expect(text).toContain(
      'http_request_duration_seconds_count{service="friday-website",method="POST",route="/api",status="201"} 1',
    );
  });
});
