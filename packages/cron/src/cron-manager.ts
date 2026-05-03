/**
 * Daemon-Level Cron Manager
 *
 * Centralized timer management that survives workspace runtime shutdowns.
 * Allows workspaces to sleep while maintaining scheduled automation.
 *
 * Key Features:
 * - Persistent timer storage using KV storage
 * - Independent of workspace runtime lifecycle
 * - Wake-up mechanism for sleeping workspaces
 * - Centralized timer scheduling and execution
 */

import type { Logger } from "@atlas/logger";
import type { KVStorage } from "@atlas/storage/kv";
import type { WorkspaceSignalTriggerCallback } from "@atlas/workspace/types";
import { CronExpressionParser } from "cron-parser";

/**
 * Coalescing policy for cron firings the daemon was down for.
 *
 * - `skip`     — drop missed firings entirely. Pre-G1.5 behavior.
 * - `coalesce` — fire once now representing every missed slot inside
 *                `missedWindowMs`. Payload carries `missedCount` +
 *                `firstMissedAt`.
 * - `catchup`  — fire each missed slot in chronological order, one
 *                signal per slot. Bounded by `missedWindowMs`.
 * - `manual`   — emit a pending notification but DO NOT fire. The
 *                operator decides via the /schedules UI whether to
 *                trigger. Right for expensive / visible side-effect
 *                jobs.
 *
 * Window cap matters: a daemon down for a week with `catchup` on an
 * hourly cron only fires the slots inside the window, not all 168.
 */
export type OnMissedPolicy = "skip" | "coalesce" | "catchup" | "manual";

export interface TimerInfo {
  workspaceId: string;
  signalId: string;
  schedule: string;
  timezone: string;
  nextExecution: Date; // Always present at runtime
  lastExecution?: Date;
  paused?: boolean;
  /** Missed-fire policy. Defaults to "skip" if undefined (legacy timers). */
  onMissed?: OnMissedPolicy;
  /** How far back to consider missed firings, in ms. Defaults to 24h if undefined. */
  missedWindowMs?: number;
}

// Type for registering timers (without computed fields)
export type TimerConfig = Omit<TimerInfo, "nextExecution" | "lastExecution">;

const DEFAULT_MISSED_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Cron timer signal payload data.
 *
 * `scheduled` is when the tick was *supposed* to fire (according to the
 * schedule + the previously-persisted `nextExecution`). `actualFiredAt`
 * is when it actually fired — usually identical, but diverges after a
 * daemon downtime or broker outage.
 *
 * **Coalescing semantics (G1.5):** Friday collapses missed ticks into
 * a single execution. If the daemon was down 1h and a job was
 * scheduled to fire every 15 min, the job fires ONCE on restart with
 * `scheduled` set to the most-recent missed tick. `missedSince`
 * carries the previous successful tick (`lastExecution` before the
 * gap) so jobs that care about catching up — counting metrics,
 * window-aware batches — can compute the gap themselves and self-batch.
 *
 * Idempotent jobs (sweeps, autopilots) ignore `missedSince` and the
 * default behavior is correct.
 */
export interface CronTimerSignalPayload {
  scheduled: string;
  timezone: string;
  nextRun: string;
  /** ISO 8601 of when this tick actually fired. */
  actualFiredAt: string;
  /**
   * ISO 8601 of the last successful tick before this one, or undefined
   * on first execution. Jobs can compute `(scheduled − missedSince)` to
   * detect gaps caused by daemon downtime / broker outage / manual
   * pause and decide whether to backfill.
   */
  missedSince?: string;
  /**
   * Which onMissed policy produced this firing. "ontime" when the fire
   * was at its scheduled slot; "coalesce" / "catchup" when it was a
   * make-up fire for a missed slot. Absent on legacy callers.
   */
  policy?: "ontime" | "coalesce" | "catchup";
  /**
   * For "coalesce" — total slots collapsed into this one fire (>= 1).
   * For "catchup" — always 1 (each slot fires separately).
   * Undefined for "ontime".
   */
  missedCount?: number;
  /**
   * For "coalesce" — ISO 8601 of the earliest missed slot represented.
   * For "catchup" — ISO 8601 of this specific missed slot (== `scheduled`).
   * Undefined for "ontime".
   */
  firstMissedAt?: string;
}

