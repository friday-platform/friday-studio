/**
 * Local File Vector Search Storage Adapter
 *
 * Stores vector embeddings in local JSON files with similarity search capabilities.
 * Uses cosine similarity for vector comparison.
 */

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { getAtlasHome } from "../../../../src/utils/paths.ts";
import type {
  IVectorSearchStorageAdapter,
  VectorEmbedding,
  VectorIndexStats,
  VectorSearchQuery,
  VectorSearchResult,
} from "../types/vector-search.ts";

interface StoredEmbedding extends VectorEmbedding {
  // Additional storage-specific fields can be added here
}

export class VectorSearchLocalStorageAdapter implements IVectorSearchStorageAdapter {
  private storagePath: string;
  private embeddings: Map<string, StoredEmbedding> = new Map();
  private embeddingsByType: Map<string, Set<string>> = new Map();
  private indexFile: string;
  private statsFile: string;

  constructor(storagePath?: string) {
    if (storagePath) {
      this.storagePath = storagePath;
    } else {
      // Use the centralized getAtlasHome function
      this.storagePath = join(getAtlasHome(), "memory", "vectors");
    }
    this.indexFile = join(this.storagePath, "embeddings.json");
    this.statsFile = join(this.storagePath, "stats.json");
    this.loadFromStorage();
  }

  async upsertEmbeddings(embeddings: VectorEmbedding[]): Promise<void> {
    for (const embedding of embeddings) {
      // Store the embedding
      this.embeddings.set(embedding.id, embedding as StoredEmbedding);

      // Update type index
      const memoryType = embedding.metadata.memoryType;
      if (!this.embeddingsByType.has(memoryType)) {
        this.embeddingsByType.set(memoryType, new Set());
      }
      this.embeddingsByType.get(memoryType)!.add(embedding.id);
    }

    await this.saveToStorage();
  }

  async deleteEmbeddings(ids: string[]): Promise<void> {
    for (const id of ids) {
      const embedding = this.embeddings.get(id);
      if (embedding) {
        // Remove from main index
        this.embeddings.delete(id);

        // Remove from type index
        const memoryType = embedding.metadata.memoryType;
        const typeSet = this.embeddingsByType.get(memoryType);
        if (typeSet) {
          typeSet.delete(id);
          if (typeSet.size === 0) {
            this.embeddingsByType.delete(memoryType);
          }
        }
      }
    }

    await this.saveToStorage();
  }

  search(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    if (!query.vector && !query.query) {
      throw new Error("Either vector or query text must be provided");
    }

    const searchVector = query.vector;
    if (!searchVector) {
      throw new Error(
        "Vector must be provided for search (text-to-vector conversion should be done by embedding provider)",
      );
    }

    const results: VectorSearchResult[] = [];
    const minSimilarity = query.minSimilarity || 0.5;
    const limit = query.limit || 10;

    // Filter embeddings by criteria
    const candidateEmbeddings = this.filterEmbeddings(query);

    // Calculate similarities
    for (const embedding of candidateEmbeddings) {
      const similarity = this.cosineSimilarity(searchVector, embedding.vector);

      if (similarity >= minSimilarity) {
        results.push({
          id: embedding.id,
          memoryId: embedding.metadata.memoryId,
          similarity,
          metadata: embedding.metadata,
        });
      }
    }

    // Sort by similarity (highest first) and limit
    results.sort((a, b) => b.similarity - a.similarity);
    return Promise.resolve(results.slice(0, limit));
  }

  getEmbedding(id: string): Promise<VectorEmbedding | null> {
    return Promise.resolve(this.embeddings.get(id) || null);
  }

  getEmbeddingsByType(memoryType: string): Promise<VectorEmbedding[]> {
    const ids = this.embeddingsByType.get(memoryType);
    if (!ids) return Promise.resolve([]);

    const embeddings: VectorEmbedding[] = [];
    for (const id of ids) {
      const embedding = this.embeddings.get(id);
      if (embedding) {
        embeddings.push(embedding);
      }
    }

    return Promise.resolve(embeddings);
  }

  async clear(): Promise<void> {
    this.embeddings.clear();
    this.embeddingsByType.clear();
    await this.saveToStorage();
  }

  getStats(): Promise<VectorIndexStats> {
    const embeddingsByType: Record<string, number> = {};

    for (const [type, ids] of this.embeddingsByType.entries()) {
      embeddingsByType[type] = ids.size;
    }

    // Calculate approximate index size
    const serializedData = JSON.stringify(Array.from(this.embeddings.values()));
    const indexSize = new TextEncoder().encode(serializedData).length;

    return Promise.resolve({
      totalEmbeddings: this.embeddings.size,
      embeddingsByType,
      indexSize,
      lastUpdated: new Date(),
    });
  }

  private filterEmbeddings(query: VectorSearchQuery): StoredEmbedding[] {
    let candidates = Array.from(this.embeddings.values());

    // Filter by memory types
    if (query.memoryTypes && query.memoryTypes.length > 0) {
      candidates = candidates.filter((e) => query.memoryTypes!.includes(e.metadata.memoryType));
    }

    // Filter by tags
    if (query.tags && query.tags.length > 0) {
      candidates = candidates.filter((e) =>
        query.tags!.some((tag) => e.metadata.tags.includes(tag))
      );
    }

    // Filter by source scope
    if (query.sourceScope) {
      candidates = candidates.filter((e) => e.metadata.sourceScope === query.sourceScope);
    }

    return candidates;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error("Vectors must have the same dimension");
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (normA * normB);
  }

  private async loadFromStorage(): Promise<void> {
    try {
      const content = await Deno.readTextFile(this.indexFile);
      if (content.trim()) {
        const data = JSON.parse(content) as StoredEmbedding[];

        // Rebuild indexes
        this.embeddings.clear();
        this.embeddingsByType.clear();

        for (const embedding of data) {
          // Convert timestamp strings back to Date objects
          embedding.metadata.timestamp = new Date(embedding.metadata.timestamp);

          this.embeddings.set(embedding.id, embedding);

          const memoryType = embedding.metadata.memoryType;
          if (!this.embeddingsByType.has(memoryType)) {
            this.embeddingsByType.set(memoryType, new Set());
          }
          this.embeddingsByType.get(memoryType)!.add(embedding.id);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        console.warn(
          `Failed to load vector index: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // File doesn't exist or is corrupted, start with empty index
    }
  }

  private async saveToStorage(): Promise<void> {
    await ensureDir(this.storagePath);

    // Save embeddings
    const embeddingsArray = Array.from(this.embeddings.values());
    await Deno.writeTextFile(
      this.indexFile,
      JSON.stringify(embeddingsArray, null, 2),
    );

    // Save stats
    const stats = await this.getStats();
    await Deno.writeTextFile(
      this.statsFile,
      JSON.stringify(stats, null, 2),
    );
  }
}
