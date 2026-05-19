import { type WorkspaceConfig, WorkspaceConfigSchema } from "@atlas/config";
import { describe, expect, it } from "vitest";
import {
  type LinkCredentialState,
  resolveWorkspaceSetupRequirements,
  StaleCredentialIdAtImportError,
} from "../setup-requirements.ts";

function baseConfig(overrides: Record<string, unknown> = {}): WorkspaceConfig {
  return WorkspaceConfigSchema.parse({
    version: "1.0",
    workspace: { name: "test", id: "test", description: "test workspace" },
    ...overrides,
  });
}

function emptyLink(): LinkCredentialState {
  return { defaultByProvider: {}, resolvedIds: new Set(), providerErrors: new Set() };
}

const RUNTIME_OPTS = { allowStaleIdRecovery: true } as const;
const IMPORT_OPTS = { allowStaleIdRecovery: false } as const;

describe("resolveWorkspaceSetupRequirements — variables", () => {
  it("flags unfilled when no default and no env value", () => {
    const config = baseConfig({
      variables: {
        email_recipient: {
          description: "Where to send the report",
          schema: { type: "string", format: "email" },
        },
      },
    });
    const result = resolveWorkspaceSetupRequirements(config, {}, emptyLink(), RUNTIME_OPTS);
    expect(result.requires_setup).toBe(true);
    expect(result.setup_requirements).toEqual([
      {
        kind: "variable",
        name: "email_recipient",
        description: "Where to send the report",
        schema: { type: "string", format: "email" },
      },
    ]);
  });

  it("treats variable with passing schema default as filled even without env value", () => {
    const config = baseConfig({
      variables: {
        threshold: { schema: { type: "number", minimum: 0, maximum: 1, default: 0.5 } },
      },
    });
    const result = resolveWorkspaceSetupRequirements(config, {}, emptyLink(), RUNTIME_OPTS);
    expect(result.requires_setup).toBe(false);
    expect(result.setup_requirements).toEqual([]);
  });

  it("treats variable as filled when env value satisfies schema", () => {
    const config = baseConfig({
      variables: { email_recipient: { schema: { type: "string", format: "email" } } },
    });
    const result = resolveWorkspaceSetupRequirements(
      config,
      { EMAIL_RECIPIENT: "user@example.com" },
      emptyLink(),
      RUNTIME_OPTS,
    );
    expect(result.requires_setup).toBe(false);
  });

  it("treats variable as unfilled when env value fails schema (author tightening)", () => {
    const config = baseConfig({
      variables: { max_retries: { schema: { type: "integer", minimum: 5, maximum: 10 } } },
    });
    const result = resolveWorkspaceSetupRequirements(
      config,
      { MAX_RETRIES: "1" },
      emptyLink(),
      RUNTIME_OPTS,
    );
    expect(result.requires_setup).toBe(true);
    expect(result.setup_requirements[0]).toMatchObject({ kind: "variable", name: "max_retries" });
  });

  it("accepts empty string when schema does not require non-empty content", () => {
    const config = baseConfig({ variables: { note: { schema: { type: "string" } } } });
    const result = resolveWorkspaceSetupRequirements(
      config,
      { NOTE: "" },
      emptyLink(),
      RUNTIME_OPTS,
    );
    expect(result.requires_setup).toBe(false);
  });

  it("flags empty string when schema demands minLength: 1", () => {
    const config = baseConfig({
      variables: { note: { schema: { type: "string", minLength: 1 } } },
    });
    const result = resolveWorkspaceSetupRequirements(
      config,
      { NOTE: "" },
      emptyLink(),
      RUNTIME_OPTS,
    );
    expect(result.requires_setup).toBe(true);
  });
});

