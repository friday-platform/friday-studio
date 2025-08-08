/**
 * Diagnostics status constants
 */
export const DIAGNOSTICS_STATUS = {
  IDLE: "idle",
  COLLECTING: "collecting",
  UPLOADING: "uploading",
  DONE: "done",
} as const;

export type DiagnosticsStatus = typeof DIAGNOSTICS_STATUS[keyof typeof DIAGNOSTICS_STATUS] | string;
// Note: string is included for error messages
