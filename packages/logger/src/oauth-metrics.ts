/**
 * OAuth refresh telemetry instruments.
 *
 * Counters covering classifier outcomes and the 60s-threshold silent fallback.
 * Emitted from:
 *
 *   - `apps/link/src/oauth/delegated.ts` — classifier outcomes + platform_bug.
 *   - `apps/link/src/routes/credentials.ts` — silent_fallback.
 *
 * Two backends share one `OAuthMetricsSink` interface:
 *   - `OtelOAuthMetricsSink` — emits OpenTelemetry counters via a meter named
 *     `"link.oauth"`. Lazy-bootstrapped so module load doesn't depend on an
 *     OTel runtime being available.
 *   - `InMemoryOAuthMetricsSink` — synchronous counters in a Map for tests.
 */

import { env } from "node:process";
import type { Attributes, Counter, Meter } from "@opentelemetry/api";

/**
 * Attributes accepted by the refresh outcome counter. Kept low-cardinality —
 * bounded `kind`, bounded `reason`, provider is a registry constant.
 */
export interface RefreshOutcomeAttrs {
  kind: "success" | "token_dead" | "transient";
  /** Only set when `kind === "transient"`. */
  reason?: string;
  provider: string;
}
// (`retry_attempt` removed alongside the wrapper / in-classifier retry — the
// classifier now performs exactly one refresh attempt.)

export interface PlatformBugAttrs {
  provider: string;
  /** Internal classification name from the classifier (e.g. `4xx_non_invalid_grant`). */
  reason: string;
}

export interface SilentFallbackAttrs {
  provider: string;
  reason: string;
}

/**
 * Plugin point for backends. All sinks must accept every call — no-op is
 * fine when a sink doesn't care.
 */
export interface OAuthMetricsSink {
  recordRefreshOutcome(attrs: RefreshOutcomeAttrs): void;
  recordPlatformBug(attrs: PlatformBugAttrs): void;
  recordSilentFallback(attrs: SilentFallbackAttrs): void;
}

/**
 * Test-friendly sink that aggregates counts in a Map keyed by
 * `name|sortedKey=value|...`. Production code never reads this — it's only
 * inspected by tests via `getCount`.
 */
export class InMemoryOAuthMetricsSink implements OAuthMetricsSink {
  private readonly counters = new Map<string, number>();

  private bump(name: string, attrs: Attributes): void {
    const key = this.keyFor(name, attrs);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
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

  reset(): void {
    this.counters.clear();
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
  recordPlatformBug(attrs: PlatformBugAttrs): void {
    this.bump("link.oauth.refresh.platform_bug", toAttrs(attrs));
  }
  recordSilentFallback(attrs: SilentFallbackAttrs): void {
    this.bump("link.oauth.refresh.silent_fallback", toAttrs(attrs));
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
  recordPlatformBug(): void {}
  recordSilentFallback(): void {}
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
  private platformBug: Counter | null = null;
  private silentFallback: Counter | null = null;
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
        this.platformBug = meter.createCounter("link.oauth.refresh.platform_bug", {
          description: "Refresh responses classified as platform_bug",
          unit: "{events}",
        });
        this.silentFallback = meter.createCounter("link.oauth.refresh.silent_fallback", {
          description: "Refresh failures masked by ≥60s remaining access_token life",
          unit: "{events}",
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

  recordRefreshOutcome(attrs: RefreshOutcomeAttrs): void {
    this.fire(this.refreshOutcome, toAttrs(attrs));
  }
  recordPlatformBug(attrs: PlatformBugAttrs): void {
    this.fire(this.platformBug, toAttrs(attrs));
  }
  recordSilentFallback(attrs: SilentFallbackAttrs): void {
    this.fire(this.silentFallback, toAttrs(attrs));
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
