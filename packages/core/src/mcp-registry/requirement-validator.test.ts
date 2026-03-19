import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateRequiredFields } from "./requirement-validator.ts";

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
function mockSummaryFetch(responses: Record<string, MockCredential[]>): typeof fetch {
  return (input: RequestInfo | URL) => {
    const requestUrl = typeof input === "string" ? input : input.toString();

    for (const [provider, credentials] of Object.entries(responses)) {
      const url = `${LINK_BASE_URL}/v1/summary?provider=${provider}`;
      if (requestUrl === url) {
        return Promise.resolve(
          new Response(JSON.stringify({ providers: [{ id: provider }], credentials }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
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
  process.env.LINK_DEV_MODE = "true";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDevMode === undefined) {
    delete process.env.LINK_DEV_MODE;
  } else {
    process.env.LINK_DEV_MODE = originalDevMode;
  }
});

// =============================================================================
// validateRequiredFields — bundled agent (no configTemplate)
// =============================================================================

describe("validateRequiredFields without configTemplate", () => {
  it("resolves when default credential exists", async () => {
    globalThis.fetch = mockSummaryFetch({
      slack: [
        {
          id: "cred_1",
          provider: "slack",
          label: "Work",
          type: "oauth",
          displayName: "Slack",
          userIdentifier: "work@co.com",
          isDefault: true,
        },
        {
          id: "cred_2",
          provider: "slack",
          label: "Personal",
          type: "oauth",
          displayName: "Slack",
          userIdentifier: "me@me.com",
          isDefault: false,
        },
      ],
    });

    const result = await validateRequiredFields([
      {
        from: "link",
        envKey: "SLACK_TOKEN",
        provider: "slack",
        key: "access_token",
        description: "Slack token",
      },
    ]);

    expect(result.resolvedCredentials).toHaveLength(1);
    expect(result.resolvedCredentials[0]).toMatchObject({
      field: "SLACK_TOKEN",
      provider: "slack",
      credentialId: "cred_1",
    });
    expect(result.missingCredentials).toHaveLength(0);
  });

  it("reports missing when no default credential exists", async () => {
    globalThis.fetch = mockSummaryFetch({
      slack: [
        {
          id: "cred_1",
          provider: "slack",
          label: "Work",
          type: "oauth",
          displayName: "Slack",
          userIdentifier: "work@co.com",
          isDefault: false,
        },
        {
          id: "cred_2",
          provider: "slack",
          label: "Personal",
          type: "oauth",
          displayName: "Slack",
          userIdentifier: "me@me.com",
          isDefault: false,
        },
      ],
    });

    const result = await validateRequiredFields([
      {
        from: "link",
        envKey: "SLACK_TOKEN",
        provider: "slack",
        key: "access_token",
        description: "Slack token",
      },
    ]);

    expect(result.missingCredentials).toHaveLength(1);
    expect(result.missingCredentials[0]).toMatchObject({
      field: "SLACK_TOKEN",
      reason: expect.stringContaining("No default credential"),
    });
    expect(result.resolvedCredentials).toHaveLength(0);
  });

  it("reports missing when no credentials exist at all", async () => {
    globalThis.fetch = mockSummaryFetch({ slack: [] });

    const result = await validateRequiredFields([
      {
        from: "link",
        envKey: "SLACK_TOKEN",
        provider: "slack",
        key: "access_token",
        description: "Slack token",
      },
    ]);

    expect(result.missingCredentials).toHaveLength(1);
    expect(result.missingCredentials[0]).toMatchObject({
      field: "SLACK_TOKEN",
      reason: expect.stringContaining("No credentials found"),
    });
  });
});

// =============================================================================
// validateRequiredFields — MCP server (with configTemplate)
// =============================================================================

describe("validateRequiredFields with configTemplate", () => {
  const configTemplate = {
    transport: { type: "stdio" as const, command: "test-server" },
    env: { SLACK_TOKEN: { from: "link" as const, provider: "slack", key: "access_token" } },
  };

  it("resolves when default credential exists", async () => {
    globalThis.fetch = mockSummaryFetch({
      slack: [
        {
          id: "cred_default",
          provider: "slack",
          label: "Work",
          type: "oauth",
          displayName: "Slack",
          userIdentifier: "work@co.com",
          isDefault: true,
        },
      ],
    });

    const result = await validateRequiredFields(
      [{ key: "SLACK_TOKEN", description: "Slack token", type: "string" as const }],
      configTemplate,
    );

    expect(result.resolvedCredentials).toHaveLength(1);
    expect(result.resolvedCredentials[0]).toMatchObject({
      field: "SLACK_TOKEN",
      provider: "slack",
      credentialId: "cred_default",
    });
    expect(result.missingCredentials).toHaveLength(0);
  });

  it("reports missing when no default credential exists", async () => {
    globalThis.fetch = mockSummaryFetch({
      slack: [
        {
          id: "cred_1",
          provider: "slack",
          label: "Work",
          type: "oauth",
          displayName: "Slack",
          userIdentifier: "work@co.com",
          isDefault: false,
        },
      ],
    });

    const result = await validateRequiredFields(
      [{ key: "SLACK_TOKEN", description: "Slack token", type: "string" as const }],
      configTemplate,
    );

    expect(result.missingCredentials).toHaveLength(1);
    expect(result.missingCredentials[0]).toMatchObject({
      field: "SLACK_TOKEN",
      reason: expect.stringContaining("No default credential"),
    });
    expect(result.resolvedCredentials).toHaveLength(0);
  });

  it("skips validation when credential has explicit id", async () => {
    const templateWithId = {
      transport: { type: "stdio" as const, command: "test-server" },
      env: {
        SLACK_TOKEN: {
          from: "link" as const,
          id: "cred_explicit_123",
          provider: "slack",
          key: "access_token",
        },
      },
    };

    const result = await validateRequiredFields(
      [{ key: "SLACK_TOKEN", description: "Slack token", type: "string" as const }],
      templateWithId,
    );

    // Skipped — no fetch calls needed, no resolved/missing
    expect(result.resolvedCredentials).toHaveLength(0);
    expect(result.missingCredentials).toHaveLength(0);
  });
});
