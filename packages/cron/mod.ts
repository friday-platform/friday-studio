/**
 * @atlas/cron - Daemon-level cron management for Atlas workspaces
 *
 * Provides centralized timer management that survives workspace runtime shutdowns.
 * Allows workspaces to sleep while maintaining scheduled automation.
 */

export {
  type CronLogger,
  CronManager,
  type CronTimerConfig,
  type PersistedTimerData,
  type TimerInfo,
  type WorkspaceWakeupCallback,
} from "./src/cron-manager.ts";
