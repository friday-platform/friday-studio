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

import cronParser from "cron-parser";
import { logger } from "../utils/logger.ts";
import type { KVStorage } from "./storage/kv-storage.ts";

export interface TimerInfo {
  workspaceId: string;
  signalId: string;
  schedule: string;
  timezone: string;
  description?: string;
  nextExecution?: Date;
  lastExecution?: Date;
  isActive: boolean;
}

export interface CronTimerConfig {
  workspaceId: string;
  signalId: string;
  schedule: string;
  timezone: string;
  description?: string;
}

export interface PersistedTimerData {
  workspaceId: string;
  signalId: string;
  schedule: string;
  timezone: string;
  description?: string;
  nextExecution?: string; // ISO string
  lastExecution?: string; // ISO string
  isActive: boolean;
  registeredAt: string; // ISO string
}

/**
 * Callback interface for workspace wake-up
 */
export interface WorkspaceWakeupCallback {
  (workspaceId: string, signalId: string, signalData: any): Promise<void>;
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
  private timers = new Map<string, TimerInfo>();
  private activeIntervals = new Map<string, number>();
  private wakeupCallback?: WorkspaceWakeupCallback;
  private isRunning = false;

  constructor(storage: KVStorage) {
    this.storage = storage;
  }

  /**
   * Set the callback function to wake up workspaces when timers fire
   */
  setWakeupCallback(callback: WorkspaceWakeupCallback): void {
    this.wakeupCallback = callback;
  }

  /**
   * Start the cron manager and restore persisted timers
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("CronManager is already running");
      return;
    }

    logger.info("Starting CronManager");

    try {
      // Restore persisted timers
      await this.loadPersistedTimers();

      // Schedule all active timers
      for (const [timerKey, timer] of this.timers.entries()) {
        if (timer.isActive) {
          await this.scheduleTimer(timerKey, timer);
        }
      }

      this.isRunning = true;
      logger.info("CronManager started successfully", {
        activeTimers: this.timers.size,
        scheduledIntervals: this.activeIntervals.size,
      });
    } catch (error) {
      logger.error("Failed to start CronManager", { error });
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

    logger.info("Shutting down CronManager");

    // Clear all active intervals
    for (const [timerKey, intervalId] of this.activeIntervals.entries()) {
      clearTimeout(intervalId);
      this.activeIntervals.delete(timerKey);
    }

    // Persist current state
    await this.persistAllTimers();

    this.isRunning = false;
    logger.info("CronManager shutdown complete");
  }

  /**
   * Register a timer for a workspace signal
   */
  async registerTimer(config: CronTimerConfig): Promise<void> {
    const timerKey = this.getTimerKey(config.workspaceId, config.signalId);

    logger.info("Registering cron timer", {
      workspaceId: config.workspaceId,
      signalId: config.signalId,
      schedule: config.schedule,
      timezone: config.timezone,
    });

    // Validate cron expression
    try {
      cronParser.parseExpression(config.schedule, {
        tz: config.timezone || "UTC",
      });
    } catch (error) {
      const errorMsg = `Invalid cron expression '${config.schedule}': ${
        error instanceof Error ? error.message : String(error)
      }`;
      logger.error(errorMsg, { config });
      throw new Error(errorMsg);
    }

    // Create timer info
    const timerInfo: TimerInfo = {
      workspaceId: config.workspaceId,
      signalId: config.signalId,
      schedule: config.schedule,
      timezone: config.timezone || "UTC",
      description: config.description,
      isActive: true,
    };

    // Calculate next execution
    try {
      const cronExpression = cronParser.parseExpression(config.schedule, {
        tz: timerInfo.timezone,
      });
      timerInfo.nextExecution = cronExpression.next().toDate();
    } catch (error) {
      logger.error("Failed to calculate next execution", { error, config });
      throw error;
    }

    // Store in memory
    this.timers.set(timerKey, timerInfo);

    // Persist to storage
    await this.persistTimer(timerKey, timerInfo);

    // Schedule if cron manager is running
    if (this.isRunning) {
      await this.scheduleTimer(timerKey, timerInfo);
    }

    logger.info("Cron timer registered successfully", {
      timerKey,
      nextExecution: timerInfo.nextExecution?.toISOString(),
    });
  }

