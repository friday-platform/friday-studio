import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SkillsShClient,
  SkillsShDownloadResultSchema,
  SkillsShSearchResultSchema,
  type SkillsShSkillEntry,
  sortByOfficialPriority,
} from "./skills-sh-client.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<SkillsShSkillEntry> = {}): SkillsShSkillEntry {
  return {
    id: "test-id",
    skillId: "test-skill-id",
    name: "test-skill",
    installs: 100,
    source: "community/repo",
    ...overrides,
  };
}

const VALID_SEARCH_RESPONSE = {
  query: "deploy",
  searchType: "semantic",
  skills: [
    makeEntry({ name: "deploy-tool", source: "community/deploy", installs: 50 }),
    makeEntry({ name: "deploy-official", source: "anthropic/deploy", installs: 30 }),
  ],
  count: 2,
  duration_ms: 12.5,
};

const VALID_DOWNLOAD_RESPONSE = {
  files: [
    {
      path: "SKILL.md",
      contents: "---\nname: test\ndescription: A test skill\n---\nInstructions here",
    },
    { path: "README.md", contents: "# Test" },
  ],
  hash: "a".repeat(64),
};

// ─── sortByOfficialPriority ──────────────────────────────────────────────────

describe("sortByOfficialPriority", () => {
  it("ranks official orgs above community", () => {
    const entries = [
      makeEntry({ name: "community-tool", source: "community/repo", installs: 1000 }),
      makeEntry({ name: "official-tool", source: "anthropic/repo", installs: 10 }),
    ];

    const sorted = sortByOfficialPriority(entries);
    expect(sorted[0]?.name).toBe("official-tool");
    expect(sorted[1]?.name).toBe("community-tool");
  });

  it("uses installs as tiebreaker within the same tier", () => {
    const entries = [
      makeEntry({ name: "low-installs", source: "anthropic/a", installs: 5 }),
      makeEntry({ name: "high-installs", source: "vercel/b", installs: 500 }),
    ];

    const sorted = sortByOfficialPriority(entries);
    expect(sorted[0]?.name).toBe("high-installs");
  });

  it("recognises multiple official orgs", () => {
    for (const org of [
      "anthropic",
      "anthropics",
      "vercel",
      "microsoft",
      "google",
      "openai",
      "github",
      "supabase",
      "official",
    ]) {
      const entries = [
        makeEntry({ name: "community", source: "random/repo" }),
        makeEntry({ name: "official", source: `${org}/repo` }),
      ];
      const sorted = sortByOfficialPriority(entries);
      expect(sorted[0]?.name).toBe("official");
    }
  });

  it("does not mutate the original array", () => {
    const entries = [
      makeEntry({ name: "b", source: "community/b" }),
      makeEntry({ name: "a", source: "anthropic/a" }),
    ];
    const original = [...entries];
    sortByOfficialPriority(entries);
    expect(entries).toEqual(original);
  });
});

// ─── Zod schema validation ───────────────────────────────────────────────────

describe("Zod schemas", () => {
  it("validates a well-formed search result", () => {
    const result = SkillsShSearchResultSchema.safeParse(VALID_SEARCH_RESPONSE);
    expect(result.success).toBe(true);
  });

  it("rejects search result with missing fields", () => {
    const result = SkillsShSearchResultSchema.safeParse({ query: "test" });
    expect(result.success).toBe(false);
  });

  it("validates a well-formed download result", () => {
    const result = SkillsShDownloadResultSchema.safeParse(VALID_DOWNLOAD_RESPONSE);
    expect(result.success).toBe(true);
  });

  it("rejects download result with wrong hash length", () => {
    const result = SkillsShDownloadResultSchema.safeParse({
      ...VALID_DOWNLOAD_RESPONSE,
      hash: "tooshort",
    });
    expect(result.success).toBe(false);
  });

  it("rejects download result with non-string file contents", () => {
    const result = SkillsShDownloadResultSchema.safeParse({
      files: [{ path: "SKILL.md", contents: 123 }],
      hash: "a".repeat(64),
    });
    expect(result.success).toBe(false);
  });
});

