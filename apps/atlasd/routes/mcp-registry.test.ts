import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import { LocalMCPRegistryAdapter } from "@atlas/core/mcp-registry/storage";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// In-memory KV + adapter for test isolation
let testKv: Deno.Kv;
let testAdapter: LocalMCPRegistryAdapter;

vi.mock("@atlas/core/mcp-registry/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@atlas/core/mcp-registry/storage")>();
  return { ...original, getMCPRegistryAdapter: () => Promise.resolve(testAdapter) };
});

beforeAll(async () => {
  testKv = await Deno.openKv(":memory:");
  testAdapter = new LocalMCPRegistryAdapter(testKv);
});

afterAll(() => {
  testKv.close();
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
    domains: [`test-domain-${suffix}`],
    source: "web",
    securityRating: "medium",
    configTemplate: { transport: { type: "stdio", command: "echo", args: ["hello"] } },
    requiredConfig: [{ key: "TEST_KEY", description: "A test key", type: "string" as const }],
  };
}

/** Schema for successful create response */
const CreateResponseSchema = z.object({
  ok: z.literal(true),
  server: z
    .object({ id: z.string(), name: z.string(), domains: z.array(z.string()), source: z.string() })
    .passthrough(),
});

/** Schema for error response */
const ErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  suggestion: z.string().optional(),
});

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
    domains: z.array(z.string()),
    configTemplate: z
      .object({ transport: z.object({ type: z.string() }).passthrough() })
      .passthrough(),
  })
  .passthrough();

describe("MCP Registry Routes", () => {
  // --- POST / Tests ---

  it("POST / creates entry and returns 201", async () => {
    const entry = createTestEntry("create-basic");

    const res = await mcpRegistryRouter.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry }),
    });

    expect(res.status).toEqual(201);
    const body = CreateResponseSchema.parse(await res.json());
    expect(body.ok).toEqual(true);
    expect(body.server.id).toEqual(entry.id);
    expect(body.server.name).toEqual(entry.name);
  });

  it("POST / returns 409 for blessed registry collision", async () => {
    // Use a known blessed server ID
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
    expect(body.ok).toEqual(false);
    expect(body.error).toContain("blessed registry");
  });

  it("POST / returns 409 for dynamic collision with suggestion", async () => {
    // First, create an entry
    const entry = createTestEntry("collision-test");

    const firstRes = await mcpRegistryRouter.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry }),
    });
    expect(firstRes.status).toEqual(201);

    // Try to create again with same ID
    const res = await mcpRegistryRouter.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry }),
    });

    expect(res.status).toEqual(409);
    const body = ErrorResponseSchema.parse(await res.json());
    expect(body.ok).toEqual(false);
    expect(body.error).toContain("already used");
    expect(body.suggestion).toBeDefined();
  });

  it("POST / validates entry schema (rejects invalid ID)", async () => {
    const invalidEntry = {
      ...createTestEntry("invalid"),
      id: "INVALID_ID_WITH_CAPS", // Invalid: must match /^[a-z0-9-]+$/
    };

    const res = await mcpRegistryRouter.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry: invalidEntry }),
    });

    expect(res.status).toEqual(400);
  });

  it("POST / validates entry schema (rejects missing domains)", async () => {
    const invalidEntry = {
      id: "test-no-domains",
      name: "Test Server",
      domains: [], // Invalid: min 1
      source: "web",
      securityRating: "medium",
      configTemplate: { transport: { type: "stdio", command: "echo" } },
    };

    const res = await mcpRegistryRouter.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry: invalidEntry }),
    });

    expect(res.status).toEqual(400);
  });

  // --- GET / Tests ---

  it("GET / lists static and dynamic servers merged", async () => {
    // Create a dynamic entry first to ensure there's at least one
    const entry = createTestEntry("list-test");
    await mcpRegistryRouter.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry }),
    });

    const res = await mcpRegistryRouter.request("/");

    expect(res.status).toEqual(200);
    const body = ListResponseSchema.parse(await res.json());

    // Should have both static servers from blessed registry and dynamic
    expect(body.metadata.staticCount).toEqual(Object.keys(mcpServersRegistry.servers).length);
    // Dynamic count should be at least 1 (our created entry)
    expect(body.metadata.dynamicCount).toBeGreaterThanOrEqual(1);

    // Total servers should match
    expect(body.servers.length).toEqual(body.metadata.staticCount + body.metadata.dynamicCount);
  });

  it("GET / includes blessed registry servers", async () => {
    const res = await mcpRegistryRouter.request("/");
    expect(res.status).toEqual(200);

    const body = ListResponseSchema.parse(await res.json());

    // Check that known blessed servers are present
    const serverIds = body.servers.map((s) => s.id);
    const blessedIds = Object.keys(mcpServersRegistry.servers);

    for (const blessedId of blessedIds) {
      expect(serverIds).toContain(blessedId);
    }
  });

  // --- GET /:id Tests ---

  it("GET /:id returns static server with source field", async () => {
    const blessedId = "github"; // Known blessed server

    const res = await mcpRegistryRouter.request(`/${blessedId}`);

    expect(res.status).toEqual(200);
    const body = ServerResponseSchema.parse(await res.json());
    expect(body.id).toEqual(blessedId);
    expect(body.source).toEqual("static");
  });

  it("GET /:id returns dynamic server", async () => {
    // Create a dynamic entry
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

  // --- Config Template Validation Tests ---
  // These tests verify that the configs produced by the route would pass validation

  it("created entries have valid configTemplate structure", async () => {
    // Test HTTP transport type
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
    // This is the pattern that previously had a bug - testing that http + apikey works
    const linkEntry = {
      ...createTestEntry("link-template"),
      configTemplate: {
        transport: { type: "http" as const, url: "https://api.example.com/mcp" },
        auth: { type: "bearer" as const, token_env: "EXAMPLE_TOKEN" },
        env: { EXAMPLE_TOKEN: { from: "link" as const, provider: "example", key: "access_token" } },
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

    // Verify the configTemplate structure is preserved correctly
    expect(linkBody).toMatchObject({
      ok: true,
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
