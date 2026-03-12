import process from "node:process";
import { aroundEach, describe, expect, it } from "vitest";
import { getSlackTokenByTeamId } from "./slack-credentials.ts";

// =============================================================================
// Mock Fetch Helpers
// =============================================================================

const LINK_BASE_URL = "http://127.0.0.1:8080/api/link";

type MockCredential = { id: string; provider: string; label: string; type: string };
type MockFullCredential = {
  id: string;
  provider: string;
  type: string;
  secret: Record<string, unknown>;
};

/**
 * Create mock fetch that handles both summary and credential endpoints.
 */
function mockLinkFetch(config: {
  summaryCredentials?: MockCredential[];
  fullCredentials?: Record<string, MockFullCredential>;
  summaryError?: { status: number; error: string };
  credentialError?: { status: number; error: string };
}): { restore: () => void } {
  const originalFetch = globalThis.fetch;
  const summaryUrl = `${LINK_BASE_URL}/v1/summary?provider=slack`;
  const internalUrlPrefix = `${LINK_BASE_URL}/internal/v1/credentials/`;

  globalThis.fetch = (input: RequestInfo | URL) => {
    const requestUrl = typeof input === "string" ? input : input.toString();

    // Handle summary endpoint
    if (requestUrl === summaryUrl) {
      if (config.summaryError) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: config.summaryError.error }), {
            status: config.summaryError.status,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ providers: [], credentials: config.summaryCredentials ?? [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    // Handle internal credential endpoint
    if (requestUrl.startsWith(internalUrlPrefix)) {
      if (config.credentialError) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: config.credentialError.error }), {
            status: config.credentialError.status,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      const credId = requestUrl.slice(internalUrlPrefix.length);
      const credential = config.fullCredentials?.[credId];

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

  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

// =============================================================================
// Test Setup
// =============================================================================

aroundEach(async (run) => {
  const originalDevMode = process.env.LINK_DEV_MODE;
  process.env.LINK_DEV_MODE = "true"; // Skip ATLAS_KEY auth requirement
  await run();
  if (originalDevMode === undefined) {
    delete process.env.LINK_DEV_MODE;
  } else {
    process.env.LINK_DEV_MODE = originalDevMode;
  }
});

// =============================================================================
// Tests
// =============================================================================

describe("getSlackTokenByTeamId", () => {
  it("returns token when credential exists", async () => {
    const credId = "cred_slack_123";
    const accessToken = "xoxb-test-token-12345";

    const mock = mockLinkFetch({
      summaryCredentials: [{ id: credId, provider: "slack", label: "Work", type: "oauth" }],
      fullCredentials: {
        [credId]: {
          id: credId,
          provider: "slack",
          type: "oauth",
          secret: { externalId: "T12345", access_token: accessToken, token_type: "bot" },
        },
      },
    });

    try {
      const token = await getSlackTokenByTeamId("T12345");
      expect(token).toEqual(accessToken);
    } finally {
      mock.restore();
    }
  });

  it("returns null when CredentialNotFoundError thrown (empty credentials)", async () => {
    // When no credentials exist, resolveCredentialsByProvider throws CredentialNotFoundError
    const mock = mockLinkFetch({ summaryCredentials: [] });

    try {
      const token = await getSlackTokenByTeamId("T12345");
      expect(token).toBeNull();
    } finally {
      mock.restore();
    }
  });

  it("returns first credential token when multiple exist", async () => {
    const firstToken = "xoxb-first-token";
    const secondToken = "xoxb-second-token";

    const mock = mockLinkFetch({
      summaryCredentials: [
        { id: "cred_1", provider: "slack", label: "First", type: "oauth" },
        { id: "cred_2", provider: "slack", label: "Second", type: "oauth" },
      ],
      fullCredentials: {
        cred_1: {
          id: "cred_1",
          provider: "slack",
          type: "oauth",
          secret: { access_token: firstToken, externalId: "T1", token_type: "bot" },
        },
        cred_2: {
          id: "cred_2",
          provider: "slack",
          type: "oauth",
          secret: { access_token: secondToken, externalId: "T2", token_type: "bot" },
        },
      },
    });

    try {
      const token = await getSlackTokenByTeamId("T1");
      expect(token).toEqual(firstToken);
    } finally {
      mock.restore();
    }
  });

  it("throws when Link API returns non-404 error", async () => {
    const mock = mockLinkFetch({ summaryError: { status: 500, error: "Internal server error" } });

    try {
      await expect(getSlackTokenByTeamId("T12345")).rejects.toThrow("Failed to fetch credentials");
    } finally {
      mock.restore();
    }
  });

  it("throws when credential fetch fails with non-404 error", async () => {
    const mock = mockLinkFetch({
      summaryCredentials: [{ id: "cred_abc", provider: "slack", label: "Work", type: "oauth" }],
      credentialError: { status: 500, error: "Internal server error" },
    });

    try {
      await expect(getSlackTokenByTeamId("T12345")).rejects.toThrow("Failed to fetch credential");
    } finally {
      mock.restore();
    }
  });
});
