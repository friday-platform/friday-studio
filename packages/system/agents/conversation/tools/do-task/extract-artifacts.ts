import { type ArtifactRef, ArtifactRefSchema } from "@atlas/agent-sdk";
import { z } from "zod";

const OutputWithArtifactsSchema = z.looseObject({
  artifactRef: ArtifactRefSchema.optional(),
  artifactRefs: z.array(ArtifactRefSchema).optional(),
});

const ResultWrapperSchema = z.object({ ok: z.literal(true), data: OutputWithArtifactsSchema });

const SanitizableDataSchema = z.looseObject({
  response: z.string().optional(),
  summary: z.string().optional(),
  content: z.string().optional(),
  artifactRef: z.unknown().optional(),
  artifactRefs: z.unknown().optional(),
});

const SanitizableWrapperSchema = z.object({
  ok: z.boolean(),
  data: SanitizableDataSchema.optional(),
  error: z.unknown().optional(),
});

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

const MAX_RESPONSE_CHARS = 12_000;

function capResponse(text: string): string {
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  return (
    text.slice(0, MAX_RESPONSE_CHARS) +
    "\n\n[Content truncated — full output stored in artifacts. Use display_artifact to show.]"
  );
}

/**
 * Sanitize agent output: strip artifact refs, normalize text field.
 * Caps response length — full content is already persisted as artifacts.
 * Handles Result wrapper and direct object patterns.
 */
export function sanitizeAgentOutput(
  output: unknown,
): { ok: boolean; data?: { response?: string }; error?: unknown } | undefined {
  if (!output || typeof output !== "object") return undefined;

  // Try Result wrapper first
  const wrapperParse = SanitizableWrapperSchema.safeParse(output);
  if (wrapperParse.success) {
    const { ok, data, error } = wrapperParse.data;
    const text = data?.response ?? data?.summary ?? data?.content;
    return { ok, data: text ? { response: capResponse(text) } : undefined, error };
  }

  // Try direct object
  const directParse = SanitizableDataSchema.safeParse(output);
  if (directParse.success) {
    const text = directParse.data.response ?? directParse.data.summary ?? directParse.data.content;
    return { ok: true, data: text ? { response: capResponse(text) } : undefined };
  }

  return undefined;
}
