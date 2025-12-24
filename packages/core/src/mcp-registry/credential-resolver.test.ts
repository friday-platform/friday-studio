import { assertEquals, assertRejects } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { CredentialNotFoundError, resolveCredentialsByProvider } from "./credential-resolver.ts";

// =============================================================================
// Mock Fetch Helpers
// =============================================================================

const LINK_BASE_URL = "http://127.0.0.1:8080/api/link";

type MockCredential = { id: string; provider: string; label: string; type: string };

/**
 * Create mock fetch that returns summary for a provider.
 */
function mockSummaryFetch(provider: string, credentials: MockCredential[]): typeof fetch {
  const url = `${LINK_BASE_URL}/v1/summary?provider=${provider}`;

  return (input: RequestInfo | URL) => {
    const requestUrl = typeof input === "string" ? input : input.toString();
    if (requestUrl !== url) {
      throw new Error(`Mock not configured for URL: ${requestUrl}`);
    }

    return Promise.resolve(
      new Response(JSON.stringify({ providers: [], credentials }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
}

// =============================================================================
// Test Setup
// =============================================================================

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("resolveCredentialsByProvider", () => {
  it("returns all credentials when one exists", async () => {
    globalThis.fetch = mockSummaryFetch("slack", [
      { id: "cred_abc", provider: "slack", label: "Work", type: "oauth" },
    ]);

    const credentials = await resolveCredentialsByProvider("slack", "user-123");
    assertEquals(credentials.length, 1);
    assertEquals(credentials[0]!.id, "cred_abc");
  });

  it("throws CredentialNotFoundError when none exist", async () => {
    globalThis.fetch = mockSummaryFetch("slack", []);

    await assertRejects(
      () => resolveCredentialsByProvider("slack", "user-123"),
      CredentialNotFoundError,
      "No credentials found for provider 'slack'",
    );
  });

  it("returns all credentials when multiple exist", async () => {
    globalThis.fetch = mockSummaryFetch("slack", [
      { id: "cred_abc", provider: "slack", label: "Work", type: "oauth" },
      { id: "cred_xyz", provider: "slack", label: "Personal", type: "oauth" },
    ]);

    const credentials = await resolveCredentialsByProvider("slack", "user-123");
    assertEquals(credentials.length, 2);
    assertEquals(credentials[0]!.id, "cred_abc");
    assertEquals(credentials[1]!.id, "cred_xyz");
  });
});

describe("CredentialNotFoundError", () => {
  it("includes provider in message and exposes property", () => {
    const error = new CredentialNotFoundError("github");
    assertEquals(error.message, "No credentials found for provider 'github'");
    assertEquals(error.name, "CredentialNotFoundError");
    assertEquals(error.provider, "github");
  });
});
