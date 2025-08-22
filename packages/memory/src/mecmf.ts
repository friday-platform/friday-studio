/**
 * Memory-Enhanced Context Management Framework (MECMF) for Atlas
 *
 * Main module that exports all MECMF components and provides factory functions
 * for easy integration with Atlas workspaces and agents.
 */

// === Core Interfaces ===
export * from "./mecmf-interfaces.ts";

// === Implementation Components ===
export { createWebEmbeddingProvider, WebEmbeddingProvider } from "./web-embedding-provider.ts";
export { AtlasTokenBudgetManager, createTokenBudgetManager } from "./token-budget-manager.ts";
export { AtlasMemoryClassifier, createMemoryClassifier } from "./memory-classifier.ts";
export { createErrorHandler, MECMFErrorHandler } from "./error-handling.ts";
export {
  createMECMFMemoryManager,
  type MECMFConfig,
  MECMFMemoryManager,
} from "./mecmf-memory-manager.ts";

// === Debug Logging ===
export {
  disableMECMFDebugLogging,
  enableMECMFDebugLogging,
  getGlobalMECMFDebugLogger,
  MECMFDebugLogger,
} from "./debug-logger.ts";
export type { MECMFDebugConfig, PromptEnhancementLog } from "./debug-logger.ts";

// === Integration Helpers ===
import type { MemoryScoper } from "./mecmf-interfaces.ts";
import {
  createMECMFMemoryManager,
  MECMFConfig,
  MECMFMemoryManager,
} from "./mecmf-memory-manager.ts";
import { ConversationContext, MemoryType } from "./mecmf-interfaces.ts";
import { enableMECMFDebugLogging } from "./debug-logger.ts";
import { getMECMFCacheDir } from "../../../src/utils/paths.ts";

/**
 * Quick setup function for MECMF in Atlas workspaces
 */
export async function setupMECMF(
  scope: MemoryScoper,
  options?: Partial<MECMFConfig>,
): Promise<MECMFMemoryManager> {
  const config: MECMFConfig = {
    // Prefer explicit workspaceId, fall back to id for workspace-scoped usage
    workspaceId: scope.workspaceId ?? scope.id,
    enableVectorSearch: true,
    embeddingConfig: {
      cacheDirectory: getMECMFCacheDir(),
      batchSize: 10,
    },
    tokenBudgets: {
      defaultBudget: 8000,
      modelLimits: {
        "claude-3.5-sonnet": 200000,
        "claude-3-sonnet": 200000,
        "claude-3-haiku": 200000,
        "gpt-4-turbo": 128000,
        "gpt-4": 8000,
        "gpt-3.5-turbo": 16000,
      },
    },
    fallbackOptions: {
      enableTextSearch: true,
      cacheRecentMemories: true,
      maxCachedMemories: 100,
    },
    ...options,
  };

  // Enable debug logging if environment variable is set
  if (typeof Deno !== "undefined" && Deno.env.get("MECMF_DEBUG") === "true") {
    enableMECMFDebugLogging({
      logLevel: Deno.env.get("MECMF_DEBUG_LEVEL") || "detailed",
      includeMemoryContent: true,
    });
  }

  const manager = createMECMFMemoryManager(scope, config);
  await manager.initialize();
  return manager;
}

/**
 * Create a conversation context for memory classification
 */
export function createConversationContext(
  sessionId: string,
  workspaceId: string,
  options?: {
    currentTask?: string;
    recentMessages?: string[];
    activeAgents?: string[];
  },
): ConversationContext {
  return {
    sessionId,
    workspaceId,
    currentTask: options?.currentTask,
    recentMessages: options?.recentMessages || [],
    activeAgents: options?.activeAgents || [],
  };
}

/**
 * Utility functions for memory type detection
 */
