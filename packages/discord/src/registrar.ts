/**
 * Tracks which workspaces have Discord signals configured.
 */

import type { DiscordSignalConfig, MergedConfig } from "@atlas/config";
import { logger } from "@atlas/logger";
import type { WorkspaceSignalRegistrar } from "@atlas/workspace/types";

/**
 * Event match criteria for routing Gateway events to signals
 */
export interface EventMatchCriteria {
  eventType: "message_create" | "message_update";
  isDM: boolean;
  isMention: boolean;
  guildId: string | null;
}

/**
 * Signal match result
 */
export interface SignalMatch {
  workspaceId: string;
  signalId: string;
}

/**
 * Tracks workspace Discord signals and matches Gateway events to signal configurations.
 */
export class DiscordSignalRegistrar implements WorkspaceSignalRegistrar {
  // Track event configurations: workspaceId -> signalId -> config
  private eventConfigs = new Map<string, Map<string, DiscordSignalConfig>>();

  /**
   * Register workspace Discord signals
   *
   * Called by WorkspaceManager when a workspace is registered.
   * Extracts and tracks all Discord signals from config.
   */
  registerWorkspace(
    workspaceId: string,
    workspacePath: string,
    config: MergedConfig,
  ): Promise<void> {
    try {
      const signals = config.workspace?.signals;

      if (!signals) {
        return Promise.resolve();
      }

      const configs = new Map<string, DiscordSignalConfig>();

      // Extract Discord signals from config
      for (const signalId of Object.keys(signals)) {
        const signalConfig = signals[signalId];

        if (signalConfig && signalConfig.provider === "discord") {
          // TypeScript narrows discriminated union after provider check
          configs.set(signalId, signalConfig);
        }
      }

      // Store if we found any Discord signals
      if (configs.size > 0) {
        this.eventConfigs.set(workspaceId, configs);

        logger.info("Registered Discord signals", {
          workspaceId,
          signalCount: configs.size,
          signals: Array.from(configs.keys()),
        });
      } else {
        // Clean up if no Discord signals
        this.eventConfigs.delete(workspaceId);
      }
    } catch (error) {
      logger.error("Failed to register workspace Discord signals", {
        error,
        workspaceId,
        workspacePath,
      });
      // Don't throw - registration failures shouldn't block workspace loading
    }
    return Promise.resolve();
  }

  /**
   * Unregister workspace Discord signals
   *
   * Called by WorkspaceManager when a workspace is unregistered.
   * Removes all tracking data for the workspace.
   */
  unregisterWorkspace(workspaceId: string): void {
    const hadSignals = this.eventConfigs.has(workspaceId);

    this.eventConfigs.delete(workspaceId);

    if (hadSignals) {
      logger.info("Unregistered Discord signals", { workspaceId });
    }
  }

  /**
   * Cleanup on daemon shutdown
   */
  shutdown(): Promise<void> {
    const workspaceCount = this.eventConfigs.size;

    this.eventConfigs.clear();

    if (workspaceCount > 0) {
      logger.info("Discord signal registrar shutdown", { clearedWorkspaces: workspaceCount });
    }
    return Promise.resolve();
  }

  /**
   * Get signals for a specific workspace
   *
   * @param workspaceId - Workspace ID
   * @returns Array of signal IDs, or empty array if workspace not found
   */
  getWorkspaceSignals(workspaceId: string): string[] {
    const configs = this.eventConfigs.get(workspaceId);
    return configs ? Array.from(configs.keys()) : [];
  }

  /**
   * Get total count of workspaces with Discord signals
   */
  getWorkspaceCount(): number {
    return this.eventConfigs.size;
  }

  /**
   * Get total count of Discord signals across all workspaces
   */
  getTotalSignalCount(): number {
    let total = 0;
    for (const configs of this.eventConfigs.values()) {
      total += configs.size;
    }
    return total;
  }

  /**
   * Get matching signals for Gateway event
   *
   * @param criteria - Event match criteria (event type, channel type, guild)
   * @returns Array of matching signal information
   */
  getMatchingSignals(criteria: EventMatchCriteria): SignalMatch[] {
    const matches: SignalMatch[] = [];

    for (const [workspaceId, configs] of this.eventConfigs.entries()) {
      for (const [signalId, signalConfig] of configs.entries()) {
        if (this.eventMatches(criteria, signalConfig.config)) {
          matches.push({ workspaceId, signalId });
        }
      }
    }

    return matches;
  }

  /**
   * Check if event matches signal configuration
   *
   * @param criteria - Event criteria to match
   * @param config - Signal configuration
   * @returns true if event matches signal configuration
   */
  private eventMatches(
    criteria: EventMatchCriteria,
    config: DiscordSignalConfig["config"],
  ): boolean {
    // Check event type
    if (!config.events.includes(criteria.eventType)) {
      return false;
    }

    // Check guild restrictions (only applies to guild events, not DMs)
    if (config.allowedGuilds && config.allowedGuilds.length > 0 && criteria.guildId !== null) {
      if (!config.allowedGuilds.includes(criteria.guildId)) {
        return false;
      }
    }

    // Check channel filtering
    const channels = config.channels;

    // If "all" is specified, match everything
    if (channels.includes("all")) {
      return true;
    }

    // Check DM filter
    if (channels.includes("dm") && criteria.isDM) {
      return true;
    }

    // Check mention filter
    if (channels.includes("mention") && criteria.isMention) {
      return true;
    }

    // Check guild filter (non-DM messages)
    if (channels.includes("guild") && !criteria.isDM) {
      return true;
    }

    return false;
  }
}
