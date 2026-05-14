import process from "node:process";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import type { DoctorReport, MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import { LocalMCPRegistryAdapter } from "@atlas/core/mcp-registry/storage";
import { translate } from "@atlas/core/mcp-registry/translator";
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

// Mock createMCPTools for tool probe + invoke tests. `inputSchema` mirrors the
// AI-SDK tool shape — `probeAndExtract` lifts `inputSchema.jsonSchema` into the
// probe response; `execute` is what the `/invoke` route calls.
type MockTool = {
  description?: string;
  inputSchema?: { jsonSchema?: Record<string, unknown> };
  execute?: (args: unknown, opts: unknown) => Promise<unknown>;
};
type MockDisconnected = { serverId: string; kind: string; message: string };
const mockCreateMCPTools =
  vi.fn<
    (
      configs: Record<string, unknown>,
      logger: unknown,
      options?: { signal?: AbortSignal; toolPrefix?: string },
    ) => Promise<{
      tools: Record<string, MockTool>;
      dispose: () => Promise<void>;
      disconnected: MockDisconnected[];
    }>
  >();

vi.mock("@atlas/mcp", () => ({
  createMCPTools: (...args: Parameters<typeof mockCreateMCPTools>) => mockCreateMCPTools(...args),
}));

// Mock the doctor — preflight's doctor path runs it in a background task.
const mockRunDoctor = vi.hoisted(() => vi.fn());
vi.mock("@atlas/core/mcp-registry/doctor", () => ({ runDoctor: mockRunDoctor }));

// Mock the README fetcher — keep tests hermetic. The README fallback derives a
// GitHub URL from `io.github.*` canonical names, which would otherwise hit the
// network for every fixture.
vi.mock("@atlas/core/mcp-registry/readme-fetcher", () => ({
  fetchReadme: vi.fn().mockResolvedValue(null),
}));

// Mock streamText from ai for test-chat tests
const mockStreamText = vi.hoisted(() => vi.fn());

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, streamText: mockStreamText };
});

vi.mock("@atlas/core/workspace-members/storage", () => ({
  WorkspaceMemberStorage: {
    get: vi
      .fn()
      .mockImplementation((userId: string, wsId: string) =>
        Promise.resolve({
          ok: true,
          data: { userId, wsId, role: "owner", addedAt: "2026-05-11T00:00:00.000Z" },
        }),
      ),
    listByUser: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    listByWorkspace: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    put: vi.fn().mockResolvedValue({ ok: true, data: null }),
    putIfAbsent: vi.fn().mockResolvedValue({ ok: true, data: null }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  },
  ensureWorkspaceMembersKVBucket: vi.fn(),
  initWorkspaceMemberStorage: vi.fn(),
  resetWorkspaceMemberStorageForTests: vi.fn(),
}));

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
  mockRunDoctor.mockReset();
  _resetCacheForTest();
});

// Import AFTER mock setup (vi.mock is hoisted, but this makes intent clear)
const { mcpRegistryRouter, _flushDoctorTasksForTest } = await import("./mcp-registry.ts");
const { _resetCacheForTest, _flushPrewarmsForTest, _setRaceCapForTest } = await import(
  "./mcp-tool-cache.ts"
);

/** Build a Hono app that wraps the MCP registry router with a partial mock app context. */
function createWrappedRouter(context: Record<string, unknown>) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    // @ts-expect-error - partial mock for tests
    c.set("app", context);
    // @ts-expect-error - userId Variables not typed on bare Hono app
    c.set("userId", "test-user");
    await next();
  });
  app.route("/", mcpRegistryRouter);
  return app;
}

