/**
 * Tests for the README fetcher utility.
 */

import { describe, it } from "vitest";
import { fetchReadme } from "./readme-fetcher.ts";

/**
 * Fake fetch that returns responses from a lookup map.
 */
function makeFakeFetch(responses: Map<string, { status: number; body: string }>): typeof fetch {
  return ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const match = responses.get(url);
    if (match) {
      return new Response(match.body, { status: match.status });
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
}

describe("fetchReadme", () => {
  it("returns README from main branch", async ({ expect }) => {
    const responses = new Map([
      [
        "https://raw.githubusercontent.com/owner/repo/main/README.md",
        { status: 200, body: "# Hello" },
      ],
    ]);
    const result = await fetchReadme(
      "https://github.com/owner/repo",
      undefined,
      makeFakeFetch(responses),
    );
    expect(result).toBe("# Hello");
  });

  it("falls back to master branch", async ({ expect }) => {
    const responses = new Map([
      [
        "https://raw.githubusercontent.com/owner/repo/main/README.md",
        { status: 404, body: "Not Found" },
      ],
      [
        "https://raw.githubusercontent.com/owner/repo/master/README.md",
        { status: 200, body: "# Master Readme" },
      ],
    ]);
    const result = await fetchReadme(
      "https://github.com/owner/repo",
      undefined,
      makeFakeFetch(responses),
    );
    expect(result).toBe("# Master Readme");
  });

  it("handles subfolder path", async ({ expect }) => {
    const responses = new Map([
      [
        "https://raw.githubusercontent.com/owner/repo/main/packages/mcp/README.md",
        { status: 200, body: "# Subfolder Readme" },
      ],
    ]);
    const result = await fetchReadme(
      "https://github.com/owner/repo",
      "packages/mcp",
      makeFakeFetch(responses),
    );
    expect(result).toBe("# Subfolder Readme");
  });

  it("returns null for non-GitHub URLs", async ({ expect }) => {
    const result = await fetchReadme(
      "https://gitlab.com/owner/repo",
      undefined,
      makeFakeFetch(new Map()),
    );
    expect(result).toBeNull();
  });

  it("returns null when both branches 404", async ({ expect }) => {
    const responses = new Map([
      [
        "https://raw.githubusercontent.com/owner/repo/main/README.md",
        { status: 404, body: "Not Found" },
      ],
      [
        "https://raw.githubusercontent.com/owner/repo/master/README.md",
        { status: 404, body: "Not Found" },
      ],
    ]);
    const result = await fetchReadme(
      "https://github.com/owner/repo",
      undefined,
      makeFakeFetch(responses),
    );
    expect(result).toBeNull();
  });

  it("strips .git suffix from URL", async ({ expect }) => {
    const responses = new Map([
      [
        "https://raw.githubusercontent.com/owner/repo/main/README.md",
        { status: 200, body: "# Clean" },
      ],
    ]);
    const result = await fetchReadme(
      "https://github.com/owner/repo.git",
      undefined,
      makeFakeFetch(responses),
    );
    expect(result).toBe("# Clean");
  });
});
