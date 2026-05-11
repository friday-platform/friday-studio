/**
 * Tests for `resolveDelegateSkills` — the gate that converts a parent's
 * `delegate({skills: [...]})` arg into ready-to-inject prompt text. Defense
 * in depth lives here: out-of-scope refs are dropped and logged, so a
 * hallucinated skill name in the parent LLM's output cannot escalate the
 * child's reach.
 */

import type { Logger } from "@atlas/logger";
import { type Skill, SkillStorage } from "@atlas/skills";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExtractArchiveContents = vi.hoisted(() => vi.fn());

vi.mock("@atlas/skills", async () => {
  const actual = await vi.importActual<typeof import("@atlas/skills")>("@atlas/skills");
  return { ...actual, extractArchiveContents: mockExtractArchiveContents };
});

import { formatDelegateSkillsBlock, resolveDelegateSkills } from "./skills-resolver.ts";

function makeLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } satisfies Record<keyof Logger, unknown>;
}

const SUMMARY = {
  id: "stop-slop-1",
  skillId: "stop-slop-1",
  namespace: "friday",
  name: "stop-slop",
  description: "Remove AI writing patterns from prose.",
  disabled: false,
  latestVersion: 1,
  createdAt: new Date(),
  userInvocable: true,
};

const SKILL_DATA: Skill = {
  id: "stop-slop-1",
  skillId: "stop-slop-1",
  namespace: "friday",
  name: "stop-slop",
  version: 1,
  description: "Remove AI writing patterns from prose.",
  descriptionManual: false,
  disabled: false,
  frontmatter: {},
  instructions: "# Stop Slop\n\nNo em dashes.",
  archive: null,
  createdBy: "user-1",
  createdAt: new Date(),
};

function mockVisibility(summaries: (typeof SUMMARY)[]) {
  vi.spyOn(SkillStorage, "list").mockResolvedValue({ ok: true, data: summaries });
  vi.spyOn(SkillStorage, "listAssigned").mockResolvedValue({ ok: true, data: [] });
  vi.spyOn(SkillStorage, "listAssignmentsForJob").mockResolvedValue({ ok: true, data: [] });
  vi.spyOn(SkillStorage, "listJobOnlySkillIds").mockResolvedValue({ ok: true, data: [] });
}

describe("resolveDelegateSkills", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockExtractArchiveContents.mockReset();
  });

  it("returns [] for an empty request without hitting storage", async () => {
    const listSpy = vi.spyOn(SkillStorage, "list");
    const resolved = await resolveDelegateSkills([], { workspaceId: "ws-1", logger: makeLogger() });
    expect(resolved).toEqual([]);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("threads a visible skill's SKILL.md body when no refs are passed", async () => {
    mockVisibility([SUMMARY]);
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: SKILL_DATA });

    const resolved = await resolveDelegateSkills([{ name: "@friday/stop-slop" }], {
      workspaceId: "ws-1",
      logger: makeLogger(),
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      name: "@friday/stop-slop",
      description: "Remove AI writing patterns from prose.",
      body: "# Stop Slop\n\nNo em dashes.",
    });
  });

  it("includes only the requested reference files when refs is provided", async () => {
    mockVisibility([SUMMARY]);
    vi.spyOn(SkillStorage, "get").mockResolvedValue({
      ok: true,
      data: { ...SKILL_DATA, archive: new Uint8Array(new ArrayBuffer(3)) },
    });
    mockExtractArchiveContents.mockResolvedValue({
      "SKILL.md": "# main",
      "references/phrases.md": "## Phrases to cut\nKill all adverbs.",
      "references/structures.md": "## Structures\nAvoid binary contrasts.",
    });

    const resolved = await resolveDelegateSkills(
      [{ name: "@friday/stop-slop", refs: ["references/phrases.md"] }],
      { workspaceId: "ws-1", logger: makeLogger() },
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.body).toContain('<file path="references/phrases.md">');
    expect(resolved[0]?.body).toContain("Kill all adverbs.");
    expect(resolved[0]?.body).not.toContain("Avoid binary contrasts.");
    expect(resolved[0]?.body).not.toContain("# main");
  });

  it("drops and logs a skill not in the parent's visible set", async () => {
    mockVisibility([]); // nothing visible
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: SKILL_DATA });
    const logger = makeLogger();

    const resolved = await resolveDelegateSkills([{ name: "@friday/stop-slop" }], {
      workspaceId: "ws-1",
      logger,
    });

    expect(resolved).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "delegate_skill_not_visible",
      expect.objectContaining({ skill: "@friday/stop-slop", workspaceId: "ws-1" }),
    );
  });

  it("drops a refs request when the skill has no archive", async () => {
    mockVisibility([SUMMARY]);
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: SKILL_DATA });
    const logger = makeLogger();

    const resolved = await resolveDelegateSkills(
      [{ name: "@friday/stop-slop", refs: ["references/phrases.md"] }],
      { workspaceId: "ws-1", logger },
    );

    expect(resolved).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "delegate_skill_no_archive",
      expect.objectContaining({ skill: "@friday/stop-slop" }),
    );
  });

  it("skips an unknown ref but keeps the skill when at least one ref resolves", async () => {
    mockVisibility([SUMMARY]);
    vi.spyOn(SkillStorage, "get").mockResolvedValue({
      ok: true,
      data: { ...SKILL_DATA, archive: new Uint8Array(new ArrayBuffer(1)) },
    });
    mockExtractArchiveContents.mockResolvedValue({ "references/phrases.md": "phrases body" });
    const logger = makeLogger();

    const resolved = await resolveDelegateSkills(
      [{ name: "@friday/stop-slop", refs: ["references/phrases.md", "does-not-exist.md"] }],
      { workspaceId: "ws-1", logger },
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.body).toContain("phrases body");
    expect(logger.warn).toHaveBeenCalledWith(
      "delegate_skill_ref_not_found",
      expect.objectContaining({ skill: "@friday/stop-slop", ref: "does-not-exist.md" }),
    );
  });

  it("drops the skill entirely when no requested ref resolves", async () => {
    mockVisibility([SUMMARY]);
    vi.spyOn(SkillStorage, "get").mockResolvedValue({
      ok: true,
      data: { ...SKILL_DATA, archive: new Uint8Array(new ArrayBuffer(1)) },
    });
    mockExtractArchiveContents.mockResolvedValue({ "SKILL.md": "# main" });

    const resolved = await resolveDelegateSkills(
      [{ name: "@friday/stop-slop", refs: ["nope.md"] }],
      { workspaceId: "ws-1", logger: makeLogger() },
    );

    expect(resolved).toEqual([]);
  });
});

