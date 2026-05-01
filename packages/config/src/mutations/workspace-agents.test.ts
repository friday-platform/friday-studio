/**
 * Tests for workspace-level agent extraction
 */

import { describe, expect, test } from "vitest";
import { atlasAgent, createTestConfig, llmAgent, systemAgent } from "./test-fixtures.ts";
import { deriveWorkspaceAgents } from "./workspace-agents.ts";

describe("deriveWorkspaceAgents", () => {
  test("returns empty array when agents section is undefined", () => {
    const config = createTestConfig();

    const result = deriveWorkspaceAgents(config);

    expect(result).toEqual([]);
  });

  test("returns empty array when agents section is empty", () => {
    const config = createTestConfig({ agents: {} });

    const result = deriveWorkspaceAgents(config);

    expect(result).toEqual([]);
  });

  test("extracts atlas agent with all fields", () => {
    const config = createTestConfig({
      agents: {
        "repo-cloner": atlasAgent({
          agent: "claude-code",
          description: "Clones the target repository",
          prompt: "You are Repo Cloner.",
          env: { ANTHROPIC_API_KEY: { from: "link", provider: "anthropic", key: "access_token" } },
        }),
      },
    });

    const result = deriveWorkspaceAgents(config);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "repo-cloner",
      name: "repo-cloner",
      description: "Clones the target repository",
      type: "atlas",
      agent: "claude-code",
      prompt: "You are Repo Cloner.",
      env: { ANTHROPIC_API_KEY: { from: "link", provider: "anthropic", key: "access_token" } },
      provider: undefined,
      model: undefined,
      temperature: undefined,
      tools: undefined,
      maxTokens: undefined,
      toolChoice: undefined,
      timeout: undefined,
      maxRetries: undefined,
      providerOptions: undefined,
    });
  });

  test("extracts LLM agent with prompt from nested config", () => {
    const config = createTestConfig({
      agents: {
        summarizer: llmAgent({
          description: "Summarizes content",
          prompt: "Summarize the following.",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        }),
      },
    });

    const result = deriveWorkspaceAgents(config);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "summarizer",
      name: "summarizer",
      description: "Summarizes content",
      type: "llm",
      agent: undefined,
      prompt: "Summarize the following.",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      temperature: 0.3,
      tools: undefined,
      maxTokens: undefined,
      toolChoice: undefined,
      timeout: undefined,
      maxRetries: undefined,
      providerOptions: undefined,
    });
  });

  test("extracts LLM agent with full config", () => {
    const config = createTestConfig({
      agents: {
        "full-llm": llmAgent({
          description: "Full config agent",
          provider: "openai",
          model: "gpt-4o",
          temperature: 0.7,
          max_tokens: 4096,
          tool_choice: "required",
          tools: ["search", "calculator"],
          timeout: "30s",
          max_retries: 3,
          provider_options: { reasoning_effort: "high" },
        }),
      },
    });

    const result = deriveWorkspaceAgents(config);

    expect(result[0]).toMatchObject({
      provider: "openai",
      model: "gpt-4o",
      temperature: 0.7,
      maxTokens: 4096,
      toolChoice: "required",
      tools: ["search", "calculator"],
      timeout: "30s",
      maxRetries: 3,
      providerOptions: { reasoning_effort: "high" },
    });
  });

  test("extracts system agent with agent identifier", () => {
    const config = createTestConfig({
      agents: {
        "chat-agent": systemAgent({
          agent: "conversation",
          description: "Handles chat",
          prompt: "You are a chat assistant.",
        }),
      },
    });

    const result = deriveWorkspaceAgents(config);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "chat-agent",
      name: "chat-agent",
      description: "Handles chat",
      type: "system",
      agent: "conversation",
      prompt: "You are a chat assistant.",
      provider: undefined,
      model: undefined,
      temperature: undefined,
      tools: undefined,
    });
  });

  test("system agent without config has undefined prompt", () => {
    const config = createTestConfig({
      agents: {
        "basic-agent": systemAgent({ agent: "conversation", description: "Basic system agent" }),
      },
    });

    const result = deriveWorkspaceAgents(config);

    expect(result[0]).toMatchObject({ prompt: undefined });
  });

  test("handles PR review workspace — extracts 3 atlas agents", () => {
    const config = createTestConfig({
      agents: {
        "repo-cloner": atlasAgent({
          agent: "claude-code",
          description: "Clones the target repository",
          prompt: "You are Repo Cloner.",
          env: {
            ANTHROPIC_API_KEY: { from: "link", provider: "anthropic", key: "access_token" },
            GH_TOKEN: { from: "link", provider: "github", key: "access_token" },
          },
        }),
        "code-reviewer": atlasAgent({
          agent: "claude-code",
          description: "Reviews the pull request diff",
          prompt: "You are Code Reviewer.",
          env: {
            ANTHROPIC_API_KEY: { from: "link", provider: "anthropic", key: "access_token" },
            GH_TOKEN: { from: "link", provider: "github", key: "access_token" },
          },
        }),
        "review-reporter": atlasAgent({
          agent: "claude-code",
          description: "Posts the code review",
          prompt: "You are Review Reporter.",
          env: {
            ANTHROPIC_API_KEY: { from: "link", provider: "anthropic", key: "access_token" },
            GH_TOKEN: { from: "link", provider: "github", key: "access_token" },
          },
        }),
      },
    });

    const result = deriveWorkspaceAgents(config);

    expect(result).toHaveLength(3);

    const ids = result.map((a) => a.id);
    expect(ids).toContain("repo-cloner");
    expect(ids).toContain("code-reviewer");
    expect(ids).toContain("review-reporter");

    for (const agent of result) {
      expect(agent.type).toBe("atlas");
      expect(agent.agent).toBe("claude-code");
      expect(agent.prompt).toBeDefined();
      expect(agent.env).toHaveProperty("ANTHROPIC_API_KEY");
      expect(agent.env).toHaveProperty("GH_TOKEN");
    }
  });

  test("atlas agent without env returns empty env object", () => {
    const config = createTestConfig({
      agents: {
        "no-env-agent": atlasAgent({
          agent: "claude-code",
          description: "No env vars",
          prompt: "Test prompt",
        }),
      },
    });

    const result = deriveWorkspaceAgents(config);

    expect(result[0]?.env).toEqual({});
  });

  test("non-atlas agents return empty env object", () => {
    const config = createTestConfig({
      agents: { "llm-agent": llmAgent({ description: "LLM agent" }) },
    });

    const result = deriveWorkspaceAgents(config);

    expect(result[0]?.env).toEqual({});
  });
});
