/**
 * Tests for integration data derivation from workspace configuration.
 */

import { describe, expect, test } from "vitest";
import { deriveIntegrations } from "./integrations.ts";
import { atlasAgent, createTestConfig, llmAgent, systemAgent } from "./test-fixtures.ts";

describe("deriveIntegrations", () => {
  // ==========================================================================
  // CREDENTIALS
  // ==========================================================================

  describe("credentials", () => {
    test("returns empty credentials when no agents defined", () => {
      const config = createTestConfig();

      const result = deriveIntegrations(config);

      expect(result.credentials).toEqual([]);
    });

    test("excludes agents with no from:link env vars", () => {
      const config = createTestConfig({
        agents: {
          "plain-agent": atlasAgent({
            description: "No link refs",
            env: { API_KEY: "hardcoded-value" },
          }),
        },
      });

      const result = deriveIntegrations(config);

      expect(result.credentials).toEqual([]);
    });

    test("excludes LLM and system agents from credentials", () => {
      const config = createTestConfig({
        agents: {
          "llm-agent": llmAgent({ description: "LLM agent" }),
          "sys-agent": systemAgent({ description: "System agent" }),
        },
      });

      const result = deriveIntegrations(config);

      expect(result.credentials).toEqual([]);
    });

    test("extracts credentials grouped by provider and env key", () => {
      const config = createTestConfig({
        agents: {
          "agent-a": atlasAgent({
            description: "Agent A",
            env: {
              ANTHROPIC_API_KEY: { from: "link", provider: "anthropic", key: "access_token" },
            },
          }),
          "agent-b": atlasAgent({
            description: "Agent B",
            env: {
              ANTHROPIC_API_KEY: { from: "link", provider: "anthropic", key: "access_token" },
            },
          }),
        },
      });

      const result = deriveIntegrations(config);

      expect(result.credentials).toHaveLength(1);
      expect(result.credentials[0]).toEqual({
        provider: "anthropic",
        envKey: "ANTHROPIC_API_KEY",
        agentIds: ["agent-a", "agent-b"],
        status: "declared",
      });
    });

    test("PR review workspace — 2 providers, 3 agents each", () => {
      const config = createTestConfig({
        agents: {
          "repo-cloner": atlasAgent({
            agent: "claude-code",
            description: "Clones the target repository",
            env: {
              ANTHROPIC_API_KEY: { from: "link", provider: "anthropic", key: "access_token" },
              GH_TOKEN: { from: "link", provider: "github", key: "access_token" },
            },
          }),
          "code-reviewer": atlasAgent({
            agent: "claude-code",
            description: "Reviews the pull request diff",
            env: {
              ANTHROPIC_API_KEY: { from: "link", provider: "anthropic", key: "access_token" },
              GH_TOKEN: { from: "link", provider: "github", key: "access_token" },
            },
          }),
          "review-reporter": atlasAgent({
            agent: "claude-code",
            description: "Posts the code review",
            env: {
              ANTHROPIC_API_KEY: { from: "link", provider: "anthropic", key: "access_token" },
              GH_TOKEN: { from: "link", provider: "github", key: "access_token" },
            },
          }),
        },
      });

      const result = deriveIntegrations(config);

      expect(result.credentials).toHaveLength(2);

      const anthropic = result.credentials.find((c) => c.provider === "anthropic");
      expect(anthropic).toEqual({
        provider: "anthropic",
        envKey: "ANTHROPIC_API_KEY",
        agentIds: ["repo-cloner", "code-reviewer", "review-reporter"],
        status: "declared",
      });

      const github = result.credentials.find((c) => c.provider === "github");
      expect(github).toEqual({
        provider: "github",
        envKey: "GH_TOKEN",
        agentIds: ["repo-cloner", "code-reviewer", "review-reporter"],
        status: "declared",
      });
    });

    test("falls back to credential id when provider is absent", () => {
      const config = createTestConfig({
        agents: {
          "id-agent": atlasAgent({
            description: "Uses credential ID",
            env: { SECRET_KEY: { from: "link", id: "cred_abc123", key: "token" } },
          }),
        },
      });

      const result = deriveIntegrations(config);

      expect(result.credentials).toHaveLength(1);
      expect(result.credentials[0]).toEqual({
        provider: "cred_abc123",
        envKey: "SECRET_KEY",
        agentIds: ["id-agent"],
        status: "declared",
      });
    });
  });

  // ==========================================================================
  // MCP SERVERS
  // ==========================================================================

  describe("mcpServers", () => {
    test("returns empty when no tools config", () => {
      const config = createTestConfig();

      const result = deriveIntegrations(config);

      expect(result.mcpServers).toEqual([]);
    });

    test("extracts stdio MCP server with tool count from allow list", () => {
      const config = createTestConfig({
        tools: {
          mcp: {
            servers: {
              "filesystem-context": {
                transport: { type: "stdio", command: "npx", args: ["-y", "@mcp/server-fs"] },
                tools: { allow: ["read_file", "list_directory"] },
              },
            },
          },
        },
      });

      const result = deriveIntegrations(config);

      expect(result.mcpServers).toHaveLength(1);
      expect(result.mcpServers[0]).toEqual({
        name: "filesystem-context",
        transport: "stdio",
        toolCount: 2,
        agentIds: [],
      });
    });

    test("extracts http MCP server with zero tool count when no allow list", () => {
      const config = createTestConfig({
        tools: {
          mcp: {
            servers: {
              "remote-api": { transport: { type: "http", url: "https://api.example.com/mcp" } },
            },
          },
        },
      });

      const result = deriveIntegrations(config);

      expect(result.mcpServers).toHaveLength(1);
      expect(result.mcpServers[0]).toEqual({
        name: "remote-api",
        transport: "http",
        toolCount: 0,
        agentIds: [],
      });
    });

    test("resolves agent IDs from LLM agent tool references", () => {
      const config = createTestConfig({
        tools: {
          mcp: {
            servers: {
              "filesystem-context": {
                transport: { type: "stdio", command: "npx", args: ["-y", "@mcp/server-fs"] },
                tools: { allow: ["read_file"] },
              },
            },
          },
        },
        agents: {
          "agent-with-tools": llmAgent({
            description: "Uses filesystem",
            tools: ["filesystem-context"],
          }),
          "agent-without-tools": llmAgent({ description: "No tools" }),
        },
      });

      const result = deriveIntegrations(config);

      expect(result.mcpServers[0]?.agentIds).toEqual(["agent-with-tools"]);
    });

    test("multiple LLM agents sharing an MCP server", () => {
      const config = createTestConfig({
        tools: {
          mcp: {
            servers: {
              "shared-server": {
                transport: { type: "stdio", command: "node", args: ["server.js"] },
              },
            },
          },
        },
        agents: {
          "agent-a": llmAgent({ description: "Agent A", tools: ["shared-server"] }),
          "agent-b": llmAgent({ description: "Agent B", tools: ["shared-server"] }),
        },
      });

      const result = deriveIntegrations(config);

      expect(result.mcpServers[0]?.agentIds).toEqual(["agent-a", "agent-b"]);
    });
  });

  // ==========================================================================
  // EMPTY CONFIG
  // ==========================================================================

  test("empty config returns empty arrays", () => {
    const config = createTestConfig();

    const result = deriveIntegrations(config);

    expect(result).toEqual({ credentials: [], mcpServers: [] });
  });
});
