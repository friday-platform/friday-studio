import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import { describe, expect, test } from "vitest";
import { mcpRoute } from "./mcp.ts";

/** Server shape returned by GET /servers. */
interface ServerEntry {
  id: string;
  name: string;
  description: string;
  transportType: string;
  requiredConfig: Array<{ key: string; description: string }>;
}

describe("GET /servers", () => {
  test("returns all registry servers with expected shape", async () => {
    const res = await mcpRoute.request("/servers");
    expect(res.status).toBe(200);

    const data = await res.json() as ServerEntry[];
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(Object.keys(mcpServersRegistry.servers).length);

    // Check shape of first entry
    const first = data[0];
    if (!first) throw new Error("expected at least one server");
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("name");
    expect(first).toHaveProperty("description");
    expect(first).toHaveProperty("transportType");
    expect(first).toHaveProperty("requiredConfig");
    expect(["stdio", "http"]).toContain(first.transportType);
  });

  test("github entry has correct metadata", async () => {
    const res = await mcpRoute.request("/servers");
    const data = await res.json() as ServerEntry[];
    const github = data.find((s) => s.id === "github");
    if (!github) throw new Error("expected github server");

    expect(github).toMatchObject({ id: "github", name: "GitHub", transportType: "http" });
    expect(github.requiredConfig).toContainEqual(expect.objectContaining({ key: "GH_TOKEN" }));
  });

  test("requiredConfig entries have key and description", async () => {
    const res = await mcpRoute.request("/servers");
    const data = await res.json() as ServerEntry[];
    const withConfig = data.filter((s) => s.requiredConfig.length > 0);

    expect(withConfig.length).toBeGreaterThan(0);
    for (const server of withConfig) {
      for (const field of server.requiredConfig) {
        expect(field).toHaveProperty("key");
        expect(field).toHaveProperty("description");
        expect(typeof field.key).toBe("string");
        expect(typeof field.description).toBe("string");
      }
    }
  });

  test("servers without requiredConfig return empty array", async () => {
    const res = await mcpRoute.request("/servers");
    const data = await res.json() as ServerEntry[];
    const playwright = data.find((s) => s.id === "playwright");
    if (!playwright) throw new Error("expected playwright server");

    expect(playwright.requiredConfig).toEqual([]);
  });
});

describe("POST /tools — validation", () => {
  test("rejects empty body", async () => {
    const res = await mcpRoute.request("/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("rejects missing serverIds", async () => {
    const res = await mcpRoute.request("/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: {} }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects empty serverIds array", async () => {
    const res = await mcpRoute.request("/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverIds: [], env: {} }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 for unknown server IDs", async () => {
    const res = await mcpRoute.request("/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverIds: ["nonexistent-server"], env: {} }),
    });
    expect(res.status).toBe(400);

    const data = await res.json() as { error: string };
    expect(data.error).toContain("nonexistent-server");
  });

  test("returns 400 when required env vars are missing", async () => {
    const res = await mcpRoute.request("/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverIds: ["github"], env: {} }),
    });
    expect(res.status).toBe(400);

    const data = await res.json() as { error: string };
    expect(data.error).toContain("GH_TOKEN");
    expect(data.error).toContain("github");
  });

  test("returns 400 listing all servers with missing env vars", async () => {
    const res = await mcpRoute.request("/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverIds: ["github", "stripe"], env: {} }),
    });
    expect(res.status).toBe(400);

    const data = await res.json() as { error: string };
    expect(data.error).toContain("github");
    expect(data.error).toContain("GH_TOKEN");
    expect(data.error).toContain("stripe");
    expect(data.error).toContain("STRIPE_SECRET_KEY");
  });

  test("passes validation when all required env vars provided", async () => {
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
    const data = await res.json() as Record<string, unknown>;
    if (res.status === 200) {
      expect(data).toHaveProperty("tools");
    } else {
      // Connection failure is expected in test env — but it's not a validation error
      expect(data).not.toHaveProperty("error", expect.stringContaining("Missing required"));
    }
  });

});
