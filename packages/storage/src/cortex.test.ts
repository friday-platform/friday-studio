/**
 * Tests for workspace config history storage to Cortex
 */

import process from "node:process";
import type { WorkspaceConfig } from "@atlas/config";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { storeToCortex, storeWorkspaceHistory, type WorkspaceHistoryInput } from "./cortex.ts";

function createMinimalConfig(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    version: "1.0",
    workspace: { id: "test-workspace", name: "Test Workspace" },
    ...overrides,
  };
}

function createWorkspace(overrides: Partial<WorkspaceHistoryInput> = {}): WorkspaceHistoryInput {
  return { id: "test-workspace-id", ...overrides };
}

// Mock fetch globally
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  vi.clearAllMocks();
  // Reset env vars
  delete process.env.CORTEX_URL;
  delete process.env.ATLAS_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("storeToCortex", () => {
  const baseUrl = "https://cortex.example.com";

  beforeEach(() => {
    process.env.ATLAS_KEY = "test-api-key";
  });

  test("returns cortex object ID on success", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "cortex-object-123" }) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve("") }); // Empty body like real Cortex

    const id = await storeToCortex(
      baseUrl,
      { foo: "bar" },
      {
        workspace_id: "ws-123",
        type: "workspace-config" as const,
        schema_version: 1 as const,
        source: "partial-update" as const,
        created_at: "2024-01-01T00:00:00.000Z",
      },
    );

    expect(id).toBe("cortex-object-123");
  });

  test("uses correct endpoint and auth header", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "obj-1" }) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve("") });

    await storeToCortex(
      baseUrl,
      { test: true },
      {
        workspace_id: "ws",
        type: "workspace-config",
        schema_version: 1,
        source: "full-update",
        created_at: new Date().toISOString(),
      },
    );

    // Contract verification: correct endpoint and auth for content POST
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "https://cortex.example.com/objects",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-api-key" }),
      }),
    );

    // Contract verification: correct endpoint and auth for metadata POST
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "https://cortex.example.com/objects/obj-1/metadata",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-api-key" }),
      }),
    );
  });

  test("normalizes baseUrl with trailing slashes", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "obj-1" }) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve("") });

    await storeToCortex(
      "https://cortex.example.com///",
      { test: true },
      {
        workspace_id: "ws",
        type: "workspace-config",
        schema_version: 1,
        source: "full-update",
        created_at: new Date().toISOString(),
      },
    );

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "https://cortex.example.com/objects",
      expect.anything(),
    );
  });

  test("throws when ATLAS_KEY not set", async () => {
    delete process.env.ATLAS_KEY;

    await expect(
      storeToCortex(
        baseUrl,
        { data: "test" },
        {
          workspace_id: "ws",
          type: "workspace-config",
          schema_version: 1,
          source: "partial-update",
          created_at: new Date().toISOString(),
        },
      ),
    ).rejects.toThrow("ATLAS_KEY not available for Cortex authentication");
  });

  test("throws on storage HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    await expect(
      storeToCortex(
        baseUrl,
        { data: "test" },
        {
          workspace_id: "ws",
          type: "workspace-config",
          schema_version: 1,
          source: "partial-update",
          created_at: new Date().toISOString(),
        },
      ),
    ).rejects.toThrow("Cortex store failed: 500 Internal Server Error");
  });

  test("throws on metadata HTTP error and rolls back orphaned object", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "orphan-123" }) })
      .mockResolvedValueOnce({ ok: false, status: 403, text: () => Promise.resolve("Forbidden") })
      .mockResolvedValueOnce({ ok: true }); // DELETE for rollback

    await expect(
      storeToCortex(
        baseUrl,
        { data: "test" },
        {
          workspace_id: "ws",
          type: "workspace-config",
          schema_version: 1,
          source: "partial-update",
          created_at: new Date().toISOString(),
        },
      ),
    ).rejects.toThrow("Cortex metadata update failed: 403 Forbidden");

    // Verify rollback DELETE was called
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      "https://cortex.example.com/objects/orphan-123",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  test("still throws on metadata error even if rollback fails", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "orphan-456" }) })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Server Error"),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 }); // DELETE fails

    await expect(
      storeToCortex(
        baseUrl,
        { data: "test" },
        {
          workspace_id: "ws",
          type: "workspace-config",
          schema_version: 1,
          source: "partial-update",
          created_at: new Date().toISOString(),
        },
      ),
    ).rejects.toThrow("Cortex metadata update failed: 500 Server Error");

    // Rollback was attempted even though it failed
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  test("accepts metadata response with JSON body", async () => {
    // Cortex currently returns empty 200, but if it adds fields later we should handle them
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "obj-1" }) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('{"updated": true}') });

    const id = await storeToCortex(
      baseUrl,
      { data: "test" },
      {
        workspace_id: "ws",
        type: "workspace-config",
        schema_version: 1,
        source: "partial-update",
        created_at: new Date().toISOString(),
      },
    );

    expect(id).toBe("obj-1");
  });
});

describe("storeWorkspaceHistory", () => {
  beforeEach(() => {
    process.env.CORTEX_URL = "https://cortex.example.com";
    process.env.ATLAS_KEY = "test-api-key";
  });

  test("stores config for non-system workspace", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "obj-123" }) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve("") });

    const workspace = createWorkspace({ id: "user-workspace" });
    const config = createMinimalConfig();

    // Behavioral outcome: completes without error
    await expect(
      storeWorkspaceHistory(workspace, config, "partial-update"),
    ).resolves.toBeUndefined();
    // Verify storage was attempted (not implementation details of what was sent)
    expect(mockFetch).toHaveBeenCalled();
  });

  test("skips system workspaces", async () => {
    const workspace = createWorkspace({ id: "system-workspace", metadata: { system: true } });
    const config = createMinimalConfig();

    await storeWorkspaceHistory(workspace, config, "full-update");

    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("skips when CORTEX_URL not configured", async () => {
    delete process.env.CORTEX_URL;

    const workspace = createWorkspace();
    const config = createMinimalConfig();

    await storeWorkspaceHistory(workspace, config, "partial-update");

    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("catches errors without throwing (default behavior)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network failure"));

    const workspace = createWorkspace();
    const config = createMinimalConfig();

    // Behavioral outcome: function swallows errors gracefully
    await expect(
      storeWorkspaceHistory(workspace, config, "partial-update"),
    ).resolves.toBeUndefined();
  });

  test("throws when throwOnError option is true", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network failure"));

    const workspace = createWorkspace();
    const config = createMinimalConfig();

    // Behavioral outcome: function re-throws error for caller to handle
    await expect(
      storeWorkspaceHistory(workspace, config, "partial-update", { throwOnError: true }),
    ).rejects.toThrow("Network failure");
  });
});
