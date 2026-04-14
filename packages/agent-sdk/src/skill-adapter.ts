/**
 * Skill Adapter Interface
 *
 * Versioned, validated, hot-reloadable skill management.
 * ResolvedSkill extends the existing AgentSkill from types.ts.
 *
 * From parity plan v6, lines 673-686.
 */

import { z } from "zod";
import type { AgentSkill } from "./types.ts";

// ── Zod schemas ─────────────────────────────────────────────────────────────

export const SkillMetadataSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
});

export const SkillDraftSchema = z.object({
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  referenceFiles: z.record(z.string(), z.string()).optional(),
});

export const SkillVersionSchema = z.object({
  version: z.string(),
  createdAt: z.string(),
  summary: z.string(),
});

// ── TypeScript types ────────────────────────────────────────────────────────

export interface SkillMetadata {
  name: string;
  description: string;
  version: string;
}

export interface ResolvedSkill extends AgentSkill {
  version: string;
}

export interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
  referenceFiles?: Record<string, string>;
}

export interface SkillVersion {
  version: string;
  createdAt: string;
  summary: string;
}

export interface SkillAdapter {
  list(workspaceId: string, agentId?: string): Promise<SkillMetadata[]>;
  get(workspaceId: string, name: string): Promise<ResolvedSkill | undefined>;
  create(workspaceId: string, draft: SkillDraft): Promise<ResolvedSkill>;
  update(workspaceId: string, name: string, patch: Partial<SkillDraft>): Promise<ResolvedSkill>;
  /** Versioned history — leapfrog dimension #2. */
  history(workspaceId: string, name: string): Promise<SkillVersion[]>;
  rollback(workspaceId: string, name: string, toVersion: string): Promise<ResolvedSkill>;
  invalidate(workspaceId: string): void;
}
