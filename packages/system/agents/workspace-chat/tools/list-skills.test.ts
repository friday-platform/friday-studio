import type { Logger } from "@atlas/logger";
import type { SkillSummary } from "@atlas/skills";
import { SkillStorage } from "@atlas/skills";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDescribeSkillTool,
  createListSkillsTool,
  createSearchSkillsTool,
} from "./list-skills.ts";

const { mockResolveVisibleSkills } = vi.hoisted(() => ({
  mockResolveVisibleSkills: vi.fn<() => Promise<SkillSummary[]>>(),
}));

vi.mock("@atlas/skills", async () => {
  const actual = await vi.importActual<typeof import("@atlas/skills")>("@atlas/skills");
  return { ...actual, resolveVisibleSkills: mockResolveVisibleSkills };
});

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

const TOOL_CALL_OPTS = { toolCallId: "test-call", messages: [] as never[] };

function summary(
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
    createdAt: new Date(),
    userInvocable: true,
    ...overrides,
  };
}

beforeEach(() => {
  mockResolveVisibleSkills.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// list_skills
// =============================================================================

describe("createListSkillsTool", () => {
  it("registers a list_skills tool", () => {
    const tools = createListSkillsTool("ws-1", makeLogger());
    expect(tools).toHaveProperty("list_skills");
  });

  it("defaults to workspace scope and returns refs sorted alphabetically", async () => {
    mockResolveVisibleSkills.mockResolvedValueOnce([
      summary("svelte", "core", "Core Svelte patterns"),
      summary("friday", "qa", "QA helpers"),
    ]);

    const tools = createListSkillsTool("ws-1", makeLogger());
    const result = await tools.list_skills?.execute?.({}, TOOL_CALL_OPTS);

    expect(result).toMatchObject({ ok: true, scope: "workspace", count: 2 });
    const refs = (result as { skills: Array<{ ref: string }> }).skills.map((s) => s.ref);
    expect(refs).toEqual(["@friday/qa", "@svelte/core"]);
  });

  it("returns each entry with the canonical ref + namespace + name + description", async () => {
    mockResolveVisibleSkills.mockResolvedValueOnce([
      summary("svelte", "core", "Patterns for Svelte 5 components", { latestVersion: 7 }),
    ]);

    const tools = createListSkillsTool("ws-1", makeLogger());
    const result = await tools.list_skills?.execute?.({}, TOOL_CALL_OPTS);

    expect(result).toMatchObject({
      ok: true,
      skills: [
        {
          ref: "@svelte/core",
          namespace: "svelte",
          name: "core",
          description: "Patterns for Svelte 5 components",
          latestVersion: 7,
        },
      ],
    });
  });

  it("uses SkillStorage.list when scope=catalog", async () => {
    vi.spyOn(SkillStorage, "list").mockResolvedValue({
      ok: true,
      data: [summary("friday", "qa", "QA helpers")],
    });

    const tools = createListSkillsTool("ws-1", makeLogger());
    const result = await tools.list_skills?.execute?.({ scope: "catalog" }, TOOL_CALL_OPTS);

    expect(result).toMatchObject({ ok: true, scope: "catalog", count: 1 });
    expect(mockResolveVisibleSkills).not.toHaveBeenCalled();
  });

  it("filters out skills without a name", async () => {
    mockResolveVisibleSkills.mockResolvedValueOnce([
      summary("svelte", "core", "Core"),
      // null name — synthetic catalog row
      { ...summary("orphan", "x", ""), name: null } as SkillSummary,
    ]);

    const tools = createListSkillsTool("ws-1", makeLogger());
    const result = await tools.list_skills?.execute?.({}, TOOL_CALL_OPTS);

    expect((result as { skills: unknown[] }).skills).toHaveLength(1);
  });

  it("propagates failures via ok:false", async () => {
    mockResolveVisibleSkills.mockRejectedValueOnce(new Error("kv down"));

    const tools = createListSkillsTool("ws-1", makeLogger());
    const result = await tools.list_skills?.execute?.({}, TOOL_CALL_OPTS);

    expect(result).toEqual({ ok: false, error: "list_skills failed: kv down" });
  });
});

// =============================================================================
// search_skills
// =============================================================================

describe("createSearchSkillsTool", () => {
  it("ranks name matches above description matches", async () => {
    mockResolveVisibleSkills.mockResolvedValueOnce([
      summary("a", "z-extra", "QA description hit"),
      summary("a", "qa", "unrelated body"),
      summary("a", "other", "no match here"),
    ]);

    const tools = createSearchSkillsTool("ws-1", makeLogger());
    const result = await tools.search_skills?.execute?.({ query: "qa" }, TOOL_CALL_OPTS);

    expect(result).toMatchObject({ ok: true, count: 2 });
    const refs = (result as { skills: Array<{ ref: string }> }).skills.map((s) => s.ref);
    expect(refs).toEqual(["@a/qa", "@a/z-extra"]);
  });

  it("respects k cap", async () => {
    mockResolveVisibleSkills.mockResolvedValueOnce([
      summary("a", "alpha", "match"),
      summary("a", "beta", "match"),
      summary("a", "gamma", "match"),
    ]);

    const tools = createSearchSkillsTool("ws-1", makeLogger());
    const result = await tools.search_skills?.execute?.({ query: "match", k: 2 }, TOOL_CALL_OPTS);

    expect((result as { skills: unknown[] }).skills).toHaveLength(2);
  });

  it("returns no skills when nothing matches", async () => {
    mockResolveVisibleSkills.mockResolvedValueOnce([summary("a", "alpha", "nothing here")]);

    const tools = createSearchSkillsTool("ws-1", makeLogger());
    const result = await tools.search_skills?.execute?.({ query: "zzzz" }, TOOL_CALL_OPTS);

    expect(result).toMatchObject({ ok: true, count: 0, skills: [] });
  });

  it("matches case-insensitively", async () => {
    mockResolveVisibleSkills.mockResolvedValueOnce([summary("a", "alpha", "Cookie Monster")]);

    const tools = createSearchSkillsTool("ws-1", makeLogger());
    const result = await tools.search_skills?.execute?.({ query: "COOKIE" }, TOOL_CALL_OPTS);

    expect(result).toMatchObject({ ok: true, count: 1 });
  });
});

// =============================================================================
// describe_skill
// =============================================================================

describe("createDescribeSkillTool", () => {
  it("returns the full description, version, and source from the catalog record", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({
      ok: true,
      data: {
        id: "row-1",
        skillId: "skill-1",
        namespace: "svelte",
        name: "core",
        version: 7,
        description: "Detailed description of patterns and conventions.",
        descriptionManual: false,
        disabled: false,
        frontmatter: { source: "skills.sh/foo/bar" },
        instructions: "...",
        archive: null,
        createdBy: "user-1",
        createdAt: new Date(),
      },
    });

    const tools = createDescribeSkillTool(makeLogger());
    const result = await tools.describe_skill?.execute?.({ ref: "@svelte/core" }, TOOL_CALL_OPTS);

    expect(result).toMatchObject({
      ok: true,
      ref: "@svelte/core",
      namespace: "svelte",
      name: "core",
      description: "Detailed description of patterns and conventions.",
      latestVersion: 7,
      source: "skills.sh/foo/bar",
    });
  });

  it("returns ok:false when ref is malformed", async () => {
    const tools = createDescribeSkillTool(makeLogger());
    const result = await tools.describe_skill?.execute?.({ ref: "not-a-ref" }, TOOL_CALL_OPTS);

    expect(result).toMatchObject({ ok: false });
  });

  it("returns ok:false when the skill is missing from the catalog", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: null });

    const tools = createDescribeSkillTool(makeLogger());
    const result = await tools.describe_skill?.execute?.(
      { ref: "@svelte/missing" },
      TOOL_CALL_OPTS,
    );

    expect(result).toMatchObject({ ok: false });
  });

  it("propagates SkillStorage.get failures", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: false, error: "broker down" });

    const tools = createDescribeSkillTool(makeLogger());
    const result = await tools.describe_skill?.execute?.({ ref: "@svelte/core" }, TOOL_CALL_OPTS);

    expect(result).toMatchObject({ ok: false, error: "broker down" });
  });
});

