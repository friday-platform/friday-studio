import { afterEach, describe, expect, it } from "vitest";
import {
  getOAuthMetrics,
  InMemoryOAuthMetricsSink,
  setOAuthMetricsSinkForTesting,
} from "./oauth-metrics.ts";

describe("InMemoryOAuthMetricsSink", () => {
  it("counts refresh outcomes keyed by every attribute", () => {
    const sink = new InMemoryOAuthMetricsSink();
    sink.recordRefreshOutcome({ kind: "success", provider: "google-calendar" });
    sink.recordRefreshOutcome({
      kind: "transient",
      reason: "http_5xx",
      provider: "google-calendar",
    });
    sink.recordRefreshOutcome({
      kind: "transient",
      reason: "http_5xx",
      provider: "google-calendar",
    });

    expect(sink.getCount("link.oauth.refresh.outcome")).toEqual(3);
    expect(sink.getCount("link.oauth.refresh.outcome", { kind: "transient" })).toEqual(2);
    expect(
      sink.getCount("link.oauth.refresh.outcome", { kind: "transient", reason: "http_5xx" }),
    ).toEqual(2);
    expect(
      sink.getCount("link.oauth.refresh.outcome", { kind: "transient", reason: "platform_bug" }),
    ).toEqual(0);
  });

  it("tracks platform_bug and silent_fallback counters via their dedicated methods", () => {
    const sink = new InMemoryOAuthMetricsSink();
    sink.recordPlatformBug({ provider: "google-calendar", reason: "4xx_non_invalid_grant" });
    sink.recordSilentFallback({ provider: "google-calendar", reason: "http_500" });

    expect(sink.getCount("link.oauth.refresh.platform_bug")).toEqual(1);
    expect(sink.getCount("link.oauth.refresh.silent_fallback")).toEqual(1);
  });

  it("reset() clears counters", () => {
    const sink = new InMemoryOAuthMetricsSink();
    sink.recordPlatformBug({ provider: "google-calendar", reason: "invalid_client" });
    sink.reset();
    expect(sink.getCount("link.oauth.refresh.platform_bug")).toEqual(0);
  });

  it("filter matching ignores extra labels on samples", () => {
    const sink = new InMemoryOAuthMetricsSink();
    sink.recordRefreshOutcome({
      kind: "transient",
      reason: "network",
      provider: "google-calendar",
    });
    // Filter by a strict subset of labels — extra labels on the recorded
    // sample should not exclude it.
    expect(sink.getCount("link.oauth.refresh.outcome", { kind: "transient" })).toEqual(1);
  });
});

describe("getOAuthMetrics + setOAuthMetricsSinkForTesting", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    if (restore) {
      restore();
      restore = null;
    }
  });

  it("default sink is a no-op when OTEL_DENO is disabled (does not throw)", () => {
    const defaultSink = getOAuthMetrics();
    expect(() =>
      defaultSink.recordRefreshOutcome({ kind: "success", provider: "google-calendar" }),
    ).not.toThrow();
  });

  it("swap-in sink intercepts every call until the restore fn fires", () => {
    const probe = new InMemoryOAuthMetricsSink();
    restore = setOAuthMetricsSinkForTesting(probe);
    getOAuthMetrics().recordPlatformBug({ provider: "google-calendar", reason: "invalid_client" });
    expect(probe.getCount("link.oauth.refresh.platform_bug")).toEqual(1);
    restore();
    restore = null;
    // After restore, calls go back to the default no-op sink.
    getOAuthMetrics().recordPlatformBug({ provider: "google-calendar", reason: "after_restore" });
    expect(probe.getCount("link.oauth.refresh.platform_bug")).toEqual(1);
  });
});
