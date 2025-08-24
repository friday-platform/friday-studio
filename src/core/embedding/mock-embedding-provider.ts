/**
 * Mock Embedding Provider for Development and Testing
 *
 * Provides deterministic embeddings for testing vector search functionality.
 * In production, this should be replaced with a real embedding service.
 */

import type { IEmbeddingProvider } from "../../types/vector-search.ts";

export class MockEmbeddingProvider implements IEmbeddingProvider {
  private dimension: number;
  private modelInfo: string;

  constructor(dimension: number = 384) {
    this.dimension = dimension;
    this.modelInfo = `mock-embeddings-v1-${dimension}d`;
  }

  generateEmbedding(text: string): Promise<number[]> {
    return Promise.resolve(this.generateDeterministicEmbedding(text));
  }

  generateEmbeddings(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.generateDeterministicEmbedding(text)));
  }

  getDimension(): number {
    return this.dimension;
  }

  getModelInfo(): string {
    return this.modelInfo;
  }

  /**
   * Generate a deterministic embedding based on text content
   * This creates embeddings that will be similar for similar texts
   */
  private generateDeterministicEmbedding(text: string): number[] {
    const normalizedText = text.toLowerCase().trim();

    // Simple hash-based approach for deterministic embeddings
    const embedding = new Array(this.dimension).fill(0);

    // Character frequency analysis
    const charFreq = new Map<string, number>();
    for (const char of normalizedText) {
      charFreq.set(char, (charFreq.get(char) || 0) + 1);
    }

    // Word frequency analysis
    const words = normalizedText.split(/\s+/).filter((w) => w.length > 0);
    const wordFreq = new Map<string, number>();
    for (const word of words) {
      wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
    }

    // Generate embedding components
    let index = 0;

    // Text length features
    embedding[index++] = Math.tanh(normalizedText.length / 100);
    embedding[index++] = Math.tanh(words.length / 20);

    // Character features
    const chars = Array.from(charFreq.keys()).sort();
    for (let i = 0; i < Math.min(chars.length, 50) && index < this.dimension; i++) {
      const char = chars[i];
      const charCount = charFreq.get(char);
      if (!charCount) continue;
      const freq = charCount / normalizedText.length;
      embedding[index++] = Math.tanh(freq * 10);
    }

    // Word features
    const sortedWords = Array.from(wordFreq.keys()).sort();
    for (let i = 0; i < Math.min(sortedWords.length, 100) && index < this.dimension; i++) {
      const word = sortedWords[i];
      const wordCount = wordFreq.get(word);
      if (!wordCount) continue;
      const freq = wordCount / words.length;

      // Hash word to get consistent position
      const wordHash = this.simpleHash(word);
      const position = Math.abs(wordHash) % (this.dimension - index);

      if (index + position < this.dimension) {
        embedding[index + position] += Math.tanh(freq * 5);
      }
    }

    // Fill remaining positions with text-based patterns
    while (index < this.dimension) {
      const hash = this.simpleHash(normalizedText + index.toString());
      embedding[index] = Math.sin(hash / 1000000) * 0.1;
      index++;
    }

    // Normalize to unit vector
    const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    if (norm > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= norm;
      }
    }

    return embedding;
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash;
  }
}

/**
 * Factory function to create embedding provider based on configuration
 */
export function createEmbeddingProvider(config?: {
  provider?: "mock" | "openai" | "cohere" | "local";
  dimension?: number;
  apiKey?: string;
  model?: string;
}): IEmbeddingProvider {
  const { provider = "mock", dimension = 384 } = config || {};

  switch (provider) {
    case "mock":
      return new MockEmbeddingProvider(dimension);

    // TODO: Implement real embedding providers
    case "openai":
      throw new Error("OpenAI embedding provider not yet implemented");

    case "cohere":
      throw new Error("Cohere embedding provider not yet implemented");

    case "local":
      throw new Error("Local embedding provider not yet implemented");

    default:
      throw new Error(`Unknown embedding provider: ${provider}`);
  }
}
