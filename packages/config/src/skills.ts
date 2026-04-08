import { z } from "zod";

// ==============================================================================
// IDENTIFIER SCHEMAS
// ==============================================================================

/** Words prohibited in skill names and namespaces per the Agent Skills spec */
export const RESERVED_WORDS = ["anthropic", "claude"] as const;

function containsReservedWord(value: string): boolean {
  return RESERVED_WORDS.some((word) => value.includes(word));
}

const reservedWordMessage = `Must not contain reserved words: ${RESERVED_WORDS.join(", ")}`;

/** Name validation per Agent Skills spec — shared by @atlas/config and @atlas/skills */
export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "Name must be lowercase alphanumeric with single hyphens, no leading/trailing hyphens",
  })
  .refine((v) => !containsReservedWord(v), { message: reservedWordMessage });

/** Namespace validation — same kebab-case rules as SkillNameSchema */
export const NamespaceSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      "Namespace must be lowercase alphanumeric with single hyphens, no leading/trailing hyphens",
  })
  .refine((v) => !containsReservedWord(v), { message: reservedWordMessage });

/** Combined `@namespace/skill-name` format used in workspace.yml and CLI */
export const SkillRefSchema = z
  .string()
  .regex(/^@[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "Skill ref must be in @namespace/skill-name format with kebab-case identifiers",
  })
  .refine(
    (v) => {
      const slash = v.indexOf("/");
      return !containsReservedWord(v.slice(1, slash)) && !containsReservedWord(v.slice(slash + 1));
    },
    { message: reservedWordMessage },
  );

/** Parse a validated skill ref into its namespace and name parts */
export function parseSkillRef(ref: string): { namespace: string; name: string } {
  const parsed = SkillRefSchema.parse(ref);
  const slashIndex = parsed.indexOf("/");
  const namespace = parsed.slice(1, slashIndex);
  const name = parsed.slice(slashIndex + 1);
  if (containsReservedWord(namespace)) {
    throw new Error(`Namespace "${namespace}" contains reserved word`);
  }
  if (containsReservedWord(name)) {
    throw new Error(`Skill name "${name}" contains reserved word`);
  }
  return { namespace, name };
}

// ==============================================================================
// HELPERS
// ==============================================================================

/** Rejects strings containing `<` or `>` to prevent XML injection in agent prompts */
export function noXmlTags(s: string): boolean {
  return !s.includes("<") && !s.includes(">");
}

export const noXmlTagsMessage =
  "Must not contain < or > characters (prevents XML injection in agent prompts)";
