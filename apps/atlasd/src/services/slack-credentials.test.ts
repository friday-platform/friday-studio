import process from "node:process";
import { aroundEach, describe, expect, it } from "vitest";
import { getSlackBotToken } from "./slack-credentials.ts";

const LINK_BASE_URL = "http://127.0.0.1:8080/api/link";
const LINK_SERVICE_URL = "http://localhost:3100";

type MockFullCredential = {
  id: string;
  provider: string;
  type: string;
  secret: Record<string, unknown>;
};

/**
 * Create mock fetch that handles both the by-workspace endpoint and
 * the internal credential endpoint.
 */
function mockLinkFetch(config: {
  byWorkspace?: { credential_id: string; app_id: string } | null;
  byWorkspaceError?: { status: number; body: string };
  fullCredentials?: Record<string, MockFullCredential>;
  credentialError?: { status: number; error: string };
}): { restore: () => void } {
  const originalFetch = globalThis.fetch;
  const byWorkspacePrefix = `${LINK_SERVICE_URL}/internal/v1/slack-apps/by-workspace/`;
  const internalUrlPrefix = `${LINK_BASE_URL}/internal/v1/credentials/`;

  globalThis.fetch = (input: RequestInfo | URL) => {
    const requestUrl = typeof input === "string" ? input : input.toString();

    // Handle by-workspace endpoint
    if (requestUrl.startsWith(byWorkspacePrefix)) {
      if (config.byWorkspaceError) {
        return Promise.resolve(
          new Response(config.byWorkspaceError.body, {
            status: config.byWorkspaceError.status,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (!config.byWorkspace) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "NOT_FOUND" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(config.byWorkspace), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
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

describe("getSlackBotToken", () => {
  it("returns token when workspace has a wired credential", async () => {
    const credId = "cred_slack_123";
    const accessToken = "xoxb-test-token-12345";

    const mock = mockLinkFetch({
      byWorkspace: { credential_id: credId, app_id: "A012ABCD" },
      fullCredentials: {
        [credId]: {
          id: credId,
          provider: "slack-app",
          type: "oauth",
          secret: { externalId: "A012ABCD", access_token: accessToken, token_type: "bot" },
        },
      },
    });

    try {
      const token = await getSlackBotToken("my-workspace");
      expect(token).toEqual(accessToken);
    } finally {
      mock.restore();
    }
  });

  it("returns null when no credential is wired to the workspace (404)", async () => {
    const mock = mockLinkFetch({ byWorkspace: null });

    try {
      const token = await getSlackBotToken("my-workspace");
      expect(token).toBeNull();
    } finally {
      mock.restore();
    }
  });

  it("returns null when credential token is pending", async () => {
    const credId = "cred_pending";

    const mock = mockLinkFetch({
      byWorkspace: { credential_id: credId, app_id: "A_PENDING" },
      fullCredentials: {
        [credId]: {
          id: credId,
          provider: "slack-app",
          type: "oauth",
          secret: { externalId: "A_PENDING", access_token: "pending", token_type: "bot" },
        },
      },
    });

    try {
      const token = await getSlackBotToken("my-workspace");
      expect(token).toBeNull();
    } finally {
      mock.restore();
    }
  });

  it("throws when by-workspace endpoint returns non-404 error", async () => {
    const mock = mockLinkFetch({
      byWorkspaceError: { status: 500, body: "Internal server error" },
    });

    try {
      await expect(getSlackBotToken("my-workspace")).rejects.toThrow(
        "Failed to resolve slack-app for workspace",
      );
    } finally {
      mock.restore();
    }
  });

  it("throws when credential fetch fails with non-404 error", async () => {
    const credId = "cred_abc";

    const mock = mockLinkFetch({
      byWorkspace: { credential_id: credId, app_id: "A001" },
      credentialError: { status: 500, error: "Internal server error" },
    });

    try {
      await expect(getSlackBotToken("my-workspace")).rejects.toThrow("Failed to fetch credential");
    } finally {
      mock.restore();
    }
  });
});
