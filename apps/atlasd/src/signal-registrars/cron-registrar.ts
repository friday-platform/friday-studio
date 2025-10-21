import type { MergedConfig } from "@atlas/config";
import type { CronManager, TimerConfig } from "@atlas/cron";
import { logger } from "@atlas/logger";
import type { WorkspaceSignalRegistrar } from "@atlas/workspace/types";

/**
 * CronSignalRegistrar bridges workspace configs to CronManager timers,
 * following the same registration lifecycle as fs-watch registrar.
 */
export class CronSignalRegistrar implements WorkspaceSignalRegistrar {
  private readonly cronManager: CronManager;

  constructor(cronManager: CronManager) {
    this.cronManager = cronManager;
  }

  async registerWorkspace(
    workspaceId: string,
    workspacePath: string,
    config: MergedConfig,
  ): Promise<void> {
    try {
      const signals = config.workspace?.signals;
      if (!signals) return;

      const timers: TimerConfig[] = [];
      for (const signalId of Object.keys(signals)) {
        const signalConfig = signals[signalId];
        if (signalConfig && signalConfig.provider === "schedule") {
          const schedule = signalConfig.config.schedule;
          const timezone = signalConfig.config.timezone || "UTC";
          if (!schedule) {
            logger.warn("Skipping cron signal without schedule", { workspaceId, signalId });
            continue;
          }
          timers.push({ workspaceId, signalId, schedule, timezone });
        }
      }

      for (const t of timers) {
        try {
          await this.cronManager.registerTimer(t);
          logger.info("Registered cron timer", {
            workspaceId,
            signalId: t.signalId,
            schedule: t.schedule,
          });
        } catch (error) {
          logger.error("Failed to register cron timer", {
            error,
            workspaceId,
            signalId: t.signalId,
          });
        }
      }
    } catch (error) {
      logger.error("Failed to register workspace cron signals", {
        error,
        workspaceId,
        workspacePath,
      });
    }
  }

  async unregisterWorkspace(workspaceId: string): Promise<void> {
    try {
      await this.cronManager.unregisterWorkspaceTimers(workspaceId);
      logger.info("Unregistered workspace cron signals", { workspaceId });
    } catch (error) {
      logger.error("Failed to unregister workspace cron signals", { error, workspaceId });
    }
  }

  async shutdown(): Promise<void> {}
}
