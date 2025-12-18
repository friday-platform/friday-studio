/**
 * Link MCP Integration Tests
 *
 * Tests credential resolution from Link service for MCP server environment variables.
 * Covers Linear requirement TEM-3376:
 * 1. Happy path - Link credential resolves correctly
 * 2. Error handling - 404 not found with clear message
 * 3. Mixed env types - Link ref + literal + auto
 */

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
// Mock Helpers
// =============================================================================

class MockFetchBuilder {
  private responses = new Map<string, Response>();
  private baseUrl = "http://127.0.0.1:8080/api/link";
  private headerCapture?: (headers: Record<string, string>) => void;

  withCredential(credId: string, responseData: unknown) {
    const url = `${this.baseUrl}/internal/v1/credentials/${credId}`;
    this.responses.set(
      url,
      new Response(JSON.stringify(responseData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    return this;
  }

  with404(credId: string) {
    const url = `${this.baseUrl}/internal/v1/credentials/${credId}`;
    this.responses.set(
      url,
      new Response(JSON.stringify({ error: "credential_not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    return this;
  }

  withHeaderCapture(callback: (headers: Record<string, string>) => void) {
    this.headerCapture = callback;
    return this;
  }

  build(): typeof fetch {
    return (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const response = this.responses.get(url);

      if (!response) {
        throw new Error(`Mock not configured for URL: ${url}`);
      }

      // Capture headers if callback provided
      if (this.headerCapture && init?.headers) {
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
        this.headerCapture(headers);
      }

      return Promise.resolve(response.clone());
    };
  }
}

// =============================================================================
// Global Setup/Teardown
// =============================================================================

let originalFetch: typeof fetch;
let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalEnv = { ATLAS_USER_ID: process.env.ATLAS_USER_ID };

  process.env.ATLAS_USER_ID = "test-user";
});

afterEach(() => {
  globalThis.fetch = originalFetch;

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
    const mockFetch = new MockFetchBuilder()
      .withCredential("cred_slack_prod", TestFixtures.validOAuth)
      .build();
    globalThis.fetch = mockFetch;

    // Setup: Environment config
    const envConfig = {
      SLACK_BOT_TOKEN: { from: "link" as const, id: "cred_slack_prod", key: "access_token" },
    };

    // Execute
    const manager = MCPManager.getInstance();
    // biome-ignore lint/complexity/useLiteralKeys: bracket notation needed to access private method in test
    const resolved = await manager["resolveEnvValues"](envConfig);

    // Assert: Credential resolved correctly
    assertEquals(resolved.SLACK_BOT_TOKEN, "xoxb-test-token-12345");
  });

  it("Test 2: fails with clear error when credential not found (404)", async () => {
    // Setup: Mock 404 response
    const mockFetch = new MockFetchBuilder().with404("cred_nonexistent").build();
    globalThis.fetch = mockFetch;

    // Setup: Environment config referencing missing credential
    const envConfig = { API_KEY: { from: "link" as const, id: "cred_nonexistent", key: "token" } };

    // Execute & Assert: Should throw with clear error message
    const manager = MCPManager.getInstance();
    const error = await assertRejects(
      // biome-ignore lint/complexity/useLiteralKeys: bracket notation needed to access private method in test
      async () => await manager["resolveEnvValues"](envConfig),
      Error,
    );

    // Verify error message is actionable
    assertMatch(error.message, /Failed to fetch credential 'cred_nonexistent'/);
  });

  it("Test 3: resolves mixed env types (Link + literal + auto)", async () => {
    // Setup: Mock Link credential
    const mockFetch = new MockFetchBuilder()
      .withCredential("cred_github", TestFixtures.validApiKey)
      .build();
    globalThis.fetch = mockFetch;

    // Setup: Environment variable for "auto"
    process.env.DEBUG = "true";

    // Setup: Mixed environment config
    const envConfig = {
      // From Link
      GITHUB_TOKEN: { from: "link" as const, id: "cred_github", key: "api_key" },
      // Literal string
      WORKSPACE_ID: "workspace-123",
      // From process.env
      DEBUG: "auto" as const,
    };

    // Execute
    const manager = MCPManager.getInstance();
    // biome-ignore lint/complexity/useLiteralKeys: bracket notation needed to access private method in test
    const resolved = await manager["resolveEnvValues"](envConfig);

    // Assert: All types resolved correctly
    assertEquals(resolved.GITHUB_TOKEN, "ghp_test_key_abcdef123456"); // from Link
    assertEquals(resolved.WORKSPACE_ID, "workspace-123"); // literal
    assertEquals(resolved.DEBUG, "true"); // from env

    // Cleanup
    delete process.env.DEBUG;
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

    // Import the signLinkJWT function (will be added to manager.ts)
    const { signLinkJWT } = await import("./manager.ts");

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

  it("includes JWT in Authorization header (prod mode)", async () => {
    // Setup: Generate test key pair with extractable=true and write to temp file
    const keyPair = await jose.generateKeyPair("RS256", { extractable: true });
    const privateKeyPem = await jose.exportPKCS8(keyPair.privateKey);
    const tempKeyFile = await Deno.makeTempFile({ suffix: ".pem" });
    await Deno.writeTextFile(tempKeyFile, privateKeyPem);

    // Setup: Mock environment for prod mode
    const originalDevMode = process.env.LINK_DEV_MODE;
    const originalKeyFile = process.env.ATLAS_JWT_PRIVATE_KEY_FILE;

    process.env.LINK_DEV_MODE = "false";
    process.env.ATLAS_JWT_PRIVATE_KEY_FILE = tempKeyFile;

    // Setup: Mock Link API with header capture
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = new MockFetchBuilder()
      .withCredential("cred_jwt_test", TestFixtures.validOAuth)
      .withHeaderCapture((headers) => {
        capturedHeaders = headers;
      })
      .build();
    globalThis.fetch = mockFetch;

    try {
      // Create new manager instance to load the private key
      const { MCPManager: FreshMCPManager } = await import(`./manager.ts?t=${Date.now()}`);
      const manager = new (FreshMCPManager as typeof MCPManager)();

      // Execute: Fetch credential (should include JWT)
      // biome-ignore lint/complexity/useLiteralKeys: bracket notation needed to access private method in test
      await manager["fetchLinkCredential"]("cred_jwt_test");

      // Assert: JWT present in Authorization header
      assertExists(capturedHeaders.authorization);
      assertMatch(capturedHeaders.authorization, /^Bearer .+\..+\..+$/);

      // Verify JWT is valid by decoding
      const token = capturedHeaders.authorization.replace("Bearer ", "");
      const payload = jose.decodeJwt(token);
      assertEquals(payload.iss, "atlas-daemon");
      assertEquals(payload.aud, "link-service");
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
    // Setup: Mock environment for dev mode
    const originalDevMode = process.env.LINK_DEV_MODE;
    const originalKeyFile = process.env.ATLAS_JWT_PRIVATE_KEY_FILE;

    process.env.LINK_DEV_MODE = "true";
    delete process.env.ATLAS_JWT_PRIVATE_KEY_FILE;

    // Setup: Mock Link API with header capture
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = new MockFetchBuilder()
      .withCredential("cred_dev_test", TestFixtures.validOAuth)
      .withHeaderCapture((headers) => {
        capturedHeaders = headers;
      })
      .build();
    globalThis.fetch = mockFetch;

    try {
      // Execute: Fetch credential (should NOT include JWT)
      const manager = MCPManager.getInstance();
      // biome-ignore lint/complexity/useLiteralKeys: bracket notation needed to access private method in test
      await manager["fetchLinkCredential"]("cred_dev_test");

      // Assert: No JWT in headers
      assertEquals(capturedHeaders.authorization, undefined);
      // But X-Atlas-User-ID should still be present
      assertExists(capturedHeaders["x-atlas-user-id"]);
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

  it("throws clear error when private key missing in prod mode", async () => {
    // Setup: Mock environment for prod without key file
    const originalDevMode = process.env.LINK_DEV_MODE;
    const originalKeyFile = process.env.ATLAS_JWT_PRIVATE_KEY_FILE;

    process.env.LINK_DEV_MODE = "false";
    delete process.env.ATLAS_JWT_PRIVATE_KEY_FILE;

    try {
      // Execute & Assert: Should throw on MCPManager initialization
      // Note: We use the existing singleton, so we test fetchLinkCredential instead
      const manager = MCPManager.getInstance();

      // Mock fetch
      const mockFetch = new MockFetchBuilder()
        .withCredential("cred_test", TestFixtures.validOAuth)
        .build();
      globalThis.fetch = mockFetch;

      // Should throw when trying to fetch without key
      await assertRejects(
        // biome-ignore lint/complexity/useLiteralKeys: bracket notation needed to access private method in test
        async () => await manager["fetchLinkCredential"]("cred_test"),
        Error,
        "ATLAS_JWT_PRIVATE_KEY_FILE is required",
      );
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
