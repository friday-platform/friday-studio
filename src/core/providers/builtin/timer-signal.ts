/**
 * Timer Signal Provider - Built-in provider for cron-based scheduled signals
 * Handles cron expressions with timezone support for scheduled task execution
 */

import type { HealthStatus, IProvider, ProviderState } from "../types.ts";
import { ProviderStatus, ProviderType } from "../types.ts";
import { logger } from "../../../utils/logger.ts";
import type { KVStorage } from "../../storage/kv-storage.ts";
import cronParser from "cron-parser";

export interface TimerSignalConfig {
  id: string;
  description: string;
  provider: "timer" | "schedule" | "cron" | "cron-scheduler";
  schedule: string; // Cron expression (e.g., "0 9 * * 1" for Monday 9 AM)
  timezone?: string; // IANA timezone (e.g., "America/Los_Angeles")
}

export interface TimerSignalData {
  id: string;
  type: string;
  timestamp: string;
  data: {
    scheduled: string; // The original cron schedule
    timezone?: string;
    nextRun?: string; // ISO string of next scheduled run
  };
}

export interface TimerSignalPersistentState {
  id: string;
  schedule: string;
  timezone?: string;
  nextExecution?: string; // ISO string
  lastExecution?: string; // ISO string
  isActive: boolean;
}

/**
 * Built-in Timer Signal Provider for cron-based scheduled signals
 */
export class TimerSignalProvider implements IProvider {
  // IProvider interface properties
  readonly id: string;
  readonly type = ProviderType.SIGNAL;
  readonly name = "Timer Signal Provider";
  readonly version = "1.0.0";

  private config: TimerSignalConfig;
  private state: ProviderState;
  private cronInterval?: number; // Timer reference for cleanup
  private nextExecution?: Date;
  private signalCallback?: (signal: TimerSignalData) => void | Promise<void>;
  private storage?: KVStorage;
  private storageKey: string[];

  constructor(config: TimerSignalConfig, storage?: KVStorage) {
    this.validateConfig(config);
    this.config = {
      ...config,
      timezone: config.timezone || "UTC",
    };
    this.id = config.id;
    this.storage = storage;
    this.storageKey = ["timer_signals", config.id];
    this.state = {
      status: ProviderStatus.NOT_CONFIGURED,
    };
  }

