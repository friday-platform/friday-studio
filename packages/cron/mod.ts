/**
 * @atlas/cron - Daemon-level cron management for Atlas workspaces
 *
 * Provides centralized timer management that survives workspace runtime shutdowns.
 * Allows workspaces to sleep while maintaining scheduled automation.
 */

export {
  CronManager,
  type CronTimerSignalData,
  type CronTimerSignalPayload,
  type TimerConfig,
  type TimerInfo,
} from "./src/cron-manager.ts";
