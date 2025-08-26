/**
 * MECMF Memory Manager
 *
 * Main implementation of the Memory-Enhanced Context Management Framework,
 * integrating all MECMF components into a unified memory system for Atlas.
 */

import { GlobalEmbeddingProvider } from "./global-embedding-provider.ts";

// Import existing Atlas components
import { type CoALAMemoryEntry, CoALAMemoryManager, CoALAMemoryType } from "./coala-memory.ts";
import { getGlobalMECMFDebugLogger, type PromptEnhancementLog } from "./debug-logger.ts";
import { MECMFErrorHandler } from "./error-handling.ts";
import type {
  MemoryScoper,
  MECMFMemoryManager,
  MECMFEmbeddingProvider,
} from "./mecmf-interfaces.ts";
import {
  type ConversationContext,
  type EnhancedPrompt,
  type MemoryEntry,
  MemorySource,
  type MemorySourceMetadata,
  type MemoryStatistics,
  MemoryType,
  type RetrievalOptions,
} from "./mecmf-interfaces.ts";
import { PIISafeMemoryClassifier } from "./pii-safe-classifier.ts";
import { AtlasTokenBudgetManager } from "./token-budget-manager.ts";

export interface MECMFConfig {
  workspaceId: string;
  enableVectorSearch?: boolean;
  embeddingConfig?: { cacheDirectory?: string; batchSize?: number };
  tokenBudgets?: { defaultBudget?: number; modelLimits?: Record<string, number> };
  fallbackOptions?: {
    enableTextSearch?: boolean;
    cacheRecentMemories?: boolean;
    maxCachedMemories?: number;
  };
}

export class AtlasMECMFMemoryManager implements MECMFMemoryManager {
  private embeddingProvider: MECMFEmbeddingProvider | null = null;
  private tokenBudgetManager: AtlasTokenBudgetManager;
  private memoryClassifier: PIISafeMemoryClassifier; // Changed to PII-safe classifier
  private errorHandler: MECMFErrorHandler;
  private coalaManager: CoALAMemoryManager;
  private recentMemoryCache: Map<string, MemoryEntry> = new Map();
  private ready: boolean = false;
  private config: MECMFConfig;
  private scope: IAtlasScope;

  constructor(scope: IAtlasScope, config: MECMFConfig) {
    this.scope = scope;
    this.config = {
      enableVectorSearch: true,
      fallbackOptions: { enableTextSearch: true, cacheRecentMemories: true, maxCachedMemories: 50 },
      tokenBudgets: {
        defaultBudget: 4000, // Conservative default
        modelLimits: {
          "claude-3-sonnet": 200000,
          "claude-3-haiku": 200000,
          "gpt-4": 128000,
          "gpt-3.5-turbo": 16000,
        },
      },
      ...config,
    };

    // Initialize synchronous core components
    this.tokenBudgetManager = new AtlasTokenBudgetManager();
    this.memoryClassifier = new PIISafeMemoryClassifier(); // Use PII-safe classifier
    this.errorHandler = new MECMFErrorHandler();

    // Note: Embedding provider and CoALA manager initialization moved to initialize() method
    // to support async singleton embedding provider initialization
    this.coalaManager = new CoALAMemoryManager(
      scope,
      undefined, // Use default storage
      true, // Enable cognitive loop
      {
        // Vector search config will be set in initialize() once embedding provider is ready
        vectorSearchConfig: undefined,
      },
    );
  }

