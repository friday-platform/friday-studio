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

import { CronExpressionParser } from "cron-parser";
import type { KVStorage } from "../../../src/core/storage/kv-storage.ts";

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
  (workspaceId: string, signalId: string, signalData: unknown): Promise<void> | void;
}

/**
 * Logger interface for dependency injection
 */
export interface CronLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

/**
 * Simple async mutex for timer operations
 */
class TimerOperationLock {
  private locks = new Map<string, Promise<void>>();

  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    // Wait for any existing operation on this key
    const existingLock = this.locks.get(key);
    if (existingLock) {
      await existingLock;
    }

    // Create new lock for this operation
    let resolver: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      resolver = resolve;
    });

    this.locks.set(key, lockPromise);

    try {
      return await operation();
    } finally {
      // Release the lock
      this.locks.delete(key);
      resolver!();
    }
  }
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
  private logger: CronLogger;
  private timers = new Map<string, TimerInfo>();
  private activeIntervals = new Map<string, number>();
  private wakeupTimeouts = new Map<string, number>();
  private wakeupCallback?: WorkspaceWakeupCallback;
  private isRunning = false;
  private isShuttingDown = false;
  private timerLock = new TimerOperationLock();
  private pendingOperations = new Set<Promise<unknown>>();

  constructor(storage: KVStorage, logger: CronLogger) {
    this.storage = storage;
    this.logger = logger;
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
      this.logger.warn("CronManager is already running");
      return;
    }

    this.logger.info("Starting CronManager");

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
      this.logger.info("CronManager started successfully", {
        activeTimers: this.timers.size,
        scheduledIntervals: this.activeIntervals.size,
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
    this.isShuttingDown = true;

    // Wait for pending operations to complete
    if (this.pendingOperations.size > 0) {
      this.logger.info("Waiting for pending operations to complete", {
        pendingCount: this.pendingOperations.size,
      });
      await Promise.allSettled(Array.from(this.pendingOperations));
    }

    // Clear all active intervals
    for (const [timerKey, intervalId] of this.activeIntervals.entries()) {
      clearTimeout(intervalId);
      this.activeIntervals.delete(timerKey);
    }

    // Clear all wakeup timeouts
    for (const [timerKey, timeoutId] of this.wakeupTimeouts.entries()) {
      clearTimeout(timeoutId);
      this.wakeupTimeouts.delete(timerKey);
    }

    // Persist current state
    await this.persistAllTimers();

    // Close the KV storage connection to free file descriptors
    try {
      await this.storage.close();
      this.logger.info("KV storage connection closed");
    } catch (error) {
      this.logger.error("Failed to close KV storage", { error });
    }

    this.isRunning = false;
    this.isShuttingDown = false;
    this.logger.info("CronManager shutdown complete");
  }

  /**
   * Register a timer for a workspace signal
   */
  async registerTimer(config: CronTimerConfig): Promise<void> {
    if (this.isShuttingDown) {
      throw new Error("Cannot register timer - CronManager is shutting down");
    }

    const timerKey = this.getTimerKey(config.workspaceId, config.signalId);

    // Use timer lock to prevent race conditions
    const operation = this.timerLock.withLock(timerKey, async () => {
      this.logger.info("Registering cron timer", {
        workspaceId: config.workspaceId,
        signalId: config.signalId,
        schedule: config.schedule,
        timezone: config.timezone,
      });

      // Check if timer already exists
      if (this.timers.has(timerKey)) {
        this.logger.warn("Timer already exists, skipping registration", { timerKey });
        return;
      }

      // Validate cron expression
      try {
        CronExpressionParser.parse(config.schedule, {
          tz: config.timezone || "UTC",
        });
      } catch (error) {
        const errorMsg = `Invalid cron expression '${config.schedule}': ${
          error instanceof Error ? error.message : String(error)
        }`;
        this.logger.error(errorMsg, { config });
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
        const cronExpression = CronExpressionParser.parse(config.schedule, {
          tz: timerInfo.timezone,
        });
        timerInfo.nextExecution = cronExpression.next().toDate();
      } catch (error) {
        this.logger.error("Failed to calculate next execution", { error, config });
        throw error;
      }

      // Persist to storage first, then store in memory
      await this.persistTimer(timerKey, timerInfo);

      // Store in memory only after successful persistence
      this.timers.set(timerKey, timerInfo);

      // Schedule if cron manager is running
      if (this.isRunning && !this.isShuttingDown) {
        await this.scheduleTimer(timerKey, timerInfo);
      }

      this.logger.info("Cron timer registered successfully", {
        timerKey,
        nextExecution: timerInfo.nextExecution?.toISOString(),
      });
    });

    // Track pending operation
    this.pendingOperations.add(operation);

    try {
      await operation;
    } finally {
      this.pendingOperations.delete(operation);
    }
  }

  /**
   * Unregister a timer for a workspace signal
   */
  async unregisterTimer(workspaceId: string, signalId: string): Promise<void> {
    const timerKey = this.getTimerKey(workspaceId, signalId);

    // Use timer lock to prevent race conditions
    const operation = this.timerLock.withLock(timerKey, async () => {
      this.logger.info("Unregistering cron timer", { workspaceId, signalId, timerKey });

      // Clear active interval
      const intervalId = this.activeIntervals.get(timerKey);
      if (intervalId) {
        clearTimeout(intervalId);
        this.activeIntervals.delete(timerKey);
      }

      // Clear any pending wakeup timeout
      const timeoutId = this.wakeupTimeouts.get(timerKey);
      if (timeoutId) {
        clearTimeout(timeoutId);
        this.wakeupTimeouts.delete(timerKey);
      }

      // Remove from memory
      this.timers.delete(timerKey);

      // Remove from storage
      await this.storage.delete([`cron_timers`, timerKey]);

      this.logger.info("Cron timer unregistered successfully", { timerKey });
    });

    // Track pending operation
    this.pendingOperations.add(operation);

    try {
      await operation;
    } finally {
      this.pendingOperations.delete(operation);
    }
  }

  /**
   * Unregister all timers for a workspace
   */
  async unregisterWorkspaceTimers(workspaceId: string): Promise<void> {
    this.logger.info("Unregistering all timers for workspace", { workspaceId });

    const workspaceTimers = Array.from(this.timers.entries())
      .filter(([_, timer]) => timer.workspaceId === workspaceId);

    for (const [_timerKey, timer] of workspaceTimers) {
      await this.unregisterTimer(timer.workspaceId, timer.signalId);
    }

    this.logger.info("All workspace timers unregistered", {
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
    const firstTimer = activeTimers[0];
    const nextExecution = firstTimer?.nextExecution;

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
      this.logger.error("Cannot schedule timer without next execution time", { timerKey, timer });
      return;
    }

    const delay = timer.nextExecution.getTime() - Date.now();

    if (delay <= 0) {
      // Execution time has passed, calculate next execution
      try {
        const cronExpression = CronExpressionParser.parse(timer.schedule, {
          tz: timer.timezone,
        });
        timer.nextExecution = cronExpression.next().toDate();
        await this.persistTimer(timerKey, timer);
        return this.scheduleTimer(timerKey, timer);
      } catch (error) {
        this.logger.error("Failed to recalculate next execution", { error, timerKey });
        return;
      }
    }

    this.logger.debug("Scheduling timer execution", {
      timerKey,
      nextExecution: timer.nextExecution.toISOString(),
      delayMs: delay,
    });

    // Atomically create and track the timer to prevent race conditions
    const intervalId = setTimeout(async () => {
      // Remove from active intervals when execution starts
      this.activeIntervals.delete(timerKey);
      await this.executeTimer(timerKey, timer);
    }, delay);

    this.activeIntervals.set(timerKey, intervalId);
  }

  /**
   * Execute a timer by waking up the workspace
   */
  private async executeTimer(timerKey: string, timer: TimerInfo): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.debug("Skipping timer execution - shutting down", { timerKey });
      return;
    }

    // Use timer lock to prevent race conditions during execution
    const operation = this.timerLock.withLock(timerKey, async () => {
      this.logger.info("Executing cron timer", {
        timerKey,
        workspaceId: timer.workspaceId,
        signalId: timer.signalId,
        schedule: timer.schedule,
      });

      // Double-check timer still exists (might have been unregistered)
      if (!this.timers.has(timerKey)) {
        this.logger.debug("Timer no longer exists, skipping execution", { timerKey });
        return;
      }

      try {
        // Update last execution time
        timer.lastExecution = new Date();

        // Calculate next execution
        const cronExpression = CronExpressionParser.parse(timer.schedule, {
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
            nextRun: timer.nextExecution?.toISOString() ?? "unknown",
            source: "cron-manager",
          },
        };

        // Wake up workspace if callback is set (with timeout protection)
        if (this.wakeupCallback) {
          try {
            // Add timeout to prevent hanging
            let timeoutId: number;
            const timeoutPromise = new Promise((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error("Wakeup callback timeout")), 30000);
            });

            // Track the timeout so it can be cleared
            this.wakeupTimeouts.set(timerKey, timeoutId!);

            try {
              await Promise.race([
                this.wakeupCallback(timer.workspaceId, timer.signalId, signalData),
                timeoutPromise,
              ]);
            } finally {
              // Clear the timeout regardless of outcome
              if (this.wakeupTimeouts.has(timerKey)) {
                clearTimeout(this.wakeupTimeouts.get(timerKey)!);
                this.wakeupTimeouts.delete(timerKey);
              }
            }
          } catch (callbackError) {
            this.logger.error("Wakeup callback failed", {
              error: callbackError,
              timerKey,
              workspaceId: timer.workspaceId,
            });
            // Continue with rescheduling even if callback fails
          }
        } else {
          this.logger.warn("No wakeup callback set - timer execution skipped", { timerKey });
        }

        // Schedule next execution (only if not shutting down)
        if (!this.isShuttingDown) {
          await this.scheduleTimer(timerKey, timer);
        }

        this.logger.info("Cron timer executed successfully", {
          timerKey,
          nextExecution: timer.nextExecution?.toISOString() ?? "unknown",
        });
      } catch (error) {
        this.logger.error("Failed to execute cron timer", { error, timerKey, timer });

        // Schedule next execution anyway to prevent timer from stopping (if not shutting down)
        if (!this.isShuttingDown) {
          try {
            await this.scheduleTimer(timerKey, timer);
          } catch (scheduleError) {
            this.logger.error("Failed to reschedule timer after execution error", {
              scheduleError,
              timerKey,
            });
          }
        }
      }
    });

    // Track pending operation
    this.pendingOperations.add(operation);

    try {
      await operation;
    } finally {
      this.pendingOperations.delete(operation);
    }
  }

  /**
   * Load persisted timers from storage
   */
  private async loadPersistedTimers(): Promise<void> {
    try {
      const timerEntries = this.storage.list([`cron_timers`]);

      const timers: Array<{ key: string[]; value: unknown }> = [];
      for await (const { key, value } of timerEntries) {
        timers.push({ key, value });
      }

      this.logger.info("Loading persisted timers", { count: timers.length });

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
            const cronExpression = CronExpressionParser.parse(timer.schedule, {
              tz: timer.timezone,
            });
            timer.nextExecution = cronExpression.next().toDate();
          }

          this.timers.set(timerKey, timer);

          this.logger.debug("Loaded persisted timer", {
            timerKey,
            workspaceId: timer.workspaceId,
            signalId: timer.signalId,
            nextExecution: timer.nextExecution?.toISOString(),
          });
        } catch (error) {
          this.logger.error("Failed to load persisted timer", { error, key });
        }
      }

      this.logger.info("Persisted timers loaded successfully", {
        loadedCount: this.timers.size,
      });
    } catch (error) {
      this.logger.error("Failed to load persisted timers", { error });
      throw error;
    }
  }

  /**
   * Persist a single timer to storage with retry logic
   */
  private async persistTimer(timerKey: string, timer: TimerInfo, retries = 3): Promise<void> {
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

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this.storage.set([`cron_timers`, timerKey], persistedData);

        this.logger.debug("Timer persisted to storage", {
          timerKey,
          attempt: attempt > 1 ? attempt : undefined,
        });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < retries) {
          const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // Exponential backoff, max 5s
          this.logger.warn("Storage operation failed, retrying", {
            timerKey,
            attempt,
            totalRetries: retries,
            delayMs,
            error: lastError.message,
          });

          // Add jitter to prevent thundering herd
          const jitter = Math.random() * 100;
          await new Promise((resolve) => setTimeout(resolve, delayMs + jitter));
        }
      }
    }

    // All retries failed
    this.logger.error("Failed to persist timer after all retries", {
      error: lastError,
      timerKey,
      retries,
    });
    throw lastError;
  }

  /**
   * Persist all timers to storage
   */
  private async persistAllTimers(): Promise<void> {
    this.logger.info("Persisting all timers to storage", { count: this.timers.size });

    if (this.timers.size === 0) {
      this.logger.debug("No timers to persist");
      return;
    }

    // Use allSettled to handle individual failures gracefully
    const persistPromises = Array.from(this.timers.entries()).map(([timerKey, timer]) =>
      this.persistTimer(timerKey, timer).catch((error) => ({ timerKey, error }))
    );

    try {
      const results = await Promise.allSettled(persistPromises);

      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected").length;

      if (failed > 0) {
        this.logger.warn("Some timers failed to persist", {
          succeeded,
          failed,
          total: this.timers.size,
        });

        // Log details of failures
        results.forEach((result, index) => {
          if (result.status === "rejected") {
            const entry = Array.from(this.timers.entries())[index];
            if (entry) {
              const [timerKey] = entry;
              this.logger.error("Timer persistence failed", {
                timerKey,
                error: result.reason,
              });
            } else {
              this.logger.error("Timer persistence failed", {
                index,
                error: result.reason,
              });
            }
          }
        });
      } else {
        this.logger.info("All timers persisted successfully", { count: succeeded });
      }
    } catch (error) {
      this.logger.error("Failed to persist timers", { error });
      // Don't throw - we want shutdown to continue even if persistence fails
    }
  }
}
