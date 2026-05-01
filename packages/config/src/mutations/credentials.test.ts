/**
 * Tests for credential extraction and mutation functions
 */

import { describe, expect, test } from "vitest";
import {
  extractCredentials,
  stripCredentialRefs,
  toIdRefs,
  toProviderRefs,
  updateCredential,
} from "./credentials.ts";
import { atlasAgent, createTestConfig, expectError } from "./test-fixtures.ts";

describe("extractCredentials", () => {
  test("returns empty array for empty config", () => {
    const config = createTestConfig();

    const result = extractCredentials(config);

    expect(result).toEqual([]);
  });

  test("returns empty array when no credentials present", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            linear: {
              transport: { type: "stdio", command: "linear-mcp" },
              env: { SOME_VAR: "plain-string-value" },
            },
          },
        },
      },
      agents: { "my-agent": atlasAgent({ env: { PLAIN_VAR: "just-a-string" } }) },
    });

    const result = extractCredentials(config);

    expect(result).toEqual([]);
  });

  test("extracts credentials from MCP server env", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            linear: {
              transport: { type: "stdio", command: "linear-mcp" },
              env: {
                LINEAR_ACCESS_TOKEN: { from: "link", provider: "linear", key: "access_token" },
              },
            },
          },
        },
      },
    });

    const result = extractCredentials(config);

    expect(result).toEqual([
      { path: "mcp:linear:LINEAR_ACCESS_TOKEN", provider: "linear", key: "access_token" },
    ]);
  });

  test("extracts credentials with id-based ref", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "github-mcp" },
              env: { GITHUB_TOKEN: { from: "link", id: "cred_abc123", key: "token" } },
            },
          },
        },
      },
    });

    const result = extractCredentials(config);

    expect(result).toEqual([
      { path: "mcp:github:GITHUB_TOKEN", credentialId: "cred_abc123", key: "token" },
    ]);
  });

  test("extracts credentials from Atlas agent env", () => {
    const config = createTestConfig({
      agents: {
        "slack-agent": atlasAgent({
          env: { SLACK_TOKEN: { from: "link", provider: "slack", key: "bot_token" } },
        }),
      },
    });

    const result = extractCredentials(config);

    expect(result).toEqual([
      { path: "agent:slack-agent:SLACK_TOKEN", provider: "slack", key: "bot_token" },
    ]);
  });

  test("skips non-atlas agents", () => {
    const config = createTestConfig({
      agents: {
        "llm-agent": {
          type: "llm",
          description: "Test LLM agent",
          config: { provider: "anthropic", model: "claude-sonnet-4-6", prompt: "Test" },
        },
        "system-agent": { type: "system", agent: "conversation", description: "Test system agent" },
      },
    });

    const result = extractCredentials(config);

    expect(result).toEqual([]);
  });

  test("extracts credentials from mixed MCP and agent sources", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            linear: {
              transport: { type: "stdio", command: "linear-mcp" },
              env: {
                LINEAR_TOKEN: { from: "link", provider: "linear", key: "access_token" },
                PLAIN_VAR: "not-a-credential",
              },
            },
            github: {
              transport: { type: "http", url: "http://localhost:3000" },
              env: { GITHUB_TOKEN: { from: "link", id: "cred_github", key: "token" } },
            },
          },
        },
      },
      agents: {
        "slack-agent": atlasAgent({
          env: {
            SLACK_TOKEN: { from: "link", provider: "slack", key: "token" },
            OTHER_VAR: "plain-string",
          },
        }),
        "llm-agent": {
          type: "llm",
          description: "Test",
          config: { provider: "anthropic", model: "claude-sonnet-4-6", prompt: "Test" },
        },
      },
    });

    const result = extractCredentials(config);

    expect(result).toHaveLength(3);
    expect(result).toContainEqual({
      path: "mcp:linear:LINEAR_TOKEN",
      provider: "linear",
      key: "access_token",
    });
    expect(result).toContainEqual({
      path: "mcp:github:GITHUB_TOKEN",
      credentialId: "cred_github",
      key: "token",
    });
    expect(result).toContainEqual({
      path: "agent:slack-agent:SLACK_TOKEN",
      provider: "slack",
      key: "token",
    });
  });
});

