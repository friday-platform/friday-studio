/**
 * Supervisor Memory Coordinator
 *
 * Integrates CoALA memory systems with Atlas supervisor architecture
 * Provides memory coordination between WorkspaceSupervisor and SessionSupervisor
 */

import type { IAtlasScope, IWorkspaceSignal } from "../../../src/types/core.ts";
import { extractSearchTerms } from "../../../src/utils/prompt-tokenizer.ts";
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

  // WorkspaceSupervisor Memory Operations
  async analyzeSignalWithMemory(
    signal: IWorkspaceSignal,
  ): Promise<{
    relevantMemories: CoALAMemoryEntry[];
    analysisContext: string;
    suggestedAgents: string[];
  }> {
    // Extract searchable content from signal
    const signalContent = extractSearchTerms(signal);

    // Use enhanced memory retrieval with vector search for better relevance
    const memoryResults = await this.workspaceMemory.getRelevantMemoriesForPrompt(signalContent, {
      includeWorking: false, // Don't include working memory for signal analysis
      includeEpisodic: true, // Include past experiences
      includeSemantic: true, // Include knowledge and concepts
      includeProcedural: true, // Include workflows and patterns
      limit: 15,
      minSimilarity: 0.3,
      tags: undefined, // Search all tags
    });

    // Separate memories by type for targeted analysis
    const semanticMemories = memoryResults.memories.filter((m) => m.memoryType === "semantic");
    const proceduralMemories = memoryResults.memories.filter((m) => m.memoryType === "procedural");
    const episodicMemories = memoryResults.memories.filter((m) => m.memoryType === "episodic");

    // Prioritize procedural memories for workflow patterns
    const prioritizedMemories = [
      ...proceduralMemories.slice(0, 5), // Top procedural memories first
      ...semanticMemories.slice(0, 5), // Then semantic knowledge
      ...episodicMemories.slice(0, 5), // Finally past experiences
    ];

    // Extract agent suggestions from memory patterns
    const suggestedAgents = this.extractAgentSuggestions(prioritizedMemories);

    // Create analysis context
    const analysisContext = this.createAnalysisContext(prioritizedMemories, signal);

    // Remember this signal analysis for future reference
    this.workspaceMemory.rememberWithMetadata(
      `signal-analysis-${signal.id || Date.now()}`,
      {
        signal: signalContent,
        relevantMemories: JSON.stringify(prioritizedMemories.map((m) => m.id)),
        suggestedAgents: JSON.stringify(suggestedAgents),
        analysisResult: analysisContext,
        vectorSearchUsed: "true",
        searchTerms: JSON.stringify(memoryResults.processedPrompt.tokens),
      },
      {
        memoryType: "episodic",
        tags: ["signal-analysis", "workspace-decision", "vector-enhanced"],
        relevanceScore: 0.7, // Higher relevance since using vector search
      },
    );

    return { relevantMemories: prioritizedMemories, analysisContext, suggestedAgents };
  }

  // Private helper methods
  private extractAgentSuggestions(memories: CoALAMemoryEntry[]): string[] {
    const agentMentions = new Map<string, number>();

    for (const memory of memories) {
      if (memory.tags.includes("agent-result")) {
        const agentTag = memory.tags.find((tag: string) => tag.startsWith("agent-"));
        if (agentTag) {
          const agentId = agentTag.replace("agent-", "");
          agentMentions.set(agentId, (agentMentions.get(agentId) || 0) + 1);
        }
      }
    }

    return Array.from(agentMentions.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([agentId, _]) => agentId);
  }

  private createAnalysisContext(memories: CoALAMemoryEntry[], _signal: IWorkspaceSignal): string {
    const patterns = memories
      .filter((m) => m.tags.includes("pattern"))
      .map((m) => m.content)
      .slice(0, 3);

    return (
      `Signal analysis based on ${memories.length} relevant memories. ` +
      `Identified patterns: ${
        patterns.length > 0
          ? patterns.map((p) => (typeof p === "string" ? p : p.type)).join(", ")
          : "none"
      }`
    );
  }
}
