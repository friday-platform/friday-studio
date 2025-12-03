/**
 * Slack signal registrar
 * Tracks which workspaces have Slack signals configured
 */

import type { MergedConfig, SlackSignalConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import type { WorkspaceSignalRegistrar } from "@atlas/workspace/types";
import type { SlackChannelFilter, SlackEventType } from "./schemas.ts";

// Extract the inner config from the full SlackSignalConfig
type SlackSignalInnerConfig = SlackSignalConfig["config"];

export interface SlackSignalMetadata {
  workspaceId: string;
  signalId: string;
  config: SlackSignalInnerConfig;
}

/**
 * Tracks Slack signal configurations across workspaces
 * Maps signal configurations to workspace IDs for event routing
 */
export class SlackSignalRegistrar implements WorkspaceSignalRegistrar {
  private readonly logger: Logger;
  // Map: workspaceId -> signalId -> config
  private readonly signals = new Map<string, Map<string, SlackSignalInnerConfig>>();

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Register workspace Slack signals
   */
  registerWorkspace(workspaceId: string, _workspacePath: string, config: MergedConfig): void {
    try {
      const signals = config.workspace?.signals;
      if (!signals) {
        return;
      }

      const slackSignals = new Map<string, SlackSignalInnerConfig>();

      for (const [signalId, signalConfig] of Object.entries(signals)) {
        if (signalConfig.provider === "slack") {
          // Config system already validated this via discriminated union
          slackSignals.set(signalId, signalConfig.config);
        }
      }

      if (slackSignals.size > 0) {
        this.signals.set(workspaceId, slackSignals);
        this.logger.info("Registered Slack signals", { workspaceId, count: slackSignals.size });
      }
    } catch (error) {
      this.logger.error("Failed to register Slack signals", { error, workspaceId });
    }
  }

  /**
   * Unregister workspace Slack signals
   */
  unregisterWorkspace(workspaceId: string): void {
    this.signals.delete(workspaceId);
  }

  /**
   * Shutdown registrar (no cleanup needed for Socket Mode signals)
   */
  shutdown(): Promise<void> {
    this.signals.clear();
    return Promise.resolve();
  }

  /**
   * Find all matching signals for an event
   * Returns array of {workspaceId, signalId, config}
   */
  findMatchingSignals(
    eventType: SlackEventType,
    channelType: SlackChannelFilter,
    isBot: boolean,
  ): SlackSignalMetadata[] {
    const matches: SlackSignalMetadata[] = [];

    for (const [workspaceId, workspaceSignals] of this.signals.entries()) {
      for (const [signalId, config] of workspaceSignals.entries()) {
        // Check if event type matches
        if (!config.events.includes(eventType)) {
          continue;
        }

        // Check if channel type matches
        const channelMatches =
          config.channels.includes("all") || config.channels.includes(channelType);

        if (!channelMatches) {
          continue;
        }

        // Check bot message filter
        if (isBot && config.ignoreBotMessages) {
          continue;
        }

        matches.push({ workspaceId, signalId, config });
      }
    }

    return matches;
  }
}