describe("updateCredential", () => {
  test("updates MCP server credential with new id", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            linear: {
              transport: { type: "stdio", command: "linear-mcp" },
              env: { LINEAR_TOKEN: { from: "link", provider: "linear", key: "access_token" } },
            },
          },
        },
      },
    });

    const result = updateCredential(config, "mcp:linear:LINEAR_TOKEN", "cred_new123");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tools?.mcp?.servers?.linear?.env?.LINEAR_TOKEN).toEqual({
        from: "link",
        id: "cred_new123",
        key: "access_token",
      });
    }
  });

  test("updates Atlas agent credential with new id", () => {
    const config = createTestConfig({
      agents: {
        "slack-agent": atlasAgent({
          env: { SLACK_TOKEN: { from: "link", provider: "slack", key: "bot_token" } },
        }),
      },
    });

    const result = updateCredential(config, "agent:slack-agent:SLACK_TOKEN", "cred_slack_new");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.agents?.["slack-agent"]).toHaveProperty("env.SLACK_TOKEN", {
        from: "link",
        id: "cred_slack_new",
        key: "bot_token",
      });
    }
  });

  test("preserves key from original ref", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "github-mcp" },
              env: { GITHUB_TOKEN: { from: "link", id: "cred_old", key: "personal_access_token" } },
            },
          },
        },
      },
    });

    const result = updateCredential(config, "mcp:github:GITHUB_TOKEN", "cred_new");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tools?.mcp?.servers?.github?.env?.GITHUB_TOKEN).toEqual({
        from: "link",
        id: "cred_new",
        key: "personal_access_token",
      });
    }
  });

  test("converts provider-based ref to id-based ref", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            linear: {
              transport: { type: "stdio", command: "linear-mcp" },
              env: { LINEAR_TOKEN: { from: "link", provider: "linear", key: "access_token" } },
            },
          },
        },
      },
    });

    const result = updateCredential(config, "mcp:linear:LINEAR_TOKEN", "cred_specific");

    expect(result.ok).toBe(true);
    if (result.ok) {
      const ref = result.value.tools?.mcp?.servers?.linear?.env?.LINEAR_TOKEN as Record<
        string,
        unknown
      >;
      expect(ref.id).toBe("cred_specific");
      expect(ref.provider).toBeUndefined();
    }
  });

  test("returns not_found error for non-existent MCP server", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: { linear: { transport: { type: "stdio", command: "linear-mcp" }, env: {} } },
        },
      },
    });

    const result = updateCredential(config, "mcp:nonexistent:SOME_TOKEN", "cred_new");

    expectError(result, "not_found", (e) => {
      expect(e.entityId).toBe("mcp:nonexistent:SOME_TOKEN");
      expect(e.entityType).toBe("credential");
    });
  });

  test("returns not_found error for non-existent env var", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            linear: {
              transport: { type: "stdio", command: "linear-mcp" },
              env: { OTHER_VAR: "plain-value" },
            },
          },
        },
      },
    });

    const result = updateCredential(config, "mcp:linear:MISSING_VAR", "cred_new");

    expectError(result, "not_found", (e) => {
      expect(e.entityId).toBe("mcp:linear:MISSING_VAR");
    });
  });

  test("returns not_found error for plain string env var", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            linear: {
              transport: { type: "stdio", command: "linear-mcp" },
              env: { PLAIN_VAR: "not-a-credential" },
            },
          },
        },
      },
    });

    const result = updateCredential(config, "mcp:linear:PLAIN_VAR", "cred_new");

    expectError(result, "not_found", (e) => {
      expect(e.entityId).toBe("mcp:linear:PLAIN_VAR");
    });
  });

  test("returns validation error for invalid path format - missing parts", () => {
    const config = createTestConfig();

    const result = updateCredential(config, "mcp:linear", "cred_new");

    expectError(result, "validation", (e) => {
      expect(e.message).toContain("Invalid credential path format");
    });
  });

  test("returns validation error for invalid path format - unknown type", () => {
    const config = createTestConfig();

    const result = updateCredential(config, "unknown:server:VAR", "cred_new");

    expectError(result, "validation", (e) => {
      expect(e.message).toContain("Invalid credential path format");
    });
  });

  test("returns validation error for empty path parts", () => {
    const config = createTestConfig();

    const result = updateCredential(config, "mcp::SOME_VAR", "cred_new");

    expectError(result, "validation", (e) => {
      expect(e.message).toContain("Invalid credential path format");
    });
  });

  test("stores provider when provided", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            linear: {
              transport: { type: "stdio", command: "linear-mcp" },
              env: { LINEAR_TOKEN: { from: "link", provider: "linear", key: "access_token" } },
            },
          },
        },
      },
    });

    const result = updateCredential(config, "mcp:linear:LINEAR_TOKEN", "cred_new123", "linear");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tools?.mcp?.servers?.linear?.env?.LINEAR_TOKEN).toEqual({
        from: "link",
        id: "cred_new123",
        provider: "linear",
        key: "access_token",
      });
    }
  });

  test("omits provider from ref when not provided", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "github-mcp" },
              env: { GITHUB_TOKEN: { from: "link", id: "cred_old", key: "token" } },
            },
          },
        },
      },
    });

    const result = updateCredential(config, "mcp:github:GITHUB_TOKEN", "cred_new");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tools?.mcp?.servers?.github?.env?.GITHUB_TOKEN).toMatchObject({
        from: "link",
        id: "cred_new",
        key: "token",
      });
      expect(result.value.tools?.mcp?.servers?.github?.env?.GITHUB_TOKEN).not.toHaveProperty(
        "provider",
      );
    }
  });

  test("does not mutate original config", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            linear: {
              transport: { type: "stdio", command: "linear-mcp" },
              env: { LINEAR_TOKEN: { from: "link", provider: "linear", key: "access_token" } },
            },
          },
        },
      },
    });
    const originalEnv = config.tools?.mcp?.servers?.linear?.env?.LINEAR_TOKEN;

    const result = updateCredential(config, "mcp:linear:LINEAR_TOKEN", "cred_new");

    expect(result.ok).toBe(true);
    // Original should be unchanged
    expect(config.tools?.mcp?.servers?.linear?.env?.LINEAR_TOKEN).toBe(originalEnv);
    expect(originalEnv).toMatchObject({ provider: "linear" });
  });
});

