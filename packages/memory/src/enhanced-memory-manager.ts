import { logger } from "@atlas/logger";
import { ContextAssemblyService, type FormatType } from "./context-assembly.ts";
import { EnhancedTokenBudgetManager } from "./enhanced-token-budget-manager.ts";
import {
  type ConversationContext,
  type EnhancedPrompt,
  type MECMFEmbeddingProvider,
  type MECMFMemoryManager,
  type MemoryConfiguration,
  type MemoryEntry,
  type MemorySource,
  type MemorySourceMetadata,
  type MemoryStatistics,
  MemoryType,
  type RetrievalOptions,
  type WorklogEntry,
} from "./mecmf-interfaces.ts";
import { SessionBridgeManager } from "./session-bridge-manager.ts";
import { SessionTransitionHandler } from "./session-transition.ts";
import { WorklogManager } from "./worklog/worklog-manager.ts";

/**
 * Enhanced statistics including session bridge and worklog metrics
 */
interface EnhancedMemoryStatistics extends MemoryStatistics {
  sessionBridge: { totalEntries: number; averageAge: number; averageRelevance: number };
  worklog: {
    totalEntries: number;
    entriesByType: Record<string, number>;
    entriesByOutcome: Record<string, number>;
    averageConfidence: number;
  };
  tokenUsage: {
    totalAllocated: number;
    bridgeTokens: number;
    worklogTokens: number;
    compressionRate: number;
  };
}

/**
 * EnhancedMemoryManager integrates session bridge, worklog, and enhanced token management
 * to provide seamless conversational continuity and institutional memory.
 */
export class EnhancedMemoryManager implements MECMFMemoryManager {
  private baseMemoryManager: MECMFMemoryManager;
  private _embeddingProvider: MECMFEmbeddingProvider;
  private bridgeManager: SessionBridgeManager;
  private worklogManager: WorklogManager;
  private transitionHandler: SessionTransitionHandler;
  private tokenManager: EnhancedTokenBudgetManager;
  private contextAssembly: ContextAssemblyService;
  private config: MemoryConfiguration;
  private currentSessionId?: string;

  constructor(
    baseMemoryManager: MECMFMemoryManager,
    embeddingProvider: MECMFEmbeddingProvider,
    config: MemoryConfiguration,
  ) {
    this.baseMemoryManager = baseMemoryManager;
    this._embeddingProvider = embeddingProvider;
    this.config = config;

    // Initialize enhanced components
    this.bridgeManager = new SessionBridgeManager(baseMemoryManager, config.session_bridge);
    this.worklogManager = new WorklogManager(baseMemoryManager, embeddingProvider, config.worklog);
    this.transitionHandler = new SessionTransitionHandler(
      baseMemoryManager,
      this.bridgeManager,
      this.worklogManager,
    );
    this.tokenManager = new EnhancedTokenBudgetManager();
    this.contextAssembly = new ContextAssemblyService(this.tokenManager);
  }

  // === Core MECMFMemoryManager Interface Implementation ===

  async initialize(): Promise<void> {
    // Initialize the base memory manager
    await this.baseMemoryManager.initialize();

    // Initialize enhanced components if they have initialize methods
    if ("initialize" in this.bridgeManager && typeof this.bridgeManager.initialize === "function") {
      await this.bridgeManager.initialize();
    }
    if (
      "initialize" in this.worklogManager &&
      typeof this.worklogManager.initialize === "function"
    ) {
      await this.worklogManager.initialize();
    }
  }

  async dispose(): Promise<void> {
    // Dispose of enhanced components if they have dispose methods
    if ("dispose" in this.bridgeManager && typeof this.bridgeManager.dispose === "function") {
      await this.bridgeManager.dispose();
    }
    if ("dispose" in this.worklogManager && typeof this.worklogManager.dispose === "function") {
      await this.worklogManager.dispose();
    }

    // Dispose of base memory manager
    await this.baseMemoryManager.dispose();
  }

  async storeMemory(entry: MemoryEntry): Promise<void> {
    return await this.baseMemoryManager.storeMemory(entry);
  }

  async retrieveMemory(id: string): Promise<MemoryEntry | null> {
    return await this.baseMemoryManager.retrieveMemory(id);
  }

  async deleteMemory(id: string): Promise<void> {
    return await this.baseMemoryManager.deleteMemory(id);
  }

  async classifyAndStore(
    content: string,
    context: ConversationContext,
    source?: MemorySource,
    sourceMetadata?: MemorySourceMetadata,
  ): Promise<string> {
    // Store current session ID for later use
    if (context.sessionId && context.sessionId !== this.currentSessionId) {
      await this.handleSessionChange(context.sessionId);
    }

    return this.baseMemoryManager.classifyAndStore(content, context, source, sourceMetadata);
  }

