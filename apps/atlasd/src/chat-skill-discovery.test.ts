import type { PlatformModels } from "@atlas/llm";
import type { SkillsShClient, SkillsShDownloadResult, SkillsShSearchResult } from "@atlas/skills";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `smallLLM` is mocked, so platformModels is never read in tests — but the
// signature still requires a value with the right shape.
const fakePlatformModels: PlatformModels = {
  get: () => {
    throw new Error("platformModels.get should not be called when smallLLM is mocked");
  },
};

// ─── Module mocks ────────────────────────────────────────────────────────────

const mockSmallLLM = vi.hoisted(() =>
  vi.fn<
    (params: { system: string; prompt: string; maxOutputTokens?: number }) => Promise<string>
  >(),
);

const mockSkillStorageList = vi.hoisted(() =>
  vi.fn<
    (
      namespace?: string,
      query?: string,
    ) => Promise<{ ok: boolean; data: unknown[]; error?: string }>
  >(),
);

const mockSkillStoragePublish = vi.hoisted(() =>
  vi.fn<
    (
      namespace: string,
      name: string,
      createdBy: string,
      input: Record<string, unknown>,
    ) => Promise<{
      ok: boolean;
      data: { id: string; version: number; name: string; skillId: string };
      error?: string;
    }>
  >(),
);

vi.mock("@atlas/llm", () => ({ smallLLM: mockSmallLLM }));

vi.mock("@atlas/skills", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    SkillStorage: { list: mockSkillStorageList, publish: mockSkillStoragePublish },
  };
});

// Import after mocks
const { discoverAndInstallSkill, judgeComplexity } = await import("./chat-skill-discovery.ts");

// ─── Fixtures ────────────────────────────────────────────────────────────────

