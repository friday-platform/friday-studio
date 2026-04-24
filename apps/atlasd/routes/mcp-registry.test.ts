import process from "node:process";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import { LocalMCPRegistryAdapter } from "@atlas/core/mcp-registry/storage";
import type { UpstreamServerEntry } from "@atlas/core/mcp-registry/upstream-client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// In-memory KV + adapter for test isolation
let testKv: Deno.Kv;
let testAdapter: LocalMCPRegistryAdapter;

vi.mock("@atlas/core/mcp-registry/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@atlas/core/mcp-registry/storage")>();
  return { ...original, getMCPRegistryAdapter: () => Promise.resolve(testAdapter) };
});

// Mock the upstream client - use simpler typing to avoid esbuild parsing issues
type SearchResult = { server: { name: string } };
const mockFetchLatest = vi.fn<(name: string) => Promise<UpstreamServerEntry>>();
const mockSearch = vi.fn<(query: string, limit?: number) => Promise<{ servers: SearchResult[] }>>();

vi.mock("@atlas/core/mcp-registry/upstream-client", () => ({
  MCPUpstreamClient: class MockClient {
    fetchLatest(name: string): Promise<UpstreamServerEntry> {
      return mockFetchLatest(name);
    }
    search(query: string, limit = 20) {
      return mockSearch(query, limit);
    }
  },
}));

beforeAll(async () => {
  testKv = await Deno.openKv(":memory:");
  testAdapter = new LocalMCPRegistryAdapter(testKv);
  process.env.LINK_SERVICE_URL = "http://localhost:3100";
  process.env.ATLAS_KEY = "test-atlas-key";
});

afterAll(() => {
  testKv.close();
  delete process.env.LINK_SERVICE_URL;
  delete process.env.ATLAS_KEY;
});

beforeEach(() => {
  mockFetchLatest.mockReset();
  mockSearch.mockReset();
});

// Import AFTER mock setup (vi.mock is hoisted, but this makes intent clear)
const { mcpRegistryRouter } = await import("./mcp-registry.ts");

/** Create a valid test entry with unique ID */
function createTestEntry(
  suffix: string,
): Omit<MCPServerMetadata, "source"> & { source: "web" | "agents" } {
  return {
    id: `test-${suffix}`,
    name: `Test Server ${suffix}`,
    source: "web",
    securityRating: "medium",
    configTemplate: { transport: { type: "stdio", command: "echo", args: ["hello"] } },
    requiredConfig: [{ key: "TEST_KEY", description: "A test key", type: "string" as const }],
  };
}

/** Create a valid npm stdio upstream entry */
function createNpmStdioUpstreamEntry(name: string, version: string): UpstreamServerEntry {
  return {
    server: {
      $schema: "https://registry.modelcontextprotocol.io/v0.1/schema.json",
      name,
      description: `Test server ${name}`,
      version,
      packages: [
        {
          registryType: "npm",
          identifier: `@test/${name.split("/").pop()}`,
          version,
          transport: { type: "stdio" },
        },
      ],
    },
    _meta: {
      "io.modelcontextprotocol.registry/official": {
        status: "active",
        statusChangedAt: "2025-06-15T12:00:00.000000Z",
        publishedAt: "2025-06-15T12:00:00.000000Z",
        updatedAt: "2025-06-15T12:00:00.000000Z",
        isLatest: true,
      },
    },
  };
}

/** Create a valid npm stdio upstream entry with env vars (produces linkProvider) */
function createNpmStdioUpstreamEntryWithEnv(name: string, version: string): UpstreamServerEntry {
  return {
    server: {
      $schema: "https://registry.modelcontextprotocol.io/v0.1/schema.json",
      name,
      description: `Test server ${name}`,
      version,
      packages: [
        {
          registryType: "npm",
          identifier: `@test/${name.split("/").pop()}`,
          version,
          transport: { type: "stdio" },
          environmentVariables: [
            { name: "API_KEY", description: "API key for the server", isRequired: true },
          ],
        },
      ],
    },
    _meta: {
      "io.modelcontextprotocol.registry/official": {
        status: "active",
        statusChangedAt: "2025-06-15T12:00:00.000000Z",
        publishedAt: "2025-06-15T12:00:00.000000Z",
        updatedAt: "2025-06-15T12:00:00.000000Z",
        isLatest: true,
      },
    },
  };
}

/** Create a docker-only upstream entry (will be rejected) */
function createDockerOnlyUpstreamEntry(name: string, version: string): UpstreamServerEntry {
  return {
    server: {
      $schema: "https://registry.modelcontextprotocol.io/v0.1/schema.json",
      name,
      description: `Docker server ${name}`,
      version,
      packages: [
        {
          registryType: "oci",
          identifier: `docker.io/test/${name.split("/").pop()}`,
          version,
          transport: { type: "stdio" },
        },
      ],
    },
    _meta: {
      "io.modelcontextprotocol.registry/official": {
        status: "active",
        statusChangedAt: "2025-06-15T12:00:00.000000Z",
        publishedAt: "2025-06-15T12:00:00.000000Z",
        updatedAt: "2025-06-15T12:00:00.000000Z",
        isLatest: true,
      },
    },
  };
}

