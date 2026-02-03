/**
 * Auth Middleware Tests
 * Tests JWT verification in dev and production modes
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { makeTempDir } from "@atlas/utils/temp.server";
import * as jose from "jose";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

type CryptoKey = globalThis.CryptoKey;

/** Helper to create a temp file (replaces Deno.makeTempFile) */
async function makeTempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "link-test-"));
  return join(dir, "key.pem");
}

import { FileSystemStorageAdapter } from "../src/adapters/filesystem-adapter.ts";
import { NoOpPlatformRouteRepository } from "../src/adapters/platform-route-repository.ts";
import { OAuthService } from "../src/oauth/service.ts";
import { registry } from "../src/providers/registry.ts";
import { CredentialSummarySchema } from "../src/types.ts";

/**
 * Helper to create a JWT with user_metadata.tempest_user_id claim using RSA key
 */
async function createTestJWT(userId: string, privateKey: CryptoKey): Promise<string> {
  return await new jose.SignJWT({ sub: userId, user_metadata: { tempest_user_id: userId } })
    .setProtectedHeader({ alg: "RS256" })
    .sign(privateKey);
}

/**
 * Helper to set up prod app with RSA key pair and env vars
 * Returns app instance with cleanup function
 */
async function setupProdAuthApp(
  storage: FileSystemStorageAdapter,
  oauthService: OAuthService,
  options: {
    /** Use simple RSA keypair (jose) instead of Web Crypto */
    useSimpleKey?: boolean;
  } = {},
) {
  let keyPair: CryptoKeyPair | { publicKey: CryptoKey; privateKey: CryptoKey };
  let publicKeyPem: string;

  if (options.useSimpleKey) {
    // Use jose.generateKeyPair for simpler scenarios
    const pair = await jose.generateKeyPair("RS256");
    keyPair = pair as { publicKey: CryptoKey; privateKey: CryptoKey };
    publicKeyPem = await jose.exportSPKI(pair.publicKey);
  } else {
    // Use Web Crypto for full control
    keyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );

    const publicKeySpki = await crypto.subtle.exportKey("spki", keyPair.publicKey);
    const base64Key = btoa(String.fromCharCode(...new Uint8Array(publicKeySpki)));
    const base64Lines = base64Key.match(/.{1,64}/g);
    if (!base64Lines) {
      throw new Error("Failed to encode public key to base64");
    }
    publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${base64Lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
  }

  const keyFile = await makeTempFile();
  await writeFile(keyFile, publicKeyPem, "utf-8");

  const originalKeyFile = process.env.LINK_JWT_PUBLIC_KEY_FILE;
  const originalKvPath = process.env.LINK_KV_PATH;
  const originalDevMode = process.env.LINK_DEV_MODE;

  process.env.LINK_JWT_PUBLIC_KEY_FILE = keyFile;
  process.env.LINK_KV_PATH = ":memory:";
  // Keep LINK_DEV_MODE=true during import so module-level createPlatformRouteRepo() works
  process.env.LINK_DEV_MODE = "true";

  vi.resetModules();
  const { createApp: createAppFresh } = await import("../src/index.ts");

  // Now delete LINK_DEV_MODE so createApp's readConfig() sees devMode=false and enables JWT
  delete process.env.LINK_DEV_MODE;
  const app = await createAppFresh(storage, oauthService, new NoOpPlatformRouteRepository());

  return {
    app,
    keyPair,
    cleanup: async () => {
      await rm(keyFile);
      if (originalKeyFile) process.env.LINK_JWT_PUBLIC_KEY_FILE = originalKeyFile;
      else delete process.env.LINK_JWT_PUBLIC_KEY_FILE;
      if (originalKvPath) process.env.LINK_KV_PATH = originalKvPath;
      else delete process.env.LINK_KV_PATH;
      if (originalDevMode) process.env.LINK_DEV_MODE = originalDevMode;
    },
  };
}

