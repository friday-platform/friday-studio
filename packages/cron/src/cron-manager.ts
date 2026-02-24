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
}

// Type for registering timers (without computed fields)
export type TimerConfig = Omit<TimerInfo, "nextExecution" | "lastExecution">;

/**
 * Cron timer signal payload data
 */
export interface CronTimerSignalPayload {
  scheduled: string;
  timezone: string;
  nextRun: string;
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
  private checkInterval?: number;
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
   * Start the cron manager and restore persisted timers
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn("CronManager is already running");
      return;
    }

    this.logger.info("Starting CronManager");

    try {
      // Restore persisted timers
      await this.loadPersistedTimers();

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
   * Check all timers and execute any that are due
   * This method runs every CHECK_INTERVAL_MS to ensure reliable execution
   */
  private checkTimers(): void {
    const now = Date.now();
    let dueCount = 0;

    for (const [timerKey, timer] of this.timers.entries()) {
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
      // Update last execution time
      timer.lastExecution = new Date();

      // Calculate next execution
      const cronExpression = CronExpressionParser.parse(timer.schedule, {
        currentDate: new Date(),
        tz: timer.timezone,
      });
      timer.nextExecution = cronExpression.next().toDate();

      // Persist updated timer state immediately for reliability
      await this.persistTimer(timerKey, timer);

      // Create signal data
      const signalData: CronTimerSignalData = {
        id: timer.signalId,
        timestamp: new Date().toISOString(),
        data: {
          scheduled: timer.schedule,
          timezone: timer.timezone,
          nextRun: timer.nextExecution.toISOString(),
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
    });
    this.logger.debug("Timer persisted to storage", { timerKey });
  }
}
