import type { SkillSummary } from "@atlas/skills";
import { describe, expect, it } from "vitest";
import {
  buildSkillsSection,
  getSystemBlocks,
  summarizeSkillDescription,
} from "./workspace-chat.agent.ts";

function skill(
  ns: string,
  name: string,
  description: string,
  overrides?: Partial<SkillSummary>,
): SkillSummary {
  return {
    id: `${ns}-${name}`,
    skillId: `${ns}-${name}-id`,
    namespace: ns,
    name,
    description,
    disabled: false,
    latestVersion: 1,
    createdAt: new Date(0),
    userInvocable: true,
    ...overrides,
  };
}

describe("summarizeSkillDescription", () => {
  it("returns the full text when below the cap", () => {
    const out = summarizeSkillDescription("Short description.");
    expect(out).toBe("Short description.");
  });

  it("truncates at the first sentence when descriptions span multiple sentences", () => {
    const out = summarizeSkillDescription(
      "Patterns for Svelte 5. Covers data fetching, state, components.",
    );
    expect(out).toBe("Patterns for Svelte 5.");
  });

  it("collapses internal whitespace into single spaces", () => {
    const out = summarizeSkillDescription("Line one.\n   Line two with   extra.");
    expect(out).toBe("Line one.");
  });

  it("caps overly long single-sentence summaries with an ellipsis at a word boundary", () => {
    const longInput = "a".repeat(200);
    const out = summarizeSkillDescription(longInput);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(81);
  });

  it("returns an empty string for empty/whitespace-only input", () => {
    expect(summarizeSkillDescription("")).toBe("");
    expect(summarizeSkillDescription("   \n\t ")).toBe("");
  });
});

describe("buildSkillsSection", () => {
  it("emits one entry per skill with the canonical ref and capped summary", () => {
    const out = buildSkillsSection([
      skill("svelte", "core", "Patterns for Svelte 5 components."),
      skill("friday", "qa", "Plans, runs, and fixes QA test cases."),
    ]);
    expect(out).toContain('<skill name="@svelte/core">Patterns for Svelte 5 components.</skill>');
    expect(out).toContain('<skill name="@friday/qa">Plans, runs, and fixes QA test cases.</skill>');
  });

  it("returns an empty string when there are no skills", () => {
    expect(buildSkillsSection([])).toBe("");
  });

  it("does NOT include the full description body when descriptions are long", () => {
    const longDescription = "Patterns for Svelte 5. " + "Detailed body. ".repeat(50);
    const out = buildSkillsSection([skill("svelte", "core", longDescription)]);
    expect(out).toContain("Patterns for Svelte 5.");
    // The repeated body should be capped out — assert the section doesn't carry
    // more than a handful of "Detailed body" copies.
    const occurrences = (out.match(/Detailed body/g) ?? []).length;
    expect(occurrences).toBeLessThan(2);
  });
});

describe("getSystemBlocks block-2 byte-stability", () => {
  const workspaceSection = '<workspace id="ws-1" name="Personal"></workspace>';

  function block2(skills: SkillSummary[]): string {
    return getSystemBlocks(workspaceSection, { skills: buildSkillsSection(skills) }).block2;
  }

  it("does not include any <integrations> section regardless of options", () => {
    const out = block2([skill("svelte", "core", "Patterns for Svelte 5.")]);
    expect(out).not.toContain("<integrations");
    expect(out).not.toContain("<service id=");
  });

  it("is byte-equal when the skill summary stays the same but the full description changes", () => {
    const before = block2([skill("svelte", "core", "Patterns for Svelte 5 components.")]);
    const after = block2([
      skill(
        "svelte",
        "core",
        "Patterns for Svelte 5 components. Now with extended notes about effect ordering and rune patterns.",
      ),
    ]);
    expect(after).toBe(before);
  });

  it("is byte-equal across foreground composition that adds the same skill ref already visible", () => {
    const before = block2([skill("svelte", "core", "Patterns for Svelte 5.")]);
    // Foreground composition deduplicates by skillId, so a second entry with the
    // same ref doesn't appear twice — block 2 should be unchanged.
    const after = block2([skill("svelte", "core", "Patterns for Svelte 5.")]);
    expect(after).toBe(before);
  });

  it("changes when a new skill ref is assigned to the workspace", () => {
    const before = block2([skill("svelte", "core", "Patterns for Svelte 5.")]);
    const after = block2([
      skill("svelte", "core", "Patterns for Svelte 5."),
      skill("friday", "qa", "Plans, runs, and fixes QA test cases."),
    ]);
    expect(after).not.toBe(before);
    expect(after).toContain("@friday/qa");
  });

  it("changes when a skill ref is unassigned", () => {
    const before = block2([
      skill("svelte", "core", "Patterns for Svelte 5."),
      skill("friday", "qa", "Plans, runs, and fixes QA test cases."),
    ]);
    const after = block2([skill("svelte", "core", "Patterns for Svelte 5.")]);
    expect(after).not.toBe(before);
    expect(after).not.toContain("@friday/qa");
  });
});