describe("auth middleware", () => {
  // Use temp directory for testing
  const tempDir = makeTempDir();
  const storage = new FileSystemStorageAdapter(tempDir);
  const oauthService = new OAuthService(registry, storage);

  it("dev mode: no secret = userId defaults to dev", async () => {
    // Save original env vars
    const originalKeyFile = process.env.LINK_JWT_PUBLIC_KEY_FILE;
    const originalKvPath = process.env.LINK_KV_PATH;

    // Unset LINK_JWT_PUBLIC_KEY_FILE to simulate dev mode
    delete process.env.LINK_JWT_PUBLIC_KEY_FILE;
    // Set LINK_KV_PATH so module can load
    process.env.LINK_KV_PATH = ":memory:";

    // Re-import to pick up env change
    vi.resetModules();
    const { createApp: createAppFresh } = await import("../src/index.ts");
    const devApp = await createAppFresh(storage, oauthService, new NoOpPlatformRouteRepository());

    // Request without header should succeed with userId=dev
    const res = await devApp.request("/v1/credentials/type/apikey", { method: "GET" });

    // Should succeed (200) because in dev mode, no auth required
    expect(res.status).toBe(200);

    // Restore env vars
    if (originalKeyFile) {
      process.env.LINK_JWT_PUBLIC_KEY_FILE = originalKeyFile;
    }
    if (originalKvPath) {
      process.env.LINK_KV_PATH = originalKvPath;
    } else {
      delete process.env.LINK_KV_PATH;
    }
  });

  it("prod mode: missing header = 401", async () => {
    const { app, cleanup } = await setupProdAuthApp(storage, oauthService, { useSimpleKey: true });

    // Request without header should return 401
    const res = await app.request("/v1/credentials/type/apikey", { method: "GET" });

    expect(res.status).toBe(401);
    // Hono JWT middleware returns plain text "Unauthorized", not JSON
    expect(await res.text()).toBe("Unauthorized");

    await cleanup();
  });

  it("prod mode: invalid JWT = 401", async () => {
    const { app, cleanup } = await setupProdAuthApp(storage, oauthService, { useSimpleKey: true });

    // Request with invalid JWT should return 401
    const res = await app.request("/v1/credentials/type/apikey", {
      method: "GET",
      headers: { Authorization: "Bearer invalid.jwt.token" },
    });

    expect(res.status).toBe(401);
    // Hono JWT middleware returns plain text "Unauthorized", not JSON
    expect(await res.text()).toBe("Unauthorized");

    await cleanup();
  });

  it("prod mode: valid JWT with Authorization = userId extracted from JWT", async () => {
    const { app, keyPair, cleanup } = await setupProdAuthApp(storage, oauthService);

    // Create JWT with user_metadata.tempest_user_id claim using jose (which accepts CryptoKey)
    const userId = "test-user-123";
    const token = await createTestJWT(userId, keyPair.privateKey);

    // Request with Authorization header should succeed
    const res = await app.request("/v1/credentials/type/apikey", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);

    await cleanup();
  });

  it("prod mode: valid JWT with Authorization Bearer = userId extracted", async () => {
    const { app, keyPair, cleanup } = await setupProdAuthApp(storage, oauthService);

    // Create JWT with user_metadata.tempest_user_id claim using jose (which accepts CryptoKey)
    const userId = "test-user-456";
    const token = await createTestJWT(userId, keyPair.privateKey);

    // Request with Authorization header should succeed
    const res = await app.request("/v1/credentials/type/apikey", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);

    await cleanup();
  });

  it("health endpoint bypasses auth", async () => {
    const { app, cleanup } = await setupProdAuthApp(storage, oauthService, { useSimpleKey: true });

    // Health endpoint should work without auth even in prod mode
    const res = await app.request("/health", { method: "GET" });

    expect(res.status).toBe(200);
    const json = z.object({ status: z.string(), service: z.string() }).parse(await res.json());
    expect(json).toMatchObject({ status: "ok", service: "link" });

    await cleanup();
  });
});

/**
 * Tenancy Middleware Tests
 * Tests X-Atlas-User-ID header extraction edge cases for multi-tenant isolation
 */