describe("resolveWorkspaceSetupRequirements — credentials", () => {
  function configWithProviderRef(provider: string): WorkspaceConfig {
    return baseConfig({
      tools: {
        mcp: {
          servers: {
            myserver: {
              transport: { type: "stdio", command: "npx", args: ["-y", "some-server"] },
              env: { TOKEN: { from: "link", provider, key: "access_token" } },
            },
          },
        },
      },
    });
  }

  function configWithPinnedId(provider: string, id: string): WorkspaceConfig {
    return baseConfig({
      tools: {
        mcp: {
          servers: {
            myserver: {
              transport: { type: "stdio", command: "npx", args: ["-y", "some-server"] },
              env: { TOKEN: { from: "link", id, provider, key: "access_token" } },
            },
          },
        },
      },
    });
  }

  it("provider-only ref + Link default → no requirement", () => {
    const link: LinkCredentialState = {
      defaultByProvider: { github: "cred_default" },
      resolvedIds: new Set(),
      providerErrors: new Set(),
    };
    const result = resolveWorkspaceSetupRequirements(
      configWithProviderRef("github"),
      {},
      link,
      RUNTIME_OPTS,
    );
    expect(result.requires_setup).toBe(false);
  });

  it("provider-only ref + no Link default → no_default requirement", () => {
    const link: LinkCredentialState = {
      defaultByProvider: { github: null },
      resolvedIds: new Set(),
      providerErrors: new Set(),
    };
    const result = resolveWorkspaceSetupRequirements(
      configWithProviderRef("github"),
      {},
      link,
      RUNTIME_OPTS,
    );
    expect(result.requires_setup).toBe(true);
    expect(result.setup_requirements).toEqual([
      {
        kind: "credential",
        provider: "github",
        path: "mcp:myserver:TOKEN",
        key: "access_token",
        reason: "no_default",
      },
    ]);
  });

  it("pinned id that resolves → no requirement", () => {
    const link: LinkCredentialState = {
      defaultByProvider: {},
      resolvedIds: new Set(["cred_pinned"]),
      providerErrors: new Set(),
    };
    const result = resolveWorkspaceSetupRequirements(
      configWithPinnedId("github", "cred_pinned"),
      {},
      link,
      RUNTIME_OPTS,
    );
    expect(result.requires_setup).toBe(false);
  });

  it("stale pinned id post-import → stale_id requirement", () => {
    const link: LinkCredentialState = {
      defaultByProvider: {},
      resolvedIds: new Set(),
      providerErrors: new Set(),
    };
    const result = resolveWorkspaceSetupRequirements(
      configWithPinnedId("github", "cred_gone"),
      {},
      link,
      RUNTIME_OPTS,
    );
    expect(result.requires_setup).toBe(true);
    expect(result.setup_requirements).toEqual([
      {
        kind: "credential",
        provider: "github",
        path: "mcp:myserver:TOKEN",
        key: "access_token",
        reason: "stale_id",
      },
    ]);
  });

  it("stale pinned id at import → throws StaleCredentialIdAtImportError", () => {
    const link: LinkCredentialState = {
      defaultByProvider: {},
      resolvedIds: new Set(),
      providerErrors: new Set(),
    };
    expect(() =>
      resolveWorkspaceSetupRequirements(
        configWithPinnedId("github", "cred_foreign"),
        {},
        link,
        IMPORT_OPTS,
      ),
    ).toThrow(StaleCredentialIdAtImportError);
  });

  it("provider-only ref + Link error → does not flip requires_setup true", () => {
    const link: LinkCredentialState = {
      defaultByProvider: {},
      resolvedIds: new Set(),
      providerErrors: new Set(["github"]),
    };
    const result = resolveWorkspaceSetupRequirements(
      configWithProviderRef("github"),
      {},
      link,
      RUNTIME_OPTS,
    );
    expect(result.requires_setup).toBe(false);
    expect(result.setup_requirements).toEqual([]);
  });

  it("preserves single-credential auto-pin behavior — pinned ref that resolves is not a requirement", () => {
    const link: LinkCredentialState = {
      defaultByProvider: {},
      resolvedIds: new Set(["cred_only"]),
      providerErrors: new Set(),
    };
    const result = resolveWorkspaceSetupRequirements(
      configWithPinnedId("linear", "cred_only"),
      {},
      link,
      RUNTIME_OPTS,
    );
    expect(result.requires_setup).toBe(false);
  });
});

describe("resolveWorkspaceSetupRequirements — composite", () => {
  it("combines unfilled variables and unresolved credentials in one pass", () => {
    const config = baseConfig({
      variables: { email_recipient: { schema: { type: "string", format: "email" } } },
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
              env: { GITHUB_TOKEN: { from: "link", provider: "github", key: "token" } },
            },
          },
        },
      },
    });
    const link: LinkCredentialState = {
      defaultByProvider: { github: null },
      resolvedIds: new Set(),
      providerErrors: new Set(),
    };
    const result = resolveWorkspaceSetupRequirements(config, {}, link, RUNTIME_OPTS);
    expect(result.requires_setup).toBe(true);
    expect(result.setup_requirements).toHaveLength(2);
    const kinds = result.setup_requirements.map((r) => r.kind).sort();
    expect(kinds).toEqual(["credential", "variable"]);
  });

  it("returns no requirements when both variables and credentials are satisfied", () => {
    const config = baseConfig({
      variables: { email_recipient: { schema: { type: "string", format: "email" } } },
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
              env: { GITHUB_TOKEN: { from: "link", id: "cred_resolved", key: "token" } },
            },
          },
        },
      },
    });
    const link: LinkCredentialState = {
      defaultByProvider: {},
      resolvedIds: new Set(["cred_resolved"]),
      providerErrors: new Set(),
    };
    const result = resolveWorkspaceSetupRequirements(
      config,
      { EMAIL_RECIPIENT: "user@example.com" },
      link,
      RUNTIME_OPTS,
    );
    expect(result.requires_setup).toBe(false);
    expect(result.setup_requirements).toEqual([]);
  });
});
