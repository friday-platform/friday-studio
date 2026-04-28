/**
 * Tests for MCP server mutation functions
 */

import { describe, expect, test } from "vitest";
import type { WorkspaceAgentConfig } from "../agents.ts";
import { WorkspaceConfigSchema } from "../workspace.ts";
import { disableMCPServer, enableMCPServer, findServerReferences } from "./mcp-servers.ts";
import { createTestConfig, expectError, llmAgent } from "./test-fixtures.ts";

function mcpServerConfig(command = "echo") {
  return { transport: { type: "stdio" as const, command, args: ["hello"] } };
}

function getLlmTools(agent: WorkspaceAgentConfig | undefined): string[] | undefined {
  return agent?.type === "llm" ? agent.config.tools : undefined;
}

// ==============================================================================
// findServerReferences
// ==============================================================================

describe("findServerReferences", () => {
  test("finds no references in an empty config", () => {
    const config = createTestConfig();
    const refs = findServerReferences(config, "github");
    expect(refs.agentIds).toEqual([]);
    expect(refs.jobIds).toEqual([]);
  });

  test("finds a top-level LLM agent that references the server", () => {
    const config = createTestConfig({
      agents: {
        "repo-agent": llmAgent({ description: "Repo agent", tools: ["github", "linear"] }),
      },
    });

    const refs = findServerReferences(config, "github");
    expect(refs.agentIds).toEqual(["repo-agent"]);
    expect(refs.jobIds).toEqual([]);
  });

  test("ignores non-LLM agents", () => {
    const config = createTestConfig({
      agents: {
        "system-agent": { type: "system", description: "System agent", agent: "claude-code" },
      },
    });

    const refs = findServerReferences(config, "github");
    expect(refs.agentIds).toEqual([]);
    expect(refs.jobIds).toEqual([]);
  });

  test("finds multiple LLM agents referencing the same server", () => {
    const config = createTestConfig({
      agents: {
        a1: llmAgent({ description: "A1", tools: ["github"] }),
        a2: llmAgent({ description: "A2", tools: ["github", "slack"] }),
      },
    });

    const refs = findServerReferences(config, "github");
    expect(refs.agentIds.sort()).toEqual(["a1", "a2"]);
    expect(refs.jobIds).toEqual([]);
  });

  test("finds an FSM job step that references the server", () => {
    const config = createTestConfig({
      jobs: {
        "research-job": {
          name: "research",
          fsm: {
            id: "research-job",
            initial: "step_0",
            states: {
              step_0: {
                entry: [
                  {
                    type: "llm",
                    provider: "anthropic",
                    model: "claude-sonnet-4-6",
                    prompt: "Research",
                    tools: ["github"],
                  },
                ],
              },
            },
          },
        },
      },
    });

    const refs = findServerReferences(config, "github");
    expect(refs.agentIds).toEqual([]);
    expect(refs.jobIds).toEqual(["research-job"]);
  });

  test("finds multiple FSM jobs referencing the same server", () => {
    const config = createTestConfig({
      jobs: {
        j1: {
          name: "j1",
          fsm: {
            id: "j1",
            initial: "s0",
            states: {
              s0: {
                entry: [
                  {
                    type: "llm",
                    provider: "openai",
                    model: "gpt-4",
                    prompt: "p",
                    tools: ["github"],
                  },
                ],
              },
            },
          },
        },
        j2: {
          name: "j2",
          fsm: {
            id: "j2",
            initial: "s0",
            states: {
              s0: {
                entry: [
                  {
                    type: "llm",
                    provider: "openai",
                    model: "gpt-4",
                    prompt: "p",
                    tools: ["github", "slack"],
                  },
                ],
              },
            },
          },
        },
      },
    });

    const refs = findServerReferences(config, "github");
    expect(refs.jobIds.sort()).toEqual(["j1", "j2"]);
  });

  test("ignores non-llm FSM actions", () => {
    const config = createTestConfig({
      jobs: {
        "agent-job": {
          name: "agent-job",
          fsm: {
            id: "agent-job",
            initial: "s0",
            states: { s0: { entry: [{ type: "agent", agentId: "claude-code" }] } },
          },
        },
      },
    });

    const refs = findServerReferences(config, "github");
    expect(refs.jobIds).toEqual([]);
  });

  test("deduplicates job IDs when multiple states reference the same server", () => {
    const config = createTestConfig({
      jobs: {
        "multi-state": {
          name: "multi-state",
          fsm: {
            id: "multi-state",
            initial: "s0",
            states: {
              s0: {
                entry: [
                  {
                    type: "llm",
                    provider: "openai",
                    model: "gpt-4",
                    prompt: "p",
                    tools: ["github"],
                  },
                ],
              },
              s1: {
                entry: [
                  {
                    type: "llm",
                    provider: "openai",
                    model: "gpt-4",
                    prompt: "p",
                    tools: ["github"],
                  },
                ],
              },
            },
          },
        },
      },
    });

    const refs = findServerReferences(config, "github");
    expect(refs.jobIds).toEqual(["multi-state"]);
  });

  test("returns both agent and job references", () => {
    const config = createTestConfig({
      agents: { a1: llmAgent({ description: "A1", tools: ["github"] }) },
      jobs: {
        j1: {
          name: "j1",
          fsm: {
            id: "j1",
            initial: "s0",
            states: {
              s0: {
                entry: [
                  {
                    type: "llm",
                    provider: "openai",
                    model: "gpt-4",
                    prompt: "p",
                    tools: ["github"],
                  },
                ],
              },
            },
          },
        },
      },
    });

    const refs = findServerReferences(config, "github");
    expect(refs.agentIds).toEqual(["a1"]);
    expect(refs.jobIds).toEqual(["j1"]);
  });

  test("finds top-level LLM agent with prefixed tool names (server-id/tool-name)", () => {
    const config = createTestConfig({
      agents: {
        "gmail-agent": llmAgent({
          description: "Gmail agent",
          tools: [
            "google-gmail/search_gmail_messages",
            "google-gmail/draft_gmail_message",
            "memory_read",
          ],
        }),
      },
    });

    const refs = findServerReferences(config, "google-gmail");
    expect(refs.agentIds).toEqual(["gmail-agent"]);
    expect(refs.jobIds).toEqual([]);
  });

  test("finds FSM job step with prefixed tool names (server-id/tool-name)", () => {
    const config = createTestConfig({
      jobs: {
        "email-job": {
          name: "email-job",
          fsm: {
            id: "email-job",
            initial: "s0",
            states: {
              s0: {
                entry: [
                  {
                    type: "llm",
                    provider: "openai",
                    model: "gpt-4",
                    prompt: "p",
                    tools: ["google-gmail/search_gmail_messages"],
                  },
                ],
              },
            },
          },
        },
      },
    });

    const refs = findServerReferences(config, "google-gmail");
    expect(refs.agentIds).toEqual([]);
    expect(refs.jobIds).toEqual(["email-job"]);
  });

  test("does not match partial server-id prefixes", () => {
    const config = createTestConfig({
      agents: { agent: llmAgent({ description: "Agent", tools: ["google-gmail-extra/search"] }) },
    });

    // "google-gmail" should NOT match "google-gmail-extra/search"
    const refs = findServerReferences(config, "google-gmail");
    expect(refs.agentIds).toEqual([]);
  });
});

