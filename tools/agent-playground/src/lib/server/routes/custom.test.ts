import { describe, expect, test } from "vitest";
import { customExecuteRoute } from "./custom.ts";

/** Valid request body for custom execute. */
function validBody(overrides?: Record<string, unknown>) {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250514",
    systemPrompt: "You are a helpful assistant.",
    input: "Hello",
    mcpServerIds: [],
    env: {},
    ...overrides,
  };
}

/** Make a POST request to the custom execute route. */
function post(body: unknown) {
  return customExecuteRoute.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /custom/execute — validation", () => {
  test("rejects empty body", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
  });

  test("rejects missing provider", async () => {
    const { provider: _, ...body } = validBody();
    const res = await post(body);
    expect(res.status).toBe(400);
  });

  test("rejects invalid provider", async () => {
    const res = await post(validBody({ provider: "invalid-llm" }));
    expect(res.status).toBe(400);
  });

  test("rejects empty model", async () => {
    const res = await post(validBody({ model: "" }));
    expect(res.status).toBe(400);
  });

  test("rejects empty input", async () => {
    const res = await post(validBody({ input: "" }));
    expect(res.status).toBe(400);
  });

  test("rejects maxSteps below 1", async () => {
    const res = await post(validBody({ maxSteps: 0 }));
    expect(res.status).toBe(400);
  });

  test("rejects maxSteps above 100", async () => {
    const res = await post(validBody({ maxSteps: 101 }));
    expect(res.status).toBe(400);
  });

  test("rejects non-integer maxSteps", async () => {
    const res = await post(validBody({ maxSteps: 5.5 }));
    expect(res.status).toBe(400);
  });
});

describe("POST /custom/execute — server validation", () => {
  test("returns 400 for unknown server IDs", async () => {
    const res = await post(validBody({ mcpServerIds: ["nonexistent-server"] }));
    expect(res.status).toBe(400);

    const data = await res.json() as { error: string };
    expect(data.error).toContain("nonexistent-server");
  });

  test("returns 400 when required env vars are missing", async () => {
    const res = await post(validBody({ mcpServerIds: ["github"], env: {} }));
    expect(res.status).toBe(400);

    const data = await res.json() as { error: string };
    expect(data.error).toContain("GH_TOKEN");
    expect(data.error).toContain("github");
  });

  test("returns 400 listing all servers with missing env vars", async () => {
    const res = await post(validBody({ mcpServerIds: ["github", "stripe"], env: {} }));
    expect(res.status).toBe(400);

    const data = await res.json() as { error: string };
    expect(data.error).toContain("github");
    expect(data.error).toContain("GH_TOKEN");
    expect(data.error).toContain("stripe");
    expect(data.error).toContain("STRIPE_SECRET_KEY");
  });

  test("accepts empty mcpServerIds array", async () => {
    // Empty serverIds is valid — means no MCP tools, just raw LLM
    // This will proceed to SSE stream (which will fail at LLM call in test env)
    const res = await post(validBody({ mcpServerIds: [] }));
    // Should NOT be a 400 validation error
    expect(res.status).not.toBe(400);
  });
});