describe("resolveDelegateSkills — caching + parallelism", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockExtractArchiveContents.mockReset();
  });

  it("extracts an archive once when the same skill+version is requested twice across calls", async () => {
    mockVisibility([SUMMARY]);
    vi.spyOn(SkillStorage, "get").mockResolvedValue({
      ok: true,
      data: { ...SKILL_DATA, archive: new Uint8Array(new ArrayBuffer(1)) },
    });
    mockExtractArchiveContents.mockResolvedValue({ "references/phrases.md": "phrases body" });
    const archiveCache = new Map<string, Promise<Record<string, string>>>();

    await resolveDelegateSkills([{ name: "@friday/stop-slop", refs: ["references/phrases.md"] }], {
      workspaceId: "ws-1",
      logger: makeLogger(),
      archiveCache,
    });
    await resolveDelegateSkills([{ name: "@friday/stop-slop", refs: ["references/phrases.md"] }], {
      workspaceId: "ws-1",
      logger: makeLogger(),
      archiveCache,
    });

    expect(mockExtractArchiveContents).toHaveBeenCalledTimes(1);
    expect(archiveCache.size).toBe(1);
  });

  it("evicts a poisoned entry from the cache when extraction fails", async () => {
    mockVisibility([SUMMARY]);
    vi.spyOn(SkillStorage, "get").mockResolvedValue({
      ok: true,
      data: { ...SKILL_DATA, archive: new Uint8Array(new ArrayBuffer(1)) },
    });
    mockExtractArchiveContents.mockRejectedValueOnce(new Error("tar exploded"));
    const archiveCache = new Map<string, Promise<Record<string, string>>>();

    const resolved = await resolveDelegateSkills([{ name: "@friday/stop-slop", refs: ["x.md"] }], {
      workspaceId: "ws-1",
      logger: makeLogger(),
      archiveCache,
    });

    expect(resolved).toEqual([]);
    expect(archiveCache.size).toBe(0);
  });

  it("resolves multiple skills in parallel within one call", async () => {
    const SECOND_SUMMARY = { ...SUMMARY, skillId: "other-1", name: "other" };
    const SECOND_DATA: Skill = {
      ...SKILL_DATA,
      skillId: "other-1",
      name: "other",
      instructions: "second skill body",
    };
    mockVisibility([SUMMARY, SECOND_SUMMARY]);
    const getSpy = vi.spyOn(SkillStorage, "get").mockImplementation((_ns, name) => {
      const data = name === "other" ? SECOND_DATA : SKILL_DATA;
      return Promise.resolve({ ok: true, data });
    });

    const resolved = await resolveDelegateSkills(
      [{ name: "@friday/stop-slop" }, { name: "@friday/other" }],
      { workspaceId: "ws-1", logger: makeLogger() },
    );

    expect(resolved).toHaveLength(2);
    expect(resolved.map((r) => r.name).sort()).toEqual(["@friday/other", "@friday/stop-slop"]);
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it("preserves request order in the resolved output", async () => {
    const SECOND_SUMMARY = { ...SUMMARY, skillId: "other-1", name: "other" };
    const SECOND_DATA: Skill = {
      ...SKILL_DATA,
      skillId: "other-1",
      name: "other",
      instructions: "second body",
    };
    mockVisibility([SUMMARY, SECOND_SUMMARY]);
    vi.spyOn(SkillStorage, "get").mockImplementation((_ns, name) =>
      Promise.resolve({ ok: true, data: name === "other" ? SECOND_DATA : SKILL_DATA }),
    );

    const resolved = await resolveDelegateSkills(
      [{ name: "@friday/other" }, { name: "@friday/stop-slop" }],
      { workspaceId: "ws-1", logger: makeLogger() },
    );

    expect(resolved.map((r) => r.name)).toEqual(["@friday/other", "@friday/stop-slop"]);
  });
});

describe("formatDelegateSkillsBlock", () => {
  it("returns an empty string for no skills", () => {
    expect(formatDelegateSkillsBlock([])).toBe("");
  });

  it("wraps each skill in a named <skill> block inside a <skills> envelope", () => {
    const out = formatDelegateSkillsBlock([
      { name: "@friday/stop-slop", description: "x", body: "no em dashes" },
      { name: "@friday/composing-emails", description: "y", body: "blocks only" },
    ]);
    expect(out).toContain('<skill name="@friday/stop-slop">');
    expect(out).toContain('<skill name="@friday/composing-emails">');
    expect(out.startsWith("<skills>")).toBe(true);
    expect(out.endsWith("</skills>")).toBe(true);
  });
});
