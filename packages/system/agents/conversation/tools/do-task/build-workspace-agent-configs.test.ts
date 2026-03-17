/**
 * Tests for buildWorkspaceAgentConfigs — maps planner Agent objects to
 * WorkspaceAgentConfig records for agent indirection.
 */

import type { Agent } from "@atlas/workspace-builder";
import { describe, expect, test } from "vitest";
import { buildWorkspaceAgentConfigs } from "./index.ts";

function makeAgent(overrides: Partial<Agent> & Pick<Agent, "id" | "name" | "description">): Agent {
  return { capabilities: [], ...overrides };
}

describe("buildWorkspaceAgentConfigs", () => {
  test("bundled agent produces atlas config with bundledId as agent field", () => {
    const agents = [
      makeAgent({
        id: "repo-cloner",
        name: "Repo Cloner",
        description: "Clones repositories",
        bundledId: "claude-code",
      }),
    ];

    const configs = buildWorkspaceAgentConfigs(agents);

    expect(configs["repo-cloner"]).toEqual({
      type: "atlas",
      agent: "claude-code",
      description: "Clones repositories",
      prompt: "Clones repositories",
    });
  });

  test("LLM agent with MCP servers produces llm config with tools", () => {
    const agents = [
      makeAgent({
        id: "notion-researcher",
        name: "Notion Researcher",
        description: "Searches Notion pages",
        mcpServers: [
          { serverId: "notion", name: "Notion" },
          { serverId: "slack", name: "Slack" },
        ],
      }),
    ];

    const configs = buildWorkspaceAgentConfigs(agents);

    expect(configs["notion-researcher"]).toMatchObject({
      type: "llm",
      description: "Searches Notion pages",
      config: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        prompt: "Searches Notion pages",
        temperature: 0.3,
        tools: ["notion", "slack"],
      },
    });
  });

  test("LLM agent without MCP servers produces llm config with no tools", () => {
    const agents = [
      makeAgent({ id: "summarizer", name: "Summarizer", description: "Summarizes content" }),
    ];

    const configs = buildWorkspaceAgentConfigs(agents);

    expect(configs["summarizer"]).toMatchObject({
      type: "llm",
      description: "Summarizes content",
      config: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        prompt: "Summarizes content",
        temperature: 0.3,
        tools: undefined,
      },
    });
  });

  test("mixed agents produce correct config types keyed by agent.id", () => {
    const agents = [
      makeAgent({
        id: "cloner",
        name: "Cloner",
        description: "Clones repos",
        bundledId: "claude-code",
      }),
      makeAgent({
        id: "analyst",
        name: "Analyst",
        description: "Analyzes data",
        mcpServers: [{ serverId: "sql", name: "SQL" }],
      }),
    ];

    const configs = buildWorkspaceAgentConfigs(agents);

    expect(configs["cloner"]?.type).toBe("atlas");
    expect(configs["analyst"]?.type).toBe("llm");
    expect(Object.keys(configs)).toEqual(["cloner", "analyst"]);
  });
});
