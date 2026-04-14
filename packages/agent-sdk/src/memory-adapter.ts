/**
 * Memory Adapter Interface
 *
 * Corpus-typed memory with swappable backends. A thin MemoryAdapter router
 * hands out kind-typed Corpus handles. Every corpus write emits a typed
 * AtlasDataEvent and records a version.
 *
 * From parity plan v6, lines 582-652.
 */

import { z } from "zod";

// ── Zod schemas for wire-serialisable types ─────────────────────────────────

export const NarrativeEntrySchema = z.object({
  id: z.string(),
  text: z.string(),
  author: z.string().optional(),
  createdAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const SearchOptsSchema = z.object({ limit: z.number().int().optional() });

export const DocBatchSchema = z.object({
  docs: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

export const IngestOptsSchema = z.object({
  chunker: z.string().optional(),
  embedder: z.string().optional(),
});

export const IngestResultSchema = z.object({
  ingested: z.number().int(),
  skipped: z.number().int(),
});

export const RetrievalQuerySchema = z.object({
  text: z.string(),
  topK: z.number().int().optional(),
});

export const RetrievalOptsSchema = z.object({
  filter: z.record(z.string(), z.unknown()).optional(),
});

export const HitSchema = z.object({
  id: z.string(),
  score: z.number(),
  text: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const RetrievalStatsSchema = z.object({
  count: z.number().int(),
  sizeBytes: z.number().int(),
});

export const HistoryFilterSchema = z.object({
  corpus: z.string().optional(),
  since: z.string().optional(),
  limit: z.number().int().optional(),
});

export const HistoryEntrySchema = z.object({
  version: z.string(),
  corpus: z.string(),
  at: z.string(),
  summary: z.string(),
});

export const CorpusMetadataSchema = z.object({
  name: z.string(),
  kind: z.enum(["narrative", "retrieval", "dedup", "kv"]),
  workspaceId: z.string(),
});

// ── TypeScript types (authoritative — verbatim from plan) ───────────────────

export type CorpusKind = "narrative" | "retrieval" | "dedup" | "kv";

export interface NarrativeEntry {
  id: string;
  text: string;
  author?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface SearchOpts {
  limit?: number;
}
export interface DocBatch {
  docs: Array<{ id: string; text: string; metadata?: Record<string, unknown> }>;
}
export interface IngestOpts {
  chunker?: string;
  embedder?: string;
}
export interface IngestResult {
  ingested: number;
  skipped: number;
}
export interface RetrievalQuery {
  text: string;
  topK?: number;
}
export interface RetrievalOpts {
  filter?: Record<string, unknown>;
}
export interface Hit {
  id: string;
  score: number;
  text: string;
  metadata?: Record<string, unknown>;
}
export interface RetrievalStats {
  count: number;
  sizeBytes: number;
}
export interface DedupEntry {
  [field: string]: unknown;
}
export interface HistoryFilter {
  corpus?: string;
  since?: string;
  limit?: number;
}
export interface HistoryEntry {
  version: string;
  corpus: string;
  at: string;
  summary: string;
}
export interface CorpusMetadata {
  name: string;
  kind: CorpusKind;
  workspaceId: string;
}

export interface NarrativeCorpus {
  append(entry: NarrativeEntry): Promise<NarrativeEntry>;
  read(opts?: { since?: string; limit?: number }): Promise<NarrativeEntry[]>;
  search(query: string, opts?: SearchOpts): Promise<NarrativeEntry[]>;
  forget(id: string): Promise<void>;
  render(): Promise<string>;
}

export interface RetrievalCorpus {
  ingest(docs: DocBatch, opts?: IngestOpts): Promise<IngestResult>;
  query(q: RetrievalQuery, opts?: RetrievalOpts): Promise<Hit[]>;
  stats(): Promise<RetrievalStats>;
  reset(): Promise<void>;
}

export interface DedupCorpus {
  append(namespace: string, entry: DedupEntry, ttlHours?: number): Promise<void>;
  filter(namespace: string, field: string, values: unknown[]): Promise<unknown[]>;
  clear(namespace: string): Promise<void>;
}

export interface KVCorpus {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export type CorpusOf<K extends CorpusKind> = K extends "narrative"
  ? NarrativeCorpus
  : K extends "retrieval"
    ? RetrievalCorpus
    : K extends "dedup"
      ? DedupCorpus
      : K extends "kv"
        ? KVCorpus
        : never;

export interface MemoryAdapter {
  /** Open or create a named corpus. Backend resolved per-corpus from config. */
  corpus<K extends CorpusKind>(workspaceId: string, name: string, kind: K): Promise<CorpusOf<K>>;

  /** Enumerate corpora registered in this workspace. */
  list(workspaceId: string): Promise<CorpusMetadata[]>;

  /** Bootstrap block injected into agent system prompt at session start.
   *  A *view* over one or more narrative corpora. */
  bootstrap(workspaceId: string, agentId: string): Promise<string>;

  /** Versioned history — leapfrog dimension #2. */
  history(workspaceId: string, filter?: HistoryFilter): Promise<HistoryEntry[]>;
  rollback(workspaceId: string, corpus: string, toVersion: string): Promise<void>;
}
