/**
 * Integration test for credential-resolver service.
 * Tests real credential resolution flow hitting actual Link service.
 *
 * Run with:
 *   deno test --allow-net --allow-env packages/core/src/mcp-registry/credential-resolver.integration.test.ts
 *
 * Requirements:
 * - Link service running on http://localhost:3100
 * - Tests will FAIL with clear error message if Link is not available
 * - Requires --allow-net (for HTTP requests) and --allow-env (for client config)
 */

import { CredentialNotFoundError, resolveCredentialsByProvider } from "@atlas/core";
import { assertEquals, assertRejects } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import * as jose from "jose";

const LINK_BASE_URL = "http://localhost:3100";
const TEST_USER_ID = "integration-test-user";

/**
 * Generate unsigned JWT for dev mode testing.
 */
async function generateDevToken(userId: string): Promise<string> {
  return await new jose.UnsecuredJWT({ user_metadata: { tempest_user_id: userId } })
    .setSubject("test-user")
    .encode();
}

/**
 * Check if Link service is running.
 */
async function isLinkAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${LINK_BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    const ok = response.ok;
    // Consume body to avoid resource leak
    await response.text();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Create test credential via Link API.
 */
async function createTestCredential(
  token: string,
  provider: string,
  label: string,
): Promise<string> {
  const response = await fetch(`${LINK_BASE_URL}/v1/credentials/apikey`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Atlas-User-ID": TEST_USER_ID,
    },
    body: JSON.stringify({ provider, label, secret: { key: `sk-test-${crypto.randomUUID()}` } }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create credential: ${response.status} ${await response.text()}`);
  }

  const result = (await response.json()) as { id: string };
  return result.id;
}

/**
 * Delete test credential via Link API.
 */
async function deleteTestCredential(token: string, credentialId: string): Promise<void> {
  const response = await fetch(`${LINK_BASE_URL}/v1/credentials/${credentialId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "X-Atlas-User-ID": TEST_USER_ID },
  });
  // Consume response body to avoid resource leak
  await response.text();
}

/**
 * Google OAuth providers for integration testing.
 * These require real OAuth flow completion to have valid credentials.
 */
const GOOGLE_PROVIDERS = [
  "google-calendar",
  "google-gmail",
  "google-drive",
  "google-docs",
  "google-sheets",
] as const;

describe("credential-resolver integration tests", () => {
  let linkAvailable = false;
  let token = "";
  const createdCredentials: string[] = [];

  beforeAll(async () => {
    linkAvailable = await isLinkAvailable();

    if (!linkAvailable) {
      // Tests will fail explicitly with clear error messages
      return;
    }

    token = await generateDevToken(TEST_USER_ID);
  });

  afterAll(async () => {
    if (!linkAvailable) return;

    // Clean up test credentials
    for (const credId of createdCredentials) {
      try {
        await deleteTestCredential(token, credId);
      } catch (error) {
        console.warn(`Failed to clean up credential ${credId}:`, error);
      }
    }
  });

  it("resolves single credential by provider", async () => {
    if (!linkAvailable) {
      throw new Error(`SKIP: Link service not available at ${LINK_BASE_URL}`);
    }

    // Create test credential
    const credId = await createTestCredential(token, "test", "integration-test-single");
    createdCredentials.push(credId);

    try {
      // Call resolver - this hits the real Link API
      const credentials = await resolveCredentialsByProvider("test");

      assertEquals(credentials.length, 1, "Should return exactly one credential");
      assertEquals(
        // biome-ignore lint/style/noNonNullAssertion: length assertion above guarantees [0] exists
        credentials[0]!.id,
        credId,
        "Resolved credential ID should match created credential",
      );
    } finally {
      await deleteTestCredential(token, credId);
      const idx = createdCredentials.indexOf(credId);
      if (idx > -1) createdCredentials.splice(idx, 1);
    }
  });

  it("throws CredentialNotFoundError when no credentials exist", async () => {
    if (!linkAvailable) {
      throw new Error(`SKIP: Link service not available at ${LINK_BASE_URL}`);
    }

    const nonExistentProvider = `test-nonexistent-${crypto.randomUUID()}`;

    await assertRejects(
      () => resolveCredentialsByProvider(nonExistentProvider),
      CredentialNotFoundError,
      `No credentials found for provider '${nonExistentProvider}'`,
    );
  });

  it("returns all credentials when multiple exist", async () => {
    if (!linkAvailable) {
      throw new Error(`SKIP: Link service not available at ${LINK_BASE_URL}`);
    }

    // Use registered "test" provider - Link requires known providers
    const provider = "test";

    // Create two credentials with same provider
    const cred1 = await createTestCredential(token, provider, "multiple-test-1");
    const cred2 = await createTestCredential(token, provider, "multiple-test-2");
    createdCredentials.push(cred1, cred2);

    try {
      const credentials = await resolveCredentialsByProvider(provider);

      assertEquals(credentials.length >= 2, true, "Should have at least 2 credentials");
      const ids = credentials.map((c) => c.id);
      assertEquals(ids.includes(cred1), true, "Should include first credential");
      assertEquals(ids.includes(cred2), true, "Should include second credential");
    } finally {
      await deleteTestCredential(token, cred1);
      await deleteTestCredential(token, cred2);
      createdCredentials.splice(createdCredentials.indexOf(cred1), 1);
      createdCredentials.splice(createdCredentials.indexOf(cred2), 1);
    }
  });
});

