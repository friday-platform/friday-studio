/**
 * Supervisor Memory Coordinator
 *
 * Integrates CoALA memory systems with Atlas supervisor architecture
 * Provides memory coordination between WorkspaceSupervisor and SessionSupervisor
 */

import type { IAtlasScope } from "../../../src/types/core.ts";
import { type CoALAMemoryEntry, CoALAMemoryManager, type CoALAMemoryType } from "./coala-memory.ts";

export class SupervisorMemoryCoordinator {
  private workspaceMemory: CoALAMemoryManager;
  private sessionMemories: Map<string, CoALAMemoryManager> = new Map();

  constructor(workspace: IAtlasScope) {
    this.workspaceMemory = new CoALAMemoryManager(workspace, undefined, true);
  }

  /**
   * Consolidate working memories for a session
   * Promotes important working memories to long-term storage
   */
  consolidateWorkingMemories(
    sessionId: string,
    options: { minAccessCount?: number; minRelevance?: number; markImportant?: boolean } = {},
  ): void {
    const { minAccessCount = 3, minRelevance = 0.8, markImportant = false } = options;

    // Get session memory manager
    const sessionMemory = this.sessionMemories.get(sessionId) || this.workspaceMemory;

    // Query working memories for this session
    const workingMemories = sessionMemory.queryMemories({
      memoryType: "working",
      sourceScope: sessionId,
      minRelevance,
    });

    // Filter for consolidation candidates
    const toConsolidate = workingMemories.filter(
      (memory) =>
        memory.accessCount >= minAccessCount ||
        memory.relevanceScore >= minRelevance ||
        (markImportant && memory.tags.includes("important")),
    );

    // Promote each qualified memory
    for (const memory of toConsolidate) {
      // Determine target memory type based on content
      const newType = this.determinePromotionType(memory);

      // Update memory type and boost relevance
      memory.memoryType = newType;
      memory.relevanceScore = Math.min(1.0, memory.relevanceScore * 1.2);
      memory.tags.push("consolidated", `from-session-${sessionId}`);

      // Store in workspace memory for cross-session access
      this.workspaceMemory.rememberWithMetadata(memory.id, memory.content, {
        memoryType: newType,
        tags: memory.tags,
        relevanceScore: memory.relevanceScore,
        confidence: memory.confidence,
        associations: memory.associations,
      });
    }
  }

  /**
   * Clear working memory for a specific session
   */
  clearWorkingMemoryBySession(sessionId: string): number {
    // Get session memory manager
    const sessionMemory = this.sessionMemories.get(sessionId);

    if (sessionMemory) {
      // Clear working memory in session-specific manager
      const clearedCount = sessionMemory.clearWorkingBySession(sessionId);

      // Also clear from workspace memory if any were stored there
      this.workspaceMemory.clearWorkingBySession(sessionId);

      // Remove session memory manager if no longer needed
      this.sessionMemories.delete(sessionId);

      return clearedCount;
    } else {
      // Clear from workspace memory directly
      return this.workspaceMemory.clearWorkingBySession(sessionId);
    }
  }

  /**
   * Determine the appropriate memory type for promotion
   */
  private determinePromotionType(memory: CoALAMemoryEntry): CoALAMemoryType {
    const content = JSON.stringify(memory.content).toLowerCase();

    // Check for procedural patterns
    if (
      content.includes("step") ||
      content.includes("process") ||
      content.includes("workflow") ||
      memory.tags.includes("tool")
    ) {
      return "procedural";
    }

    // Check for episodic patterns
    if (
      content.includes("success") ||
      content.includes("failure") ||
      content.includes("result") ||
      memory.tags.includes("agent")
    ) {
      return "episodic";
    }

    // Default to semantic for factual content
    return "semantic";
  }
}
