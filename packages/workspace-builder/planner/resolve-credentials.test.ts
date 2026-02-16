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
        agentId: "github-bot",
        field: "GH_TOKEN",
        provider: "github",
        reason: expect.stringContaining("skipped"),
      },
      {
        agentId: "github-bot",
        field: "NOTION_ACCESS_TOKEN",
        provider: "notion",
        reason: expect.stringContaining("skipped"),
      },
    ]);
  });

  it("creates CredentialBinding when Link API resolves credential", async () => {
    mockResolveByProvider.mockResolvedValueOnce([
      { id: "cred_abc123", provider: "github", label: "tempestteam", type: "oauth2" },
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

  it("tracks unresolved when Link API throws CredentialNotFoundError", async () => {
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
        agentId: "note-taker",
        field: "NOTION_ACCESS_TOKEN",
        provider: "notion",
        reason: expect.stringContaining("notion"),
      },
    ]);
  });

  it("handles mixed resolved, unresolved, and env fields across requirements", async () => {
    // github resolves, notion does not
    mockResolveByProvider
      .mockResolvedValueOnce([
        { id: "cred_gh", provider: "github", label: "gh-org", type: "oauth2" },
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
      expect.objectContaining({ field: "NOTION_ACCESS_TOKEN", provider: "notion" }),
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

  it("uses agentId as targetId for bundled agent integrations", async () => {
    mockResolveByProvider.mockResolvedValueOnce([
      { id: "cred_slack1", provider: "slack", label: "team-workspace", type: "oauth2" },
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
});
