import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import { LocalMCPRegistryAdapter } from "@atlas/core/mcp-registry/storage";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// In-memory KV + adapter for test isolation
let testKv: Deno.Kv;
let testAdapter: LocalMCPRegistryAdapter;

vi.mock("@atlas/core/mcp-registry/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@atlas/core/mcp-registry/storage")>();
  return { ...original, getMCPRegistryAdapter: () => Promise.resolve(testAdapter) };
});

const mockCreateMCPTools = vi.hoisted(() => {
  const dispose = vi.fn().mockResolvedValue(undefined);
  return vi.fn().mockImplementation((configs: Record<string, unknown>) => {
    const tools: Record<string, { description: string; inputSchema: unknown }> = {};
    for (const serverId of Object.keys(configs)) {
      tools[`${serverId}__test_tool`] = {
        description: `Test tool for ${serverId}`,
        inputSchema: {},
      };
    }
    return Promise.resolve({ tools, dispose });
  });
});

vi.mock("@atlas/mcp", () => ({ createMCPTools: (...args: unknown[]) => mockCreateMCPTools(...args) }));

beforeAll(async () => {
  testKv = await Deno.openKv(":memory:");
  testAdapter = new LocalMCPRegistryAdapter(testKv);
});

afterAll(() => {
  testKv.close();
});

// Import AFTER mock setup (vi.mock is hoisted, but this makes intent clear)
const { mcpRoute } = await import("./mcp.ts");

/** Create a valid dynamic test entry */
function createDynamicEntry(suffix: string): MCPServerMetadata {
  return {
    id: `dynamic-${suffix}`,
    name: `Dynamic Server ${suffix}`,
    source: "registry",
    securityRating: "medium",
    configTemplate: { transport: { type: "stdio", command: "echo", args: ["hello"] } },
    requiredConfig: [{ key: "DYNAMIC_KEY", description: "A dynamic key", type: "string" as const }],
  };
}

/** Create a custom stdio test entry with Link env refs and skipResolverCheck */
function createCustomStdioEntry(id: string): MCPServerMetadata {
  return {
    id,
    name: `Custom Stdio ${id}`,
    source: "registry",
    securityRating: "medium",
    configTemplate: {
      transport: { type: "stdio", command: "echo", args: ["hello"] },
      skipResolverCheck: true,
      env: {
        CUSTOM_TOKEN: { from: "link", provider: id, key: "CUSTOM_TOKEN" },
      },
    },
    requiredConfig: [{ key: "CUSTOM_TOKEN", description: "Custom token", type: "string" as const }],
  };
}

/** Create a custom HTTP test entry with Link env refs */
function createCustomHttpEntry(id: string): MCPServerMetadata {
  return {
    id,
    name: `Custom HTTP ${id}`,
    source: "registry",
    securityRating: "medium",
    configTemplate: {
      transport: { type: "http", url: "http://localhost:3000/sse" },
      env: {
        API_KEY: { from: "link", provider: id, key: "API_KEY" },
      },
    },
    requiredConfig: [{ key: "API_KEY", description: "API key", type: "string" as const }],
  };
}