  async getRelevantMemories(query: string, options?: RetrievalOptions): Promise<MemoryEntry[]> {
    return await this.baseMemoryManager.getRelevantMemories(query, options);
  }

  async buildTokenAwarePrompt(
    originalPrompt: string,
    tokenBudget: number,
  ): Promise<EnhancedPrompt> {
    // Get all memory types for enhanced context assembly
    const workingMemories = await this.getRelevantMemories("", {
      memoryTypes: [
        MemoryType.WORKING,
        MemoryType.PROCEDURAL,
        MemoryType.SEMANTIC,
        MemoryType.EPISODIC,
      ],
      maxResults: 100,
    });

    const bridgeMemories = await this.getBridgeMemories();
    const worklogEntries = await this.getRecentWorklogForContext();

    // Use enhanced prompt building with all context types
    return this.tokenManager.buildEnhancedPromptWithBridge(
      originalPrompt,
      workingMemories,
      bridgeMemories,
      worklogEntries,
      tokenBudget,
      {
        adaptiveAllocation: true,
        contextFormat: "summary",
        prioritizeBridge: this.config.session_bridge.enabled,
      },
    );
  }

  optimizeMemoryForTokens(memories: MemoryEntry[], budget: number): MemoryEntry[] {
    return this.baseMemoryManager.optimizeMemoryForTokens(memories, budget);
  }

  async consolidateWorkingMemory(): Promise<void> {
    return await this.baseMemoryManager.consolidateWorkingMemory();
  }

  async pruneByRelevance(threshold: number): Promise<number> {
    const basePruned = await this.baseMemoryManager.pruneByRelevance(threshold);

    // Also prune expired bridge memories and old worklog entries
    if (this.config.session_bridge.enabled) {
      await this.bridgeManager.pruneExpired();
    }

    if (this.config.worklog.enabled) {
      await this.worklogManager.pruneOldWorklogEntries();
    }

    return basePruned;
  }

  getMemoryStatistics(): MemoryStatistics {
    // Get statistics from the base memory manager
    // Note: This returns synchronous stats as the base interface is not async
    const baseStats = this.baseMemoryManager.getMemoryStatistics();
    return (
      baseStats || {
        totalMemories: 0,
        byType: {
          [MemoryType.WORKING]: 0,
          [MemoryType.SESSION_BRIDGE]: 0,
          [MemoryType.EPISODIC]: 0,
          [MemoryType.SEMANTIC]: 0,
          [MemoryType.PROCEDURAL]: 0,
        },
        averageRelevance: 0,
        oldestEntry: null,
        newestEntry: null,
        totalSize: 0,
      }
    );
  }

  async enhancePromptWithMemory(
    originalPrompt: string,
    options?: {
      tokenBudget?: number;
      contextFormat?: "detailed" | "summary" | "bullets";
      includeTypes?: MemoryType[];
      maxMemories?: number;
    },
  ): Promise<EnhancedPrompt> {
    return await this.baseMemoryManager.enhancePromptWithMemory(originalPrompt, options);
  }

  // === Enhanced Memory Manager Methods ===

  /**
   * Initializes a new session with bridge memory and worklog context.
   */
  async initializeNewSession(sessionId: string): Promise<void> {
    logger.info(`Initializing enhanced session: ${sessionId}`);

    this.currentSessionId = sessionId;

    if (this.config.session_bridge.enabled) {
      // Load session bridge + recent worklog into working memory
      await this.transitionHandler.onSessionStart(sessionId);
    }

    if (this.config.worklog.enabled) {
      // Set up worklog monitoring for this session
      this.worklogManager.startSessionMonitoring(sessionId);
    }

    logger.info(`Enhanced session ${sessionId} initialized successfully`);
  }