/** Create a streamable-http upstream entry without env vars (produces OAuth linkProvider) */
function createHttpRemoteUpstreamEntry(name: string, version: string): UpstreamServerEntry {
  return {
    server: {
      $schema: "https://registry.modelcontextprotocol.io/v0.1/schema.json",
      name,
      description: `HTTP remote server ${name}`,
      version,
      remotes: [{ type: "streamable-http", url: "https://api.example.com/mcp" }],
    },
    _meta: {
      "io.modelcontextprotocol.registry/official": {
        status: "active",
        statusChangedAt: "2025-06-15T12:00:00.000000Z",
        publishedAt: "2025-06-15T12:00:00.000000Z",
        updatedAt: "2025-06-15T12:00:00.000000Z",
        isLatest: true,
      },
    },
  };
}

/** Create a streamable-http upstream entry with env vars from packages (produces API key linkProvider) */
function createHttpRemoteWithEnvUpstreamEntry(name: string, version: string): UpstreamServerEntry {
  return {
    server: {
      $schema: "https://registry.modelcontextprotocol.io/v0.1/schema.json",
      name,
      description: `HTTP remote server with env ${name}`,
      version,
      packages: [
        {
          registryType: "pypi",
          identifier: "http-env-server",
          version,
          transport: { type: "stdio" },
          environmentVariables: [
            { name: "API_KEY", description: "API key for the server", isRequired: true },
          ],
        },
      ],
      remotes: [{ type: "streamable-http", url: "https://api.example.com/mcp" }],
    },
    _meta: {
      "io.modelcontextprotocol.registry/official": {
        status: "active",
        statusChangedAt: "2025-06-15T12:00:00.000000Z",
        publishedAt: "2025-06-15T12:00:00.000000Z",
        updatedAt: "2025-06-15T12:00:00.000000Z",
        isLatest: true,
      },
    },
  };
}

/** Create an SSE-only upstream entry (will be rejected) */
function createSseOnlyUpstreamEntry(name: string, version: string): UpstreamServerEntry {
  return {
    server: {
      $schema: "https://registry.modelcontextprotocol.io/v0.1/schema.json",
      name,
      description: `SSE server ${name}`,
      version,
      remotes: [{ type: "sse", url: "https://example.com/events" }],
    },
    _meta: {
      "io.modelcontextprotocol.registry/official": {
        status: "active",
        statusChangedAt: "2025-06-15T12:00:00.000000Z",
        publishedAt: "2025-06-15T12:00:00.000000Z",
        updatedAt: "2025-06-15T12:00:00.000000Z",
        isLatest: true,
      },
    },
  };
}

/** Schema for successful create response */
const CreateResponseSchema = z.object({
  server: z.object({ id: z.string(), name: z.string(), source: z.string() }).passthrough(),
});

/** Schema for error response */
const ErrorResponseSchema = z.object({ error: z.string(), suggestion: z.string().optional() });

/** Schema for list response */
const ListResponseSchema = z.object({
  servers: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
  metadata: z.object({ version: z.string(), staticCount: z.number(), dynamicCount: z.number() }),
});

/** Schema for single server response */
const ServerResponseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    source: z.string().optional(),
    configTemplate: z
      .object({ transport: z.object({ type: z.string() }).passthrough() })
      .passthrough(),
  })
  .passthrough();

/** Schema for search response */
const SearchResponseSchema = z.object({
  servers: z.array(
    z
      .object({
        name: z.string(),
        alreadyInstalled: z.boolean(),
        repositoryUrl: z.string().nullable().optional(),
      })
      .passthrough(),
  ),
});

/** Schema for check-update response */
const CheckUpdateResponseSchema = z.object({
  hasUpdate: z.boolean(),
  remote: z.object({ updatedAt: z.string(), version: z.string() }).optional(),
  reason: z.string().optional(),
});

/** Schema for install success response */
const InstallResponseSchema = z.object({
  server: z
    .object({
      id: z.string(),
      source: z.string(),
      upstream: z
        .object({ canonicalName: z.string(), version: z.string(), updatedAt: z.string() })
        .optional(),
    })
    .passthrough(),
  warning: z.string().optional(),
});

/** Schema for install error response */
const InstallErrorSchema = z.object({
  error: z.string(),
  suggestion: z.string().optional(),
  existingId: z.string().optional(),
});

/** Schema for check-update false response */
const CheckUpdateFalseSchema = z.object({ hasUpdate: z.literal(false), reason: z.string() });

/** Schema for update response */
const UpdateResponseSchema = z.object({
  server: z
    .object({
      id: z.string(),
      upstream: z.object({ version: z.string(), updatedAt: z.string() }).optional(),
    })
    .passthrough(),
});

