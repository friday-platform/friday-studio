import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DynamicProviderInput } from "../types.ts";
import { CortexProviderStorageAdapter } from "./cortex-adapter.ts";

const testProvider: DynamicProviderInput = {
  type: "apikey",
  id: "test-provider",
  displayName: "Test Provider",
  description: "A test provider",
  secretSchema: { api_key: "string" },
};

describe("CortexProviderStorageAdapter", () => {
  let originalFetch: typeof globalThis.fetch;
  let captured: { url: string; method: string; headers: Headers; body: string | null }[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    captured = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(responses: Array<{ body: unknown; status?: number }>) {
    let callIndex = 0;
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        url: input.toString(),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : null,
      });
      if (callIndex >= responses.length) {
        throw new Error(`Unexpected fetch call #${callIndex + 1}: ${input.toString()}`);
      }
      const res = responses[callIndex++] ?? { body: {}, status: 200 };
      return Promise.resolve(new Response(JSON.stringify(res.body), { status: res.status ?? 200 }));
    };
  }

  it("calls getAuthToken on each request, not at construction time", async () => {
    const tokens = ["token-1", "token-2"];
    let callCount = 0;
    const getAuthToken = vi.fn(() => tokens[callCount++] ?? "fallback");

    stubFetch([{ body: { objects: [] } }, { body: { objects: [] } }]);

    const adapter = new CortexProviderStorageAdapter("https://cortex.test", getAuthToken);

    expect(getAuthToken).not.toHaveBeenCalled();

    await adapter.list();
    expect(captured[0]?.headers.get("Authorization")).toBe("Bearer token-1");

    await adapter.list();
    expect(captured[1]?.headers.get("Authorization")).toBe("Bearer token-2");

    expect(getAuthToken).toHaveBeenCalledTimes(2);
  });

  it("throws when auth token is empty", async () => {
    const adapter = new CortexProviderStorageAdapter("https://cortex.test", () => "");

    await expect(adapter.list()).rejects.toThrow("missing auth token");
  });

  describe("add()", () => {
    it("creates object and sets metadata", async () => {
      stubFetch([
        // findObjectByProviderId: no existing provider
        { body: { objects: [] } },
        // POST /objects: create
        { body: { id: "obj-123" } },
        // POST /objects/obj-123/metadata: set metadata
        { body: {} },
      ]);

      const adapter = new CortexProviderStorageAdapter("https://cortex.test", () => "test-token");
      await adapter.add(testProvider);

      // All 3 requests got the auth header
      for (const req of captured) {
        expect(req.headers.get("Authorization")).toBe("Bearer test-token");
      }

      expect(captured[1]).toMatchObject({ method: "POST", url: "https://cortex.test/objects" });
      expect(captured[2]).toMatchObject({
        method: "POST",
        url: "https://cortex.test/objects/obj-123/metadata",
      });
      expect(JSON.parse(captured[2]?.body ?? "{}")).toMatchObject({
        entity_type: "link_provider",
        provider_id: "test-provider",
        provider_type: "apikey",
      });
    });

    it("throws on duplicate provider", async () => {
      stubFetch([
        // findObjectByProviderId: existing provider found
        { body: { objects: [{ id: "existing-obj" }] } },
      ]);

      const adapter = new CortexProviderStorageAdapter("https://cortex.test", () => "test-token");
      await expect(adapter.add(testProvider)).rejects.toThrow(
        "Provider already exists: test-provider",
      );

      // Only 1 fetch — no unnecessary content fetch
      expect(captured).toHaveLength(1);
    });

    it("cleans up object when metadata POST fails", async () => {
      stubFetch([
        // findObjectByProviderId: no existing provider
        { body: { objects: [] } },
        // POST /objects: create succeeds
        { body: { id: "obj-456" } },
        // POST metadata: fails
        { body: {}, status: 500 },
        // DELETE cleanup
        { body: {} },
      ]);

      const adapter = new CortexProviderStorageAdapter("https://cortex.test", () => "test-token");
      await expect(adapter.add(testProvider)).rejects.toThrow("Failed to set metadata: 500");

      expect(captured[3]).toMatchObject({
        method: "DELETE",
        url: "https://cortex.test/objects/obj-456",
      });
    });

    it("creates provider when duplicate check fails transiently", async () => {
      stubFetch([
        // findObjectByProviderId: list request fails (transient)
        { body: {}, status: 503 },
        // POST /objects: create succeeds
        { body: { id: "obj-new" } },
        // POST metadata: succeeds
        { body: {} },
      ]);

      const adapter = new CortexProviderStorageAdapter("https://cortex.test", () => "test-token");
      await adapter.add(testProvider);

      expect(captured).toHaveLength(3);
      expect(captured[1]).toMatchObject({ method: "POST", url: "https://cortex.test/objects" });
    });

    it("throws when create POST fails", async () => {
      stubFetch([
        // findObjectByProviderId: no existing provider
        { body: { objects: [] } },
        // POST /objects: fails
        { body: {}, status: 503 },
      ]);

      const adapter = new CortexProviderStorageAdapter("https://cortex.test", () => "test-token");
      await expect(adapter.add(testProvider)).rejects.toThrow("Failed to create object: 503");
    });
  });

  describe("get()", () => {
    it("returns null when provider not found", async () => {
      stubFetch([{ body: { objects: [] } }]);

      const adapter = new CortexProviderStorageAdapter("https://cortex.test", () => "test-token");
      expect(await adapter.get("nonexistent")).toBeNull();
    });

    it("returns parsed provider when found", async () => {
      stubFetch([{ body: { objects: [{ id: "obj-1" }] } }, { body: testProvider }]);

      const adapter = new CortexProviderStorageAdapter("https://cortex.test", () => "test-token");
      const result = await adapter.get("test-provider");
      expect(result).toEqual(testProvider);
    });

    it("returns null when content is corrupt", async () => {
      stubFetch([{ body: { objects: [{ id: "obj-1" }] } }, { body: { garbage: true } }]);

      const adapter = new CortexProviderStorageAdapter("https://cortex.test", () => "test-token");
      expect(await adapter.get("test-provider")).toBeNull();
    });

    it("returns null when content fetch fails", async () => {
      stubFetch([{ body: { objects: [{ id: "obj-1" }] } }, { body: {}, status: 500 }]);

      const adapter = new CortexProviderStorageAdapter("https://cortex.test", () => "test-token");
      expect(await adapter.get("test-provider")).toBeNull();
    });
  });

  describe("delete()", () => {
    it("returns false when provider not found", async () => {
      stubFetch([{ body: { objects: [] } }]);

      const adapter = new CortexProviderStorageAdapter("https://cortex.test", () => "test-token");
      expect(await adapter.delete("nonexistent")).toBe(false);
    });

    it("returns false when DELETE request fails", async () => {
      stubFetch([{ body: { objects: [{ id: "obj-1" }] } }, { body: {}, status: 500 }]);

      const adapter = new CortexProviderStorageAdapter("https://cortex.test", () => "test-token");
      expect(await adapter.delete("test-provider")).toBe(false);
    });

    it("returns true after successful deletion", async () => {
      stubFetch([{ body: { objects: [{ id: "obj-1" }] } }, { body: {} }]);

      const adapter = new CortexProviderStorageAdapter("https://cortex.test", () => "test-token");
      expect(await adapter.delete("test-provider")).toBe(true);
      expect(captured[1]).toMatchObject({
        method: "DELETE",
        url: "https://cortex.test/objects/obj-1",
      });
    });
  });

  describe("list()", () => {
    it("returns all providers", async () => {
      const provider2 = { ...testProvider, id: "test-provider-2" };
      stubFetch([
        { body: { objects: [{ id: "obj-1" }, { id: "obj-2" }] } },
        { body: testProvider },
        { body: provider2 },
      ]);

      const adapter = new CortexProviderStorageAdapter("https://cortex.test", () => "test-token");
      const result = await adapter.list();
      expect(result).toMatchObject([{ id: "test-provider" }, { id: "test-provider-2" }]);
    });

    it("skips entries when fetch fails", async () => {
      stubFetch([
        { body: { objects: [{ id: "obj-1" }, { id: "obj-2" }] } },
        { body: testProvider },
        { body: {}, status: 500 },
      ]);

      const adapter = new CortexProviderStorageAdapter("https://cortex.test", () => "test-token");
      const result = await adapter.list();
      expect(result).toMatchObject([{ id: "test-provider" }]);
    });

    it("skips corrupt entries", async () => {
      stubFetch([
        { body: { objects: [{ id: "obj-1" }, { id: "obj-2" }] } },
        { body: testProvider },
        { body: { garbage: true } },
      ]);

      const adapter = new CortexProviderStorageAdapter("https://cortex.test", () => "test-token");
      const result = await adapter.list();
      expect(result).toMatchObject([{ id: "test-provider" }]);
    });

    it("returns empty array when list request fails", async () => {
      stubFetch([{ body: {}, status: 503 }]);

      const adapter = new CortexProviderStorageAdapter("https://cortex.test", () => "test-token");
      expect(await adapter.list()).toHaveLength(0);
    });
  });
});
