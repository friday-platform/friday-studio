import type { CronManager, CronTimerConfig } from "@atlas/cron";
import { logger } from "@atlas/logger";
import type { WorkspaceManager } from "@atlas/workspace";
import type { WorkspaceSignalRegistrar } from "./types.ts";

/**
 * CronSignalRegistrar bridges workspace configs to CronManager timers,
 * following the same registration lifecycle as fs-watch registrar.
 */
export class CronSignalRegistrar implements WorkspaceSignalRegistrar {
  private readonly cronManager: CronManager;
  private workspaceManager: WorkspaceManager | null = null;

  constructor(cronManager: CronManager) {
    this.cronManager = cronManager;
  }

  async initialize(): Promise<void> {}

  async discoverAndRegisterExisting(workspaceManager: WorkspaceManager): Promise<void> {
    this.workspaceManager = workspaceManager;
    try {
      const workspaces = await workspaceManager.list();
      logger.info("Discovering cron signals for existing workspaces", {
        workspaceCount: workspaces.length,
      });

      let registeredTimers = 0;
      for (const workspace of workspaces) {
        const before = this.cronManager.listActiveTimers().length;
        await this.registerWorkspace(workspace.id, workspace.path);
        const after = this.cronManager.listActiveTimers().length;
        registeredTimers += after - before;
      }

      logger.info("Cron signal discovery complete", { timersRegistered: registeredTimers });
    } catch (error) {
      logger.error("Failed to discover existing workspace cron signals", { error });
    }
  }

  async registerWorkspace(workspaceId: string, workspacePath: string): Promise<void> {
    try {
      // Centralized config loading
      const merged = await this.workspaceManager?.getWorkspaceConfig(workspaceId);
      const signals = merged?.workspace?.signals;
      if (!signals) return;

      const timers: CronTimerConfig[] = [];
      for (const signalId of Object.keys(signals)) {
        const signalConfig = signals[signalId];
        if (signalConfig && signalConfig.provider === "schedule") {
          const schedule = signalConfig.config.schedule;
          const timezone = signalConfig.config.timezone || "UTC";
          if (!schedule) {
            logger.warn("Skipping cron signal without schedule", { workspaceId, signalId });
            continue;
          }
          timers.push({
            workspaceId,
            signalId,
            schedule,
            timezone,
            description: signalConfig.description,
          });
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

  async onWorkspaceConfigChanged(workspaceId: string, workspacePath: string): Promise<void> {
    await this.unregisterWorkspace(workspaceId);
    await this.registerWorkspace(workspaceId, workspacePath);
  }

  async shutdown(): Promise<void> {}
}
