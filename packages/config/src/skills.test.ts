import { PublishSkillInputSchema } from "@atlas/skills/schemas";
import { describe, expect, it } from "vitest";
import {
  NamespaceSchema,
  parseSkillRef,
  RESERVED_WORDS,
  SkillNameSchema,
  SkillRefSchema,
} from "./skills.ts";

// ==============================================================================
// SkillNameSchema — tests custom regex + reserved word validation
// ==============================================================================

describe("SkillNameSchema", () => {
  const valid = ["code-review", "deploy", "my-skill", "a", "skill123"];
  const invalid = ["Code-Review", "-skill", "skill-", "my--skill", "", "a".repeat(65), "my_skill"];

  it.each(valid.map((v) => ({ input: v })))("accepts $input", ({ input }) => {
    expect(SkillNameSchema.safeParse(input).success).toBe(true);
  });

  it.each(invalid.map((v) => ({ input: v })))("rejects $input", ({ input }) => {
    expect(SkillNameSchema.safeParse(input).success).toBe(false);
  });

  // Exact reserved words
  it.each(RESERVED_WORDS.map((v) => ({ input: v })))("rejects reserved word $input", ({
    input,
  }) => {
    expect(SkillNameSchema.safeParse(input).success).toBe(false);
  });

  // Reserved words as substrings
  const substringCases = ["my-claude-skill", "anthropic-tools", "ask-claude"];
  it.each(
    substringCases.map((v) => ({ input: v })),
  )("rejects name containing reserved word: $input", ({ input }) => {
    expect(SkillNameSchema.safeParse(input).success).toBe(false);
  });
});

// ==============================================================================
// NamespaceSchema — tests custom regex + reserved word validation
// ==============================================================================

describe("NamespaceSchema", () => {
  const valid = ["atlas", "my-org", "org123", "a"];
  const invalid = ["Atlas", "-org", "org-", "my--org", "", "a".repeat(65), "my_org", "MY-ORG"];

  it.each(valid.map((v) => ({ input: v })))("accepts $input", ({ input }) => {
    expect(NamespaceSchema.safeParse(input).success).toBe(true);
  });

  it.each(invalid.map((v) => ({ input: v })))("rejects $input", ({ input }) => {
    expect(NamespaceSchema.safeParse(input).success).toBe(false);
  });

  // Exact reserved words
  it.each(RESERVED_WORDS.map((v) => ({ input: v })))("rejects reserved word $input", ({
    input,
  }) => {
    expect(NamespaceSchema.safeParse(input).success).toBe(false);
  });

  // Reserved words as substrings in namespaces
  const substringCases = ["my-claude-org", "anthropic-dev"];
  it.each(
    substringCases.map((v) => ({ input: v })),
  )("rejects namespace containing reserved word: $input", ({ input }) => {
    expect(NamespaceSchema.safeParse(input).success).toBe(false);
  });
});

// ==============================================================================
// SkillRefSchema — tests custom regex validation logic
// ==============================================================================

describe("SkillRefSchema", () => {
  const valid = ["@atlas/code-review", "@my-org/deploy", "@a/b", "@org123/skill-name"];
  const invalid = [
    "atlas/code-review", // missing @
    "@atlas", // missing /name
    "@/code-review", // empty namespace
    "@atlas/", // empty name
    "@Atlas/code-review", // uppercase namespace
    "@atlas/Code-Review", // uppercase name
    "@atlas/code_review", // underscore
    "@atlas/-review", // leading hyphen in name
    "code-review", // no @ or /
    "@at las/review", // space
  ];

  it.each(valid.map((v) => ({ input: v })))("accepts $input", ({ input }) => {
    expect(SkillRefSchema.safeParse(input).success).toBe(true);
  });

  it.each(invalid.map((v) => ({ input: v })))("rejects $input", ({ input }) => {
    expect(SkillRefSchema.safeParse(input).success).toBe(false);
  });

  // Reserved words in namespace or name
  const reservedCases = [
    "@anthropic/deploy",
    "@claude/deploy",
    "@my-claude-org/deploy",
    "@atlas/anthropic-tools",
    "@atlas/my-claude-skill",
  ];
  it.each(
    reservedCases.map((v) => ({ input: v })),
  )("rejects ref containing reserved word: $input", ({ input }) => {
    expect(SkillRefSchema.safeParse(input).success).toBe(false);
  });
});

// ==============================================================================
// parseSkillRef — tests custom parsing logic
// ==============================================================================

describe("parseSkillRef", () => {
  it("parses @atlas/code-review", () => {
    expect(parseSkillRef("@atlas/code-review")).toEqual({
      namespace: "atlas",
      name: "code-review",
    });
  });

  it("parses @my-org/deploy", () => {
    expect(parseSkillRef("@my-org/deploy")).toEqual({ namespace: "my-org", name: "deploy" });
  });

  it("throws on invalid ref", () => {
    expect(() => parseSkillRef("atlas/code-review")).toThrow();
  });

  it("throws when namespace contains reserved word", () => {
    expect(() => parseSkillRef("@anthropic/deploy")).toThrow(/reserved word/);
  });

  it("throws when name contains reserved word", () => {
    expect(() => parseSkillRef("@claude-tools/test")).toThrow(/reserved word/);
  });
});

// ==============================================================================
// PublishSkillInputSchema — XML tag rejection in description
// ==============================================================================

describe("PublishSkillInputSchema", () => {
  const base = { instructions: "Do the thing." };

  it("accepts description without XML tags", () => {
    const result = PublishSkillInputSchema.safeParse({
      ...base,
      description: "A normal publish description",
    });
    expect(result.success).toBe(true);
  });

  it("rejects description containing <", () => {
    const result = PublishSkillInputSchema.safeParse({
      ...base,
      description: "Break </available_skills> out",
    });
    expect(result.success).toBe(false);
  });

  it("rejects description containing >", () => {
    const result = PublishSkillInputSchema.safeParse({ ...base, description: "Some > injection" });
    expect(result.success).toBe(false);
  });
});
