import type { MergedConfig } from "@atlas/config";
import { logger } from "@atlas/logger";
import { FileWatchSignalProvider, ProviderRegistry, ProviderType } from "@atlas/signals";
import type {
  WorkspaceSignalRegistrar,
  WorkspaceSignalTriggerCallback,
} from "@atlas/workspace/types";

import { z } from "zod";

export class FsWatchSignalRegistrar implements WorkspaceSignalRegistrar {
  private readonly onWakeup: WorkspaceSignalTriggerCallback;
  // Track active runtime signals per workspace:signal
  private activeRuntimes = new Map<string, { teardown: () => void }>();

  constructor(onWakeup: WorkspaceSignalTriggerCallback) {
    this.onWakeup = onWakeup;
  }

  async registerWorkspace(
    workspaceId: string,
    workspacePath: string,
    config: MergedConfig,
  ): Promise<void> {
    try {
      const signals = config.workspace?.signals;
      if (!signals) return;

      for (const signalId of Object.keys(signals)) {
        const signalConfig = signals[signalId];
        if (signalConfig && signalConfig.provider === "fs-watch") {
          const cfg = signalConfig.config;
          await this.registerRuntimeSignal(workspaceId, workspacePath, signalId, {
            path: cfg.path,
            recursive: cfg.recursive !== false,
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
        logger.error("Failed to teardown fs-watch signal", { workspaceId, signalId: key });
      }
      this.activeRuntimes.delete(key);
    }
    return Promise.resolve();
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
    cfg: { path: string; recursive?: boolean },
  ): Promise<void> {
    const parsedPath = z.string().min(1).safeParse(cfg.path);
    if (!parsedPath.success) {
      logger.warn("Skipping fs-watch signal without valid path", { workspaceId, signalId });
      return;
    }

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
        path: parsedPath.data,
        recursive: cfg.recursive !== false,
      },
    });

    // Use class check for clarity and strong typing
    if (!(provider instanceof FileWatchSignalProvider)) {
      throw new Error("Loaded provider is not a fs-watch signal provider");
    }

    const signal = provider.createSignal({
      id: signalId,
      description: `File watch signal for ${signalId}`,
      provider: "fs-watch",
      path: parsedPath.data,
      recursive: cfg.recursive !== false,
    });

    // TODO: @Sara cleanup: clean typing on signals. Here we should fs watcher signals which implement IWorkspaceSignal interface
    const runtime = signal.toRuntimeSignal() as {
      initialize: (ctx: {
        id: string;
        processSignal: (id: string, payload: Record<string, unknown>) => Promise<void> | void;
        workspacePath?: string;
      }) => void;
      teardown: () => void;
    };

    try {
      runtime.initialize({
        id: signalId,
        processSignal: (id: string, payload: Record<string, unknown>) => {
          return this.onWakeup(workspaceId, id, payload);
        },
        workspacePath,
      });

      this.activeRuntimes.set(key, { teardown: () => runtime.teardown() });
    } catch (error) {
      // Handle invalid/non-existent watch paths gracefully
      logger.warn("Failed to initialize fs-watch runtime signal", {
        workspaceId,
        signalId,
        path: cfg.path,
        error,
      });
    }
  }
}
