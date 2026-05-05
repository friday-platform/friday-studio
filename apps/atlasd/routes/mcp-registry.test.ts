import process from "node:process";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import { LocalMCPRegistryAdapter } from "@atlas/core/mcp-registry/storage";
import type { UpstreamServerEntry } from "@atlas/core/mcp-registry/upstream-client";
import { createStubPlatformModels } from "@atlas/llm";
import { RetryError } from "@std/async/retry";
import { Hono } from "hono";
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
type SearchResult = { server: { name: string; version?: string } };
const mockFetchLatest = vi.fn<(name: string) => Promise<UpstreamServerEntry>>();
const mockSearch =
  vi.fn<
    (query: string, limit?: number, version?: string) => Promise<{ servers: SearchResult[] }>
  >();

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

// Mock createMCPTools for tool probe tests
type MockTool = { description?: string };
const mockCreateMCPTools =
  vi.fn<
    (
      configs: Record<string, unknown>,
      logger: unknown,
      options?: { signal?: AbortSignal; toolPrefix?: string },
    ) => Promise<{ tools: Record<string, MockTool>; dispose: () => Promise<void> }>
  >();

vi.mock("@atlas/mcp", () => ({
  createMCPTools: (...args: Parameters<typeof mockCreateMCPTools>) => mockCreateMCPTools(...args),
}));

// Mock streamText from ai for test-chat tests
const mockStreamText = vi.hoisted(() => vi.fn());

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, streamText: mockStreamText };
});

beforeAll(async () => {
  testKv = await Deno.openKv(":memory:");
  testAdapter = new LocalMCPRegistryAdapter(testKv);
  process.env.LINK_SERVICE_URL = "http://localhost:3100";
  process.env.FRIDAY_KEY = "test-atlas-key";
});

afterAll(() => {
  testKv.close();
  delete process.env.LINK_SERVICE_URL;
  delete process.env.FRIDAY_KEY;
});

beforeEach(() => {
  mockFetchLatest.mockReset();
  mockSearch.mockReset();
  mockCreateMCPTools.mockReset();
  mockStreamText.mockReset();
  _resetCacheForTest();
});

// Import AFTER mock setup (vi.mock is hoisted, but this makes intent clear)
const { mcpRegistryRouter } = await import("./mcp-registry.ts");
const { _resetCacheForTest, _flushPrewarmsForTest } = await import("./mcp-tool-cache.ts");

/** Build a Hono app that wraps the MCP registry router with a partial mock app context. */
function createWrappedRouter(context: Record<string, unknown>) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    // @ts-expect-error - partial mock for tests
    c.set("app", context);
    await next();
  });
  app.route("/", mcpRegistryRouter);
  return app;
}

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
        version: z.string(),
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

/** Schema for tool probe success response */
const ToolProbeSuccessSchema = z.object({
  ok: z.literal(true),
  tools: z.array(z.object({ name: z.string(), description: z.string().optional() })),
});

