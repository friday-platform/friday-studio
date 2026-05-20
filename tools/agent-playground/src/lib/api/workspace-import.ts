/**
 * Response schemas for the daemon's workspace-import surface.
 *
 * `POST /api/workspaces/import-bundle` accepts a single workspace zip
 * (`multipart/form-data` field `bundle`) and returns one imported
 * workspace. `POST /api/workspaces/import-bundle-all` accepts a
 * full-export archive and returns a per-entry list plus aggregate
 * `errors[]` and optional `globalSkills` status. Both endpoints share
 * the same `{ error: string }` failure body. The playground proxies
 * `/api/daemon/*` to the daemon, so callers prefix `/api/daemon`.
 */

import { z } from "zod";

const ImportedMemorySchema = z
  .object({ kind: z.string(), path: z.string().optional(), reason: z.string().optional() })
  .passthrough();

export const ImportedEntrySchema = z
  .object({
    workspaceId: z.string(),
    name: z.string().optional(),
    path: z.string().optional(),
    memory: ImportedMemorySchema.optional(),
    agentsInstalled: z.number().optional(),
    agentsSkipped: z.number().optional(),
  })
  .passthrough();

/** Success body for `POST /api/workspaces/import-bundle`. */
export const ImportBundleResponseSchema = z
  .object({
    workspaceId: z.string(),
    name: z.string().optional(),
    path: z.string().optional(),
    memory: ImportedMemorySchema.optional(),
    agentsInstalled: z.number().optional(),
    agentsSkipped: z.number().optional(),
  })
  .passthrough();

const GlobalSkillsStatusSchema = z.object({ kind: z.string().optional() }).passthrough();

/** Success body for `POST /api/workspaces/import-bundle-all`. */
export const ImportBundleAllResponseSchema = z
  .object({
    imported: z.array(ImportedEntrySchema),
    errors: z.array(
      z.object({ name: z.string().optional(), error: z.string().optional() }).passthrough(),
    ),
    globalSkills: GlobalSkillsStatusSchema.nullable().optional(),
  })
  .passthrough();

/** Shared failure body for both import endpoints (and the daemon's
 * validation 400/422 responses, which also carry a `report` field that
 * the playground currently ignores). */
export const ImportBundleErrorSchema = z.object({ error: z.string() }).passthrough();

export type ImportedEntry = z.infer<typeof ImportedEntrySchema>;
export type ImportBundleResponse = z.infer<typeof ImportBundleResponseSchema>;
export type ImportBundleAllResponse = z.infer<typeof ImportBundleAllResponseSchema>;