  async initialize(): Promise<void> {
    if (this.ready) return;

    try {
      // Initialize embedding provider using singleton if vector search is enabled
      if (this.config.enableVectorSearch) {
        this.embeddingProvider = await GlobalEmbeddingProvider.getInstance(
          this.config.embeddingConfig,
        );

        // Configure CoALA manager with vector search now that embedding provider is ready
        this.coalaManager = new CoALAMemoryManager(
          this.scope,
          undefined, // Use default storage
          true, // Enable cognitive loop
          {
            vectorSearchConfig: {
              embeddingProvider: this.embeddingProvider,
              batchSize: this.config.embeddingConfig?.batchSize || 10,
            },
          },
        );
      }

      // The CoALA manager initializes automatically

      this.ready = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to initialize MECMF Memory Manager: ${message}`);
    }
  }

  // === Core Memory Operations ===

  async storeMemory(entry: MemoryEntry): Promise<void> {
    await this.ensureReady();

    // Convert MECMF MemoryEntry to CoALA format
    const coalaEntry: Partial<CoALAMemoryEntry> = {
      id: entry.id,
      content: entry.content,
      timestamp: entry.timestamp,
      memoryType: this.mapMemoryType(entry.memoryType),
      relevanceScore: entry.relevanceScore,
      sourceScope: entry.sourceScope,
      tags: entry.tags,
      confidence: entry.confidence,
      decayRate: entry.decayRate,
      accessCount: 0,
      lastAccessed: entry.timestamp,
      associations: [],
      source: entry.source,
      sourceMetadata: entry.sourceMetadata,
    };

    // Store in CoALA manager
    this.coalaManager.rememberWithMetadata(entry.id, entry.content, {
      memoryType: coalaEntry.memoryType!,
      tags: entry.tags,
      relevanceScore: entry.relevanceScore,
      confidence: entry.confidence,
      decayRate: entry.decayRate,
      source: entry.source,
      sourceMetadata: entry.sourceMetadata,
    });

    // Update recent memory cache for fallback scenarios
    if (this.config.fallbackOptions?.cacheRecentMemories) {
      this.updateRecentMemoryCache(entry);
    }
  }

  async retrieveMemory(id: string): Promise<MemoryEntry | null> {
    await this.ensureReady();

    // Try to get the full memory entry with metadata first
    const fullMemory = this.coalaManager.getMemoryById(id);
    if (fullMemory) {
      return {
        id: fullMemory.id,
        content: fullMemory.content,
        timestamp: fullMemory.timestamp,
        memoryType: this.mapCoALAType(fullMemory.memoryType),
        relevanceScore: fullMemory.relevanceScore,
        sourceScope: fullMemory.sourceScope,
        tags: fullMemory.tags,
        confidence: fullMemory.confidence,
        decayRate: fullMemory.decayRate,
        source: (fullMemory.source as MemorySource) || MemorySource.SYSTEM_GENERATED,
        sourceMetadata: fullMemory.sourceMetadata,
      };
    }

    // Fallback to content-only retrieval if full memory not available
    const content = this.coalaManager.recall(id);
    if (!content) return null;

    // Check recent memory cache for original metadata
    const cachedMemory = this.recentMemoryCache.get(id);
    if (cachedMemory) {
      return cachedMemory;
    }

    // Return minimal info when metadata is not accessible
    return {
      id,
      content,
      timestamp: new Date(),
      memoryType: MemoryType.WORKING,
      relevanceScore: 0.5,
      sourceScope: this.config.workspaceId,
      tags: [],
      confidence: 1.0,
      decayRate: 0.1,
      source: MemorySource.SYSTEM_GENERATED,
    };
  }

  async deleteMemory(id: string): Promise<void> {
    await this.ensureReady();

    this.coalaManager.forget(id);
    this.recentMemoryCache.delete(id);
  }

  // === Classification and Management ===

  async classifyAndStore(
    content: string,
    context: ConversationContext,
    source: MemorySource = MemorySource.SYSTEM_GENERATED,
    sourceMetadata?: MemorySourceMetadata,
  ): Promise<string> {
    const startTime = performance.now();
    const debugLogger = getGlobalMECMFDebugLogger();

    await this.ensureReady();

    // Check if content is empty or just whitespace
    if (!content || content.trim().length === 0) {
      throw new Error("Cannot store empty content in memory");
    }

    // Get sanitized content and classification
    const classificationStart = performance.now();

    // For now, store content as-is; classifier handles PII when extracting entities
    const sanitizedContent = content;

    const memoryType = this.memoryClassifier.classifyContent(content, context);
    const classificationTime = performance.now() - classificationStart;

    // Extract entities with PII-safe filtering based on source (using original content for entity extraction)
    const entityStart = performance.now();
    const entities = this.memoryClassifier.extractKeyEntities(content, source);
    const entityTime = performance.now() - entityStart;

    const memoryId = `${memoryType}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const entry: MemoryEntry = {
      id: memoryId,
      content: sanitizedContent, // Use sanitized content instead of original
      timestamp: new Date(),
      memoryType,
      relevanceScore: 0.7, // Default relevance
      sourceScope: context.workspaceId,
      tags: entities.map((e) => e.name.toLowerCase()).slice(0, 5),
      confidence: 0.8,
      decayRate: this.getDecayRateForType(memoryType),
      source,
      sourceMetadata,
    };

    await this.storeMemory(entry);

    const totalTime = performance.now() - startTime;

    // Log memory classification and storage if debugging is enabled
    if (debugLogger.isEnabled()) {
      // Create a simplified log for memory storage (show what was actually stored)
      const truncatedContent =
        sanitizedContent.length > 200
          ? sanitizedContent.substring(0, 200) + "..."
          : sanitizedContent;

      // Write debug information to stderr if environment variable is set
      if (typeof Deno !== "undefined" && Deno.env.get("MECMF_DEBUG") === "true") {
        const debugInfo = [
          `\n🧠 MECMF MEMORY CLASSIFICATION & STORAGE`,
          `Memory ID: ${memoryId}`,
          `Content: "${truncatedContent}"`,
          `Classified as: ${memoryType}`,
          `Source: ${source}`,
          `Source Metadata: ${sourceMetadata ? JSON.stringify(sourceMetadata) : "none"}`,
          `Entities found: ${entities.length} (${entities.map((e) => e.name).join(", ")})`,
          `Tags: [${entry.tags.join(", ")}]`,
          `Classification time: ${classificationTime.toFixed(1)}ms`,
          `Entity extraction time: ${entityTime.toFixed(1)}ms`,
          `Total time: ${totalTime.toFixed(1)}ms`,
          `────────────────────────────────────────\n`,
        ].join("\n");

        Deno.stderr.writeSync(new TextEncoder().encode(debugInfo));
      }
    }

    return memoryId;
  }

  async getRelevantMemories(query: string, options?: RetrievalOptions): Promise<MemoryEntry[]> {
    await this.ensureReady();

    const {
      memoryTypes = [
        MemoryType.WORKING,
        MemoryType.EPISODIC,
        MemoryType.SEMANTIC,
        MemoryType.PROCEDURAL,
      ],
      maxResults = 10,
      minRelevanceScore = 0.3,
    } = options || {};

    // Use error handling with fallback for vector search
    return this.errorHandler
      .handleVectorSearchTimeout(
        // Primary: Vector search via CoALA
        async () => {
          const coalaMemories = await this.coalaManager.searchMemoriesByVector(query, {
            memoryTypes: memoryTypes.map((t) => this.mapMemoryType(t)),
            limit: maxResults,
            minSimilarity: minRelevanceScore,
          });

          return this.convertCoALAToMECMF(coalaMemories);
        },
        // Fallback: Recent cached memories
        (limit: number) =>
          Promise.resolve(
            Array.from(this.recentMemoryCache.values())
              .filter((m) => memoryTypes.includes(m.memoryType))
              .sort((a, b) => b.relevanceScore - a.relevanceScore)
              .slice(0, limit),
          ),
        { operation: "getRelevantMemories", memoryType: memoryTypes[0] },
      )
      .then((result) => result.data);
  }

  // === Token-Aware Operations ===

  async buildTokenAwarePrompt(
    originalPrompt: string,
    tokenBudget: number,
  ): Promise<EnhancedPrompt> {
    const startTime = performance.now();
    const debugLogger = getGlobalMECMFDebugLogger();
    const transformationSteps: string[] = [];

    await this.ensureReady();
    transformationSteps.push("Memory manager initialized and ready");

    // Get relevant memories with timing
    const memoryRetrievalStart = performance.now();
    const memories = await this.getRelevantMemories(originalPrompt, {
      maxResults: 15, // Get more than needed for selection
      minRelevanceScore: 0.4,
    });
    const memoryRetrievalTime = performance.now() - memoryRetrievalStart;
    transformationSteps.push(
      `Retrieved ${memories.length} relevant memories in ${memoryRetrievalTime.toFixed(1)}ms`,
    );

    // Build token-aware prompt with timing
    const tokenBudgetStart = performance.now();
    const enhancedPrompt = this.tokenBudgetManager.buildTokenAwarePrompt(
      originalPrompt,
      memories,
      tokenBudget,
      { adaptiveAllocation: true, contextFormat: "summary" },
    );
    const tokenBudgetTime = performance.now() - tokenBudgetStart;
    transformationSteps.push(`Constructed token-aware prompt in ${tokenBudgetTime.toFixed(1)}ms`);

    const totalTime = performance.now() - startTime;
    transformationSteps.push(`Total enhancement completed in ${totalTime.toFixed(1)}ms`);

    // Log the enhancement process
    if (debugLogger.isEnabled()) {
      const logEntry: PromptEnhancementLog = {
        sessionId: this.config.workspaceId, // Using workspace ID as session identifier
        timestamp: new Date(),
        originalPrompt,
        enhancedPrompt: enhancedPrompt.enhancedPrompt,
        memoryContext: enhancedPrompt.memoryContext,
        tokensOriginal: this.tokenBudgetManager.estimateTokens(originalPrompt),
        tokensEnhanced: enhancedPrompt.tokensUsed,
        memoriesUsed: enhancedPrompt.memoriesIncluded,
        memoryBreakdown: enhancedPrompt.memoryBreakdown,
        transformationSteps,
        performanceMetrics: {
          memoryRetrievalMs: Math.round(memoryRetrievalTime),
          classificationMs: 0, // Would need to track classification separately
          embeddingMs: 0, // Would need to track embedding generation separately
          totalEnhancementMs: Math.round(totalTime),
        },
      };

      debugLogger.logPromptEnhancement(logEntry);
    }

    return enhancedPrompt;
  }

  optimizeMemoryForTokens(memories: MemoryEntry[], budget: number): MemoryEntry[] {
    const memoryObjects = memories.map((m) => ({
      id: m.id,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      type: m.memoryType,
      tokens: this.tokenBudgetManager.estimateTokens(
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      ),
      relevanceScore: m.relevanceScore,
      timestamp: m.timestamp,
    }));

    const optimized = this.tokenBudgetManager.optimizeContentForBudget(memoryObjects, budget);

    return memories.filter((m) => optimized.some((opt) => opt.id === m.id));
  }

  // === Memory Consolidation and Pruning ===

  async consolidateWorkingMemory(): Promise<void> {
    await this.ensureReady();

    // Use CoALA's consolidation mechanism
    this.coalaManager.consolidate();
  }

  async pruneByRelevance(_threshold: number): Promise<number> {
    await this.ensureReady();

    const initialCount = this.coalaManager.size();

    // Use CoALA's pruning mechanism
    this.coalaManager.prune();

    const finalCount = this.coalaManager.size();
    return initialCount - finalCount;
  }

  getMemoryStatistics(): MemoryStatistics {
    const coalaStats = this.coalaManager.getMemoryTypeStatistics();

    const byType = {
      [MemoryType.WORKING]: coalaStats.working?.count || 0,
      [MemoryType.EPISODIC]: coalaStats.episodic?.count || 0,
      [MemoryType.SEMANTIC]: coalaStats.semantic?.count || 0,
      [MemoryType.PROCEDURAL]: coalaStats.procedural?.count || 0,
    };

    const totalMemories = Object.values(byType).reduce((sum, count) => sum + count, 0);

    const averageRelevance =
      totalMemories > 0
        ? Object.entries(coalaStats).reduce(
            (sum, [_type, stats]) => sum + (stats?.avgRelevance || 0) * (stats?.count || 0),
            0,
          ) / totalMemories
        : 0;

    const timestamps = Object.values(coalaStats)
      .map((stats) => stats?.oldestEntry)
      .filter((date) => date !== null) as Date[];

    return {
      totalMemories,
      byType,
      averageRelevance,
      oldestEntry:
        timestamps.length > 0 ? new Date(Math.min(...timestamps.map((d) => d.getTime()))) : null,
      newestEntry: new Date(), // Would need proper tracking
      totalSize: totalMemories * 1024, // Rough estimate
    };
  }

  // === Enhanced Operations ===

  /**
   * Enhanced prompt construction with full MECMF features
   */
  async enhancePromptWithMemory(
    originalPrompt: string,
    options?: {
      tokenBudget?: number;
      contextFormat?: "detailed" | "summary" | "bullets";
      includeTypes?: MemoryType[];
      maxMemories?: number;
    },
  ): Promise<EnhancedPrompt> {
    const startTime = performance.now();
    const debugLogger = getGlobalMECMFDebugLogger();
    const transformationSteps: string[] = [];

    await this.ensureReady();
    transformationSteps.push("Enhanced memory manager initialized and ready");

    const {
      tokenBudget = this.config.tokenBudgets?.defaultBudget || 4000,
      contextFormat = "summary",
      includeTypes = [
        MemoryType.WORKING,
        MemoryType.EPISODIC,
        MemoryType.SEMANTIC,
        MemoryType.PROCEDURAL,
      ],
      maxMemories = 8,
    } = options || {};

    transformationSteps.push(
      `Configuration: budget=${tokenBudget}, format=${contextFormat}, types=[${includeTypes.join(
        ",",
      )}], maxMemories=${maxMemories}`,
    );

    // Use CoALA's enhanced prompt construction with error handling
    const result = await this.errorHandler.withGracefulDegradation(
      // Primary: Full enhanced prompt with vector search
      async () => {
        const result = await this.coalaManager.enhancePromptWithMemory(originalPrompt, {
          includeWorking: includeTypes.includes(MemoryType.WORKING),
          includeEpisodic: includeTypes.includes(MemoryType.EPISODIC),
          includeSemantic: includeTypes.includes(MemoryType.SEMANTIC),
          includeProcedural: includeTypes.includes(MemoryType.PROCEDURAL),
          maxMemories,
          contextFormat,
        });

        return {
          enhancedPrompt: result.enhancedPrompt,
          originalPrompt,
          memoryContext: result.memoryContext,
          tokensUsed: this.tokenBudgetManager.estimateTokens(result.enhancedPrompt),
          memoriesIncluded: result.memoriesUsed,
          memoryBreakdown: {
            [MemoryType.WORKING]: 0, // Would need proper mapping
            [MemoryType.EPISODIC]: 0,
            [MemoryType.SEMANTIC]: 0,
            [MemoryType.PROCEDURAL]: 0,
          },
        };
      },
      // Fallbacks
      [
        {
          name: "basic_memory_enhancement",
          performanceImpact: "moderate",
          operation: () => {
            const memories = Array.from(this.recentMemoryCache.values()).slice(0, 5);
            const context =
              memories.length > 0
                ? `Context: ${memories
                    .map((m) =>
                      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
                    )
                    .join("; ")}`
                : "";

            return Promise.resolve({
              enhancedPrompt: context ? `${context}\n\n${originalPrompt}` : originalPrompt,
              originalPrompt,
              memoryContext: context,
              tokensUsed: this.tokenBudgetManager.estimateTokens(context + originalPrompt),
              memoriesIncluded: memories.length,
              memoryBreakdown: {
                [MemoryType.WORKING]: memories.filter((m) => m.memoryType === MemoryType.WORKING)
                  .length,
                [MemoryType.EPISODIC]: memories.filter((m) => m.memoryType === MemoryType.EPISODIC)
                  .length,
                [MemoryType.SEMANTIC]: memories.filter((m) => m.memoryType === MemoryType.SEMANTIC)
                  .length,
                [MemoryType.PROCEDURAL]: memories.filter(
                  (m) => m.memoryType === MemoryType.PROCEDURAL,
                ).length,
              },
            });
          },
        },
        {
          name: "no_memory_enhancement",
          performanceImpact: "significant",
          operation: () =>
            Promise.resolve({
              enhancedPrompt: originalPrompt,
              originalPrompt,
              memoryContext: "",
              tokensUsed: this.tokenBudgetManager.estimateTokens(originalPrompt),
              memoriesIncluded: 0,
              memoryBreakdown: {
                [MemoryType.WORKING]: 0,
                [MemoryType.EPISODIC]: 0,
                [MemoryType.SEMANTIC]: 0,
                [MemoryType.PROCEDURAL]: 0,
              },
            }),
        },
      ],
      { operation: "enhancePromptWithMemory" },
    );

    const totalTime = performance.now() - startTime;
    transformationSteps.push(`Graceful degradation completed in ${totalTime.toFixed(1)}ms`);

    // Log the enhancement process
    if (debugLogger.isEnabled()) {
      const logEntry: PromptEnhancementLog = {
        sessionId: this.config.workspaceId,
        timestamp: new Date(),
        originalPrompt,
        enhancedPrompt: result.data.enhancedPrompt,
        memoryContext: result.data.memoryContext,
        tokensOriginal: this.tokenBudgetManager.estimateTokens(originalPrompt),
        tokensEnhanced: result.data.tokensUsed,
        memoriesUsed: result.data.memoriesIncluded,
        memoryBreakdown: result.data.memoryBreakdown,
        transformationSteps,
        performanceMetrics: {
          memoryRetrievalMs: 0, // Would need more granular tracking
          classificationMs: 0,
          embeddingMs: 0,
          totalEnhancementMs: Math.round(totalTime),
        },
      };

      debugLogger.logPromptEnhancement(logEntry);
    }

    return result.data;
  }

  /**
   * Batch memory operations for performance
   */
  async storeMemoryBatch(entries: MemoryEntry[]): Promise<void> {
    await this.ensureReady();

    const promises = entries.map((entry) => this.storeMemory(entry));
    await Promise.all(promises);
  }

  // === Lifecycle Management ===

  async dispose(): Promise<void> {
    try {
      if (this.embeddingProvider) {
        // Release reference to singleton instead of disposing it
        // The singleton manages its own lifecycle across all sessions
        GlobalEmbeddingProvider.releaseReference();
        this.embeddingProvider = null;
      }
      await this.coalaManager.dispose();
      this.recentMemoryCache.clear();
      this.ready = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Error during MECMF disposal: ${message}`);
    }
  }

  // === Private Helper Methods ===

  private async ensureReady(): Promise<void> {
    if (!this.ready) {
      await this.initialize();
    }
  }

  private mapMemoryType(mecmfType: MemoryType): CoALAMemoryType {
    switch (mecmfType) {
      case MemoryType.WORKING:
        return CoALAMemoryType.WORKING;
      case MemoryType.EPISODIC:
        return CoALAMemoryType.EPISODIC;
      case MemoryType.SEMANTIC:
        return CoALAMemoryType.SEMANTIC;
      case MemoryType.PROCEDURAL:
        return CoALAMemoryType.PROCEDURAL;
      default:
        return CoALAMemoryType.WORKING;
    }
  }

  private convertCoALAToMECMF(
    coalaMemories: Array<CoALAMemoryEntry & { similarity?: number }>,
  ): MemoryEntry[] {
    return coalaMemories.map((coala) => ({
      id: coala.id,
      content: coala.content,
      timestamp: coala.timestamp,
      memoryType: this.mapCoALAType(coala.memoryType),
      relevanceScore: coala.similarity || coala.relevanceScore,
      sourceScope: coala.sourceScope,
      tags: coala.tags,
      confidence: coala.confidence,
      decayRate: coala.decayRate,
      embedding: undefined, // Would need to be extracted if needed
      source: (coala.source as MemorySource) || MemorySource.SYSTEM_GENERATED,
      sourceMetadata: coala.sourceMetadata,
    }));
  }

  private mapCoALAType(coalaType: CoALAMemoryType): MemoryType {
    switch (coalaType) {
      case CoALAMemoryType.WORKING:
        return MemoryType.WORKING;
      case CoALAMemoryType.EPISODIC:
        return MemoryType.EPISODIC;
      case CoALAMemoryType.SEMANTIC:
        return MemoryType.SEMANTIC;
      case CoALAMemoryType.PROCEDURAL:
        return MemoryType.PROCEDURAL;
      default:
        return MemoryType.WORKING;
    }
  }

  private updateRecentMemoryCache(entry: MemoryEntry): void {
    this.recentMemoryCache.set(entry.id, entry);

    const maxSize = this.config.fallbackOptions?.maxCachedMemories || 50;
    if (this.recentMemoryCache.size > maxSize) {
      const oldestKey = Array.from(this.recentMemoryCache.keys())[0] ?? "";
      if (oldestKey !== "") {
        this.recentMemoryCache.delete(oldestKey);
      }
    }
  }

  private getDecayRateForType(memoryType: MemoryType): number {
    switch (memoryType) {
      case MemoryType.WORKING:
        return 0.5; // Fast decay
      case MemoryType.EPISODIC:
        return 0.2; // Moderate decay
      case MemoryType.SEMANTIC:
        return 0.05; // Slow decay
      case MemoryType.PROCEDURAL:
        return 0.01; // Very slow decay
      default:
        return 0.1;
    }
  }
}

// Factory function
export function createMECMFMemoryManager(
  scope: MemoryScoper,
  config: MECMFConfig,
): MECMFMemoryManager {
  return new AtlasMECMFMemoryManager(scope, config);
}