// =============================================================================
// invocation contract — schema fields present
// =============================================================================

describe("retrieval tool contract", () => {
  it("each list/search/describe tool returns canonical ref + description fields", async () => {
    mockResolveVisibleSkills.mockResolvedValue([
      summary("svelte", "core", "Patterns for Svelte 5 components"),
    ]);
    vi.spyOn(SkillStorage, "get").mockResolvedValue({
      ok: true,
      data: {
        id: "row-1",
        skillId: "skill-1",
        namespace: "svelte",
        name: "core",
        version: 1,
        description: "Patterns for Svelte 5 components",
        descriptionManual: false,
        disabled: false,
        frontmatter: {},
        instructions: "...",
        archive: null,
        createdBy: "user-1",
        createdAt: new Date(),
      },
    });

    const list = createListSkillsTool("ws-1", makeLogger());
    const search = createSearchSkillsTool("ws-1", makeLogger());
    const describe = createDescribeSkillTool(makeLogger());

    const listResult = (await list.list_skills?.execute?.({}, TOOL_CALL_OPTS)) as {
      skills: Array<{ ref: string; description: string }>;
    };
    expect(listResult.skills[0]).toHaveProperty("ref");
    expect(listResult.skills[0]).toHaveProperty("description");

    const searchResult = (await search.search_skills?.execute?.(
      { query: "patterns" },
      TOOL_CALL_OPTS,
    )) as { skills: Array<{ ref: string; description: string }> };
    expect(searchResult.skills[0]).toHaveProperty("ref");
    expect(searchResult.skills[0]).toHaveProperty("description");

    const describeResult = await describe.describe_skill?.execute?.(
      { ref: "@svelte/core" },
      TOOL_CALL_OPTS,
    );
    expect(describeResult).toHaveProperty("ref");
    expect(describeResult).toHaveProperty("description");
  });
});