/**
 * Cron timer signal data structure passed to workspace wakeup callback.
 * Extends Record to satisfy WorkspaceSignalTriggerCallback constraint.
 */
export interface CronTimerSignalData extends Record<string, unknown> {
  id: string;
  timestamp: string;
  data: CronTimerSignalPayload;
}

/**
 * Daemon-level Cron Manager
 *
 * Manages all timer signals across all workspaces independently of
 * workspace runtime lifecycle. Allows workspaces to sleep while
 * maintaining scheduled automation.
 */
/**
 * Callback the daemon registers to receive a structured event when
 * the onMissed policy produced a make-up firing (`coalesce` or
 * `catchup`). Lives outside the wakeup callback so the daemon can
 * publish to a separate audit feed (`WORKSPACE_EVENTS`) without
 * conflating "fire the signal" with "log that we caught up."
 *
 * Best-effort: implementations should not throw. Failures inside the
 * notifier are caught + logged at WARN by the manager so a failing
 * notification publish never breaks the cron firing it describes.
 */
export interface MissedFiringNotification {
  workspaceId: string;
  signalId: string;
  policy: "coalesce" | "catchup" | "manual";
  missedCount: number;
  firstMissedAt: string;
  lastMissedAt: string;
  scheduledAt: string;
  /**
   * For `coalesce` / `catchup`: ISO 8601 of when the make-up fire
   * dispatched. For `manual`: ISO 8601 of when the missed slot was
   * detected (no fire happened). The UI uses this to display "fired"
   * vs "detected" timing depending on policy.
   */
  firedAt: string;
  schedule: string;
  timezone: string;
  /**
   * True for `manual` events that haven't been operator-fired yet.
   * Always undefined for `coalesce` / `catchup` (those fire
   * immediately and have no pending state).
   */
  pending?: boolean;
}
export type MissedFiringNotifier = (event: MissedFiringNotification) => void | Promise<void>;

export class CronManager {
  private storage: KVStorage;
  private logger: Logger;
  private wakeupCallback?: WorkspaceSignalTriggerCallback;
  private missedFiringNotifier?: MissedFiringNotifier;
  private timers = new Map<string, TimerInfo>();
  public isRunning = false;

  // Timer reliability via interval checking
  private checkInterval?: ReturnType<typeof setInterval>;
  private readonly CHECK_INTERVAL_MS = 30000; // Check every 30 seconds

  constructor(storage: KVStorage, logger: Logger) {
    this.storage = storage;
    this.logger = logger;
  }

  /**
   * Set the callback function to wake up workspaces when timers fire
   */
  setWakeupCallback(callback: WorkspaceSignalTriggerCallback): void {
    this.wakeupCallback = callback;
  }

  /**
   * Register the missed-firing notifier. Daemon wires this to publish
   * `events.<wsid>.schedule.missed` records to the WORKSPACE_EVENTS
   * stream so the `/schedules` UI (and any subscriber) can surface
   * make-up fires after the fact.
   */
  setMissedFiringNotifier(notifier: MissedFiringNotifier): void {
    this.missedFiringNotifier = notifier;
  }

