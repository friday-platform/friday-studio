/**
 * Shared Zod schemas used across multiple bundled agent output schemas.
 * Internal to this package — not re-exported from index.ts.
 *
 * OutlineRefSchema is duplicated here (rather than imported from @atlas/core)
 * because @atlas/core depends on @atlas/bundled-agents at the package level,
 * and OutlineRefSchema is not exported via any @atlas/core subpath.
 * Keep in sync with: packages/core/src/types/outline-ref.ts
 * Drift detected by: packages/core/src/types/outline-ref-drift.test.ts
 */

import { ArtifactRefSchema } from "@atlas/agent-sdk";
import { z } from "zod";

export const OutlineRefSchema = z.object({
  service: z.string(),
  title: z.string(),
  content: z.string().optional(),
  artifactId: z.string().optional(),
  artifactLabel: z.string().optional(),
  type: z.string().optional(),
});

export const ArtifactRefsSchema = z.array(ArtifactRefSchema);
export const OutlineRefsSchema = z.array(OutlineRefSchema);

export type OutlineRef = z.infer<typeof OutlineRefSchema>;
