/**
 * G4 — elicitation pending→expired sweeper.
 *
 * Closes review finding C1: `ElicitationStatus` includes `"expired"`
 * but no code path ever wrote it. The Activity page (G1) flips
 * past-deadline pending entries to expired in the client as UX
 * smoothing; this sweeper does the durable transition on the daemon
 * so KV/stream consumers (Activity SSE feed, runtime suspend/resume,
 * audit consumers) see the terminal state without a UI in the loop.
 *
 * Two layers of protection together:
 *
 *  - Read-time derivation in `ElicitationStorage.get/list` — past-
 *    deadline pending entries surface as `expired` immediately on
 *    every read, so callers never observe stale `pending` between
 *    sweeper ticks.
 *  - This sweeper — durable KV write so a watch subscriber sees a
 *    terminal-state event without polling, and so the next read after
 *    a daemon restart still sees `expired` even though the read-time
 *    derivation runs against the freshly-loaded snapshot.
 *
 * The KV write is CAS-guarded against the entry's revision: if a
 * `/answer` or `/decline` lands between the sweeper's read and write,
 * the CAS fails and the answer wins. Idempotent across ticks: an
 * already-`expired` entry is filtered out before the write attempt
 * (no work, no log noise).
 *
 * Default tick interval: 60s. Override via the
 * `FRIDAY_ELICITATION_SWEEP_INTERVAL_MS` env var (tests pass
 * `intervalMs` directly with a fake clock).
 */

import { ElicitationStorage } from "@atlas/core/elicitations";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";

const logger = createLogger({ component: "elicitations-sweeper" });

/** Default sweep cadence: 60 seconds. */
const DEFAULT_INTERVAL_MS = 60 * 1000;

export interface ElicitationsSweeperOptions {
  /**
   * Tick interval in milliseconds. Defaults to 60s, overridable via
   * the `FRIDAY_ELICITATION_SWEEP_INTERVAL_MS` env var. Tests pass
   * a small value with a fake clock.
   */
  intervalMs?: number;
  /**
   * Now-source. Defaults to `() => new Date()`. Tests inject a fake
   * clock to assert ordering without sleeping.
   */
  now?: () => Date;
  /**
   * Per-tick scan cap. Hard limit on the number of expired entries
   * processed per pass — keeps a backlog from monopolizing a tick.
   * Defaults to 500; the next tick picks up the rest.
   */
  perTickLimit?: number;
}

export interface ElicitationsSweeperHandle {
  /** Cancel the timer. Idempotent. */
  stop(): void;
  /**
   * Run a single sweep tick now. Tests call this directly. Resolves
   * after the pass finishes; per-entry CAS skips and write failures
   * are surfaced in the result, not thrown.
   */
  tick(): Promise<{ scanned: number; expired: string[]; skipped: string[]; errors: number }>;
}

/**
 * Start the elicitations sweeper. Caller owns the returned handle and
 * must call `stop()` on shutdown to clear the interval.
 *
 * Returns synchronously — the first tick fires after `intervalMs`,
 * not at start-time. A startup-time backfill is unnecessary because
 * the read-time derivation in `ElicitationStorage.get/list` already
 * surfaces past-deadline entries as `expired` on every read; the
 * sweeper's job is durable persistence + watch-event emission.
 */
export function startElicitationsSweeper(
  opts: ElicitationsSweeperOptions = {},
): ElicitationsSweeperHandle {
  const interval = opts.intervalMs ?? readIntervalFromEnv() ?? DEFAULT_INTERVAL_MS;
  const now = opts.now ?? (() => new Date());
  const perTickLimit = opts.perTickLimit ?? 500;

  const tick = async (): Promise<{
    scanned: number;
    expired: string[];
    skipped: string[];
    errors: number;
  }> => {
    let result: Awaited<ReturnType<typeof ElicitationStorage.expirePending>>;
    try {
      result = await ElicitationStorage.expirePending({ now: now(), limit: perTickLimit });
    } catch (err) {
      // expirePending throws when the storage facade isn't initialized
      // (daemon mid-boot). Log and skip this tick — the next one will
      // pick up after init completes.
      logger.warn("elicitations sweeper: expirePending threw", { error: stringifyError(err) });
      return { scanned: 0, expired: [], skipped: [], errors: 1 };
    }
    if (!result.ok) {
      logger.warn("elicitations sweeper: expirePending failed", { error: result.error });
      return { scanned: 0, expired: [], skipped: [], errors: 1 };
    }
    const { scanned, expired, skipped, errors } = result.data;
    if (expired.length || skipped.length || errors) {
      logger.info("elicitations sweeper: tick complete", {
        scanned,
        expiredCount: expired.length,
        skippedCount: skipped.length,
        errors,
      });
    }
    return { scanned, expired, skipped, errors };
  };

  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    tick().catch((err) => {
      logger.warn("elicitations sweeper: tick threw at top level", { error: stringifyError(err) });
    });
  }, interval);

  return {
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick,
  };
}

function readIntervalFromEnv(): number | undefined {
  const raw = globalThis.process?.env?.FRIDAY_ELICITATION_SWEEP_INTERVAL_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}
