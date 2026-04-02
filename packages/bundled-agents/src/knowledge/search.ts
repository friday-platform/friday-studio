/**
 * Hybrid search: BM25 (FTS5) + Vector (cosine similarity) + RRF merge.
 */

import type { Database } from "@db/sqlite";
import { blobToEmbedding, embedQuery } from "./embed.ts";

export interface SearchResult {
  id: number;
  title: string;
  content: string;
  response: string | null;
  url: string | null;
  sourceType: string;
  score: number;
}

export interface EmbeddingCache {
  ids: number[];
  embeddings: Float32Array[];
}

/** Cosine similarity between a number[] query vector and a Float32Array corpus vector. */
export function cosineSimilarity(a: number[], b: Float32Array): number {
  const n = a.length;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  return magA === 0 || magB === 0 ? 0 : dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// Module-level cache: avoids reloading embeddings from SQLite per request.
// Keyed by corpus file path so a reindex with a new corpus invalidates correctly.
let _cachedEmbeddings: { path: string; cache: EmbeddingCache } | undefined;

/**
 * Load all embeddings from the corpus into memory for vector search.
 * Results are cached at module level — subsequent calls with the same
 * corpusPath return instantly.
 */
export function loadEmbeddings(db: Database, corpusPath?: string): EmbeddingCache {
  if (_cachedEmbeddings && corpusPath && _cachedEmbeddings.path === corpusPath) {
    return _cachedEmbeddings.cache;
  }

  // Load in chunks using keyset pagination (WHERE id > ? ORDER BY id LIMIT ?)
  // instead of .all(). Benchmarked 3x faster (514ms vs 1557ms for 151K rows)
  // and avoids a ~1 GB RSS spike from materializing all Uint8Array blobs at once.
  const LOAD_CHUNK = 10000;
  const ids: number[] = [];
  const embeddings: Float32Array[] = [];
  let lastId = 0;

  const stmt = db.prepare(
    "SELECT id, embedding FROM documents WHERE embedding IS NOT NULL AND id > ? ORDER BY id LIMIT ?",
  );

  while (true) {
    const chunk = stmt.all<{ id: number; embedding: Uint8Array }>(lastId, LOAD_CHUNK);
    if (chunk.length === 0) break;
    for (const row of chunk) {
      ids.push(row.id);
      embeddings.push(blobToEmbedding(row.embedding));
      lastId = row.id;
    }
  }

  stmt.finalize?.();

  const cache = { ids, embeddings };
  if (corpusPath) {
    _cachedEmbeddings = { path: corpusPath, cache };
  }
  return cache;
}

/** Invalidate the embedding cache (e.g., after a reindex). */
export function invalidateEmbeddingCache(): void {
  _cachedEmbeddings = undefined;
}

/**
 * Sanitize a query string for FTS5 MATCH: strip special chars, reserved words,
 * then rejoin meaningful tokens with OR for broad recall.
 */
export function sanitizeFtsQuery(query: string): string | null {
  const sanitized = query
    .replace(/[""()*/\\?!.,:;@#$%^&+={}[\]~`<>]/g, " ")
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = sanitized.split(" ").filter((w) => w.length >= 3);
  if (tokens.length === 0) return null;
  return tokens.join(" OR ");
}

type RawSearchRow = {
  id: number;
  title: string;
  content: string;
  response: string | null;
  url: string | null;
  source_type: string;
  score: number;
};

function rowToResult(r: RawSearchRow): SearchResult {
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    response: r.response,
    url: r.url,
    sourceType: r.source_type,
    score: r.score,
  };
}

/**
 * BM25 full-text search via FTS5 with source-type diversity.
 *
 * Tickets vastly outnumber KB articles (~47K vs ~250), so pure BM25 ranking
 * buries KB articles. We run a single query then ensure at least `kbMinSlots`
 * KB articles are included by backfilling from a KB-only query.
 */
interface Bm25Result {
  results: SearchResult[];
  error?: string;
}

function bm25Search(db: Database, query: string, limit = 20): Bm25Result {
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return { results: [], error: "empty query after sanitization" };

  const kbMinSlots = 5;

  try {
    // Main BM25 query
    const allResults = db
      .prepare(
        `SELECT d.id, d.title, d.content, d.response, d.url, d.source_type,
          bm25(documents_fts, 5.0, 1.0, 0.5) as score
        FROM documents_fts
        JOIN documents d ON documents_fts.rowid = d.id
        WHERE documents_fts MATCH ?
        ORDER BY score
        LIMIT ?`,
      )
      .all<RawSearchRow>(ftsQuery, limit);

    const kbInMain = allResults.filter((r) => r.source_type !== "ticket");

    // If KB articles are underrepresented, backfill from KB-only query
    if (kbInMain.length < kbMinSlots) {
      const existingIds = new Set(allResults.map((r) => r.id));
      const kbExtra = db
        .prepare(
          `SELECT d.id, d.title, d.content, d.response, d.url, d.source_type,
            bm25(documents_fts, 5.0, 1.0, 0.5) as score
          FROM documents_fts
          JOIN documents d ON documents_fts.rowid = d.id
          WHERE documents_fts MATCH ? AND d.source_type != 'ticket'
          ORDER BY score
          LIMIT ?`,
        )
        .all<RawSearchRow>(ftsQuery, kbMinSlots - kbInMain.length);

      for (const r of kbExtra) {
        if (!existingIds.has(r.id)) {
          allResults.push(r);
        }
      }
    }

    return { results: allResults.map(rowToResult) };
  } catch (error: unknown) {
    // FTS5 MATCH can fail on malformed queries — fall back to LIKE
    const msg = error instanceof Error ? error.message : String(error);

    const sanitized = query
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[%_\\]/g, "\\$&");
    const likePattern = `%${sanitized}%`;
    const likeResults = db
      .prepare(
        `SELECT id, title, content, response, url, source_type, 0 as score
        FROM documents
        WHERE title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
        ORDER BY id LIMIT ?`,
      )
      .all<RawSearchRow>(likePattern, likePattern, limit)
      .map(rowToResult);
    return {
      results: likeResults,
      error: `FTS5 MATCH '${ftsQuery}' failed: ${msg}. LIKE fallback: ${likeResults.length}`,
    };
  }
}

/** Vector similarity search using in-memory embeddings. */
async function vectorSearch(
  queryText: string,
  cache: EmbeddingCache,
  db: Database,
  limit = 20,
  env?: Record<string, string>,
): Promise<SearchResult[]> {
  const queryEmb = await embedQuery(queryText, env);

  // Score all documents by cosine similarity
  const scored: Array<{ id: number; similarity: number }> = [];
  for (let i = 0; i < cache.ids.length; i++) {
    const emb = cache.embeddings[i];
    const id = cache.ids[i];
    if (emb && id !== undefined) {
      scored.push({ id, similarity: cosineSimilarity(queryEmb, emb) });
    }
  }

  // Sort by similarity descending, take top N
  scored.sort((a, b) => b.similarity - a.similarity);
  const topIds = scored.slice(0, limit);

  // Fetch full documents
  const results: SearchResult[] = [];
  for (const { id, similarity } of topIds) {
    const row = db
      .prepare("SELECT id, title, content, response, url, source_type FROM documents WHERE id = ?")
      .get<{
        id: number;
        title: string;
        content: string;
        response: string | null;
        url: string | null;
        source_type: string;
      }>(id);
    if (row) {
      results.push({
        id: row.id,
        title: row.title,
        content: row.content,
        response: row.response,
        url: row.url,
        sourceType: row.source_type,
        score: similarity,
      });
    }
  }
  return results;
}

/**
 * Reciprocal Rank Fusion: merge BM25 and vector results with source-type diversity.
 *
 * RRF_score = sum(1 / (k + rank_i)) across all result lists.
 *
 * KB articles (~250) are dwarfed by tickets (~47K) so pure RRF buries them.
 * We reserve `kbMinSlots` slots for the top-scoring KB/confluence articles to
 * ensure the reranker and LLM always see authoritative documentation alongside
 * past tickets.
 */
export function reciprocalRankFusion(
  bm25Results: SearchResult[],
  vecResults: SearchResult[],
  k = 60,
  limit = 15,
): SearchResult[] {
  const scores = new Map<number, number>();
  const docsById = new Map<number, SearchResult>();

  for (const [rank, r] of bm25Results.entries()) {
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + rank + 1));
    docsById.set(r.id, r);
  }
  for (const [rank, r] of vecResults.entries()) {
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + rank + 1));
    docsById.set(r.id, r);
  }

  const sorted = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => {
      const doc = docsById.get(id);
      if (!doc) throw new Error(`Document ${id} not found`);
      return { ...doc, score };
    });

  // Apply source-type diversity: ensure KB articles appear in results
  const kbMinSlots = 3;
  const result: SearchResult[] = [];
  const kbResults: SearchResult[] = [];
  const seenIds = new Set<number>();

  for (const r of sorted) {
    if (r.sourceType !== "ticket") {
      kbResults.push(r);
    }
  }

  // Take top results up to (limit - reserved KB slots)
  const kbAlreadyInTop = sorted.slice(0, limit).filter((r) => r.sourceType !== "ticket").length;
  const kbSlotsNeeded = Math.max(0, kbMinSlots - kbAlreadyInTop);
  const mainSlots = limit - kbSlotsNeeded;

  for (const r of sorted) {
    if (result.length >= mainSlots) break;
    result.push(r);
    seenIds.add(r.id);
  }

  // Backfill with top KB articles not already included
  for (const r of kbResults) {
    if (result.length >= limit) break;
    if (!seenIds.has(r.id)) {
      result.push(r);
      seenIds.add(r.id);
    }
  }

  return result;
}

/**
 * Hybrid search: BM25 + Vector + RRF merge.
 * Returns top candidates ready for reranking.
 */
export async function hybridSearch(
  query: string,
  db: Database,
  embeddingCache: EmbeddingCache,
  options?: {
    bm25Limit?: number;
    vecLimit?: number;
    rrfLimit?: number;
    env?: Record<string, string>;
  },
): Promise<{ results: SearchResult[]; bm25Count: number; vecCount: number; bm25Error?: string }> {
  const bm25Limit = options?.bm25Limit ?? 20;
  const vecLimit = options?.vecLimit ?? 20;
  const rrfLimit = options?.rrfLimit ?? 15;

  // Run BM25 and vector search in parallel
  const [bm25Result, vecResults] = await Promise.all([
    Promise.resolve(bm25Search(db, query, bm25Limit)),
    vectorSearch(query, embeddingCache, db, vecLimit, options?.env),
  ]);

  // Merge with RRF
  const merged = reciprocalRankFusion(bm25Result.results, vecResults, 60, rrfLimit);

  return {
    results: merged,
    bm25Count: bm25Result.results.length,
    vecCount: vecResults.length,
    bm25Error: bm25Result.error,
  };
}