  /**
   * Start the cron manager and restore persisted timers.
   *
   * `options.knownWorkspaceIds` enables orphan pruning: any persisted timer
   * whose `workspaceId` isn't in the set is dropped from memory and storage
   * before the tick loop starts. Defense-in-depth for workspaces removed
   * outside the manager's normal delete path (direct `rm -rf` of a
   * workspace directory, crashes mid-delete, FAST self-modification).
   */
  async start(options?: { knownWorkspaceIds?: ReadonlySet<string> }): Promise<void> {
    if (this.isRunning) {
      this.logger.warn("CronManager is already running");
      return;
    }

    this.logger.info("Starting CronManager");

    try {
      // Restore persisted timers
      await this.loadPersistedTimers();

      if (options?.knownWorkspaceIds) {
        await this.pruneOrphanedTimers(options.knownWorkspaceIds);
      }

      // Apply onMissed policy for any timer whose nextExecution slipped
      // into the past while the daemon was down. Default `skip` is a
      // no-op aside from advancing nextExecution past now; `coalesce`
      // and `catchup` produce make-up signal fires here.
      const now = new Date();
      for (const [timerKey, timer] of this.timers.entries()) {
        if (timer.paused) continue;
        if (timer.nextExecution.getTime() <= now.getTime()) {
          try {
            await this.applyMissedPolicy(timerKey, timer, now);
          } catch (err) {
            this.logger.error("Failed to apply onMissed policy", { timerKey, error: err });
          }
        }
      }

      // Start the interval-based timer checking for reliability
      this.startTimerCheckInterval();

      this.isRunning = true;
      this.logger.info("CronManager started successfully", {
        activeTimers: this.timers.size,
        checkIntervalMs: this.CHECK_INTERVAL_MS,
      });
    } catch (error) {
      this.logger.error("Failed to start CronManager", { error });
      throw error;
    }
  }

  /**
   * Drop timers whose workspaceId isn't in the set of known workspaces.
   * Removes both the in-memory entry and the storage row so the orphan
   * can't resurrect on the next restart.
   */
  private async pruneOrphanedTimers(known: ReadonlySet<string>): Promise<void> {
    const orphaned: Array<[string, TimerInfo]> = [];
    for (const [timerKey, timer] of this.timers.entries()) {
      if (!known.has(timer.workspaceId)) {
        orphaned.push([timerKey, timer]);
      }
    }
    for (const [timerKey, timer] of orphaned) {
      this.logger.warn("Pruning orphaned cron timer (workspace missing)", {
        workspaceId: timer.workspaceId,
        signalId: timer.signalId,
        timerKey,
      });
      this.timers.delete(timerKey);
      try {
        await this.storage.delete([`cron_timers`, timerKey]);
      } catch (error) {
        this.logger.error("Failed to delete orphaned timer from storage", { timerKey, error });
      }
    }
    if (orphaned.length > 0) {
      this.logger.info("Pruned orphaned cron timers", { count: orphaned.length });
    }
  }

  /**
   * Shutdown the cron manager and cleanup timers
   */
  async shutdown(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info("Shutting down CronManager");

    // Stop the timer check interval
    if (this.checkInterval !== undefined) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }

    // Persist current state
    for (const [timerKey, timer] of this.timers.entries()) {
      try {
        await this.persistTimer(timerKey, timer);
      } catch (error) {
        // Log error but continue with other timers
        this.logger.error("Failed to persist timer", { timerKey, error });
      }
    }