describe("toProviderRefs", () => {
  test("drops id from ref with both id and provider", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            linear: {
              transport: { type: "stdio", command: "linear-mcp" },
              env: {
                LINEAR_TOKEN: {
                  from: "link",
                  id: "cred_abc",
                  provider: "linear",
                  key: "access_token",
                },
              },
            },
          },
        },
      },
    });

    const result = toProviderRefs(config, {});

    expect(result.tools?.mcp?.servers?.linear?.env?.LINEAR_TOKEN).toEqual({
      from: "link",
      provider: "linear",
      key: "access_token",
    });
  });

  test("leaves provider-only ref untouched", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            linear: {
              transport: { type: "stdio", command: "linear-mcp" },
              env: { LINEAR_TOKEN: { from: "link", provider: "linear", key: "access_token" } },
            },
          },
        },
      },
    });

    const result = toProviderRefs(config, {});

    expect(result.tools?.mcp?.servers?.linear?.env?.LINEAR_TOKEN).toEqual({
      from: "link",
      provider: "linear",
      key: "access_token",
    });
  });

  test("resolves legacy id-only ref using providerMap", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "github-mcp" },
              env: { GITHUB_TOKEN: { from: "link", id: "cred_legacy", key: "token" } },
            },
          },
        },
      },
    });

    const result = toProviderRefs(config, { cred_legacy: "github" });

    expect(result.tools?.mcp?.servers?.github?.env?.GITHUB_TOKEN).toEqual({
      from: "link",
      provider: "github",
      key: "token",
    });
  });

  test("throws for legacy id-only ref missing from providerMap", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "github-mcp" },
              env: { GITHUB_TOKEN: { from: "link", id: "cred_unknown", key: "token" } },
            },
          },
        },
      },
    });

    expect(() => toProviderRefs(config, {})).toThrow("cred_unknown");
  });

  test("returns unchanged config when no credentials exist", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            linear: {
              transport: { type: "stdio", command: "linear-mcp" },
              env: { PLAIN_VAR: "just-a-string" },
            },
          },
        },
      },
    });

    const result = toProviderRefs(config, {});

    expect(result).toEqual(config);
  });

  test("handles credentials in agent env", () => {
    const config = createTestConfig({
      agents: {
        "slack-agent": atlasAgent({
          env: {
            SLACK_TOKEN: { from: "link", id: "cred_slack", provider: "slack", key: "bot_token" },
          },
        }),
      },
    });

    const result = toProviderRefs(config, {});

    expect(result.agents?.["slack-agent"]).toHaveProperty("env.SLACK_TOKEN", {
      from: "link",
      provider: "slack",
      key: "bot_token",
    });
  });

  test("handles mixed refs across MCP servers and agents", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            linear: {
              transport: { type: "stdio", command: "linear-mcp" },
              env: {
                LINEAR_TOKEN: {
                  from: "link",
                  id: "cred_lin",
                  provider: "linear",
                  key: "access_token",
                },
                PLAIN_VAR: "not-a-credential",
              },
            },
          },
        },
      },
      agents: {
        "my-agent": atlasAgent({
          env: { AGENT_TOKEN: { from: "link", id: "cred_legacy_agent", key: "token" } },
        }),
      },
    });

    const result = toProviderRefs(config, { cred_legacy_agent: "custom-provider" });

    expect(result.tools?.mcp?.servers?.linear?.env?.LINEAR_TOKEN).toEqual({
      from: "link",
      provider: "linear",
      key: "access_token",
    });
    expect(result.tools?.mcp?.servers?.linear?.env?.PLAIN_VAR).toBe("not-a-credential");
    expect(result.agents?.["my-agent"]).toHaveProperty("env.AGENT_TOKEN", {
      from: "link",
      provider: "custom-provider",
      key: "token",
    });
  });
});

