import { afterEach, describe, expect, it } from "vitest";
import {
  getOAuthMetrics,
  InMemoryOAuthMetricsSink,
  setOAuthMetricsSinkForTesting,
} from "./oauth-metrics.ts";

describe("InMemoryOAuthMetricsSink", () => {
  it("counts refresh outcomes keyed by every attribute", () => {
    const sink = new InMemoryOAuthMetricsSink();
    sink.recordRefreshOutcome({ kind: "success", provider: "google-calendar", retry_attempt: 1 });
    sink.recordRefreshOutcome({
      kind: "transient",
      reason: "http_5xx",
      provider: "google-calendar",
      retry_attempt: 1,
    });
    sink.recordRefreshOutcome({
      kind: "transient",
      reason: "http_5xx",
      provider: "google-calendar",
      retry_attempt: 1,
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

  it("tracks the every other counter via its dedicated method", () => {
    const sink = new InMemoryOAuthMetricsSink();
    sink.recordRetrySaved({ provider: "google-calendar", first_reason: "http_5xx" });
    sink.recordPlatformBug({ provider: "google-calendar", reason: "4xx_non_invalid_grant" });
    sink.recordSilentFallback({ provider: "google-calendar", reason: "http_500" });

    const ctx = { family: "google", workspaceId: "ws1", sessionId: "s1" };
    sink.recordElicitationCreated(ctx);
    sink.recordElicitationDeduped(ctx);
    sink.recordElicitationAnsweredRetry(ctx);
    sink.recordElicitationAnsweredCancel(ctx);
    sink.recordElicitationExpired(ctx);
    sink.recordElicitationAborted(ctx);
    sink.recordElicitationRetrySucceeded(ctx);
    sink.recordElicitationRetryFailed(ctx);

    expect(sink.getCount("link.oauth.refresh.retry_saved")).toEqual(1);
    expect(sink.getCount("link.oauth.refresh.platform_bug")).toEqual(1);
    expect(sink.getCount("link.oauth.refresh.silent_fallback")).toEqual(1);
    expect(sink.getCount("link.oauth.elicitation.created")).toEqual(1);
    expect(sink.getCount("link.oauth.elicitation.deduped")).toEqual(1);
    expect(sink.getCount("link.oauth.elicitation.answered_retry")).toEqual(1);
    expect(sink.getCount("link.oauth.elicitation.answered_cancel")).toEqual(1);
    expect(sink.getCount("link.oauth.elicitation.expired")).toEqual(1);
    expect(sink.getCount("link.oauth.elicitation.aborted")).toEqual(1);
    expect(sink.getCount("link.oauth.elicitation.retry_succeeded")).toEqual(1);
    expect(sink.getCount("link.oauth.elicitation.retry_failed")).toEqual(1);
  });

  it("captures histogram samples by attribute and aggregates with filters", () => {
    const sink = new InMemoryOAuthMetricsSink();
    sink.recordAnswerLatencyMs(120, {
      family: "google",
      workspaceId: "ws1",
      sessionId: "s1",
      status: "answered_retry",
    });
    sink.recordAnswerLatencyMs(2_500, {
      family: "google",
      workspaceId: "ws1",
      sessionId: "s1",
      status: "answered_retry",
    });
    sink.recordAnswerLatencyMs(180_000, {
      family: "google",
      workspaceId: "ws1",
      sessionId: "s1",
      status: "expired",
    });

    expect(sink.getHistogramSamples("link.oauth.elicitation.answer_latency_ms").length).toEqual(3);
    expect(
      sink
        .getHistogramSamples("link.oauth.elicitation.answer_latency_ms", {
          status: "answered_retry",
        })
        .sort((a, b) => a - b),
    ).toEqual([120, 2_500]);
    expect(
      sink.getHistogramSamples("link.oauth.elicitation.answer_latency_ms", { status: "expired" }),
    ).toEqual([180_000]);
  });

  it("reset() clears both counters and histograms", () => {
    const sink = new InMemoryOAuthMetricsSink();
    sink.recordElicitationCreated({ family: "f", workspaceId: "w", sessionId: "s" });
    sink.recordAnswerLatencyMs(1, {
      family: "f",
      workspaceId: "w",
      sessionId: "s",
      status: "answered_retry",
    });
    sink.reset();
    expect(sink.getCount("link.oauth.elicitation.created")).toEqual(0);
    expect(sink.getHistogramSamples("link.oauth.elicitation.answer_latency_ms").length).toEqual(0);
  });

  it("filter matching ignores extra labels on samples", () => {
    const sink = new InMemoryOAuthMetricsSink();
    sink.recordRefreshOutcome({
      kind: "transient",
      reason: "network",
      provider: "google-calendar",
      retry_attempt: 1,
    });
    // Filter by a strict subset of labels — extra labels (`reason`,
    // `retry_attempt`) on the recorded sample should not exclude it.
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
      defaultSink.recordRefreshOutcome({
        kind: "success",
        provider: "google-calendar",
        retry_attempt: 1,
      }),
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