  /**
   * Unregister a timer for a workspace signal
   */
  async unregisterTimer(workspaceId: string, signalId: string): Promise<void> {
    const timerKey = this.getTimerKey(workspaceId, signalId);

    logger.info("Unregistering cron timer", { workspaceId, signalId, timerKey });

    // Clear active interval
    const intervalId = this.activeIntervals.get(timerKey);
    if (intervalId) {
      clearTimeout(intervalId);
      this.activeIntervals.delete(timerKey);
    }

    // Remove from memory
    this.timers.delete(timerKey);

    // Remove from storage
    await this.storage.delete([`cron_timers`, timerKey]);

    logger.info("Cron timer unregistered successfully", { timerKey });
  }

  /**
   * Unregister all timers for a workspace
   */
  async unregisterWorkspaceTimers(workspaceId: string): Promise<void> {
    logger.info("Unregistering all timers for workspace", { workspaceId });

    const workspaceTimers = Array.from(this.timers.entries())
      .filter(([_, timer]) => timer.workspaceId === workspaceId);

    for (const [timerKey, timer] of workspaceTimers) {
      await this.unregisterTimer(timer.workspaceId, timer.signalId);
    }

    logger.info("All workspace timers unregistered", {
      workspaceId,
      unregisteredCount: workspaceTimers.length,
    });
  }

  /**
   * List all active timers
   */
  listActiveTimers(): TimerInfo[] {
    return Array.from(this.timers.values())
      .filter((timer) => timer.isActive)
      .sort((a, b) => {
        if (!a.nextExecution && !b.nextExecution) return 0;
        if (!a.nextExecution) return 1;
        if (!b.nextExecution) return -1;
        return a.nextExecution.getTime() - b.nextExecution.getTime();
      });
  }

  /**
   * Get specific timer info
   */
  getTimer(workspaceId: string, signalId: string): TimerInfo | undefined {
    const timerKey = this.getTimerKey(workspaceId, signalId);
    return this.timers.get(timerKey);
  }

  /**
   * Get next execution time for a specific timer
   */
  getNextExecution(workspaceId: string, signalId: string): Date | undefined {
    const timer = this.getTimer(workspaceId, signalId);
    return timer?.nextExecution;
  }