describe("toIdRefs", () => {
  test("adds id to provider-only ref from credentialMap", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            linear: {
              transport: { type: "stdio", command: "linear-mcp" },
              env: { LINEAR_TOKEN: { from: "link", provider: "linear", key: "access_token" } },
            },
          },
        },
      },
    });

    const result = toIdRefs(config, { linear: "cred_user_123" });

    expect(result.tools?.mcp?.servers?.linear?.env?.LINEAR_TOKEN).toEqual({
      from: "link",
      id: "cred_user_123",
      provider: "linear",
      key: "access_token",
    });
  });

  test("replaces existing id when provider is in credentialMap", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "github-mcp" },
              env: {
                GITHUB_TOKEN: {
                  from: "link",
                  id: "cred_foreign",
                  provider: "github",
                  key: "token",
                },
              },
            },
          },
        },
      },
    });

    const result = toIdRefs(config, { github: "cred_user_new" });

    expect(result.tools?.mcp?.servers?.github?.env?.GITHUB_TOKEN).toEqual({
      from: "link",
      id: "cred_user_new",
      provider: "github",
      key: "token",
    });
  });

  test("leaves ref with only id untouched", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "github-mcp" },
              env: { GITHUB_TOKEN: { from: "link", id: "cred_legacy", key: "token" } },
            },
          },
        },
      },
    });

    const result = toIdRefs(config, {});

    expect(result.tools?.mcp?.servers?.github?.env?.GITHUB_TOKEN).toEqual({
      from: "link",
      id: "cred_legacy",
      key: "token",
    });
  });

  test("returns unchanged config when no credentials exist", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            linear: {
              transport: { type: "stdio", command: "linear-mcp" },
              env: { PLAIN_VAR: "just-a-string" },
            },
          },
        },
      },
    });

    const result = toIdRefs(config, {});

    expect(result).toEqual(config);
  });

  test("handles credentials in agent env", () => {
    const config = createTestConfig({
      agents: {
        "slack-agent": atlasAgent({
          env: { SLACK_TOKEN: { from: "link", provider: "slack", key: "bot_token" } },
        }),
      },
    });

    const result = toIdRefs(config, { slack: "cred_slack_456" });

    expect(result.agents?.["slack-agent"]).toHaveProperty("env.SLACK_TOKEN", {
      from: "link",
      id: "cred_slack_456",
      provider: "slack",
      key: "bot_token",
    });
  });

  test("leaves provider-only ref unchanged when missing from credentialMap", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            linear: {
              transport: { type: "stdio", command: "linear-mcp" },
              env: { LINEAR_TOKEN: { from: "link", provider: "linear", key: "access_token" } },
            },
          },
        },
      },
    });

    const result = toIdRefs(config, {});
    // Ref should be unchanged — no id added
    expect(result.tools?.mcp?.servers?.linear?.env?.LINEAR_TOKEN).toEqual({
      from: "link",
      provider: "linear",
      key: "access_token",
    });
  });

  test("handles mixed refs across MCP servers and agents", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            linear: {
              transport: { type: "stdio", command: "linear-mcp" },
              env: {
                LINEAR_TOKEN: { from: "link", provider: "linear", key: "access_token" },
                PLAIN_VAR: "not-a-credential",
              },
            },
          },
        },
      },
      agents: {
        "my-agent": atlasAgent({
          env: {
            AGENT_TOKEN: { from: "link", id: "cred_bound", provider: "custom", key: "token" },
          },
        }),
      },
    });

    const result = toIdRefs(config, { linear: "cred_lin_new", custom: "cred_custom_new" });

    expect(result.tools?.mcp?.servers?.linear?.env?.LINEAR_TOKEN).toEqual({
      from: "link",
      id: "cred_lin_new",
      provider: "linear",
      key: "access_token",
    });
    expect(result.tools?.mcp?.servers?.linear?.env?.PLAIN_VAR).toBe("not-a-credential");
    expect(result.agents?.["my-agent"]).toHaveProperty("env.AGENT_TOKEN", {
      from: "link",
      id: "cred_custom_new",
      provider: "custom",
      key: "token",
    });
  });

  test("leaves ref with both id and provider unchanged when provider is missing from credentialMap", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "github-mcp" },
              env: {
                GITHUB_TOKEN: {
                  from: "link",
                  id: "cred_foreign",
                  provider: "github",
                  key: "token",
                },
              },
            },
          },
        },
      },
    });

    const result = toIdRefs(config, {});
    // Ref should be unchanged — provider not in map, partial resolution
    expect(result.tools?.mcp?.servers?.github?.env?.GITHUB_TOKEN).toEqual({
      from: "link",
      id: "cred_foreign",
      provider: "github",
      key: "token",
    });
  });
});