describe("POST /tools — validation", () => {
  it("rejects empty body", async () => {
    const res = await mcpRoute.request("/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing serverIds", async () => {
    const res = await mcpRoute.request("/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty serverIds array", async () => {
    const res = await mcpRoute.request("/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverIds: [], env: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for unknown server IDs", async () => {
    const res = await mcpRoute.request("/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverIds: ["nonexistent-server"], env: {} }),
    });
    expect(res.status).toBe(400);

    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("nonexistent-server");
  });

  it("returns 400 when required env vars are missing", async () => {
    const res = await mcpRoute.request("/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverIds: ["github"], env: {} }),
    });
    expect(res.status).toBe(400);

    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("GH_TOKEN");
    expect(data.error).toContain("github");
  });

  it("returns 400 listing all servers with missing env vars", async () => {
    // Use two registry-known servers — `stripe` was removed from the
    // consolidated registry, so the route now short-circuits with
    // `Unknown server IDs: stripe` before reaching the env-var pass.
    const res = await mcpRoute.request("/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverIds: ["github", "google-gmail"], env: {} }),
    });
    expect(res.status).toBe(400);

    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("github");
    expect(data.error).toContain("GH_TOKEN");
    expect(data.error).toContain("google-gmail");
    expect(data.error).toContain("GOOGLE_GMAIL_ACCESS_TOKEN");
  });

  it("passes validation when all required env vars provided", async () => {
    // This will fail at MCPManager connection (expected) but should NOT return 400
    // We can't easily test the success path without real MCP servers,
    // so we verify it gets past validation by checking it's not a 400 validation error
    const res = await mcpRoute.request("/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverIds: ["time"], env: {} }),
    });

    // time server has no requiredConfig, so validation passes
    // Response will either succeed or have connection errors (not 400)
    const data = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) {
      expect(data).toHaveProperty("tools");
    } else {
      // Connection failure is expected in test env — but it's not a validation error
      expect(data).not.toHaveProperty("error", expect.stringContaining("Missing required"));
    }
  });
});

describe("POST /tools — dynamic registry merge", () => {
  it("resolves a registry-imported server ID when adapter contains it", async () => {
    // Add a dynamic entry to the adapter
    const dynamicEntry = createDynamicEntry("test-001");
    await testAdapter.add(dynamicEntry);

    // Request should find the dynamic server (will fail at connection, but not 400)
    const res = await mcpRoute.request("/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverIds: [dynamicEntry.id],
        env: { DYNAMIC_KEY: "test-value" },
      }),
    });

    // Should not be 400 (unknown server) - it should get past validation
    expect(res.status).not.toBe(400);
    const data = (await res.json()) as { error?: string };
    if (res.status === 400) {
      expect(data.error).not.toContain("Unknown server IDs");
    }
  });

  it("rejects unknown ID even after merge with dynamic entries", async () => {
    // Add some dynamic entries first
    await testAdapter.add(createDynamicEntry("existing-1"));
    await testAdapter.add(createDynamicEntry("existing-2"));

    // Request an unknown server ID
    const res = await mcpRoute.request("/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverIds: ["totally-unknown-server-id"],
        env: {},
      }),
    });

    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Unknown server IDs");
    expect(data.error).toContain("totally-unknown-server-id");
  });

  it("validates required env vars for dynamic registry entries", async () => {
    // Add a dynamic entry with required config
    const dynamicEntry = createDynamicEntry("env-test");
    await testAdapter.add(dynamicEntry);

    // Request without providing required env var
    const res = await mcpRoute.request("/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverIds: [dynamicEntry.id],
        env: {},
      }),
    });

    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Missing required env vars");
    expect(data.error).toContain(dynamicEntry.id);
    expect(data.error).toContain("DYNAMIC_KEY");
  });

  it("static entries win on ID collision with dynamic entries", async () => {
    // Use "time" server which has no required config
    const staticId = "time";

    // Try to add a dynamic entry with the same ID
    const collidingEntry: MCPServerMetadata = {
      ...createDynamicEntry("collision"),
      id: staticId,
      name: "Colliding Dynamic Server",
    };

    // This should succeed (dynamic storage allows it), but won't affect lookup
    // because static entries take precedence
    await testAdapter.add(collidingEntry);

    // Request the ID - should resolve to the static server, not the dynamic one
    // (we can't easily verify which one was used, but we can check it resolves)
    const res = await mcpRoute.request("/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverIds: [staticId],
        env: {}, // time server has no requiredConfig
      }),
    });

    // Should not be 400 for unknown server
    expect(res.status).not.toBe(400);
    if (res.status === 400) {
      const data = (await res.json()) as { error: string };
      expect(data.error).not.toContain("Unknown server IDs");
    }
  });

  it("resolves mixed static and dynamic server IDs in one request", async () => {
    // Add a dynamic entry
    const dynamicEntry = createDynamicEntry("mixed-test");
    await testAdapter.add(dynamicEntry);

    // Get a static server that requires no env vars (time server)
    const staticServerId = "time";

    // Request both servers
    const res = await mcpRoute.request("/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverIds: [staticServerId, dynamicEntry.id],
        env: { DYNAMIC_KEY: "test-value" },
      }),
    });

    // Should not be 400 for unknown server
    expect(res.status).not.toBe(400);
    if (res.status === 400) {
      const data = (await res.json()) as { error: string };
      expect(data.error).not.toContain("Unknown server IDs");
    }
  });
});

describe("POST /tools — custom servers", () => {
  it("resolves a custom stdio server with Link env refs and returns 200 with tools", async () => {
    const customId = "custom-stdio-echo";
    const customEntry = createCustomStdioEntry(customId);
    await testAdapter.add(customEntry);

    const res = await mcpRoute.request("/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverIds: [customId],
        env: { CUSTOM_TOKEN: "secret-value" },
      }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      tools: Array<{ name: string; description: string; inputSchema: unknown }>;
    };
    expect(data.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: `${customId}__test_tool`,
          description: `Test tool for ${customId}`,
        }),
      ]),
    );
  });

  it("resolves a custom http server with Link env refs and returns 200 with tools", async () => {
    const customId = "custom-http-local";
    const customEntry = createCustomHttpEntry(customId);
    await testAdapter.add(customEntry);

    const res = await mcpRoute.request("/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverIds: [customId],
        env: { API_KEY: "api-secret" },
      }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      tools: Array<{ name: string; description: string; inputSchema: unknown }>;
    };
    expect(data.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: `${customId}__test_tool`,
          description: `Test tool for ${customId}`,
        }),
      ]),
    );
  });
});