function createMockSkillsShClient(overrides: Partial<SkillsShClient> = {}): SkillsShClient {
  return {
    search: vi
      .fn<(query: string, limit?: number) => Promise<SkillsShSearchResult>>()
      .mockResolvedValue({
        query: "test",
        searchType: "semantic",
        skills: [],
        count: 0,
        duration_ms: 5,
      }),
    download: vi
      .fn<(owner: string, repo: string, slug: string) => Promise<SkillsShDownloadResult>>()
      .mockResolvedValue({
        files: [
          {
            path: "SKILL.md",
            contents: "---\nname: test-skill\ndescription: A test skill\n---\nTest instructions",
          },
        ],
        hash: "a".repeat(64),
      }),
    clearCache: vi.fn(),
    ...overrides,
  } as unknown as SkillsShClient;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("judgeComplexity", () => {
  beforeEach(() => {
    mockSmallLLM.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns complex=true when LLM says YES", async () => {
    mockSmallLLM.mockResolvedValueOnce("YES needs deployment");
    const result = await judgeComplexity("deploy my app to production", fakePlatformModels);
    expect(result.complex).toBe(true);
    expect(result.rationale).toBe("needs deployment");
  });

  it("returns complex=false when LLM says NO", async () => {
    mockSmallLLM.mockResolvedValueOnce("NO simple greeting");
    const result = await judgeComplexity("hello", fakePlatformModels);
    expect(result.complex).toBe(false);
    expect(result.rationale).toBe("simple greeting");
  });

  it("defaults to non-complex on LLM failure", async () => {
    mockSmallLLM.mockRejectedValueOnce(new Error("LLM unavailable"));
    const result = await judgeComplexity("build a feature", fakePlatformModels);
    expect(result.complex).toBe(false);
    expect(result.rationale).toBe("judgment failed");
  });

  it("is case-insensitive for YES/NO", async () => {
    mockSmallLLM.mockResolvedValueOnce("yes complex task");
    const result = await judgeComplexity("build something", fakePlatformModels);
    expect(result.complex).toBe(true);
  });
});

describe("discoverAndInstallSkill", () => {
  beforeEach(() => {
    mockSmallLLM.mockReset();
    mockSkillStorageList.mockReset();
    mockSkillStoragePublish.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips discovery when complexity=NO", async () => {
    mockSmallLLM.mockResolvedValueOnce("NO simple question");
    const client = createMockSkillsShClient();

    const result = await discoverAndInstallSkill({
      messageText: "what is TypeScript?",
      workspaceId: "test-ws",
      skillsShClient: client,
      platformModels: fakePlatformModels,
    });

    expect(result.complex).toBe(false);
    expect(result.installedSkillName).toBeNull();
    expect(result.source).toBeNull();
    expect(mockSkillStorageList).not.toHaveBeenCalled();
  });

  it("returns local skill match without calling skills.sh", async () => {
    mockSmallLLM.mockResolvedValueOnce("YES needs debugging");
    mockSkillStorageList.mockResolvedValueOnce({
      ok: true,
      data: [
        {
          id: "id-1",
          skillId: "skill-1",
          namespace: "atlas",
          name: "debugging",
          description: "Debug tools",
          disabled: false,
          latestVersion: 1,
          createdAt: new Date(),
        },
      ],
    });

    const client = createMockSkillsShClient();

    const result = await discoverAndInstallSkill({
      messageText: "debug this error",
      workspaceId: "test-ws",
      skillsShClient: client,
      platformModels: fakePlatformModels,
    });

    expect(result.complex).toBe(true);
    expect(result.installedSkillName).toBe("debugging");
    expect(result.source).toBe("local");
    expect(client.search).not.toHaveBeenCalled();
  });

  it("falls back to skills.sh when no local match", async () => {
    mockSmallLLM.mockResolvedValueOnce("YES needs testing");
    mockSkillStorageList.mockResolvedValueOnce({ ok: true, data: [] });
    mockSkillStoragePublish.mockResolvedValueOnce({
      ok: true,
      data: { id: "pub-1", version: 1, name: "qa-testing", skillId: "skill-qa" },
    });

    const client = createMockSkillsShClient({
      search: vi
        .fn<(query: string, limit?: number) => Promise<SkillsShSearchResult>>()
        .mockResolvedValueOnce({
          query: "qa testing",
          searchType: "semantic",
          skills: [
            {
              id: "s1",
              skillId: "s1-id",
              name: "qa-testing",
              installs: 100,
              source: "anthropic/qa-tools",
            },
          ],
          count: 1,
          duration_ms: 10,
        }),
    });

    const result = await discoverAndInstallSkill({
      messageText: "run QA tests on this feature",
      workspaceId: "test-ws",
      skillsShClient: client,
      platformModels: fakePlatformModels,
    });

    expect(result.complex).toBe(true);
    expect(result.installedSkillName).toBe("qa-testing");
    expect(result.source).toBe("skills.sh");
    expect(mockSkillStoragePublish).toHaveBeenCalledOnce();
  });

  it("returns no skill when skills.sh has no results", async () => {
    mockSmallLLM.mockResolvedValueOnce("YES complex task");
    mockSkillStorageList.mockResolvedValueOnce({ ok: true, data: [] });

    const client = createMockSkillsShClient();

    const result = await discoverAndInstallSkill({
      messageText: "do something very specific",
      workspaceId: "test-ws",
      skillsShClient: client,
      platformModels: fakePlatformModels,
    });

    expect(result.complex).toBe(true);
    expect(result.installedSkillName).toBeNull();
    expect(result.source).toBeNull();
  });

  it("returns null when downloaded skill has invalid frontmatter", async () => {
    mockSmallLLM.mockResolvedValueOnce("YES needs tool");
    mockSkillStorageList.mockResolvedValueOnce({ ok: true, data: [] });

    const client = createMockSkillsShClient({
      search: vi
        .fn<(query: string, limit?: number) => Promise<SkillsShSearchResult>>()
        .mockResolvedValueOnce({
          query: "test",
          searchType: "semantic",
          skills: [
            {
              id: "s1",
              skillId: "s1-id",
              name: "bad-skill",
              installs: 10,
              source: "community/bad",
            },
          ],
          count: 1,
          duration_ms: 5,
        }),
      download: vi
        .fn<(owner: string, repo: string, slug: string) => Promise<SkillsShDownloadResult>>()
        .mockResolvedValueOnce({
          files: [{ path: "SKILL.md", contents: "---\nbad: yaml: syntax\n---\nInstructions" }],
          hash: "b".repeat(64),
        }),
    });

    const result = await discoverAndInstallSkill({
      messageText: "build a feature",
      workspaceId: "test-ws",
      skillsShClient: client,
      platformModels: fakePlatformModels,
    });

    expect(result.complex).toBe(true);
    expect(result.installedSkillName).toBeNull();
    expect(mockSkillStoragePublish).not.toHaveBeenCalled();
  });

  it("returns null when downloaded skill has no SKILL.md", async () => {
    mockSmallLLM.mockResolvedValueOnce("YES needs tool");
    mockSkillStorageList.mockResolvedValueOnce({ ok: true, data: [] });

    const client = createMockSkillsShClient({
      search: vi
        .fn<(query: string, limit?: number) => Promise<SkillsShSearchResult>>()
        .mockResolvedValueOnce({
          query: "test",
          searchType: "semantic",
          skills: [
            {
              id: "s1",
              skillId: "s1-id",
              name: "no-md",
              installs: 10,
              source: "community/noskill",
            },
          ],
          count: 1,
          duration_ms: 5,
        }),
      download: vi
        .fn<(owner: string, repo: string, slug: string) => Promise<SkillsShDownloadResult>>()
        .mockResolvedValueOnce({
          files: [{ path: "README.md", contents: "# Not a skill" }],
          hash: "c".repeat(64),
        }),
    });

    const result = await discoverAndInstallSkill({
      messageText: "build something",
      workspaceId: "test-ws",
      skillsShClient: client,
      platformModels: fakePlatformModels,
    });

    expect(result.complex).toBe(true);
    expect(result.installedSkillName).toBeNull();
  });

  it("handles skills.sh search failure gracefully", async () => {
    mockSmallLLM.mockResolvedValueOnce("YES needs tool");
    mockSkillStorageList.mockResolvedValueOnce({ ok: true, data: [] });

    const client = createMockSkillsShClient({
      search: vi
        .fn<(query: string, limit?: number) => Promise<SkillsShSearchResult>>()
        .mockRejectedValueOnce(new Error("Network error")),
    });

    const result = await discoverAndInstallSkill({
      messageText: "deploy to production",
      workspaceId: "test-ws",
      skillsShClient: client,
      platformModels: fakePlatformModels,
    });

    expect(result.complex).toBe(true);
    expect(result.installedSkillName).toBeNull();
    expect(result.source).toBeNull();
  });
});