describe("stripCredentialRefs", () => {
  test("strips MCP server env var by path", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "github-mcp" },
              env: { GITHUB_TOKEN: { from: "link", id: "cred_foreign", key: "token" } },
            },
          },
        },
      },
    });

    const result = stripCredentialRefs(config, ["mcp:github:GITHUB_TOKEN"]);

    const env = result.tools?.mcp?.servers?.github?.env ?? {};
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(result.tools?.mcp?.servers?.github).toBeDefined();
  });

  test("strips agent env var by path", () => {
    const config = createTestConfig({
      agents: {
        summarizer: atlasAgent({
          env: { API_KEY: { from: "link", id: "cred_foreign", key: "api_key" } },
        }),
      },
    });

    const result = stripCredentialRefs(config, ["agent:summarizer:API_KEY"]);

    const agent = result.agents?.summarizer;
    expect(agent).toBeDefined();
    if (agent && agent.type === "atlas") {
      expect(agent.env?.API_KEY).toBeUndefined();
    }
  });

  test("returns unchanged config for empty paths array", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "github-mcp" },
              env: { GITHUB_TOKEN: { from: "link", id: "cred_abc", key: "token" } },
            },
          },
        },
      },
    });

    const result = stripCredentialRefs(config, []);

    expect(result).toEqual(config);
  });

  test("returns unchanged config when paths do not match any env vars", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "github-mcp" },
              env: { GITHUB_TOKEN: { from: "link", id: "cred_abc", key: "token" } },
            },
          },
        },
      },
    });

    const result = stripCredentialRefs(config, ["mcp:nonexistent:SOME_VAR"]);

    expect(result.tools?.mcp?.servers?.github?.env?.GITHUB_TOKEN).toEqual({
      from: "link",
      id: "cred_abc",
      key: "token",
    });
  });

  test("preserves other env vars on the same server", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "github-mcp" },
              env: {
                GITHUB_TOKEN: { from: "link", id: "cred_foreign", key: "token" },
                OTHER_VAR: "plain-value",
                ANOTHER_CRED: { from: "link", provider: "github", key: "secret" },
              },
            },
          },
        },
      },
    });

    const result = stripCredentialRefs(config, ["mcp:github:GITHUB_TOKEN"]);

    const env = result.tools?.mcp?.servers?.github?.env ?? {};
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.OTHER_VAR).toBe("plain-value");
    expect(env.ANOTHER_CRED).toEqual({ from: "link", provider: "github", key: "secret" });
  });

  test("does not mutate original config", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "github-mcp" },
              env: { GITHUB_TOKEN: { from: "link", id: "cred_foreign", key: "token" } },
            },
          },
        },
      },
    });
    const originalRef = config.tools?.mcp?.servers?.github?.env?.GITHUB_TOKEN;

    stripCredentialRefs(config, ["mcp:github:GITHUB_TOKEN"]);

    expect(config.tools?.mcp?.servers?.github?.env?.GITHUB_TOKEN).toBe(originalRef);
  });

  test("skips non-atlas agents", () => {
    const config = createTestConfig({
      agents: {
        "llm-agent": {
          type: "llm",
          description: "Test LLM agent",
          config: { provider: "anthropic", model: "claude-sonnet-4-6", prompt: "Test" },
        },
      },
    });

    const result = stripCredentialRefs(config, ["agent:llm-agent:SOME_VAR"]);

    expect(result).toEqual(config);
  });

  test("strips from both MCP servers and agents in one call", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "github-mcp" },
              env: { GITHUB_TOKEN: { from: "link", id: "cred_1", key: "token" } },
            },
          },
        },
      },
      agents: {
        summarizer: atlasAgent({
          env: { API_KEY: { from: "link", id: "cred_2", key: "api_key" } },
        }),
      },
    });

    const result = stripCredentialRefs(config, [
      "mcp:github:GITHUB_TOKEN",
      "agent:summarizer:API_KEY",
    ]);

    expect(result.tools?.mcp?.servers?.github?.env?.GITHUB_TOKEN).toBeUndefined();
    expect(result.tools?.mcp?.servers?.github).toBeDefined();
    const agent = result.agents?.summarizer;
    expect(agent).toBeDefined();
    if (agent && agent.type === "atlas") {
      expect(agent.env?.API_KEY).toBeUndefined();
    }
  });
});
