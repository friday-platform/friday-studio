/**
 * OAuth refresh + elicitation telemetry instruments.
 *
 * Counters and one histogram covering the v8 OAuth refresh resilience design
 * (`docs/plans/2026-05-11-oauth-refresh-resilience-design.v8.md`, "Telemetry"
 * section). Emitted from three call sites that don't share a module:
 *
 *   - `apps/link/src/oauth/delegated.ts` — classifier outcomes + retry_saved
 *     + platform_bug.
 *   - `apps/link/src/routes/credentials.ts` — silent_fallback.
 *   - `packages/mcp/src/create-mcp-tools-with-retry.ts` — elicitation
 *     create / answer / expire / abort / dedup + the answer-latency
 *     histogram.
 *
 * Two backends share one `OAuthMetricsSink` interface:
 *   - `OtelOAuthMetricsSink` — emits OpenTelemetry counters and a histogram
 *     via a meter named `"link.oauth"`. Used in production. Lazy-bootstrapped
 *     so module load doesn't depend on an OTel runtime being available.
 *   - `InMemoryOAuthMetricsSink` — synchronous counters in a Map for tests.
 *     Tests install it via `setOAuthMetricsSinkForTesting()` and read counts
 *     back with `.getCount(name, attrs?)`.
 *
 * The default singleton calls into both sinks at once — production gets OTel
 * emission, but a test that wraps an emission site in
 * `withOAuthMetricsSink(...)` observes the same call synchronously without
 * needing to spin up an OTel meter provider.
 */

import { env } from "node:process";
import type { Attributes, Counter, Histogram, Meter } from "@opentelemetry/api";

/**
 * Attributes accepted by the refresh outcome counter. Kept low-cardinality
 * per v8 "Telemetry" guidance — bounded `kind`, bounded `reason`, provider
 * is a registry constant, `retry_attempt` is 1 or 2.
 */
export interface RefreshOutcomeAttrs {
  kind: "success" | "token_dead" | "transient";
  /** Only set when `kind === "transient"`. */
  reason?: string;
  provider: string;
  retry_attempt: 1 | 2;
}

export interface RetrySavedAttrs {
  provider: string;
  /** Reason of the FIRST (failed) attempt — what we recovered from. */
  first_reason: string;
}

export interface PlatformBugAttrs {
  provider: string;
  /** Internal classification name from the classifier (e.g. `4xx_non_invalid_grant`). */
  reason: string;
}

export interface SilentFallbackAttrs {
  provider: string;
  reason: string;
}

export interface ElicitationCreatedAttrs {
  family: string;
  workspaceId: string;
  sessionId: string;
}

export interface ElicitationDedupedAttrs {
  family: string;
  workspaceId: string;
  sessionId: string;
}

export interface ElicitationAnswerAttrs {
  family: string;
  workspaceId: string;
  sessionId: string;
}

export interface ElicitationLifecycleAttrs {
  family: string;
  workspaceId: string;
  sessionId: string;
}

export type AnswerLatencyStatus = "answered_retry" | "answered_cancel" | "expired" | "aborted";

export interface AnswerLatencyAttrs {
  family: string;
  workspaceId: string;
  sessionId: string;
  status: AnswerLatencyStatus;
}

/**
 * Plugin point for backends. All sinks must accept every call — no-op is
 * fine when a sink doesn't care.
 */
export interface OAuthMetricsSink {
  recordRefreshOutcome(attrs: RefreshOutcomeAttrs): void;
  recordRetrySaved(attrs: RetrySavedAttrs): void;
  recordPlatformBug(attrs: PlatformBugAttrs): void;
  recordSilentFallback(attrs: SilentFallbackAttrs): void;
  recordElicitationCreated(attrs: ElicitationCreatedAttrs): void;
  recordElicitationDeduped(attrs: ElicitationDedupedAttrs): void;
  recordElicitationAnsweredRetry(attrs: ElicitationAnswerAttrs): void;
  recordElicitationAnsweredCancel(attrs: ElicitationAnswerAttrs): void;
  recordElicitationExpired(attrs: ElicitationLifecycleAttrs): void;
  recordElicitationAborted(attrs: ElicitationLifecycleAttrs): void;
  recordElicitationRetrySucceeded(attrs: ElicitationLifecycleAttrs): void;
  recordElicitationRetryFailed(attrs: ElicitationLifecycleAttrs): void;
  recordAnswerLatencyMs(ms: number, attrs: AnswerLatencyAttrs): void;
}

