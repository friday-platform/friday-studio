/**
 * Workspace Memory Integration
 *
 * Provides integration between the Enhanced Memory Manager and Atlas workspace runtime.
 * Handles session lifecycle events and memory management for conversational workspaces.
 */

import { logger } from "@atlas/logger";
import {
  createEnhancedMemoryManager,
  type EnhancedMemoryManager,
} from "./enhanced-memory-manager.ts";
import type {
  MECMFEmbeddingProvider,
  MECMFMemoryManager,
  MemoryConfiguration,
} from "./mecmf-interfaces.ts";

interface WorkspaceMemoryConfig {
  enabled?: boolean;
  sessionBridge?: {
    enabled?: boolean;
    maxTurns?: number;
    retentionHours?: number;
    tokenAllocation?: number;
    relevanceThreshold?: number;
  };
  worklog?: {
    enabled?: boolean;
    autoDetect?: boolean;
    confidenceThreshold?: number;
    maxEntriesPerSession?: number;
    retentionDays?: number;
  };
}

/**
 * Memory manager instance for workspace integration
 */
export class WorkspaceMemoryManager {
  private enhancedMemoryManager?: EnhancedMemoryManager;
  private config: MemoryConfiguration;

  constructor(config?: WorkspaceMemoryConfig) {
    this.config = this.normalizeConfig(config);
  }

  /**
   * Initialize the enhanced memory manager with base dependencies
   */
  async initialize(
    baseMemoryManager: MECMFMemoryManager,
    embeddingProvider: MECMFEmbeddingProvider,
  ): Promise<void> {
    try {
      this.enhancedMemoryManager = createEnhancedMemoryManager(
        baseMemoryManager,
        embeddingProvider,
        this.config,
      );

      logger.info("Enhanced memory manager initialized", {
        sessionBridge: this.config.session_bridge.enabled,
        worklog: this.config.worklog.enabled,
      });
    } catch (error) {
      logger.error("Failed to initialize enhanced memory manager", { error });
      throw error;
    }
  }

  /**
   * Handle session start event
   */
  async onSessionStart(sessionId: string): Promise<void> {
    if (!this.enhancedMemoryManager) {
      logger.warn("Enhanced memory manager not initialized, skipping session start");
      return;
    }

    try {
      await this.enhancedMemoryManager.initializeNewSession(sessionId);
      logger.debug("Session memory initialized", { sessionId });
    } catch (error) {
      logger.error("Failed to initialize session memory", { sessionId, error });
    }
  }

  /**
   * Handle session end event
   */
  async onSessionEnd(sessionId: string): Promise<void> {
    if (!this.enhancedMemoryManager) {
      logger.warn("Enhanced memory manager not initialized, skipping session end");
      return;
    }

    try {
      await this.enhancedMemoryManager.finalizeSession(sessionId);
      logger.debug("Session memory finalized", { sessionId });
    } catch (error) {
      logger.error("Failed to finalize session memory", { sessionId, error });
    }
  }

  /**
   * Get the enhanced memory manager instance
   */
  getMemoryManager(): EnhancedMemoryManager | undefined {
    return this.enhancedMemoryManager;
  }

  /**
   * Update memory configuration
   */
  updateConfig(config: WorkspaceMemoryConfig): void {
    this.config = this.normalizeConfig(config);
    if (this.enhancedMemoryManager) {
      this.enhancedMemoryManager.updateConfiguration(this.config);
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): MemoryConfiguration {
    return this.config;
  }

  /**
   * Perform health check
   */
  async healthCheck(): Promise<{ status: "healthy" | "degraded" | "failed"; details?: unknown }> {
    if (!this.enhancedMemoryManager) {
      return { status: "failed", details: { reason: "Not initialized" } };
    }

    try {
      const health = await this.enhancedMemoryManager.healthCheck();
      return { status: health.overall, details: health };
    } catch (error) {
      return {
        status: "failed",
        details: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  /**
   * Normalize workspace memory config to full MemoryConfiguration
   */
  private normalizeConfig(config?: WorkspaceMemoryConfig): MemoryConfiguration {
    const defaultConfig: MemoryConfiguration = {
      session_bridge: {
        enabled: true,
        max_turns: 10,
        retention_hours: 48,
        token_allocation: 0.1,
        relevance_threshold: 0.6,
      },
      worklog: {
        enabled: true,
        auto_detect: true,
        confidence_threshold: 0.7,
        max_entries_per_session: 20,
        retention_days: 90,
      },
      token_management: {
        bridge_allocation: 0.1,
        worklog_allocation: 0.05,
        compression_threshold: 0.8,
      },
    };

    if (!config) return defaultConfig;

    return {
      session_bridge: {
        enabled: config.sessionBridge?.enabled ?? defaultConfig.session_bridge.enabled,
        max_turns: config.sessionBridge?.maxTurns ?? defaultConfig.session_bridge.max_turns,
        retention_hours:
          config.sessionBridge?.retentionHours ?? defaultConfig.session_bridge.retention_hours,
        token_allocation:
          config.sessionBridge?.tokenAllocation ?? defaultConfig.session_bridge.token_allocation,
        relevance_threshold:
          config.sessionBridge?.relevanceThreshold ??
          defaultConfig.session_bridge.relevance_threshold,
      },
      worklog: {
        enabled: config.worklog?.enabled ?? defaultConfig.worklog.enabled,
        auto_detect: config.worklog?.autoDetect ?? defaultConfig.worklog.auto_detect,
        confidence_threshold:
          config.worklog?.confidenceThreshold ?? defaultConfig.worklog.confidence_threshold,
        max_entries_per_session:
          config.worklog?.maxEntriesPerSession ?? defaultConfig.worklog.max_entries_per_session,
        retention_days: config.worklog?.retentionDays ?? defaultConfig.worklog.retention_days,
      },
      token_management: defaultConfig.token_management,
    };
  }
}

/**
 * Session lifecycle hooks for memory management
 */
export interface SessionMemoryHooks {
  onStart: (sessionId: string) => Promise<void>;
  onEnd: (sessionId: string) => Promise<void>;
}

/**
 * Create session memory hooks
 */
export function createSessionMemoryHooks(
  memoryManager: WorkspaceMemoryManager,
): SessionMemoryHooks {
  return {
    onStart: async (sessionId: string) => {
      await memoryManager.onSessionStart(sessionId);
    },
    onEnd: async (sessionId: string) => {
      await memoryManager.onSessionEnd(sessionId);
    },
  };
}