/**
 * Check if Google OAuth credentials exist for a provider.
 * Returns true if at least one credential exists (from completed OAuth flow).
 */
async function hasGoogleCredential(provider: string): Promise<boolean> {
  try {
    const credentials = await resolveCredentialsByProvider(provider);
    return credentials.length > 0;
  } catch {
    return false;
  }
}

describe("Google OAuth credential resolution (requires completed OAuth flow)", () => {
  let linkAvailable = false;

  beforeAll(async () => {
    linkAvailable = await isLinkAvailable();
    // linkAvailable checked in each test - tests will fail explicitly if unavailable
  });

  for (const provider of GOOGLE_PROVIDERS) {
    it(`resolves ${provider} credentials when OAuth is configured`, async () => {
      if (!linkAvailable) {
        throw new Error(`SKIP: Link service not available at ${LINK_BASE_URL}`);
      }

      const hasCredential = await hasGoogleCredential(provider);
      if (!hasCredential) {
        throw new Error(
          `SKIP: No ${provider} OAuth credential found - complete OAuth flow to enable`,
        );
      }

      const credentials = await resolveCredentialsByProvider(provider);
      assertEquals(
        credentials.length >= 1,
        true,
        `Should have at least one ${provider} credential`,
      );
      // biome-ignore lint/style/noNonNullAssertion: length assertion above guarantees [0] exists
      assertEquals(credentials[0]!.provider, provider);
      // biome-ignore lint/style/noNonNullAssertion: length assertion above guarantees [0] exists
      assertEquals(credentials[0]!.type, "oauth");
    });
  }

  it("resolves google-calendar access_token format (ya29.*)", async () => {
    if (!linkAvailable) {
      throw new Error(`SKIP: Link service not available at ${LINK_BASE_URL}`);
    }

    const hasCredential = await hasGoogleCredential("google-calendar");
    if (!hasCredential) {
      throw new Error(
        "SKIP: No google-calendar OAuth credential found - complete OAuth flow to enable",
      );
    }

    const credentials = await resolveCredentialsByProvider("google-calendar");

    // Get full credential to check token format
    // biome-ignore lint/style/noNonNullAssertion: resolveCredentialsByProvider throws if empty
    const credId = credentials[0]!.id;
    const response = await fetch(`${LINK_BASE_URL}/internal/v1/credentials/${credId}`, {
      headers: { "X-Atlas-User-ID": TEST_USER_ID },
    });

    if (!response.ok) {
      throw new Error(
        `SKIP: Could not fetch full credential - internal API returned ${response.status}`,
      );
    }

    const { credential } = (await response.json()) as {
      credential: { secret: { access_token?: string } };
    };
    const accessToken = credential.secret.access_token;

    assertEquals(typeof accessToken, "string", "access_token should be a string");
    assertEquals(
      accessToken?.startsWith("ya29."),
      true,
      "Google access token should start with ya29.",
    );
  });
});
