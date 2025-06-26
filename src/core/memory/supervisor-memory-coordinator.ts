/**
 * Supervisor Memory Coordinator
 *
 * Integrates CoALA memory systems with Atlas supervisor architecture
 * Provides memory coordination between WorkspaceSupervisor and SessionSupervisor
 */

import type { IAtlasScope, IWorkspaceSession, IWorkspaceSignal } from "../../types/core.ts";
import { CoALAMemoryManager, CoALAMemoryType } from "./coala-memory.ts";
import { CoALALocalFileStorageAdapter } from "../../storage/coala-local.ts";
import { extractSearchTerms } from "../../utils/prompt-tokenizer.ts";
import { WorkspaceMemoryConsolidator } from "./coala-consolidation.ts";

export interface SupervisorMemoryContext {
  workspaceMemory: CoALAMemoryManager;
  sessionMemories: Map<string, CoALAMemoryManager>;
  consolidator: WorkspaceMemoryConsolidator;
}

export interface MemoryFilteringPolicy {
  filterForSession(
    workspaceMemories: any[],
    sessionContext: IWorkspaceSession,
  ): any[];
  filterForAgent(
    sessionMemories: any[],
    agentId: string,
  ): any[];
}

export class SupervisorMemoryCoordinator {
  private workspaceMemory: CoALAMemoryManager;
  private sessionMemories: Map<string, CoALAMemoryManager> = new Map();
  private consolidator: WorkspaceMemoryConsolidator;
  private filteringPolicy: MemoryFilteringPolicy;

  constructor(
    workspace: IAtlasScope,
    filteringPolicy?: MemoryFilteringPolicy,
  ) {
    // Create workspace memory manager with proper storage adapter
    let storageAdapter;

    try {
      // Try to determine workspace storage path
      const workspacePath = this.getWorkspaceStoragePath(workspace);
      storageAdapter = new CoALALocalFileStorageAdapter(workspacePath);
    } catch (error) {
      console.warn("Failed to create workspace storage adapter, using default:", error);
      storageAdapter = undefined;
    }

    this.workspaceMemory = new CoALAMemoryManager(workspace, storageAdapter);
    this.consolidator = new WorkspaceMemoryConsolidator(this.workspaceMemory);
    this.filteringPolicy = filteringPolicy || new DefaultMemoryFilteringPolicy();
  }