/** Schema for tool probe error response */
const ToolProbeErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  phase: z.enum(["dns", "connect", "auth", "tools"]),
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
          { server: { name: canonicalName, version: "1.0.0" } }, // already installed
          { server: { name: "io.github.test/new-server", version: "2.0.0" } }, // not installed
        ],
      });

      const res = await mcpRegistryRouter.request("/search?q=test");

      expect(res.status).toBe(200);
      const body = SearchResponseSchema.parse(await res.json());
      expect(body.servers).toHaveLength(2);
      expect(body.servers[0]!.alreadyInstalled).toBe(true);
      expect(body.servers[0]!.version).toBe("1.0.0");
      expect(body.servers[1]!.alreadyInstalled).toBe(false);
      expect(body.servers[1]!.version).toBe("2.0.0");
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

      // Verify persisted entry has bearer-token env bridge (OAuth via Link)
      const adapter = testAdapter;
      const persisted = await adapter.get(body.server.id);
      expect(persisted).toBeDefined();
      expect(persisted?.configTemplate.env).toEqual({
        IO_GITHUB_TEST_HTTP_OAUTH_ACCESS_TOKEN: {
          from: "link",
          key: "access_token",
          provider: "io-github-test-http-oauth",
        },
      });
      expect(persisted?.configTemplate.auth).toEqual({
        type: "bearer",
        token_env: "IO_GITHUB_TEST_HTTP_OAUTH_ACCESS_TOKEN",
      });

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

  // ═══════════════════════════════════════════════════════════════════════
  // POST /custom
  // ═══════════════════════════════════════════════════════════════════════

  describe("POST /custom", () => {
    it("creates a custom HTTP URL entry and returns 201 with OAuth provider creation", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(
            JSON.stringify({ ok: true, provider: { id: "custom-http-url", type: "oauth" } }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          ),
        );

      const res = await mcpRegistryRouter.request("/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Custom HTTP Server",
          description: "A custom HTTP MCP server",
          httpUrl: "https://api.example.com/mcp",
        }),
      });

      expect(res.status).toBe(201);
      const body = z
        .object({
          server: z.object({
            id: z.string(),
            name: z.string(),
            source: z.literal("web"),
            securityRating: z.literal("unverified"),
            configTemplate: z.object({
              transport: z.object({ type: z.literal("http"), url: z.string().url() }),
            }),
          }),
          warning: z.string().optional(),
        })
        .parse(await res.json());

      expect(body.server.id).toBe("custom-http-server");
      expect(body.server.name).toBe("Custom HTTP Server");
      expect(body.server.source).toBe("web");
      expect(body.server.securityRating).toBe("unverified");
      expect(body.server.configTemplate.transport).toEqual({
        type: "http",
        url: "https://api.example.com/mcp",
      });

      // Verify Link call was made with OAuth provider in discovery mode
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0]!;
      expect(init?.method).toBe("POST");
      if (!init || typeof init.body !== "string") throw new Error("expected string body");
      const requestBody = z
        .object({
          provider: z.object({
            type: z.literal("oauth"),
            id: z.string(),
            oauthConfig: z.object({ mode: z.literal("discovery"), serverUrl: z.string().url() }),
          }),
        })
        .parse(JSON.parse(init.body));
      expect(requestBody.provider.id).toBe(body.server.id);
      expect(requestBody.provider.oauthConfig.serverUrl).toBe("https://api.example.com/mcp");

      fetchSpy.mockRestore();
    });

    it("creates a custom JSON stdio entry with env and returns 201 with API-key provider", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(
            JSON.stringify({ ok: true, provider: { id: "custom-stdio-env", type: "apikey" } }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          ),
        );

      const res = await mcpRegistryRouter.request("/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Custom Stdio Server",
          description: "A custom stdio MCP server",
          configJson: {
            transport: { type: "stdio", command: "uvx", args: ["my-server"] },
            envVars: [{ key: "API_KEY", description: "API key", exampleValue: "your-key-here" }],
          },
        }),
      });

      expect(res.status).toBe(201);
      const body = z
        .object({
          server: z.object({
            id: z.string(),
            name: z.string(),
            source: z.literal("web"),
            configTemplate: z.object({
              transport: z.object({
                type: z.literal("stdio"),
                command: z.string(),
                args: z.array(z.string()),
              }),
              skipResolverCheck: z.literal(true),
              env: z.record(
                z.string(),
                z.object({ from: z.literal("link"), provider: z.string(), key: z.string() }),
              ),
            }),
            requiredConfig: z.array(
              z.object({
                key: z.string(),
                description: z.string(),
                type: z.literal("string"),
                examples: z.array(z.string()).optional(),
              }),
            ),
          }),
          warning: z.string().optional(),
        })
        .parse(await res.json());

      expect(body.server.id).toBe("custom-stdio-server");
      expect(body.server.configTemplate.transport).toEqual({
        type: "stdio",
        command: "uvx",
        args: ["my-server"],
      });
      expect(body.server.configTemplate.skipResolverCheck).toBe(true);
      expect(body.server.configTemplate.env).toEqual({
        API_KEY: { from: "link", provider: body.server.id, key: "API_KEY" },
      });
      expect(body.server.requiredConfig).toEqual([
        { key: "API_KEY", description: "API key", type: "string", examples: ["your-key-here"] },
      ]);

      // Verify Link call was made with API-key provider
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0]!;
      expect(init?.method).toBe("POST");
      if (!init || typeof init.body !== "string") throw new Error("expected string body");
      const requestBody = z
        .object({
          provider: z.object({
            type: z.literal("apikey"),
            id: z.string(),
            secretSchema: z.record(z.string(), z.literal("string")),
          }),
        })
        .parse(JSON.parse(init.body));
      expect(requestBody.provider.id).toBe(body.server.id);
      expect(requestBody.provider.secretSchema).toEqual({ API_KEY: "string" });

      fetchSpy.mockRestore();
    });

    it("creates a custom JSON http entry with env and returns 201 with API-key provider", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(
            JSON.stringify({ ok: true, provider: { id: "custom-http-env", type: "apikey" } }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          ),
        );

      const res = await mcpRegistryRouter.request("/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Custom HTTP with Env",
          configJson: {
            transport: { type: "http", url: "https://http-env.example.com/mcp" },
            envVars: [{ key: "TOKEN" }],
          },
        }),
      });

      expect(res.status).toBe(201);
      const body = z
        .object({
          server: z.object({
            id: z.string(),
            source: z.literal("web"),
            configTemplate: z.object({
              transport: z.object({ type: z.literal("http"), url: z.string().url() }),
              env: z.record(
                z.string(),
                z.object({ from: z.literal("link"), provider: z.string(), key: z.string() }),
              ),
            }),
            requiredConfig: z.array(
              z.object({ key: z.string(), description: z.string(), type: z.literal("string") }),
            ),
          }),
          warning: z.string().optional(),
        })
        .parse(await res.json());

      expect(body.server.configTemplate.transport).toEqual({
        type: "http",
        url: "https://http-env.example.com/mcp",
      });
      expect(body.server.configTemplate.env).toEqual({
        TOKEN: { from: "link", provider: body.server.id, key: "TOKEN" },
      });
      expect(body.server.requiredConfig).toEqual([
        { key: "TOKEN", description: "Credential: TOKEN", type: "string" },
      ]);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      fetchSpy.mockRestore();
    });

    it("creates a custom JSON stdio entry without env and returns 201 with no provider", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const res = await mcpRegistryRouter.request("/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Custom No Env",
          configJson: {
            transport: { type: "stdio", command: "npx", args: ["-y", "@example/mcp"] },
            envVars: [],
          },
        }),
      });

      expect(res.status).toBe(201);
      const body = z
        .object({
          server: z.object({
            id: z.string(),
            source: z.literal("web"),
            configTemplate: z.object({
              transport: z.object({ type: z.literal("stdio"), command: z.string() }),
              skipResolverCheck: z.literal(true),
            }),
            requiredConfig: z.undefined().or(z.array(z.any()).length(0)),
          }),
          warning: z.string().optional(),
        })
        .parse(await res.json());

      expect(body.server.requiredConfig).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
    });

    it("returns 400 when both httpUrl and configJson are provided", async () => {
      const res = await mcpRegistryRouter.request("/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Both Inputs",
          httpUrl: "https://example.com/mcp",
          configJson: { transport: { type: "stdio", command: "echo" }, envVars: [] },
        }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 when neither httpUrl nor configJson is provided", async () => {
      const res = await mcpRegistryRouter.request("/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "No Inputs" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 409 for blessed registry collision", async () => {
      const blessedId = Object.keys(mcpServersRegistry.servers)[0];
      if (!blessedId) throw new Error("expected at least one blessed server");

      const res = await mcpRegistryRouter.request("/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: blessedId,
          id: blessedId,
          httpUrl: "https://example.com/mcp",
        }),
      });

      expect(res.status).toBe(409);
      const body = z.object({ error: z.string() }).parse(await res.json());
      expect(body.error).toContain("blessed");
    });

    it("returns 409 for duplicate dynamic ID collision", async () => {
      const entry = createTestEntry("custom-dup");
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      const res = await mcpRegistryRouter.request("/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: entry.name,
          id: entry.id,
          httpUrl: "https://example.com/mcp",
        }),
      });

      expect(res.status).toBe(409);
      const body = z.object({ error: z.string() }).parse(await res.json());
      expect(body.error).toContain("already used");
    });

    it("returns 201 with warning when Link provider creation fails", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: false, error: "internal error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
        );

      const res = await mcpRegistryRouter.request("/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Link Fail Server",
          httpUrl: "https://link-fail.example.com/mcp",
        }),
      });

      expect(res.status).toBe(201);
      const body = z
        .object({ server: z.object({ id: z.string(), name: z.string() }), warning: z.string() })
        .parse(await res.json());
      expect(body.warning).toContain("Link provider creation failed");

      fetchSpy.mockRestore();
    });

    it("derives ID from name when omitted and succeeds", async () => {
      const res = await mcpRegistryRouter.request("/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "My Awesome Server",
          httpUrl: "https://awesome.example.com/mcp",
        }),
      });

      expect(res.status).toBe(201);
      const body = z.object({ server: z.object({ id: z.string() }) }).parse(await res.json());
      expect(body.server.id).toBe("my-awesome-server");
    });

    it("appends timestamp suffix when derived ID collides and succeeds", async () => {
      const firstRes = await mcpRegistryRouter.request("/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Collision Server",
          httpUrl: "https://collision1.example.com/mcp",
        }),
      });
      expect(firstRes.status).toBe(201);
      const firstBody = z
        .object({ server: z.object({ id: z.string() }) })
        .parse(await firstRes.json());
      const firstId = firstBody.server.id;
      expect(firstId).toBe("collision-server");

      const secondRes = await mcpRegistryRouter.request("/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Collision Server",
          httpUrl: "https://collision2.example.com/mcp",
        }),
      });
      expect(secondRes.status).toBe(201);
      const secondBody = z
        .object({ server: z.object({ id: z.string() }) })
        .parse(await secondRes.json());
      expect(secondBody.server.id).not.toBe(firstId);
      expect(secondBody.server.id).toMatch(/^collision-server-/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /:id/tools — MCP tool probe
  // ═══════════════════════════════════════════════════════════════════════

  describe("GET /:id/tools", () => {
    it("returns tools on successful probe", async () => {
      const entry = createTestEntry("probe-success");
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      mockCreateMCPTools.mockResolvedValue({
        tools: {
          "fetch-data": { description: "Fetch data from the server" },
          "send-data": { description: "Send data to the server" },
        },
        dispose: vi.fn().mockResolvedValue(undefined),
      });

      const res = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      expect(res.status).toBe(200);

      const body = ToolProbeSuccessSchema.parse(await res.json());
      expect(body.ok).toBe(true);
      expect(body.tools).toHaveLength(2);
      expect(body.tools[0]).toEqual({
        name: "fetch-data",
        description: "Fetch data from the server",
      });
      expect(body.tools[1]).toEqual({ name: "send-data", description: "Send data to the server" });
    });

    it("returns 404 for unknown server", async () => {
      const res = await mcpRegistryRouter.request("/nonexistent-server/tools");
      expect(res.status).toBe(404);
      const body = z.object({ error: z.string() }).parse(await res.json());
      expect(body.error).toContain("not found");
    });

    it("classifies DNS errors with phase dns", async () => {
      const entry = createTestEntry("probe-dns");
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      mockCreateMCPTools.mockRejectedValue(
        new Error("getaddrinfo ENOTFOUND nonexistent.example.com"),
      );

      const res = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      expect(res.status).toBe(200);

      const body = ToolProbeErrorSchema.parse(await res.json());
      expect(body.ok).toBe(false);
      expect(body.phase).toBe("dns");
    });

    it("classifies auth errors with phase auth", async () => {
      const entry = createTestEntry("probe-auth");
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      const { LinkCredentialNotFoundError } = await import(
        "@atlas/core/mcp-registry/credential-resolver"
      );
      mockCreateMCPTools.mockRejectedValue(new LinkCredentialNotFoundError("provider-1"));

      const res = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      expect(res.status).toBe(200);

      const body = ToolProbeErrorSchema.parse(await res.json());
      expect(body.ok).toBe(false);
      expect(body.phase).toBe("auth");
    });

    it("classifies connection errors with phase connect", async () => {
      const entry = createTestEntry("probe-connect");
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      mockCreateMCPTools.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:8080"));

      const res = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      expect(res.status).toBe(200);

      const body = ToolProbeErrorSchema.parse(await res.json());
      expect(body.ok).toBe(false);
      expect(body.phase).toBe("connect");
    });

    it("classifies tools timeout with phase tools", async () => {
      const entry = createTestEntry("probe-tools");
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      mockCreateMCPTools.mockRejectedValue(new Error("Tool listing timed out"));

      const res = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      expect(res.status).toBe(200);

      const body = ToolProbeErrorSchema.parse(await res.json());
      expect(body.ok).toBe(false);
      expect(body.phase).toBe("tools");
    });

    it("classifies RetryError by unwrapping the underlying cause", async () => {
      const entry = createTestEntry("probe-retry");
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      mockCreateMCPTools.mockRejectedValue(
        new RetryError(new Error("getaddrinfo ENOTFOUND sentry.example.com"), 3),
      );

      const res = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      expect(res.status).toBe(200);

      const body = ToolProbeErrorSchema.parse(await res.json());
      expect(body.ok).toBe(false);
      expect(body.phase).toBe("dns");
      expect(body.error).toContain("ENOTFOUND");
    });

    it("works for a blessed static server", async () => {
      const blessedId = Object.keys(mcpServersRegistry.servers)[0];
      if (!blessedId) throw new Error("expected at least one blessed server");

      mockCreateMCPTools.mockResolvedValue({
        tools: { "static-tool": { description: "A static tool" } },
        dispose: vi.fn().mockResolvedValue(undefined),
      });

      const res = await mcpRegistryRouter.request(`/${blessedId}/tools`);
      expect(res.status).toBe(200);

      const body = ToolProbeSuccessSchema.parse(await res.json());
      expect(body.ok).toBe(true);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0]).toEqual({ name: "static-tool", description: "A static tool" });
    });

    it("handles tools without descriptions gracefully", async () => {
      const entry = createTestEntry("probe-no-desc");
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      mockCreateMCPTools.mockResolvedValue({
        tools: { "bare-tool": {} },
        dispose: vi.fn().mockResolvedValue(undefined),
      });

      const res = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      expect(res.status).toBe(200);

      const body = ToolProbeSuccessSchema.parse(await res.json());
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0]).toEqual({ name: "bare-tool", description: undefined });
    });

    it("serves a cached tool list on the second probe without re-invoking createMCPTools", async () => {
      const entry = createTestEntry("probe-cache-hit");
      // Seed without prewarm side effects: prewarm uses createMCPTools too.
      // Mock first to count both prewarm + probe calls.
      mockCreateMCPTools.mockResolvedValue({
        tools: { "cached-tool": { description: "cached" } },
        dispose: vi.fn().mockResolvedValue(undefined),
      });

      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });
      await _flushPrewarmsForTest();
      const callsAfterAdd = mockCreateMCPTools.mock.calls.length;

      const first = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      expect(first.status).toBe(200);
      const firstBody = ToolProbeSuccessSchema.parse(await first.json());
      expect(firstBody.tools[0]?.name).toBe("cached-tool");

      const callsAfterFirst = mockCreateMCPTools.mock.calls.length;
      // Either prewarm filled the cache (first probe is a hit, no new call) or
      // prewarm was racy and the foreground probe ran. Either way, a *second*
      // /tools call must be a cache hit.
      const second = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      expect(second.status).toBe(200);
      const secondBody = ToolProbeSuccessSchema.parse(await second.json());
      expect(secondBody.tools[0]?.name).toBe("cached-tool");

      expect(mockCreateMCPTools.mock.calls.length).toBe(callsAfterFirst);
      // Sanity: at least the prewarm fired on add.
      expect(callsAfterAdd).toBeGreaterThanOrEqual(1);
    });

    it("does not cache failed probes — retry sees a fresh probe", async () => {
      const entry = createTestEntry("probe-no-cache-on-fail");
      // Prewarm fails (cold install timeout simulation).
      mockCreateMCPTools.mockRejectedValueOnce(new Error("ECONNREFUSED 127.0.0.1:8080"));

      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });
      await _flushPrewarmsForTest();

      // First foreground probe fails too.
      mockCreateMCPTools.mockRejectedValueOnce(new Error("ECONNREFUSED 127.0.0.1:8080"));
      const failed = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      const failedBody = ToolProbeErrorSchema.parse(await failed.json());
      expect(failedBody.ok).toBe(false);

      // Now succeed — cache must not contain the prior failure.
      mockCreateMCPTools.mockResolvedValueOnce({
        tools: { "recovered-tool": { description: "ok" } },
        dispose: vi.fn().mockResolvedValue(undefined),
      });
      const ok = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      const okBody = ToolProbeSuccessSchema.parse(await ok.json());
      expect(okBody.tools[0]?.name).toBe("recovered-tool");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Prewarm — POST mutations populate the tool cache
  // ═══════════════════════════════════════════════════════════════════════

  describe("prewarm on add", () => {
    it("invokes createMCPTools after POST /", async () => {
      mockCreateMCPTools.mockResolvedValue({
        tools: { "warmed-tool": { description: "warmed" } },
        dispose: vi.fn().mockResolvedValue(undefined),
      });

      const entry = createTestEntry("prewarm-create");
      const res = await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });
      expect(res.status).toBe(201);

      await _flushPrewarmsForTest();
      expect(mockCreateMCPTools).toHaveBeenCalled();
    });

    it("invalidates cache on DELETE /:id", async () => {
      const entry = createTestEntry("prewarm-delete");
      mockCreateMCPTools.mockResolvedValue({
        tools: { "v1-tool": { description: "v1" } },
        dispose: vi.fn().mockResolvedValue(undefined),
      });
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });
      await _flushPrewarmsForTest();

      const del = await mcpRegistryRouter.request(`/${entry.id}`, { method: "DELETE" });
      expect(del.status).toBe(204);

      // Re-add same id with a different config; must not serve stale cached tools.
      const reAdded = {
        ...entry,
        configTemplate: { transport: { type: "stdio", command: "echo", args: ["different"] } },
      };
      mockCreateMCPTools.mockResolvedValue({
        tools: { "v2-tool": { description: "v2" } },
        dispose: vi.fn().mockResolvedValue(undefined),
      });
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry: reAdded }),
      });
      await _flushPrewarmsForTest();

      const probe = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      const body = ToolProbeSuccessSchema.parse(await probe.json());
      expect(body.tools[0]?.name).toBe("v2-tool");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /:id/test-chat — MCP test-chat SSE stream
  // ═══════════════════════════════════════════════════════════════════════

  describe("POST /:id/test-chat", () => {
    const stubPlatformModels = createStubPlatformModels();

    function makeMockStreamTextResult(chunks: unknown[]) {
      const fullStream = (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })();

      return {
        fullStream,
        text: Promise.resolve("hello world"),
        finishReason: Promise.resolve("stop" as const),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 5 }),
        totalUsage: Promise.resolve({ promptTokens: 10, completionTokens: 5 }),
        steps: Promise.resolve([]),
        toolCalls: Promise.resolve([]),
        toolResults: Promise.resolve([]),
      };
    }

    /** Decode SSE stream body into array of { event, data } objects. */
    async function decodeSseEvents(
      body: ReadableStream<Uint8Array> | null,
    ): Promise<Array<{ event: string; data: unknown }>> {
      if (!body) return [];
      const decoder = new TextDecoder();
      let text = "";
      const reader = body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();

      const events: Array<{ event: string; data: unknown }> = [];
      for (const block of text.split("\n\n")) {
        const lines = block.split("\n");
        const eventLine = lines.find((l) => l.startsWith("event:"));
        const dataLine = lines.find((l) => l.startsWith("data:"));
        if (eventLine && dataLine) {
          const event = eventLine.slice("event:".length).trim();
          const data = JSON.parse(dataLine.slice("data:".length).trim());
          events.push({ event, data });
        }
      }
      return events;
    }

    it("returns 404 for unknown server", async () => {
      const res = await mcpRegistryRouter.request("/nonexistent-server/test-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });

      expect(res.status).toBe(404);
      const body = z.object({ error: z.string() }).parse(await res.json());
      expect(body.error).toContain("not found");
    });

    it("streams SSE events: chunk, tool_call, tool_result, done", async () => {
      const entry = createTestEntry("test-chat-success");
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      mockCreateMCPTools.mockResolvedValue({
        tools: { "fetch-data": { description: "Fetch data" } },
        dispose: vi.fn().mockResolvedValue(undefined),
      });

      mockStreamText.mockReturnValue(
        makeMockStreamTextResult([
          { type: "text-delta", delta: "Hello " },
          { type: "text-delta", delta: "world" },
          {
            type: "tool-call",
            toolCallId: "tc-1",
            toolName: "fetch-data",
            input: { url: "https://example.com" },
          },
          { type: "tool-result", toolCallId: "tc-1", output: "fetched content" },
        ]),
      );

      const app = createWrappedRouter({ platformModels: stubPlatformModels });
      const res = await app.request(`/${entry.id}/test-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");

      const events = await decodeSseEvents(res.body);
      expect(events.map((e) => e.event)).toEqual([
        "chunk",
        "chunk",
        "tool_call",
        "tool_result",
        "done",
      ]);
      expect(events[0]).toEqual({ event: "chunk", data: { text: "Hello " } });
      expect(events[1]).toEqual({ event: "chunk", data: { text: "world" } });
      expect(events[2]).toEqual({
        event: "tool_call",
        data: { toolCallId: "tc-1", toolName: "fetch-data", input: { url: "https://example.com" } },
      });
      expect(events[3]).toEqual({
        event: "tool_result",
        data: { toolCallId: "tc-1", output: "fetched content" },
      });
      expect(events[4]).toEqual({ event: "done", data: {} });

      // Verify model resolution
      const streamCall = mockStreamText.mock.calls[0];
      expect(streamCall).toBeDefined();
      const expectedModel = stubPlatformModels.get("conversational");
      expect(streamCall![0].model.modelId).toBe(expectedModel.modelId);
      expect(streamCall![0].model.provider).toBe(expectedModel.provider);
      expect(streamCall![0].system).toContain(entry.name);
    });

    it("returns SSE error event when MCP connection fails", async () => {
      const entry = createTestEntry("test-chat-mcp-fail");
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      mockCreateMCPTools.mockRejectedValue(
        new Error("getaddrinfo ENOTFOUND nonexistent.example.com"),
      );

      const app = createWrappedRouter({ platformModels: stubPlatformModels });
      const res = await app.request(`/${entry.id}/test-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");

      const events = await decodeSseEvents(res.body);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        event: "error",
        data: { error: expect.stringContaining("ENOTFOUND"), phase: "dns" },
      });
    });

    it("returns SSE error event when stream fails", async () => {
      const entry = createTestEntry("test-chat-stream-fail");
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      mockCreateMCPTools.mockResolvedValue({
        tools: { "fetch-data": { description: "Fetch data" } },
        dispose: vi.fn().mockResolvedValue(undefined),
      });

      mockStreamText.mockReturnValue(
        makeMockStreamTextResult([
          { type: "text-delta", delta: "partial" },
          // Simulate an error thrown during iteration by making the generator throw
        ]),
      );

      // Override the generator to throw after first chunk
      const errorStream = (async function* () {
        yield { type: "text-delta", delta: "partial" };
        throw new Error("Stream broke");
      })();

      mockStreamText.mockReturnValue({
        fullStream: errorStream,
        text: Promise.resolve("partial"),
        finishReason: Promise.resolve("error" as const),
        usage: Promise.resolve({ promptTokens: 5, completionTokens: 1 }),
        totalUsage: Promise.resolve({ promptTokens: 5, completionTokens: 1 }),
        steps: Promise.resolve([]),
        toolCalls: Promise.resolve([]),
        toolResults: Promise.resolve([]),
      });

      const app = createWrappedRouter({ platformModels: stubPlatformModels });
      const res = await app.request(`/${entry.id}/test-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });

      expect(res.status).toBe(200);
      const events = await decodeSseEvents(res.body);
      expect(events[0]).toEqual({ event: "chunk", data: { text: "partial" } });
      expect(events[1]).toEqual({ event: "error", data: { error: "Stream broke" } });
    });

    it("returns 404 when workspaceId is provided but workspace not found", async () => {
      const entry = createTestEntry("test-chat-ws-missing");
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      const app = createWrappedRouter({
        platformModels: stubPlatformModels,
        daemon: {
          getWorkspaceManager: () => ({ getWorkspaceConfig: vi.fn().mockResolvedValue(null) }),
        },
      });

      const res = await app.request(`/${entry.id}/test-chat?workspaceId=ws-missing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });

      expect(res.status).toBe(404);
      const body = z.object({ error: z.string() }).parse(await res.json());
      expect(body.error).toContain("Workspace not found");
    });

    it("uses workspace-scoped config when workspaceId is provided", async () => {
      const entry = createTestEntry("test-chat-ws-scope");
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      const workspaceOverride = { transport: { type: "stdio", command: "overridden-echo" } };

      const mockWorkspaceManager = {
        getWorkspaceConfig: vi
          .fn()
          .mockResolvedValue({
            workspace: { tools: { mcp: { servers: { [entry.id]: workspaceOverride } } } },
          }),
      };

      mockCreateMCPTools.mockResolvedValue({
        tools: { "fetch-data": { description: "Fetch data" } },
        dispose: vi.fn().mockResolvedValue(undefined),
      });

      mockStreamText.mockReturnValue(
        makeMockStreamTextResult([{ type: "text-delta", delta: "ok" }]),
      );

      const app = createWrappedRouter({
        platformModels: stubPlatformModels,
        daemon: { getWorkspaceManager: () => mockWorkspaceManager },
      });

      const res = await app.request(`/${entry.id}/test-chat?workspaceId=ws-1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });

      expect(res.status).toBe(200);
      const events = await decodeSseEvents(res.body);
      expect(events.some((e) => e.event === "done")).toBe(true);

      // Verify workspace config was fetched
      expect(mockWorkspaceManager.getWorkspaceConfig).toHaveBeenCalledWith("ws-1");

      // Verify createMCPTools was called for the requested server
      const createCall = mockCreateMCPTools.mock.calls[0];
      expect(createCall).toBeDefined();
      const passedConfig = createCall![0] as Record<string, unknown>;
      expect(passedConfig).toHaveProperty(entry.id);
    });
  });
});
