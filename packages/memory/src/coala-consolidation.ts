/**
 * CoALA Memory Consolidation Interfaces
 *
 * Provides cross-scope memory consolidation and hierarchical memory management
 * for WorkspaceSupervisor and SessionSupervisor integration
 */

import type { IAtlasScope } from "../../../src/types/core.ts";
import type {
  CoALAMemoryEntry,
  CoALAMemoryManager,
  CoALAMemoryQuery,
  CoALAMemoryType,
  IMemoryScope,
} from "./coala-memory.ts";

export interface MemoryConsolidationStrategy {
  shouldConsolidate(memory: CoALAMemoryEntry): boolean;
  getConsolidationTarget(memory: CoALAMemoryEntry): CoALAMemoryType;
  calculateConsolidatedRelevance(memory: CoALAMemoryEntry): number;
}

export interface CrossScopeMemorySync {
  syncUp(childScope: IAtlasScope, memories: CoALAMemoryEntry[]): void;
  syncDown(parentScope: IAtlasScope, query: CoALAMemoryQuery): CoALAMemoryEntry[];
  filterForScope(memories: CoALAMemoryEntry[], targetScope: IAtlasScope): CoALAMemoryEntry[];
}

export class WorkspaceMemoryConsolidator
  implements MemoryConsolidationStrategy, CrossScopeMemorySync
{
  private workspaceMemory: CoALAMemoryManager;
  private sessionMemories: Map<string, CoALAMemoryManager> = new Map();

  constructor(workspaceMemory: CoALAMemoryManager) {
    this.workspaceMemory = workspaceMemory;
  }

  // Memory Consolidation Strategy
  shouldConsolidate(memory: CoALAMemoryEntry): boolean {
    // Consolidate memories that are:
    // 1. Frequently accessed (>5 times)
    // 2. High relevance (>0.7)
    // 3. Cross-session relevant (tagged as 'workspace-relevant')
    return (
      memory.accessCount > 5 ||
      memory.relevanceScore > 0.7 ||
      memory.tags.includes("workspace-relevant")
    );
  }

  getConsolidationTarget(memory: CoALAMemoryEntry): CoALAMemoryType {
    // Determine appropriate long-term memory type
    if (memory.tags.includes("pattern") || memory.tags.includes("workflow")) {
      return "procedural";
    }
    if (memory.tags.includes("knowledge") || memory.tags.includes("fact")) {
      return "semantic";
    }
    if (memory.memoryType === "working") {
      return "episodic";
    }
    return memory.memoryType; // Keep existing type
  }

  calculateConsolidatedRelevance(memory: CoALAMemoryEntry): number {
    // Boost relevance for consolidated memories
    const consolidationBonus = this.shouldConsolidate(memory) ? 0.2 : 0;
    const crossSessionBonus = memory.tags.includes("cross-session") ? 0.1 : 0;

    return Math.min(1.0, memory.relevanceScore + consolidationBonus + crossSessionBonus);
  }

  // Cross-Scope Memory Sync
  syncUp(childScope: IMemoryScope, memories: CoALAMemoryEntry[]): void {
    // Consolidate session memories up to workspace level
    const consolidationCandidates = memories.filter((memory) => this.shouldConsolidate(memory));

    for (const memory of consolidationCandidates) {
      const consolidatedMemory = {
        ...memory,
        id: `workspace-${memory.id}`,
        memoryType: this.getConsolidationTarget(memory),
        relevanceScore: this.calculateConsolidatedRelevance(memory),
        sourceScope: childScope.id,
        tags: [...memory.tags, "consolidated", `from-${childScope.id}`],
      };

      this.workspaceMemory.rememberWithMetadata(consolidatedMemory.id, consolidatedMemory.content, {
        memoryType: consolidatedMemory.memoryType,
        tags: consolidatedMemory.tags,
        relevanceScore: consolidatedMemory.relevanceScore,
        associations: consolidatedMemory.associations,
        confidence: consolidatedMemory.confidence,
        decayRate: consolidatedMemory.decayRate,
      });
    }
  }

  syncDown(parentScope: IAtlasScope, query: CoALAMemoryQuery): CoALAMemoryEntry[] {
    // Provide relevant workspace memories to session
    const workspaceMemories = this.workspaceMemory.queryMemories({
      ...query,
      memoryType: "semantic", // Prefer semantic knowledge for sessions
      minRelevance: 0.5,
    });

    return this.filterForScope(workspaceMemories, parentScope);
  }

  filterForScope(memories: CoALAMemoryEntry[], targetScope: IAtlasScope): CoALAMemoryEntry[] {
    // Filter memories appropriate for the target scope
    return memories.filter((memory) => {
      // Don't share memories that are too context-specific
      if (memory.memoryType === "contextual") {
        return false;
      }

      // Share general knowledge and procedures
      if (memory.memoryType === "semantic" || memory.memoryType === "procedural") {
        return true;
      }

      // Share episodic memories if they're tagged as shareable
      return memory.tags.includes("shareable") || memory.tags.includes(`shared:${targetScope.id}`);
    });
  }

  // Session memory management
  registerSessionMemory(sessionId: string, memory: CoALAMemoryManager): void {
    this.sessionMemories.set(sessionId, memory);
  }

  unregisterSessionMemory(sessionId: string): void {
    const sessionMemory = this.sessionMemories.get(sessionId);
    if (sessionMemory) {
      // Consolidate important memories before cleanup
      const importantMemories = sessionMemory.queryMemories({ minRelevance: 0.6 });

      if (importantMemories.length > 0) {
        this.syncUp({ id: sessionId }, importantMemories);
      }

      this.sessionMemories.delete(sessionId);
    }
  }
}