// ==============================================================================
// enableMCPServer
// ==============================================================================

describe("enableMCPServer", () => {
  test("adds server to tools.mcp.servers", () => {
    const config = createTestConfig();
    const serverConfig = mcpServerConfig("github-mcp");

    const result = enableMCPServer(config, "github", serverConfig);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tools?.mcp?.servers?.github).toEqual(serverConfig);
    }
  });

  test("is idempotent when server is already enabled", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          client_config: { timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" } },
          servers: { github: mcpServerConfig("existing") },
        },
      },
    });

    const result = enableMCPServer(config, "github", mcpServerConfig("new"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tools?.mcp?.servers?.github).toEqual(mcpServerConfig("existing"));
      expect(result.value).toBe(config); // exact same reference
    }
  });

  test("produces a valid WorkspaceConfig", () => {
    const config = createTestConfig();
    const result = enableMCPServer(config, "github", mcpServerConfig());

    expect(result.ok).toBe(true);
    if (result.ok) {
      const validation = WorkspaceConfigSchema.safeParse(result.value);
      expect(validation.success).toBe(true);
    }
  });
});

// ==============================================================================
// disableMCPServer
// ==============================================================================

describe("disableMCPServer", () => {
  test("fails with not_found when server is not enabled", () => {
    const config = createTestConfig();

    const result = disableMCPServer(config, "github");

    expectError(result, "not_found", (e) => {
      expect(e.entityId).toBe("github");
      expect(e.entityType).toBe("mcp server");
    });
  });

  test("removes server when no agents or jobs reference it", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          client_config: { timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" } },
          servers: { github: mcpServerConfig(), slack: mcpServerConfig("slack-mcp") },
        },
      },
    });

    const result = disableMCPServer(config, "github");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tools?.mcp?.servers?.github).toBeUndefined();
      expect(result.value.tools?.mcp?.servers?.slack).toBeDefined();
    }
  });

  test("fails with conflict when referenced by a top-level LLM agent (no force)", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          client_config: { timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" } },
          servers: { github: mcpServerConfig() },
        },
      },
      agents: { "repo-agent": llmAgent({ description: "Repo agent", tools: ["github"] }) },
    });

    const result = disableMCPServer(config, "github");

    expectError(result, "conflict", (e) => {
      expect(e.willUnlinkFrom).toHaveLength(1);
      expect(e.willUnlinkFrom[0]).toEqual({ type: "agent", agentId: "repo-agent" });
    });
  });

  test("cascade removes server and cleans agent tools with force", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          client_config: { timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" } },
          servers: { github: mcpServerConfig(), slack: mcpServerConfig("slack-mcp") },
        },
      },
      agents: {
        "repo-agent": llmAgent({ description: "Repo agent", tools: ["github", "slack"] }),
        "other-agent": llmAgent({ description: "Other agent", tools: ["slack"] }),
      },
    });

    const result = disableMCPServer(config, "github", { force: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tools?.mcp?.servers?.github).toBeUndefined();
      expect(result.value.tools?.mcp?.servers?.slack).toBeDefined();
      expect(getLlmTools(result.value.agents?.["repo-agent"])).toEqual(["slack"]);
      expect(getLlmTools(result.value.agents?.["other-agent"])).toEqual(["slack"]);
    }
  });

  test("fails with conflict when referenced by an FSM job step (no force)", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          client_config: { timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" } },
          servers: { github: mcpServerConfig() },
        },
      },
      jobs: {
        "research-job": {
          name: "research",
          fsm: {
            id: "research-job",
            initial: "step_0",
            states: {
              step_0: {
                entry: [
                  {
                    type: "llm",
                    provider: "anthropic",
                    model: "claude-sonnet-4-6",
                    prompt: "Research",
                    tools: ["github"],
                  },
                ],
              },
            },
          },
        },
      },
    });

    const result = disableMCPServer(config, "github");

    expectError(result, "conflict", (e) => {
      expect(e.willUnlinkFrom).toHaveLength(1);
      expect(e.willUnlinkFrom[0]).toEqual({
        type: "job",
        jobId: "research-job",
        remainingTriggers: 0,
      });
    });
  });

  test("cascade removes server and cleans FSM job step tools with force", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          client_config: { timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" } },
          servers: { github: mcpServerConfig(), slack: mcpServerConfig("slack-mcp") },
        },
      },
      jobs: {
        j1: {
          name: "j1",
          fsm: {
            id: "j1",
            initial: "s0",
            states: {
              s0: {
                entry: [
                  {
                    type: "llm",
                    provider: "openai",
                    model: "gpt-4",
                    prompt: "p",
                    tools: ["github", "slack"],
                  },
                ],
              },
            },
          },
        },
        j2: {
          name: "j2",
          fsm: {
            id: "j2",
            initial: "s0",
            states: {
              s0: {
                entry: [
                  {
                    type: "llm",
                    provider: "openai",
                    model: "gpt-4",
                    prompt: "p",
                    tools: ["slack"],
                  },
                ],
              },
            },
          },
        },
      },
    });

    const result = disableMCPServer(config, "github", { force: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tools?.mcp?.servers?.github).toBeUndefined();
      expect(result.value.tools?.mcp?.servers?.slack).toBeDefined();

      const j1Entry = (result.value.jobs?.j1 as Record<string, unknown> | undefined)?.fsm as
        | Record<string, unknown>
        | undefined;
      const j1Tools = (
        (j1Entry?.states as Record<string, unknown> | undefined)?.s0 as
          | Record<string, unknown>
          | undefined
      )?.entry as Array<Record<string, unknown>> | undefined;
      expect(j1Tools?.[0]?.tools).toEqual(["slack"]);

      const j2Entry = (result.value.jobs?.j2 as Record<string, unknown> | undefined)?.fsm as
        | Record<string, unknown>
        | undefined;
      const j2Tools = (
        (j2Entry?.states as Record<string, unknown> | undefined)?.s0 as
          | Record<string, unknown>
          | undefined
      )?.entry as Array<Record<string, unknown>> | undefined;
      expect(j2Tools?.[0]?.tools).toEqual(["slack"]);
    }
  });

  test("reports both agent and job references in conflict", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          client_config: { timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" } },
          servers: { github: mcpServerConfig() },
        },
      },
      agents: { a1: llmAgent({ description: "A1", tools: ["github"] }) },
      jobs: {
        j1: {
          name: "j1",
          fsm: {
            id: "j1",
            initial: "s0",
            states: {
              s0: {
                entry: [
                  {
                    type: "llm",
                    provider: "openai",
                    model: "gpt-4",
                    prompt: "p",
                    tools: ["github"],
                  },
                ],
              },
            },
          },
        },
      },
    });

    const result = disableMCPServer(config, "github");

    expectError(result, "conflict", (e) => {
      expect(e.willUnlinkFrom).toHaveLength(2);
      expect(e.willUnlinkFrom).toContainEqual({ type: "agent", agentId: "a1" });
      expect(e.willUnlinkFrom).toContainEqual({ type: "job", jobId: "j1", remainingTriggers: 0 });
    });
  });

  test("cascade cleans both agents and jobs with force", () => {
    const config = createTestConfig({
      tools: {
        mcp: {
          client_config: { timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" } },
          servers: { github: mcpServerConfig() },
        },
      },
      agents: { a1: llmAgent({ description: "A1", tools: ["github", "slack"] }) },
      jobs: {
        j1: {
          name: "j1",
          fsm: {
            id: "j1",
            initial: "s0",
            states: {
              s0: {
                entry: [
                  {
                    type: "llm",
                    provider: "openai",
                    model: "gpt-4",
                    prompt: "p",
                    tools: ["github", "slack"],
                  },
                ],
              },
            },
          },
        },
      },
    });

    const result = disableMCPServer(config, "github", { force: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tools?.mcp?.servers?.github).toBeUndefined();
      expect(getLlmTools(result.value.agents?.a1)).toEqual(["slack"]);

      const j1Entry = (result.value.jobs?.j1 as Record<string, unknown> | undefined)?.fsm as
        | Record<string, unknown>
        | undefined;
      const j1Tools = (
        (j1Entry?.states as Record<string, unknown> | undefined)?.s0 as
          | Record<string, unknown>
          | undefined
      )?.entry as Array<Record<string, unknown>> | undefined;
      expect(j1Tools?.[0]?.tools).toEqual(["slack"]);
    }
  });
});
