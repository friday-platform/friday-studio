import type { CredentialSummary } from "@atlas/core/mcp-registry/credential-resolver";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigRequirement } from "./classify-agents.ts";
import { resolveCredentials } from "./resolve-credentials.ts";

const mockResolveByProvider = vi.hoisted(() =>
  vi.fn<(provider: string) => Promise<CredentialSummary[]>>(),
);

const MockCredentialNotFoundError = vi.hoisted(
  () =>
    class CredentialNotFoundError extends Error {
      constructor(public readonly provider: string) {
        super(`No credentials found for provider '${provider}'`);
        this.name = "CredentialNotFoundError";
      }
    },
);

vi.mock("@atlas/core/mcp-registry/credential-resolver", () => ({
  resolveCredentialsByProvider: mockResolveByProvider,
  CredentialNotFoundError: MockCredentialNotFoundError,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(
  overrides: Partial<ConfigRequirement> & {
    agentId: string;
    requiredConfig: ConfigRequirement["requiredConfig"];
  },
): ConfigRequirement {
  return {
    agentId: overrides.agentId,
    agentName: overrides.agentName ?? `Agent ${overrides.agentId}`,
    integration: overrides.integration ?? { type: "bundled", bundledId: "test" },
    requiredConfig: overrides.requiredConfig,
  };
}

// ---------------------------------------------------------------------------
// resolveCredentials
// ---------------------------------------------------------------------------

describe("resolveCredentials", () => {
  afterEach(() => {
    mockResolveByProvider.mockReset();
  });

  it("returns all link fields as unresolved when skipLink is true", async () => {
    const requirements = [
      makeReq({
        agentId: "github-bot",
        integration: { type: "mcp", serverId: "github" },
        requiredConfig: [
          { key: "GH_TOKEN", description: "GitHub token", source: "link", provider: "github" },
          {
            key: "NOTION_ACCESS_TOKEN",
            description: "Notion token",
            source: "link",
            provider: "notion",
          },
        ],
      }),
    ];

    const result = await resolveCredentials(requirements, { skipLink: true });

    expect(result.bindings).toEqual([]);
    expect(result.unresolved).toEqual([
      {
        targetType: "mcp",
        targetId: "github",
        field: "GH_TOKEN",
        provider: "github",
        reason: "skipped",
      },
      {
        targetType: "mcp",
        targetId: "github",
        field: "NOTION_ACCESS_TOKEN",
        provider: "notion",
        reason: "skipped",
      },
    ]);
  });

  it("creates CredentialBinding when Link API resolves credential", async () => {
    mockResolveByProvider.mockResolvedValueOnce([
      {
        id: "cred_abc123",
        provider: "github",
        label: "tempestteam",
        type: "oauth2",
        displayName: "GitHub",
        userIdentifier: "tempestteam",
        isDefault: true,
      },
    ]);

    const requirements = [
      makeReq({
        agentId: "github-bot",
        integration: { type: "mcp", serverId: "github" },
        requiredConfig: [
          { key: "GH_TOKEN", description: "GitHub token", source: "link", provider: "github" },
        ],
      }),
    ];

    const result = await resolveCredentials(requirements);

    expect(result.bindings).toEqual([
      {
        targetType: "mcp",
        targetId: "github",
        field: "GH_TOKEN",
        credentialId: "cred_abc123",
        provider: "github",
        key: "access_token",
        label: "tempestteam",
      },
    ]);
    expect(result.unresolved).toEqual([]);
  });

  it("tracks unresolved with reason not_found when Link API throws CredentialNotFoundError", async () => {
    mockResolveByProvider.mockRejectedValueOnce(new MockCredentialNotFoundError("notion"));

    const requirements = [
      makeReq({
        agentId: "note-taker",
        integration: { type: "mcp", serverId: "notion" },
        requiredConfig: [
          {
            key: "NOTION_ACCESS_TOKEN",
            description: "Notion token",
            source: "link",
            provider: "notion",
          },
        ],
      }),
    ];

    const result = await resolveCredentials(requirements);

    expect(result.bindings).toEqual([]);
    expect(result.unresolved).toEqual([
      {
        targetType: "mcp",
        targetId: "notion",
        field: "NOTION_ACCESS_TOKEN",
        provider: "notion",
        reason: "not_found",
      },
    ]);
  });

  it("handles mixed resolved, unresolved, and env fields across requirements", async () => {
    // github resolves, notion does not
    mockResolveByProvider
      .mockResolvedValueOnce([
        {
          id: "cred_gh",
          provider: "github",
          label: "gh-org",
          type: "oauth2",
          displayName: "GitHub",
          userIdentifier: "gh-org",
          isDefault: true,
        },
      ])
      .mockRejectedValueOnce(new MockCredentialNotFoundError("notion"));

    const requirements = [
      makeReq({
        agentId: "github-bot",
        integration: { type: "mcp", serverId: "github" },
        requiredConfig: [
          { key: "GH_TOKEN", description: "GitHub token", source: "link", provider: "github" },
          { key: "SOME_API_KEY", description: "Some API key", source: "env" },
        ],
      }),
      makeReq({
        agentId: "note-taker",
        integration: { type: "mcp", serverId: "notion" },
        requiredConfig: [
          {
            key: "NOTION_ACCESS_TOKEN",
            description: "Notion token",
            source: "link",
            provider: "notion",
          },
        ],
      }),
    ];

    const result = await resolveCredentials(requirements);

    expect(result.bindings).toEqual([
      expect.objectContaining({ targetId: "github", field: "GH_TOKEN", credentialId: "cred_gh" }),
    ]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({
        field: "NOTION_ACCESS_TOKEN",
        provider: "notion",
        reason: "not_found",
      }),
    ]);
  });

  it("skips env-source fields without calling Link API", async () => {
    const requirements = [
      makeReq({
        agentId: "email",
        integration: { type: "bundled", bundledId: "email" },
        requiredConfig: [
          { key: "SENDGRID_API_KEY", description: "SendGrid API key", source: "env" },
        ],
      }),
    ];

    const result = await resolveCredentials(requirements);

    expect(result.bindings).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(mockResolveByProvider).not.toHaveBeenCalled();
  });

  it("auto-selects first candidate when multiple credentials exist and none is default", async () => {
    const creds: CredentialSummary[] = [
      {
        id: "cred_slack1",
        provider: "slack",
        label: "Work",
        type: "oauth2",
        displayName: "Slack",
        userIdentifier: "work@acme.com",
        isDefault: false,
      },
      {
        id: "cred_slack2",
        provider: "slack",
        label: "Personal",
        type: "oauth2",
        displayName: "Slack",
        userIdentifier: "me@gmail.com",
        isDefault: false,
      },
    ];
    mockResolveByProvider.mockResolvedValueOnce(creds);

    const requirements = [
      makeReq({
        agentId: "slack-bot",
        integration: { type: "mcp", serverId: "slack" },
        requiredConfig: [
          { key: "SLACK_BOT_TOKEN", description: "Slack token", source: "link", provider: "slack" },
        ],
      }),
    ];

    const result = await resolveCredentials(requirements);

    // Auto-selects first candidate into bindings
    expect(result.bindings).toEqual([
      {
        targetType: "mcp",
        targetId: "slack",
        field: "SLACK_BOT_TOKEN",
        credentialId: "cred_slack1",
        provider: "slack",
        key: "access_token",
        label: "Work",
      },
    ]);
    expect(result.unresolved).toEqual([]);
    // Candidates surfaced for the UI picker
    expect(result.candidates).toEqual([
      {
        provider: "slack",
        candidates: [
          {
            id: "cred_slack1",
            label: "Work",
            displayName: "Slack",
            userIdentifier: "work@acme.com",
            isDefault: false,
          },
          {
            id: "cred_slack2",
            label: "Personal",
            displayName: "Slack",
            userIdentifier: "me@gmail.com",
            isDefault: false,
          },
        ],
      },
    ]);
  });

  it("auto-selects default credential when one exists among multiple and returns candidates", async () => {
    mockResolveByProvider.mockResolvedValueOnce([
      {
        id: "cred_slack1",
        provider: "slack",
        label: "Work",
        type: "oauth2",
        displayName: "Slack",
        userIdentifier: "work@acme.com",
        isDefault: true,
      },
      {
        id: "cred_slack2",
        provider: "slack",
        label: "Personal",
        type: "oauth2",
        displayName: "Slack",
        userIdentifier: "me@gmail.com",
        isDefault: false,
      },
    ]);

    const requirements = [
      makeReq({
        agentId: "slack-bot",
        integration: { type: "mcp", serverId: "slack" },
        requiredConfig: [
          { key: "SLACK_BOT_TOKEN", description: "Slack token", source: "link", provider: "slack" },
        ],
      }),
    ];

    const result = await resolveCredentials(requirements);

    expect(result.bindings).toEqual([
      {
        targetType: "mcp",
        targetId: "slack",
        field: "SLACK_BOT_TOKEN",
        credentialId: "cred_slack1",
        provider: "slack",
        key: "access_token",
        label: "Work",
      },
    ]);
    expect(result.unresolved).toEqual([]);
    // Candidates surfaced even when default exists
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.provider).toBe("slack");
    expect(result.candidates[0]?.candidates).toHaveLength(2);
  });

  it("returns empty candidates for single-credential providers", async () => {
    mockResolveByProvider.mockResolvedValueOnce([
      {
        id: "cred_gh",
        provider: "github",
        label: "gh-org",
        type: "oauth2",
        displayName: "GitHub",
        userIdentifier: "gh-org",
        isDefault: true,
      },
    ]);

    const requirements = [
      makeReq({
        agentId: "github-bot",
        integration: { type: "mcp", serverId: "github" },
        requiredConfig: [
          { key: "GH_TOKEN", description: "GitHub token", source: "link", provider: "github" },
        ],
      }),
    ];

    const result = await resolveCredentials(requirements);

    expect(result.bindings).toHaveLength(1);
    expect(result.candidates).toEqual([]);
  });

  it("uses secretKey from requirement field instead of hardcoded access_token", async () => {
    mockResolveByProvider.mockResolvedValueOnce([
      {
        id: "cred_posthog1",
        provider: "posthog",
        label: "PostHog Prod",
        type: "apikey",
        displayName: "PostHog",
        userIdentifier: null,
        isDefault: true,
      },
    ]);

    const requirements = [
      makeReq({
        agentId: "analytics-agent",
        integration: { type: "mcp", serverId: "posthog" },
        requiredConfig: [
          {
            key: "POSTHOG_API_KEY",
            description: "PostHog API key",
            source: "link",
            provider: "posthog",
            secretKey: "key",
          },
        ],
      }),
    ];

    const result = await resolveCredentials(requirements);

    expect(result.bindings).toEqual([
      {
        targetType: "mcp",
        targetId: "posthog",
        field: "POSTHOG_API_KEY",
        credentialId: "cred_posthog1",
        provider: "posthog",
        key: "key",
        label: "PostHog Prod",
      },
    ]);
  });

  it("defaults to access_token when secretKey is not specified", async () => {
    mockResolveByProvider.mockResolvedValueOnce([
      {
        id: "cred_gh1",
        provider: "github",
        label: "gh-org",
        type: "oauth2",
        displayName: "GitHub",
        userIdentifier: "gh-org",
        isDefault: true,
      },
    ]);

    const requirements = [
      makeReq({
        agentId: "github-bot",
        integration: { type: "mcp", serverId: "github" },
        requiredConfig: [
          { key: "GH_TOKEN", description: "GitHub token", source: "link", provider: "github" },
        ],
      }),
    ];

    const result = await resolveCredentials(requirements);

    expect(result.bindings[0]).toEqual(expect.objectContaining({ key: "access_token" }));
  });

  it("deduplicates candidates when multiple requirements reference the same provider", async () => {
    const slackCreds: CredentialSummary[] = [
      {
        id: "cred_slack1",
        provider: "slack",
        label: "Work",
        type: "oauth2",
        displayName: "Slack",
        userIdentifier: "work@acme.com",
        isDefault: true,
      },
      {
        id: "cred_slack2",
        provider: "slack",
        label: "Personal",
        type: "oauth2",
        displayName: "Slack",
        userIdentifier: "me@gmail.com",
        isDefault: false,
      },
    ];
    // Both requirements resolve the same provider — API should be called once
    mockResolveByProvider.mockResolvedValue(slackCreds);

    const requirements = [
      makeReq({
        agentId: "slack-bot",
        integration: { type: "mcp", serverId: "slack-mcp" },
        requiredConfig: [
          { key: "SLACK_BOT_TOKEN", description: "Bot token", source: "link", provider: "slack" },
        ],
      }),
      makeReq({
        agentId: "slack-notifier",
        integration: { type: "mcp", serverId: "slack-notify" },
        requiredConfig: [
          {
            key: "SLACK_WEBHOOK_TOKEN",
            description: "Webhook token",
            source: "link",
            provider: "slack",
          },
        ],
      }),
    ];

    const result = await resolveCredentials(requirements);

    // Both fields get bindings
    expect(result.bindings).toHaveLength(2);
    expect(result.bindings[0]).toEqual(
      expect.objectContaining({ field: "SLACK_BOT_TOKEN", credentialId: "cred_slack1" }),
    );
    expect(result.bindings[1]).toEqual(
      expect.objectContaining({ field: "SLACK_WEBHOOK_TOKEN", credentialId: "cred_slack1" }),
    );

    // Candidates appear only once for the provider
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.provider).toBe("slack");

    // API called once, not twice (fetch cache)
    expect(mockResolveByProvider).toHaveBeenCalledTimes(1);
  });

  it("uses agentId as targetId for bundled agent integrations", async () => {
    mockResolveByProvider.mockResolvedValueOnce([
      {
        id: "cred_slack1",
        provider: "slack",
        label: "team-workspace",
        type: "oauth2",
        displayName: "Slack",
        userIdentifier: "team-workspace",
        isDefault: true,
      },
    ]);

    const requirements = [
      makeReq({
        agentId: "slack-agent",
        integration: { type: "bundled", bundledId: "slack" },
        requiredConfig: [
          {
            key: "SLACK_BOT_TOKEN",
            description: "Slack bot token",
            source: "link",
            provider: "slack",
          },
        ],
      }),
    ];

    const result = await resolveCredentials(requirements);

    expect(result.bindings).toEqual([
      expect.objectContaining({
        targetType: "agent",
        targetId: "slack-agent",
        field: "SLACK_BOT_TOKEN",
        credentialId: "cred_slack1",
        provider: "slack",
      }),
    ]);
  });

  // ---------------------------------------------------------------------------
  // slack-app: uses unwired endpoint instead of label-based filtering
  // ---------------------------------------------------------------------------

  it("resolves slack-app credential via resolveCredentialsByProvider", async () => {
    mockResolveByProvider.mockResolvedValueOnce([
      {
        id: "cred_slack_app_1",
        provider: "slack-app",
        label: "",
        type: "oauth",
        displayName: null,
        userIdentifier: null,
        isDefault: false,
      },
    ]);

    const requirements = [
      makeReq({
        agentId: "slack-bot",
        integration: { type: "bundled", bundledId: "slack" },
        requiredConfig: [
          {
            key: "SLACK_APP_TOKEN",
            description: "Slack app token",
            source: "link",
            provider: "slack-app",
          },
        ],
      }),
    ];

    const result = await resolveCredentials(requirements);

    expect(result.bindings).toEqual([
      expect.objectContaining({
        targetType: "agent",
        targetId: "slack-bot",
        field: "SLACK_APP_TOKEN",
        credentialId: "cred_slack_app_1",
        provider: "slack-app",
        key: "access_token",
      }),
    ]);
    expect(result.unresolved).toEqual([]);
    expect(mockResolveByProvider).toHaveBeenCalledWith("slack-app", { workspaceId: undefined });
  });

  it("returns setup_required when no slack-app credential exists", async () => {
    mockResolveByProvider.mockRejectedValueOnce(new MockCredentialNotFoundError("slack-app"));

    const requirements = [
      makeReq({
        agentId: "slack-bot",
        integration: { type: "bundled", bundledId: "slack" },
        requiredConfig: [
          {
            key: "SLACK_APP_TOKEN",
            description: "Slack app token",
            source: "link",
            provider: "slack-app",
          },
        ],
      }),
    ];

    const result = await resolveCredentials(requirements);

    expect(result.bindings).toEqual([]);
    expect(result.unresolved).toEqual([
      {
        targetType: "agent",
        targetId: "slack-bot",
        field: "SLACK_APP_TOKEN",
        provider: "slack-app",
        reason: "setup_required",
      },
    ]);
  });

  it("caches slack-app lookup across multiple fields", async () => {
    mockResolveByProvider.mockResolvedValueOnce([
      {
        id: "cred_slack_app_1",
        provider: "slack-app",
        label: "",
        type: "oauth",
        displayName: null,
        userIdentifier: null,
        isDefault: false,
      },
    ]);

    const requirements = [
      makeReq({
        agentId: "slack-bot",
        integration: { type: "bundled", bundledId: "slack" },
        requiredConfig: [
          {
            key: "SLACK_APP_TOKEN",
            description: "Slack app token",
            source: "link",
            provider: "slack-app",
          },
        ],
      }),
      makeReq({
        agentId: "slack-notifier",
        integration: { type: "bundled", bundledId: "slack-notifier" },
        requiredConfig: [
          {
            key: "SLACK_APP_TOKEN",
            description: "Slack app token",
            source: "link",
            provider: "slack-app",
          },
        ],
      }),
    ];

    const result = await resolveCredentials(requirements);

    expect(result.bindings).toHaveLength(2);
    // Only called once despite two fields needing slack-app (cached by fetchCache)
    expect(mockResolveByProvider).toHaveBeenCalledTimes(1);
  });
});
