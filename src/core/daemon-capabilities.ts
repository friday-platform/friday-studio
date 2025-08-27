/**
 * Daemon-level capabilities - global capabilities managed by the daemon
 * These are orthogonal to workspaces and handle daemon-level operations
 */

import { AtlasLogger } from "@atlas/logger";
import type { Tool } from "ai";
import type { AtlasDaemon } from "../../apps/atlasd/src/atlas-daemon.ts";

export interface DaemonCapability {
  id: string;
  name: string;
  description: string;
  category: "streaming" | "system" | "management";
  // Direct AI SDK Tool factory method - follows MCP pattern
  toTool: (context: DaemonExecutionContext) => Tool;
}

export interface DaemonExecutionContext {
  sessionId: string;
  agentId: string;
  workspaceId: string;
  daemon: AtlasDaemon;
  conversationId?: string;
  streams: {
    send: (
      streamId: string,
      event: {
        type: string;
        content: string;
        metadata?: Record<string, unknown>;
        conversationId?: string;
      },
    ) => Promise<void>;
  };
}

export class DaemonCapabilityRegistry {
  private static capabilities = new Map<string, DaemonCapability>();
  private static initialized = false;
  private static daemonInstance: AtlasDaemon | null = null;

  static setDaemonInstance(daemon: AtlasDaemon): void {
    AtlasLogger.getInstance().debug("Setting daemon instance", {
      component: "DaemonCapabilityRegistry",
      hasDaemon: !!daemon,
    });
    DaemonCapabilityRegistry.daemonInstance = daemon;
    AtlasLogger.getInstance().debug("Daemon instance set successfully", {
      component: "DaemonCapabilityRegistry",
      hasDaemonInstance: !!DaemonCapabilityRegistry.daemonInstance,
    });
  }

  static getDaemonInstance(): AtlasDaemon | null {
    AtlasLogger.getInstance().debug("Getting daemon instance", {
      component: "DaemonCapabilityRegistry",
      hasDaemonInstance: !!DaemonCapabilityRegistry.daemonInstance,
    });
    return DaemonCapabilityRegistry.daemonInstance;
  }

  static initialize(): void {
    if (DaemonCapabilityRegistry.initialized) return;

    DaemonCapabilityRegistry.initialized = true;
  }

  static registerCapability(capability: DaemonCapability): void {
    DaemonCapabilityRegistry.capabilities.set(capability.id, capability);
  }

  static getAllCapabilities(): DaemonCapability[] {
    DaemonCapabilityRegistry.initialize();
    return Array.from(DaemonCapabilityRegistry.capabilities.values());
  }

  static getCapability(id: string): DaemonCapability | undefined {
    DaemonCapabilityRegistry.initialize();
    return DaemonCapabilityRegistry.capabilities.get(id);
  }

  static reset(): void {
    DaemonCapabilityRegistry.capabilities.clear();
    DaemonCapabilityRegistry.initialized = false;
  }
}