  /**
   * Finalizes a session with bridge promotion and worklog generation.
   */
  async finalizeSession(sessionId: string): Promise<void> {
    logger.info(`Finalizing enhanced session: ${sessionId}`);

    try {
      if (this.config.session_bridge.enabled || this.config.worklog.enabled) {
        // Process worklog entries and promote conversations to bridge memory
        await this.transitionHandler.onSessionEnd(sessionId);
      }

      if (this.config.worklog.enabled) {
        this.worklogManager.stopSessionMonitoring(sessionId);
      }

      logger.info(`Enhanced session ${sessionId} finalized successfully`);
    } catch (error) {
      logger.error(`Failed to finalize session ${sessionId}:`, { error });
      // Attempt emergency cleanup
      await this.transitionHandler.emergencySessionCleanup(sessionId);
    }

    // Clear current session
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = undefined;
    }
  }

  /**
   * Builds an enhanced prompt with full context integration.
   */
  async buildEnhancedPrompt(
    originalPrompt: string,
    tokenBudget: number,
    options?: { format?: FormatType; prioritizeRecent?: boolean; includeMetadata?: boolean },
  ): Promise<{
    enhancedPrompt: string;
    originalPrompt: string;
    contextSections: {
      bridgeContext?: string;
      worklogContext?: string;
      workingContext?: string;
      proceduralContext?: string;
      semanticContext?: string;
      episodicContext?: string;
    };
    tokensUsed: number;
    bridgeMemoriesIncluded: number;
    worklogEntriesIncluded: number;
  }> {
    const workingMemories = await this.getRelevantMemories("", {
      memoryTypes: [
        MemoryType.WORKING,
        MemoryType.PROCEDURAL,
        MemoryType.SEMANTIC,
        MemoryType.EPISODIC,
      ],
      maxResults: 100,
    });

    const bridgeMemories = await this.getBridgeMemories();
    const worklogEntries = await this.getRecentWorklogForContext();

    const result = await this.contextAssembly.assembleEnhancedPrompt(
      originalPrompt,
      workingMemories,
      bridgeMemories,
      worklogEntries,
      tokenBudget,
      options,
    );

    return {
      enhancedPrompt: result.enhancedPrompt,
      originalPrompt: result.originalPrompt,
      contextSections: result.contextSections,
      tokensUsed: result.tokensUsed,
      bridgeMemoriesIncluded: bridgeMemories.length,
      worklogEntriesIncluded: worklogEntries.length,
    };
  }

  /**
   * Gets session bridge memories for context.
   */
  async getBridgeMemories(): Promise<MemoryEntry[]> {
    if (!this.config.session_bridge.enabled) {
      return [];
    }

    try {
      return await this.bridgeManager.loadIntoNewSession();
    } catch (error) {
      logger.error("Failed to load bridge memories:", { error });
      return [];
    }
  }

  /**
   * Gets recent worklog entries for context.
   */
  async getRecentWorklogForContext(): Promise<WorklogEntry[]> {
    if (!this.config.worklog.enabled) {
      return [];
    }

    try {
      return await this.worklogManager.getRecentWorklog(7); // Last 7 days
    } catch (error) {
      logger.error("Failed to load recent worklog:", { error });
      return [];
    }
  }

  /**
   * Searches worklog entries by query.
   */
  async searchWorklog(query: string, maxResults?: number): Promise<WorklogEntry[]> {
    if (!this.config.worklog.enabled) {
      return [];
    }

    return await this.worklogManager.searchWorklog(query, maxResults);
  }

  /**
   * Gets worklog entries by type.
   */
  async getWorklogByType(
    type: "task_completed" | "decision_made" | "file_modified" | "command_executed",
    maxResults?: number,
  ): Promise<WorklogEntry[]> {
    if (!this.config.worklog.enabled) {
      return [];
    }

    return await this.worklogManager.getWorklogByType(type, maxResults);
  }

  /**
   * Gets enhanced memory statistics including bridge and worklog metrics.
   */
  async getEnhancedMemoryStatistics(): Promise<EnhancedMemoryStatistics> {
    const baseStats = await this.baseMemoryManager.getMemoryStatistics();

    // Get session bridge statistics
    const bridgeStats = await this.bridgeManager.getStatistics();

    // Get worklog statistics
    const worklogStats = await this.worklogManager.getWorklogStatistics();

    // Calculate token usage statistics (simplified)
    const tokenUsage = {
      totalAllocated: 0, // Would track actual usage
      bridgeTokens: 0,
      worklogTokens: 0,
      compressionRate: 0,
    };

    return {
      ...baseStats,
      sessionBridge: {
        totalEntries: bridgeStats.totalBridgeMemories,
        averageAge: bridgeStats.oldestBridgeMemory
          ? (Date.now() - bridgeStats.oldestBridgeMemory.getTime()) / (1000 * 60 * 60)
          : 0,
        averageRelevance: bridgeStats.averageRelevance,
      },
      worklog: {
        totalEntries: worklogStats.totalEntries,
        entriesByType: worklogStats.entriesByType,
        entriesByOutcome: worklogStats.entriesByOutcome,
        averageConfidence: worklogStats.averageConfidence,
      },
      tokenUsage,
    };
  }

  /**
   * Manually triggers session transition (for testing/debugging).
   */
  async manualSessionTransition(fromSessionId: string, toSessionId: string): Promise<void> {
    await this.finalizeSession(fromSessionId);
    await this.initializeNewSession(toSessionId);
  }

  /**
   * Handles session change detection.
   */
  private async handleSessionChange(newSessionId: string): Promise<void> {
    if (this.currentSessionId) {
      // Finalize the previous session
      await this.finalizeSession(this.currentSessionId);
    }

    // Initialize the new session
    await this.initializeNewSession(newSessionId);
  }

  /**
   * Updates the memory configuration.
   */
  updateConfiguration(newConfig: Partial<MemoryConfiguration>): void {
    this.config = { ...this.config, ...newConfig };

    // Update component configurations
    if (newConfig.session_bridge) {
      this.bridgeManager.updateConfig(newConfig.session_bridge);
    }

    if (newConfig.worklog) {
      this.worklogManager.updateConfig(newConfig.worklog);
    }
  }

  /**
   * Gets current configuration.
   */
  getConfiguration(): MemoryConfiguration {
    return { ...this.config };
  }

  /**
   * Gets the embedding provider (for future enhanced features).
   */
  getEmbeddingProvider(): MECMFEmbeddingProvider {
    return this._embeddingProvider;
  }

  /**
   * Performs health check on all enhanced memory components.
   */
  async healthCheck(): Promise<{
    overall: "healthy" | "degraded" | "failed";
    components: {
      baseManager: "healthy" | "failed";
      sessionBridge: "healthy" | "disabled" | "failed";
      worklog: "healthy" | "disabled" | "failed";
      tokenManager: "healthy" | "failed";
      contextAssembly: "healthy" | "failed";
    };
    issues: string[];
  }> {
    const issues: string[] = [];
    const components = {
      baseManager: <"healthy" | "failed">"healthy",
      sessionBridge: <"healthy" | "disabled" | "failed">"healthy",
      worklog: <"healthy" | "disabled" | "failed">"healthy",
      tokenManager: <"healthy" | "failed">"healthy",
      contextAssembly: <"healthy" | "failed">"healthy",
    };

    // Check base memory manager
    try {
      await this.baseMemoryManager.getMemoryStatistics();
    } catch (error) {
      components.baseManager = "failed";
      issues.push(
        `Base memory manager failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Check session bridge
    if (!this.config.session_bridge.enabled) {
      components.sessionBridge = "disabled";
    } else {
      try {
        await this.bridgeManager.getStatistics();
      } catch (error) {
        components.sessionBridge = "failed";
        issues.push(
          `Session bridge failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Check worklog
    if (!this.config.worklog.enabled) {
      components.worklog = "disabled";
    } else {
      try {
        await this.worklogManager.getWorklogStatistics();
      } catch (error) {
        components.worklog = "failed";
        issues.push(
          `Worklog manager failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Determine overall health
    const failedComponents = Object.values(components).filter(
      (status) => status === "failed",
    ).length;
    let overall: "healthy" | "degraded" | "failed";

    if (failedComponents === 0) {
      overall = "healthy";
    } else if (components.baseManager === "healthy") {
      overall = "degraded";
    } else {
      overall = "failed";
    }

    return { overall, components, issues };
  }

  /**
   * Gets the current session ID.
   */
  getCurrentSessionId(): string | undefined {
    return this.currentSessionId;
  }

  /**
   * Forces cleanup of all memory components (emergency use).
   */
  async emergencyCleanup(): Promise<void> {
    logger.warn("Performing emergency cleanup of enhanced memory manager");

    try {
      if (this.currentSessionId) {
        await this.transitionHandler.emergencySessionCleanup(this.currentSessionId);
      }

      await this.bridgeManager.pruneExpired();
      await this.worklogManager.pruneOldWorklogEntries();
      await this.baseMemoryManager.consolidateWorkingMemory();

      logger.info("Emergency cleanup completed");
    } catch (error) {
      logger.error("Emergency cleanup failed:", { error });
      throw error;
    }
  }
}

/**
 * Factory function to create an enhanced memory manager with default configuration.
 */
export function createEnhancedMemoryManager(
  baseMemoryManager: MECMFMemoryManager,
  embeddingProvider: MECMFEmbeddingProvider,
  config?: Partial<MemoryConfiguration>,
): EnhancedMemoryManager {
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

  const finalConfig = { ...defaultConfig, ...config };

  return new EnhancedMemoryManager(baseMemoryManager, embeddingProvider, finalConfig);
}
