/**
 * Terminal setup type definitions
 */

export interface TerminalInfo {
  type: "Apple_Terminal" | "iTerm.app" | "ghostty" | "unknown";
  isSupported: boolean;
  confidence: "high" | "medium" | "low";
  detectionMethod: string;
}

export interface TerminalContext {
  terminal: TerminalInfo;
  isSSH: boolean;
  isTmux: boolean;
  isScreen: boolean;
  isDocker: boolean;
  warnings: string[];
}

export interface SetupResult {
  success: boolean;
  error?: string; // Only populated on failure
  backupPath?: string;
  terminalType?: "Apple_Terminal" | "iTerm.app" | "ghostty"; // Terminal type for context
}

export interface TerminalSetupState {
  shiftEnterKeyBindingInstalled?: boolean;
  optionAsMetaKeyInstalled?: boolean;
  appleTerminalBackupPath?: string;
  iterm2BackupPath?: string;
  ghosttyBackupPath?: string;
  lastSetupAttempt?: string; // ISO date string
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  success: boolean;
}

export interface PreFlightCheckResult {
  canProceed: boolean;
  issues: string[];
  warnings: string[];
}
