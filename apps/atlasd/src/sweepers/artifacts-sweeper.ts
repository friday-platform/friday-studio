/**
 * Phase 6.B — artifact grace-window sweeper.
 *
 * Replaces the synchronous {@link cleanupEphemeralForSession} delete-at-
 * complete pass. The runtime now stamps `expiresAt = completedAt + grace`
 * on each ephemeral artifact at session-complete; this sweeper walks
 * past-deadline ephemeral artifacts on a timer and either:
 *
 *  - Deletes them (no inbound reference signal), or
 *  - Promotes them to durable (some signal found — memory entry text
 *    contains the artifact ID, or aiSummary key-detail URL points at
 *    it). The supervisor's prior choice to remember/surface acts as
 *    the implicit "keep" signal; the author writes nothing extra.
 *
 * Decoupling from session-complete buys us:
 *
 *  - Idempotence on process death: a daemon restart between
 *    session-complete and sweep doesn't lose the cleanup window.
 *    `expiresAt` is the source of truth.
 *  - Free promotion: `memory_save` calls that happen *after* session-
 *    complete (chat path callbacks, follow-up turns) still keep the
 *    artifact alive as long as they land before the grace window
 *    closes.
 *  - One pass per workspace: the sweep walks the global artifact
 *    keyspace once per tick instead of running per session-complete.
 *
 * Default cadence: hourly. The sweep is cheap (KV scan + per-expired
 * substring match against memory entries); the timer interval is the
 * dominant cost. Override via `FRIDAY_SWEEPER_INTERVAL_MS` env var or
 * call-site `intervalMs` for tests.
 */

import {
  type AiSummaryProvider,
  ArtifactStorage,
  hasPromotionSignal,
  type PromotionScanContext,
} from "@atlas/core/artifacts/server";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";

const logger = createLogger({ component: "artifacts-sweeper" });

/** Default sweep cadence: 1 hour. */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export interface ArtifactsSweeperOptions {
  /**
   * Tick interval in milliseconds. Defaults to 1 hour, overridable
   * via `FRIDAY_SWEEPER_INTERVAL_MS` env var. Tests pass small values
   * with a fake clock.
   */
  intervalMs?: number;
  /**
   * Resolves the per-workspace promotion-scan context (memory adapter,
   * configured store names, optional aiSummary provider). Sweeper calls
   * this for every expired artifact's workspace; daemon wires it to
   * the runtime registry.
   *
   * Returning `undefined` means "no scan context for this workspace —
   * treat as no signal" (artifact gets deleted). Useful for artifacts
   * whose workspace has been torn down.
   */
  getScanContext: (workspaceId: string) => Promise<PromotionScanContext | undefined>;
  /**
   * Optional fallback aiSummary provider used when the per-workspace
   * `getScanContext` doesn't supply one. Wired by the daemon to the
   * `completedSessionMetadata` snapshot maintained on each runtime;
   * left undefined in tests that exercise memory-only promotion.
   */
  aiSummaryFallback?: AiSummaryProvider;
  /**
   * Now-source. Defaults to `() => new Date()`. Tests inject a fake
   * clock to assert ordering without sleeping.
   */
  now?: () => Date;
  /**
   * Per-tick artifact cap. Hard limit on the number of expired
   * artifacts processed per pass — keeps a backlog from monopolizing
   * a tick. Defaults to 1000; the next tick picks up the rest.
   */
  perTickLimit?: number;
}

export interface ArtifactsSweeperHandle {
  /** Cancel the timer. Idempotent. */
  stop(): void;
  /**
   * Run a single sweep tick now. Tests call this directly. Resolves
   * after the pass finishes; per-artifact failures are logged and
   * isolated.
   */
  tick(): Promise<{ promoted: string[]; deleted: string[]; errors: number }>;
}

/**
 * Start the artifacts sweeper. Caller owns the returned handle and
 * must call `stop()` on shutdown to clear the interval.
 *
 * Returns synchronously — the first tick fires after `intervalMs`,
 * not at start-time. Daemon should `await handle.tick()` once during
 * boot if a startup-time backfill is desired (not the default — the
 * grace window is hours, so a delayed first tick is fine).
 */
