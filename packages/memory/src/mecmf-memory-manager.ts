/**
 * MECMF Memory Manager
 *
 * Main implementation of the Memory-Enhanced Context Management Framework,
 * integrating all MECMF components into a unified memory system for Atlas.
 */

import {
  ConversationContext,
  EnhancedPrompt,
  MECMFMemoryManager,
  MemoryEntry,
  MemorySource,
  MemorySourceMetadata,
  MemoryStatistics,
  MemoryType,
  RetrievalOptions,
} from "./mecmf-interfaces.ts";

import { WebEmbeddingProvider } from "./web-embedding-provider.ts";
import { AtlasTokenBudgetManager } from "./token-budget-manager.ts";
import { AtlasMemoryClassifier } from "./memory-classifier.ts";
import { PIISafeMemoryClassifier } from "./pii-safe-classifier.ts";
import { FallbackResult, MECMFErrorHandler } from "./error-handling.ts";
import { getGlobalMECMFDebugLogger, type PromptEnhancementLog } from "./debug-logger.ts";

// Import existing Atlas components
import { CoALAMemoryEntry, CoALAMemoryManager, CoALAMemoryType } from "./coala-memory.ts";
import type { IAtlasScope } from "../../../src/types/core.ts";
import { VectorSearchLocalStorageAdapter } from "@atlas/storage";
import { join } from "jsr:@std/path";

export interface MECMFConfig {
  workspaceId: string;
  enableVectorSearch?: boolean;
  embeddingConfig?: {
    cacheDirectory?: string;
    batchSize?: number;
  };
  tokenBudgets?: {
    defaultBudget?: number;
    modelLimits?: Record<string, number>;
  };
  fallbackOptions?: {
    enableTextSearch?: boolean;
    cacheRecentMemories?: boolean;
    maxCachedMemories?: number;
  };
}

export class MECMFMemoryManager implements MECMFMemoryManager {
  private embeddingProvider: WebEmbeddingProvider;
  private tokenBudgetManager: AtlasTokenBudgetManager;
  private memoryClassifier: PIISafeMemoryClassifier; // Changed to PII-safe classifier
  private errorHandler: MECMFErrorHandler;
  private coalaManager: CoALAMemoryManager;
  private recentMemoryCache: Map<string, MemoryEntry> = new Map();
  private ready: boolean = false;
  private config: MECMFConfig;

