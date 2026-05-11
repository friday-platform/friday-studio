import process from "node:process";
import { createLogger } from "@atlas/logger";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CredentialNotFoundError,
  hasUnusableCredentialCause,
  InvalidProviderError,
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
  LinkCredentialUnavailableError,
  NoDefaultCredentialError,
  resolveCredentialsByProvider,
  resolveEnvValues,
} from "./credential-resolver.ts";

// =============================================================================
// Mock Fetch Helpers
// =============================================================================

const LINK_BASE_URL = "http://127.0.0.1:8080/api/link";

type MockCredential = {
  id: string;
  provider: string;
  label: string;
  type: string;
  displayName: string | null;
  userIdentifier: string | null;
  isDefault: boolean;
};

/**
 * Create mock fetch that returns summary for a provider.
 */
function mockSummaryFetch(
  provider: string,
  credentials: MockCredential[],
  providers: { id: string }[] = [{ id: provider }],
): typeof fetch {
  const url = `${LINK_BASE_URL}/v1/summary?provider=${provider}`;

  return (input: RequestInfo | URL) => {
    const requestUrl = typeof input === "string" ? input : input.toString();
    if (requestUrl !== url) {
      throw new Error(`Mock not configured for URL: ${requestUrl}`);
    }

    return Promise.resolve(
      new Response(JSON.stringify({ providers, credentials }), {
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

type MockStatus = "ready" | "expired_no_refresh" | "refresh_failed" | "refresh_unavailable";

/** Default credential lookup by provider (keyed by provider name) */
type MockDefaultCredentialEntry = { credential: MockFullCredential; status?: MockStatus };
type MockDefaultCredentials = Record<string, MockFullCredential | MockDefaultCredentialEntry>;

/** Per-id credential lookup that can carry a non-"ready" status. */
type MockFullCredentialEntry = { credential: MockFullCredential; status?: MockStatus };
type MockFullCredentials = Record<string, MockFullCredential | MockFullCredentialEntry>;

/**
 * Create mock fetch that handles summary, credential-by-id, and default credential endpoints.
 * Used for testing full resolveEnvValues flow.
 */
function mockLinkFetch(
  provider: string,
  summaryCredentials: MockCredential[],
  fullCredentials: MockFullCredentials,
  defaultCredentials?: MockDefaultCredentials,
): typeof fetch {
  const summaryUrl = `${LINK_BASE_URL}/v1/summary?provider=${provider}`;
  const internalUrlPrefix = `${LINK_BASE_URL}/internal/v1/credentials/`;
  const defaultUrlPrefix = `${LINK_BASE_URL}/internal/v1/credentials/default/`;

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

    // Handle default credential endpoint (must check before generic internal prefix)
    if (requestUrl.startsWith(defaultUrlPrefix)) {
      const providerName = requestUrl.slice(defaultUrlPrefix.length);
      const entry = defaultCredentials?.[providerName];

      if (!entry) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "no_default_credential" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      // Support both plain credential object and { credential, status } entry
      const credential = "credential" in entry ? entry.credential : entry;
      const status = "credential" in entry ? (entry.status ?? "ready") : "ready";

      return Promise.resolve(
        new Response(JSON.stringify({ credential, status }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    // Handle internal credential-by-id endpoint
    if (requestUrl.startsWith(internalUrlPrefix)) {
      const credId = requestUrl.slice(internalUrlPrefix.length);
      const entry = fullCredentials[credId];

      if (!entry) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "Not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      const credential = "credential" in entry ? entry.credential : entry;
      const status = "credential" in entry ? (entry.status ?? "ready") : "ready";

      return Promise.resolve(
        new Response(JSON.stringify({ credential, status }), {
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
  process.env.LINK_DEV_MODE = "true"; // Use dev mode to skip FRIDAY_KEY auth
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
      {
        id: "cred_abc",
        provider: "slack",
        label: "Work",
        type: "oauth",
        displayName: "Slack",
        userIdentifier: "work@example.com",
        isDefault: true,
      },
    ]);

    const credentials = await resolveCredentialsByProvider("slack");
    expect(credentials.length).toEqual(1);
    // biome-ignore lint/style/noNonNullAssertion: length assertion above guarantees [0] exists
    expect(credentials[0]!.id).toEqual("cred_abc");
  });

  it("throws CredentialNotFoundError when none exist", async () => {
    globalThis.fetch = mockSummaryFetch("slack", []);

    const error = await resolveCredentialsByProvider("slack").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialNotFoundError);
    expect((error as Error).message).toContain("No credentials found for provider 'slack'");
  });

  it("throws InvalidProviderError when provider is not registered", async () => {
    globalThis.fetch = mockSummaryFetch("nonexistent", [], []);

    const error = await resolveCredentialsByProvider("nonexistent").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidProviderError);
    expect((error as Error).message).toContain("not a registered provider");
  });

  it("returns all credentials when multiple exist", async () => {
    globalThis.fetch = mockSummaryFetch("slack", [
      {
        id: "cred_abc",
        provider: "slack",
        label: "Work",
        type: "oauth",
        displayName: "Slack",
        userIdentifier: "work@example.com",
        isDefault: true,
      },
      {
        id: "cred_xyz",
        provider: "slack",
        label: "Personal",
        type: "oauth",
        displayName: "Slack",
        userIdentifier: "personal@example.com",
        isDefault: false,
      },
    ]);

    const credentials = await resolveCredentialsByProvider("slack");
    expect(credentials.length).toEqual(2);
    // biome-ignore lint/style/noNonNullAssertion: length assertion above guarantees indices exist
    expect(credentials[0]!.id).toEqual("cred_abc");
    // biome-ignore lint/style/noNonNullAssertion: length assertion above guarantees indices exist
    expect(credentials[1]!.id).toEqual("cred_xyz");
  });
});

describe("LinkCredentialNotFoundError", () => {
  it("is thrown when fetching a non-existent credential", async () => {
    const logger = createLogger({ name: "test", level: "silent" });
    const nonExistentCredId = "does_not_exist_xyz";

    globalThis.fetch = mockLinkFetch("any-provider", [], {});

    const env = {
      SOME_TOKEN: { from: "link" as const, id: nonExistentCredId, key: "access_token" },
    };

    const error = await resolveEnvValues(env, logger).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinkCredentialNotFoundError);
    expect((error as LinkCredentialNotFoundError).credentialId).toEqual(nonExistentCredId);
  });
});

// =============================================================================
// resolveEnvValues — provider-only refs use default credential
// =============================================================================

describe("resolveEnvValues with provider-only ref", () => {
  const logger = createLogger({ name: "test", level: "silent" });

  it("fetches default credential for provider-only ref", async () => {
    const fakeAccessToken = "ya29.fake-google-access-token-for-testing";
    const credId = "cred_google_calendar_abc";

    globalThis.fetch = mockLinkFetch(
      "google-calendar",
      [],
      {},
      {
        "google-calendar": {
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
    expect(token).toEqual(fakeAccessToken);
    expect(token?.startsWith("ya29.")).toEqual(true);
  });

  it("throws NoDefaultCredentialError when no default exists", async () => {
    globalThis.fetch = mockLinkFetch("slack", [], {});

    const env = { SLACK_TOKEN: { from: "link" as const, provider: "slack", key: "access_token" } };

    const error = await resolveEnvValues(env, logger).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoDefaultCredentialError);
    expect((error as NoDefaultCredentialError).provider).toEqual("slack");
  });

  it("throws LinkCredentialExpiredError when default credential is expired_no_refresh", async () => {
    globalThis.fetch = mockLinkFetch(
      "google-calendar",
      [],
      {},
      {
        "google-calendar": {
          credential: {
            id: "cred_expired",
            provider: "google-calendar",
            type: "oauth",
            secret: { access_token: "expired-token" },
          },
          status: "expired_no_refresh",
        },
      },
    );

    const env = {
      GOOGLE_CALENDAR_TOKEN: {
        from: "link" as const,
        provider: "google-calendar",
        key: "access_token",
      },
    };

    const error = await resolveEnvValues(env, logger).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinkCredentialExpiredError);
    expect((error as LinkCredentialExpiredError).credentialId).toEqual("cred_expired");
  });

  it("throws LinkCredentialExpiredError when default credential refresh fails", async () => {
    globalThis.fetch = mockLinkFetch(
      "slack",
      [],
      {},
      {
        slack: {
          credential: {
            id: "cred_refresh_fail",
            provider: "slack",
            type: "oauth",
            secret: { access_token: "stale-token" },
          },
          status: "refresh_failed",
        },
      },
    );

    const env = { SLACK_TOKEN: { from: "link" as const, provider: "slack", key: "access_token" } };

    const error = await resolveEnvValues(env, logger).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinkCredentialExpiredError);
    expect((error as LinkCredentialExpiredError).credentialId).toEqual("cred_refresh_fail");
  });

  it("throws LinkCredentialUnavailableError when default credential is refresh_unavailable", async () => {
    globalThis.fetch = mockLinkFetch(
      "google-calendar",
      [],
      {},
      {
        "google-calendar": {
          credential: {
            id: "cred_transient",
            provider: "google-calendar",
            type: "oauth",
            secret: { access_token: "still-valid-token" },
          },
          status: "refresh_unavailable",
        },
      },
    );

    const env = {
      GOOGLE_CALENDAR_TOKEN: {
        from: "link" as const,
        provider: "google-calendar",
        key: "access_token",
      },
    };

    const error = await resolveEnvValues(env, logger).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinkCredentialUnavailableError);
    expect((error as LinkCredentialUnavailableError).credentialId).toEqual("cred_transient");
  });

  it("throws LinkCredentialUnavailableError when explicit id credential is refresh_unavailable", async () => {
    const credId = "cred_id_transient";
    globalThis.fetch = mockLinkFetch("any-provider", [], {
      [credId]: {
        credential: {
          id: credId,
          provider: "google-drive",
          type: "oauth",
          secret: { access_token: "still-valid-token" },
        },
        status: "refresh_unavailable",
      },
    });

    const env = { DRIVE_TOKEN: { from: "link" as const, id: credId, key: "access_token" } };

    const error = await resolveEnvValues(env, logger).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinkCredentialUnavailableError);
    expect((error as LinkCredentialUnavailableError).credentialId).toEqual(credId);
  });

  it("throws when default credential is missing requested secret key", async () => {
    const credId = "cred_drive_no_token";

    globalThis.fetch = mockLinkFetch(
      "google-drive",
      [],
      {},
      {
        "google-drive": {
          id: credId,
          provider: "google-drive",
          type: "oauth",
          secret: { refresh_token: "only-refresh" },
        },
      },
    );

    const env = {
      DRIVE_TOKEN: { from: "link" as const, provider: "google-drive", key: "access_token" },
    };

    await expect(() => resolveEnvValues(env, logger)).rejects.toThrow(
      "Key 'access_token' not found in credential",
    );
  });
});

// =============================================================================
// resolveEnvValues — explicit id refs unchanged
// =============================================================================

describe("resolveEnvValues with explicit id ref", () => {
  const logger = createLogger({ name: "test", level: "silent" });

  it("fetches credential by id directly", async () => {
    const credId = "cred_explicit_123";

    globalThis.fetch = mockLinkFetch("slack", [], {
      [credId]: {
        id: credId,
        provider: "slack",
        type: "oauth",
        secret: { access_token: "xoxb-explicit" },
      },
    });

    const env = { SLACK_TOKEN: { from: "link" as const, id: credId, key: "access_token" } };

    const resolved = await resolveEnvValues(env, logger);
    expect(resolved.SLACK_TOKEN).toEqual("xoxb-explicit");
  });
});

// =============================================================================
// hasUnusableCredentialCause
// =============================================================================

describe("hasUnusableCredentialCause", () => {
  it.each([
    { name: "LinkCredentialNotFoundError", error: new LinkCredentialNotFoundError("cred_1") },
    {
      name: "LinkCredentialExpiredError (expired_no_refresh)",
      error: new LinkCredentialExpiredError("cred_2", "expired_no_refresh"),
    },
    {
      name: "LinkCredentialExpiredError (refresh_failed)",
      error: new LinkCredentialExpiredError("cred_3", "refresh_failed"),
    },
    { name: "NoDefaultCredentialError", error: new NoDefaultCredentialError("slack") },
  ])("returns true for direct $name", ({ error }) => {
    expect(hasUnusableCredentialCause(error)).toBe(true);
  });

  it("returns true when credential error is nested in cause chain", () => {
    const inner = new LinkCredentialNotFoundError("cred_deep");
    const middle = new Error("middle");
    middle.cause = inner;
    const outer = new Error("outer");
    outer.cause = middle;

    expect(hasUnusableCredentialCause(outer)).toBe(true);
  });

  it.each([
    { name: "generic Error", error: new Error("connection refused") },
    { name: "TypeError", error: new TypeError("oops") },
    { name: "string", error: "not an error" },
    { name: "null", error: null },
    { name: "undefined", error: undefined },
  ])("returns false for $name", ({ error }) => {
    expect(hasUnusableCredentialCause(error)).toBe(false);
  });

  it("returns false for LinkCredentialUnavailableError (transient, not unusable)", () => {
    const error = new LinkCredentialUnavailableError({
      credentialId: "cred_pending",
      serverName: "google-calendar",
    });
    expect(hasUnusableCredentialCause(error)).toBe(false);
  });
});

// =============================================================================
// LinkCredentialUnavailableError
// =============================================================================

describe("LinkCredentialUnavailableError", () => {
  it("singular constructor produces entries array of length 1", () => {
    const error = new LinkCredentialUnavailableError({
      credentialId: "cred_1",
      serverName: "google-calendar",
      provider: "google-calendar",
    });

    expect(error.entries.length).toEqual(1);
    expect(error.entries[0]).toEqual({
      credentialId: "cred_1",
      serverName: "google-calendar",
      provider: "google-calendar",
    });
    expect(error.credentialId).toEqual("cred_1");
    expect(error.serverName).toEqual("google-calendar");
  });

  it("multi-entry constructor preserves order in entries", () => {
    const entries = [
      { credentialId: "cred_a", serverName: "calendar", provider: "google-calendar" },
      { credentialId: "cred_b", serverName: "drive", provider: "google-drive" },
      { credentialId: "cred_c", serverName: "gmail", provider: "google-gmail" },
    ];
    const error = new LinkCredentialUnavailableError({ entries });

    expect(error.entries).toEqual(entries);
    expect(error.credentialId).toEqual("cred_a");
    expect(error.serverName).toEqual("calendar");
  });

  it("throws at construction when entries array is empty", () => {
    expect(() => new LinkCredentialUnavailableError({ entries: [] })).toThrow(
      "LinkCredentialUnavailableError requires at least one entry",
    );
  });

  it("error message lists all affected servers", () => {
    const error = new LinkCredentialUnavailableError({
      entries: [
        { credentialId: "cred_a", serverName: "calendar" },
        { credentialId: "cred_b", serverName: "drive" },
      ],
    });

    expect(error.message).toContain("'calendar'");
    expect(error.message).toContain("'drive'");
  });

  it("error message names a single server", () => {
    const error = new LinkCredentialUnavailableError({
      credentialId: "cred_x",
      serverName: "slack",
    });
    expect(error.message).toContain("'slack'");
  });
});
