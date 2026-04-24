import { describe, expect, it, vi } from "vitest";

// Mock svelte-query so .svelte imports from node_modules don't break node tests
vi.mock("@tanstack/svelte-query", () => ({
  queryOptions: (opts: Record<string, unknown>) => opts,
}));

const { linkProviderQueries } = await import("./link-provider-queries.ts");

describe("linkProviderQueries", () => {
  describe("all", () => {
    it("returns the base query key", () => {
      expect(linkProviderQueries.all()).toEqual(["daemon", "link", "providers"]);
    });
  });

  describe("providerDetails", () => {
    it("produces a query key with provider id", () => {
      const options = linkProviderQueries.providerDetails("openai");
      expect(options.queryKey).toEqual([
        "daemon",
        "link",
        "providers",
        "details",
        "openai",
      ]);
    });

    it("sets staleTime to 60 seconds", () => {
      const options = linkProviderQueries.providerDetails("openai");
      expect(options.staleTime).toBe(60_000);
    });
  });

  describe("credentialsByProvider", () => {
    it("produces a query key with provider id", () => {
      const options = linkProviderQueries.credentialsByProvider("github");
      expect(options.queryKey).toEqual([
        "daemon",
        "link",
        "providers",
        "credentials",
        "github",
      ]);
    });

    it("sets staleTime to 30 seconds", () => {
      const options = linkProviderQueries.credentialsByProvider("github");
      expect(options.staleTime).toBe(30_000);
    });
  });
});
