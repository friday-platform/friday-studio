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

export interface TimerInfo {
  workspaceId: string;
  signalId: string;
  schedule: string;
  timezone: string;
  nextExecution: Date; // Always present at runtime
  lastExecution?: Date;
  paused?: boolean;
}

// Type for registering timers (without computed fields)
export type TimerConfig = Omit<TimerInfo, "nextExecution" | "lastExecution">;

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
export class CronManager {
  private storage: KVStorage;
  private logger: Logger;
  private wakeupCallback?: WorkspaceSignalTriggerCallback;
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
   * Register a timer for a workspace signal
   */
  async registerTimer(config: TimerConfig): Promise<void> {
    const timerKey = `${config.workspaceId}:${config.signalId}`;

    // Check if timer already exists
    if (this.timers.has(timerKey)) {
      this.logger.warn("Timer already exists, skipping registration", { timerKey });
      return;
    }

    // Validate cron expression and calculate next execution
    this.logger.debug("Registering cron timer", {
      workspaceId: config.workspaceId,
      signalId: config.signalId,
      schedule: config.schedule,
      timezone: config.timezone,
    });
    let nextExecution: Date;

    try {
      const cronExpression = CronExpressionParser.parse(config.schedule, {
        currentDate: new Date(),
        tz: config.timezone,
      });
      nextExecution = cronExpression.next().toDate();
    } catch (error) {
      const errorMsg = `Invalid cron expression '${config.schedule}': ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.logger.error(errorMsg, { config });
      throw new Error(errorMsg);
    }

    // Create timer info (reuse config but ensure nextExecution is set)
    const timerInfo: TimerInfo = { ...config, nextExecution };

    // Persist to storage first, then store in memory
    await this.persistTimer(timerKey, timerInfo);

    // Store in memory only after successful persistence
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
   * Execute a timer by waking up the workspace
   */
  private async executeTimer(timerKey: string, timer: TimerInfo): Promise<void> {
    this.logger.debug("Executing cron timer", {
      timerKey,
      workspaceId: timer.workspaceId,
      signalId: timer.signalId,
      schedule: timer.schedule,
    });

    try {
      // Capture `missedSince` BEFORE we mutate lastExecution — it's the
      // previous tick (if any) that the consumer's "did I miss any?"
      // computation cares about. See CronTimerSignalPayload docstring.
      const missedSince = timer.lastExecution?.toISOString();

      const now = new Date();
      timer.lastExecution = now;

      // Calculate next execution
      const cronExpression = CronExpressionParser.parse(timer.schedule, {
        currentDate: now,
        tz: timer.timezone,
      });
      timer.nextExecution = cronExpression.next().toDate();

      // Persist updated timer state immediately for reliability
      await this.persistTimer(timerKey, timer);

      // Create signal data
      const signalData: CronTimerSignalData = {
        id: timer.signalId,
        timestamp: now.toISOString(),
        data: {
          scheduled: timer.schedule,
          timezone: timer.timezone,
          nextRun: timer.nextExecution.toISOString(),
          actualFiredAt: now.toISOString(),
          ...(missedSince ? { missedSince } : {}),
        },
      };

      // Wake up workspace if callback is set
      if (this.wakeupCallback) {
        try {
          await this.wakeupCallback(timer.workspaceId, timer.signalId, signalData);
          this.logger.debug("Cron timer executed successfully", {
            timerKey,
            nextExecution: timer.nextExecution.toISOString(),
          });
        } catch (callbackError) {
          this.logger.error("Wakeup callback failed", {
            error: callbackError,
            timerKey,
            workspaceId: timer.workspaceId,
          });
          // Continue with next execution calculation even if callback fails
        }
      } else {
        this.logger.warn("No wakeup callback set - timer execution skipped", { timerKey });
      }
    } catch (error) {
      this.logger.error("Failed to execute cron timer", { error, timerKey, timer });
      // Timer will be retried on next interval check
    }
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
    });
    this.logger.debug("Timer persisted to storage", { timerKey });
  }
}
