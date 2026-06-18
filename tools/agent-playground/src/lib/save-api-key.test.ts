import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveApiKeyForPlatform, type CatalogEntry } from "./save-api-key.ts";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const catalogAfterSave: CatalogEntry[] = [
  {
    provider: "anthropic",
    credentialConfigured: true,
    credentialEnvVar: "ANTHROPIC_API_KEY",
    meta: { name: "Anthropic", letter: "A", keyPrefix: "sk-ant-", helpUrl: null },
    models: [{ id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" }],
    images: [],
  },
];

describe("saveApiKeyForPlatform", () => {
  let fetchSpy: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchSpy = vi.fn<typeof fetch>();
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("reads latest env, splices the new key, PUTs the merged map, returns fresh catalog", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ envVars: { OPENAI_API_KEY: "sk-old", OTHER: "x" } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ entries: catalogAfterSave }));

    const result = await saveApiKeyForPlatform("ANTHROPIC_API_KEY", "sk-ant-new");

    expect(result).toEqual(catalogAfterSave);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[0]).toEqual(["/api/daemon/api/config/env"]);

    const putCall = fetchSpy.mock.calls[1];
    expect(putCall?.[0]).toBe("/api/daemon/api/config/env");
    const init = putCall?.[1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      envVars: {
        OPENAI_API_KEY: "sk-old",
        OTHER: "x",
        ANTHROPIC_API_KEY: "sk-ant-new",
      },
    });

    expect(fetchSpy.mock.calls[2]).toEqual(["/api/daemon/api/config/models/catalog"]);
  });

  it("treats a missing envVars body as empty before splicing", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ entries: catalogAfterSave }));

    await saveApiKeyForPlatform("ANTHROPIC_API_KEY", "sk-ant-new");

    const putCall = fetchSpy.mock.calls[1];
    const init = putCall?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      envVars: { ANTHROPIC_API_KEY: "sk-ant-new" },
    });
  });

  it("throws with body text when the PUT fails", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ envVars: {} }))
      .mockResolvedValueOnce(new Response("write denied", { status: 500 }));

    await expect(
      saveApiKeyForPlatform("ANTHROPIC_API_KEY", "sk-ant-new"),
    ).rejects.toThrow(/HTTP 500.*write denied/);
  });

  it("throws when initial env load returns non-2xx", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 503 }));

    await expect(
      saveApiKeyForPlatform("ANTHROPIC_API_KEY", "sk-ant-new"),
    ).rejects.toThrow(/HTTP 503/);
  });
});
