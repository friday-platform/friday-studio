import { logger } from "@atlas/logger";
import {
  type MECMFMemoryManager,
  type MemoryEntry,
  MemoryType,
  type SessionBridgeConfig,
} from "./mecmf-interfaces.ts";

/**
 * SessionBridgeManager handles the promotion of working memory to session bridge
 * and the loading of bridge memories into new sessions for conversational continuity.
 */
export class SessionBridgeManager {
  private config: SessionBridgeConfig;
  private memoryManager: MECMFMemoryManager;

  constructor(memoryManager: MECMFMemoryManager, config?: Partial<SessionBridgeConfig>) {
    this.memoryManager = memoryManager;
    this.config = {
      max_turns: config?.max_turns ?? 10,
      retention_hours: config?.retention_hours ?? 48,
      token_allocation: config?.token_allocation ?? 0.1,
      relevance_threshold: config?.relevance_threshold ?? 0.6,
    };
  }

  /**
   * Promotes the most relevant working memory conversations to bridge memory
   * for use in future sessions.
   */
  async promoteFromWorking(workingMemories: MemoryEntry[]): Promise<void> {
    // Filter for high relevance memories
    const relevantMemories = workingMemories
      .filter((memory) => memory.relevanceScore >= this.config.relevance_threshold)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, this.config.max_turns);

    // Convert to session bridge memories with TTL
    const expirationTime = new Date();
    expirationTime.setHours(expirationTime.getHours() + this.config.retention_hours);

    for (const memory of relevantMemories) {
      const bridgeMemory: MemoryEntry = {
        ...memory,
        id: `bridge_${memory.id}`,
        memoryType: MemoryType.SESSION_BRIDGE,
        tags: [...memory.tags, "session_bridge", `expires_at_${expirationTime.toISOString()}`],
        timestamp: new Date(), // Update timestamp to current time
      };

      await this.memoryManager.storeMemory(bridgeMemory);
    }
  }

  /**
   * Loads unexpired session bridge memories for injection into a new session.
   */
  async loadIntoNewSession(): Promise<MemoryEntry[]> {
    try {
      const bridgeMemories = await this.memoryManager.getRelevantMemories("", {
        memoryTypes: [MemoryType.SESSION_BRIDGE],
        maxResults: this.config.max_turns,
        minRelevanceScore: 0.1, // Lower threshold for bridge memories
      });

      // Filter out expired memories
      const now = new Date();
      const validMemories = bridgeMemories.filter((memory) => {
        const expirationTag = memory.tags.find((tag) => tag.startsWith("expires_at_"));
        if (!expirationTag) return false;

        const expirationTime = new Date(expirationTag.replace("expires_at_", ""));
        return expirationTime > now;
      });

      // Apply decay weighting (newer = higher weight)
      return validMemories.map((memory) => ({
        ...memory,
        relevanceScore: this.calculateDecayedRelevance(memory),
        tags: [
          ...memory.tags.filter((tag) => !tag.startsWith("expires_at_")),
          "loaded_from_bridge",
        ],
      }));
    } catch (error) {
      logger.warn("Failed to load session bridge memories:", { error });
      return [];
    }
  }

  /**
   * Removes expired session bridge memories to prevent storage bloat.
   */
  async pruneExpired(): Promise<void> {
    try {
      const allBridgeMemories = await this.memoryManager.getRelevantMemories("", {
        memoryTypes: [MemoryType.SESSION_BRIDGE],
        maxResults: 1000, // Get all bridge memories for pruning
      });

      const now = new Date();
      const expiredMemories = allBridgeMemories.filter((memory) => {
        const expirationTag = memory.tags.find((tag) => tag.startsWith("expires_at_"));
        if (!expirationTag) return true; // Delete memories without expiration tags

        const expirationTime = new Date(expirationTag.replace("expires_at_", ""));
        return expirationTime <= now;
      });

      for (const expiredMemory of expiredMemories) {
        await this.memoryManager.deleteMemory(expiredMemory.id);
      }

      if (expiredMemories.length > 0) {
        logger.info(`Pruned ${expiredMemories.length} expired session bridge memories`);
      }
    } catch (error) {
      logger.error("Failed to prune expired session bridge memories:", { error });
    }
  }

  /**
   * Calculates decayed relevance score based on memory age.
   * Newer memories maintain higher relevance.
   */
  private calculateDecayedRelevance(memory: MemoryEntry): number {
    const now = new Date();
    const ageHours = (now.getTime() - memory.timestamp.getTime()) / (1000 * 60 * 60);
    const maxAgeHours = this.config.retention_hours;

    // Linear decay: newer memories keep higher scores
    const decayFactor = Math.max(0, (maxAgeHours - ageHours) / maxAgeHours);
    return memory.relevanceScore * (0.5 + 0.5 * decayFactor); // Maintain at least 50% of original relevance
  }

  /**
   * Updates the session bridge configuration.
   */
  updateConfig(newConfig: Partial<SessionBridgeConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Gets current session bridge statistics.
   */
  async getStatistics(): Promise<{
    totalBridgeMemories: number;
    oldestBridgeMemory: Date | null;
    newestBridgeMemory: Date | null;
    averageRelevance: number;
  }> {
    try {
      const bridgeMemories = await this.memoryManager.getRelevantMemories("", {
        memoryTypes: [MemoryType.SESSION_BRIDGE],
        maxResults: 1000,
      });

      if (bridgeMemories.length === 0) {
        return {
          totalBridgeMemories: 0,
          oldestBridgeMemory: null,
          newestBridgeMemory: null,
          averageRelevance: 0,
        };
      }

      const timestamps = bridgeMemories.map((m) => m.timestamp);
      const relevanceScores = bridgeMemories.map((m) => m.relevanceScore);

      return {
        totalBridgeMemories: bridgeMemories.length,
        oldestBridgeMemory: new Date(Math.min(...timestamps.map((t) => t.getTime()))),
        newestBridgeMemory: new Date(Math.max(...timestamps.map((t) => t.getTime()))),
        averageRelevance:
          relevanceScores.reduce((sum, score) => sum + score, 0) / relevanceScores.length,
      };
    } catch (error) {
      logger.error("Failed to get session bridge statistics:", { error });
      return {
        totalBridgeMemories: 0,
        oldestBridgeMemory: null,
        newestBridgeMemory: null,
        averageRelevance: 0,
      };
    }
  }
}
