/**
 * WatchdogTimer - Progress-based timeout system for MCP operations and LLM generations
 *
 * Replaces static AbortSignal.timeout() with intelligent progress monitoring.
 * Operations must report progress within progressTimeout or be cancelled for inactivity.
 */

import {
  parseDuration,
  type WorkspaceTimeoutConfig,
  WorkspaceTimeoutConfigSchema,
} from "@atlas/config";

// =============================================================================
// WATCHDOG TIMER IMPLEMENTATION
// =============================================================================

/**
 * WatchdogTimer provides progress-based timeout monitoring.
 *
 * Instead of "operation must complete in X seconds", uses
 * "operation must show progress within X seconds or be cancelled for inactivity".
 */
export class WatchdogTimer {
  private readonly abortController: AbortController;
  private readonly progressTimeoutMs: number;
  private readonly maxTotalTimeoutMs: number;

  private progressTimer: number | null = null;
  private totalTimer: number | null = null;
  private isAborted = false;

  constructor(config?: WorkspaceTimeoutConfig) {
    // Apply defaults and validate configuration
    const validatedConfig = WorkspaceTimeoutConfigSchema.parse(config || {});

    this.progressTimeoutMs = parseDuration(validatedConfig.progressTimeout);
    this.maxTotalTimeoutMs = parseDuration(validatedConfig.maxTotalTimeout);

    this.abortController = new AbortController();

    // Start both timers
    this.resetProgressTimer();
    this.startTotalTimer();
  }

  /**
   * Signal progress to reset the progress timeout.
   * Call this whenever the operation makes meaningful progress.
   */
  reportProgress(): void {
    if (this.isAborted) {
      return; // Already aborted, ignore progress reports
    }

    this.resetProgressTimer();
  }

  /**
   * Get AbortSignal for integration with existing code.
   * Use this signal in fetch(), generateText(), and other operations.
   */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Check if the watchdog has been triggered (operation timed out)
   */
  get isTimedOut(): boolean {
    return this.isAborted;
  }

  /**
   * Manually abort the operation and clean up timers
   */
  abort(reason = "Operation manually aborted"): void {
    if (this.isAborted) {
      return;
    }

    this.isAborted = true;
    this.cleanupTimers();
    this.abortController.abort(reason);
  }

  // ==========================================================================
  // PRIVATE IMPLEMENTATION
  // ==========================================================================

  private resetProgressTimer(): void {
    // Clear existing progress timer
    if (this.progressTimer !== null) {
      clearTimeout(this.progressTimer);
    }

    // Set new progress timer
    this.progressTimer = setTimeout(() => {
      this.abort("Operation timed out due to inactivity (no progress reported)");
    }, this.progressTimeoutMs);
  }

  private startTotalTimer(): void {
    this.totalTimer = setTimeout(() => {
      this.abort("Operation exceeded maximum total timeout");
    }, this.maxTotalTimeoutMs);
  }

  private cleanupTimers(): void {
    if (this.progressTimer !== null) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }

    if (this.totalTimer !== null) {
      clearTimeout(this.totalTimer);
      this.totalTimer = null;
    }
  }
}