export function startArtifactsSweeper(opts: ArtifactsSweeperOptions): ArtifactsSweeperHandle {
  const interval = opts.intervalMs ?? readIntervalFromEnv() ?? DEFAULT_INTERVAL_MS;
  const now = opts.now ?? (() => new Date());
  const perTickLimit = opts.perTickLimit ?? 1000;

  const tick = async (): Promise<{ promoted: string[]; deleted: string[]; errors: number }> => {
    const promoted: string[] = [];
    const deleted: string[] = [];
    let errors = 0;

    let listing: Awaited<ReturnType<typeof ArtifactStorage.listExpired>>;
    try {
      listing = await ArtifactStorage.listExpired({ now: now(), limit: perTickLimit });
    } catch (err) {
      // listExpired() throws when the storage facade isn't initialized
      // (daemon mid-boot). Log and skip this tick — the next one will
      // pick up after init completes.
      logger.warn("artifacts sweeper: listExpired threw", { error: stringifyError(err) });
      return { promoted, deleted, errors: 1 };
    }
    if (!listing.ok) {
      logger.warn("artifacts sweeper: listExpired failed", { error: listing.error });
      return { promoted, deleted, errors: 1 };
    }

    for (const summary of listing.data) {
      // Skip oddities — listExpired's filter already constrains shape,
      // but be paranoid against schema drift.
      if (summary.lifecycle?.kind !== "ephemeral") continue;
      const workspaceId = summary.workspaceId;
      if (!workspaceId) {
        // Without a workspace anchor we can't scan for references; the
        // runtime wouldn't have produced this shape, but if it did,
        // treat as orphan and delete.
        const del = await ArtifactStorage.deleteArtifact({ id: summary.id });
        if (del.ok) {
          deleted.push(summary.id);
          logger.info("artifacts sweeper: deleted orphan ephemeral (no workspaceId)", {
            artifactId: summary.id,
          });
        } else {
          errors += 1;
          logger.warn("artifacts sweeper: delete failed for orphan", {
            artifactId: summary.id,
            error: del.error,
          });
        }
        continue;
      }

      try {
        const ctx = await opts.getScanContext(workspaceId);
        // Compose the scan context. If the workspace runtime is gone
        // (workspaceId points at nothing live), `ctx` is undefined —
        // synthesize an empty scan that always returns "no signal" so
        // the artifact gets deleted instead of leaking forever.
        const scanCtx: PromotionScanContext = ctx ?? {
          memoryStoreNames: [],
          ...(opts.aiSummaryFallback ? { aiSummary: opts.aiSummaryFallback } : {}),
        };
        // Per-workspace ctx may not supply aiSummary; fall back to the
        // sweeper-level provider when present.
        if (!scanCtx.aiSummary && opts.aiSummaryFallback) {
          scanCtx.aiSummary = opts.aiSummaryFallback;
        }

        const promote = await hasPromotionSignal(summary.id, workspaceId, scanCtx);
        if (promote) {
          const upd = await ArtifactStorage.updateLifecycle({
            id: summary.id,
            lifecycle: { kind: "durable" },
          });
          if (upd.ok) {
            promoted.push(summary.id);
            logger.info("artifacts sweeper: promoted ephemeral → durable (reference found)", {
              artifactId: summary.id,
              workspaceId,
            });
          } else {
            errors += 1;
            logger.warn("artifacts sweeper: promote (updateLifecycle) failed", {
              artifactId: summary.id,
              error: upd.error,
            });
          }
        } else {
          const del = await ArtifactStorage.deleteArtifact({ id: summary.id });
          if (del.ok) {
            deleted.push(summary.id);
            logger.info("artifacts sweeper: deleted expired ephemeral (no signal)", {
              artifactId: summary.id,
              workspaceId,
            });
          } else {
            errors += 1;
            logger.warn("artifacts sweeper: delete failed", {
              artifactId: summary.id,
              error: del.error,
            });
          }
        }
      } catch (err) {
        errors += 1;
        logger.warn("artifacts sweeper: per-artifact processing threw", {
          artifactId: summary.id,
          workspaceId,
          error: stringifyError(err),
        });
      }
    }

    if (promoted.length || deleted.length || errors) {
      logger.info("artifacts sweeper: tick complete", {
        promotedCount: promoted.length,
        deletedCount: deleted.length,
        errors,
      });
    }
    return { promoted, deleted, errors };
  };

  const handle: ArtifactsSweeperHandle = {
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick,
  };

  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    tick().catch((err) => {
      logger.warn("artifacts sweeper: tick threw at top level", { error: stringifyError(err) });
    });
  }, interval);

  return handle;
}

function readIntervalFromEnv(): number | undefined {
  const raw = globalThis.process?.env?.FRIDAY_SWEEPER_INTERVAL_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}
