/**
 * Three-Scope Memory Model
 *
 * Canonical source for the memory scope taxonomy:
 *   1. GLOBAL  — synthetic workspace id "_global", write-gated to kernel
 *   2. PER-WORKSPACE — owned by exactly one workspace at ~/.atlas/memory/{wsId}/
 *   3. MOUNTED — runtime alias resolved by MountRegistry from workspace.yml mounts
 *
 * The MemoryAdapter interface is scope-agnostic at the call site. The
 * workspaceId parameter is the scope discriminator:
 *   - "_global"      → GLOBAL scope, write-gated
 *   - "<real-slug>"  → PER-WORKSPACE or MOUNTED (MountRegistry resolves)
 *
 * From the OpenClaw parity plan v6, three-scope design memo.
 */

import { z } from "zod";

// ── Zod schemas ─────────────────────────────────────────────────────────────

export const MountDeclarationSchema = z.object({
  alias: z.string().min(1),
  sourceWorkspaceId: z.string().min(1),
  sourceCorpus: z.string().min(1),
  mode: z.enum(["read", "read-write"]),
});

export const WorkspaceMemoryConfigSchema = z.object({
  mounts: z.array(MountDeclarationSchema).optional().default([]),
});

// ── TypeScript types ────────────────────────────────────────────────────────

export type MemoryScope = "global" | "workspace" | "mounted";

export type MountMode = "read" | "read-write";

export interface MountDeclaration {
  alias: string;
  sourceWorkspaceId: string;
  sourceCorpus: string;
  mode: MountMode;
}

export interface MountRegistryEntry {
  consumerWorkspaceId: string;
  mount: MountDeclaration;
  resolvedAt: string;
}

export interface MountRegistry {
  resolve(consumerWorkspaceId: string, alias: string): MountRegistryEntry | undefined;
  listByConsumer(consumerWorkspaceId: string): MountRegistryEntry[];
  listBySource(sourceWorkspaceId: string, sourceCorpus: string): MountRegistryEntry[];
  register(consumerWorkspaceId: string, mounts: MountDeclaration[]): Promise<void>;
  deregister(consumerWorkspaceId: string): void;
}