describe("MCP Registry Routes", () => {
  // ═══════════════════════════════════════════════════════════════════════
  // EXISTING ROUTES (POST /, GET /, GET /:id)
  // ═══════════════════════════════════════════════════════════════════════

  describe("POST / (existing)", () => {
    it("POST / creates entry and returns 201", async () => {
      const entry = createTestEntry("create-basic");

      const res = await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      expect(res.status).toEqual(201);
      const body = CreateResponseSchema.parse(await res.json());
      expect(body.server.id).toEqual(entry.id);
      expect(body.server.name).toEqual(entry.name);
    });

    it("POST / returns 409 for blessed registry collision", async () => {
      const blessedIds = Object.keys(mcpServersRegistry.servers);
      const blessedId = blessedIds[0];
      if (!blessedId) throw new Error("expected at least one blessed server");
      const entry = { ...createTestEntry("blessed-collision"), id: blessedId };

      const res = await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      expect(res.status).toEqual(409);
      const body = ErrorResponseSchema.parse(await res.json());
      expect(body.error).toContain("blessed registry");
    });

    it("POST / returns 409 for dynamic collision with suggestion", async () => {
      const entry = createTestEntry("collision-test");

      const firstRes = await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });
      expect(firstRes.status).toEqual(201);

      const res = await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      expect(res.status).toEqual(409);
      const body = ErrorResponseSchema.parse(await res.json());
      expect(body.error).toContain("already used");
      expect(body.suggestion).toBeDefined();
    });

    it("POST / validates entry schema (rejects invalid ID)", async () => {
      const invalidEntry = { ...createTestEntry("invalid"), id: "INVALID_ID_WITH_CAPS" };

      const res = await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry: invalidEntry }),
      });

      expect(res.status).toEqual(400);
    });
  });

  describe("GET / (existing)", () => {
    it("GET / lists static and dynamic servers merged", async () => {
      const entry = createTestEntry("list-test");
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      const res = await mcpRegistryRouter.request("/");

      expect(res.status).toEqual(200);
      const body = ListResponseSchema.parse(await res.json());

      expect(body.metadata.staticCount).toEqual(Object.keys(mcpServersRegistry.servers).length);
      expect(body.metadata.dynamicCount).toBeGreaterThanOrEqual(1);
      expect(body.servers.length).toEqual(body.metadata.staticCount + body.metadata.dynamicCount);
    });

    it("GET / includes blessed registry servers", async () => {
      const res = await mcpRegistryRouter.request("/");
      expect(res.status).toEqual(200);

      const body = ListResponseSchema.parse(await res.json());

      const serverIds = body.servers.map((s) => s.id);
      const blessedIds = Object.keys(mcpServersRegistry.servers);

      for (const blessedId of blessedIds) {
        expect(serverIds).toContain(blessedId);
      }
    });
  });

  describe("GET /:id (existing)", () => {
    it("GET /:id returns static server with source field", async () => {
      const blessedId = "github";

      const res = await mcpRegistryRouter.request(`/${blessedId}`);

      expect(res.status).toEqual(200);
      const body = ServerResponseSchema.parse(await res.json());
      expect(body.id).toEqual(blessedId);
      expect(body.source).toEqual("static");
    });

    it("GET /:id returns dynamic server", async () => {
      const entry = createTestEntry("get-dynamic");
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      const res = await mcpRegistryRouter.request(`/${entry.id}`);

      expect(res.status).toEqual(200);
      const body = ServerResponseSchema.parse(await res.json());
      expect(body.id).toEqual(entry.id);
      expect(body.name).toEqual(entry.name);
    });

    it("GET /:id returns 404 for unknown server", async () => {
      const res = await mcpRegistryRouter.request("/nonexistent-server-id-12345");

      expect(res.status).toEqual(404);
      const body = z.object({ error: z.string() }).parse(await res.json());
      expect(body.error).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // NEW ROUTES (search, install, check-update, pull-update)
  // ═══════════════════════════════════════════════════════════════════════

  describe("GET /search", () => {
    it("returns search results with alreadyInstalled flag", async () => {
      // First install a server
      const canonicalName = "io.github.test/searchable";
      const upstreamEntry = createNpmStdioUpstreamEntry(canonicalName, "1.0.0");
      mockFetchLatest.mockResolvedValue(upstreamEntry);

      const installRes = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });
      expect(installRes.status).toBe(201);

      // Search returns installed and not-installed servers
      mockSearch.mockResolvedValue({
        servers: [
          { server: { name: canonicalName } }, // already installed
          { server: { name: "io.github.test/new-server" } }, // not installed
        ],
      });

      const res = await mcpRegistryRouter.request("/search?q=test");

      expect(res.status).toBe(200);
      const body = SearchResponseSchema.parse(await res.json());
      expect(body.servers).toHaveLength(2);
      expect(body.servers[0]!.alreadyInstalled).toBe(true);
      expect(body.servers[1]!.alreadyInstalled).toBe(false);
    });

    it("handles empty search results", async () => {
      mockSearch.mockResolvedValue({ servers: [] });

      const res = await mcpRegistryRouter.request("/search?q=xyz");

      expect(res.status).toBe(200);
      const body = SearchResponseSchema.parse(await res.json());
      expect(body.servers).toHaveLength(0);
    });
  });

  describe("POST /install", () => {
    // Test #1: install happy path (201 + persisted)
    it("installs a valid npm stdio server and returns 201 with stored entry", async () => {
      const canonicalName = "io.github.example/valid-server";
      const upstreamEntry = createNpmStdioUpstreamEntry(canonicalName, "1.2.3");
      mockFetchLatest.mockResolvedValue(upstreamEntry);

      const res = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      expect(res.status).toBe(201);
      const body = InstallResponseSchema.parse(await res.json());
      expect(body.server).toBeDefined();
      expect(body.server.source).toBe("registry");
      expect(body.server.upstream).toEqual({
        canonicalName,
        version: "1.2.3",
        updatedAt: "2025-06-15T12:00:00.000000Z",
      });

      // Verify it was persisted
      const adapter = testAdapter;
      const persisted = await adapter.get(body.server.id);
      expect(persisted).toBeDefined();
      expect(persisted?.upstream?.canonicalName).toBe(canonicalName);
    });

    // Test #2: install 400 reject — translator returns failure (docker-only or SSE-only)
    it("returns 400 when translator rejects (docker-only server)", async () => {
      const canonicalName = "io.github.test/docker-only";
      const upstreamEntry = createDockerOnlyUpstreamEntry(canonicalName, "1.0.0");
      mockFetchLatest.mockResolvedValue(upstreamEntry);

      const res = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      expect(res.status).toBe(400);
      const body = InstallErrorSchema.parse(await res.json());
      expect(body.error).toContain("Docker/OCI");
      expect(body.error).toContain("not yet supported");
    });

    it("returns 400 when translator rejects (SSE-only server)", async () => {
      const canonicalName = "io.github.test/sse-only";
      const upstreamEntry = createSseOnlyUpstreamEntry(canonicalName, "1.0.0");
      mockFetchLatest.mockResolvedValue(upstreamEntry);

      const res = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      expect(res.status).toBe(400);
      const body = InstallErrorSchema.parse(await res.json());
      expect(body.error).toContain("SSE transport");
      expect(body.error).toContain("not yet supported");
    });

    // Test #9 (bonus): schema validation - can add as extra test
    it("returns 400 for invalid request body (missing registryName)", async () => {
      const res = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}), // missing registryName
      });

      expect(res.status).toBe(400);
    });

    // Test #3: install 409 blessed (collision with mcpServersRegistry.servers)
    it("returns 409 when installing would collide with blessed registry", async () => {
      // Find a blessed server ID - the translator will derive ID from canonical name
      // We need to find a canonical name that translates to a blessed ID
      // First let's find what ID would be derived from a pattern
      const blessedIds = Object.keys(mcpServersRegistry.servers);
      const blessedId = blessedIds[0];
      if (!blessedId) throw new Error("expected at least one blessed server");

      // Mock the upstream client to return an entry that would derive to the blessed ID
      const upstreamEntry: UpstreamServerEntry = {
        server: {
          $schema: "https://registry.modelcontextprotocol.io/v0.1/schema.json",
          name: blessedId, // direct match to blessed ID
          description: "Test server",
          version: "1.0.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@test/server",
              version: "1.0.0",
              transport: { type: "stdio" },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-06-15T12:00:00.000000Z",
            publishedAt: "2025-06-15T12:00:00.000000Z",
            updatedAt: "2025-06-15T12:00:00.000000Z",
            isLatest: true,
          },
        },
      };
      mockFetchLatest.mockResolvedValue(upstreamEntry);

      const res = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: blessedId }),
      });

      expect(res.status).toBe(409);
      const body = InstallErrorSchema.parse(await res.json());
      expect(body.error).toContain("blessed");
      expect(body.error).toContain(blessedId);
    });

    // Test #4: install 409 duplicate (same upstream.canonicalName already in adapter)
    it("returns 409 when installing same canonical name already in adapter", async () => {
      const canonicalName = "io.github.test/duplicate-test";
      const upstreamEntry = createNpmStdioUpstreamEntry(canonicalName, "1.0.0");
      mockFetchLatest.mockResolvedValue(upstreamEntry);

      // First install succeeds
      const firstRes = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });
      expect(firstRes.status).toBe(201);
      const firstBody = InstallResponseSchema.parse(await firstRes.json());
      const existingId = firstBody.server.id;

      // Second install with same canonical name fails with 409
      const res = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      expect(res.status).toBe(409);
      const body = InstallErrorSchema.parse(await res.json());
      expect(body.error).toContain("already installed");
      expect(body.error).toContain(canonicalName);
      expect(body.existingId).toBe(existingId);
    });

    it("returns 404 when upstream server not found", async () => {
      mockFetchLatest.mockRejectedValue(new Error("Server not found in registry"));

      const res = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: "io.github.test/nonexistent" }),
      });

      expect(res.status).toBe(404);
      const body = z.object({ error: z.string() }).parse(await res.json());
      expect(body.error).toContain("not found");
    });

    it("auto-creates Link provider when translation produces one", async () => {
      const canonicalName = "io.github.test/with-env";
      const upstreamEntry = createNpmStdioUpstreamEntryWithEnv(canonicalName, "1.0.0");
      mockFetchLatest.mockResolvedValue(upstreamEntry);

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              ok: true,
              provider: { id: "io-github-test-with-env", type: "apikey" },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          ),
        );

      const res = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      expect(res.status).toBe(201);
      const body = InstallResponseSchema.parse(await res.json());
      expect(body.warning).toBeUndefined();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("http://localhost:3100/v1/providers");
      expect(init?.method).toBe("POST");
      if (!init || typeof init.body !== "string") throw new Error("expected string body");
      const requestBody = z
        .object({ provider: z.object({ type: z.string(), id: z.string() }) })
        .parse(JSON.parse(init.body));
      expect(requestBody.provider.type).toBe("apikey");
      expect(requestBody.provider.id).toBe("io-github-test-with-env");

      fetchSpy.mockRestore();
    });

    it("returns 201 without warning when Link provider already exists (409)", async () => {
      const canonicalName = "io.github.test/with-env-409";
      const upstreamEntry = createNpmStdioUpstreamEntryWithEnv(canonicalName, "1.0.0");
      mockFetchLatest.mockResolvedValue(upstreamEntry);

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: false, error: "already exists" }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          }),
        );

      const res = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      expect(res.status).toBe(201);
      const body = InstallResponseSchema.parse(await res.json());
      expect(body.warning).toBeUndefined();

      fetchSpy.mockRestore();
    });

    it("returns 201 with warning when Link provider creation fails", async () => {
      const canonicalName = "io.github.test/with-env-fail";
      const upstreamEntry = createNpmStdioUpstreamEntryWithEnv(canonicalName, "1.0.0");
      mockFetchLatest.mockResolvedValue(upstreamEntry);

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: false, error: "internal error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
        );

      const res = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      expect(res.status).toBe(201);
      const body = InstallResponseSchema.parse(await res.json());
      expect(body.warning).toContain("Link provider creation failed");

      fetchSpy.mockRestore();
    });

    it("does not call Link when translation produces no linkProvider", async () => {
      const canonicalName = "io.github.test/no-link-provider";
      const upstreamEntry = createNpmStdioUpstreamEntry(canonicalName, "1.0.0");
      mockFetchLatest.mockResolvedValue(upstreamEntry);

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const res = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      expect(res.status).toBe(201);
      expect(fetchSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // E2E: Three translator cases produce correct Link providers
    // ═══════════════════════════════════════════════════════════════════════

    it("case 1: npm+stdio with env vars → creates API key Link provider and persisted env uses Link refs", async () => {
      const canonicalName = "io.github.test/npm-env-link-refs";
      const upstreamEntry = createNpmStdioUpstreamEntryWithEnv(canonicalName, "1.0.0");
      mockFetchLatest.mockResolvedValue(upstreamEntry);

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              ok: true,
              provider: { id: "io-github-test-npm-env-link-refs", type: "apikey" },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          ),
        );

      const res = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      expect(res.status).toBe(201);
      const body = InstallResponseSchema.parse(await res.json());
      expect(body.warning).toBeUndefined();

      // Verify Link call was made with apikey provider
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0]!;
      expect(init?.method).toBe("POST");
      if (!init || typeof init.body !== "string") throw new Error("expected string body");
      const requestBody = z
        .object({ provider: z.object({ type: z.literal("apikey"), id: z.string() }) })
        .parse(JSON.parse(init.body));
      expect(requestBody.provider.id).toBe("io-github-test-npm-env-link-refs");

      // Verify persisted entry has Link refs in env, not placeholders
      const adapter = testAdapter;
      const persisted = await adapter.get(body.server.id);
      expect(persisted).toBeDefined();
      expect(persisted?.configTemplate.env).toEqual({
        API_KEY: { from: "link", provider: "io-github-test-npm-env-link-refs", key: "API_KEY" },
      });

      fetchSpy.mockRestore();
    });

    it("case 2: http remote without env vars → creates OAuth Link provider (discovery mode)", async () => {
      const canonicalName = "io.github.test/http-oauth";
      const upstreamEntry = createHttpRemoteUpstreamEntry(canonicalName, "1.0.0");
      mockFetchLatest.mockResolvedValue(upstreamEntry);

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              ok: true,
              provider: { id: "io-github-test-http-oauth", type: "oauth" },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          ),
        );

      const res = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      expect(res.status).toBe(201);
      const body = InstallResponseSchema.parse(await res.json());
      expect(body.warning).toBeUndefined();

      // Verify Link call was made with oauth provider in discovery mode
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0]!;
      expect(init?.method).toBe("POST");
      if (!init || typeof init.body !== "string") throw new Error("expected string body");
      const requestBody = z
        .object({
          provider: z.object({
            type: z.literal("oauth"),
            id: z.string(),
            oauthConfig: z.object({ mode: z.literal("discovery"), serverUrl: z.string() }),
          }),
        })
        .parse(JSON.parse(init.body));
      expect(requestBody.provider.id).toBe("io-github-test-http-oauth");
      expect(requestBody.provider.oauthConfig.mode).toBe("discovery");
      expect(requestBody.provider.oauthConfig.serverUrl).toBe("https://api.example.com/mcp");

      // Verify persisted entry has no env (no env vars in this case)
      const adapter = testAdapter;
      const persisted = await adapter.get(body.server.id);
      expect(persisted).toBeDefined();
      expect(persisted?.configTemplate.env).toBeUndefined();

      fetchSpy.mockRestore();
    });

    it("case 3: http remote with env vars → creates API key Link provider and persisted env uses Link refs", async () => {
      const canonicalName = "io.github.test/http-apikey-env";
      const upstreamEntry = createHttpRemoteWithEnvUpstreamEntry(canonicalName, "1.0.0");
      mockFetchLatest.mockResolvedValue(upstreamEntry);

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              ok: true,
              provider: { id: "io-github-test-http-apikey-env", type: "apikey" },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          ),
        );

      const res = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      expect(res.status).toBe(201);
      const body = InstallResponseSchema.parse(await res.json());
      expect(body.warning).toBeUndefined();

      // Verify Link call was made with apikey provider
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0]!;
      expect(init?.method).toBe("POST");
      if (!init || typeof init.body !== "string") throw new Error("expected string body");
      const requestBody = z
        .object({
          provider: z.object({
            type: z.literal("apikey"),
            id: z.string(),
            secretSchema: z.object({ API_KEY: z.literal("string") }),
          }),
        })
        .parse(JSON.parse(init.body));
      expect(requestBody.provider.id).toBe("io-github-test-http-apikey-env");

      // Verify persisted entry has Link refs in env, not placeholders
      const adapter = testAdapter;
      const persisted = await adapter.get(body.server.id);
      expect(persisted).toBeDefined();
      expect(persisted?.configTemplate.env).toEqual({
        API_KEY: { from: "link", provider: "io-github-test-http-apikey-env", key: "API_KEY" },
      });

      fetchSpy.mockRestore();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // E2E: Partial failure mode
    // ═══════════════════════════════════════════════════════════════════════

    it("partial failure: Link fails but registry entry persists and response has warning", async () => {
      const canonicalName = "io.github.test/partial-fail";
      const upstreamEntry = createHttpRemoteWithEnvUpstreamEntry(canonicalName, "1.0.0");
      mockFetchLatest.mockResolvedValue(upstreamEntry);

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: false, error: "internal error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
        );

      const res = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      expect(res.status).toBe(201);
      const body = InstallResponseSchema.parse(await res.json());
      expect(body.warning).toContain("Link provider creation failed");

      // Verify entry was persisted despite Link failure
      const adapter = testAdapter;
      const persisted = await adapter.get(body.server.id);
      expect(persisted).toBeDefined();
      expect(persisted?.upstream?.canonicalName).toBe(canonicalName);
      // Verify env still uses Link refs even when Link creation failed
      expect(persisted?.configTemplate.env).toEqual({
        API_KEY: { from: "link", provider: "io-github-test-partial-fail", key: "API_KEY" },
      });

      fetchSpy.mockRestore();
    });
  });

  describe("GET /:id/check-update", () => {
    // Test #5: check-update true (stored.updatedAt < fresh.updatedAt)
    it("returns hasUpdate: true when remote has newer timestamp", async () => {
      // First install an older version
      const canonicalName = "io.github.test/update-check";
      const oldUpstreamEntry: UpstreamServerEntry = {
        server: {
          $schema: "https://registry.modelcontextprotocol.io/v0.1/schema.json",
          name: canonicalName,
          description: "Test server",
          version: "1.0.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@test/update-check",
              version: "1.0.0",
              transport: { type: "stdio" },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          }, // older
        },
      };
      mockFetchLatest.mockResolvedValueOnce(oldUpstreamEntry);

      const installRes = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });
      expect(installRes.status).toBe(201);
      const installBody = InstallResponseSchema.parse(await installRes.json());
      const installedId = installBody.server.id;

      // Now mock a newer upstream version
      const newUpstreamEntry: UpstreamServerEntry = {
        server: {
          $schema: "https://registry.modelcontextprotocol.io/v0.1/schema.json",
          name: canonicalName,
          description: "Test server",
          version: "1.1.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@test/update-check",
              version: "1.1.0",
              transport: { type: "stdio" },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-12-01T00:00:00.000000Z",
            publishedAt: "2025-12-01T00:00:00.000000Z",
            updatedAt: "2025-12-01T00:00:00.000000Z",
            isLatest: true,
          }, // newer
        },
      };
      mockFetchLatest.mockResolvedValueOnce(newUpstreamEntry);

      const res = await mcpRegistryRouter.request(`/${installedId}/check-update`);

      expect(res.status).toBe(200);
      const body = CheckUpdateResponseSchema.parse(await res.json());
      expect(body.hasUpdate).toBe(true);
      expect(body.remote?.version).toBe("1.1.0");
      expect(body.remote?.updatedAt).toBe("2025-12-01T00:00:00.000000Z");
    });

    // Test #6: check-update false (stored.updatedAt >= fresh.updatedAt)
    it("returns hasUpdate: false when timestamps are equal", async () => {
      const canonicalName = "io.github.test/no-update";
      const timestamp = "2025-06-15T12:00:00.000000Z";
      const upstreamEntry: UpstreamServerEntry = {
        server: {
          $schema: "https://registry.modelcontextprotocol.io/v0.1/schema.json",
          name: canonicalName,
          description: "Test server",
          version: "1.0.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@test/no-update",
              version: "1.0.0",
              transport: { type: "stdio" },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: timestamp,
            publishedAt: timestamp,
            updatedAt: timestamp,
            isLatest: true,
          },
        },
      };
      mockFetchLatest.mockResolvedValue(upstreamEntry);

      const installRes = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });
      expect(installRes.status).toBe(201);
      const installBody = InstallResponseSchema.parse(await installRes.json());
      const installedId = installBody.server.id;

      // Same timestamp - no update available
      mockFetchLatest.mockResolvedValue({
        ...upstreamEntry,
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: timestamp,
            publishedAt: timestamp,
            updatedAt: timestamp,
            isLatest: true,
          }, // same timestamp
        },
      });

      const res = await mcpRegistryRouter.request(`/${installedId}/check-update`);

      expect(res.status).toBe(200);
      const body = CheckUpdateFalseSchema.parse(await res.json());
      expect(body.hasUpdate).toBe(false);
      expect(body.reason).toContain("up to date");
    });

    it("returns hasUpdate: false when local server has no upstream provenance", async () => {
      // Create a manual entry (no upstream)
      const entry = createTestEntry("manual-no-upstream");
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      const res = await mcpRegistryRouter.request(`/${entry.id}/check-update`);

      expect(res.status).toBe(200);
      const body = CheckUpdateFalseSchema.parse(await res.json());
      expect(body.hasUpdate).toBe(false);
      expect(body.reason).toContain("not installed from registry");
    });

    it("returns 404 for unknown server", async () => {
      const res = await mcpRegistryRouter.request("/nonexistent-server/check-update");

      expect(res.status).toBe(404);
    });
  });

  describe("POST /:id/update", () => {
    // Test #7: pull-update preserves ID (re-translate fresh, overwrite id with stored, adapter.update)
    it("pull-update preserves the stored kebab-case ID after re-translation", async () => {
      const canonicalName = "io.github.example/pull-update-test";
      const v1UpstreamEntry: UpstreamServerEntry = {
        server: {
          $schema: "https://registry.modelcontextprotocol.io/v0.1/schema.json",
          name: canonicalName,
          description: "Version 1",
          version: "1.0.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@test/pull-update",
              version: "1.0.0",
              transport: { type: "stdio" },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };
      mockFetchLatest.mockResolvedValueOnce(v1UpstreamEntry);

      // Install v1
      const installRes = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });
      expect(installRes.status).toBe(201);
      const installBody = InstallResponseSchema.parse(await installRes.json());
      const storedId = installBody.server.id;
      // installBody.server.upstream?.updatedAt is the original timestamp

      // Now prepare v2 (newer timestamp and version)
      const v2UpstreamEntry: UpstreamServerEntry = {
        server: {
          $schema: "https://registry.modelcontextprotocol.io/v0.1/schema.json",
          name: canonicalName,
          description: "Version 2 - updated description", // description changed
          version: "2.0.0", // version changed
          packages: [
            {
              registryType: "npm",
              identifier: "@test/pull-update",
              version: "2.0.0", // package version changed
              transport: { type: "stdio" },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-12-01T00:00:00.000000Z",
            publishedAt: "2025-12-01T00:00:00.000000Z",
            updatedAt: "2025-12-01T00:00:00.000000Z",
            isLatest: true,
          }, // newer
        },
      };
      mockFetchLatest.mockResolvedValueOnce(v2UpstreamEntry);

      // Pull update
      const res = await mcpRegistryRouter.request(`/${storedId}/update`, { method: "POST" });

      expect(res.status).toBe(200);
      const body = UpdateResponseSchema.parse(await res.json());

      // Verify ID is preserved
      expect(body.server.id).toBe(storedId);

      // Verify content was updated
      expect(body.server.upstream?.version).toBe("2.0.0");
      expect(body.server.upstream?.updatedAt).toBe("2025-12-01T00:00:00.000000Z");
      expect(body.server.description).toBe("Version 2 - updated description");

      // Verify the ID didn't change even though re-translation would produce same ID
      // This tests that adapter.update preserves the stored ID
      const adapter = testAdapter;
      const persisted = await adapter.get(storedId);
      expect(persisted).toBeDefined();
      expect(persisted?.id).toBe(storedId);
      expect(persisted?.upstream?.version).toBe("2.0.0");
    });

    it("returns 400 when updating server without upstream provenance", async () => {
      const entry = createTestEntry("manual-update-test");
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      const res = await mcpRegistryRouter.request(`/${entry.id}/update`, { method: "POST" });

      expect(res.status).toBe(400);
      const body = InstallErrorSchema.parse(await res.json());
      expect(body.error).toContain("not installed from registry");
    });

    it("returns 400 when upstream translation fails after update", async () => {
      // Install a valid server first
      const canonicalName = "io.github.test/will-break";
      const upstreamEntry = createNpmStdioUpstreamEntry(canonicalName, "1.0.0");
      mockFetchLatest.mockResolvedValueOnce(upstreamEntry);

      const installRes = await mcpRegistryRouter.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });
      expect(installRes.status).toBe(201);
      const installBody = InstallResponseSchema.parse(await installRes.json());
      const installedId = installBody.server.id;

      // Now upstream becomes docker-only (rejection case)
      const brokenUpstreamEntry = createDockerOnlyUpstreamEntry(canonicalName, "2.0.0");
      mockFetchLatest.mockResolvedValueOnce(brokenUpstreamEntry);

      const res = await mcpRegistryRouter.request(`/${installedId}/update`, { method: "POST" });

      expect(res.status).toBe(400);
      const body = InstallErrorSchema.parse(await res.json());
      expect(body.error).toContain("Translation failed");
      expect(body.error).toContain("Docker/OCI");
    });

    it("returns 404 for unknown server", async () => {
      const res = await mcpRegistryRouter.request("/nonexistent-server/update", { method: "POST" });

      expect(res.status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Config Template Validation Tests (existing)
  // ═══════════════════════════════════════════════════════════════════════

  describe("Config Template Validation", () => {
    it("created entries have valid configTemplate structure", async () => {
      const httpEntry = {
        ...createTestEntry("http-template"),
        configTemplate: {
          transport: { type: "http" as const, url: "https://api.example.com/mcp" },
          auth: { type: "bearer" as const, token_env: "API_TOKEN" },
        },
      };

      const httpRes = await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry: httpEntry }),
      });

      expect(httpRes.status).toEqual(201);
      const httpBody = CreateResponseSchema.parse(await httpRes.json());
      expect(httpBody.server.configTemplate).toBeDefined();
    });

    it("created entries with stdio transport are valid", async () => {
      const stdioEntry = {
        ...createTestEntry("stdio-template"),
        configTemplate: {
          transport: { type: "stdio" as const, command: "npx", args: ["-y", "@example/mcp"] },
          env: { API_KEY: "test-key" },
        },
      };

      const stdioRes = await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry: stdioEntry }),
      });

      expect(stdioRes.status).toEqual(201);
      const stdioBody = CreateResponseSchema.parse(await stdioRes.json());
      expect(stdioBody.server.configTemplate).toBeDefined();
    });

    it("created entries with Link credential refs are valid", async () => {
      const linkEntry = {
        ...createTestEntry("link-template"),
        configTemplate: {
          transport: { type: "http" as const, url: "https://api.example.com/mcp" },
          auth: { type: "bearer" as const, token_env: "EXAMPLE_TOKEN" },
          env: {
            EXAMPLE_TOKEN: { from: "link" as const, provider: "example", key: "access_token" },
          },
        },
        requiredConfig: [
          {
            key: "EXAMPLE_TOKEN",
            description: "Example API token from Link",
            type: "string" as const,
          },
        ],
      };

      const linkRes = await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry: linkEntry }),
      });

      expect(linkRes.status).toEqual(201);
      const linkBody = CreateResponseSchema.parse(await linkRes.json());

      expect(linkBody).toMatchObject({
        server: {
          configTemplate: {
            transport: { type: "http", url: "https://api.example.com/mcp" },
            auth: { type: "bearer", token_env: "EXAMPLE_TOKEN" },
            env: { EXAMPLE_TOKEN: { from: "link", provider: "example", key: "access_token" } },
          },
        },
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // DELETE /:id
  // ═══════════════════════════════════════════════════════════════════════

  describe("DELETE /:id", () => {
    it("deletes a dynamic entry and returns 204", async () => {
      const entry = createTestEntry("delete-dynamic");
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      const res = await mcpRegistryRouter.request(`/${entry.id}`, { method: "DELETE" });
      expect(res.status).toBe(204);

      // Verify it is gone
      const getRes = await mcpRegistryRouter.request(`/${entry.id}`);
      expect(getRes.status).toBe(404);
    });

    it("returns 403 for built-in (static) entries", async () => {
      const blessedId = Object.keys(mcpServersRegistry.servers)[0];
      if (!blessedId) throw new Error("expected at least one blessed server");

      const res = await mcpRegistryRouter.request(`/${blessedId}`, { method: "DELETE" });
      expect(res.status).toBe(403);
      const body = z.object({ error: z.string() }).parse(await res.json());
      expect(body.error).toContain("Built-in");
    });

    it("returns 404 for unknown entries", async () => {
      const res = await mcpRegistryRouter.request("/nonexistent-delete-id", { method: "DELETE" });
      expect(res.status).toBe(404);
      const body = z.object({ error: z.string() }).parse(await res.json());
      expect(body.error).toContain("not found");
    });

    it("entry disappears from catalog list after delete", async () => {
      const entry = createTestEntry("delete-list");
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      // Verify present before
      const before = await mcpRegistryRouter.request("/");
      expect(before.status).toBe(200);
      const beforeBody = ListResponseSchema.parse(await before.json());
      const beforeIds = beforeBody.servers.map((s) => s.id);
      expect(beforeIds).toContain(entry.id);

      // Delete
      const delRes = await mcpRegistryRouter.request(`/${entry.id}`, { method: "DELETE" });
      expect(delRes.status).toBe(204);

      // Verify gone after
      const after = await mcpRegistryRouter.request("/");
      expect(after.status).toBe(200);
      const afterBody = ListResponseSchema.parse(await after.json());
      const afterIds = afterBody.servers.map((s) => s.id);
      expect(afterIds).not.toContain(entry.id);
    });
  });
});