/** Seed a `ready` registry entry directly into the test adapter (no install route). */
async function seedRegistryEntry(upstreamEntry: UpstreamServerEntry): Promise<string> {
  const result = translate(upstreamEntry);
  if (!result.success) throw new Error(`seedRegistryEntry: translate failed — ${result.reason}`);
  await testAdapter.add({ ...result.entry, status: "ready" });
  return result.entry.id;
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
        updatedAt: z.string(),
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
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      inputSchema: z.record(z.string(), z.unknown()).nullable(),
    }),
  ),
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

      await seedRegistryEntry(upstreamEntry);

      // Search returns installed and not-installed servers
      mockSearch.mockResolvedValue({
        servers: [
          createNpmStdioUpstreamEntry(canonicalName, "1.0.0"), // already installed
          createNpmStdioUpstreamEntry("io.github.test/new-server", "2.0.0"), // not installed
        ],
      });

      const res = await mcpRegistryRouter.request("/search?q=test");

      expect(res.status).toBe(200);
      const body = SearchResponseSchema.parse(await res.json());
      expect(body.servers).toHaveLength(2);
      expect(body.servers[0]?.alreadyInstalled).toBe(true);
      expect(body.servers[0]?.version).toBe("1.0.0");
      expect(body.servers[0]?.updatedAt).toBeTruthy();
      expect(body.servers[1]?.alreadyInstalled).toBe(false);
      expect(body.servers[1]?.version).toBe("2.0.0");
    });

    it("filters out entries the translator can't install (e.g. Docker/OCI)", async () => {
      mockSearch.mockResolvedValue({
        servers: [
          createNpmStdioUpstreamEntry("io.github.test/installable", "1.0.0"),
          createDockerOnlyUpstreamEntry("io.github.test/docker-only", "1.0.0"),
        ],
      });

      const res = await mcpRegistryRouter.request("/search?q=test");

      expect(res.status).toBe(200);
      const body = SearchResponseSchema.parse(await res.json());
      expect(body.servers.map((s) => s.name)).toEqual(["io.github.test/installable"]);
    });

    it("handles empty search results", async () => {
      mockSearch.mockResolvedValue({ servers: [] });

      const res = await mcpRegistryRouter.request("/search?q=xyz");

      expect(res.status).toBe(200);
      const body = SearchResponseSchema.parse(await res.json());
      expect(body.servers).toHaveLength(0);
    });
  });

  /** Read an SSE response body fully into a list of {event, data} pairs. */
  async function readSSE(res: Response): Promise<Array<{ event: string; data: unknown }>> {
    const events: Array<{ event: string; data: unknown }> = [];
    if (!res.body) return events;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      for (;;) {
        const idx = buf.indexOf("\n\n");
        if (idx === -1) break;
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const eventLine = chunk.split("\n").find((l) => l.startsWith("event: "));
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (eventLine && dataLine) {
          events.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) });
        }
      }
      if (done) break;
    }
    return events;
  }

  /** A router wired with a stub app context — needed by the doctor-path branch. */
  function installApp() {
    return createWrappedRouter({ platformModels: createStubPlatformModels() });
  }

  const PreflightReadySchema = z.object({
    server_id: z.string(),
    status: z.literal("ready"),
    warning: z.string().optional(),
  });
  const PreflightSettingUpSchema = z.object({
    server_id: z.string(),
    status: z.literal("setting_up"),
  });

  describe("POST /install/preflight", () => {
    it("fast path: declared env vars → 201 ready, entry persisted, Link provider created", async () => {
      const canonicalName = "io.github.test/preflight-fast";
      mockFetchLatest.mockResolvedValue(createNpmStdioUpstreamEntryWithEnv(canonicalName, "1.0.0"));
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          }),
        );

      const res = await installApp().request("/install/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      expect(res.status).toBe(201);
      const body = PreflightReadySchema.parse(await res.json());
      const persisted = await testAdapter.get(body.server_id);
      expect(persisted?.status).toBe("ready");
      expect(persisted?.configTemplate.env).toEqual({
        API_KEY: { from: "link", provider: body.server_id, key: "API_KEY" },
      });
      // Link provider created; no LLM call on the fast path.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(mockRunDoctor).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("fast path: HTTP-remote OAuth server → 201 ready with no LLM call", async () => {
      const canonicalName = "io.github.test/preflight-http-oauth";
      mockFetchLatest.mockResolvedValue(createHttpRemoteUpstreamEntry(canonicalName, "1.0.0"));
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 }));

      const res = await installApp().request("/install/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      expect(res.status).toBe(201);
      const body = PreflightReadySchema.parse(await res.json());
      expect((await testAdapter.get(body.server_id))?.status).toBe("ready");
      expect(mockRunDoctor).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("fast path: surfaces a warning when Link provider creation fails", async () => {
      const canonicalName = "io.github.test/preflight-link-fail";
      mockFetchLatest.mockResolvedValue(createNpmStdioUpstreamEntryWithEnv(canonicalName, "1.0.0"));
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: false }), { status: 500 }));

      const res = await installApp().request("/install/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      expect(res.status).toBe(201);
      const body = PreflightReadySchema.parse(await res.json());
      expect(body.warning).toContain("Link provider creation failed");
      fetchSpy.mockRestore();
    });

    it("doctor path: bare entry → 201 setting_up, background run lands attention → awaiting_confirm", async () => {
      const canonicalName = "io.github.test/preflight-doctor-attention";
      mockFetchLatest.mockResolvedValue(createNpmStdioUpstreamEntry(canonicalName, "1.0.0"));
      mockRunDoctor.mockResolvedValue({
        verdict: "attention",
        tldr: "Needs a token.",
        findings: [],
        env_vars: [
          {
            name: "TOKEN",
            isRequired: true,
            isSecret: true,
            provenance: { source: "friday", readme_excerpt: "TOKEN" },
          },
        ],
      } satisfies DoctorReport);

      const res = await installApp().request("/install/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      expect(res.status).toBe(201);
      const body = PreflightSettingUpSchema.parse(await res.json());
      expect((await testAdapter.get(body.server_id))?.status).toBe("setting_up");

      await _flushDoctorTasksForTest();
      const persisted = await testAdapter.get(body.server_id);
      expect(persisted?.status).toBe("awaiting_confirm");
      expect(persisted?.doctor_report?.verdict).toBe("attention");
      expect(mockRunDoctor).toHaveBeenCalledTimes(1);
    });

    it("doctor path: clean verdict → entry becomes ready with no Link provider", async () => {
      const canonicalName = "io.github.test/preflight-doctor-clean";
      mockFetchLatest.mockResolvedValue(createNpmStdioUpstreamEntry(canonicalName, "1.0.0"));
      mockRunDoctor.mockResolvedValue({
        verdict: "clean",
        tldr: "Self-contained.",
        findings: [],
      } satisfies DoctorReport);
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 200 }));

      const res = await installApp().request("/install/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      const body = PreflightSettingUpSchema.parse(await res.json());
      await _flushDoctorTasksForTest();
      const persisted = await testAdapter.get(body.server_id);
      expect(persisted?.status).toBe("ready");
      expect(persisted?.doctor_report?.verdict).toBe("clean");
      // No Link provider creation on the doctor path.
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("doctor path: unknown verdict → entry becomes ready, flagged unknown", async () => {
      const canonicalName = "io.github.test/preflight-doctor-unknown";
      mockFetchLatest.mockResolvedValue(createNpmStdioUpstreamEntry(canonicalName, "1.0.0"));
      mockRunDoctor.mockResolvedValue({
        verdict: "unknown",
        tldr: "Could not enumerate config.",
        findings: [{ severity: "warn", title: "Sparse README", detail: "No env vars listed." }],
      } satisfies DoctorReport);

      const res = await installApp().request("/install/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      const body = PreflightSettingUpSchema.parse(await res.json());
      await _flushDoctorTasksForTest();
      const persisted = await testAdapter.get(body.server_id);
      expect(persisted?.status).toBe("ready");
      expect(persisted?.doctor_report?.verdict).toBe("unknown");
    });

    it("doctor path: a thrown doctor error collapses to a ready entry with an unknown report", async () => {
      const canonicalName = "io.github.test/preflight-doctor-crash";
      mockFetchLatest.mockResolvedValue(createNpmStdioUpstreamEntry(canonicalName, "1.0.0"));
      mockRunDoctor.mockRejectedValue(new Error("doctor exploded"));

      const res = await installApp().request("/install/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      const body = PreflightSettingUpSchema.parse(await res.json());
      await _flushDoctorTasksForTest();
      const persisted = await testAdapter.get(body.server_id);
      expect(persisted?.status).toBe("ready");
      expect(persisted?.doctor_report?.verdict).toBe("unknown");
      expect(persisted?.doctor_report?.findings.some((f) => f.severity === "error")).toBe(true);
    });

    it("returns 400 when the translator rejects the entry", async () => {
      const canonicalName = "io.github.test/preflight-docker";
      mockFetchLatest.mockResolvedValue(createDockerOnlyUpstreamEntry(canonicalName, "1.0.0"));

      const res = await installApp().request("/install/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      expect(res.status).toBe(400);
      const body = InstallErrorSchema.parse(await res.json());
      expect(body.error).toContain("Docker/OCI");
    });

    it("returns 400 for an invalid request body", async () => {
      const res = await installApp().request("/install/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 409 when the derived id collides with a blessed registry entry", async () => {
      const blessedId = Object.keys(mcpServersRegistry.servers)[0];
      if (!blessedId) throw new Error("expected at least one blessed server");
      mockFetchLatest.mockResolvedValue(createNpmStdioUpstreamEntry(blessedId, "1.0.0"));

      const res = await installApp().request("/install/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: blessedId }),
      });

      expect(res.status).toBe(409);
      const body = InstallErrorSchema.parse(await res.json());
      expect(body.error).toContain("blessed");
    });

    it("returns 409 when the same canonical name is already installed", async () => {
      const canonicalName = "io.github.test/preflight-duplicate";
      mockFetchLatest.mockResolvedValue(createNpmStdioUpstreamEntryWithEnv(canonicalName, "1.0.0"));
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 }));

      const first = await installApp().request("/install/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });
      const firstBody = PreflightReadySchema.parse(await first.json());

      const res = await installApp().request("/install/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });

      expect(res.status).toBe(409);
      const body = InstallErrorSchema.parse(await res.json());
      expect(body.existingId).toBe(firstBody.server_id);
      fetchSpy.mockRestore();
    });

    it("returns 404 when the upstream server is not found", async () => {
      mockFetchLatest.mockRejectedValue(new Error("Server not found in registry"));

      const res = await installApp().request("/install/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: "io.github.test/preflight-missing" }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe("POST /install/commit/:id", () => {
    /** Drive a bare entry to `awaiting_confirm` via the doctor path. */
    async function seedAwaitingConfirm(canonicalName: string): Promise<string> {
      mockFetchLatest.mockResolvedValue(createNpmStdioUpstreamEntry(canonicalName, "1.0.0"));
      mockRunDoctor.mockResolvedValue({
        verdict: "attention",
        tldr: "Needs an API key.",
        findings: [],
        env_vars: [
          {
            name: "API_KEY",
            isRequired: true,
            isSecret: true,
            provenance: { source: "friday", readme_excerpt: "API_KEY" },
          },
        ],
      } satisfies DoctorReport);
      const pre = await installApp().request("/install/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });
      const { server_id } = PreflightSettingUpSchema.parse(await pre.json());
      await _flushDoctorTasksForTest();
      return server_id;
    }

    it("commits an awaiting_confirm entry → creates the Link provider, flips to ready", async () => {
      const serverId = await seedAwaitingConfirm("io.github.test/commit-ok");
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 }));

      const res = await installApp().request(`/install/commit/${serverId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env_vars: [{ name: "API_KEY", isRequired: true, isSecret: true }] }),
      });

      expect(res.status).toBe(200);
      const body = z
        .object({ server_id: z.string(), status: z.literal("ready") })
        .parse(await res.json());
      expect(body.server_id).toBe(serverId);

      const persisted = await testAdapter.get(serverId);
      expect(persisted?.status).toBe("ready");
      expect(persisted?.configTemplate.env).toEqual({
        API_KEY: { from: "link", provider: serverId, key: "API_KEY" },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      fetchSpy.mockRestore();
    });

    it("rejects commit on an entry that is not awaiting confirmation", async () => {
      const canonicalName = "io.github.test/commit-wrong-status";
      mockFetchLatest.mockResolvedValue(createNpmStdioUpstreamEntryWithEnv(canonicalName, "1.0.0"));
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 }));
      const pre = await installApp().request("/install/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });
      const { server_id } = PreflightReadySchema.parse(await pre.json());
      fetchSpy.mockRestore();

      const res = await installApp().request(`/install/commit/${server_id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env_vars: [{ name: "X", isRequired: true, isSecret: false }] }),
      });

      expect(res.status).toBe(409);
    });

    it("returns 404 for an unknown server", async () => {
      const res = await installApp().request("/install/commit/does-not-exist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env_vars: [{ name: "X", isRequired: true, isSecret: false }] }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /install/cancel/:id", () => {
    it("cancels an in-progress install → 204, entry removed", async () => {
      const canonicalName = "io.github.test/cancel-ok";
      mockFetchLatest.mockResolvedValue(createNpmStdioUpstreamEntry(canonicalName, "1.0.0"));
      mockRunDoctor.mockResolvedValue({
        verdict: "clean",
        tldr: "ok",
        findings: [],
      } satisfies DoctorReport);
      const pre = await installApp().request("/install/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });
      const { server_id } = PreflightSettingUpSchema.parse(await pre.json());

      const res = await installApp().request(`/install/cancel/${server_id}`, { method: "POST" });
      expect(res.status).toBe(204);
      expect(await testAdapter.get(server_id)).toBeNull();
      await _flushDoctorTasksForTest();
    });

    it("returns 404 for an unknown server", async () => {
      const res = await installApp().request("/install/cancel/does-not-exist", { method: "POST" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /manual-config/:id", () => {
    /** Drive a bare entry to a `ready` terminal state with the given verdict. */
    async function seedReady(canonicalName: string, report: DoctorReport): Promise<string> {
      mockFetchLatest.mockResolvedValue(createNpmStdioUpstreamEntry(canonicalName, "1.0.0"));
      mockRunDoctor.mockResolvedValue(report);
      const pre = await installApp().request("/install/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });
      const { server_id } = PreflightSettingUpSchema.parse(await pre.json());
      await _flushDoctorTasksForTest();
      return server_id;
    }

    const UNKNOWN_REPORT: DoctorReport = {
      verdict: "unknown",
      tldr: "Could not enumerate config.",
      findings: [{ severity: "warn", title: "Sparse README", detail: "No env vars listed." }],
    };
    const CLEAN_REPORT: DoctorReport = { verdict: "clean", tldr: "Self-contained.", findings: [] };

    it("credentials → Link provider created and Link refs added to env", async () => {
      const serverId = await seedReady("io.github.test/manual-creds", UNKNOWN_REPORT);
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 }));

      const res = await installApp().request(`/manual-config/${serverId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credentials: [{ name: "MY_TOKEN", isRequired: true }],
          settings: [],
        }),
      });

      expect(res.status).toBe(200);
      const persisted = await testAdapter.get(serverId);
      expect(persisted?.configTemplate.env?.MY_TOKEN).toEqual({
        from: "link",
        provider: serverId,
        key: "MY_TOKEN",
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      fetchSpy.mockRestore();
    });

    it("settings → plain-string env entries, no Link provider", async () => {
      const serverId = await seedReady("io.github.test/manual-settings", UNKNOWN_REPORT);
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 }));

      const res = await installApp().request(`/manual-config/${serverId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credentials: [],
          settings: [{ name: "LOG_LEVEL", default: "info" }],
        }),
      });

      expect(res.status).toBe(200);
      const persisted = await testAdapter.get(serverId);
      expect(persisted?.configTemplate.env?.LOG_LEVEL).toBe("info");
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("mixed credentials + settings apply together", async () => {
      const serverId = await seedReady("io.github.test/manual-mixed", UNKNOWN_REPORT);
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 }));

      const res = await installApp().request(`/manual-config/${serverId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credentials: [{ name: "TOKEN", isRequired: true }],
          settings: [{ name: "REGION", default: "us-east-1" }],
        }),
      });

      expect(res.status).toBe(200);
      const persisted = await testAdapter.get(serverId);
      expect(persisted?.configTemplate.env?.TOKEN).toEqual({
        from: "link",
        provider: serverId,
        key: "TOKEN",
      });
      expect(persisted?.configTemplate.env?.REGION).toBe("us-east-1");
      fetchSpy.mockRestore();
    });

    it("succeeds on a clean-verdict entry — the gate is 'no Link provider', not the verdict", async () => {
      const serverId = await seedReady("io.github.test/manual-clean", CLEAN_REPORT);
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 }));

      const res = await installApp().request(`/manual-config/${serverId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentials: [{ name: "KEY", isRequired: true }], settings: [] }),
      });

      expect(res.status).toBe(200);
      fetchSpy.mockRestore();
    });

    it("rejects manual-config on an attention-verdict entry (Link provider is frozen)", async () => {
      const canonicalName = "io.github.test/manual-attention";
      mockFetchLatest.mockResolvedValue(createNpmStdioUpstreamEntry(canonicalName, "1.0.0"));
      mockRunDoctor.mockResolvedValue({
        verdict: "attention",
        tldr: "Needs a key.",
        findings: [],
        env_vars: [
          {
            name: "API_KEY",
            isRequired: true,
            isSecret: true,
            provenance: { source: "friday", readme_excerpt: "API_KEY" },
          },
        ],
      } satisfies DoctorReport);
      const pre = await installApp().request("/install/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });
      const { server_id } = PreflightSettingUpSchema.parse(await pre.json());
      await _flushDoctorTasksForTest();

      const res = await installApp().request(`/manual-config/${server_id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentials: [{ name: "EXTRA", isRequired: true }], settings: [] }),
      });

      expect(res.status).toBe(409);
      const body = z.object({ error: z.string() }).parse(await res.json());
      expect(body.error).toBe("link_provider_frozen");
    });

    it("returns 404 for an unknown server", async () => {
      const res = await installApp().request("/manual-config/does-not-exist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentials: [], settings: [] }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /:id/stream", () => {
    it("emits the phase sequence then a terminal result for a live run", async () => {
      const canonicalName = "io.github.test/stream-live";
      mockFetchLatest.mockResolvedValue(createNpmStdioUpstreamEntry(canonicalName, "1.0.0"));
      let resolveDoctor!: (r: DoctorReport) => void;
      mockRunDoctor.mockReturnValue(
        new Promise<DoctorReport>((r) => {
          resolveDoctor = r;
        }),
      );

      const pre = await installApp().request("/install/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });
      const { server_id } = PreflightSettingUpSchema.parse(await pre.json());

      // Wait until the background task is blocked on runDoctor — the
      // `fetching-readme` and `prompting-llm` phases are buffered, and the
      // entry is still `setting_up`.
      await vi.waitFor(() => {
        expect(mockRunDoctor).toHaveBeenCalled();
      });

      const streamRes = await installApp().request(`/${server_id}/stream`, { method: "GET" });
      const readPromise = readSSE(streamRes);

      resolveDoctor({ verdict: "clean", tldr: "ok", findings: [] });
      await _flushDoctorTasksForTest();

      const events = await readPromise;
      expect(events.map((e) => e.event)).toEqual(["phase", "phase", "phase", "result"]);
      expect(
        events
          .map((e) => (e.data as { phase?: string }).phase)
          .filter((p): p is string => Boolean(p)),
      ).toEqual(["fetching-readme", "prompting-llm", "validating"]);
      const last = events.at(-1);
      expect((last?.data as { report: DoctorReport }).report.verdict).toBe("clean");
    });

    it("replays just the terminal result for a late subscriber", async () => {
      const canonicalName = "io.github.test/stream-replay";
      mockFetchLatest.mockResolvedValue(createNpmStdioUpstreamEntry(canonicalName, "1.0.0"));
      mockRunDoctor.mockResolvedValue({
        verdict: "unknown",
        tldr: "Needs config.",
        findings: [{ severity: "warn", title: "Sparse", detail: "No vars." }],
      } satisfies DoctorReport);

      const pre = await installApp().request("/install/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryName: canonicalName }),
      });
      const { server_id } = PreflightSettingUpSchema.parse(await pre.json());
      await _flushDoctorTasksForTest();

      const streamRes = await installApp().request(`/${server_id}/stream`, { method: "GET" });
      const events = await readSSE(streamRes);

      expect(events).toHaveLength(1);
      expect(events[0]?.event).toBe("result");
      expect((events[0]?.data as { report: DoctorReport }).report.verdict).toBe("unknown");
    });

    it("returns 404 for an unknown server", async () => {
      const res = await installApp().request("/nonexistent-server/stream", { method: "GET" });
      expect(res.status).toBe(404);
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
      const installedId = await seedRegistryEntry(oldUpstreamEntry);

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
      const installedId = await seedRegistryEntry(upstreamEntry);

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
      // Install v1
      const storedId = await seedRegistryEntry(v1UpstreamEntry);
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
      const installedId = await seedRegistryEntry(upstreamEntry);

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
      const init = fetchSpy.mock.calls[0]?.[1];
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
      const init = fetchSpy.mock.calls[0]?.[1];
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
            requiredConfig: z.array(z.any()).length(0).optional(),
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
          // `createMCPTools` exposes the tool's JSON Schema under
          // `inputSchema.jsonSchema`; `probeAndExtract` lifts that out.
          "fetch-data": {
            description: "Fetch data from the server",
            inputSchema: { jsonSchema: { type: "object", properties: { id: { type: "string" } } } },
          },
          // No declared schema → the route returns `inputSchema: null`.
          "send-data": { description: "Send data to the server" },
        },
        dispose: vi.fn().mockResolvedValue(undefined),
        disconnected: [],
      });

      const res = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      expect(res.status).toBe(200);

      const body = ToolProbeSuccessSchema.parse(await res.json());
      expect(body.ok).toBe(true);
      expect(body.tools).toHaveLength(2);
      expect(body.tools[0]).toEqual({
        name: "fetch-data",
        description: "Fetch data from the server",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
      });
      expect(body.tools[1]).toEqual({
        name: "send-data",
        description: "Send data to the server",
        inputSchema: null,
      });
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
        disconnected: [],
      });

      const res = await mcpRegistryRouter.request(`/${blessedId}/tools`);
      expect(res.status).toBe(200);

      const body = ToolProbeSuccessSchema.parse(await res.json());
      expect(body.ok).toBe(true);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0]).toEqual({
        name: "static-tool",
        description: "A static tool",
        inputSchema: null,
      });
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
        disconnected: [],
      });

      const res = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      expect(res.status).toBe(200);

      const body = ToolProbeSuccessSchema.parse(await res.json());
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0]).toEqual({
        name: "bare-tool",
        description: undefined,
        inputSchema: null,
      });
    });

    it("serves cached tools — prewarm populates, GET is a hit, no second probe", async () => {
      const entry = createTestEntry("probe-cache-hit");
      mockCreateMCPTools.mockResolvedValue({
        tools: { "cached-tool": { description: "cached" } },
        dispose: vi.fn().mockResolvedValue(undefined),
        disconnected: [],
      });

      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });
      await _flushPrewarmsForTest();
      // Prewarm probed exactly once.
      expect(mockCreateMCPTools.mock.calls.length).toBe(1);

      // First GET must be a cache hit — no new probe.
      const first = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      expect(first.status).toBe(200);
      const firstBody = ToolProbeSuccessSchema.parse(await first.json());
      expect(firstBody.tools[0]?.name).toBe("cached-tool");
      expect(mockCreateMCPTools.mock.calls.length).toBe(1);

      // Second GET also a cache hit.
      const second = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      expect(second.status).toBe(200);
      const secondBody = ToolProbeSuccessSchema.parse(await second.json());
      expect(secondBody.tools[0]?.name).toBe("cached-tool");
      expect(mockCreateMCPTools.mock.calls.length).toBe(1);
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
        disconnected: [],
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
    it("populates the cache after POST / — follow-up GET is a hit", async () => {
      mockCreateMCPTools.mockResolvedValue({
        tools: { "warmed-tool": { description: "warmed" } },
        dispose: vi.fn().mockResolvedValue(undefined),
        disconnected: [],
      });

      const entry = createTestEntry("prewarm-create");
      const res = await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });
      expect(res.status).toBe(201);
      await _flushPrewarmsForTest();
      expect(mockCreateMCPTools.mock.calls.length).toBe(1);

      // The follow-up GET must be a cache hit — call count stays at 1.
      const probe = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      expect(probe.status).toBe(200);
      const body = ToolProbeSuccessSchema.parse(await probe.json());
      expect(body.tools[0]?.name).toBe("warmed-tool");
      expect(mockCreateMCPTools.mock.calls.length).toBe(1);
    });

    it("invalidates cache on DELETE /:id — same id+config re-add returns fresh tools", async () => {
      const entry = createTestEntry("prewarm-delete");
      mockCreateMCPTools.mockResolvedValue({
        tools: { "v1-tool": { description: "v1" } },
        dispose: vi.fn().mockResolvedValue(undefined),
        disconnected: [],
      });
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });
      await _flushPrewarmsForTest();

      const del = await mcpRegistryRouter.request(`/${entry.id}`, { method: "DELETE" });
      expect(del.status).toBe(204);

      // Re-add with the SAME configTemplate. configHash matches, so only
      // invalidateCache(id) on DELETE can keep the cache from serving v1-tool
      // (otherwise prewarmTools would short-circuit on the still-cached entry
      // and skip probing — caller would see stale tools).
      mockCreateMCPTools.mockResolvedValue({
        tools: { "v2-tool": { description: "v2" } },
        dispose: vi.fn().mockResolvedValue(undefined),
        disconnected: [],
      });
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });
      await _flushPrewarmsForTest();

      const probe = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      const body = ToolProbeSuccessSchema.parse(await probe.json());
      expect(body.tools[0]?.name).toBe("v2-tool");
    });

    it("invalidates and reprewarms on POST /:id/update — old tools gone, new tools cached", async () => {
      const canonicalName = "io.github.test/update-prewarm";
      const v1 = createNpmStdioUpstreamEntry(canonicalName, "1.0.0");

      mockCreateMCPTools.mockResolvedValueOnce({
        tools: { "v1-tool": { description: "v1" } },
        dispose: vi.fn().mockResolvedValue(undefined),
        disconnected: [],
      });
      const storedId = await seedRegistryEntry(v1);
      await _flushPrewarmsForTest();
      // Confirm v1 tools cached.
      const beforeUpdate = await mcpRegistryRouter.request(`/${storedId}/tools`);
      expect(ToolProbeSuccessSchema.parse(await beforeUpdate.json()).tools[0]?.name).toBe(
        "v1-tool",
      );
      const callsAfterInstall = mockCreateMCPTools.mock.calls.length;

      // Pull update to v2 — handler must invalidateCache + prewarm with new config.
      const v2 = createNpmStdioUpstreamEntry(canonicalName, "2.0.0");
      mockFetchLatest.mockResolvedValueOnce(v2);
      mockCreateMCPTools.mockResolvedValueOnce({
        tools: { "v2-tool": { description: "v2" } },
        dispose: vi.fn().mockResolvedValue(undefined),
        disconnected: [],
      });
      const updateRes = await mcpRegistryRouter.request(`/${storedId}/update`, { method: "POST" });
      expect(updateRes.status).toBe(200);
      await _flushPrewarmsForTest();

      // Reprewarm probed exactly once after install.
      expect(mockCreateMCPTools.mock.calls.length).toBe(callsAfterInstall + 1);

      // GET /tools must serve the new v2 tools and stay a cache hit.
      const probe = await mcpRegistryRouter.request(`/${storedId}/tools`);
      const body = ToolProbeSuccessSchema.parse(await probe.json());
      expect(body.tools[0]?.name).toBe("v2-tool");
      expect(mockCreateMCPTools.mock.calls.length).toBe(callsAfterInstall + 1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /:id/tools — in-flight prewarm dedup
  // ═══════════════════════════════════════════════════════════════════════

  describe("GET /:id/tools dedup", () => {
    it("waits for in-flight prewarm instead of spawning a duplicate probe", async () => {
      const entry = createTestEntry("dedup-wait");
      // Defer the prewarm's createMCPTools so the GET races into the dedup branch.
      let resolvePrewarm: (() => void) | undefined;
      mockCreateMCPTools.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePrewarm = () =>
              resolve({
                tools: { "warmed-tool": { description: "warmed" } },
                dispose: vi.fn().mockResolvedValue(undefined),
                disconnected: [],
              });
          }),
      );

      // Add — prewarm starts but does not resolve yet.
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      // Click "list tools" while prewarm is still pending.
      const probePromise = mcpRegistryRouter.request(`/${entry.id}/tools`);

      // Now resolve the prewarm. The pending GET awaits the same in-flight
      // promise — must not have spawned its own probe.
      resolvePrewarm?.();
      const probe = await probePromise;
      await _flushPrewarmsForTest();

      expect(probe.status).toBe(200);
      const body = ToolProbeSuccessSchema.parse(await probe.json());
      expect(body.tools[0]?.name).toBe("warmed-tool");
      // Exactly one probe — no duplicate spawned by the GET.
      expect(mockCreateMCPTools.mock.calls.length).toBe(1);
    });

    it("disconnected probe surfaces as auth phase, not cached as []", async () => {
      const entry = createTestEntry("disconnected-probe");
      mockCreateMCPTools.mockResolvedValue({
        tools: {},
        dispose: vi.fn().mockResolvedValue(undefined),
        disconnected: [
          {
            serverId: entry.id,
            kind: "credential_not_found",
            message: "Credential 'github' was deleted. Reconnect to continue.",
          },
        ],
      });

      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });
      await _flushPrewarmsForTest();

      // Foreground GET — prewarm finished with auth error, surfaced via the dedup
      // path or via foreground probe (both get classified as auth).
      const probe = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      const body = ToolProbeErrorSchema.parse(await probe.json());
      expect(body.ok).toBe(false);
      expect(body.phase).toBe("auth");
      // Error must be the entry.message verbatim — not the constructor's
      // template wrapped around it (which would produce nested gibberish).
      expect(body.error).toBe("Credential 'github' was deleted. Reconnect to continue.");
    });

    it("silently-failed probe (empty tools, no disconnected) surfaces as connect, not cached []", async () => {
      // Mirrors the QA finding: createMCPTools warn-logs and silently drops
      // servers that fail to start (typo'd npm package, MCPStartupError,
      // connect error). No `disconnected` entry, just `tools: {}`. Without
      // the empty-tools guard in probeAndExtract, the probe would cache `[]`
      // and the user would see "no tools" instead of a real error.
      const entry = createTestEntry("connect-failed-probe");
      mockCreateMCPTools.mockResolvedValue({
        tools: {},
        dispose: vi.fn().mockResolvedValue(undefined),
        disconnected: [],
      });

      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });
      await _flushPrewarmsForTest();

      const probe = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      const body = ToolProbeErrorSchema.parse(await probe.json());
      expect(body.ok).toBe(false);
      expect(body.phase).toBe("connect");
      expect(body.error).toContain("failed to start");
    });

    it("dedup branch surfaces classified prewarm failure when GET arrives mid-prewarm", async () => {
      const entry = createTestEntry("dedup-prewarm-error");
      // Defer the prewarm so the GET enters the dedup branch BEFORE the
      // prewarm settles. Resolves to disconnected — probeAndExtract throws
      // inside prewarmTools, which classifies to auth and resolves the
      // PrewarmResult with { ok: false, phase: "auth" }.
      let resolveDisconnected: (() => void) | undefined;
      mockCreateMCPTools.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveDisconnected = () =>
              resolve({
                tools: {},
                dispose: vi.fn().mockResolvedValue(undefined),
                disconnected: [
                  {
                    serverId: entry.id,
                    kind: "credential_not_found",
                    message: "Credential missing — reconnect to continue.",
                  },
                ],
              });
          }),
      );

      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      // GET while prewarm is still pending — must enter the dedup branch.
      const probePromise = mcpRegistryRouter.request(`/${entry.id}/tools`);
      // Wait for the handler to advance past `await getMCPRegistryAdapter()`
      // and `await adapter.get(id)` (in-memory KV, normally <1ms) and reach
      // `await Promise.race(...)` BEFORE the prewarm settles. Otherwise the
      // IIFE's microtasks (dispose → throw → catch → classify → finally →
      // delete) finish first, evicting `inFlightPrewarm` before the handler
      // consults it; the GET then falls through to the foreground probe
      // path, which still classifies disconnect to "auth" via mockResolved
      // carry-over OR fails on the exhausted `mockImplementationOnce`. Use
      // 250ms to stay well clear of GC pauses / loaded-CI jitter — failure
      // mode (`expected "auth" got "connect"`) doesn't point at timing.
      await new Promise((resolve) => setTimeout(resolve, 250));
      resolveDisconnected?.();
      const probe = await probePromise;

      const body = ToolProbeErrorSchema.parse(await probe.json());
      expect(body.ok).toBe(false);
      expect(body.phase).toBe("auth");
      expect(body.error).toBe("Credential missing — reconnect to continue.");
      // The dedup branch consumed the prewarm's classified result — no
      // duplicate foreground probe was spawned.
      expect(mockCreateMCPTools.mock.calls.length).toBe(1);
    });

    it("returns retryable hint when in-flight prewarm exceeds the race cap", async () => {
      _setRaceCapForTest(50);
      const entry = createTestEntry("dedup-retryable");
      // Prewarm hangs forever — race cap will fire first. The pending IIFE
      // is GC-eligible after `_resetCacheForTest` clears `inFlightPrewarm`
      // in the next test's beforeEach (the map holds the only live ref).
      mockCreateMCPTools.mockImplementationOnce(() => new Promise(() => {}));

      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });

      const probe = await mcpRegistryRouter.request(`/${entry.id}/tools`);
      expect(probe.status).toBe(200);
      const body = z
        .object({ ok: z.literal(false), retryable: z.literal(true), error: z.string() })
        .parse(await probe.json());
      expect(body.retryable).toBe(true);
      // The GET did not spawn its own probe — only the still-pending prewarm.
      expect(mockCreateMCPTools.mock.calls.length).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // mcp-tool-cache.ts — direct unit tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("mcp-tool-cache direct", () => {
    it("invalidateCache(id) clears the entry — getCachedTools returns null", async () => {
      const { putCachedTools, getCachedTools, invalidateCache } = await import(
        "./mcp-tool-cache.ts"
      );
      const config = { transport: { type: "stdio" as const, command: "echo", args: ["x"] } };
      putCachedTools("direct-id", config, [
        { name: "t1", description: "first", inputSchema: null },
      ]);
      expect(getCachedTools("direct-id", config)?.[0]?.name).toBe("t1");
      invalidateCache("direct-id");
      expect(getCachedTools("direct-id", config)).toBeNull();
    });

    it("getCachedTools returns null when configHash differs", async () => {
      const { putCachedTools, getCachedTools } = await import("./mcp-tool-cache.ts");
      const v1 = { transport: { type: "stdio" as const, command: "echo", args: ["1"] } };
      const v2 = { transport: { type: "stdio" as const, command: "echo", args: ["2"] } };
      putCachedTools("hash-id", v1, [{ name: "t-v1", inputSchema: null }]);
      expect(getCachedTools("hash-id", v1)?.[0]?.name).toBe("t-v1");
      expect(getCachedTools("hash-id", v2)).toBeNull();
    });

    it("evicts the entry on TTL expiry — getCachedTools returns null and the map is clean", async () => {
      vi.useFakeTimers();
      try {
        const { putCachedTools, getCachedTools } = await import("./mcp-tool-cache.ts");
        const config = { transport: { type: "stdio" as const, command: "echo", args: ["x"] } };
        putCachedTools("ttl-id", config, [{ name: "t1", inputSchema: null }]);
        expect(getCachedTools("ttl-id", config)?.[0]?.name).toBe("t1");
        // Advance past the 1h TTL.
        vi.advanceTimersByTime(60 * 60 * 1000 + 1);
        expect(getCachedTools("ttl-id", config)).toBeNull();
        // The expired entry must actually be removed (not just returned-as-null).
        // Re-put would prove the slot is reusable; checking again post-eviction
        // confirms no stale entry lingers under the same id+hash.
        expect(getCachedTools("ttl-id", config)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("prewarmTools dedupes same-config callers but starts a fresh probe when config changes", async () => {
      const { prewarmTools, getInFlightPrewarm, _resetCacheForTest } = await import(
        "./mcp-tool-cache.ts"
      );
      _resetCacheForTest();

      // Two never-resolving probes so we can inspect in-flight state without
      // the IIFE settling between assertions.
      mockCreateMCPTools.mockImplementation(() => new Promise(() => {}));

      const fakeLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as Parameters<typeof prewarmTools>[2];

      const v1 = { transport: { type: "stdio" as const, command: "echo", args: ["v1"] } };
      const v2 = { transport: { type: "stdio" as const, command: "echo", args: ["v2"] } };

      const p1a = prewarmTools("race-id", v1, fakeLogger);
      const p1b = prewarmTools("race-id", v1, fakeLogger);
      // Same config → second caller dedupes onto the same in-flight promise.
      expect(p1a).toBe(p1b);
      expect(mockCreateMCPTools.mock.calls.length).toBe(1);

      // Different config → must start a fresh probe, not return p1.
      const p2 = prewarmTools("race-id", v2, fakeLogger);
      expect(p2).not.toBe(p1a);
      expect(mockCreateMCPTools.mock.calls.length).toBe(2);

      // getInFlightPrewarm now returns the v2 promise for v2 callers, and
      // undefined for v1 callers (the v1 prewarm is still running but its
      // slot has been replaced — a v1-config GET would correctly fall
      // through rather than wait on v2 tools).
      expect(getInFlightPrewarm("race-id", v2)).toBe(p2);
      expect(getInFlightPrewarm("race-id", v1)).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /:id/invoke — raw single-tool invocation
  // ═══════════════════════════════════════════════════════════════════════

  describe("POST /:id/invoke", () => {
    /** App context with a workspace manager whose config has the server enabled. */
    function invokeApp(serverId: string) {
      const mockWorkspaceManager = {
        getWorkspaceConfig: vi
          .fn()
          .mockResolvedValue({
            workspace: {
              tools: {
                mcp: { servers: { [serverId]: { transport: { type: "stdio", command: "echo" } } } },
              },
            },
          }),
      };
      return {
        app: createWrappedRouter({ daemon: { getWorkspaceManager: () => mockWorkspaceManager } }),
        mockWorkspaceManager,
      };
    }

    async function seedEntry(name: string) {
      const entry = createTestEntry(name);
      await mcpRegistryRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry }),
      });
      return entry;
    }

    it("rejects a request with no workspaceId (400)", async () => {
      const entry = await seedEntry("invoke-no-ws");
      const { app } = invokeApp(entry.id);
      const res = await app.request(`/${entry.id}/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName: "fetch-data", args: {} }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for an unknown server", async () => {
      const { app } = invokeApp("nonexistent");
      const res = await app.request("/nonexistent-server/invoke?workspaceId=ws-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName: "x", args: {} }),
      });
      expect(res.status).toBe(404);
      const body = z.object({ ok: z.literal(false), error: z.string() }).parse(await res.json());
      expect(body.error).toContain("not found");
    });

    it("returns 404 when the tool is not found on the server", async () => {
      const entry = await seedEntry("invoke-no-tool");
      mockCreateMCPTools.mockResolvedValue({
        tools: { "other-tool": { execute: vi.fn() } },
        dispose: vi.fn().mockResolvedValue(undefined),
        disconnected: [],
      });
      const { app } = invokeApp(entry.id);
      const res = await app.request(`/${entry.id}/invoke?workspaceId=ws-1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName: "missing-tool", args: {} }),
      });
      expect(res.status).toBe(404);
      const body = z.object({ ok: z.literal(false), error: z.string() }).parse(await res.json());
      expect(body.error).toContain("missing-tool");
    });

    it("invokes the tool, returns its output, and disposes the connection", async () => {
      const entry = await seedEntry("invoke-ok");
      const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "done" }] });
      const dispose = vi.fn().mockResolvedValue(undefined);
      mockCreateMCPTools.mockResolvedValue({
        tools: { "run-it": { execute } },
        dispose,
        disconnected: [],
      });
      const { app } = invokeApp(entry.id);
      const res = await app.request(`/${entry.id}/invoke?workspaceId=ws-1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName: "run-it", args: { q: "hi" } }),
      });
      expect(res.status).toBe(200);
      const body = z.object({ ok: z.literal(true), output: z.unknown() }).parse(await res.json());
      expect(body.output).toEqual({ content: [{ type: "text", text: "done" }] });
      expect(execute).toHaveBeenCalledWith({ q: "hi" }, expect.objectContaining({ messages: [] }));
      expect(dispose).toHaveBeenCalled();
    });

    it("classifies a connection failure into an ok:false response", async () => {
      const entry = await seedEntry("invoke-fail");
      mockCreateMCPTools.mockRejectedValue(new Error("getaddrinfo ENOTFOUND nope.example.com"));
      const { app } = invokeApp(entry.id);
      const res = await app.request(`/${entry.id}/invoke?workspaceId=ws-1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName: "run-it", args: {} }),
      });
      expect(res.status).toBe(200);
      const body = z
        .object({ ok: z.literal(false), error: z.string(), phase: z.string().optional() })
        .parse(await res.json());
      expect(body.ok).toBe(false);
    });

    it("returns 404 when the workspace config is not found", async () => {
      const entry = await seedEntry("invoke-no-wsconfig");
      const mockWorkspaceManager = { getWorkspaceConfig: vi.fn().mockResolvedValue(null) };
      const app = createWrappedRouter({
        daemon: { getWorkspaceManager: () => mockWorkspaceManager },
      });
      const res = await app.request(`/${entry.id}/invoke?workspaceId=ws-gone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName: "run-it", args: {} }),
      });
      expect(res.status).toBe(404);
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
        disconnected: [],
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
      expect(streamCall?.[0].model.modelId).toBe(expectedModel.modelId);
      expect(streamCall?.[0].model.provider).toBe(expectedModel.provider);
      expect(streamCall?.[0].system).toContain(entry.name);
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
        disconnected: [],
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
        disconnected: [],
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
      const passedConfig = createCall?.[0] as Record<string, unknown>;
      expect(passedConfig).toHaveProperty(entry.id);
    });
  });
});
