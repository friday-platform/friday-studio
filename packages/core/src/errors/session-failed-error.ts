import type { WorkspaceSessionStatusType } from "../constants/supervisor-status.ts";

/**
 * Thrown when a signal's session completes with a non-success terminal status
 * (failed, skipped, cancelled). Distinguishes session execution failures from
 * infrastructure errors (workspace not found, runtime crash) so callers like the
 * cron wakeup callback can handle them differently.
 */
export class SessionFailedError extends Error {
  override readonly name = "SessionFailedError";
  readonly status: WorkspaceSessionStatusType;

  constructor(signalId: string, status: WorkspaceSessionStatusType, sessionError?: string) {
    super(`Signal '${signalId}' session ${status}: ${sessionError ?? "unknown error"}`);
    this.status = status;
  }
}
