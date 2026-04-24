/**
 * Three-Scope Memory Model
 *
 * Canonical source for the memory scope taxonomy:
 *   1. GLOBAL  — synthetic workspace id "_global", write-gated to kernel
 *   2. PER-WORKSPACE — owned by exactly one workspace at ~/.atlas/memory/{wsId}/
 *   3. MOUNTED — runtime alias resolved from workspace.yml memory.mounts[]
 *
 * The MemoryAdapter interface is scope-agnostic at the call site. The
 * workspaceId parameter is the scope discriminator:
 *   - "_global"      → GLOBAL scope, write-gated
 *   - "<real-slug>"  → PER-WORKSPACE or MOUNTED (resolved at runtime init)
 *
 * Zod validation for mounts lives in @atlas/config (MemoryMountSchema,
 * MemoryConfigSchema). This file declares pure TS types only.
 */

// ── TypeScript types ────────────────────────────────────────────────────────

export type MemoryScope = "global" | "workspace" | "mounted";

export type MemoryScopeKind = MemoryScope;

export type MountMode = "ro" | "rw";

export interface MountFilter {
  status?: string | string[];
  priority_min?: number;
  kind?: string | string[];
  since?: string;
}

export interface MountDeclaration {
  name: string;
  source: string;
  mode: MountMode;
  scope: "workspace" | "job" | "agent";
  scopeTarget?: string;
  filter?: MountFilter;
}

// ── Global scope constants ─────────────────────────────────────────────────

export const GLOBAL_WORKSPACE_ID = "_global" as const;

export const GLOBAL_MEMORY_BASE_PATH = "memory/_global/" as const;

export function isGlobalScope(workspaceId: string): workspaceId is typeof GLOBAL_WORKSPACE_ID {
  return workspaceId === GLOBAL_WORKSPACE_ID;
}

export function resolveMemoryBasePath(workspaceId: string): string {
  if (isGlobalScope(workspaceId)) return GLOBAL_MEMORY_BASE_PATH;
  return `memory/${workspaceId}/`;
}

// ── Canonical scope list + access policy ──────────────────────────────────

export const ALL_SCOPES = ["global", "workspace", "mounted"] as const;

export const SCOPE_ACCESS_RULES: Record<
  MemoryScope,
  { read: "any" | "kernel" | "owner"; write: "any" | "kernel" | "owner"; bootstrap: boolean }
> = {
  global: { read: "any", write: "kernel", bootstrap: true },
  workspace: { read: "owner", write: "owner", bootstrap: true },
  mounted: { read: "any", write: "owner", bootstrap: true },
} as const;

// ── Scope descriptors ─────────────────────────────────────────────────────

export type MemoryScopeDescriptor =
  | { scope: "global"; kernelOnly: boolean }
  | { scope: "workspace"; ownerId: string }
  | { scope: "mounted"; source: string; mode: MountMode };

// ── Well-known store names ──────────────────────────────────────────────────

export const USER_PROFILE_STORE = "notes" as const;

export type UserProfileEntryType = "user-name" | "name-declined";

export const USER_PROFILE_ENTRY_TYPES = ["user-name", "name-declined"] as const;
