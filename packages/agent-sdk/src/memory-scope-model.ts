/**
 * Three-Scope Memory Model — Compatibility Re-exports
 *
 * Canonical types live in memory-scope.ts. This file re-exports them
 * and provides backward-compat aliases for code written against the
 * previous iteration.
 */

export {
  type MemoryScope,
  type MountDeclaration,
  MountDeclarationSchema,
  type MountMode,
  type MountRegistry,
  type MountRegistryEntry,
  WorkspaceMemoryConfigSchema,
} from "./memory-scope.ts";

export type MemoryScopeKind = "global" | "workspace" | "mounted";