export const MemoryUtils = {
  /**
   * Check if content is likely to be working memory
   */
  isWorkingMemoryContent(content: string): boolean {
    const workingIndicators = [
      "current",
      "now",
      "today",
      "this session",
      "right now",
      "currently",
      "context",
      "state",
      "status",
      "active",
      "ongoing",
      "immediate",
    ];

    const contentLower = content.toLowerCase();
    return workingIndicators.some((indicator) => contentLower.includes(indicator));
  },

  /**
   * Check if content is likely to be procedural memory
   */
  isProceduralContent(content: string): boolean {
    const proceduralIndicators = [
      "how to",
      "step",
      "process",
      "procedure",
      "method",
      "approach",
      "first",
      "then",
      "next",
      "finally",
      "should",
      "must",
      "do",
    ];

    const contentLower = content.toLowerCase();
    return proceduralIndicators.filter((indicator) => contentLower.includes(indicator)).length >= 2;
  },

  /**
   * Check if content is likely to be semantic memory
   */
  isSemanticContent(content: string): boolean {
    const semanticIndicators = [
      "is",
      "are",
      "definition",
      "means",
      "represents",
      "concept",
      "fact",
      "property",
      "characteristic",
      "always",
      "never",
      "typically",
    ];

    const contentLower = content.toLowerCase();
    return semanticIndicators.filter((indicator) => contentLower.includes(indicator)).length >= 2;
  },

  /**
   * Check if content is likely to be episodic memory
   */
  isEpisodicContent(content: string): boolean {
    const episodicIndicators = [
      "happened",
      "occurred",
      "experienced",
      "tried",
      "learned",
      "yesterday",
      "last time",
      "previously",
      "result",
      "outcome",
      "succeeded",
      "failed",
      "worked",
      "error",
      "mistake",
    ];

    const contentLower = content.toLowerCase();
    return episodicIndicators.some((indicator) => contentLower.includes(indicator));
  },

  /**
   * Suggest memory type based on simple heuristics
   */
  suggestMemoryType(content: string): MemoryType {
    if (this.isWorkingMemoryContent(content)) return MemoryType.WORKING;
    if (this.isProceduralContent(content)) return MemoryType.PROCEDURAL;
    if (this.isSemanticContent(content)) return MemoryType.SEMANTIC;
    if (this.isEpisodicContent(content)) return MemoryType.EPISODIC;

    return MemoryType.WORKING; // Default fallback
  },

  /**
   * Extract key terms from content for tagging
   */
  extractKeyTerms(content: string, maxTerms: number = 5): string[] {
    // Simple term extraction - remove stop words and get meaningful terms
    const stopWords = new Set([
      "the",
      "a",
      "an",
      "and",
      "or",
      "but",
      "in",
      "on",
      "at",
      "to",
      "for",
      "of",
      "with",
      "by",
      "from",
      "up",
      "about",
      "into",
      "through",
      "during",
      "before",
      "after",
      "above",
      "below",
      "between",
      "among",
      "this",
      "that",
      "these",
      "those",
      "i",
      "you",
      "he",
      "she",
      "it",
      "we",
      "they",
      "am",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "could",
      "should",
      "may",
      "might",
    ]);

    const words = content.toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !stopWords.has(word));

    // Count word frequency
    const wordCount = new Map<string, number>();
    words.forEach((word) => {
      wordCount.set(word, (wordCount.get(word) || 0) + 1);
    });

    // Return top terms by frequency
    return Array.from(wordCount.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, maxTerms)
      .map(([word]) => word);
  },

  /**
   * Estimate content complexity for relevance scoring
   */
  estimateContentComplexity(content: string): number {
    const words = content.split(/\s+/).length;
    const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;
    const uniqueWords = new Set(content.toLowerCase().split(/\s+/)).size;

    // Complexity score based on length, sentence structure, and vocabulary diversity
    const lengthScore = Math.min(1, words / 100); // Normalize to 0-1
    const structureScore = sentences > 1 ? Math.min(1, sentences / 10) : 0;
    const diversityScore = words > 0 ? uniqueWords / words : 0;

    return (lengthScore + structureScore + diversityScore) / 3;
  },
};

/**
 * Constants for MECMF configuration
 */
export const MECMFConstants = {
  // Performance expectations from MECMF spec
  PERFORMANCE_TARGETS: {
    MEMORY_RETRIEVAL_LATENCY: 100, // milliseconds
    EMBEDDING_GENERATION_TIME: 30, // milliseconds
    MODEL_LOADING_CACHED: 50, // milliseconds
    MODEL_LOADING_COLD: 3000, // milliseconds
    MEMORY_CONSOLIDATION_TIME: 5000, // milliseconds
    TOKENIZATION_TIME: 5, // milliseconds
  },

  // Token allocation defaults from MECMF spec
  DEFAULT_TOKEN_ALLOCATION: {
    WORKING_MEMORY: 0.40,
    PROCEDURAL_MEMORY: 0.25,
    SEMANTIC_MEMORY: 0.25,
    EPISODIC_MEMORY: 0.10,
  },

  // Resource thresholds
  RESOURCE_THRESHOLDS: {
    MEMORY_PRESSURE_WARNING: 0.85,
    MEMORY_PRESSURE_EMERGENCY: 0.95,
    DISK_PRESSURE_WARNING: 0.90,
    DISK_PRESSURE_EMERGENCY: 0.98,
  },

  // Vector search configuration
  VECTOR_SEARCH: {
    DEFAULT_SIMILARITY_THRESHOLD: 0.4,
    VECTOR_DIMENSION: 384, // all-MiniLM-L6-v2
    BATCH_SIZE: 10,
    MAX_SEQUENCE_LENGTH: 512,
  },
} as const;

/**
 * Version information
 */
export const MECMF_VERSION = {
  version: "1.0.0",
  specification: "MECMF-2025",
  implementation: "Atlas-TypeScript",
  model: "sentence-transformers/all-MiniLM-L6-v2",
} as const;