  /**
   * Check if cron manager is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get timer statistics
   */
  getStats(): {
    totalTimers: number;
    activeTimers: number;
    scheduledIntervals: number;
    nextExecution?: Date;
  } {
    const activeTimers = this.listActiveTimers();
    const nextExecution = activeTimers.length > 0 ? activeTimers[0].nextExecution : undefined;

    return {
      totalTimers: this.timers.size,
      activeTimers: activeTimers.length,
      scheduledIntervals: this.activeIntervals.size,
      nextExecution,
    };
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Generate timer key for storage and lookup
   */
  private getTimerKey(workspaceId: string, signalId: string): string {
    return `${workspaceId}:${signalId}`;
  }

  /**
   * Schedule a timer using setTimeout
   */
  private async scheduleTimer(timerKey: string, timer: TimerInfo): Promise<void> {
    // Clear existing interval if any
    const existingInterval = this.activeIntervals.get(timerKey);
    if (existingInterval) {
      clearTimeout(existingInterval);
    }

    if (!timer.nextExecution) {
      logger.error("Cannot schedule timer without next execution time", { timerKey, timer });
      return;
    }

    const delay = timer.nextExecution.getTime() - Date.now();

    if (delay <= 0) {
      // Execution time has passed, calculate next execution
      try {
        const cronExpression = cronParser.parseExpression(timer.schedule, {
          tz: timer.timezone,
        });
        timer.nextExecution = cronExpression.next().toDate();
        await this.persistTimer(timerKey, timer);
        return this.scheduleTimer(timerKey, timer);
      } catch (error) {
        logger.error("Failed to recalculate next execution", { error, timerKey });
        return;
      }
    }

    logger.debug("Scheduling timer execution", {
      timerKey,
      nextExecution: timer.nextExecution.toISOString(),
      delayMs: delay,
    });

    const intervalId = setTimeout(async () => {
      await this.executeTimer(timerKey, timer);
    }, delay);

    this.activeIntervals.set(timerKey, intervalId);
  }

  /**
   * Execute a timer by waking up the workspace
   */
  private async executeTimer(timerKey: string, timer: TimerInfo): Promise<void> {
    logger.info("Executing cron timer", {
      timerKey,
      workspaceId: timer.workspaceId,
      signalId: timer.signalId,
      schedule: timer.schedule,
    });

    try {
      // Update last execution time
      timer.lastExecution = new Date();

      // Calculate next execution
      const cronExpression = cronParser.parseExpression(timer.schedule, {
        tz: timer.timezone,
      });
      timer.nextExecution = cronExpression.next().toDate();

      // Persist updated timer state
      await this.persistTimer(timerKey, timer);

      // Create signal data
      const signalData = {
        id: timer.signalId,
        type: "timer",
        timestamp: new Date().toISOString(),
        data: {
          scheduled: timer.schedule,
          timezone: timer.timezone,
          nextRun: timer.nextExecution.toISOString(),
          source: "cron-manager",
        },
      };

      // Wake up workspace if callback is set
      if (this.wakeupCallback) {
        await this.wakeupCallback(timer.workspaceId, timer.signalId, signalData);
      } else {
        logger.warn("No wakeup callback set - timer execution skipped", { timerKey });
      }

      // Schedule next execution
      await this.scheduleTimer(timerKey, timer);

      logger.info("Cron timer executed successfully", {
        timerKey,
        nextExecution: timer.nextExecution.toISOString(),
      });
    } catch (error) {
      logger.error("Failed to execute cron timer", { error, timerKey, timer });

      // Schedule next execution anyway to prevent timer from stopping
      try {
        await this.scheduleTimer(timerKey, timer);
      } catch (scheduleError) {
        logger.error("Failed to reschedule timer after execution error", {
          scheduleError,
          timerKey,
        });
      }
    }
  }

  /**
   * Load persisted timers from storage
   */
  private async loadPersistedTimers(): Promise<void> {
    try {
      const timerEntries = this.storage.list([`cron_timers`]);

      const timers = [];
      for await (const { key, value } of timerEntries) {
        timers.push({ key, value });
      }

      logger.info("Loading persisted timers", { count: timers.length });

      for (const { key, value } of timers) {
        try {
          const persistedData = value as PersistedTimerData;
          const timerKey = key[key.length - 1]; // Last part of key is timerKey

          const timer: TimerInfo = {
            workspaceId: persistedData.workspaceId,
            signalId: persistedData.signalId,
            schedule: persistedData.schedule,
            timezone: persistedData.timezone,
            description: persistedData.description,
            nextExecution: persistedData.nextExecution
              ? new Date(persistedData.nextExecution)
              : undefined,
            lastExecution: persistedData.lastExecution
              ? new Date(persistedData.lastExecution)
              : undefined,
            isActive: persistedData.isActive,
          };

          // Recalculate next execution if needed
          if (!timer.nextExecution || timer.nextExecution.getTime() <= Date.now()) {
            const cronExpression = cronParser.parseExpression(timer.schedule, {
              tz: timer.timezone,
            });
            timer.nextExecution = cronExpression.next().toDate();
          }

          this.timers.set(timerKey, timer);

          logger.debug("Loaded persisted timer", {
            timerKey,
            workspaceId: timer.workspaceId,
            signalId: timer.signalId,
            nextExecution: timer.nextExecution?.toISOString(),
          });
        } catch (error) {
          logger.error("Failed to load persisted timer", { error, key });
        }
      }

      logger.info("Persisted timers loaded successfully", {
        loadedCount: this.timers.size,
      });
    } catch (error) {
      logger.error("Failed to load persisted timers", { error });
      throw error;
    }
  }

  /**
   * Persist a single timer to storage
   */
  private async persistTimer(timerKey: string, timer: TimerInfo): Promise<void> {
    try {
      const persistedData: PersistedTimerData = {
        workspaceId: timer.workspaceId,
        signalId: timer.signalId,
        schedule: timer.schedule,
        timezone: timer.timezone,
        description: timer.description,
        nextExecution: timer.nextExecution?.toISOString(),
        lastExecution: timer.lastExecution?.toISOString(),
        isActive: timer.isActive,
        registeredAt: new Date().toISOString(),
      };

      await this.storage.set([`cron_timers`, timerKey], persistedData);

      logger.debug("Timer persisted to storage", { timerKey });
    } catch (error) {
      logger.error("Failed to persist timer", { error, timerKey });
      throw error;
    }
  }

  /**
   * Persist all timers to storage
   */
  private async persistAllTimers(): Promise<void> {
    logger.info("Persisting all timers to storage", { count: this.timers.size });

    const persistPromises = Array.from(this.timers.entries()).map(([timerKey, timer]) =>
      this.persistTimer(timerKey, timer)
    );

    try {
      await Promise.all(persistPromises);
      logger.info("All timers persisted successfully");
    } catch (error) {
      logger.error("Failed to persist some timers", { error });
      throw error;
    }
  }
}
