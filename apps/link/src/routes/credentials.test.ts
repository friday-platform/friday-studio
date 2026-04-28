import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

async function makeTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "link-credentials-test-"));
}

import { FileSystemStorageAdapter } from "../adapters/filesystem-adapter.ts";
import { NoOpPlatformRouteRepository } from "../adapters/platform-route-repository.ts";
import { NoOpSlackAppWorkspaceRepository } from "../adapters/slack-app-workspace-repository.ts";
import { createApp } from "../index.ts";
import { OAuthService } from "../oauth/service.ts";
import { registry } from "../providers/registry.ts";

const testProvider = {
  id: "test-credentials-patch",
  type: "apikey" as const,
  displayName: "Test Patch Provider",
  description: "Provider for PATCH credential tests",
  setupInstructions: "# Test",
  secretSchema: z.object({ apiKey: z.string() }),
};

const testOAuthProvider = {
  id: "test-credentials-oauth",
  type: "oauth" as const,
  displayName: "Test OAuth Provider",
  description: "OAuth provider for PATCH credential tests",
  oauthConfig: {
    mode: "static" as const,
    authorizationEndpoint: "https://example.com/oauth/authorize",
    tokenEndpoint: "https://example.com/oauth/token",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    scopes: ["read"],
  },
  // deno-lint-ignore require-await
  identify: async () => "test-user",
};

describe("PATCH /v1/credentials/:id", () => {
  let tempDir: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  let storage: FileSystemStorageAdapter;
  const userId = "dev";

  beforeAll(async () => {
    tempDir = await makeTempDir();
    storage = new FileSystemStorageAdapter(tempDir);
    const oauthService = new OAuthService(registry, storage);
    app = await createApp(
      storage,
      oauthService,
      new NoOpPlatformRouteRepository(),
      new NoOpSlackAppWorkspaceRepository(),
    );

    if (!registry.has(testProvider.id)) {
      registry.register(testProvider);
    }
    if (!registry.has(testOAuthProvider.id)) {
      registry.register(testOAuthProvider);
    }
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true });
  });

  const CredentialResponseSchema = z.object({
    id: z.string(),
    label: z.string().optional(),
    displayName: z.string().optional(),
  });

  async function createApiKeyCredential(secret: Record<string, string>) {
    const res = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: testProvider.id, label: "Test Credential", secret }),
    });
    expect(res.status).toEqual(201);
    return CredentialResponseSchema.parse(await res.json());
  }

  it("updates secret only — 200, id unchanged", async () => {
    const created = await createApiKeyCredential({ apiKey: "old-key" });
    const originalId = created.id;

    const res = await app.request(`/v1/credentials/${originalId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: { apiKey: "new-key" } }),
    });

    expect(res.status).toEqual(200);
    const updated = CredentialResponseSchema.parse(await res.json());
    expect(updated.id).toEqual(originalId);
    expect(updated.label).toEqual("Test Credential");
  });

  it("updates both displayName and secret — 200", async () => {
    const created = await createApiKeyCredential({ apiKey: "key-123" });

    const res = await app.request(`/v1/credentials/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Renamed Credential", secret: { apiKey: "key-456" } }),
    });

    expect(res.status).toEqual(200);
    const updated = CredentialResponseSchema.parse(await res.json());
    expect(updated.displayName).toEqual("Renamed Credential");
  });

  it("rejects invalid secret — 400", async () => {
    const created = await createApiKeyCredential({ apiKey: "valid-key" });

    const res = await app.request(`/v1/credentials/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: { wrongField: "value" } }),
    });

    expect(res.status).toEqual(400);
    const body = z.object({ error: z.string() }).parse(await res.json());
    expect(body.error).toEqual("validation_failed");
  });

  it("rejects request with neither displayName nor secret — 400", async () => {
    const created = await createApiKeyCredential({ apiKey: "key" });

    const res = await app.request(`/v1/credentials/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toEqual(400);
  });

  it("returns 404 for non-existent credential", async () => {
    const res = await app.request("/v1/credentials/nonexistent-cred-id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: { apiKey: "x" } }),
    });

    expect(res.status).toEqual(404);
  });

  it("rejects secret replacement for OAuth providers — 400", async () => {
    // Create an oauth credential directly via storage
    const saved = await storage.save(
      {
        type: "oauth",
        provider: testOAuthProvider.id,
        userIdentifier: "test-user",
        label: "Test OAuth",
        secret: { access_token: "token123" },
      },
      userId,
    );

    const res = await app.request(`/v1/credentials/${saved.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: { access_token: "new-token" } }),
    });

    expect(res.status).toEqual(400);
    const body = z.object({ error: z.string() }).parse(await res.json());
    expect(body.error).toEqual("invalid_provider_type");
  });
});
