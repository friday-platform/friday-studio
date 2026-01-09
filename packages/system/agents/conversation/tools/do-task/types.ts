/**
 * Task Progress Types
 *
 * Progress event types for do_task execution.
 * Note: EnhancedTaskStep lives in planner.ts to avoid circular deps.
 */

/**
 * Progress events emitted during task execution.
 * Discriminated union - make impossible states impossible.
 */
export type TaskProgressEvent =
  | { type: "planning" }
  | { type: "preparing"; stepCount: number }
  | { type: "step-start"; stepIndex: number; totalSteps: number; description: string }
  | { type: "step-complete"; stepIndex: number; success: boolean };

/**
 * Datetime context from client session
 */
export interface DatetimeContext {
  timezone: string;
  timestamp: string;
  localDate: string;
  localTime: string;
  timezoneOffset: string;
}

/**
 * Execution context with progress callback and cancellation.
 * Passed to FSM executor.
 */
export interface TaskExecutionContext {
  sessionId: string;
  workspaceId: string;
  streamId: string;
  userId?: string;
  daemonUrl?: string;
  datetime?: DatetimeContext;
  onProgress?: (event: TaskProgressEvent) => void;
  abortSignal?: AbortSignal;
}
