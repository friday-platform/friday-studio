/**
 * Memory Adapter Interface
 *
 * Store-typed memory with swappable backends. A thin MemoryAdapter router
 * hands out kind-typed Store handles. Every store write emits a typed
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
  createdAt: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const SearchOptsSchema = z.object({ limit: z.number().int().optional() });

export const RetrievalOptsSchema = z.object({
  filter: z.record(z.string(), z.unknown()).optional(),
});

export const DedupEntrySchema = z.record(z.string(), z.unknown());

export const HistoryFilterSchema = z.object({
  store: z.string().optional(),
  since: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

export const HistoryEntrySchema = z.object({
  version: z.string(),
  store: z.string(),
  at: z.string(),
  summary: z.string(),
});

export const StoreMetadataSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["narrative", "retrieval", "dedup", "kv"]),
  workspaceId: z.string().min(1),
});

export const StatusMetadataSchema = z.object({
  status: z.enum(["in_progress", "completed", "blocked"]),
  task_id: z.string().optional(),
  dispatched_session_id: z.string().optional(),
});

// ── Reflection-specific schemas (for store entries written by the reflector) ─

export const ReflectionMetadataSchema = z.object({
  target_workspace_id: z.string(),
  target_session_id: z.string(),
  finding_type: z.enum(["SKILL_GAP", "PROCESS_DRIFT", "ANOMALY", "INFO"]),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
  proposed_action: z.string(),
});

export const ReflectionNarrativeEntrySchema = z.object({
  id: z.string().uuid(),
  text: z.string().min(1),
  author: z.literal("reflector"),
  createdAt: z.string().datetime(),
  metadata: ReflectionMetadataSchema,
});

// ── TypeScript types (authoritative — verbatim from plan) ───────────────────

export type StoreKind = "narrative" | "retrieval" | "dedup" | "kv";

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
  store?: string;
  since?: string;
  limit?: number;
}
export interface HistoryEntry {
  version: string;
  store: string;
  at: string;
  summary: string;
}
export interface StoreMetadata {
  name: string;
  kind: StoreKind;
  workspaceId: string;
}

export interface NarrativeStore {
  append(entry: NarrativeEntry): Promise<NarrativeEntry>;
  read(opts?: { since?: string; limit?: number }): Promise<NarrativeEntry[]>;
  search(query: string, opts?: SearchOpts): Promise<NarrativeEntry[]>;
  forget(id: string): Promise<void>;
  render(): Promise<string>;
}

export interface RetrievalStore {
  ingest(docs: DocBatch, opts?: IngestOpts): Promise<IngestResult>;
  query(q: RetrievalQuery, opts?: RetrievalOpts): Promise<Hit[]>;
  stats(): Promise<RetrievalStats>;
  reset(): Promise<void>;
}

export interface DedupStore {
  append(namespace: string, entry: DedupEntry, ttlHours?: number): Promise<void>;
  filter(namespace: string, field: string, values: unknown[]): Promise<unknown[]>;
  clear(namespace: string): Promise<void>;
}

export interface KVStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export type StoreOf<K extends StoreKind> = K extends "narrative"
  ? NarrativeStore
  : K extends "retrieval"
    ? RetrievalStore
    : K extends "dedup"
      ? DedupStore
      : K extends "kv"
        ? KVStore
        : never;

export interface MemoryAdapter {
  /** Open or create a named store. Backend resolved per-store from config. */
  store<K extends StoreKind>(workspaceId: string, name: string, kind: K): Promise<StoreOf<K>>;

  /** Enumerate stores registered in this workspace. */
  list(workspaceId: string): Promise<StoreMetadata[]>;

  /** Bootstrap block injected into agent system prompt at session start.
   *  A *view* over one or more narrative stores. */
  bootstrap(workspaceId: string, agentId: string): Promise<string>;

  /** Versioned history — leapfrog dimension #2. */
  history(workspaceId: string, filter?: HistoryFilter): Promise<HistoryEntry[]>;
  rollback(workspaceId: string, store: string, toVersion: string): Promise<void>;
}
