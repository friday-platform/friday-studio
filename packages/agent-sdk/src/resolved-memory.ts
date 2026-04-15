/**
 * Resolved Workspace Memory
 *
 * Consolidation type representing the fully-resolved memory surface of a
 * running workspace — the composition point where GLOBAL, PER-WORKSPACE,
 * and MOUNTED scopes are unified into a single queryable structure.
 *
 * Used by bootstrap injection (Task 7) and memory API routes.
 */

import { z } from "zod";
import type { MountDeclaration } from "./memory-scope.ts";

// ── Scope tag ─────────────────────────────────────────────────────────────

export type ScopeTag = "global" | "workspace" | "mounted";

// ── Zod schemas ───────────────────────────────────────────────────────────

const MemoryTypeValues = ["short_term", "long_term", "scratchpad"] as const;
const MemoryStrategyValues = ["narrative", "retrieval", "dedup", "kv"] as const;
const CorpusKindValues = ["narrative", "retrieval", "dedup", "kv"] as const;

export const ResolvedOwnCorpusSchema = z.object({
  name: z.string(),
  type: z.enum(MemoryTypeValues),
  strategy: z.enum(MemoryStrategyValues).optional(),
  scope: z.literal("workspace" as const),
});

export type ResolvedOwnCorpus = z.infer<typeof ResolvedOwnCorpusSchema>;

export const ResolvedMountSchema = z.object({
  name: z.string(),
  source: z.string(),
  mode: z.enum(["ro", "rw"]),
  scope: z.enum(["workspace", "job", "agent"]),
  scopeTarget: z.string().optional(),
  sourceWorkspaceId: z.string(),
  // Runtime currently only supports "narrative" mounts (runtime.ts:550)
  sourceCorpusKind: z.enum(CorpusKindValues),
  sourceCorpusName: z.string(),
});

export type ResolvedMount = z.infer<typeof ResolvedMountSchema>;

export const ResolvedWorkspaceMemorySchema = z.object({
  workspaceId: z.string(),
  own: z.array(ResolvedOwnCorpusSchema),
  mounts: z.array(ResolvedMountSchema),
  globalAccess: z.object({ canRead: z.boolean(), canWrite: z.boolean() }),
});

export type ResolvedWorkspaceMemory = z.infer<typeof ResolvedWorkspaceMemorySchema>;

// ── Builder ───────────────────────────────────────────────────────────────

export interface BuildResolvedMemoryInput {
  workspaceId: string;
  ownEntries: ReadonlyArray<{ name: string; type: string; strategy?: string }>;
  mountDeclarations: ReadonlyArray<MountDeclaration>;
  kernelWorkspaceId: string | undefined;
}

export function buildResolvedWorkspaceMemory(
  input: BuildResolvedMemoryInput,
): ResolvedWorkspaceMemory {
  const own: ResolvedOwnCorpus[] = input.ownEntries.map((entry) =>
    ResolvedOwnCorpusSchema.parse({
      name: entry.name,
      type: entry.type,
      strategy: entry.strategy,
      scope: "workspace",
    }),
  );

  const mounts: ResolvedMount[] = input.mountDeclarations.map((decl) => {
    const parts = decl.source.split("/");
    return ResolvedMountSchema.parse({
      name: decl.name,
      source: decl.source,
      mode: decl.mode,
      scope: decl.scope,
      scopeTarget: decl.scopeTarget,
      sourceWorkspaceId: parts[0] ?? "",
      sourceCorpusKind: parts[1] ?? "narrative",
      sourceCorpusName: parts[2] ?? "",
    });
  });

  const hasGlobalMount = mounts.some((m) => m.sourceWorkspaceId === "_global");
  const hasGlobalRwMount = mounts.some((m) => m.sourceWorkspaceId === "_global" && m.mode === "rw");
  const isKernel = input.workspaceId === input.kernelWorkspaceId;

  return {
    workspaceId: input.workspaceId,
    own,
    mounts,
    globalAccess: { canRead: hasGlobalMount, canWrite: hasGlobalRwMount && isKernel },
  };
}