/**
 * Test-friendly sink that aggregates counts in a Map keyed by
 * `name|sortedKey=value|...`. Production code never reads this — it's only
 * inspected by tests via `getCount` / `getHistogramSamples`.
 */
export class InMemoryOAuthMetricsSink implements OAuthMetricsSink {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();

  private bump(name: string, attrs: Attributes): void {
    const key = this.keyFor(name, attrs);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  private observe(name: string, value: number, attrs: Attributes): void {
    const key = this.keyFor(name, attrs);
    const samples = this.histograms.get(key) ?? [];
    samples.push(value);
    this.histograms.set(key, samples);
  }

  private keyFor(name: string, attrs: Attributes): string {
    const parts = Object.keys(attrs)
      .sort()
      .map((k) => `${k}=${String(attrs[k])}`);
    return parts.length === 0 ? name : `${name}|${parts.join("|")}`;
  }

  /**
   * Sum every counter sample whose attributes are a superset of `filter`.
   * Pass `{}` for an unfiltered total across all observed label sets.
   */
  getCount(name: string, filter: Attributes = {}): number {
    let total = 0;
    for (const [key, value] of this.counters) {
      if (this.matches(key, name, filter)) total += value;
    }
    return total;
  }

  /** Same predicate as `getCount`, but returns recorded histogram samples. */
  getHistogramSamples(name: string, filter: Attributes = {}): number[] {
    const out: number[] = [];
    for (const [key, samples] of this.histograms) {
      if (this.matches(key, name, filter)) out.push(...samples);
    }
    return out;
  }

  reset(): void {
    this.counters.clear();
    this.histograms.clear();
  }

  private matches(key: string, name: string, filter: Attributes): boolean {
    if (!key.startsWith(`${name}|`) && key !== name) return false;
    if (Object.keys(filter).length === 0) return true;
    const segments = key.split("|").slice(1);
    const have = new Map<string, string>();
    for (const segment of segments) {
      const eq = segment.indexOf("=");
      if (eq === -1) continue;
      have.set(segment.slice(0, eq), segment.slice(eq + 1));
    }
    for (const [k, v] of Object.entries(filter)) {
      if (have.get(k) !== String(v)) return false;
    }
    return true;
  }

  recordRefreshOutcome(attrs: RefreshOutcomeAttrs): void {
    this.bump("link.oauth.refresh.outcome", toAttrs(attrs));
  }
  recordRetrySaved(attrs: RetrySavedAttrs): void {
    this.bump("link.oauth.refresh.retry_saved", toAttrs(attrs));
  }
  recordPlatformBug(attrs: PlatformBugAttrs): void {
    this.bump("link.oauth.refresh.platform_bug", toAttrs(attrs));
  }
  recordSilentFallback(attrs: SilentFallbackAttrs): void {
    this.bump("link.oauth.refresh.silent_fallback", toAttrs(attrs));
  }
  recordElicitationCreated(attrs: ElicitationCreatedAttrs): void {
    this.bump("link.oauth.elicitation.created", toAttrs(attrs));
  }
  recordElicitationDeduped(attrs: ElicitationDedupedAttrs): void {
    this.bump("link.oauth.elicitation.deduped", toAttrs(attrs));
  }
  recordElicitationAnsweredRetry(attrs: ElicitationAnswerAttrs): void {
    this.bump("link.oauth.elicitation.answered_retry", toAttrs(attrs));
  }
  recordElicitationAnsweredCancel(attrs: ElicitationAnswerAttrs): void {
    this.bump("link.oauth.elicitation.answered_cancel", toAttrs(attrs));
  }
  recordElicitationExpired(attrs: ElicitationLifecycleAttrs): void {
    this.bump("link.oauth.elicitation.expired", toAttrs(attrs));
  }
  recordElicitationAborted(attrs: ElicitationLifecycleAttrs): void {
    this.bump("link.oauth.elicitation.aborted", toAttrs(attrs));
  }
  recordElicitationRetrySucceeded(attrs: ElicitationLifecycleAttrs): void {
    this.bump("link.oauth.elicitation.retry_succeeded", toAttrs(attrs));
  }
  recordElicitationRetryFailed(attrs: ElicitationLifecycleAttrs): void {
    this.bump("link.oauth.elicitation.retry_failed", toAttrs(attrs));
  }
  recordAnswerLatencyMs(ms: number, attrs: AnswerLatencyAttrs): void {
    this.observe("link.oauth.elicitation.answer_latency_ms", ms, toAttrs(attrs));
  }
}

type AttrPrimitive = string | number | boolean;

/**
 * Translate a typed attrs object into a generic OTel `Attributes` record.
 * Skips undefined values (OTel doesn't accept them) and rejects nested
 * objects via the value type — the typed input shapes above only carry
 * primitives so this is just a runtime safety net.
 */
function toAttrs(attrs: object): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      const primitive: AttrPrimitive = v;
      out[k] = primitive;
    }
  }
  return out;
}