describe("tenancy middleware", () => {
  // Use temp directory for testing
  const tempDir = makeTempDir();
  const storage = new FileSystemStorageAdapter(tempDir);
  const oauthService = new OAuthService(registry, storage);

  // Register test provider without health check
  const testProvider = {
    id: "test-tenancy",
    type: "apikey" as const,
    displayName: "Test Tenancy",
    description: "Test provider for tenancy tests",
    setupInstructions: "# Test",
    secretSchema: z.object({ token: z.string() }),
  };
  if (!registry.has(testProvider.id)) {
    registry.register(testProvider);
  }

  // Helper to generate valid JWT + keys for prod mode tests
  // Note: Uses shared storage instance so credentials persist across tests
  async function setupProdApp() {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );

    const publicKeySpki = await crypto.subtle.exportKey("spki", keyPair.publicKey);
    const base64Key = btoa(String.fromCharCode(...new Uint8Array(publicKeySpki)));
    const base64Lines = base64Key.match(/.{1,64}/g);
    if (!base64Lines) {
      throw new Error("Failed to encode public key to base64");
    }
    const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${base64Lines.join("\n")}\n-----END PUBLIC KEY-----\n`;

    const keyFile = await makeTempFile();
    await writeFile(keyFile, publicKeyPem, "utf-8");

    const originalKeyFile = process.env.LINK_JWT_PUBLIC_KEY_FILE;
    const originalKvPath = process.env.LINK_KV_PATH;
    const originalDevMode = process.env.LINK_DEV_MODE;

    process.env.LINK_JWT_PUBLIC_KEY_FILE = keyFile;
    process.env.LINK_KV_PATH = ":memory:";
    // Keep LINK_DEV_MODE=true during import so module-level createPlatformRouteRepo() works
    process.env.LINK_DEV_MODE = "true";

    vi.resetModules();
    const { createApp: createAppFresh } = await import("../src/index.ts");
    // Re-register test provider after module reset (registry is a singleton that gets cleared)
    const { registry: freshRegistry } = await import("../src/providers/registry.ts");
    if (!freshRegistry.has(testProvider.id)) {
      freshRegistry.register(testProvider);
    }

    // Now delete LINK_DEV_MODE so createApp's readConfig() sees devMode=false and enables JWT
    delete process.env.LINK_DEV_MODE;
    // IMPORTANT: Use same storage instance so credentials persist
    const app = await createAppFresh(storage, oauthService, new NoOpPlatformRouteRepository());

    return {
      app,
      keyPair,
      cleanup: async () => {
        await rm(keyFile);
        if (originalKeyFile) process.env.LINK_JWT_PUBLIC_KEY_FILE = originalKeyFile;
        else delete process.env.LINK_JWT_PUBLIC_KEY_FILE;
        if (originalKvPath) process.env.LINK_KV_PATH = originalKvPath;
        else delete process.env.LINK_KV_PATH;
        if (originalDevMode) process.env.LINK_DEV_MODE = originalDevMode;
      },
    };
  }

  it("prod: JWT missing tempest_user_id → 401 missing_user_id", async () => {
    const { app, keyPair, cleanup } = await setupProdApp();

    // Create JWT without user_metadata.tempest_user_id
    const token = await new jose.SignJWT({ sub: "test-user" })
      .setProtectedHeader({ alg: "RS256" })
      .sign(keyPair.privateKey);

    const res = await app.request("/v1/credentials/type/apikey", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing_user_id" });

    await cleanup();
  });

  it("dev: no X-Atlas-User-ID → falls back to userId=dev", async () => {
    const originalKeyFile = process.env.LINK_JWT_PUBLIC_KEY_FILE;
    const originalKvPath = process.env.LINK_KV_PATH;
    const originalDevMode = process.env.LINK_DEV_MODE;

    delete process.env.LINK_JWT_PUBLIC_KEY_FILE;
    process.env.LINK_KV_PATH = ":memory:";
    process.env.LINK_DEV_MODE = "true";

    vi.resetModules();
    const { createApp: createAppFresh } = await import("../src/index.ts");
    // Re-register test provider after module reset (registry is a singleton that gets cleared)
    const { registry: freshRegistry } = await import("../src/providers/registry.ts");
    if (!freshRegistry.has(testProvider.id)) {
      freshRegistry.register(testProvider);
    }
    // Use same storage instance so we can verify data persistence
    const devApp = await createAppFresh(storage, oauthService, new NoOpPlatformRouteRepository());

    // Create credential without X-Atlas-User-ID header
    const putRes = await devApp.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProvider.id,
        label: "dev-cred",
        secret: { token: "test-dev-123" },
      }),
    });

    expect(putRes.status).toBe(201);
    const created = CredentialSummarySchema.parse(await putRes.json());

    // Verify it's stored under userId "dev" by fetching directly from storage
    // (can't use list endpoint since different app instance)
    const storedCred = await storage.get(created.id, "dev");
    expect(storedCred).toMatchObject({ id: created.id, label: "dev-cred" });

    // Restore env
    if (originalKeyFile) process.env.LINK_JWT_PUBLIC_KEY_FILE = originalKeyFile;
    if (originalKvPath) process.env.LINK_KV_PATH = originalKvPath;
    else delete process.env.LINK_KV_PATH;
    if (originalDevMode) process.env.LINK_DEV_MODE = originalDevMode;
    else delete process.env.LINK_DEV_MODE;
  });

  it("special chars in user ID propagate correctly", async () => {
    const { app, keyPair, cleanup } = await setupProdApp();

    const testCases = [
      { userId: "550e8400-e29b-41d4-a716-446655440000", desc: "UUID" },
      { userId: "org/user", desc: "with slashes" },
      { userId: "user-123_456", desc: "with dashes/underscores" },
    ];

    for (const { userId, desc } of testCases) {
      // Create JWT with special userId in user_metadata
      const token = await createTestJWT(userId, keyPair.privateKey);

      // Create credential with special userId from JWT
      const putRes = await app.request("/v1/credentials/apikey", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: testProvider.id,
          label: `test-${desc}`,
          secret: { token: `test-${desc}` },
        }),
      });

      expect(putRes.status).toBe(201);
      const created = CredentialSummarySchema.parse(await putRes.json());

      // Verify credential is stored under correct userId by fetching from storage directly
      const storedCred = await storage.get(created.id, userId);
      expect(storedCred).toMatchObject({ id: created.id });

      // Verify tenant isolation - different userId should not see credential
      expect(await storage.get(created.id, "different-user")).toBeNull();
    }

    await cleanup();
  });
});
