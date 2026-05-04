import { noXmlTags, noXmlTagsMessage } from "@atlas/config";
import { fail, type Result, success } from "@atlas/utils";
import { parse as parseYaml } from "@std/yaml";
import { z } from "zod";

/**
 * Known frontmatter fields from the Agent Skills spec.
 * Unknown keys are preserved (passthrough).
 */
const KnownFrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().min(1).max(1024).refine(noXmlTags, { message: noXmlTagsMessage }),
  "allowed-tools": z.string().optional(),
  context: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  "disable-model-invocation": z.boolean().optional(),
  "user-invocable": z.boolean().optional(),
  "argument-hint": z.string().optional(),
  license: z.string().optional(),
  compatibility: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

/** Schema that validates known fields but preserves unknown keys */
export const SkillFrontmatterSchema = KnownFrontmatterSchema.catchall(z.unknown());

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

/**
 * Split SKILL.md content into frontmatter block and body.
 * Frontmatter is the YAML between the first two `---` lines.
 * Only matches when the file starts with `---`.
 */
function splitFrontmatter(content: string): { raw: string; body: string } | null {
  if (!content.startsWith("---")) return null;

  // Find the closing --- (must be on its own line)
  const closingIndex = content.indexOf("\n---", 3);
  if (closingIndex === -1) return null;

  const raw = content.slice(4, closingIndex); // skip opening "---\n"
  const body = content.slice(closingIndex + 4); // skip "\n---"

  return { raw, body };
}

/**
 * Relaxed splitter for the storage-layer use case: separates an embedded
 * `---...---` YAML preamble from the body without validating against
 * `KnownFrontmatterSchema`. Use this when you just need to move YAML out of
 * `instructions` into the `frontmatter` column on legacy rows that may be
 * missing required keys (e.g. `description`) or otherwise fail strict
 * validation. For caller-facing parsing where field types matter, use
 * `parseSkillMd`.
 *
 * Returns empty frontmatter when the YAML can't be parsed as a mapping, but
 * still strips the body so we don't double-emit the preamble downstream.
 */
export function splitSkillMd(content: string): {
  frontmatter: Record<string, unknown>;
  instructions: string;
} {
  const normalized = content.replace(/\r\n/g, "\n");
  const split = splitFrontmatter(normalized);
  if (!split) return { frontmatter: {}, instructions: content.trim() };

  const { raw, body } = split;
  if (!raw.trim()) return { frontmatter: {}, instructions: body.trim() };

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return { frontmatter: {}, instructions: body.trim() };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { frontmatter: {}, instructions: body.trim() };
  }
  return { frontmatter: parsed as Record<string, unknown>, instructions: body.trim() };
}

/** Returns full content as instructions when no frontmatter block is present. */
export function parseSkillMd(
  content: string,
): Result<{ frontmatter: SkillFrontmatter; instructions: string }, string> {
  // Normalize CRLF → LF (FormData multipart encoding converts \n to \r\n)
  const normalized = content.replace(/\r\n/g, "\n");
  const split = splitFrontmatter(normalized);

  if (!split) {
    return success({ frontmatter: {} as SkillFrontmatter, instructions: content.trim() });
  }

  const { raw, body } = split;

  // Empty frontmatter block
  if (!raw.trim()) {
    return success({ frontmatter: {} as SkillFrontmatter, instructions: body.trim() });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`Invalid frontmatter YAML: ${message}`);
  }

  // YAML parsed to non-object (e.g. a scalar or array)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("Invalid frontmatter: expected a YAML mapping");
  }

  const validation = SkillFrontmatterSchema.safeParse(parsed);
  if (!validation.success) {
    return fail(`Invalid frontmatter: ${validation.error.message}`);
  }

  return success({ frontmatter: validation.data, instructions: body.trim() });
}
