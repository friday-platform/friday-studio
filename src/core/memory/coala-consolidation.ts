/**
 * CoALA Memory Consolidation Interfaces
 *
 * Provides cross-scope memory consolidation and hierarchical memory management
 * for WorkspaceSupervisor and SessionSupervisor integration
 */

import type { IAtlasScope } from "../../types/core.ts";
import {
  CoALAMemoryEntry,
  CoALAMemoryManager,
  CoALAMemoryQuery,
  CoALAMemoryType,
} from "./coala-memory.ts";

export interface MemoryConsolidationStrategy {
  shouldConsolidate(memory: CoALAMemoryEntry): boolean;
  getConsolidationTarget(memory: CoALAMemoryEntry): CoALAMemoryType;
  calculateConsolidatedRelevance(memory: CoALAMemoryEntry): number;
}

export interface CrossScopeMemorySync {
  syncUp(childScope: IAtlasScope, memories: CoALAMemoryEntry[]): Promise<void>;
  syncDown(parentScope: IAtlasScope, query: CoALAMemoryQuery): Promise<CoALAMemoryEntry[]>;
  filterForScope(memories: CoALAMemoryEntry[], targetScope: IAtlasScope): CoALAMemoryEntry[];
}

export class WorkspaceMemoryConsolidator
  implements MemoryConsolidationStrategy, CrossScopeMemorySync {
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
    return memory.accessCount > 5 ||
      memory.relevanceScore > 0.7 ||
      memory.tags.includes("workspace-relevant");
  }

  getConsolidationTarget(memory: CoALAMemoryEntry): CoALAMemoryType {
    // Determine appropriate long-term memory type
    if (memory.tags.includes("pattern") || memory.tags.includes("workflow")) {
      return CoALAMemoryType.PROCEDURAL;
    }
    if (memory.tags.includes("knowledge") || memory.tags.includes("fact")) {
      return CoALAMemoryType.SEMANTIC;
    }
    if (memory.memoryType === CoALAMemoryType.WORKING) {
      return CoALAMemoryType.EPISODIC;
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
  async syncUp(childScope: IAtlasScope, memories: CoALAMemoryEntry[]): Promise<void> {
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

      this.workspaceMemory.rememberWithMetadata(
        consolidatedMemory.id,
        consolidatedMemory.content,
        {
          memoryType: consolidatedMemory.memoryType,
          tags: consolidatedMemory.tags,
          relevanceScore: consolidatedMemory.relevanceScore,
          associations: consolidatedMemory.associations,
          confidence: consolidatedMemory.confidence,
          decayRate: consolidatedMemory.decayRate,
        },
      );
    }
  }

  async syncDown(parentScope: IAtlasScope, query: CoALAMemoryQuery): Promise<CoALAMemoryEntry[]> {
    // Provide relevant workspace memories to session
    const workspaceMemories = this.workspaceMemory.queryMemories({
      ...query,
      memoryType: CoALAMemoryType.SEMANTIC, // Prefer semantic knowledge for sessions
      minRelevance: 0.5,
    });

    return this.filterForScope(workspaceMemories, parentScope);
  }

  filterForScope(memories: CoALAMemoryEntry[], targetScope: IAtlasScope): CoALAMemoryEntry[] {
    // Filter memories appropriate for the target scope
    return memories.filter((memory) => {
      // Don't share memories that are too context-specific
      if (memory.memoryType === CoALAMemoryType.CONTEXTUAL) {
        return false;
      }

      // Share general knowledge and procedures
      if (
        memory.memoryType === CoALAMemoryType.SEMANTIC ||
        memory.memoryType === CoALAMemoryType.PROCEDURAL
      ) {
        return true;
      }

      // Share episodic memories if they're tagged as shareable
      return memory.tags.includes("shareable") ||
        memory.tags.includes(`shared:${targetScope.id}`);
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
      const importantMemories = sessionMemory.queryMemories({
        minRelevance: 0.6,
      });

      if (importantMemories.length > 0) {
        this.syncUp({ id: sessionId } as IAtlasScope, importantMemories);
      }

      this.sessionMemories.delete(sessionId);
    }
  }

  // Cross-session pattern detection
  detectPatterns(): CoALAMemoryEntry[] {
    const allMemories = this.workspaceMemory.queryMemories({});
    const patterns: CoALAMemoryEntry[] = [];

    // Simple pattern detection based on repeated tags and content similarity
    const tagFrequency = new Map<string, number>();

    for (const memory of allMemories) {
      for (const tag of memory.tags) {
        tagFrequency.set(tag, (tagFrequency.get(tag) || 0) + 1);
      }
    }

    // Identify frequently occurring patterns
    const commonTags = Array.from(tagFrequency.entries())
      .filter(([_, count]) => count >= 3)
      .map(([tag, _]) => tag);

    for (const tag of commonTags) {
      const relatedMemories = allMemories.filter((m) => m.tags.includes(tag));

      if (relatedMemories.length >= 3) {
        // Create a pattern memory
        const patternMemory: CoALAMemoryEntry = {
          id: `pattern-${tag}`,
          content: {
            type: "pattern",
            tag: tag,
            instances: relatedMemories.length,
            examples: relatedMemories.slice(0, 3).map((m) => m.id),
          },
          timestamp: new Date(),
          accessCount: 0,
          lastAccessed: new Date(),
          memoryType: CoALAMemoryType.SEMANTIC,
          relevanceScore: Math.min(1.0, relatedMemories.length / 10),
          sourceScope: "workspace-consolidator",
          associations: relatedMemories.map((m) => m.id),
          tags: ["pattern", "auto-generated", tag],
          confidence: 0.8,
          decayRate: 0.05, // Patterns decay slowly
        };

        patterns.push(patternMemory);
      }
    }

    return patterns;
  }

  // Cleanup and maintenance
  async performMaintenance(): Promise<void> {
    // Detect and store new patterns
    const patterns = this.detectPatterns();
    for (const pattern of patterns) {
      if (!this.workspaceMemory.recall(pattern.id)) {
        this.workspaceMemory.rememberWithMetadata(
          pattern.id,
          pattern.content,
          {
            memoryType: pattern.memoryType,
            tags: pattern.tags,
            relevanceScore: pattern.relevanceScore,
            associations: pattern.associations,
            confidence: pattern.confidence,
            decayRate: pattern.decayRate,
          },
        );
      }
    }

    // Trigger memory consolidation and pruning
    await this.workspaceMemory.reflect();
    await this.workspaceMemory.consolidate();
    await this.workspaceMemory.prune();
  }
}