  constructor(
    scope: IAtlasScope,
    config: MECMFConfig,
  ) {
    this.config = {
      enableVectorSearch: true,
      fallbackOptions: {
        enableTextSearch: true,
        cacheRecentMemories: true,
        maxCachedMemories: 50,
      },
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

    // Initialize core components
    this.embeddingProvider = new WebEmbeddingProvider(config.embeddingConfig);
    this.tokenBudgetManager = new AtlasTokenBudgetManager();
    this.memoryClassifier = new PIISafeMemoryClassifier(); // Use PII-safe classifier
    this.errorHandler = new MECMFErrorHandler();

    // Initialize CoALA memory manager with vector search
    this.coalaManager = new CoALAMemoryManager(
      scope,
      undefined, // Use default storage
      true, // Enable cognitive loop
      {
        vectorSearchConfig: config.enableVectorSearch
          ? {
            embeddingProvider: this.embeddingProvider,
            batchSize: config.embeddingConfig?.batchSize || 10,
          }
          : undefined,
      },
    );
  }

  async initialize(): Promise<void> {
    if (this.ready) return;

    try {
      // Initialize embedding provider
      await this.embeddingProvider.warmup();

      // The CoALA manager initializes automatically

      this.ready = true;
    } catch (error) {
      throw new Error(`Failed to initialize MECMF Memory Manager: ${error.message}`);
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

    const content = this.coalaManager.recall(id);
    if (!content) return null;

    // Get the full CoALA memory entry to extract metadata
    const coalaMemory = (this.coalaManager as any).memories.get(id);
    if (!coalaMemory) {
      return null;
    }

    // Map CoALA memory type to MECMF memory type
    const mecmfMemoryType = this.mapCoALAToMECMFType(coalaMemory.memoryType);

    return {
      id,
      content,
      timestamp: coalaMemory.timestamp || new Date(),
      memoryType: mecmfMemoryType,
      relevanceScore: coalaMemory.relevanceScore || 0.5,
      sourceScope: coalaMemory.sourceScope || this.config.workspaceId,
      tags: coalaMemory.tags || [],
      confidence: coalaMemory.confidence || 1.0,
      decayRate: coalaMemory.decayRate || 0.1,
      source: coalaMemory.source || MemorySource.SYSTEM_GENERATED,
      sourceMetadata: coalaMemory.sourceMetadata,
    };
  }

  private mapCoALAToMECMFType(coalaType: any): MemoryType {
    // Map CoALA memory types to MECMF memory types
    switch (coalaType) {
      case "working":
        return MemoryType.WORKING;
      case "episodic":
        return MemoryType.EPISODIC;
      case "semantic":
        return MemoryType.SEMANTIC;
      case "procedural":
        return MemoryType.PROCEDURAL;
      case "contextual":
        return MemoryType.CONTEXTUAL;
      default:
        return MemoryType.WORKING;
    }
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

    // Use the PII-safe classifier to get both sanitized content and classification
    let sanitizedContent = content;
    let memoryType;

    if (this.memoryClassifier instanceof PIISafeMemoryClassifier) {
      // Get validation result to check if content should be sanitized
      const validation = (this.memoryClassifier as any).validateAndSanitizeContent(content);
      sanitizedContent = validation.sanitized;

      if (!validation.isValid) {
        // Log when content is sanitized
        const debugLogger = getGlobalMECMFDebugLogger();
        if (debugLogger.isEnabled()) {
          console.warn(
            `MECMF: Storing sanitized content instead of original: ${content.substring(0, 100)}...`,
          );
        }
      }
    }

    memoryType = this.memoryClassifier.classifyContent(content, context);
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
      const truncatedContent = sanitizedContent.length > 200
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
      maxAge,
      includeSimilarity = true,
    } = options || {};

    // Use error handling with fallback for vector search
    return this.errorHandler.handleVectorSearchTimeout(
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
      async (limit: number) => {
        const cachedMemories = Array.from(this.recentMemoryCache.values())
          .filter((m) => memoryTypes.includes(m.memoryType))
          .sort((a, b) => b.relevanceScore - a.relevanceScore)
          .slice(0, limit);

        return cachedMemories;
      },
      { operation: "getRelevantMemories", memoryType: memoryTypes[0] },
    ).then((result) => result.data);
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
      {
        adaptiveAllocation: true,
        contextFormat: "summary",
      },
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

  async pruneByRelevance(threshold: number): Promise<number> {
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

    const averageRelevance = totalMemories > 0
      ? Object.entries(coalaStats).reduce(
        (sum, [type, stats]) => sum + (stats?.avgRelevance || 0) * (stats?.count || 0),
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
      oldestEntry: timestamps.length > 0
        ? new Date(Math.min(...timestamps.map((d) => d.getTime())))
        : null,
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
      `Configuration: budget=${tokenBudget}, format=${contextFormat}, types=[${
        includeTypes.join(",")
      }], maxMemories=${maxMemories}`,
    );

    // Use CoALA's enhanced prompt construction with error handling
    return this.errorHandler.withGracefulDegradation(
      // Primary: Full enhanced prompt with vector search
      async () => {
        const result = await this.coalaManager.enhancePromptWithMemory(originalPrompt, {
          includeWorking: includeTypes.includes(MemoryType.WORKING),
          includeEpisodic: includeTypes.includes(MemoryType.EPISODIC),
          includeSemantic: includeTypes.includes(MemoryType.SEMANTIC),
          includeProcedural: includeTypes.includes(MemoryType.PROCEDURAL),
          maxMemories,
          contextFormat: contextFormat as any,
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
          operation: async () => {
            const memories = Array.from(this.recentMemoryCache.values()).slice(0, 5);
            const context = memories.length > 0
              ? `Context: ${
                memories.map((m) =>
                  typeof m.content === "string" ? m.content : JSON.stringify(m.content)
                ).join("; ")
              }`
              : "";

            return {
              enhancedPrompt: context ? `${context}\n\n${originalPrompt}` : originalPrompt,
              originalPrompt,
              memoryContext: context,
              tokensUsed: this.tokenBudgetManager.estimateTokens(context + originalPrompt),
              memoriesIncluded: memories.length,
              memoryBreakdown: {
                [MemoryType.WORKING]:
                  memories.filter((m) => m.memoryType === MemoryType.WORKING).length,
                [MemoryType.EPISODIC]:
                  memories.filter((m) => m.memoryType === MemoryType.EPISODIC).length,
                [MemoryType.SEMANTIC]:
                  memories.filter((m) => m.memoryType === MemoryType.SEMANTIC).length,
                [MemoryType.PROCEDURAL]:
                  memories.filter((m) => m.memoryType === MemoryType.PROCEDURAL).length,
              },
            };
          },
        },
        {
          name: "no_memory_enhancement",
          performanceImpact: "significant",
          operation: async () => ({
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
    ).then((result) => {
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
    });
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
      await this.embeddingProvider.dispose();
      await this.coalaManager.dispose();
      this.recentMemoryCache.clear();
      this.ready = false;
    } catch (error) {
      throw new Error(`Error during MECMF disposal: ${error.message}`);
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
      const oldestKey = Array.from(this.recentMemoryCache.keys())[0];
      this.recentMemoryCache.delete(oldestKey);
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
  scope: IAtlasScope,
  config: MECMFConfig,
): MECMFMemoryManager {
  return new MECMFMemoryManager(scope, config);
}
