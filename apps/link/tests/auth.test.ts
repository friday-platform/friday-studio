/**
 * Auth Middleware Tests
 * Tests JWT verification in dev and production modes
 */

import process from "node:process";
import { assertEquals, assertExists, assertStrictEquals } from "@std/assert";
import * as jose from "jose";
import { z } from "zod";

type CryptoKey = globalThis.CryptoKey;

import { DenoKVStorageAdapter } from "../src/adapters/deno-kv-adapter.ts";
import { OAuthService } from "../src/oauth/service.ts";
import { registry } from "../src/providers/registry.ts";

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
  storage: DenoKVStorageAdapter,
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

  const keyFile = await Deno.makeTempFile();
  await Deno.writeTextFile(keyFile, publicKeyPem);

  const originalKeyFile = process.env.LINK_JWT_PUBLIC_KEY_FILE;
  const originalKvPath = process.env.LINK_KV_PATH;
  const originalDevMode = process.env.LINK_DEV_MODE;

  process.env.LINK_JWT_PUBLIC_KEY_FILE = keyFile;
  process.env.LINK_KV_PATH = ":memory:";
  delete process.env.LINK_DEV_MODE;

  const { createApp: createAppFresh } = await import(`../src/index.ts?t=${Date.now()}`);
  const app = await createAppFresh(storage, oauthService);

  return {
    app,
    keyPair,
    cleanup: async () => {
      await Deno.remove(keyFile);
      if (originalKeyFile) process.env.LINK_JWT_PUBLIC_KEY_FILE = originalKeyFile;
      else delete process.env.LINK_JWT_PUBLIC_KEY_FILE;
      if (originalKvPath) process.env.LINK_KV_PATH = originalKvPath;
      else delete process.env.LINK_KV_PATH;
      if (originalDevMode) process.env.LINK_DEV_MODE = originalDevMode;
    },
  };
}

Deno.test(
  {
    name: "auth middleware",
    // Disable sanitizers - dynamic imports create KV connections and async ops that are hard to track
    sanitizeResources: false,
    sanitizeOps: false,
  },
  async (t) => {
    // Use in-memory KV for testing
    const storage = new DenoKVStorageAdapter(":memory:");
    const oauthService = new OAuthService(registry, storage);

    await t.step("dev mode: no secret = userId defaults to dev", async () => {
      // Save original env vars
      const originalKeyFile = process.env.LINK_JWT_PUBLIC_KEY_FILE;
      const originalKvPath = process.env.LINK_KV_PATH;

      // Unset LINK_JWT_PUBLIC_KEY_FILE to simulate dev mode
      delete process.env.LINK_JWT_PUBLIC_KEY_FILE;
      // Set LINK_KV_PATH so module can load
      process.env.LINK_KV_PATH = ":memory:";

      // Re-import to pick up env change - use dynamic import with timestamp to bust cache
      const { createApp: createAppFresh } = await import(`../src/index.ts?t=${Date.now()}`);
      const devApp = await createAppFresh(storage, oauthService);

      // Request without header should succeed with userId=dev
      const res = await devApp.request("/v1/credentials/type/apikey", { method: "GET" });

      // Should succeed (200) because in dev mode, no auth required
      assertEquals(res.status, 200);

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

    await t.step("prod mode: missing header = 401", async () => {
      const { app, cleanup } = await setupProdAuthApp(storage, oauthService, {
        useSimpleKey: true,
      });

      // Request without header should return 401
      const res = await app.request("/v1/credentials/type/apikey", { method: "GET" });

      assertEquals(res.status, 401);
      // Hono JWT middleware returns plain text "Unauthorized", not JSON
      const text = await res.text();
      assertEquals(text, "Unauthorized");

      await cleanup();
    });

    await t.step("prod mode: invalid JWT = 401", async () => {
      const { app, cleanup } = await setupProdAuthApp(storage, oauthService, {
        useSimpleKey: true,
      });

      // Request with invalid JWT should return 401
      const res = await app.request("/v1/credentials/type/apikey", {
        method: "GET",
        headers: { Authorization: "Bearer invalid.jwt.token" },
      });

      assertEquals(res.status, 401);
      // Hono JWT middleware returns plain text "Unauthorized", not JSON
      const text = await res.text();
      assertEquals(text, "Unauthorized");

      await cleanup();
    });

    await t.step(
      "prod mode: valid JWT with Authorization = userId extracted from JWT",
      async () => {
        const { app, keyPair, cleanup } = await setupProdAuthApp(storage, oauthService);

        // Create JWT with user_metadata.tempest_user_id claim using jose (which accepts CryptoKey)
        const userId = "test-user-123";
        const token = await createTestJWT(userId, keyPair.privateKey);

        // Request with Authorization header should succeed
        const res = await app.request("/v1/credentials/type/apikey", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });

        // Should succeed (200)
        assertEquals(res.status, 200);

        await cleanup();
      },
    );

    await t.step("prod mode: valid JWT with Authorization Bearer = userId extracted", async () => {
      const { app, keyPair, cleanup } = await setupProdAuthApp(storage, oauthService);

      // Create JWT with user_metadata.tempest_user_id claim using jose (which accepts CryptoKey)
      const userId = "test-user-456";
      const token = await createTestJWT(userId, keyPair.privateKey);

      // Request with Authorization header should succeed
      const res = await app.request("/v1/credentials/type/apikey", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });

      // Should succeed (200)
      assertEquals(res.status, 200);

      await cleanup();
    });

    await t.step("health endpoint bypasses auth", async () => {
      const { app, cleanup } = await setupProdAuthApp(storage, oauthService, {
        useSimpleKey: true,
      });

      // Health endpoint should work without auth even in prod mode
      const res = await app.request("/health", { method: "GET" });

      assertEquals(res.status, 200);
      const json = z.object({ status: z.string(), service: z.string() }).parse(await res.json());
      assertEquals(json.status, "ok");
      assertEquals(json.service, "link");

      await cleanup();
    });
  },
);

