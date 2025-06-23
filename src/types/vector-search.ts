/**
 * Vector Search Types and Interfaces for Atlas Memory System
 *
 * Provides vector embedding and similarity search capabilities for
 * EPISODIC, SEMANTIC, and PROCEDURAL memory types.
 */

export interface VectorEmbedding {
  id: string;
  vector: number[];
  metadata: {
    memoryId: string;
    memoryType: string;
    content: string;
    timestamp: Date;
    sourceScope: string;
    tags: string[];
  };
}

export interface VectorSearchQuery {
  query: string;
  vector?: number[];
  memoryTypes?: string[];
  tags?: string[];
  sourceScope?: string;
  minSimilarity?: number;
  limit?: number;
  includeMetadata?: boolean;
}

export interface VectorSearchResult {
  id: string;
  memoryId: string;
  similarity: number;
  metadata: VectorEmbedding["metadata"];
}

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

export interface VectorIndexStats {
  totalEmbeddings: number;
  embeddingsByType: Record<string, number>;
  indexSize: number;
  lastUpdated: Date;
}

/**
 * Interface for generating embeddings from text
 */
export interface IEmbeddingProvider {
  /**
   * Generate embeddings for text content
   */
  generateEmbedding(text: string): Promise<number[]>;

  /**
   * Generate embeddings for multiple texts
   */
  generateEmbeddings(texts: string[]): Promise<number[][]>;

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
