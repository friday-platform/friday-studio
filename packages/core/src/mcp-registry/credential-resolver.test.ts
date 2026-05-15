import process from "node:process";
import type { MCPServerConfig } from "@atlas/config";
import { createLogger } from "@atlas/logger";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CredentialNotFoundError,
  findMissingServerEnvVars,
  hasUnusableCredentialCause,
  InvalidProviderError,
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
  LinkCredentialUnavailableError,
  NoDefaultCredentialError,
  readEnvVar,
  resolveCredentialsByProvider,
  resolveEnvValues,
} from "./credential-resolver.ts";

/** Minimal MCPServerConfig — only `env`/`auth` matter for env-var checks. */
function makeServer(partial: Partial<MCPServerConfig>): MCPServerConfig {
  return { transport: { type: "stdio", command: "noop" }, ...partial } as MCPServerConfig;
}

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

  // Env-var fallback: a bundled atlas agent declares a Link credential
  // requirement (e.g. hubspot's HUBSPOT_ACCESS_TOKEN), the user has set
  // that env var in `~/.friday/local/.env` instead of configuring a Link
  // credential via Settings → Connections, the runtime works because the
  // bundled agent reads from env directly. The validator path used to
  // reject the workspace upload with `missing_providers: ["hubspot"]`
  // even though everything works at runtime — the fallback below makes
  // resolveCredentialsByProvider accept the env var as a configured
  // credential and synthesize a CredentialSummary for it.
  describe("env-var fallback (~/.friday/local/.env)", () => {
    const ENV_KEY = "HUBSPOT_ACCESS_TOKEN";
    let originalValue: string | undefined;

    beforeEach(() => {
      originalValue = process.env[ENV_KEY];
    });

    afterEach(() => {
      if (originalValue === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = originalValue;
    });

    it("returns a synthetic 'env:' credential when InvalidProviderError would have fired but env is set", async () => {
      // Link service has no record of hubspot AND no credentials —
      // would normally throw InvalidProviderError ("not a registered
      // provider"). With env-var fallback + HUBSPOT_ACCESS_TOKEN set,
      // we synthesize a CredentialSummary instead.
      globalThis.fetch = mockSummaryFetch("hubspot", [], []);
      process.env[ENV_KEY] = "pat-na2-fake-test-token";

      const credentials = await resolveCredentialsByProvider("hubspot");
      expect(credentials.length).toEqual(1);
      // biome-ignore lint/style/noNonNullAssertion: length asserted above
      expect(credentials[0]!.id).toEqual(`env:${ENV_KEY}`);
      // biome-ignore lint/style/noNonNullAssertion: length asserted above
      expect(credentials[0]!.provider).toEqual("hubspot");
      // biome-ignore lint/style/noNonNullAssertion: length asserted above
      expect(credentials[0]!.type).toEqual("env");
      // biome-ignore lint/style/noNonNullAssertion: length asserted above
      expect(credentials[0]!.isDefault).toEqual(true);
    });

    it("returns a synthetic 'env:' credential when CredentialNotFoundError would have fired but env is set", async () => {
      // Link service knows about hubspot but has zero credentials —
      // would normally throw CredentialNotFoundError. Env-var fallback
      // takes priority over throwing.
      globalThis.fetch = mockSummaryFetch("hubspot", [], [{ id: "hubspot" }]);
      process.env[ENV_KEY] = "pat-na2-fake-test-token";

      const credentials = await resolveCredentialsByProvider("hubspot");
      expect(credentials.length).toEqual(1);
      // biome-ignore lint/style/noNonNullAssertion: length asserted above
      expect(credentials[0]!.id).toEqual(`env:${ENV_KEY}`);
    });

    it("does NOT fall back to env when env var is unset", async () => {
      delete process.env[ENV_KEY];
      globalThis.fetch = mockSummaryFetch("hubspot", [], []);

      const error = await resolveCredentialsByProvider("hubspot").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidProviderError);
    });

    it("does NOT fall back for providers with no bundled-agent declaration (no envKey to map)", async () => {
      // Set an env var to prove that env-presence alone isn't enough —
      // we need a known mapping from provider → envKey via the bundled
      // agents registry. Random env vars don't get treated as
      // credentials.
      process.env.SOMETHING_RANDOM = "x";
      globalThis.fetch = mockSummaryFetch("nonexistent-provider-xyz", [], []);

      const error = await resolveCredentialsByProvider("nonexistent-provider-xyz").catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(InvalidProviderError);
      delete process.env.SOMETHING_RANDOM;
    });
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

describe("readEnvVar", () => {
  afterEach(() => {
    delete process.env.READ_ENV_VAR_TEST;
  });

  it("returns the overlay value when present", () => {
    process.env.READ_ENV_VAR_TEST = "from-process";
    expect(readEnvVar("READ_ENV_VAR_TEST", { READ_ENV_VAR_TEST: "from-overlay" })).toBe(
      "from-overlay",
    );
  });

  it("falls back to process.env when the key is not in the overlay", () => {
    process.env.READ_ENV_VAR_TEST = "from-process";
    expect(readEnvVar("READ_ENV_VAR_TEST", { OTHER: "x" })).toBe("from-process");
  });

  it("returns undefined when the key is in neither", () => {
    expect(readEnvVar("READ_ENV_VAR_TEST", {})).toBeUndefined();
    expect(readEnvVar("READ_ENV_VAR_TEST")).toBeUndefined();
  });
});

describe("findMissingServerEnvVars", () => {
  afterEach(() => {
    delete process.env.FMSEV_TOKEN;
  });

  it("returns nothing when the server declares no env or auth", () => {
    expect(findMissingServerEnvVars("s1", makeServer({}))).toEqual([]);
  });

  it("flags an `auto` / `from_environment` var that resolves nowhere", () => {
    const config = makeServer({ env: { FMSEV_TOKEN: "from_environment", REGION: "auto" } });
    expect(findMissingServerEnvVars("s1", config, {})).toEqual([
      { serverId: "s1", varName: "FMSEV_TOKEN" },
      { serverId: "s1", varName: "REGION" },
    ]);
  });

  it("treats an overlay value as resolving the var", () => {
    const config = makeServer({ env: { FMSEV_TOKEN: "from_environment" } });
    expect(findMissingServerEnvVars("s1", config, { FMSEV_TOKEN: "x" })).toEqual([]);
  });

  it("treats a process.env value as resolving the var", () => {
    process.env.FMSEV_TOKEN = "from-process";
    const config = makeServer({ env: { FMSEV_TOKEN: "from_environment" } });
    expect(findMissingServerEnvVars("s1", config, {})).toEqual([]);
  });

  it("ignores literal env values — only sentinels are checked", () => {
    const config = makeServer({ env: { FMSEV_TOKEN: "literal-value" } });
    expect(findMissingServerEnvVars("s1", config, {})).toEqual([]);
  });

  it("flags a bare auth.token_env with no matching env entry", () => {
    const config = makeServer({ auth: { type: "bearer", token_env: "FMSEV_TOKEN" } });
    expect(findMissingServerEnvVars("s1", config, {})).toEqual([
      { serverId: "s1", varName: "FMSEV_TOKEN" },
    ]);
  });

  it("does not double-check token_env when env already declares it", () => {
    const config = makeServer({
      auth: { type: "bearer", token_env: "FMSEV_TOKEN" },
      env: { FMSEV_TOKEN: "from_environment" },
    });
    // Reported once by the env loop, not again by the auth check.
    expect(findMissingServerEnvVars("s1", config, {})).toEqual([
      { serverId: "s1", varName: "FMSEV_TOKEN" },
    ]);
  });
});

describe("resolveEnvValues with workspace .env overlay", () => {
  const logger = createLogger({ name: "test", level: "silent" });

  afterEach(() => {
    delete process.env.OVERLAY_TEST_VAR;
  });

  it("resolves a from_environment entry from the overlay", async () => {
    delete process.env.OVERLAY_TEST_VAR;
    const resolved = await resolveEnvValues({ OVERLAY_TEST_VAR: "from_environment" }, logger, {
      OVERLAY_TEST_VAR: "overlay-value",
    });
    expect(resolved.OVERLAY_TEST_VAR).toBe("overlay-value");
  });

  it("the overlay takes precedence over process.env", async () => {
    process.env.OVERLAY_TEST_VAR = "process-value";
    const resolved = await resolveEnvValues({ OVERLAY_TEST_VAR: "auto" }, logger, {
      OVERLAY_TEST_VAR: "overlay-value",
    });
    expect(resolved.OVERLAY_TEST_VAR).toBe("overlay-value");
  });

  it("falls back to process.env when the key is not in the overlay", async () => {
    process.env.OVERLAY_TEST_VAR = "process-value";
    const resolved = await resolveEnvValues({ OVERLAY_TEST_VAR: "from_environment" }, logger, {
      UNRELATED: "x",
    });
    expect(resolved.OVERLAY_TEST_VAR).toBe("process-value");
  });

  it("resolves to empty string when the var is in neither the overlay nor process.env", async () => {
    delete process.env.OVERLAY_TEST_VAR;
    const resolved = await resolveEnvValues({ OVERLAY_TEST_VAR: "auto" }, logger, {
      UNRELATED: "x",
    });
    expect(resolved.OVERLAY_TEST_VAR).toBe("");
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
      error: new LinkCredentialExpiredError("cred_2", "expired_no_refresh", "expired, no refresh"),
    },
    {
      name: "LinkCredentialExpiredError (refresh_failed)",
      error: new LinkCredentialExpiredError("cred_3", "refresh_failed", "refresh failed"),
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
      linkError: "transient refresh failure (network)",
    });
    expect(hasUnusableCredentialCause(error)).toBe(false);
  });
});

// =============================================================================
// LinkCredentialUnavailableError
// =============================================================================

describe("LinkCredentialUnavailableError", () => {
  it("error message is Link's `error` field verbatim — no rewriting", () => {
    const linkError =
      "transient refresh failure (network): tcp connect error: Connection refused (os error 61)";
    const error = new LinkCredentialUnavailableError({
      credentialId: "cred_x",
      linkError,
      serverName: "slack",
    });
    // The .message MUST be exactly what Link returned. Don't translate,
    // polish, or wrap it — operators and the LLM both need the raw signal.
    expect(error.message).toBe(linkError);
  });

  it("exposes linkError + serverName as readable fields for callers", () => {
    const error = new LinkCredentialUnavailableError({
      credentialId: "cred_y",
      linkError: "some upstream detail",
      serverName: "slack",
    });
    expect(error.linkError).toBe("some upstream detail");
    expect(error.serverName).toBe("slack");
    expect(error.credentialId).toBe("cred_y");
  });
});