  private validateConfig(config: TimerSignalConfig): void {
    if (!config.schedule) {
      throw new Error("Timer signal provider requires 'schedule' configuration (cron expression)");
    }

    try {
      // Validate cron expression
      cronParser.parseExpression(config.schedule);
    } catch (error) {
      throw new Error(
        `Invalid cron expression '${config.schedule}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Validate timezone if provided
    if (config.timezone) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: config.timezone });
      } catch (error) {
        throw new Error(
          `Invalid timezone '${config.timezone}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * Set the callback function to call when signal is triggered
   */
  setSignalCallback(callback: (signal: TimerSignalData) => void | Promise<void>): void {
    this.signalCallback = callback;
  }

  // IProvider interface methods
  setup(): void {
    this.state.status = ProviderStatus.CONFIGURING;
    this.state.config = this.config;

    // Handle async operations in background
    this.setupAsync().then(() => {
      // Only set to READY after async setup completes successfully
      this.state.status = ProviderStatus.READY;
      logger.info("Timer signal provider setup completed", {
        signalId: this.config.id,
        schedule: this.config.schedule,
        timezone: this.config.timezone,
        nextExecution: this.nextExecution?.toISOString(),
      });
    }).catch((error) => {
      logger.error("Failed to complete timer signal provider async setup", {
        signalId: this.config.id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.state.status = ProviderStatus.ERROR;
      this.state.error = error instanceof Error ? error.message : String(error);
    });

    logger.info("Timer signal provider setup initiated", {
      signalId: this.config.id,
      schedule: this.config.schedule,
      timezone: this.config.timezone,
    });
  }

  private async setupAsync(): Promise<void> {
    // Try to restore state from storage
    await this.loadPersistedState();

    // Schedule the first execution
    await this.scheduleNext();

    logger.info("Timer signal provider async setup completed", {
      signalId: this.config.id,
      schedule: this.config.schedule,
      timezone: this.config.timezone,
      nextExecution: this.nextExecution?.toISOString(),
      restoredFromStorage: !!this.storage,
    });
  }

  teardown(): void {
    // Set status to disabled first to prevent new operations
    this.state.status = ProviderStatus.DISABLED;

    // Clear any active timer
    if (this.cronInterval !== undefined) {
      clearTimeout(this.cronInterval);
      this.cronInterval = undefined;
    }

    // Clear next execution
    this.nextExecution = undefined;

    // Clear callback to prevent further executions
    this.signalCallback = undefined;

    // Clear any error state
    this.state.error = undefined;

    // Persist state before shutdown in background
    this.persistState().catch((error) => {
      logger.warn("Failed to persist timer signal state during teardown", {
        signalId: this.config.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    logger.info("Timer signal provider torn down", {
      signalId: this.config.id,
    });
  }

  getState(): ProviderState {
    return {
      ...this.state,
      lastHealthCheck: new Date(),
      config: {
        ...this.config,
        nextExecution: this.nextExecution?.toISOString(),
      },
    };
  }

  checkHealth(): Promise<HealthStatus> {
    const isHealthy = this.state.status === ProviderStatus.READY &&
      this.nextExecution !== undefined;

    return Promise.resolve({
      healthy: isHealthy,
      lastCheck: new Date(),
      message: isHealthy
        ? `Timer signal scheduled for ${this.nextExecution?.toISOString()}`
        : `Provider status: ${this.state.status}`,
      details: {
        schedule: this.config.schedule,
        timezone: this.config.timezone,
        nextExecution: this.nextExecution?.toISOString(),
        hasCallback: !!this.signalCallback,
      },
    });
  }

  /**
   * Get the provider ID
   */
  getProviderId(): string {
    return this.config.id;
  }

  /**
   * Get the provider type
   */
  getProviderType(): string {
    return this.config.provider;
  }

  /**
   * Get the cron schedule
   */
  getSchedule(): string {
    return this.config.schedule;
  }

  /**
   * Get the timezone
   */
  getTimezone(): string {
    return this.config.timezone || "UTC";
  }

  /**
   * Get the next execution time
   */
  getNextExecution(): Date | undefined {
    return this.nextExecution;
  }

  /**
   * Schedule the next execution based on cron expression
   */
  private async scheduleNext(): Promise<void> {
    // Don't schedule if already disabled
    if (this.state.status === ProviderStatus.DISABLED) {
      return;
    }

    try {
      const timezone = this.config.timezone || "UTC";
      const cronExpression = cronParser.parseExpression(this.config.schedule, {
        currentDate: new Date(),
        tz: timezone,
      });

      this.nextExecution = cronExpression.next().toDate();
      const delay = this.nextExecution.getTime() - Date.now();

      logger.debug("Scheduling next timer signal execution", {
        signalId: this.config.id,
        schedule: this.config.schedule,
        timezone,
        nextExecution: this.nextExecution.toISOString(),
        delayMs: delay,
      });

      // Clear any existing timer
      if (this.cronInterval !== undefined) {
        clearTimeout(this.cronInterval);
        this.cronInterval = undefined;
      }

      // Don't schedule if disabled during the process
      if (this.state.status === ProviderStatus.DISABLED) {
        return;
      }

      // Schedule the next execution
      this.cronInterval = setTimeout(async () => {
        // Check if still ready before executing
        if (this.state.status === ProviderStatus.READY) {
          await this.executeSignal();
        }
      }, delay);

      // Persist state after scheduling
      await this.persistState();
    } catch (error) {
      logger.error("Failed to schedule next timer signal execution", {
        signalId: this.config.id,
        error: error instanceof Error ? error.message : String(error),
      });

      if (this.state.status !== ProviderStatus.DISABLED) {
        this.state.status = ProviderStatus.ERROR;
        this.state.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  /**
   * Load persisted state from storage if available
   */
  private async loadPersistedState(): Promise<void> {
    if (!this.storage) return;

    try {
      const persistedState = await this.storage.get<TimerSignalPersistentState>(this.storageKey);
      if (persistedState) {
        // Restore next execution time if it's in the future
        if (persistedState.nextExecution) {
          const nextExecution = new Date(persistedState.nextExecution);
          if (nextExecution.getTime() > Date.now()) {
            this.nextExecution = nextExecution;
            logger.info("Restored timer signal state from storage", {
              signalId: this.config.id,
              nextExecution: this.nextExecution.toISOString(),
            });
          }
        }
      }
    } catch (error) {
      logger.warn("Failed to load persisted timer signal state", {
        signalId: this.config.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Persist current state to storage
   */
  private async persistState(): Promise<void> {
    if (!this.storage) return;

    try {
      const persistentState: TimerSignalPersistentState = {
        id: this.config.id,
        schedule: this.config.schedule,
        timezone: this.config.timezone,
        nextExecution: this.nextExecution?.toISOString(),
        isActive: this.state.status === ProviderStatus.READY,
      };

      await this.storage.set(this.storageKey, persistentState);

      logger.debug("Persisted timer signal state", {
        signalId: this.config.id,
        nextExecution: persistentState.nextExecution,
      });
    } catch (error) {
      logger.warn("Failed to persist timer signal state", {
        signalId: this.config.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Execute the signal and schedule the next one
   */
  private async executeSignal(): Promise<void> {
    if (this.state.status !== ProviderStatus.READY) {
      logger.warn("Timer signal execution skipped - provider not ready", {
        signalId: this.config.id,
        status: this.state.status,
      });
      return;
    }

    // Double-check status hasn't changed during execution
    if (this.state.status !== ProviderStatus.READY) {
      logger.debug("Timer signal execution skipped - provider not ready", {
        signalId: this.config.id,
        status: this.state.status,
      });
      return;
    }

    try {
      const signal: TimerSignalData = {
        id: this.config.id,
        type: "timer",
        timestamp: new Date().toISOString(),
        data: {
          scheduled: this.config.schedule,
          timezone: this.config.timezone,
        },
      };

      // Calculate next run for the signal data
      try {
        const cronExpression = cronParser.parseExpression(this.config.schedule, {
          currentDate: new Date(),
          tz: this.config.timezone || "UTC",
        });
        signal.data.nextRun = cronExpression.next().toDate().toISOString();
      } catch {
        // If we can't calculate next run, that's ok
      }

      logger.info("Timer signal triggered", {
        signalId: this.config.id,
        schedule: this.config.schedule,
        timezone: this.config.timezone,
        timestamp: signal.timestamp,
      });

      // Call the signal callback if set (with error handling)
      if (this.signalCallback) {
        try {
          await this.signalCallback(signal);
        } catch (callbackError) {
          logger.error("Timer signal callback failed", {
            signalId: this.config.id,
            error: callbackError instanceof Error ? callbackError.message : String(callbackError),
          });
          // Continue execution despite callback error
        }
      } else {
        logger.warn("Timer signal triggered but no callback set", {
          signalId: this.config.id,
        });
      }

      // Schedule the next execution
      await this.scheduleNext();

      // Persist state after successful execution
      await this.persistState();
    } catch (error) {
      logger.error("Failed to execute timer signal", {
        signalId: this.config.id,
        error: error instanceof Error ? error.message : String(error),
      });

      this.state.status = ProviderStatus.ERROR;
      this.state.error = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Manually trigger the signal (for testing purposes)
   */
  triggerManually(): Promise<TimerSignalData> {
    const signal: TimerSignalData = {
      id: this.config.id,
      type: "timer",
      timestamp: new Date().toISOString(),
      data: {
        scheduled: this.config.schedule,
        timezone: this.config.timezone,
      },
    };

    if (this.signalCallback) {
      this.signalCallback(signal);
    }

    return Promise.resolve(signal);
  }
}
