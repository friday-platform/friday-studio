import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock TanStack Query so .svelte imports from node_modules don't break node tests
vi.mock("@tanstack/svelte-query", () => ({
  queryOptions: <T extends object>(opts: T): T => opts,
  skipToken: Symbol.for("skipToken"),
}));

// Mock daemon client so we can assert requests without real network calls
const mockToolsGet = vi.fn();
vi.mock("../daemon-client.ts", () => ({
  getDaemonClient: () => ({
    mcp: {
      ":id": {
        tools: {
          $get: mockToolsGet,
        },
      },
    },
  }),
}));

const { mcpQueries, fetchToolsProbe } = await import("./mcp-queries.ts");

describe("mcpQueries.toolsProbe", () => {
  beforeEach(() => {
    mockToolsGet.mockClear();
  });

  it("returns a query key with the server id", () => {
    const options = mcpQueries.toolsProbe("github");
    expect(options.queryKey).toEqual(["daemon", "mcp", "tools", "github"]);
  });

  it("parses successful probe response", async () => {
    mockToolsGet.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        ok: true,
        tools: [
          { name: "search_repositories", description: "Search GitHub repos" },
          { name: "get_issue" },
        ],
      }),
    });

    const result = await fetchToolsProbe("github");

    expect(mockToolsGet).toHaveBeenCalledWith({ param: { id: "github" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tools).toHaveLength(2);
      expect(result.tools[0]).toEqual({
        name: "search_repositories",
        description: "Search GitHub repos",
      });
      expect(result.tools[1]).toEqual({ name: "get_issue" });
    }
  });

  it("parses failed probe response with phase", async () => {
    mockToolsGet.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        ok: false,
        error: "Connection refused",
        phase: "connect",
      }),
    });

    const result = await fetchToolsProbe("github");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Connection refused");
      expect(result.phase).toBe("connect");
    }
  });

  it("throws on HTTP error status", async () => {
    mockToolsGet.mockResolvedValue({
      ok: false,
      status: 404,
      json: vi.fn().mockResolvedValue({ error: "Server not found" }),
    });

    await expect(fetchToolsProbe("unknown")).rejects.toThrow("Failed to probe MCP tools: 404");
  });

  it("throws on invalid response body", async () => {
    mockToolsGet.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ unexpected: true }),
    });

    await expect(fetchToolsProbe("github")).rejects.toThrow();
  });
});
