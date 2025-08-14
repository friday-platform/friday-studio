/**
 * Diagnostics status constants
 */
export const DIAGNOSTICS_STATUS = {
  IDLE: "idle",
  COLLECTING: "collecting",
  UPLOADING: "uploading",
  DONE: "done",
} as const;

export type DiagnosticsStatus = string;
// Note: string is included for error messages
