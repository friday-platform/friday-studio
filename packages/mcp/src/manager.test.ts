/**
 * Link MCP Integration Tests
 *
 * Tests credential resolution from Link service for MCP server environment variables.
 * Covers Linear requirement TEM-3376:
 * 1. Happy path - Link credential resolves correctly
 * 2. Error handling - 404 not found with clear message
 * 3. Mixed env types - Link ref + literal + auto
 */

import { writeFile } from "node:fs/promises";
import process from "node:process";
import { assertEquals, assertExists, assertMatch, assertRejects } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import * as jose from "jose";
import { MCPManager } from "./manager.ts";

// =============================================================================
// Test Fixtures
// =============================================================================

const TestFixtures = {
  validOAuth: {
    credential: {
      id: "cred_oauth_test",
      type: "oauth" as const,
      provider: "slack",
      label: "Test Slack OAuth",
      secret: {
        access_token: "xoxb-test-token-12345",
        refresh_token: "xoxr-refresh-67890",
        token_type: "Bearer",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
      metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    },
    status: "ready" as const,
  },

  validApiKey: {
    credential: {
      id: "cred_apikey_test",
      type: "apikey" as const,
      provider: "github",
      label: "Test GitHub API Key",
      secret: { api_key: "ghp_test_key_abcdef123456", api_endpoint: "https://api.github.com" },
      metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    },
    status: "ready" as const,
  },
};

// =============================================================================
// Mock Fetch Helpers
// =============================================================================

const LINK_BASE_URL = "http://127.0.0.1:8080/api/link";

/**
 * Create mock fetch that returns credential data.
 */
function mockCredentialFetch(
  credId: string,
  responseData: unknown,
  headerCapture?: (headers: Record<string, string>) => void,
): typeof fetch {
  const url = `${LINK_BASE_URL}/internal/v1/credentials/${credId}`;

  return (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input.toString();
    if (requestUrl !== url) {
      throw new Error(`Mock not configured for URL: ${requestUrl}`);
    }

    // Capture headers if callback provided
    if (headerCapture && init?.headers) {
      const headers: Record<string, string> = {};
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) {
          headers[key] = value;
        }
      } else {
        Object.assign(headers, init.headers);
      }
      headerCapture(headers);
    }

    return Promise.resolve(
      new Response(JSON.stringify(responseData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
}

// =============================================================================
// Global Setup/Teardown
// =============================================================================

let originalFetch: typeof fetch;
let originalEnv: Record<string, string | undefined>;
let manager: MCPManager;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalEnv = {
    ATLAS_USER_ID: process.env.ATLAS_USER_ID,
    DEBUG: process.env.DEBUG,
    LINK_DEV_MODE: process.env.LINK_DEV_MODE,
  };

  process.env.ATLAS_USER_ID = "test-user";
  process.env.LINK_DEV_MODE = "true"; // Use dev mode to skip JWT in most tests
  manager = MCPManager.getInstance();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;

  // Clean up any registered servers
  await manager.dispose();

  // Restore environment
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

// =============================================================================
// Integration Tests (Linear TEM-3376)
// =============================================================================

describe("MCPManager - Link Credential Integration", () => {
  it("Test 1: resolves MCP server env with Link credential (happy path)", async () => {
    // Setup: Mock Link API
    globalThis.fetch = mockCredentialFetch("cred_slack_prod", TestFixtures.validOAuth);

    // Test by registering a server that requires the Link credential
    // Use echo which exists on all platforms - it will fail during MCP handshake
    // but env resolution will have already succeeded by then
    const config = {
      id: "test-slack-server",
      transport: {
        type: "stdio" as const,
        command: Deno.build.os === "windows" ? "cmd.exe" : "echo",
        args: Deno.build.os === "windows" ? ["/c", "echo"] : [],
      },
      env: {
        SLACK_BOT_TOKEN: { from: "link" as const, id: "cred_slack_prod", key: "access_token" },
      },
    };

    // Registration will fail during MCP client creation (echo is not an MCP server),
    // but if we get a registration failure (not a credential error), we know
    // credential resolution succeeded
    const error = await assertRejects(async () => await manager.registerServer(config), Error);

    // Verify we got past credential resolution - error should be about registration, not credentials
    assertMatch(error.message, /registration failed/);
    // Make sure it's not a credential error
    assertEquals(error.message.includes("Failed to fetch credential"), false);
  });

  it("Test 2: fails with clear error when credential not found (404)", async () => {
    // Setup: Mock 404 response
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "credential_not_found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      );

    // Test by registering a server that references a missing credential
    const config = {
      id: "test-missing-cred-server",
      transport: {
        type: "stdio" as const,
        command: Deno.build.os === "windows" ? "cmd.exe" : "echo",
        args: [],
      },
      env: { API_KEY: { from: "link" as const, id: "cred_nonexistent", key: "token" } },
    };

    // Should fail with credential fetch error
    const error = await assertRejects(async () => await manager.registerServer(config), Error);

    // Verify error message is actionable and mentions the credential
    assertMatch(error.message, /Failed to fetch credential 'cred_nonexistent'/);
  });

  it("Test 3: resolves mixed env types (Link + literal + auto)", async () => {
    // Setup: Mock Link credential
    globalThis.fetch = mockCredentialFetch("cred_github", TestFixtures.validApiKey);

    // Setup: Environment variable for "auto"
    process.env.DEBUG = "true";

    // Test by registering a server with mixed env config
    const config = {
      id: "test-mixed-env-server",
      transport: {
        type: "stdio" as const,
        command: Deno.build.os === "windows" ? "cmd.exe" : "echo",
        args: Deno.build.os === "windows" ? ["/c", "echo"] : [],
      },
      env: {
        // From Link
        GITHUB_TOKEN: { from: "link" as const, id: "cred_github", key: "api_key" },
        // Literal string
        WORKSPACE_ID: "workspace-123",
        // From process.env
        DEBUG: "auto" as const,
      },
    };

    // This will fail during MCP client creation, but if all env resolution succeeded,
    // the error will be about registration, not environment variables
    const error = await assertRejects(async () => await manager.registerServer(config), Error);

    // Verify env resolution succeeded - error should be about registration
    assertMatch(error.message, /registration failed/);
    // Make sure it's not an env-related error
    assertEquals(error.message.includes("environment variable"), false);
  });
});

// =============================================================================
// JWT Authentication Tests
// =============================================================================

describe("MCPManager - JWT Authentication", () => {
  it("generates valid JWT with correct claims", async () => {
    // Generate test key pair with extractable=true
    const keyPair = await jose.generateKeyPair("RS256", { extractable: true });
    const privateKeyPem = await jose.exportPKCS8(keyPair.privateKey);

    // Test the exported signLinkJWT function directly (now in @atlas/core)
    const { signLinkJWT } = await import("@atlas/core/mcp-registry/credential-resolver");

    // Sign JWT
    const jwt = await signLinkJWT("test-user", privateKeyPem);

    // Decode and verify claims (no signature verification needed)
    const payload = jose.decodeJwt(jwt);
    assertEquals(payload.iss, "atlas-daemon");
    assertEquals(payload.sub, "test-user");
    assertEquals(payload.aud, "link-service");
    assertExists(payload.iat);
    assertExists(payload.exp);

    // Verify TTL is 5 minutes (300 seconds)
    const ttl = payload.exp - payload.iat;
    assertEquals(ttl, 300);
  });

  it("includes JWT in Authorization header when fetching credentials in prod mode", async () => {
    // Setup: Generate test key pair and write to temp file
    const keyPair = await jose.generateKeyPair("RS256", { extractable: true });
    const privateKeyPem = await jose.exportPKCS8(keyPair.privateKey);
    const tempKeyFile = await Deno.makeTempFile({ suffix: ".pem" });
    await writeFile(tempKeyFile, privateKeyPem, "utf-8");

    // Setup: Mock environment for prod mode
    const originalDevMode = process.env.LINK_DEV_MODE;
    const originalKeyFile = process.env.ATLAS_JWT_PRIVATE_KEY_FILE;

    process.env.LINK_DEV_MODE = "false";
    process.env.ATLAS_JWT_PRIVATE_KEY_FILE = tempKeyFile;

    // Setup: Mock Link API with header capture
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = mockCredentialFetch("cred_jwt_test", TestFixtures.validOAuth, (headers) => {
      capturedHeaders = headers;
    });

    try {
      // Create new manager instance to load the private key
      const { MCPManager: FreshMCPManager } = await import(`./manager.ts?t=${Date.now()}`);
      const testManager = new (FreshMCPManager as typeof MCPManager)();

      // Register a server that requires Link credentials
      // This will trigger credential fetching with JWT
      const config = {
        id: "test-jwt-server",
        transport: { type: "stdio" as const, command: "nonexistent-command", args: [] },
        env: { TOKEN: { from: "link" as const, id: "cred_jwt_test", key: "access_token" } },
      };

      // Attempt to register - will fail on command, but should fetch credential with JWT
      await assertRejects(async () => await testManager.registerServer(config));

      // Assert: JWT present in Authorization header
      assertExists(capturedHeaders.authorization);
      assertMatch(capturedHeaders.authorization, /^Bearer .+\..+\..+$/);

      // Verify JWT is valid by decoding
      const token = capturedHeaders.authorization.replace("Bearer ", "");
      const payload = jose.decodeJwt(token);
      assertEquals(payload.iss, "atlas-daemon");
      assertEquals(payload.aud, "link-service");

      // Cleanup registered server
      await testManager.dispose();
    } finally {
      // Cleanup
      await Deno.remove(tempKeyFile);
      if (originalDevMode !== undefined) {
        process.env.LINK_DEV_MODE = originalDevMode;
      } else {
        delete process.env.LINK_DEV_MODE;
      }
      if (originalKeyFile !== undefined) {
        process.env.ATLAS_JWT_PRIVATE_KEY_FILE = originalKeyFile;
      } else {
        delete process.env.ATLAS_JWT_PRIVATE_KEY_FILE;
      }
    }
  });

  it("skips JWT in dev mode", async () => {
    // Already in dev mode from beforeEach
    // Setup: Mock Link API with header capture
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = mockCredentialFetch("cred_dev_test", TestFixtures.validOAuth, (headers) => {
      capturedHeaders = headers;
    });

    // Register a server that requires Link credentials
    const config = {
      id: "test-dev-server",
      transport: { type: "stdio" as const, command: "nonexistent-command", args: [] },
      env: { TOKEN: { from: "link" as const, id: "cred_dev_test", key: "access_token" } },
    };

    // Attempt to register - will fail on command, but should fetch credential without JWT
    await assertRejects(async () => await manager.registerServer(config));

    // Assert: No JWT in headers
    assertEquals(capturedHeaders.authorization, undefined);
  });

  it("throws clear error when private key missing in prod mode", async () => {
    // Setup: Mock environment for prod without key file
    const originalDevMode = process.env.LINK_DEV_MODE;
    const originalKeyFile = process.env.ATLAS_JWT_PRIVATE_KEY_FILE;

    process.env.LINK_DEV_MODE = "false";
    delete process.env.ATLAS_JWT_PRIVATE_KEY_FILE;

    try {
      // Create new manager instance that will not have private key
      const { MCPManager: FreshMCPManager } = await import(`./manager.ts?t=${Date.now()}`);
      const testManager = new (FreshMCPManager as typeof MCPManager)();

      // Mock fetch
      globalThis.fetch = mockCredentialFetch("cred_test", TestFixtures.validOAuth);

      // Register server that requires Link credential
      const config = {
        id: "test-no-key-server",
        transport: { type: "stdio" as const, command: "echo", args: [] },
        env: { TOKEN: { from: "link" as const, id: "cred_test", key: "access_token" } },
      };

      // Should throw when trying to fetch credential without key
      await assertRejects(
        async () => await testManager.registerServer(config),
        Error,
        "ATLAS_JWT_PRIVATE_KEY_FILE is required",
      );

      // Cleanup
      await testManager.dispose();
    } finally {
      // Cleanup
      if (originalDevMode !== undefined) {
        process.env.LINK_DEV_MODE = originalDevMode;
      } else {
        delete process.env.LINK_DEV_MODE;
      }
      if (originalKeyFile !== undefined) {
        process.env.ATLAS_JWT_PRIVATE_KEY_FILE = originalKeyFile;
      } else {
        delete process.env.ATLAS_JWT_PRIVATE_KEY_FILE;
      }
    }
  });
});