    this.isRunning = false;
    this.logger.info("CronManager shutdown complete");
  }

  /**
   * Start the interval that checks timers for execution
   * This replaces unreliable long setTimeout calls
   */
  private startTimerCheckInterval(): void {
    this.checkInterval = setInterval(() => {
      try {
        this.checkTimers();
      } catch (error) {
        this.logger.error("Error in timer check interval", { error });
      }
    }, this.CHECK_INTERVAL_MS);

    this.logger.debug("Timer check interval started", { intervalMs: this.CHECK_INTERVAL_MS });
  }

  /**
   * Check all timers and execute any that are due. Runs every CHECK_INTERVAL_MS.
   *
   * **Missed-tick behavior is "coalesce to one":** if the daemon was down past
   * multiple scheduled fires, the next check fires the timer exactly once and
   * advances `nextExecution` from the current clock. Idempotent jobs (sweeps,
   * autopilots, fetch-latest) absorb this fine. Counting jobs and time-window
   * jobs (e.g. "9am batch") lose their missed window and wait until the next
   * scheduled fire. This is documented as expected behavior — see G1.5 in
   * plans/2026-05-01-stateless-friday.md.
   */
  private checkTimers(): void {
    const now = Date.now();
    let dueCount = 0;

    for (const [timerKey, timer] of this.timers.entries()) {
      if (timer.paused) continue;
      const executionTime = timer.nextExecution.getTime();

      // Execute timer if it's due
      if (executionTime <= now) {
        dueCount++;
        // Execute timer asynchronously without blocking the check loop
        this.executeTimer(timerKey, timer).catch((error) => {
          this.logger.error("Failed to execute timer from check interval", { error, timerKey });
        });
      }
    }

    if (dueCount > 0) {
      this.logger.debug("Timer check found due timers", { count: dueCount });
    }
  }

  /**
   * Register a timer for a workspace signal.
   *
   * Critical: this runs at workspace-init time for every cron signal
   * declared in workspace.yml — including ones the daemon already had
   * persisted from a previous run. **Persisted runtime state
   * (`nextExecution`, `lastExecution`, `paused`) is preserved on
   * re-registration**; only schema-derived fields (schedule, timezone,
   * onMissed, missedWindowMs) get refreshed from the new config.
   *
   * Why: the daemon-startup ordering is
   *   workspaceManager.initialize  → registrar calls registerTimer
   *   cronManager.start            → loadPersistedTimers + applyMissedPolicy
   *
   * If registerTimer freshly recomputed `nextExecution` every call, it
   * would clobber the on-disk "this slot was scheduled at 07:05" with
   * "next slot from now is 07:20", and applyMissedPolicy would never
   * see a missed-slot gap to recover from. Onboarding tested 2026-05-03:
   * daemon down 10 min on a 5-min cron produced ZERO missed-firing
   * notifications until this preservation landed.
   */
  async registerTimer(config: TimerConfig): Promise<void> {
    const timerKey = `${config.workspaceId}:${config.signalId}`;

    // In-memory check — if a previous registerTimer call (or
    // loadPersistedTimers) already populated the manager's map, skip.
    if (this.timers.has(timerKey)) {
      this.logger.warn("Timer already exists, skipping registration", { timerKey });
      return;
    }

    // Storage check — preserve runtime state (nextExecution,
    // lastExecution, paused) across daemon restarts. Schedule edits
    // through workspace.yml DO refresh schedule/timezone/onMissed.
    const persisted = await this.storage.get<{
      nextExecution: string;
      lastExecution?: string;
      paused?: boolean;
      schedule?: string;
    }>([`cron_timers`, timerKey]);

    let nextExecution: Date;
    let lastExecution: Date | undefined;
    let paused: boolean | undefined;

    if (persisted) {
      // Schedule changed → recompute from now; otherwise carry the
      // previously-scheduled slot forward so applyMissedPolicy can
      // detect the gap.
      const scheduleChanged = persisted.schedule !== config.schedule;
      if (scheduleChanged) {
        try {
          const expr = CronExpressionParser.parse(config.schedule, {
            currentDate: new Date(),
            tz: config.timezone,
          });
          nextExecution = expr.next().toDate();
        } catch (error) {
          const errorMsg = `Invalid cron expression '${config.schedule}': ${
            error instanceof Error ? error.message : String(error)
          }`;
          this.logger.error(errorMsg, { config });
          throw new Error(errorMsg);
        }
      } else {
        nextExecution = new Date(persisted.nextExecution);
      }
      lastExecution = persisted.lastExecution ? new Date(persisted.lastExecution) : undefined;
      paused = persisted.paused;
      this.logger.debug("Re-registering cron timer; preserving runtime state", {
        timerKey,
        nextExecution: nextExecution.toISOString(),
        scheduleChanged,
      });
    } else {
      this.logger.debug("Registering new cron timer", {
        workspaceId: config.workspaceId,
        signalId: config.signalId,
        schedule: config.schedule,
        timezone: config.timezone,
      });
      try {
        const expr = CronExpressionParser.parse(config.schedule, {
          currentDate: new Date(),
          tz: config.timezone,
        });
        nextExecution = expr.next().toDate();
      } catch (error) {
        const errorMsg = `Invalid cron expression '${config.schedule}': ${
          error instanceof Error ? error.message : String(error)
        }`;
        this.logger.error(errorMsg, { config });
        throw new Error(errorMsg);
      }
    }

    const timerInfo: TimerInfo = {
      ...config,
      nextExecution,
      ...(lastExecution ? { lastExecution } : {}),
      ...(paused !== undefined ? { paused } : {}),
    };

    await this.persistTimer(timerKey, timerInfo);
    this.timers.set(timerKey, timerInfo);

    this.logger.debug("Cron timer registered successfully", {
      timerKey,
      nextExecution: timerInfo.nextExecution.toISOString(),
    });
  }

  /**
   * Unregister a timer for a workspace signal
   */
  private async unregisterTimer(workspaceId: string, signalId: string): Promise<void> {
    const timerKey = `${workspaceId}:${signalId}`;

    this.logger.debug("Unregistering cron timer", { workspaceId, signalId, timerKey });

    // Remove from memory
    this.timers.delete(timerKey);

    // Remove from storage
    await this.storage.delete([`cron_timers`, timerKey]);
  }

  /**
   * Unregister all timers for a workspace
   */
  async unregisterWorkspaceTimers(workspaceId: string): Promise<void> {
    const workspaceTimers = Array.from(this.timers.entries()).filter(
      ([_, timer]) => timer.workspaceId === workspaceId,
    );

    if (workspaceTimers.length > 0) {
      this.logger.debug("Unregistering all timers for workspace", {
        workspaceId,
        count: workspaceTimers.length,
      });
    }

    for (const [_timerKey, timer] of workspaceTimers) {
      await this.unregisterTimer(timer.workspaceId, timer.signalId);
    }
  }

  /**
   * Return a snapshot of all registered timers.
   */
  listTimers(): TimerInfo[] {
    return Array.from(this.timers.values());
  }

  /**
   * Pause or resume a timer. Returns false if the timer wasn't found.
   */
  async setTimerPaused(workspaceId: string, signalId: string, paused: boolean): Promise<boolean> {
    const timerKey = `${workspaceId}:${signalId}`;
    const timer = this.timers.get(timerKey);
    if (!timer) return false;

    timer.paused = paused;
    await this.persistTimer(timerKey, timer);
    this.logger.info("Timer pause state updated", { timerKey, paused });
    return true;
  }

  /**
   * Get timer statistics (minimal - only used by daemon status)
   */
  getStats(): { totalTimers: number; nextExecution?: Date } {
    let nextExecution: Date | undefined;

    for (const timer of this.timers.values()) {
      if (!nextExecution || timer.nextExecution < nextExecution) {
        nextExecution = timer.nextExecution;
      }
    }

    return { totalTimers: this.timers.size, nextExecution };
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Enumerate cron slots in (start, end] bounded by `windowMs` (older
   * slots are discarded). Used to detect missed firings on rehydration
   * after daemon downtime, broker outage, or extended pause.
   */
  private computeMissedSlots(
    schedule: string,
    timezone: string,
    after: Date,
    until: Date,
    windowMs: number,
  ): Date[] {
    const earliestAcceptable = until.getTime() - windowMs;
    const startMs = Math.max(after.getTime(), earliestAcceptable);
    if (startMs >= until.getTime()) return [];
    let cursor: ReturnType<typeof CronExpressionParser.parse>;
    try {
      // currentDate=startMs-1ms guarantees `next()` returns the first
      // slot at-or-after `startMs`. cron-parser is exclusive on its
      // `currentDate` boundary.
      cursor = CronExpressionParser.parse(schedule, {
        currentDate: new Date(startMs - 1),
        tz: timezone,
      });
    } catch (err) {
      this.logger.error("Cannot compute missed slots — invalid schedule", { schedule, error: err });
      return [];
    }
    const slots: Date[] = [];
    const SAFETY_LIMIT = 10_000; // bounded against pathological "* * * * *" + huge window
    while (slots.length < SAFETY_LIMIT) {
      let next: Date;
      try {
        next = cursor.next().toDate();
      } catch {
        break; // cron-parser exhausted (rare; some expressions have finite ranges)
      }
      if (next.getTime() > until.getTime()) break;
      slots.push(next);
    }
    return slots;
  }

  /**
   * Apply the timer's onMissed policy on rehydration. Returns true if
   * any catch-up firings were dispatched. Always advances
   * `nextExecution` past `now` regardless of policy.
   */
  private async applyMissedPolicy(timerKey: string, timer: TimerInfo, now: Date): Promise<boolean> {
    // Default flipped from `skip` → `manual` 2026-05-03. Legacy
    // persisted timers without an explicit policy now produce a
    // pending /schedules entry on first restart. Operators can opt
    // back into silent skip via `onMissed: skip` in workspace.yml.
    const policy: OnMissedPolicy = timer.onMissed ?? "manual";
    const windowMs = timer.missedWindowMs ?? DEFAULT_MISSED_WINDOW_MS;
    // The boundary for "missed" is the timer's previously-scheduled
    // nextExecution. Slots strictly after lastExecution and at-or-before
    // now that we never fired count as missed.
    const after = timer.lastExecution ?? new Date(timer.nextExecution.getTime() - 1);
    const slots = this.computeMissedSlots(timer.schedule, timer.timezone, after, now, windowMs);

    if (slots.length === 0 || policy === "skip") {
      if (slots.length > 0) {
        this.logger.info("Missed cron firings skipped by policy", {
          timerKey,
          policy: "skip",
          missedCount: slots.length,
          firstMissedAt: slots[0]?.toISOString(),
        });
      }
      // Just advance nextExecution past now and persist.
      try {
        const expr = CronExpressionParser.parse(timer.schedule, {
          currentDate: now,
          tz: timer.timezone,
        });
        timer.nextExecution = expr.next().toDate();
      } catch (err) {
        this.logger.error("Failed to advance nextExecution after skip", { timerKey, error: err });
      }
      await this.persistTimer(timerKey, timer);
      return false;
    }

    if (policy === "coalesce") {
      const firstMissed = slots[0];
      const mostRecentMissed = slots[slots.length - 1];
      if (!firstMissed || !mostRecentMissed) return false;
      this.logger.info("Cron firings coalesced into one", {
        timerKey,
        policy: "coalesce",
        missedCount: slots.length,
        firstMissedAt: firstMissed.toISOString(),
        scheduledAs: mostRecentMissed.toISOString(),
      });
      await this.fireOnce(timerKey, timer, mostRecentMissed, now, {
        policy: "coalesce",
        missedCount: slots.length,
        firstMissedAt: firstMissed.toISOString(),
      });
      await this.notifyMissedFiring(timer, {
        policy: "coalesce",
        missedCount: slots.length,
        firstMissedAt: firstMissed.toISOString(),
        lastMissedAt: mostRecentMissed.toISOString(),
        scheduledAt: mostRecentMissed.toISOString(),
        firedAt: now.toISOString(),
      });
      return true;
    }

    if (policy === "catchup") {
      this.logger.info("Cron firings replaying in order (catchup)", {
        timerKey,
        policy: "catchup",
        missedCount: slots.length,
        firstMissedAt: slots[0]?.toISOString(),
        lastMissedAt: slots[slots.length - 1]?.toISOString(),
      });
      for (const slot of slots) {
        await this.fireOnce(timerKey, timer, slot, now, {
          policy: "catchup",
          missedCount: 1,
          firstMissedAt: slot.toISOString(),
        });
        await this.notifyMissedFiring(timer, {
          policy: "catchup",
          missedCount: 1,
          firstMissedAt: slot.toISOString(),
          lastMissedAt: slot.toISOString(),
          scheduledAt: slot.toISOString(),
          firedAt: now.toISOString(),
        });
      }
      return true;
    }

    // manual: surface as a pending event but do NOT fire. The
    // operator decides via the /schedules UI. Still advance
    // nextExecution so the next normal slot fires on schedule.
    const firstMissed = slots[0];
    const mostRecentMissed = slots[slots.length - 1];
    if (!firstMissed || !mostRecentMissed) return false;
    this.logger.info("Cron firings flagged for manual review", {
      timerKey,
      policy: "manual",
      missedCount: slots.length,
      firstMissedAt: firstMissed.toISOString(),
      lastMissedAt: mostRecentMissed.toISOString(),
    });
    try {
      const expr = CronExpressionParser.parse(timer.schedule, {
        currentDate: now,
        tz: timer.timezone,
      });
      timer.nextExecution = expr.next().toDate();
    } catch (err) {
      this.logger.error("Failed to advance nextExecution after manual", { timerKey, error: err });
    }
    // Bump lastExecution so a subsequent restart's computeMissedSlots
    // skips past these slots. Without this, every restart re-emits the
    // same pending entries to WORKSPACE_EVENTS — the KV state record
    // dedupes operator action but the stream count still inflates.
    timer.lastExecution = mostRecentMissed;
    await this.persistTimer(timerKey, timer);
    await this.notifyMissedFiring(timer, {
      policy: "manual",
      missedCount: slots.length,
      firstMissedAt: firstMissed.toISOString(),
      lastMissedAt: mostRecentMissed.toISOString(),
      scheduledAt: mostRecentMissed.toISOString(),
      firedAt: now.toISOString(),
      pending: true,
    });
    return false; // didn't actually fire
  }

  /**
   * Best-effort dispatch to the registered notifier. Errors are logged
   * at WARN and swallowed — a failing notification publish must not
   * break the cron firing it describes.
   */
  private async notifyMissedFiring(
    timer: TimerInfo,
    extras: Pick<
      MissedFiringNotification,
      | "policy"
      | "missedCount"
      | "firstMissedAt"
      | "lastMissedAt"
      | "scheduledAt"
      | "firedAt"
      | "pending"
    >,
  ): Promise<void> {
    if (!this.missedFiringNotifier) return;
    try {
      await this.missedFiringNotifier({
        workspaceId: timer.workspaceId,
        signalId: timer.signalId,
        schedule: timer.schedule,
        timezone: timer.timezone,
        ...extras,
      });
    } catch (err) {
      this.logger.warn("Missed-firing notifier threw — event lost", {
        workspaceId: timer.workspaceId,
        signalId: timer.signalId,
        error: err,
      });
    }
  }

  /**
   * Single fire with explicit `scheduled` slot (used for missed-policy
   * make-up fires + the normal on-time path). Advances `nextExecution`
   * to the next slot strictly after `now`, then dispatches via the
   * wakeup callback.
   */
  private async fireOnce(
    timerKey: string,
    timer: TimerInfo,
    scheduled: Date,
    now: Date,
    extras: {
      policy: "ontime" | "coalesce" | "catchup";
      missedCount?: number;
      firstMissedAt?: string;
    },
  ): Promise<void> {
    const missedSince = timer.lastExecution?.toISOString();
    timer.lastExecution = now;
    try {
      const expr = CronExpressionParser.parse(timer.schedule, {
        currentDate: now,
        tz: timer.timezone,
      });
      timer.nextExecution = expr.next().toDate();
    } catch (err) {
      this.logger.error("Failed to advance nextExecution", { timerKey, error: err });
    }
    await this.persistTimer(timerKey, timer);

    const signalData: CronTimerSignalData = {
      id: timer.signalId,
      timestamp: now.toISOString(),
      data: {
        scheduled: scheduled.toISOString(),
        timezone: timer.timezone,
        nextRun: timer.nextExecution.toISOString(),
        actualFiredAt: now.toISOString(),
        ...(missedSince ? { missedSince } : {}),
        ...extras,
      },
    };

    if (!this.wakeupCallback) {
      this.logger.warn("No wakeup callback set - timer execution skipped", { timerKey });
      return;
    }
    try {
      await this.wakeupCallback(timer.workspaceId, timer.signalId, signalData);
      this.logger.debug("Cron timer fired", {
        timerKey,
        scheduled: scheduled.toISOString(),
        policy: extras.policy,
        nextExecution: timer.nextExecution.toISOString(),
      });
    } catch (callbackError) {
      this.logger.error("Wakeup callback failed", {
        error: callbackError,
        timerKey,
        workspaceId: timer.workspaceId,
      });
    }
  }

  /**
   * Execute a timer by waking up the workspace. Used by the runtime
   * tick loop (CHECK_INTERVAL_MS) — assumes a single missed slot at
   * most. Larger gaps go through `applyMissedPolicy` on startup.
   */
  private async executeTimer(timerKey: string, timer: TimerInfo): Promise<void> {
    this.logger.debug("Executing cron timer", {
      timerKey,
      workspaceId: timer.workspaceId,
      signalId: timer.signalId,
      schedule: timer.schedule,
    });
    const now = new Date();
    // The runtime tick only sees gaps of CHECK_INTERVAL_MS at most;
    // treat the previously-scheduled nextExecution as the slot fired,
    // and tag as "ontime".
    await this.fireOnce(timerKey, timer, timer.nextExecution, now, { policy: "ontime" });
  }

  /**
   * Load persisted timers from storage
   */
  private async loadPersistedTimers(): Promise<void> {
    try {
      // Storage returns serialized timer data with ISO date strings
      const timerEntries = this.storage.list<{
        workspaceId: string;
        signalId: string;
        schedule: string;
        timezone: string;
        nextExecution: string;
        lastExecution?: string;
        paused?: boolean;
        onMissed?: OnMissedPolicy;
        missedWindowMs?: number;
      }>([`cron_timers`]);
      let loadedCount = 0;

      for await (const { key, value } of timerEntries) {
        try {
          const timerKey = key[key.length - 1]; // Last part of key is timerKey

          if (!timerKey) {
            throw new Error(`Invalid timer key: ${key}`);
          }

          // Deserialize dates from ISO strings
          const timer: TimerInfo = {
            workspaceId: value.workspaceId,
            signalId: value.signalId,
            schedule: value.schedule,
            timezone: value.timezone,
            nextExecution: new Date(value.nextExecution),
            lastExecution: value.lastExecution ? new Date(value.lastExecution) : undefined,
            paused: value.paused,
            onMissed: value.onMissed,
            missedWindowMs: value.missedWindowMs,
          };

          this.timers.set(timerKey, timer);
          loadedCount++;

          this.logger.debug("Loaded persisted timer", {
            timerKey,
            workspaceId: timer.workspaceId,
            signalId: timer.signalId,
            nextExecution: timer.nextExecution.toISOString(),
          });
        } catch (error) {
          this.logger.error("Failed to load persisted timer", { error, key });
        }
      }

      this.logger.info("Persisted timers loaded successfully", { loadedCount });
    } catch (error) {
      this.logger.error("Failed to load persisted timers", { error });
      throw error;
    }
  }

  /**
   * Persist a single timer to storage
   */
  private async persistTimer(timerKey: string, timer: TimerInfo): Promise<void> {
    // Serialize dates to ISO strings for storage
    await this.storage.set([`cron_timers`, timerKey], {
      workspaceId: timer.workspaceId,
      signalId: timer.signalId,
      schedule: timer.schedule,
      timezone: timer.timezone,
      nextExecution: timer.nextExecution.toISOString(),
      lastExecution: timer.lastExecution?.toISOString(),
      paused: timer.paused,
      onMissed: timer.onMissed,
      missedWindowMs: timer.missedWindowMs,
    });
    this.logger.debug("Timer persisted to storage", { timerKey });
  }
}