  // WorkspaceSupervisor Memory Operations
  async analyzeSignalWithMemory(signal: IWorkspaceSignal): Promise<{
    relevantMemories: any[];
    analysisContext: string;
    suggestedAgents: string[];
  }> {
    // Extract searchable content from signal
    const signalContent = extractSearchTerms(signal);

    // Use enhanced memory retrieval with vector search for better relevance
    const memoryResults = await this.workspaceMemory.getRelevantMemoriesForPrompt(
      signalContent,
      {
        includeWorking: false, // Don't include working memory for signal analysis
        includeEpisodic: true, // Include past experiences
        includeSemantic: true, // Include knowledge and concepts
        includeProcedural: true, // Include workflows and patterns
        limit: 15,
        minSimilarity: 0.3,
        tags: undefined, // Search all tags
      },
    );

    // Separate memories by type for targeted analysis
    const semanticMemories = memoryResults.memories.filter((m) =>
      m.memoryType === CoALAMemoryType.SEMANTIC
    );
    const proceduralMemories = memoryResults.memories.filter((m) =>
      m.memoryType === CoALAMemoryType.PROCEDURAL
    );
    const episodicMemories = memoryResults.memories.filter((m) =>
      m.memoryType === CoALAMemoryType.EPISODIC
    );

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
        relevantMemories: prioritizedMemories.map((m) => m.id),
        suggestedAgents,
        analysisResult: analysisContext,
        vectorSearchUsed: true,
        searchTerms: memoryResults.processedPrompt.tokens,
      },
      {
        memoryType: CoALAMemoryType.EPISODIC,
        tags: ["signal-analysis", "workspace-decision", "vector-enhanced"],
        relevanceScore: 0.7, // Higher relevance since using vector search
      },
    );

    return {
      relevantMemories: prioritizedMemories,
      analysisContext,
      suggestedAgents,
    };
  }

  createSessionMemoryContext(
    sessionId: string,
    session: IWorkspaceSession,
    workspaceAnalysis: any,
  ): CoALAMemoryManager {
    // Create isolated session memory
    const sessionMemory = new CoALAMemoryManager(
      session,
      undefined, // Use default storage
      false, // Disable cognitive loop for sessions (managed by workspace)
    );

    // Filter and provide relevant workspace memories to session
    const relevantWorkspaceMemories = this.filteringPolicy.filterForSession(
      workspaceAnalysis.relevantMemories,
      session,
    );

    // Seed session memory with filtered workspace context
    for (const memory of relevantWorkspaceMemories) {
      sessionMemory.rememberWithMetadata(
        `inherited-${memory.id}`,
        memory.content,
        {
          memoryType: CoALAMemoryType.CONTEXTUAL,
          tags: [...memory.tags, "inherited", "workspace-context"],
          relevanceScore: memory.relevanceScore * 0.8, // Slight reduction for inherited memories
          associations: memory.associations,
        },
      );
    }

    // Remember session creation context
    sessionMemory.rememberWithMetadata(
      "session-context",
      {
        sessionId,
        workspaceAnalysis: workspaceAnalysis.analysisContext,
        suggestedAgents: workspaceAnalysis.suggestedAgents,
        inheritedMemoryCount: relevantWorkspaceMemories.length,
      },
      {
        memoryType: CoALAMemoryType.CONTEXTUAL,
        tags: ["session-meta", "context"],
        relevanceScore: 1.0,
      },
    );

    // Register with consolidator
    this.sessionMemories.set(sessionId, sessionMemory);
    this.consolidator.registerSessionMemory(sessionId, sessionMemory);

    return sessionMemory;
  }

  // SessionSupervisor Memory Operations
  async createExecutionPlanWithMemory(
    sessionMemory: CoALAMemoryManager,
    sessionContext: any,
  ): Promise<{
    executionPlan: any;
    memoryGuidance: string[];
    agentMemoryContexts: Map<string, any>;
  }> {
    // Extract planning context from session
    const planningContext = extractSearchTerms(sessionContext);

    // Query session memories for execution planning using vector search
    const memoryResults = await sessionMemory.getRelevantMemoriesForPrompt(
      planningContext,
      {
        includeWorking: true, // Include working memory for current session state
        includeEpisodic: true, // Include past experiences
        includeSemantic: false, // Skip semantic for execution planning (focus on concrete)
        includeProcedural: true, // Include workflows and strategies
        limit: 12,
        minSimilarity: 0.3,
        tags: undefined, // Search all tags
      },
    );

    // Separate by memory source and type for targeted processing
    const contextualMemories = memoryResults.memories.filter((m) =>
      m.memoryType === CoALAMemoryType.CONTEXTUAL
    );
    const workingMemories = memoryResults.memories.filter((m) =>
      m.memoryType === CoALAMemoryType.WORKING
    );
    const proceduralMemories = memoryResults.memories.filter((m) =>
      m.memoryType === CoALAMemoryType.PROCEDURAL
    );
    const episodicMemories = memoryResults.memories.filter((m) =>
      m.memoryType === CoALAMemoryType.EPISODIC
    );

    // Combine all relevant memories, prioritizing current context
    const allRelevantMemories = [
      ...workingMemories, // Current session state first
      ...proceduralMemories, // Then applicable workflows
      ...contextualMemories, // Then inherited context
      ...episodicMemories, // Finally past experiences
    ];

    // Create execution plan based on memory guidance
    const memoryGuidance = this.extractExecutionGuidance(allRelevantMemories);

    // Create agent-specific memory contexts
    const agentMemoryContexts = new Map<string, any>();
    const suggestedAgents = sessionContext.suggestedAgents || [];

    for (const agentId of suggestedAgents) {
      const agentMemories = this.filteringPolicy.filterForAgent(
        allRelevantMemories,
        agentId,
      );

      agentMemoryContexts.set(agentId, {
        relevantMemories: agentMemories,
        guidance: this.createAgentGuidance(agentMemories, agentId),
        vectorSearchUsed: true,
        searchTerms: memoryResults.processedPrompt.tokens,
      });
    }

    // Create and remember execution plan
    const executionPlan = {
      steps: memoryGuidance.map((guidance, index) => ({
        id: `step-${index}`,
        guidance,
        agentId: suggestedAgents[index % suggestedAgents.length],
      })),
      memoryBasedStrategy: "sequential", // Could be enhanced with memory-based strategy selection
      estimatedComplexity: this.estimateComplexity(memoryGuidance),
    };

    sessionMemory.rememberWithMetadata(
      "execution-plan",
      executionPlan,
      {
        memoryType: CoALAMemoryType.PROCEDURAL,
        tags: ["execution-plan", "session-strategy"],
        relevanceScore: 0.8,
      },
    );

    return {
      executionPlan,
      memoryGuidance,
      agentMemoryContexts,
    };
  }

  evaluateProgressWithMemory(
    sessionMemory: CoALAMemoryManager,
    agentResults: any[],
  ): {
    shouldContinue: boolean;
    refinements: string[];
    memoryUpdates: any[];
  } {
    // Remember agent results
    for (const result of agentResults) {
      sessionMemory.rememberWithMetadata(
        `agent-result-${result.agentId}-${Date.now()}`,
        result,
        {
          memoryType: CoALAMemoryType.EPISODIC,
          tags: ["agent-result", result.agentId, result.success ? "success" : "failure"],
          relevanceScore: result.success ? 0.7 : 0.9, // Failures are more memorable
        },
      );
    }

    // Query historical patterns for evaluation
    const similarResults = sessionMemory.queryMemories({
      tags: ["agent-result"],
      minRelevance: 0.3,
      limit: 20,
    });

    // Analyze patterns and determine next steps
    const successRate = this.calculateSuccessRate(similarResults);
    const shouldContinue = successRate < 0.8 && agentResults.some((r) => !r.success);

    const refinements = this.generateRefinements(similarResults, agentResults);

    // Create memory updates for consolidation
    const memoryUpdates = agentResults.map((result) => ({
      type: "agent-performance",
      agentId: result.agentId,
      performance: result.success ? "good" : "needs-improvement",
      context: result.context,
    }));

    return {
      shouldContinue,
      refinements,
      memoryUpdates,
    };
  }

  // Session cleanup and consolidation
  async consolidateSessionMemory(sessionId: string): Promise<void> {
    const sessionMemory = this.sessionMemories.get(sessionId);
    if (!sessionMemory) return;

    // Get important memories from session
    const importantMemories = sessionMemory.queryMemories({
      minRelevance: 0.6,
      tags: ["success", "pattern", "learning"],
    });

    // Consolidate up to workspace level
    await this.consolidator.syncUp(
      { id: sessionId } as IAtlasScope,
      importantMemories,
    );

    // Cleanup session memory
    this.consolidator.unregisterSessionMemory(sessionId);
    this.sessionMemories.delete(sessionId);
  }

  // Maintenance and optimization
  async performMemoryMaintenance(): Promise<void> {
    await this.consolidator.performMaintenance();

    // Cleanup old session memories
    const oldSessions = Array.from(this.sessionMemories.entries())
      .filter(([_sessionId, memory]) => {
        // Remove sessions older than 24 hours
        const sessionAge = Date.now() - memory.size() * 1000; // Rough age estimate
        return sessionAge > 86400000;
      });

    for (const [sessionId, _memory] of oldSessions) {
      await this.consolidateSessionMemory(sessionId);
    }
  }

  // Private helper methods
  private extractAgentSuggestions(memories: any[]): string[] {
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

  private getWorkspaceStoragePath(workspace: IAtlasScope): string {
    // Default workspace memory path
    return "./.atlas/memory";
  }

  private createAnalysisContext(memories: any[], _signal: IWorkspaceSignal): string {
    const patterns = memories
      .filter((m) => m.tags.includes("pattern"))
      .map((m) => m.content)
      .slice(0, 3);

    return `Signal analysis based on ${memories.length} relevant memories. ` +
      `Identified patterns: ${
        patterns.length > 0 ? patterns.map((p) => p.type).join(", ") : "none"
      }`;
  }

  private extractExecutionGuidance(memories: any[]): string[] {
    return memories
      .filter((m) => m.memoryType === CoALAMemoryType.PROCEDURAL)
      .map((m) => `Execute based on: ${m.content.type || "procedure"}`)
      .slice(0, 5);
  }

  private createAgentGuidance(memories: any[], agentId: string): string {
    const relevantMemories = memories.filter((m) =>
      m.tags.some((tag: string) => tag.includes(agentId))
    );

    return `Agent ${agentId} should consider ${relevantMemories.length} relevant memories`;
  }

  private estimateComplexity(guidance: string[]): number {
    return Math.min(10, guidance.length * 2);
  }

  private calculateSuccessRate(results: any[]): number {
    if (results.length === 0) return 1.0;

    const successes = results.filter((r) => r.tags && r.tags.includes("success")).length;

    return successes / results.length;
  }

  private generateRefinements(_historical: any[], current: any[]): string[] {
    const failures = current.filter((r) => !r.success);
    return failures.map((f) => `Refine approach for ${f.agentId}: ${f.error || "unknown error"}`);
  }
}

// Default memory filtering policy
class DefaultMemoryFilteringPolicy implements MemoryFilteringPolicy {
  filterForSession(workspaceMemories: any[], _sessionContext: IWorkspaceSession): any[] {
    // Provide general knowledge and relevant patterns to sessions
    return workspaceMemories.filter((memory) =>
      memory.memoryType === CoALAMemoryType.SEMANTIC ||
      memory.memoryType === CoALAMemoryType.PROCEDURAL ||
      memory.tags.includes("session-relevant")
    );
  }

  filterForAgent(sessionMemories: any[], agentId: string): any[] {
    // Provide agent-specific and contextual memories
    return sessionMemories.filter((memory) =>
      memory.tags.includes(agentId) ||
      memory.tags.includes("context") ||
      memory.memoryType === CoALAMemoryType.CONTEXTUAL
    );
  }
}
