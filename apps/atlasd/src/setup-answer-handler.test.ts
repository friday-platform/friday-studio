/**
 * Unit tests for the workspace-setup elicitation answer commit pipeline.
 *
 * The handler composes three external side-effects: Link credential lookups
 * (for pre-flight ownership checks), `setEnvFileVar` (env writes), and
 * `applyDraftAwareMutation` (credential pin batch). Each is mocked here so
 * the tests stay file-system / network free and focus on the dispatch logic
 * — Decision 6's pre-flight-then-commit ordering, the per-field error
 * collection, and the partial-failure idempotency guarantee.
 */

import { type WorkspaceConfig, WorkspaceConfigSchema } from "@atlas/config";
import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  mockFetchLinkCredential,
  mockSetEnvFileVar,
  mockApplyDraftAwareMutation,
  MockLinkCredentialNotFoundError,
} = vi.hoisted(() => {
  class MockNotFoundError extends Error {
    readonly credentialId: string;
    constructor(credentialId: string) {
      super(`Credential ${credentialId} not found`);
      this.name = "LinkCredentialNotFoundError";
      this.credentialId = credentialId;
    }
  }
  return {
    mockFetchLinkCredential: vi.fn(),
    mockSetEnvFileVar: vi.fn(),
    mockApplyDraftAwareMutation: vi.fn(),
    MockLinkCredentialNotFoundError: MockNotFoundError,
  };
});

vi.mock("@atlas/core/mcp-registry/credential-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@atlas/core/mcp-registry/credential-resolver")>()),
  fetchLinkCredential: mockFetchLinkCredential,
  LinkCredentialNotFoundError: MockLinkCredentialNotFoundError,
}));

vi.mock("@atlas/workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@atlas/workspace")>()),
  setEnvFileVar: mockSetEnvFileVar,
}));

vi.mock("../routes/workspaces/draft-helpers.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../routes/workspaces/draft-helpers.ts")>()),
  applyDraftAwareMutation: mockApplyDraftAwareMutation,
}));

// Import AFTER mocks so the handler binds to them.
import { commitWorkspaceSetupAnswer } from "./setup-answer-handler.ts";

/**
 * Build a `WorkspaceConfig` by parsing through the schema — strict
 * properties (e.g. `tools.mcp.client_config`) get defaulted in by Zod, so we
 * don't have to spell them out by hand in every test fixture.
 */
