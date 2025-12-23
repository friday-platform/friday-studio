import { type ArtifactRef, ArtifactRefSchema } from "@atlas/agent-sdk";
import { z } from "zod";

const OutputWithArtifactsSchema = z
  .object({
    artifactRef: ArtifactRefSchema.optional(),
    artifactRefs: z.array(ArtifactRefSchema).optional(),
  })
  .passthrough();

const ResultWrapperSchema = z.object({ ok: z.literal(true), data: OutputWithArtifactsSchema });

/**
 * Extract artifact references from heterogeneous agent outputs.
 *
 * Handles:
 * - Result wrapper: { ok: true, data: { artifactRef | artifactRefs } }
 * - Direct object: { artifactRef | artifactRefs }
 * - Singular vs plural forms
 *
 * Returns deduplicated array by artifact ID.
 */
export function extractArtifactsFromOutput(output: unknown): ArtifactRef[] {
  if (!output || typeof output !== "object") return [];

  const wrapperParse = ResultWrapperSchema.safeParse(output);
  const data = wrapperParse.success ? wrapperParse.data.data : output;

  const parse = OutputWithArtifactsSchema.safeParse(data);
  if (!parse.success) return [];

  const { artifactRef, artifactRefs = [] } = parse.data;
  const all = artifactRef ? [artifactRef, ...artifactRefs] : artifactRefs;

  const seen = new Set<string>();
  return all.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}