/** No-op sink used when OTel is disabled and no test sink is installed. */
class NoopOAuthMetricsSink implements OAuthMetricsSink {
  recordRefreshOutcome(): void {}
  recordRetrySaved(): void {}
  recordPlatformBug(): void {}
  recordSilentFallback(): void {}
  recordElicitationCreated(): void {}
  recordElicitationDeduped(): void {}
  recordElicitationAnsweredRetry(): void {}
  recordElicitationAnsweredCancel(): void {}
  recordElicitationExpired(): void {}
  recordElicitationAborted(): void {}
  recordElicitationRetrySucceeded(): void {}
  recordElicitationRetryFailed(): void {}
  recordAnswerLatencyMs(): void {}
}

/**
 * OpenTelemetry-backed sink. Resolves the meter on first call (lazy) so
 * importing this module never forces OTel runtime evaluation. When OTel
 * isn't bootstrapped, `metrics.getMeter` returns a noop meter and every
 * `.add(...)` is a no-op — same result as `NoopOAuthMetricsSink` but with
 * the indirection cost. We skip the OTel call entirely when `OTEL_DENO !==
 * "true"` to match the precedent in `apps/atlasd/src/utils/metrics.ts`.
 */
class OtelOAuthMetricsSink implements OAuthMetricsSink {
  private meter: Meter | null = null;
  private refreshOutcome: Counter | null = null;
  private retrySaved: Counter | null = null;
  private platformBug: Counter | null = null;
  private silentFallback: Counter | null = null;
  private elicitationCreated: Counter | null = null;
  private elicitationDeduped: Counter | null = null;
  private elicitationAnsweredRetry: Counter | null = null;
  private elicitationAnsweredCancel: Counter | null = null;
  private elicitationExpired: Counter | null = null;
  private elicitationAborted: Counter | null = null;
  private elicitationRetrySucceeded: Counter | null = null;
  private elicitationRetryFailed: Counter | null = null;
  private answerLatency: Histogram | null = null;
  private initPromise: Promise<void> | null = null;
  private failed = false;

  private async ensure(): Promise<void> {
    if (this.failed || this.meter !== null) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    if (env.OTEL_DENO !== "true") {
      this.failed = true;
      return;
    }
    this.initPromise = (async () => {
      try {
        const otel = await import("@opentelemetry/api");
        const meter = otel.metrics.getMeter("link.oauth", "1.0.0");
        this.refreshOutcome = meter.createCounter("link.oauth.refresh.outcome", {
          description: "OAuth refresh classifier outcomes",
          unit: "{outcomes}",
        });
        this.retrySaved = meter.createCounter("link.oauth.refresh.retry_saved", {
          description: "Refreshes recovered by the in-classifier retry",
          unit: "{retries}",
        });
        this.platformBug = meter.createCounter("link.oauth.refresh.platform_bug", {
          description: "Refresh responses classified as platform_bug",
          unit: "{events}",
        });
        this.silentFallback = meter.createCounter("link.oauth.refresh.silent_fallback", {
          description: "Refresh failures masked by ≥60s remaining access_token life",
          unit: "{events}",
        });
        this.elicitationCreated = meter.createCounter("link.oauth.elicitation.created", {
          description: "auth-refresh elicitations created by the wrapper",
          unit: "{elicitations}",
        });
        this.elicitationDeduped = meter.createCounter("link.oauth.elicitation.deduped", {
          description: "Concurrent transients that joined an existing pending elicitation",
          unit: "{events}",
        });
        this.elicitationAnsweredRetry = meter.createCounter(
          "link.oauth.elicitation.answered_retry",
          { description: "User clicked Retry on an auth-refresh elicitation", unit: "{answers}" },
        );
        this.elicitationAnsweredCancel = meter.createCounter(
          "link.oauth.elicitation.answered_cancel",
          { description: "User clicked Cancel on an auth-refresh elicitation", unit: "{answers}" },
        );
        this.elicitationExpired = meter.createCounter("link.oauth.elicitation.expired", {
          description: "auth-refresh elicitations that hit their TTL with no answer",
          unit: "{events}",
        });
        this.elicitationAborted = meter.createCounter("link.oauth.elicitation.aborted", {
          description: "auth-refresh elicitations interrupted by session abort",
          unit: "{events}",
        });
        this.elicitationRetrySucceeded = meter.createCounter(
          "link.oauth.elicitation.retry_succeeded",
          { description: "Retry click followed by a successful refresh", unit: "{events}" },
        );
        this.elicitationRetryFailed = meter.createCounter("link.oauth.elicitation.retry_failed", {
          description: "Retry click followed by another transient",
          unit: "{events}",
        });
        this.answerLatency = meter.createHistogram("link.oauth.elicitation.answer_latency_ms", {
          description: "Time from auth-refresh elicitation create to terminal answer",
          unit: "ms",
        });
        this.meter = meter;
      } catch {
        this.failed = true;
      }
    })();
    await this.initPromise;
  }

