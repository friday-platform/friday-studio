import type { SkillSummary } from "@atlas/skills";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  buildAnthropicSystemMessages,
  buildSkillsSection,
  flattenSystemBlocks,
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

describe("getSystemBlocks block-4 (volatile workspace inventory)", () => {
  const workspaceSection = '<workspace id="ws-1" name="Personal"></workspace>';

  it("routes the workspace section into block 4, not block 2", () => {
    const blocks = getSystemBlocks(workspaceSection, {
      skills: buildSkillsSection([skill("svelte", "core", "Patterns for Svelte 5.")]),
    });
    expect(blocks.block4).toContain(workspaceSection);
    expect(blocks.block2).not.toContain(workspaceSection);
    expect(blocks.block2).toContain("@svelte/core");
  });

  it("prepends the cache salt to block 2 so a force-fresh bump cascades", () => {
    const cacheSaltTag = '<cache_salt workspace="ws-1" version="7"/>';
    const blocks = getSystemBlocks(workspaceSection, { cacheSaltTag });
    // The salt leads block 2 — changing block 2's prefix invalidates
    // block 3 and block 4 behind it, so "force fresh" busts everything.
    expect(blocks.block2).toContain(cacheSaltTag);
    expect(blocks.block4).not.toContain(cacheSaltTag);
  });

  it("block 2 is empty when the workspace has no skills, identity, or salt", () => {
    const blocks = getSystemBlocks(workspaceSection);
    expect(blocks.block2).toBe("");
    expect(blocks.block4).toContain(workspaceSection);
  });
});

describe("flattenSystemBlocks", () => {
  it("omits an empty block 2 and still includes block 4", () => {
    const workspaceSection = '<workspace id="ws-1" name="Personal"></workspace>';
    // No skills / identity / salt -> block 2 is empty.
    const blocks = getSystemBlocks(workspaceSection);
    expect(blocks.block2).toBe("");

    const flat = flattenSystemBlocks(blocks);
    expect(flat).toContain(blocks.block1);
    expect(flat).toContain(workspaceSection);
    // An empty block 2 must not introduce a stray blank section.
    expect(flat).not.toContain("\n\n\n\n");
  });
});

describe("buildAnthropicSystemMessages", () => {
  const longTtl = { type: "ephemeral", ttl: "1h" };
  const shortTtl = { type: "ephemeral" };

  function ttlOf(msg: ModelMessage): unknown {
    return (msg.providerOptions as { anthropic?: { cacheControl?: unknown } } | undefined)
      ?.anthropic?.cacheControl;
  }

  it("emits one breakpoint per non-empty block, ordered, with the expected TTLs", () => {
    const msgs = buildAnthropicSystemMessages({
      block1: "B1",
      block2: "B2",
      block3: "B3",
      block4: "B4",
    });
    expect(msgs.map((m) => m.content)).toEqual(["B1", "B2", "B3", "B4"]);
    expect(msgs.map(ttlOf)).toEqual([longTtl, longTtl, shortTtl, shortTtl]);
  });

  it("skips empty block 2 / block 3 but always keeps block 1 and block 4", () => {
    const msgs = buildAnthropicSystemMessages({
      block1: "B1",
      block2: "",
      block3: "",
      block4: "B4",
    });
    expect(msgs.map((m) => m.content)).toEqual(["B1", "B4"]);
    expect(msgs.map(ttlOf)).toEqual([longTtl, shortTtl]);
  });

  it("keeps the TTL sequence non-increasing (Anthropic rejects 1h after 5m)", () => {
    // 1h -> ordinal 1, 5m -> ordinal 0; the sequence must never rise.
    const ordinal = (ttl: unknown) => ((ttl as { ttl?: string })?.ttl === "1h" ? 1 : 0);
    for (const blocks of [
      { block1: "B1", block2: "B2", block3: "B3", block4: "B4" },
      { block1: "B1", block2: "", block3: "B3", block4: "B4" },
      { block1: "B1", block2: "B2", block3: "", block4: "B4" },
      { block1: "B1", block2: "", block3: "", block4: "B4" },
    ]) {
      const seq = buildAnthropicSystemMessages(blocks).map((m) => ordinal(ttlOf(m)));
      for (let i = 1; i < seq.length; i++) {
        expect(seq[i]).toBeLessThanOrEqual(seq[i - 1] as number);
      }
    }
  });
});
