import { logger } from "@atlas/logger";
import type { WorkspaceManager } from "@atlas/workspace";
import type { WorkspaceSignalTriggerCallback } from "@atlas/workspace/types";
import type { WorkspaceSignalRegistrar } from "./types.ts";
import {
  ProviderRegistry,
  ProviderType,
  type IProvider,
  type ISignalProvider,
} from "@atlas/signals";

export class FsWatchSignalRegistrar implements WorkspaceSignalRegistrar {
  private readonly onWakeup: WorkspaceSignalTriggerCallback;
  private workspaceManager: WorkspaceManager | null = null;
  // Track active runtime signals per workspace:signal
  private activeRuntimes = new Map<string, { teardown: () => void }>();

  constructor(onWakeup: WorkspaceSignalTriggerCallback) {
    this.onWakeup = onWakeup;
  }

  initialize(): Promise<void> {
    // Nothing to initialize for provider-centric registrar
    return Promise.resolve();
  }

  async discoverAndRegisterExisting(workspaceManager: WorkspaceManager): Promise<void> {
    this.workspaceManager = workspaceManager;
    try {
      const workspaces = await workspaceManager.list();
      logger.info("Discovering fs-watch signals for existing workspaces", {
        workspaceCount: workspaces.length,
      });

      let watchersRegistered = 0;
      for (const workspace of workspaces) {
        try {
          const merged = await workspaceManager.getWorkspaceConfig(workspace.id);
          const signals = merged?.workspace?.signals;
          if (!signals) continue;
          for (const signalId of Object.keys(signals)) {
            const signalConfig = signals[signalId];
            if (signalConfig && signalConfig.provider === "fs-watch") {
              const cfg = signalConfig.config;
              await this.registerRuntimeSignal(workspace.id, workspace.path, signalId, {
                path: cfg.path,
                recursive: cfg.recursive !== false,
                include: cfg.include,
                exclude: cfg.exclude,
              });
              watchersRegistered++;
              logger.info("Registered file watcher", {
                workspaceId: workspace.id,
                signalId,
                path: cfg.path,
              });
            }
          }
        } catch (error) {
          logger.warn("Failed to register fs-watch signals for workspace", {
            workspaceId: workspace.id,
            workspacePath: workspace.path,
            error,
          });
        }
      }

      logger.info("fs-watch signal discovery complete", { watchersRegistered });
    } catch (error) {
      logger.error("Failed to discover existing workspace fs-watch signals", { error });
    }
  }

  async registerWorkspace(workspaceId: string, workspacePath: string): Promise<void> {
    try {
      const wm = this.workspaceManager;
      const merged = wm ? await wm.getWorkspaceConfig(workspaceId) : null;
      const signals = merged?.workspace?.signals;
      if (!signals) return;

      for (const signalId of Object.keys(signals)) {
        const signalConfig = signals[signalId];
        if (signalConfig && signalConfig.provider === "fs-watch") {
          const cfg = signalConfig.config;
          await this.registerRuntimeSignal(workspaceId, workspacePath, signalId, {
            path: cfg.path,
            recursive: cfg.recursive !== false,
            include: cfg.include,
            exclude: cfg.exclude,
          });
          logger.info("Registered file watcher", { workspaceId, signalId, path: cfg.path });
        }
      }
    } catch (error) {
      logger.error("Failed to register workspace fs-watch signals", {
        error,
        workspaceId,
        workspacePath,
      });
    }
  }

  unregisterWorkspace(workspaceId: string): Promise<void> {
    // Teardown all runtime signals for this workspace
    const prefix = `${workspaceId}:`;
    for (const key of Array.from(this.activeRuntimes.keys())) {
      if (!key.startsWith(prefix)) continue;
      try {
        this.activeRuntimes.get(key)?.teardown();
      } catch {
        // ignore teardown errors
      }
      this.activeRuntimes.delete(key);
    }
    return Promise.resolve();
  }

  async onWorkspaceConfigChanged(workspaceId: string, workspacePath: string): Promise<void> {
    await this.unregisterWorkspace(workspaceId);
    await this.registerWorkspace(workspaceId, workspacePath);
  }

  shutdown(): Promise<void> {
    // Teardown all active runtime signals
    for (const [key, rt] of this.activeRuntimes.entries()) {
      try {
        rt.teardown();
      } catch {
        // ignore
      }
      this.activeRuntimes.delete(key);
      logger.info("fs-watch runtime signal stopped", { key });
    }
    return Promise.resolve();
  }

  private async registerRuntimeSignal(
    workspaceId: string,
    workspacePath: string,
    signalId: string,
    cfg: { path: string; recursive?: boolean; include?: string[]; exclude?: string[] },
  ): Promise<void> {
    const key = `${workspaceId}:${signalId}`;
    // Teardown existing if present
    const existing = this.activeRuntimes.get(key);
    if (existing) {
      try {
        existing.teardown();
      } catch {
        // ignore
      }
      this.activeRuntimes.delete(key);
    }

    // Create provider via registry
    const registry = ProviderRegistry.getInstance();
    const provider = await registry.loadFromConfig({
      id: signalId,
      type: ProviderType.SIGNAL,
      provider: "fs-watch",
      config: {
        id: signalId,
        description: `File watch signal for ${signalId}`,
        provider: "fs-watch",
        path: cfg.path,
        recursive: cfg.recursive !== false,
        include: cfg.include,
        exclude: cfg.exclude,
      },
    });

    // Narrow to signal provider without unsafe casts
    const isSignalProvider = (p: IProvider): p is ISignalProvider => p.type === ProviderType.SIGNAL;
    if (!isSignalProvider(provider)) {
      throw new Error("Loaded provider is not a signal provider");
    }

    const signal = provider.createSignal({
      id: signalId,
      description: `File watch signal for ${signalId}`,
      provider: "fs-watch",
      path: cfg.path,
      recursive: cfg.recursive !== false,
      include: cfg.include,
      exclude: cfg.exclude,
    });

    const runtimeSignal: {
      initialize: (ctx: {
        id: string;
        processSignal: (id: string, payload: Record<string, unknown>) => Promise<void> | void;
        workspacePath?: string;
      }) => void;
      teardown: () => void;
    } = signal.toRuntimeSignal();

    runtimeSignal.initialize({
      id: signalId,
      processSignal: (id: string, payload: Record<string, unknown>) => {
        return this.onWakeup(workspaceId, id, payload);
      },
      workspacePath,
    });

    this.activeRuntimes.set(key, { teardown: () => runtimeSignal.teardown() });
  }
}