  private fire(counter: Counter | null, attrs: Attributes): void {
    if (counter === null) {
      void this.ensure();
      return;
    }
    counter.add(1, attrs);
  }

  private observe(histogram: Histogram | null, value: number, attrs: Attributes): void {
    if (histogram === null) {
      void this.ensure();
      return;
    }
    histogram.record(value, attrs);
  }

  recordRefreshOutcome(attrs: RefreshOutcomeAttrs): void {
    this.fire(this.refreshOutcome, toAttrs(attrs));
  }
  recordRetrySaved(attrs: RetrySavedAttrs): void {
    this.fire(this.retrySaved, toAttrs(attrs));
  }
  recordPlatformBug(attrs: PlatformBugAttrs): void {
    this.fire(this.platformBug, toAttrs(attrs));
  }
  recordSilentFallback(attrs: SilentFallbackAttrs): void {
    this.fire(this.silentFallback, toAttrs(attrs));
  }
  recordElicitationCreated(attrs: ElicitationCreatedAttrs): void {
    this.fire(this.elicitationCreated, toAttrs(attrs));
  }
  recordElicitationDeduped(attrs: ElicitationDedupedAttrs): void {
    this.fire(this.elicitationDeduped, toAttrs(attrs));
  }
  recordElicitationAnsweredRetry(attrs: ElicitationAnswerAttrs): void {
    this.fire(this.elicitationAnsweredRetry, toAttrs(attrs));
  }
  recordElicitationAnsweredCancel(attrs: ElicitationAnswerAttrs): void {
    this.fire(this.elicitationAnsweredCancel, toAttrs(attrs));
  }
  recordElicitationExpired(attrs: ElicitationLifecycleAttrs): void {
    this.fire(this.elicitationExpired, toAttrs(attrs));
  }
  recordElicitationAborted(attrs: ElicitationLifecycleAttrs): void {
    this.fire(this.elicitationAborted, toAttrs(attrs));
  }
  recordElicitationRetrySucceeded(attrs: ElicitationLifecycleAttrs): void {
    this.fire(this.elicitationRetrySucceeded, toAttrs(attrs));
  }
  recordElicitationRetryFailed(attrs: ElicitationLifecycleAttrs): void {
    this.fire(this.elicitationRetryFailed, toAttrs(attrs));
  }
  recordAnswerLatencyMs(ms: number, attrs: AnswerLatencyAttrs): void {
    this.observe(this.answerLatency, ms, toAttrs(attrs));
  }
}

const defaultSink: OAuthMetricsSink =
  env.OTEL_DENO === "true" ? new OtelOAuthMetricsSink() : new NoopOAuthMetricsSink();

let currentSink: OAuthMetricsSink = defaultSink;

/**
 * Return the active sink. Emission sites call `getOAuthMetrics().recordX(...)`
 * — keeps the call site terse and lets tests swap implementations.
 */
export function getOAuthMetrics(): OAuthMetricsSink {
  return currentSink;
}

/**
 * Replace the active sink. Returns a restore function — tests must call it
 * in `afterEach` so they don't leak state between cases.
 */
export function setOAuthMetricsSinkForTesting(sink: OAuthMetricsSink): () => void {
  const previous = currentSink;
  currentSink = sink;
  return () => {
    currentSink = previous;
  };
}
