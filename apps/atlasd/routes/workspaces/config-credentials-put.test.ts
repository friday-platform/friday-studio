/**
 * Integration tests for PUT /config/credentials/:path route.
 *
 * Tests credential update with Link validation:
 * - Path parsing and not found errors
 * - Link credential validation (credential_not_found, provider_mismatch)
 * - Successful update flow
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "@std/yaml";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createMergedConfig,
  createMockWorkspace,
  createTestApp,
  createTestConfig,
  type JsonBody,
  useTempDir,
} from "./config.test-fixtures.ts";

// Mock fetchLinkCredential to control Link responses
const mockFetchLinkCredential = vi.hoisted(() => vi.fn());
vi.mock("@atlas/core/mcp-registry/credential-resolver", () => ({
  fetchLinkCredential: mockFetchLinkCredential,
  LinkCredentialNotFoundError: class extends Error {
    override name = "LinkCredentialNotFoundError";
    constructor(public readonly credentialId: string) {
      super(`Credential '${credentialId}' not found`);
    }
  },
}));

describe("PUT /config/credentials/:path", () => {
  const getTestDir = useTempDir();

  beforeEach(() => {
    mockFetchLinkCredential.mockReset();
  });

  describe("validation errors", () => {
    test("returns 404 when workspace not found", async () => {
      const { app } = createTestApp({ workspace: null });

      const response = await app.request("/ws-unknown/config/credentials/mcp:github:TOKEN", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialId: "new-cred" }),
      });

      expect(response.status).toBe(404);
      const body = (await response.json()) as JsonBody;
      expect(body).toMatchObject({
        success: false,
        error: "not_found",
        entityType: "workspace",
        entityId: "ws-unknown",
      });
    });

    test("returns 404 for invalid path format (path not found in config)", async () => {
      // Invalid path format is treated as "path not found" because no credential exists at that path
      const testDir = getTestDir();
      const workspace = createMockWorkspace({ path: testDir });
      const config = createMergedConfig(createTestConfig());
      await writeFile(join(testDir, "workspace.yml"), stringify(config.workspace));
      const { app } = createTestApp({ workspace, config });

      const response = await app.request("/ws-test-id/config/credentials/invalid-path", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialId: "new-cred" }),
      });

      expect(response.status).toBe(404);
      const body = (await response.json()) as JsonBody;
      expect(body).toMatchObject({
        success: false,
        error: "not_found",
        entityType: "credential",
        entityId: "invalid-path",
      });
    });

    test("returns 404 when credential path not found in config", async () => {
      const testDir = getTestDir();
      const workspace = createMockWorkspace({ path: testDir });
      const config = createMergedConfig(createTestConfig());
      await writeFile(join(testDir, "workspace.yml"), stringify(config.workspace));
      const { app } = createTestApp({ workspace, config });

      const response = await app.request("/ws-test-id/config/credentials/mcp:github:TOKEN", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialId: "new-cred" }),
      });

      expect(response.status).toBe(404);
      const body = (await response.json()) as JsonBody;
      expect(body).toMatchObject({
        success: false,
        error: "not_found",
        entityType: "credential",
        entityId: "mcp:github:TOKEN",
      });
    });

    test("returns 400 for missing credentialId in body", async () => {
      const testDir = getTestDir();
      const workspace = createMockWorkspace({ path: testDir });
      const config = createMergedConfig(createTestConfig());
      await writeFile(join(testDir, "workspace.yml"), stringify(config.workspace));
      const { app } = createTestApp({ workspace, config });

      const response = await app.request("/ws-test-id/config/credentials/mcp:github:TOKEN", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as JsonBody;
      expect(body).toHaveProperty("success", false);
    });
  });

  describe("Link validation errors", () => {
    test("returns 400 credential_not_found when new credential does not exist in Link", async () => {
      const testDir = getTestDir();
      const workspace = createMockWorkspace({ path: testDir });
      const config = createMergedConfig(
        createTestConfig({
          tools: {
            mcp: {
              servers: {
                github: {
                  transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
                  env: { GITHUB_TOKEN: { from: "link", id: "old-cred", key: "access_token" } },
                },
              },
            },
          },
        }),
      );
      await writeFile(join(testDir, "workspace.yml"), stringify(config.workspace));
      const { app } = createTestApp({ workspace, config });

      // Mock Link to throw not found error
      const { LinkCredentialNotFoundError } = await import(
        "@atlas/core/mcp-registry/credential-resolver"
      );
      mockFetchLinkCredential.mockRejectedValue(new LinkCredentialNotFoundError("new-cred-id"));

      const response = await app.request("/ws-test-id/config/credentials/mcp:github:GITHUB_TOKEN", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialId: "new-cred-id" }),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as JsonBody;
      expect(body).toMatchObject({ error: "credential_not_found", credentialId: "new-cred-id" });
    });

    test("returns 400 provider_mismatch when providers differ (current has provider)", async () => {
      const testDir = getTestDir();
      const workspace = createMockWorkspace({ path: testDir });
      const config = createMergedConfig(
        createTestConfig({
          tools: {
            mcp: {
              servers: {
                github: {
                  transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
                  env: { GITHUB_TOKEN: { from: "link", provider: "github", key: "access_token" } },
                },
              },
            },
          },
        }),
      );
      await writeFile(join(testDir, "workspace.yml"), stringify(config.workspace));
      const { app } = createTestApp({ workspace, config });

      // Mock Link to return credential with different provider
      mockFetchLinkCredential.mockResolvedValue({
        id: "new-cred-id",
        provider: "gitlab",
        type: "oauth",
        secret: {},
      });

      const response = await app.request("/ws-test-id/config/credentials/mcp:github:GITHUB_TOKEN", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialId: "new-cred-id" }),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as JsonBody;
      expect(body).toMatchObject({ error: "provider_mismatch", expected: "github", got: "gitlab" });
    });

    test("returns 400 provider_mismatch when providers differ (fetches current from Link)", async () => {
      const testDir = getTestDir();
      const workspace = createMockWorkspace({ path: testDir });
      const config = createMergedConfig(
        createTestConfig({
          tools: {
            mcp: {
              servers: {
                github: {
                  transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
                  env: {
                    // Only has id, no provider - need to fetch from Link
                    GITHUB_TOKEN: { from: "link", id: "current-cred-id", key: "access_token" },
                  },
                },
              },
            },
          },
        }),
      );
      await writeFile(join(testDir, "workspace.yml"), stringify(config.workspace));
      const { app } = createTestApp({ workspace, config });

      // First call: fetch new credential (to validate it exists)
      // Second call: fetch current credential (to get its provider)
      mockFetchLinkCredential
        .mockResolvedValueOnce({ id: "new-cred-id", provider: "gitlab", type: "oauth", secret: {} })
        .mockResolvedValueOnce({
          id: "current-cred-id",
          provider: "github",
          type: "oauth",
          secret: {},
        });

      const response = await app.request("/ws-test-id/config/credentials/mcp:github:GITHUB_TOKEN", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialId: "new-cred-id" }),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as JsonBody;
      expect(body).toMatchObject({ error: "provider_mismatch", expected: "github", got: "gitlab" });

      // Verify both credentials were fetched
      expect(mockFetchLinkCredential).toHaveBeenCalledTimes(2);
    });
  });

  describe("success cases", () => {
    test("updates credential and returns ok:true when provider matches", async () => {
      const testDir = getTestDir();
      const workspace = createMockWorkspace({ path: testDir });
      const config = createMergedConfig(
        createTestConfig({
          tools: {
            mcp: {
              servers: {
                github: {
                  transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
                  env: { GITHUB_TOKEN: { from: "link", provider: "github", key: "access_token" } },
                },
              },
            },
          },
        }),
      );
      await writeFile(join(testDir, "workspace.yml"), stringify(config.workspace));
      const { app, destroyWorkspaceRuntime } = createTestApp({
        workspace,
        config,
        runtimeActive: true,
      });

      // Mock Link to return credential with matching provider
      mockFetchLinkCredential.mockResolvedValue({
        id: "new-cred-id",
        provider: "github",
        type: "oauth",
        secret: {},
      });

      const response = await app.request("/ws-test-id/config/credentials/mcp:github:GITHUB_TOKEN", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialId: "new-cred-id" }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as JsonBody;
      expect(body).toMatchObject({ ok: true });

      // Runtime is not eagerly destroyed; file watcher handles deferred reload
      expect(destroyWorkspaceRuntime).not.toHaveBeenCalled();
    });

    test("stores both id and provider in the written credential ref", async () => {
      const testDir = getTestDir();
      const workspace = createMockWorkspace({ path: testDir });
      const config = createMergedConfig(
        createTestConfig({
          tools: {
            mcp: {
              servers: {
                github: {
                  transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
                  env: { GITHUB_TOKEN: { from: "link", id: "old-cred", key: "access_token" } },
                },
              },
            },
          },
        }),
      );
      await writeFile(join(testDir, "workspace.yml"), stringify(config.workspace));
      const { app } = createTestApp({ workspace, config });

      mockFetchLinkCredential.mockResolvedValue({
        id: "new-cred-id",
        provider: "github",
        type: "oauth",
        secret: {},
      });

      const response = await app.request("/ws-test-id/config/credentials/mcp:github:GITHUB_TOKEN", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialId: "new-cred-id" }),
      });

      expect(response.status).toBe(200);

      // Read back the written YAML and verify the ref has both id and provider
      const saved = parse(await readFile(join(testDir, "workspace.yml"), "utf8"));
      expect(saved).toMatchObject({
        tools: {
          mcp: {
            servers: {
              github: {
                env: {
                  GITHUB_TOKEN: {
                    from: "link",
                    id: "new-cred-id",
                    provider: "github",
                    key: "access_token",
                  },
                },
              },
            },
          },
        },
      });
    });

    test("updates agent credential successfully", async () => {
      const testDir = getTestDir();
      const workspace = createMockWorkspace({ path: testDir });
      const config = createMergedConfig(
        createTestConfig({
          agents: {
            researcher: {
              type: "atlas",
              agent: "research-agent",
              description: "Research agent",
              prompt: "Do research",
              env: { SERPER_API_KEY: { from: "link", provider: "serper", key: "api_key" } },
            },
          },
        }),
      );
      await writeFile(join(testDir, "workspace.yml"), stringify(config.workspace));
      const { app } = createTestApp({ workspace, config });

      mockFetchLinkCredential.mockResolvedValue({
        id: "new-serper-cred",
        provider: "serper",
        type: "api_key",
        secret: {},
      });

      const response = await app.request(
        "/ws-test-id/config/credentials/agent:researcher:SERPER_API_KEY",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credentialId: "new-serper-cred" }),
        },
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as JsonBody;
      expect(body).toMatchObject({ ok: true });
    });

    test("succeeds when current credential ID no longer exists in Link", async () => {
      // When the current credential was deleted from Link, we skip provider validation
      // and just ensure the new credential exists
      const testDir = getTestDir();
      const workspace = createMockWorkspace({ path: testDir });
      const config = createMergedConfig(
        createTestConfig({
          tools: {
            mcp: {
              servers: {
                github: {
                  transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
                  env: {
                    GITHUB_TOKEN: { from: "link", id: "deleted-cred-id", key: "access_token" },
                  },
                },
              },
            },
          },
        }),
      );
      await writeFile(join(testDir, "workspace.yml"), stringify(config.workspace));
      const { app } = createTestApp({ workspace, config });

      const { LinkCredentialNotFoundError } = await import(
        "@atlas/core/mcp-registry/credential-resolver"
      );

      // First call: fetch new credential (success)
      // Second call: fetch current credential (not found - it was deleted)
      mockFetchLinkCredential
        .mockResolvedValueOnce({ id: "new-cred-id", provider: "github", type: "oauth", secret: {} })
        .mockRejectedValueOnce(new LinkCredentialNotFoundError("deleted-cred-id"));

      const response = await app.request("/ws-test-id/config/credentials/mcp:github:GITHUB_TOKEN", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialId: "new-cred-id" }),
      });

      // Should succeed - we skip provider validation when old credential is gone
      expect(response.status).toBe(200);
      const body = (await response.json()) as JsonBody;
      expect(body).toMatchObject({ ok: true });
    });
  });

  describe("system workspace protection", () => {
    test("returns 403 for system workspace", async () => {
      const workspace = createMockWorkspace({ metadata: { system: true } });
      const { app } = createTestApp({ workspace });

      const response = await app.request("/ws-test-id/config/credentials/mcp:github:TOKEN", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialId: "new-cred" }),
      });

      expect(response.status).toBe(403);
      const body = (await response.json()) as JsonBody;
      expect(body).toMatchObject({ error: "forbidden" });
    });
  });
});
