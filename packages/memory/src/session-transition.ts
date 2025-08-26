import { logger } from "@atlas/logger";
import { type MECMFMemoryManager, type MemoryEntry, MemoryType } from "./mecmf-interfaces.ts";
import type { SessionBridgeManager } from "./session-bridge-manager.ts";
import type { WorklogManager } from "./worklog/worklog-manager.ts";

/**
 * SessionTransitionHandler manages the transition of memory between sessions,
 * handling promotion to bridge memory and worklog generation.
 */
export class SessionTransitionHandler {
  private memoryManager: MECMFMemoryManager;
  private bridgeManager: SessionBridgeManager;
  private worklogManager?: WorklogManager; // Will be injected when worklog is implemented

  constructor(
    memoryManager: MECMFMemoryManager,
    bridgeManager: SessionBridgeManager,
    worklogManager?: WorklogManager,
  ) {
    this.memoryManager = memoryManager;
    this.bridgeManager = bridgeManager;
    this.worklogManager = worklogManager;
  }

  /**
   * Handles the end of a session by promoting working memory to bridge
   * and generating worklog entries.
   */
  async onSessionEnd(sessionId: string): Promise<void> {
    try {
      logger.info(`Processing session end for session: ${sessionId}`);

      // 1. Get working memories from the ending session
      const workingMemories = await this.getSessionWorkingMemories(sessionId);

      if (workingMemories.length === 0) {
        logger.info(`No working memories found for session ${sessionId}`);
        return;
      }

      // 2. Promote top conversations to SESSION_BRIDGE
      await this.bridgeManager.promoteFromWorking(workingMemories);
      logger.info(`Promoted ${workingMemories.length} working memories to session bridge`);

      // 3. Generate worklog entries (if worklog manager is available)
      if (this.worklogManager) {
        await this.worklogManager.processSessionWorklog(sessionId, workingMemories);
        logger.info(`Generated worklog entries for session ${sessionId}`);
      }

      // 4. Clear working memory for the session
      await this.clearSessionWorkingMemory(sessionId);
      logger.info(`Cleared working memory for session ${sessionId}`);

      // 5. Prune expired bridge memories
      await this.bridgeManager.pruneExpired();
    } catch (error) {
      logger.error(`Failed to process session end for ${sessionId}:`, { error });
      throw new Error(
        `Session transition failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Handles the start of a new session by loading bridge memories
   * and relevant worklog context.
   */
  async onSessionStart(sessionId: string): Promise<void> {
    try {
      logger.info(`Processing session start for session: ${sessionId}`);

      // 1. Load SESSION_BRIDGE memories
      const bridgeMemories = await this.bridgeManager.loadIntoNewSession();

      // 2. Inject bridge memories into working memory with session context
      for (const bridgeMemory of bridgeMemories) {
        const workingMemory: MemoryEntry = {
          ...bridgeMemory,
          id: `working_${sessionId}_${bridgeMemory.id}`,
          memoryType: MemoryType.WORKING,
          sourceMetadata: { ...bridgeMemory.sourceMetadata, sessionId },
          tags: [
            ...bridgeMemory.tags.filter((tag) => tag !== "loaded_from_bridge"),
            "injected_from_bridge",
          ],
          timestamp: new Date(), // Update to current session time
        };

        await this.memoryManager.storeMemory(workingMemory);
      }

      logger.info(`Loaded ${bridgeMemories.length} bridge memories into new session`);

      // 3. Load relevant worklog context (if worklog manager is available)
      if (this.worklogManager) {
        const recentWorklog = await this.worklogManager.getRecentWorklog(7); // Last 7 days
        logger.info(`Loaded ${recentWorklog.length} recent worklog entries for context`);
      }
    } catch (error) {
      logger.error(`Failed to process session start for ${sessionId}:`, { error });
      // Don't throw here - session should still start even if bridge loading fails
      logger.warn("Session started without bridge memory context due to error");
    }
  }

  /**
   * Gets all working memories for a specific session.
   */
  private async getSessionWorkingMemories(sessionId: string): Promise<MemoryEntry[]> {
    try {
      const allWorkingMemories = await this.memoryManager.getRelevantMemories("", {
        memoryTypes: [MemoryType.WORKING],
        maxResults: 1000, // Get all working memories
      });

      // Filter by session ID
      return allWorkingMemories.filter(
        (memory) =>
          memory.sourceMetadata?.sessionId === sessionId ||
          memory.tags.includes(`session_${sessionId}`),
      );
    } catch (error) {
      logger.error(`Failed to get working memories for session ${sessionId}:`, { error });
      return [];
    }
  }

  /**
   * Clears all working memory for a specific session.
   */
  private async clearSessionWorkingMemory(sessionId: string): Promise<void> {
    const sessionMemories = await this.getSessionWorkingMemories(sessionId);

    for (const memory of sessionMemories) {
      try {
        await this.memoryManager.deleteMemory(memory.id);
      } catch (error) {
        logger.error(`Failed to delete memory ${memory.id}:`, { error });
      }
    }
  }

  /**
   * Handles emergency session cleanup when normal transition fails.
   */
  async emergencySessionCleanup(sessionId: string): Promise<void> {
    try {
      logger.warn(`Performing emergency cleanup for session ${sessionId}`);

      // Try to save at least some working memories to bridge
      const workingMemories = await this.getSessionWorkingMemories(sessionId);
      if (workingMemories.length > 0) {
        const topMemories = workingMemories
          .sort((a, b) => b.relevanceScore - a.relevanceScore)
          .slice(0, 3); // Save only top 3 memories

        await this.bridgeManager.promoteFromWorking(topMemories);
        logger.info(`Emergency: saved ${topMemories.length} memories to bridge`);
      }

      // Force clear working memory
      await this.clearSessionWorkingMemory(sessionId);
      logger.info(`Emergency: cleared working memory for session ${sessionId}`);
    } catch (error) {
      logger.error(`Emergency cleanup failed for session ${sessionId}:`, { error });
    }
  }

  /**
   * Gets statistics about session transitions.
   */
  async getTransitionStatistics(): Promise<{
    totalSessionsProcessed: number;
    averageBridgeMemoriesPerSession: number;
    lastSuccessfulTransition: Date | null;
    failedTransitions: number;
  }> {
    // This would typically be stored in persistent storage
    // For now, return basic info from bridge manager
    const bridgeStats = await this.bridgeManager.getStatistics();

    return {
      totalSessionsProcessed: 0, // Would track this in persistent storage
      averageBridgeMemoriesPerSession:
        bridgeStats.totalBridgeMemories > 0 ? bridgeStats.totalBridgeMemories / 1 : 0, // Rough estimate
      lastSuccessfulTransition: bridgeStats.newestBridgeMemory,
      failedTransitions: 0, // Would track this in persistent storage
    };
  }

  /**
   * Sets the worklog manager for integration with worklog functionality.
   */
  setWorklogManager(worklogManager: WorklogManager): void {
    this.worklogManager = worklogManager;
  }

  /**
   * Checks if a session has any working memories that need transition handling.
   */
  async hasWorkingMemories(sessionId: string): Promise<boolean> {
    const workingMemories = await this.getSessionWorkingMemories(sessionId);
    return workingMemories.length > 0;
  }

  /**
   * Manually triggers bridge memory promotion for a session (for testing/debugging).
   */
  async manualPromoteToBridge(sessionId: string): Promise<number> {
    const workingMemories = await this.getSessionWorkingMemories(sessionId);
    await this.bridgeManager.promoteFromWorking(workingMemories);
    return workingMemories.length;
  }
}