function makeConfig(
  servers: Record<string, { provider: string }> = { gmail: { provider: "gmail" } },
): WorkspaceConfig {
  const mcpServers: Record<string, unknown> = {};
  for (const [serverId, { provider }] of Object.entries(servers)) {
    mcpServers[serverId] = {
      transport: { type: "stdio", command: "echo" },
      env: { [`${provider.toUpperCase()}_TOKEN`]: { from: "link", provider, key: "access_token" } },
    };
  }
  return WorkspaceConfigSchema.parse({
    version: "1.0",
    workspace: { name: "test-ws" },
    variables: {
      email_recipient: { schema: { type: "string", format: "email" } },
      threshold: { schema: { type: "integer", minimum: 0, maximum: 100 } },
    },
    tools: { mcp: { servers: mcpServers } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApplyDraftAwareMutation.mockResolvedValue({
    result: { ok: true, value: makeConfig() },
    wroteToDraft: false,
  });
});

describe("commitWorkspaceSetupAnswer — pre-flight validation", () => {
  test("returns a per-field error map on schema-failing variable values without writing", async () => {
    mockFetchLinkCredential.mockResolvedValue({
      id: "cred_gmail",
      provider: "gmail",
      type: "oauth2",
      secret: {},
    });

    const outcome = await commitWorkspaceSetupAnswer({
      workspacePath: "/tmp/ws_1",
      parsedConfig: makeConfig(),
      answer: {
        variableValues: { email_recipient: "not-an-email", threshold: 999 },
        credentialChoices: { gmail: "cred_gmail" },
      },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(400);
    if (outcome.status !== 400) return;
    expect(outcome.errors.variables).toHaveProperty("email_recipient");
    expect(outcome.errors.variables).toHaveProperty("threshold");
    expect(outcome.errors.credentials).toEqual({});
    expect(mockSetEnvFileVar).not.toHaveBeenCalled();
    expect(mockApplyDraftAwareMutation).not.toHaveBeenCalled();
  });

  test("collects unknown variable names into the error map", async () => {
    const outcome = await commitWorkspaceSetupAnswer({
      workspacePath: "/tmp/ws_1",
      parsedConfig: makeConfig(),
      answer: { variableValues: { undeclared_var: "anything" }, credentialChoices: {} },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(400);
    if (outcome.status !== 400) return;
    expect(outcome.errors.variables.undeclared_var).toContain("not declared");
    expect(mockSetEnvFileVar).not.toHaveBeenCalled();
  });

  test("rejects credentials that Link does not own / cannot find", async () => {
    mockFetchLinkCredential.mockRejectedValue(new MockLinkCredentialNotFoundError("cred_missing"));

    const outcome = await commitWorkspaceSetupAnswer({
      workspacePath: "/tmp/ws_1",
      parsedConfig: makeConfig(),
      answer: {
        variableValues: { email_recipient: "user@example.com", threshold: 50 },
        credentialChoices: { gmail: "cred_missing" },
      },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(400);
    if (outcome.status !== 400) return;
    expect(outcome.errors.credentials.gmail).toContain("not found");
    // Pre-flight failure: NO writes — env or credential — happen.
    expect(mockSetEnvFileVar).not.toHaveBeenCalled();
    expect(mockApplyDraftAwareMutation).not.toHaveBeenCalled();
  });

  test("rejects a credential whose provider doesn't match the requested provider", async () => {
    mockFetchLinkCredential.mockResolvedValue({
      id: "cred_slack",
      provider: "slack",
      type: "oauth2",
      secret: {},
    });

    const outcome = await commitWorkspaceSetupAnswer({
      workspacePath: "/tmp/ws_1",
      parsedConfig: makeConfig(),
      answer: {
        variableValues: { email_recipient: "user@example.com", threshold: 50 },
        credentialChoices: { gmail: "cred_slack" },
      },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(400);
    if (outcome.status !== 400) return;
    expect(outcome.errors.credentials.gmail).toContain("slack");
  });
});

describe("commitWorkspaceSetupAnswer — commit ordering", () => {
  test("commits env writes first, then credential pins, returning the committed env keys", async () => {
    mockFetchLinkCredential.mockResolvedValue({
      id: "cred_gmail",
      provider: "gmail",
      type: "oauth2",
      secret: {},
    });

    const outcome = await commitWorkspaceSetupAnswer({
      workspacePath: "/tmp/ws_1",
      parsedConfig: makeConfig(),
      answer: {
        variableValues: { email_recipient: "user@example.com", threshold: 50 },
        credentialChoices: { gmail: "cred_gmail" },
      },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.committedKeys).toEqual(["EMAIL_RECIPIENT", "THRESHOLD"]);

    expect(mockSetEnvFileVar).toHaveBeenCalledWith(
      "/tmp/ws_1/.env",
      "EMAIL_RECIPIENT",
      "user@example.com",
    );
    expect(mockSetEnvFileVar).toHaveBeenCalledWith("/tmp/ws_1/.env", "THRESHOLD", "50");
    expect(mockApplyDraftAwareMutation).toHaveBeenCalledTimes(1);

    // Strict order: env writes commit before the credential mutation runs.
    const envOrder = mockSetEnvFileVar.mock.invocationCallOrder[0] ?? Infinity;
    const credOrder = mockApplyDraftAwareMutation.mock.invocationCallOrder[0] ?? Infinity;
    expect(envOrder).toBeLessThan(credOrder);
  });

  test("partial commit: credential pin failure leaves env keys committed for idempotent retry", async () => {
    mockFetchLinkCredential.mockResolvedValue({
      id: "cred_gmail",
      provider: "gmail",
      type: "oauth2",
      secret: {},
    });
    mockApplyDraftAwareMutation.mockResolvedValueOnce({
      result: {
        ok: false,
        error: { type: "not_found", entityId: "mcp:gmail:GMAIL_TOKEN", entityType: "credential" },
      },
      wroteToDraft: false,
    });

    const outcome = await commitWorkspaceSetupAnswer({
      workspacePath: "/tmp/ws_1",
      parsedConfig: makeConfig(),
      answer: {
        variableValues: { email_recipient: "user@example.com", threshold: 50 },
        credentialChoices: { gmail: "cred_gmail" },
      },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(500);
    if (outcome.status !== 500) return;
    expect(outcome.committedKeys).toEqual(["EMAIL_RECIPIENT", "THRESHOLD"]);
    expect(outcome.message).toContain("not_found");
  });

  test("skips the credential mutation when no credentialChoices were given", async () => {
    const outcome = await commitWorkspaceSetupAnswer({
      workspacePath: "/tmp/ws_1",
      parsedConfig: makeConfig(),
      answer: {
        variableValues: { email_recipient: "user@example.com", threshold: 50 },
        credentialChoices: {},
      },
    });

    expect(outcome.ok).toBe(true);
    expect(mockSetEnvFileVar).toHaveBeenCalledTimes(2);
    expect(mockApplyDraftAwareMutation).not.toHaveBeenCalled();
  });

  test("an env-write failure short-circuits and reports the committed-so-far keys", async () => {
    mockFetchLinkCredential.mockResolvedValue({
      id: "cred_gmail",
      provider: "gmail",
      type: "oauth2",
      secret: {},
    });
    mockSetEnvFileVar
      .mockImplementationOnce(() => {
        // first call (EMAIL_RECIPIENT) succeeds
      })
      .mockImplementationOnce(() => {
        throw new Error("disk full");
      });

    const outcome = await commitWorkspaceSetupAnswer({
      workspacePath: "/tmp/ws_1",
      parsedConfig: makeConfig(),
      answer: {
        variableValues: { email_recipient: "user@example.com", threshold: 50 },
        credentialChoices: { gmail: "cred_gmail" },
      },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(500);
    if (outcome.status !== 500) return;
    expect(outcome.committedKeys).toEqual(["EMAIL_RECIPIENT"]);
    expect(outcome.message).toContain("disk full");
    expect(mockApplyDraftAwareMutation).not.toHaveBeenCalled();
  });
});

describe("commitWorkspaceSetupAnswer — credential plan", () => {
  test("fans out one chosen credential to every path referencing the provider", async () => {
    mockFetchLinkCredential.mockResolvedValue({
      id: "cred_gmail",
      provider: "gmail",
      type: "oauth2",
      secret: {},
    });

    const multiServerConfig = makeConfig({
      gmail_a: { provider: "gmail" },
      gmail_b: { provider: "gmail" },
    });

    const outcome = await commitWorkspaceSetupAnswer({
      workspacePath: "/tmp/ws_1",
      parsedConfig: multiServerConfig,
      answer: {
        variableValues: { email_recipient: "user@example.com", threshold: 50 },
        credentialChoices: { gmail: "cred_gmail" },
      },
    });

    expect(outcome.ok).toBe(true);
    expect(mockApplyDraftAwareMutation).toHaveBeenCalledTimes(1);
  });

  test("flags a credential choice for a provider the workspace doesn't reference", async () => {
    const outcome = await commitWorkspaceSetupAnswer({
      workspacePath: "/tmp/ws_1",
      parsedConfig: makeConfig(),
      answer: {
        variableValues: { email_recipient: "user@example.com", threshold: 50 },
        credentialChoices: { slack: "cred_slack" },
      },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(400);
    if (outcome.status !== 400) return;
    expect(outcome.errors.credentials.slack).toContain("not referenced");
    expect(mockFetchLinkCredential).not.toHaveBeenCalled();
  });
});
