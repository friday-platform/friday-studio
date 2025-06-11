/**
 * Supervisor Memory Coordinator
 *
 * Integrates CoALA memory systems with Atlas supervisor architecture
 * Provides memory coordination between WorkspaceSupervisor and SessionSupervisor
 */

import type {
  IAtlasScope,
  IWorkspaceSession,
  IWorkspaceSignal,
  IWorkspaceSupervisor,
} from "../../types/core.ts";
import { CoALAMemoryManager, CoALAMemoryQuery, CoALAMemoryType } from "./coala-memory.ts";
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
    this.workspaceMemory = new CoALAMemoryManager(workspace);
    this.consolidator = new WorkspaceMemoryConsolidator(this.workspaceMemory);
    this.filteringPolicy = filteringPolicy || new DefaultMemoryFilteringPolicy();
  }

  // WorkspaceSupervisor Memory Operations
  async analyzeSignalWithMemory(signal: IWorkspaceSignal): Promise<{
    relevantMemories: any[];
    analysisContext: string;
    suggestedAgents: string[];
  }> {
    // Query relevant memories for signal analysis
    const signalContent = JSON.stringify(signal);
    const relevantMemories = this.workspaceMemory.queryMemories({
      content: signalContent,
      memoryType: CoALAMemoryType.SEMANTIC,
      minRelevance: 0.3,
      limit: 10,
    });

    // Look for procedural memories (workflows, patterns)
    const proceduralMemories = this.workspaceMemory.queryMemories({
      memoryType: CoALAMemoryType.PROCEDURAL,
      tags: ["workflow", "pattern"],
      minRelevance: 0.4,
      limit: 5,
    });

    // Combine and analyze
    const allRelevantMemories = [...relevantMemories, ...proceduralMemories];

    // Extract agent suggestions from memory patterns
    const suggestedAgents = this.extractAgentSuggestions(allRelevantMemories);

    // Create analysis context
    const analysisContext = this.createAnalysisContext(allRelevantMemories, signal);

    // Remember this signal analysis for future reference
    this.workspaceMemory.rememberWithMetadata(
      `signal-analysis-${signal.id || Date.now()}`,
      {
        signal: signalContent,
        relevantMemories: allRelevantMemories.map((m) => m.id),
        suggestedAgents,
        analysisResult: analysisContext,
      },
      {
        memoryType: CoALAMemoryType.EPISODIC,
        tags: ["signal-analysis", "workspace-decision"],
        relevanceScore: 0.6,
      },
    );

    return {
      relevantMemories: allRelevantMemories,
      analysisContext,
      suggestedAgents,
    };
  }

  async createSessionMemoryContext(
    sessionId: string,
    session: IWorkspaceSession,
    workspaceAnalysis: any,
  ): Promise<CoALAMemoryManager> {
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
    // Query session memories for execution planning
    const contextualMemories = sessionMemory.queryMemories({
      memoryType: CoALAMemoryType.CONTEXTUAL,
      minRelevance: 0.4,
    });

    const proceduralMemories = sessionMemory.queryMemories({
      memoryType: CoALAMemoryType.PROCEDURAL,
      tags: ["workflow", "strategy"],
      minRelevance: 0.3,
    });

    // Create execution plan based on memory guidance
    const memoryGuidance = this.extractExecutionGuidance(
      [...contextualMemories, ...proceduralMemories],
    );

    // Create agent-specific memory contexts
    const agentMemoryContexts = new Map<string, any>();
    const suggestedAgents = sessionContext.suggestedAgents || [];

    for (const agentId of suggestedAgents) {
      const agentMemories = this.filteringPolicy.filterForAgent(
        contextualMemories,
        agentId,
      );

      agentMemoryContexts.set(agentId, {
        relevantMemories: agentMemories,
        guidance: this.createAgentGuidance(agentMemories, agentId),
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

  async evaluateProgressWithMemory(
    sessionMemory: CoALAMemoryManager,
    agentResults: any[],
  ): Promise<{
    shouldContinue: boolean;
    refinements: string[];
    memoryUpdates: any[];
  }> {
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
      .filter(([sessionId, memory]) => {
        // Remove sessions older than 24 hours
        const sessionAge = Date.now() - memory.size() * 1000; // Rough age estimate
        return sessionAge > 86400000;
      });

    for (const [sessionId, _] of oldSessions) {
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

  private createAnalysisContext(memories: any[], signal: IWorkspaceSignal): string {
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

  private generateRefinements(historical: any[], current: any[]): string[] {
    const failures = current.filter((r) => !r.success);
    return failures.map((f) => `Refine approach for ${f.agentId}: ${f.error || "unknown error"}`);
  }
}

// Default memory filtering policy
class DefaultMemoryFilteringPolicy implements MemoryFilteringPolicy {
  filterForSession(workspaceMemories: any[], sessionContext: IWorkspaceSession): any[] {
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
