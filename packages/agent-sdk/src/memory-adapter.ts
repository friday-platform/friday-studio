/**
 * Memory Adapter Interface
 *
 * Narrative-only after the 2026-05 cleanup. Retrieval/dedup/kv strategies
 * removed; the only Store kind is markdown narrative.
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
  kind: z.literal("narrative"),
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

// ── TypeScript types ────────────────────────────────────────────────────────

export type StoreKind = "narrative";

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

export type StoreOf = NarrativeStore;

export interface MemoryAdapter {
  /** Open or create a named narrative store. */
  store(workspaceId: string, name: string): Promise<NarrativeStore>;

  /** Enumerate stores registered in this workspace. */
  list(workspaceId: string): Promise<StoreMetadata[]>;

  /** Bootstrap block injected into agent system prompt at session start.
   *  A *view* over one or more narrative stores. */
  bootstrap(workspaceId: string, agentId: string): Promise<string>;

  /** Versioned history — leapfrog dimension #2. */
  history(workspaceId: string, filter?: HistoryFilter): Promise<HistoryEntry[]>;
  rollback(workspaceId: string, store: string, toVersion: string): Promise<void>;
}
