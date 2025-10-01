/**
 * Vector Search Types and Interfaces for Atlas Memory System
 *
 * Provides vector embedding and similarity search capabilities for
 * EPISODIC, SEMANTIC, and PROCEDURAL memory types.
 */

import { z } from "zod";

// Zod schemas for type-safe storage and loading from disk
const VectorEmbeddingMetadataSchema = z.object({
  memoryId: z.string(),
  memoryType: z.string(),
  content: z.string(),
  timestamp: z.coerce.date(),
  sourceScope: z.string(),
  tags: z.array(z.string()),
});

export const VectorEmbeddingSchema = z.object({
  id: z.string(),
  vector: z.array(z.number()),
  metadata: VectorEmbeddingMetadataSchema,
});

export type VectorEmbedding = z.infer<typeof VectorEmbeddingSchema>;

const VectorSearchQuerySchema = z.object({
  query: z.string(),
  vector: z.array(z.number()).optional(),
  memoryTypes: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  sourceScope: z.string().optional(),
  minSimilarity: z.number().optional(),
  limit: z.number().optional(),
  includeMetadata: z.boolean().optional(),
});

export type VectorSearchQuery = z.infer<typeof VectorSearchQuerySchema>;

const VectorSearchResultSchema = z.object({
  id: z.string(),
  memoryId: z.string(),
  similarity: z.number(),
  metadata: VectorEmbeddingMetadataSchema,
});

export type VectorSearchResult = z.infer<typeof VectorSearchResultSchema>;

/**
 * Interface for vector search index storage
 */
export interface IVectorSearchStorageAdapter {
  /**
   * Add or update vector embeddings in the index
   */
  upsertEmbeddings(embeddings: VectorEmbedding[]): Promise<void>;

  /**
   * Remove embeddings from the index
   */
  deleteEmbeddings(ids: string[]): Promise<void>;

  /**
   * Search for similar vectors
   */
  search(query: VectorSearchQuery): Promise<VectorSearchResult[]>;

  /**
   * Get embedding by ID
   */
  getEmbedding(id: string): Promise<VectorEmbedding | null>;

  /**
   * Get all embeddings for a memory type
   */
  getEmbeddingsByType(memoryType: string): Promise<VectorEmbedding[]>;

  /**
   * Clear all embeddings
   */
  clear(): Promise<void>;

  /**
   * Get index statistics
   */
  getStats(): Promise<VectorIndexStats>;
}

const VectorIndexStatsSchema = z.object({
  totalEmbeddings: z.number(),
  embeddingsByType: z.record(z.string(), z.number()),
  indexSize: z.number(),
  lastUpdated: z.coerce.date(),
});

export type VectorIndexStats = z.infer<typeof VectorIndexStatsSchema>;

/**
 * Interface for generating embeddings from text
 */
export interface IEmbeddingProvider {
  /**
   * Generate embeddings for text content
   */
  generateEmbedding(text: string): Promise<number[]>;

  /**
   * Get the embedding dimension
   */
  getDimension(): number;

  /**
   * Get the model name/version
   */
  getModelInfo(): string;
}

/**
 * Configuration for vector search
 */
export interface VectorSearchConfig {
  embeddingProvider: IEmbeddingProvider;
  storageAdapter: IVectorSearchStorageAdapter;
  enabledMemoryTypes: string[];
  autoIndexOnWrite: boolean;
  batchSize: number;
  similarityThreshold: number;
}
