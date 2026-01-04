import process from "node:process";
import { createLogger } from "@atlas/logger";
import { assertEquals, assertRejects } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import {
  CredentialNotFoundError,
  resolveCredentialsByProvider,
  resolveEnvValues,
} from "./credential-resolver.ts";

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

type MockFullCredential = {
  id: string;
  provider: string;
  type: string;
  secret: Record<string, unknown>;
};

/**
 * Create mock fetch that handles both summary and credential endpoints.
 * Used for testing full resolveEnvValues flow.
 */
function mockLinkFetch(
  provider: string,
  summaryCredentials: MockCredential[],
  fullCredentials: Record<string, MockFullCredential>,
): typeof fetch {
  const summaryUrl = `${LINK_BASE_URL}/v1/summary?provider=${provider}`;
  const internalUrlPrefix = `${LINK_BASE_URL}/internal/v1/credentials/`;

  return (input: RequestInfo | URL) => {
    const requestUrl = typeof input === "string" ? input : input.toString();

    // Handle summary endpoint
    if (requestUrl === summaryUrl) {
      return Promise.resolve(
        new Response(JSON.stringify({ providers: [], credentials: summaryCredentials }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    // Handle internal credential endpoint
    if (requestUrl.startsWith(internalUrlPrefix)) {
      const credId = requestUrl.slice(internalUrlPrefix.length);
      const credential = fullCredentials[credId];

      if (!credential) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "Not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      return Promise.resolve(
        new Response(JSON.stringify({ credential, status: "valid" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    throw new Error(`Mock not configured for URL: ${requestUrl}`);
  };
}

// =============================================================================
// Test Setup
// =============================================================================

let originalFetch: typeof fetch;
let originalDevMode: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalDevMode = process.env.LINK_DEV_MODE;
  process.env.LINK_DEV_MODE = "true"; // Use dev mode to skip ATLAS_KEY auth
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDevMode === undefined) {
    delete process.env.LINK_DEV_MODE;
  } else {
    process.env.LINK_DEV_MODE = originalDevMode;
  }
});

describe("resolveCredentialsByProvider", () => {
  it("returns all credentials when one exists", async () => {
    globalThis.fetch = mockSummaryFetch("slack", [
      { id: "cred_abc", provider: "slack", label: "Work", type: "oauth" },
    ]);

    const credentials = await resolveCredentialsByProvider("slack");
    assertEquals(credentials.length, 1);
    assertEquals(credentials[0]!.id, "cred_abc");
  });

  it("throws CredentialNotFoundError when none exist", async () => {
    globalThis.fetch = mockSummaryFetch("slack", []);

    await assertRejects(
      () => resolveCredentialsByProvider("slack"),
      CredentialNotFoundError,
      "No credentials found for provider 'slack'",
    );
  });

  it("returns all credentials when multiple exist", async () => {
    globalThis.fetch = mockSummaryFetch("slack", [
      { id: "cred_abc", provider: "slack", label: "Work", type: "oauth" },
      { id: "cred_xyz", provider: "slack", label: "Personal", type: "oauth" },
    ]);

    const credentials = await resolveCredentialsByProvider("slack");
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

// =============================================================================
// Google Credential Resolution Tests
// =============================================================================

const GOOGLE_PROVIDERS = [
  "google-calendar",
  "google-gmail",
  "google-drive",
  "google-docs",
  "google-sheets",
] as const;

describe("Google credential resolution", () => {
  const logger = createLogger({ name: "test", level: "silent" });

  for (const provider of GOOGLE_PROVIDERS) {
    it(`resolves ${provider} credentials by provider`, async () => {
      globalThis.fetch = mockSummaryFetch(provider, [
        { id: `cred_${provider}_123`, provider, label: "Test Account", type: "oauth" },
      ]);

      const credentials = await resolveCredentialsByProvider(provider);
      assertEquals(credentials.length, 1);
      assertEquals(credentials[0]!.provider, provider);
      assertEquals(credentials[0]!.type, "oauth");
    });
  }

  it("resolves google-calendar access_token via resolveEnvValues", async () => {
    const fakeAccessToken = "ya29.fake-google-access-token-for-testing";
    const credId = "cred_google_calendar_abc";

    globalThis.fetch = mockLinkFetch(
      "google-calendar",
      [{ id: credId, provider: "google-calendar", label: "Work Calendar", type: "oauth" }],
      {
        [credId]: {
          id: credId,
          provider: "google-calendar",
          type: "oauth",
          secret: {
            access_token: fakeAccessToken,
            refresh_token: "1//fake-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          },
        },
      },
    );

    const env = {
      GOOGLE_CALENDAR_ACCESS_TOKEN: {
        from: "link" as const,
        provider: "google-calendar",
        key: "access_token",
      },
    };

    const resolved = await resolveEnvValues(env, logger);

    const token = resolved.GOOGLE_CALENDAR_ACCESS_TOKEN;
    assertEquals(token, fakeAccessToken);
    assertEquals(token?.startsWith("ya29."), true);
  });

  it("resolves google-gmail access_token via resolveEnvValues", async () => {
    const fakeAccessToken = "ya29.fake-gmail-token";
    const credId = "cred_gmail_xyz";

    globalThis.fetch = mockLinkFetch(
      "google-gmail",
      [{ id: credId, provider: "google-gmail", label: "Personal Gmail", type: "oauth" }],
      {
        [credId]: {
          id: credId,
          provider: "google-gmail",
          type: "oauth",
          secret: { access_token: fakeAccessToken },
        },
      },
    );

    const env = {
      GMAIL_TOKEN: { from: "link" as const, provider: "google-gmail", key: "access_token" },
    };

    const resolved = await resolveEnvValues(env, logger);
    assertEquals(resolved.GMAIL_TOKEN, fakeAccessToken);
  });

  it("throws when Google credential has no access_token key", async () => {
    const credId = "cred_drive_no_token";

    globalThis.fetch = mockLinkFetch(
      "google-drive",
      [{ id: credId, provider: "google-drive", label: "Drive", type: "oauth" }],
      {
        [credId]: {
          id: credId,
          provider: "google-drive",
          type: "oauth",
          secret: { refresh_token: "only-refresh" }, // Missing access_token
        },
      },
    );

    const env = {
      DRIVE_TOKEN: { from: "link" as const, provider: "google-drive", key: "access_token" },
    };

    await assertRejects(
      () => resolveEnvValues(env, logger),
      Error,
      "Key 'access_token' not found in credential",
    );
  });
});
