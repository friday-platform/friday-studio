/**
 * Tests for credential extraction and mutation functions
 */

import { describe, expect, test } from "vitest";
import { extractCredentials, updateCredential } from "./credentials.ts";
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

    expect(result).toEqual([{ path: "mcp:linear:LINEAR_ACCESS_TOKEN", provider: "linear" }]);
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

    expect(result).toEqual([{ path: "mcp:github:GITHUB_TOKEN", credentialId: "cred_abc123" }]);
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

    expect(result).toEqual([{ path: "agent:slack-agent:SLACK_TOKEN", provider: "slack" }]);
  });

  test("skips non-atlas agents", () => {
    const config = createTestConfig({
      agents: {
        "llm-agent": {
          type: "llm",
          description: "Test LLM agent",
          config: { provider: "anthropic", model: "claude-sonnet-4-5", prompt: "Test" },
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
          config: { provider: "anthropic", model: "claude-sonnet-4-5", prompt: "Test" },
        },
      },
    });

    const result = extractCredentials(config);

    expect(result).toHaveLength(3);
    expect(result).toContainEqual({ path: "mcp:linear:LINEAR_TOKEN", provider: "linear" });
    expect(result).toContainEqual({ path: "mcp:github:GITHUB_TOKEN", credentialId: "cred_github" });
    expect(result).toContainEqual({ path: "agent:slack-agent:SLACK_TOKEN", provider: "slack" });
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
    expect((originalEnv as { provider?: string }).provider).toBe("linear");
  });
});
