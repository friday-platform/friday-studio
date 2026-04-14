/**
 * Memory Scope Runtime Types
 *
 * Discriminated union types for scope-aware routing within the MemoryAdapter
 * implementation. MountMode, MountDeclaration, ResolvedMount, and MountRegistry
 * are re-exported from memory-scope-model.ts (the canonical reference).
 *
 * ScopePolicy and CallerRole are runtime enforcement types used by the adapter
 * to gate writes on the GLOBAL scope.
 */

import { z } from "zod";
import type { MountMode } from "./memory-scope-model.ts";
import { MountDeclarationSchema } from "./memory-scope-model.ts";

// ── Zod schemas ─────────────────────────────────────────────────────────────

export const MemoryMountsConfigSchema = z.object({
  mounts: z.array(MountDeclarationSchema).default([]),
});

export const ScopePolicySchema = z.object({
  workspaceId: z.string(),
  writeAllowed: z.boolean(),
  requiredRole: z.enum(["kernel", "instance-admin", "workspace-owner", "any"]).default("any"),
});

// ── TypeScript types ────────────────────────────────────────────────────────

export type MemoryMountsConfig = z.infer<typeof MemoryMountsConfigSchema>;

export type ScopePolicy = z.infer<typeof ScopePolicySchema>;

export type CallerRole = "kernel" | "instance-admin" | "workspace-owner" | "any";

export interface MemoryScopeGlobal {
  readonly kind: "global";
  readonly workspaceId: "_global";
}

export interface MemoryScopePerWorkspace {
  readonly kind: "per-workspace";
  readonly workspaceId: string;
}

export interface MemoryScopeMounted {
  readonly kind: "mounted";
  readonly alias: string;
  readonly ownerWorkspaceId: string;
  readonly corpus: string;
  readonly mode: MountMode;
}

export type MemoryScope = MemoryScopeGlobal | MemoryScopePerWorkspace | MemoryScopeMounted;