/**
 * Tenancy Middleware Tests
 * Tests X-Atlas-User-ID header extraction edge cases for multi-tenant isolation
 */
Deno.test(
  { name: "tenancy middleware", sanitizeResources: false, sanitizeOps: false },
  async (t) => {
    // Use temp file-based KV for testing (":memory:" creates separate DBs per open call)
    const tempDir = await Deno.makeTempDir();
    const storage = new DenoKVStorageAdapter(`${tempDir}/tenancy-test.db`);
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

      const keyFile = await Deno.makeTempFile();
      await Deno.writeTextFile(keyFile, publicKeyPem);

      const originalKeyFile = process.env.LINK_JWT_PUBLIC_KEY_FILE;
      const originalKvPath = process.env.LINK_KV_PATH;
      const originalDevMode = process.env.LINK_DEV_MODE;

      process.env.LINK_JWT_PUBLIC_KEY_FILE = keyFile;
      process.env.LINK_KV_PATH = ":memory:";
      delete process.env.LINK_DEV_MODE;

      const { createApp: createAppFresh } = await import(`../src/index.ts?t=${Date.now()}`);
      // IMPORTANT: Use same storage instance so credentials persist
      const app = await createAppFresh(storage, oauthService);

      return {
        app,
        keyPair,
        cleanup: async () => {
          await Deno.remove(keyFile);
          if (originalKeyFile) process.env.LINK_JWT_PUBLIC_KEY_FILE = originalKeyFile;
          else delete process.env.LINK_JWT_PUBLIC_KEY_FILE;
          if (originalKvPath) process.env.LINK_KV_PATH = originalKvPath;
          else delete process.env.LINK_KV_PATH;
          if (originalDevMode) process.env.LINK_DEV_MODE = originalDevMode;
        },
      };
    }

    await t.step("prod: JWT missing tempest_user_id → 401 missing_user_id", async () => {
      const { app, keyPair, cleanup } = await setupProdApp();

      // Create JWT without user_metadata.tempest_user_id
      const token = await new jose.SignJWT({ sub: "test-user" })
        .setProtectedHeader({ alg: "RS256" })
        .sign(keyPair.privateKey);

      const res = await app.request("/v1/credentials/type/apikey", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });

      assertEquals(res.status, 401);
      const json = await res.json();
      assertEquals(json, { error: "missing_user_id" });

      await cleanup();
    });

    await t.step("dev: no X-Atlas-User-ID → falls back to userId=dev", async () => {
      const originalKeyFile = process.env.LINK_JWT_PUBLIC_KEY_FILE;
      const originalKvPath = process.env.LINK_KV_PATH;
      const originalDevMode = process.env.LINK_DEV_MODE;

      delete process.env.LINK_JWT_PUBLIC_KEY_FILE;
      process.env.LINK_KV_PATH = ":memory:";
      process.env.LINK_DEV_MODE = "true";

      const { createApp: createAppFresh } = await import(`../src/index.ts?t=${Date.now()}`);
      // Use same storage instance so we can verify data persistence
      const devApp = await createAppFresh(storage, oauthService);

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

      assertEquals(putRes.status, 201);
      const created = await putRes.json();

      // Verify it's stored under userId "dev" by fetching directly from storage
      // (can't use list endpoint since different app instance)
      const storedCred = await storage.get(created.id, "dev");
      assertExists(storedCred);
      assertEquals(storedCred.id, created.id);
      assertEquals(storedCred.label, "dev-cred");

      // Restore env
      if (originalKeyFile) process.env.LINK_JWT_PUBLIC_KEY_FILE = originalKeyFile;
      if (originalKvPath) process.env.LINK_KV_PATH = originalKvPath;
      else delete process.env.LINK_KV_PATH;
      if (originalDevMode) process.env.LINK_DEV_MODE = originalDevMode;
      else delete process.env.LINK_DEV_MODE;
    });

    await t.step("special chars in user ID propagate correctly", async () => {
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

        assertEquals(putRes.status, 201, `Failed to create for ${desc}`);
        const created = await putRes.json();

        // Verify credential is stored under correct userId by fetching from storage directly
        const storedCred = await storage.get(created.id, userId);
        assertExists(storedCred, `Credential not found for ${desc}`);
        assertEquals(storedCred.id, created.id, `ID mismatch for ${desc}`);

        // Verify tenant isolation - different userId should not see credential
        const isolatedCred = await storage.get(created.id, "different-user");
        assertStrictEquals(isolatedCred, null, `Tenant isolation failed for ${desc}`);
      }

      await cleanup();
    });
  },
);
