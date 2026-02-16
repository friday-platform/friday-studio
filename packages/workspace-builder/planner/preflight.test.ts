import type { CredentialBinding } from "@atlas/schemas/workspace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigRequirement } from "./classify-agents.ts";
import { checkEnvironmentReadiness, formatReadinessReport } from "./preflight.ts";

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

function makeBinding(
  overrides: Partial<CredentialBinding> & { targetId: string; field: string },
): CredentialBinding {
  return {
    targetType: "mcp",
    credentialId: `cred_${overrides.targetId}`,
    provider: overrides.targetId,
    key: "access_token",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkEnvironmentReadiness
// ---------------------------------------------------------------------------

describe("checkEnvironmentReadiness", () => {
  beforeEach(() => {
    vi.stubEnv("SENDGRID_API_KEY", "sg-test-key");
    vi.stubEnv("GH_TOKEN", "ghp_test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns ready when all env vars are present", () => {
    const result = checkEnvironmentReadiness([
      makeReq({
        agentId: "email",
        integration: { type: "bundled", bundledId: "email" },
        requiredConfig: [
          { key: "SENDGRID_API_KEY", description: "SendGrid API key", source: "env" },
        ],
      }),
    ]);

    expect(result.ready).toBe(true);
    expect(result.summary).toEqual({ present: 1, missing: 0, skipped: 0, resolved: 0 });
    expect(result.checks).toEqual([
      expect.objectContaining({
        agentId: "email",
        checks: [expect.objectContaining({ key: "SENDGRID_API_KEY", status: "present" })],
      }),
    ]);
  });

  it("returns not ready when env var is missing", () => {
    vi.unstubAllEnvs();

    const result = checkEnvironmentReadiness([
      makeReq({
        agentId: "github-bot",
        integration: { type: "mcp", serverId: "github" },
        requiredConfig: [{ key: "GH_TOKEN", description: "GitHub token", source: "env" }],
      }),
    ]);

    expect(result.ready).toBe(false);
    expect(result.summary).toEqual({ present: 0, missing: 1, skipped: 0, resolved: 0 });
    expect(result.checks).toEqual([
      expect.objectContaining({
        checks: [expect.objectContaining({ key: "GH_TOKEN", status: "missing" })],
      }),
    ]);
  });

  it("skips link credentials without bindings and they do not affect readiness", () => {
    const result = checkEnvironmentReadiness([
      makeReq({
        agentId: "email",
        integration: { type: "bundled", bundledId: "email" },
        requiredConfig: [
          { key: "SENDGRID_API_KEY", description: "SendGrid API key", source: "env" },
          {
            key: "SENDGRID_LINK_CRED",
            description: "SendGrid link cred",
            source: "link",
            provider: "sendgrid",
          },
        ],
      }),
    ]);

    expect(result.ready).toBe(true);
    expect(result.summary).toEqual({ present: 1, missing: 0, skipped: 1, resolved: 0 });
    expect(result.checks).toEqual([
      expect.objectContaining({
        checks: [
          expect.objectContaining({ key: "SENDGRID_API_KEY", status: "present" }),
          expect.objectContaining({ key: "SENDGRID_LINK_CRED", status: "skipped" }),
        ],
      }),
    ]);
  });

  it("computes correct summary for mixed present/missing/skipped", () => {
    vi.unstubAllEnvs();
    vi.stubEnv("SENDGRID_API_KEY", "sg-test-key");

    const result = checkEnvironmentReadiness([
      makeReq({
        agentId: "email",
        integration: { type: "bundled", bundledId: "email" },
        requiredConfig: [
          { key: "SENDGRID_API_KEY", description: "SendGrid API key", source: "env" },
          {
            key: "SENDGRID_LINK_CRED",
            description: "SendGrid link",
            source: "link",
            provider: "sendgrid",
          },
        ],
      }),
      makeReq({
        agentId: "github-bot",
        integration: { type: "mcp", serverId: "github" },
        requiredConfig: [{ key: "GH_TOKEN", description: "GitHub token", source: "env" }],
      }),
    ]);

    expect(result.ready).toBe(false);
    expect(result.summary).toEqual({ present: 1, missing: 1, skipped: 1, resolved: 0 });
  });

  it("marks Link field as resolved when matching binding exists", () => {
    const bindings = [
      makeBinding({ targetId: "github", field: "GH_TOKEN", credentialId: "cred_123" }),
    ];
    const result = checkEnvironmentReadiness(
      [
        makeReq({
          agentId: "github-bot",
          integration: { type: "mcp", serverId: "github" },
          requiredConfig: [
            { key: "GH_TOKEN", description: "GitHub token", source: "link", provider: "github" },
          ],
        }),
      ],
      bindings,
    );

    expect(result.ready).toBe(true);
    expect(result.checks).toEqual([
      expect.objectContaining({
        checks: [
          expect.objectContaining({
            key: "GH_TOKEN",
            status: "resolved",
            credentialId: "cred_123",
          }),
        ],
      }),
    ]);
  });

  it("marks Link field as missing when no matching binding exists", () => {
    const result = checkEnvironmentReadiness(
      [
        makeReq({
          agentId: "notion-bot",
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
      ],
      [],
    );

    expect(result.ready).toBe(false);
    expect(result.checks).toEqual([
      expect.objectContaining({
        checks: [expect.objectContaining({ key: "NOTION_ACCESS_TOKEN", status: "missing" })],
      }),
    ]);
  });

  it("handles mixed env present + Link resolved + Link missing", () => {
    vi.unstubAllEnvs();
    vi.stubEnv("SENDGRID_API_KEY", "sg-key");
    const bindings = [
      makeBinding({ targetId: "github", field: "GH_TOKEN", credentialId: "cred_123" }),
    ];
    const result = checkEnvironmentReadiness(
      [
        makeReq({
          agentId: "email",
          requiredConfig: [{ key: "SENDGRID_API_KEY", description: "SendGrid key", source: "env" }],
        }),
        makeReq({
          agentId: "github-bot",
          integration: { type: "mcp", serverId: "github" },
          requiredConfig: [
            { key: "GH_TOKEN", description: "GitHub token", source: "link", provider: "github" },
          ],
        }),
        makeReq({
          agentId: "notion-bot",
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
      ],
      bindings,
    );

    expect(result.ready).toBe(false);
    expect(result.summary).toEqual({ present: 1, missing: 1, skipped: 0, resolved: 1 });
  });
});

// ---------------------------------------------------------------------------
// formatReadinessReport
// ---------------------------------------------------------------------------

describe("formatReadinessReport", () => {
  beforeEach(() => {
    vi.stubEnv("SENDGRID_API_KEY", "sg-test-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns empty string when no checks exist", () => {
    const result = checkEnvironmentReadiness([]);
    expect(formatReadinessReport(result)).toBe("");
  });

  it("includes correct symbols for present, missing, skipped, and agent-level status", () => {
    vi.unstubAllEnvs();
    vi.stubEnv("SENDGRID_API_KEY", "sg-test-key");

    const result = checkEnvironmentReadiness([
      makeReq({
        agentId: "email",
        agentName: "Email Agent",
        integration: { type: "bundled", bundledId: "email" },
        requiredConfig: [
          { key: "SENDGRID_API_KEY", description: "SendGrid API key", source: "env" },
          {
            key: "SENDGRID_LINK_CRED",
            description: "SendGrid link",
            source: "link",
            provider: "sendgrid",
          },
        ],
      }),
      makeReq({
        agentId: "github-bot",
        agentName: "GitHub Bot",
        integration: { type: "mcp", serverId: "github" },
        requiredConfig: [{ key: "GH_TOKEN", description: "GitHub token", source: "env" }],
      }),
    ]);

    const report = formatReadinessReport(result);

    expect(report).toContain("Environment readiness check:");
    // Agent-level: passing agent gets check, failing gets x
    expect(report).toContain("✓ Email Agent");
    expect(report).toContain("✗ GitHub Bot");
    // Field-level symbols
    expect(report).toContain("✓ SENDGRID_API_KEY — present");
    expect(report).toContain("○ SENDGRID_LINK_CRED — skipped");
    expect(report).toContain("✗ GH_TOKEN — MISSING");
    // Summary
    expect(report).toContain("1 present");
    expect(report).toContain("1 missing");
    expect(report).toContain("1 skipped");
  });

  it("includes resolved credential ID and count in report", () => {
    const bindings = [
      makeBinding({ targetId: "github", field: "GH_TOKEN", credentialId: "cred_123" }),
    ];
    const result = checkEnvironmentReadiness(
      [
        makeReq({
          agentId: "github-bot",
          agentName: "GitHub Bot",
          integration: { type: "mcp", serverId: "github" },
          requiredConfig: [
            { key: "GH_TOKEN", description: "GitHub token", source: "link", provider: "github" },
          ],
        }),
      ],
      bindings,
    );

    const report = formatReadinessReport(result);

    expect(report).toContain("GH_TOKEN — resolved (cred_123)");
    expect(report).toContain("1 resolved");
  });
});