// ─── SkillsShClient ──────────────────────────────────────────────────────────

describe("SkillsShClient", () => {
  let mockFetch: ReturnType<
    typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>
  >;

  beforeEach(() => {
    mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createClient(ttlMs = 60_000): SkillsShClient {
    return new SkillsShClient({ baseUrl: "https://skills.sh", ttlMs, fetchFn: mockFetch });
  }

  describe("search", () => {
    it("calls the correct URL and returns parsed results", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(VALID_SEARCH_RESPONSE), { status: 200 }),
      );

      const client = createClient();
      const result = await client.search("deploy", 5);

      expect(mockFetch).toHaveBeenCalledOnce();
      const calledUrl = String(mockFetch.mock.calls[0]?.[0]);
      expect(calledUrl).toContain("/api/search?q=deploy&limit=5");
      expect(result.query).toBe("deploy");
      expect(result.skills.length).toBe(2);
    });

    it("sorts results by official priority", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(VALID_SEARCH_RESPONSE), { status: 200 }),
      );

      const client = createClient();
      const result = await client.search("deploy");

      // anthropic/deploy should come first
      expect(result.skills[0]?.name).toBe("deploy-official");
    });

    it("throws on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response("Not Found", { status: 404, statusText: "Not Found" }),
      );

      const client = createClient();
      await expect(client.search("test")).rejects.toThrow("skills.sh search failed: 404 Not Found");
    });

    it("throws on malformed response", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ bad: "data" }), { status: 200 }),
      );

      const client = createClient();
      await expect(client.search("test")).rejects.toThrow("skills.sh returned invalid response");
    });

    it("caches results within TTL", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(VALID_SEARCH_RESPONSE), { status: 200 }),
      );

      const client = createClient(60_000);
      await client.search("deploy", 10);
      await client.search("deploy", 10);

      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("does not use cache for different queries", async () => {
      mockFetch
        .mockResolvedValueOnce(new Response(JSON.stringify(VALID_SEARCH_RESPONSE), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify(VALID_SEARCH_RESPONSE), { status: 200 }),
        );

      const client = createClient();
      await client.search("deploy", 10);
      await client.search("different", 10);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("evicts expired cache entries", async () => {
      mockFetch
        .mockResolvedValueOnce(new Response(JSON.stringify(VALID_SEARCH_RESPONSE), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify(VALID_SEARCH_RESPONSE), { status: 200 }),
        );

      // Use a 0ms TTL so entries expire immediately
      const client = createClient(0);
      await client.search("deploy", 10);

      // Wait a tick for the TTL to pass
      await new Promise((resolve) => setTimeout(resolve, 1));
      await client.search("deploy", 10);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("download", () => {
    it("calls the correct URL and returns parsed results", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(VALID_DOWNLOAD_RESPONSE), { status: 200 }),
      );

      const client = createClient();
      const result = await client.download("anthropic", "skills", "deploy");

      expect(mockFetch).toHaveBeenCalledOnce();
      const calledUrl = String(mockFetch.mock.calls[0]?.[0]);
      expect(calledUrl).toContain("/api/download/anthropic/skills/deploy");
      expect(result.files.length).toBe(2);
      expect(result.hash).toBe("a".repeat(64));
    });

    it("caches download results", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(VALID_DOWNLOAD_RESPONSE), { status: 200 }),
      );

      const client = createClient();
      await client.download("anthropic", "skills", "deploy");
      await client.download("anthropic", "skills", "deploy");

      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("throws on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response("Server Error", { status: 500, statusText: "Internal Server Error" }),
      );

      const client = createClient();
      await expect(client.download("a", "b", "c")).rejects.toThrow(
        "skills.sh download failed: 500 Internal Server Error",
      );
    });
  });

  describe("clearCache", () => {
    it("clears all cached entries", async () => {
      mockFetch
        .mockResolvedValueOnce(new Response(JSON.stringify(VALID_SEARCH_RESPONSE), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify(VALID_SEARCH_RESPONSE), { status: 200 }),
        );

      const client = createClient();
      await client.search("deploy", 10);
      client.clearCache();
      await client.search("deploy", 10);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
