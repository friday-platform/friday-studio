import { describe, expect, it, vi } from "vitest";

// Mock svelte-query so .svelte imports from node_modules don't break node tests
vi.mock("@tanstack/svelte-query", () => ({
  queryOptions: (opts: Record<string, unknown>) => opts,
}));

const { linkProviderQueries, ProviderDetailsSchema } = await import(
  "./link-provider-queries.ts"
);

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

  describe("ProviderDetailsSchema secretSchema", () => {
    it("parses a property with rich JSON-Schema annotations", () => {
      const payload: unknown = {
        id: "bitbucket-mcp",
        displayName: "Bitbucket",
        type: "apikey",
        description: "Bitbucket MCP provider",
        secretSchema: {
          properties: {
            api_token: {
              type: "string",
              description: "Bitbucket app password",
              format: "password",
              writeOnly: true,
            },
          },
          required: ["api_token"],
        },
      };

      const parsed = ProviderDetailsSchema.parse(payload);
      const prop = parsed.secretSchema?.properties?.api_token;
      expect(prop?.type).toBe("string");
      expect(prop?.description).toBe("Bitbucket app password");
      expect(prop?.format).toBe("password");
      expect(prop?.writeOnly).toBe(true);
    });

    it("parses a bare { type: 'string' } property and leaves annotations undefined", () => {
      const payload: unknown = {
        id: "openai",
        displayName: "OpenAI",
        type: "apikey",
        description: "OpenAI provider",
        secretSchema: {
          properties: {
            api_key: { type: "string" },
          },
          required: ["api_key"],
        },
      };

      const parsed = ProviderDetailsSchema.parse(payload);
      const prop = parsed.secretSchema?.properties?.api_key;
      expect(prop?.type).toBe("string");
      expect(prop?.description).toBeUndefined();
      expect(prop?.format).toBeUndefined();
      expect(prop?.writeOnly).toBeUndefined();
    });

    it("passes unknown keys through on a property", () => {
      const payload: unknown = {
        id: "weird",
        displayName: "Weird",
        type: "apikey",
        description: "",
        secretSchema: {
          properties: {
            token: {
              type: "string",
              minLength: 10,
              "x-custom": "hello",
            },
          },
        },
      };

      const parsed = ProviderDetailsSchema.parse(payload);
      const prop: Record<string, unknown> = {
        ...parsed.secretSchema?.properties?.token,
      };
      expect(prop.minLength).toBe(10);
      expect(prop["x-custom"]).toBe("hello");
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
