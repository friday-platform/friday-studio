/**
 * Three-Scope Memory Model
 *
 * Canonical reference for the memory scope taxonomy:
 *   1. GLOBAL — synthetic workspace id "_global", write-gated to kernel/instance-admin
 *   2. PER-WORKSPACE — owned by exactly one workspace, stored at ~/.atlas/memory/{wsId}/
 *   3. MOUNTED — runtime alias resolved by MountRegistry from workspace.yml mounts
 *
 * MountRegistry is an index + lifecycle tracker populated eagerly at workspace
 * config load. It is NOT a write path — consumers declare mounts in workspace.yml.
 *
 * From the OpenClaw parity plan v6, three-scope design memo.
 */

import { z } from "zod";

// ── Zod schemas ─────────────────────────────────────────────────────────────

export const CorpusKindSchema = z.enum(["narrative", "retrieval", "dedup", "kv"]);

export const MountDeclarationSchema = z.object({
  alias: z.string().min(1),
  sourceWorkspaceId: z.string().min(1),
  sourceCorpus: z.string().min(1),
  mode: z.enum(["read", "readwrite"]),
});

export const WorkspaceMemoryConfigSchema = z.object({
  mounts: z.array(MountDeclarationSchema).optional(),
});

// ── TypeScript types ────────────────────────────────────────────────────────

export type MemoryScopeKind = "global" | "per-workspace" | "mounted";

export type MountMode = "read" | "readwrite";

export interface MountDeclaration {
  alias: string;
  sourceWorkspaceId: string;
  sourceCorpus: string;
  mode: MountMode;
}

export interface ResolvedMount extends MountDeclaration {
  consumerWorkspaceId: string;
  resolvedAt: string;
}

export interface MountRegistry {
  resolve(consumerWorkspaceId: string, decl: MountDeclaration): Promise<ResolvedMount>;
  release(consumerWorkspaceId: string, alias: string): Promise<void>;
  list(filter?: {
    consumerWorkspaceId?: string;
    sourceWorkspaceId?: string;
  }): Promise<ResolvedMount[]>;
}
