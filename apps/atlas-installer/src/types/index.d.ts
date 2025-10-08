// Re-export action types from constants
export type { ServiceAction } from "../constants/actions";

// Platform and System Types
export interface PlatformInfo {
  platform: NodeJS.Platform;
  arch: string;
  homedir: string;
}

// IPC Result Types
export interface IPCResult {
  success: boolean;
  message?: string;
  error?: string;
}

export interface DirectoryResult extends IPCResult {
  path?: string;
}

export interface ApiKeyCheckResult {
  exists: boolean;
  error?: string;
}

export interface NpxPathResult extends IPCResult {
  npxPath?: string;
}

export interface BinaryCheckResult {
  exists: boolean;
  path?: string;
  error?: string;
}

export interface BinaryInstallResult extends IPCResult {
  _installed?: InstalledBinary[];
  path?: string;
}

export interface DownloadResult extends IPCResult {
  path?: string;
}

export interface InstalledBinary {
  binary?: string;
  installed?: string;
  webApp?: string;
  opened?: boolean;
  autoInstalled?: boolean;
  fallbackReason?: string;
}

// Installation Types
export interface InstallationStep {
  progress: number;
  message: string;
  action: () => Promise<IPCResult>;
}

export interface BinaryInfo {
  name: string;
  sourcePath?: string;
  targetPath?: string;
}

// Tauri API is used directly via invoke() - no global window API needed

// Error Types
export declare class InstallationError extends Error {
  readonly step: string;
  readonly platform: NodeJS.Platform;
  readonly details?: Record<string, unknown>;
  constructor(
    message: string,
    step: string,
    platform: NodeJS.Platform,
    details?: Record<string, unknown>,
  );
}

export declare class ValidationError extends Error {
  readonly field: string;
  constructor(message: string, field: string);
}

// Platform-specific Types
export type PlatformBinaryName = NodeJS.Platform extends "win32" ? `${string}.exe` : string;

export type PlatformPath = string;

// Environment Extensions
export interface ProcessEnv {
  USERPROFILE?: string;
  HOME?: string;
  PATH?: string;
  ATLAS_KEY?: string;
  ATLAS_NPX_PATH?: string;
}

// Service Management Types
export interface WindowsServiceOptions {
  name: string;
  displayName: string;
  description: string;
  executable: string;
  arguments?: string[];
}

export interface MacLaunchAgentOptions {
  label: string;
  programPath: string;
  programArguments?: string[];
  runAtLoad?: boolean;
  keepAlive?: boolean;
}

// Event Types for IPC
export type IPCChannel =
  | "get-platform"
  | "create-atlas-dir"
  | "check-existing-api-key"
  | "save-atlas-key"
  | "save-atlas-npx-path"
  | "install-atlas-binary"
  | "setup-path"
  | "check-atlas-binary"
  | "manage-atlas-service"
  | "quit-app"
  | "get-eula-text";

export type IPCProgressChannel = "installation-progress";

// Handler Types for Tauri commands
/**
 * Tauri command handler type
 * Handlers are async functions that return results
 */
export type IPCHandler<TArg = void, TReturn = IPCResult> = (
  event: unknown,
  arg?: TArg,
) => Promise<TReturn> | TReturn;

// Binary Installation Configuration
export interface InstallConfig {
  resourcesPath: string;
  targetDirectory: string;
  binaries: BinaryInfo[];
  platform: NodeJS.Platform;
  arch: string;
}

// Utility Types
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
