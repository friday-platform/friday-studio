/**
 * Embedding helper using Fireworks nomic-embed-text-v1.5 (768 dims).
 * Uses @ai-sdk/fireworks@1.0.35 (spec v2, compatible with ai@5.x).
 */
import process from "node:process";
import { createFireworks } from "@ai-sdk/fireworks";
import { embed, embedMany } from "ai";

const EMBEDDING_MODEL = "nomic-ai/nomic-embed-text-v1.5";
const MAX_PARALLEL_CALLS = 32;

function getModel(env?: Record<string, string>) {
  const apiKey = env?.FIREWORKS_API_KEY ?? process.env.FIREWORKS_API_KEY;
  if (!apiKey) throw new Error("FIREWORKS_API_KEY is required for embeddings");
  const fw = createFireworks({ apiKey });
  return fw.textEmbeddingModel(EMBEDDING_MODEL);
}

/** Embed a single query string. Returns a 768-dim float array. */
export async function embedQuery(text: string, env?: Record<string, string>): Promise<number[]> {
  const { embedding } = await embed({ model: getModel(env), value: text });
  return embedding;
}

/**
 * Embed multiple texts. The AI SDK's embedMany handles chunking
 * (via maxEmbeddingsPerCall from the provider) and parallelization
 * (via maxParallelCalls) internally.
 */
export async function embedBatch(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
  env?: Record<string, string>,
): Promise<number[][]> {
  const model = getModel(env);

  // Fireworks accepts up to 256 items per request, but the total token
  // count across all items also has a limit. With texts up to 2000 chars
  // (~500 tokens each), 256 items = ~128K tokens — well over the batch
  // token budget. Use 64 items per batch (~32K tokens) to stay safe.
  const BATCH_SIZE = 64;
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    batches.push(texts.slice(i, i + BATCH_SIZE));
  }

  const allEmbeddings: number[][] = new Array(texts.length);
  let completed = 0;

  for (let g = 0; g < batches.length; g += MAX_PARALLEL_CALLS) {
    const group = batches.slice(g, g + MAX_PARALLEL_CALLS);
    const results = await Promise.all(group.map((batch) => embedMany({ model, values: batch })));

    for (const [j, result] of results.entries()) {
      const offset = (g + j) * BATCH_SIZE;
      for (const [k, embedding] of result.embeddings.entries()) {
        allEmbeddings[offset + k] = embedding;
      }
    }

    completed += group.reduce((s, b) => s + b.length, 0);
    onProgress?.(Math.min(completed, texts.length), texts.length);
  }

  return allEmbeddings;
}

/** Convert a number[] embedding to a Uint8Array for SQLite BLOB storage. */
export function embeddingToBlob(embedding: number[]): Uint8Array {
  const buf = new ArrayBuffer(embedding.length * 4);
  const view = new DataView(buf);
  for (let i = 0; i < embedding.length; i++) {
    view.setFloat32(i * 4, embedding[i] ?? 0, true);
  }
  return new Uint8Array(buf);
}

/** Convert a SQLite BLOB back to a number[] embedding. */
export function blobToEmbedding(blob: Uint8Array): number[] {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const embedding: number[] = [];
  for (let i = 0; i < blob.byteLength; i += 4) {
    embedding.push(view.getFloat32(i, true));
  }
  return embedding;
}
