import { describe, expect, it } from "vitest";
import {
  MCPUpstreamClient,
  UpstreamSearchResponseSchema,
  UpstreamServerEntrySchema,
} from "./upstream-client.ts";

describe("MCPUpstreamClient", () => {
  describe("search", () => {
    it("sends correct query string with search and limit", async () => {
      const mockResponse = {
        servers: [
          {
            server: {
              $schema: "https://schema.modelcontextprotocol.io/server/2025-04-18.json",
              name: "io.github.test/mcp-server",
              description: "Test server",
              version: "1.0.0",
              packages: [
                {
                  registryType: "npm",
                  identifier: "@test/mcp-server",
                  version: "1.0.0",
                  transport: { type: "stdio" },
                },
              ],
            },
            _meta: {
              "io.modelcontextprotocol.registry/official": {
                status: "active",
                statusChangedAt: "2025-01-01T00:00:00Z",
                publishedAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
                isLatest: true,
              },
            },
          },
        ],
      };

      let capturedUrl: string | undefined;
      const mockFetch: typeof fetch = (
        url: URL | RequestInfo,
        _init?: RequestInit,
      ): Promise<Response> => {
        capturedUrl = url.toString();
        return Promise.resolve(
          new Response(JSON.stringify(mockResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      };

      const client = new MCPUpstreamClient({ fetchFn: mockFetch });
      const result = await client.search("filesystem", 10);

      expect(capturedUrl).toEqual(
        "https://registry.modelcontextprotocol.io/v0.1/servers?search=filesystem&limit=10",
      );
      expect(result.servers).toHaveLength(1);
      expect(result.servers[0]?.server.name).toEqual("io.github.test/mcp-server");
    });

    it("appends version parameter when provided", async () => {
      const mockResponse = { servers: [] };

      let capturedUrl: string | undefined;
      const mockFetch: typeof fetch = (
        url: URL | RequestInfo,
        _init?: RequestInit,
      ): Promise<Response> => {
        capturedUrl = url.toString();
        return Promise.resolve(
          new Response(JSON.stringify(mockResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      };

      const client = new MCPUpstreamClient({ fetchFn: mockFetch });
      await client.search("filesystem", 20, "latest");

      expect(capturedUrl).toEqual(
        "https://registry.modelcontextprotocol.io/v0.1/servers?search=filesystem&limit=20&version=latest",
      );
    });

    it("uses default limit of 20 when not specified", async () => {
      const mockResponse = { servers: [] };

      let capturedUrl: string | undefined;
      const mockFetch: typeof fetch = (
        url: URL | RequestInfo,
        _init?: RequestInit,
      ): Promise<Response> => {
        capturedUrl = url.toString();
        return Promise.resolve(
          new Response(JSON.stringify(mockResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      };

      const client = new MCPUpstreamClient({ fetchFn: mockFetch });
      await client.search("test");

      expect(capturedUrl).toContain("limit=20");
    });

    it("URL-encodes special characters in query", async () => {
      const mockResponse = { servers: [] };

      let capturedUrl: string | undefined;
      const mockFetch: typeof fetch = (
        url: URL | RequestInfo,
        _init?: RequestInit,
      ): Promise<Response> => {
        capturedUrl = url.toString();
        return Promise.resolve(
          new Response(JSON.stringify(mockResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      };

      const client = new MCPUpstreamClient({ fetchFn: mockFetch });
      await client.search("hello world & more", 5);

      expect(capturedUrl).toContain("search=hello%20world%20%26%20more");
    });

    it("drops malformed entries but keeps valid ones", async () => {
      // Defense against upstream schema drift: one bad entry must not poison
      // the whole response. Regression test for the 502 caused when a new
      // upstream registryType appeared and the strict outer parse rejected
      // every reddit search result.
      const mockResponse = {
        servers: [
          {
            server: {
              $schema: "https://schema.modelcontextprotocol.io/server/2025-04-18.json",
              name: "io.github.test/good-server",
              description: "Valid",
              version: "1.0.0",
            },
            _meta: {
              "io.modelcontextprotocol.registry/official": {
                status: "active",
                statusChangedAt: "2025-01-01T00:00:00Z",
                publishedAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
                isLatest: true,
              },
            },
          },
          {
            // Broken: missing required `_meta` block.
            server: {
              $schema: "https://schema.modelcontextprotocol.io/server/2025-04-18.json",
              name: "io.github.test/broken-server",
              version: "1.0.0",
            },
          },
          {
            // Broken: server.version missing entirely.
            server: {
              $schema: "https://schema.modelcontextprotocol.io/server/2025-04-18.json",
              name: "io.github.test/no-version",
            },
            _meta: {
              "io.modelcontextprotocol.registry/official": {
                status: "active",
                statusChangedAt: "2025-01-01T00:00:00Z",
                publishedAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
                isLatest: true,
              },
            },
          },
        ],
      };

      const mockFetch: typeof fetch = (
        _input: URL | RequestInfo,
        _init?: RequestInit,
      ): Promise<Response> =>
        Promise.resolve(
          new Response(JSON.stringify(mockResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

      const client = new MCPUpstreamClient({ fetchFn: mockFetch });
      const result = await client.search("test", 10);

      expect(result.servers).toHaveLength(1);
      expect(result.servers[0]?.server.name).toEqual("io.github.test/good-server");
    });
  });

  describe("fetchLatest", () => {
    it("URL-encodes each segment of canonical name separately", async () => {
      const mockResponse = {
        server: {
          $schema: "https://schema.modelcontextprotocol.io/server/2025-04-18.json",
          name: "io.github/Digital-Defiance/mcp-filesystem",
          description: "Filesystem server",
          version: "0.1.9",
          packages: [
            {
              registryType: "npm",
              identifier: "@digital-defiance/mcp-filesystem",
              version: "0.1.9",
              transport: { type: "stdio" },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-12-20T19:25:57.705316Z",
            publishedAt: "2025-12-20T19:25:57.705316Z",
            updatedAt: "2025-12-20T19:25:57.705316Z",
            isLatest: true,
          },
        },
      };

      let capturedUrl: string | undefined;
      const mockFetch: typeof fetch = (
        url: URL | RequestInfo,
        _init?: RequestInit,
      ): Promise<Response> => {
        capturedUrl = url.toString();
        return Promise.resolve(
          new Response(JSON.stringify(mockResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      };

      const client = new MCPUpstreamClient({ fetchFn: mockFetch });
      const result = await client.fetchLatest("io.github/Digital-Defiance/mcp-filesystem");

      expect(capturedUrl).toEqual(
        "https://registry.modelcontextprotocol.io/v0.1/servers/io.github%2FDigital-Defiance%2Fmcp-filesystem/versions/latest",
      );
      expect(result.server.name).toEqual("io.github/Digital-Defiance/mcp-filesystem");
    });

    it("parses response with nanosecond-precision updatedAt", async () => {
      const mockResponse = {
        server: {
          $schema: "https://schema.modelcontextprotocol.io/server/2025-04-18.json",
          name: "io.github.test/mcp-server",
          description: "Test server",
          version: "2.0.0",
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-12-20T19:25:57.705316Z",
            publishedAt: "2025-12-20T19:25:57.705316Z",
            updatedAt: "2025-12-20T19:25:57.705316Z",
            isLatest: true,
          },
        },
      };

      const mockFetch: typeof fetch = (
        _input: URL | RequestInfo,
        _init?: RequestInit,
      ): Promise<Response> =>
        Promise.resolve(
          new Response(JSON.stringify(mockResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

      const client = new MCPUpstreamClient({ fetchFn: mockFetch });
      const result = await client.fetchLatest("test-server");

      // Verify the schema parses the nanosecond timestamp correctly
      const parsed = UpstreamServerEntrySchema.safeParse(mockResponse);
      expect(parsed.success).toBe(true);
      expect(result._meta["io.modelcontextprotocol.registry/official"].updatedAt).toEqual(
        "2025-12-20T19:25:57.705316Z",
      );
    });

    it("throws on non-OK response", async () => {
      const mockFetch: typeof fetch = (
        _input: URL | RequestInfo,
        _init?: RequestInit,
      ): Promise<Response> =>
        Promise.resolve(new Response("Not found", { status: 404, statusText: "Not Found" }));

      const client = new MCPUpstreamClient({ fetchFn: mockFetch });
      await expect(client.fetchLatest("unknown-server")).rejects.toThrow(
        "upstream registry fetch failed: 404 Not Found",
      );
    });

    it("throws on malformed response", async () => {
      const mockResponse = {
        // Missing required 'server' field
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00Z",
            publishedAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
            isLatest: true,
          },
        },
      };

      const mockFetch: typeof fetch = (
        _input: URL | RequestInfo,
        _init?: RequestInit,
      ): Promise<Response> =>
        Promise.resolve(
          new Response(JSON.stringify(mockResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

      const client = new MCPUpstreamClient({ fetchFn: mockFetch });
      await expect(client.fetchLatest("test-server")).rejects.toThrow(
        "upstream registry returned invalid response",
      );
    });
  });

  describe("schema validation", () => {
    it("validates full upstream server entry with all fields", () => {
      const fullEntry = {
        server: {
          $schema: "https://schema.modelcontextprotocol.io/server/2025-04-18.json",
          name: "io.github.test/complex-server",
          description: "A complex test server",
          repository: { url: "https://github.com/test/complex-server", source: "github" },
          version: "1.2.3",
          packages: [
            {
              registryType: "npm",
              identifier: "@test/complex-server",
              version: "1.2.3",
              transport: { type: "stdio" },
              environmentVariables: [
                {
                  name: "API_KEY",
                  description: "API key for service",
                  isRequired: true,
                  isSecret: true,
                  default: "dev-key",
                  placeholder: "sk-...",
                  format: "string",
                  choices: ["dev-key", "prod-key"],
                },
              ],
            },
          ],
          remotes: [
            {
              type: "streamable-http",
              url: "https://api.example.com/{env}/v1",
              headers: [{ name: "Authorization", description: "Bearer token", isRequired: true }],
              variables: {
                env: { description: "Environment", default: "prod", choices: ["dev", "prod"] },
              },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-12-20T19:25:57.705316Z",
            publishedAt: "2025-12-20T19:25:57.705316Z",
            updatedAt: "2025-12-20T19:25:57.705316Z",
            isLatest: true,
          },
        },
      };

      const parsed = UpstreamServerEntrySchema.safeParse(fullEntry);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.server.packages).toHaveLength(1);
        const firstPackage = parsed.data.server.packages?.[0];
        expect(firstPackage?.environmentVariables).toHaveLength(1);
        expect(parsed.data.server.remotes).toHaveLength(1);
      }
    });

    it("validates minimal upstream server entry", () => {
      const minimalEntry = {
        server: {
          $schema: "https://schema.modelcontextprotocol.io/server/2025-04-18.json",
          name: "io.github.test/minimal",
          version: "1.0.0",
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00Z",
            publishedAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
            isLatest: true,
          },
        },
      };

      const parsed = UpstreamServerEntrySchema.safeParse(minimalEntry);
      expect(parsed.success).toBe(true);
    });

    it("accepts arbitrary registry type strings", () => {
      // Upstream spec defines registryType as an open-ended string with
      // npm/pypi/oci/nuget/mcpb as examples; we must accept new values
      // (e.g., "nuget", "cargo", "gem") rather than rejecting the whole entry.
      const entry = {
        server: {
          $schema: "https://schema.modelcontextprotocol.io/server/2025-04-18.json",
          name: "io.github.test/nuget-server",
          version: "1.0.0",
          packages: [
            {
              registryType: "nuget",
              identifier: "TestPackage",
              version: "1.0.0",
              transport: { type: "stdio" },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00Z",
            publishedAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
            isLatest: true,
          },
        },
      };

      const parsed = UpstreamServerEntrySchema.safeParse(entry);
      expect(parsed.success).toBe(true);
    });
  });

  describe("search response schema", () => {
    it("validates search response with multiple results", () => {
      const searchResponse = {
        servers: [
          {
            server: {
              $schema: "https://schema.modelcontextprotocol.io/server/2025-04-18.json",
              name: "io.github.test/server-a",
              description: "Server A",
              version: "1.0.0",
            },
            _meta: {
              "io.modelcontextprotocol.registry/official": {
                status: "active",
                statusChangedAt: "2025-01-01T00:00:00Z",
                publishedAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
                isLatest: true,
              },
            },
          },
          {
            server: {
              $schema: "https://schema.modelcontextprotocol.io/server/2025-04-18.json",
              name: "io.github.test/server-b",
              description: "Server B",
              version: "2.0.0",
            },
            _meta: {
              "io.modelcontextprotocol.registry/official": {
                status: "active",
                statusChangedAt: "2025-01-01T00:00:00Z",
                publishedAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
                isLatest: true,
              },
            },
          },
        ],
      };

      const parsed = UpstreamSearchResponseSchema.safeParse(searchResponse);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.servers).toHaveLength(2);
      }
    });

    it("validates empty search response", () => {
      const emptyResponse = { servers: [] };

      const parsed = UpstreamSearchResponseSchema.safeParse(emptyResponse);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.servers).toHaveLength(0);
      }
    });
  });

  describe("custom baseUrl", () => {
    it("allows overriding baseUrl for testing", async () => {
      const mockResponse = {
        server: {
          $schema: "https://schema.modelcontextprotocol.io/server/2025-04-18.json",
          name: "test-server",
          version: "1.0.0",
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00Z",
            publishedAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
            isLatest: true,
          },
        },
      };

      let capturedUrl: string | undefined;
      const mockFetch: typeof fetch = (
        url: URL | RequestInfo,
        _init?: RequestInit,
      ): Promise<Response> => {
        capturedUrl = url.toString();
        return Promise.resolve(
          new Response(JSON.stringify(mockResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      };

      const client = new MCPUpstreamClient({
        baseUrl: "http://localhost:8080/api",
        fetchFn: mockFetch,
      });
      await client.fetchLatest("test");

      expect(capturedUrl).toEqual("http://localhost:8080/api/servers/test/versions/latest");
    });

    it("trims trailing slash from baseUrl", async () => {
      const mockResponse = { servers: [] };

      let capturedUrl: string | undefined;
      const mockFetch: typeof fetch = (
        url: URL | RequestInfo,
        _init?: RequestInit,
      ): Promise<Response> => {
        capturedUrl = url.toString();
        return Promise.resolve(
          new Response(JSON.stringify(mockResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      };

      const client = new MCPUpstreamClient({ baseUrl: "http://test.com/", fetchFn: mockFetch });
      await client.search("test");

      expect(capturedUrl).toEqual("http://test.com/servers?search=test&limit=20");
    });
  });
});
