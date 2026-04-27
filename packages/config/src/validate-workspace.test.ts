import { readFile } from "node:fs/promises";
import { parse } from "@std/yaml";
import { describe, expect, it } from "vitest";
import { validateWorkspace } from "./validate-workspace.ts";

const inboxZeroRegistry = {
  mcpServers: ["google-gmail"],
  mcpTools: {
    "google-gmail": [
      "search_gmail_messages",
      "get_gmail_message_content",
      "get_gmail_messages_content_batch",
      "get_gmail_thread_content",
      "modify_gmail_message_labels",
      "list_gmail_labels",
      "draft_gmail_message",
      "send_gmail_message",
    ],
  },
};

describe("validateWorkspace structural layer", () => {
  it("returns ok for a minimal valid config", () => {
    const result = validateWorkspace({ version: "1.0", workspace: { name: "Test Workspace" } });
    expect(result.status).toBe("ok");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("returns error for missing required field", () => {
    const result = validateWorkspace({ workspace: { name: "Test Workspace" } });
    expect(result.status).toBe("error");
    expect(result.errors.length).toBeGreaterThan(0);
    const missingVersion = result.errors.find((e) => e.path === "version");
    expect(missingVersion).toBeDefined();
    expect(missingVersion?.code).toBe("invalid_value");
    expect(missingVersion?.message).toMatch(/expected "1\.0"/i);
  });

  it("returns error for wrong type", () => {
    const result = validateWorkspace({ version: 1.0, workspace: { name: "Test Workspace" } });
    expect(result.status).toBe("error");
    expect(result.errors.length).toBeGreaterThan(0);
    const wrongType = result.errors.find((e) => e.path === "version");
    expect(wrongType).toBeDefined();
    expect(wrongType?.code).toBe("invalid_value");
  });

  it("returns error for invalid enum value", () => {
    const result = validateWorkspace({
      version: "1.0",
      workspace: { name: "Test Workspace" },
      improvement: "bananas",
    });
    expect(result.status).toBe("error");
    expect(result.errors.length).toBe(1);
    const enumError = result.errors[0];
    expect(enumError).toBeDefined();
    expect(enumError!.path).toBe("improvement");
    expect(enumError!.code).toBe("invalid_value");
    expect(enumError!.message).toMatch(/surface/i);
  });

  it("returns error for unknown extra key", () => {
    const result = validateWorkspace({
      version: "1.0",
      workspace: { name: "Test Workspace" },
      unknown_extra_key: "hello",
    });
    expect(result.status).toBe("error");
    expect(result.errors.length).toBe(1);
    const unknownKey = result.errors[0];
    expect(unknownKey).toBeDefined();
    expect(unknownKey!.path).toBe("");
    expect(unknownKey!.code).toBe("unrecognized_keys");
    expect(unknownKey!.message).toMatch(/unknown_extra_key/i);
  });

  it("produces distinct Issue objects for multiple Zod issues", () => {
    const result = validateWorkspace({
      version: 2.0,
      workspace: { name: "Test" },
      improvement: "bananas",
      bad_key: "value",
    });
    expect(result.status).toBe("error");
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    // Each issue should have a unique combination of path + code + message
    const signatures = result.errors.map((e) => `${e.path}|${e.code}|${e.message}`);
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it("produces dot-notation path for nested issues", () => {
    const result = validateWorkspace({
      version: "1.0",
      workspace: { name: "Test" },
      signals: { "my-signal": { provider: "http", description: "Test", config: { path: 123 } } },
    });
    expect(result.status).toBe("error");
    const pathError = result.errors.find((e) => e.path.includes("path"));
    expect(pathError).toBeDefined();
    expect(pathError?.path).toMatch(/^signals\.my-signal\.config\.path$/);
  });

  it("produces warnings array empty for structural-only validation", () => {
    const result = validateWorkspace({ version: "1.0", workspace: { name: "Test" } });
    expect(result.warnings).toEqual([]);
  });

  it("returns structured path for missing signal description", () => {
    const result = validateWorkspace({
      version: "1.0",
      workspace: { name: "Test" },
      signals: {
        "review-inbox": { provider: "http", config: { path: "/review" } },
      },
    });
    expect(result.status).toBe("error");
    const err = result.errors.find((e) => e.path === "signals.review-inbox.description");
    expect(err).toBeDefined();
    expect(err!.code).toBe("invalid_type");
    expect(err!.message).not.toBe("expected string, received undefined");
    expect(err!.message).toMatch(/required|expected string|invalid input/i);
  });

  it("never emits raw Zod stringification in any issue message", () => {
    const bad = validateWorkspace({
      version: 2.0,
      workspace: { name: "Test" },
      signals: {
        "review-inbox": { provider: "http", config: { path: "/review" } },
      },
      agents: {
        orphan: { type: "llm", description: "Orphan", config: { provider: "anthropic", model: "claude-sonnet-4-5", prompt: "Hi" } },
      },
    });
    const allIssues = [...bad.errors, ...bad.warnings];
    for (const issue of allIssues) {
      expect(issue.message).not.toContain("[object Object]");
      expect(issue.message).not.toContain("ZodError");
      expect(issue.message).not.toContain("JSON.stringify");
    }
  });

  it("validates Ken's Inbox-Zero workspace as clean", async () => {
    const yaml = await readFile("/Users/ericskram/Desktop/Inbox-Zero/workspace.yml", "utf-8");
    const parsed: unknown = parse(yaml);
    const result = validateWorkspace(parsed, inboxZeroRegistry);
    expect(result.status).toBe("ok");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("validateWorkspace reference integrity", () => {
  it("errors on unknown agent ID in FSM action", () => {
    const result = validateWorkspace({
      version: "1.0",
      workspace: { name: "Test" },
      agents: { known: { type: "llm", description: "Known", config: { provider: "anthropic", model: "claude-sonnet-4-5", prompt: "Hi" } } },
      jobs: {
        my_job: {
          triggers: [{ signal: "s1" }],
          fsm: {
            id: "fsm1",
            initial: "step1",
            states: {
              step1: {
                entry: [{ type: "agent", agentId: "unknown-agent", outputTo: "out" }],
              },
            },
          },
        },
      },
      signals: { s1: { provider: "http", description: "S1", config: { path: "/s1" } } },
    });
    expect(result.status).toBe("error");
    const err = result.errors.find((e) => e.code === "unknown_agent_id");
    expect(err).toBeDefined();
    expect(err!.path).toBe("jobs.my_job.fsm.states.step1.entry[0].agentId");
  });

  it("errors on unknown tool in agent config.tools", () => {
    const result = validateWorkspace({
      version: "1.0",
      workspace: { name: "Test" },
      agents: {
        my_agent: {
          type: "llm",
          description: "Test agent",
          config: { provider: "anthropic", model: "claude-sonnet-4-5", prompt: "Hi", tools: ["bogus_tool"] },
        },
      },
    });
    expect(result.status).toBe("error");
    const err = result.errors.find((e) => e.code === "unknown_tool");
    expect(err).toBeDefined();
    expect(err!.path).toBe("agents.my_agent.config.tools[0]");
  });

  it("errors on unknown memory store referenced in agent prompt", () => {
    const result = validateWorkspace({
      version: "1.0",
      workspace: { name: "Test" },
      agents: {
        my_agent: {
          type: "llm",
          description: "Test agent",
          config: { provider: "anthropic", model: "claude-sonnet-4-5", prompt: 'Use "ghost-store" memory to save data.' },
        },
      },
    });
    expect(result.status).toBe("error");
    const err = result.errors.find((e) => e.code === "unknown_memory_store");
    expect(err).toBeDefined();
    expect(err!.message).toContain("ghost-store");
  });
});

describe("validateWorkspace semantic warnings", () => {
  it("warns missing_tools_array when tool_choice auto and no tools with MCP servers", () => {
    const result = validateWorkspace({
      version: "1.0",
      workspace: { name: "Test" },
      tools: {
        mcp: {
          servers: {
            some_server: { transport: { type: "stdio", command: "echo" } },
          },
        },
      },
      agents: {
        my_agent: {
          type: "llm",
          description: "Test agent",
          config: { provider: "anthropic", model: "claude-sonnet-4-5", prompt: "Hi", tool_choice: "auto" },
        },
      },
    });
    expect(result.status).toBe("warning");
    const warn = result.warnings.find((w) => w.code === "missing_tools_array");
    expect(warn).toBeDefined();
    expect(warn!.path).toBe("agents.my_agent.config.tools");
  });

  it("warns dead_signal when signal has no triggering job", () => {
    const result = validateWorkspace({
      version: "1.0",
      workspace: { name: "Test" },
      signals: {
        unused: { provider: "http", description: "Unused", config: { path: "/unused" } },
      },
    });
    expect(result.status).toBe("warning");
    const warn = result.warnings.find((w) => w.code === "dead_signal");
    expect(warn).toBeDefined();
    expect(warn!.path).toBe("signals.unused");
  });

  it("warns orphan_agent when agent is not referenced by any job", () => {
    const result = validateWorkspace({
      version: "1.0",
      workspace: { name: "Test" },
      agents: {
        orphan: { type: "llm", description: "Orphan", config: { provider: "anthropic", model: "claude-sonnet-4-5", prompt: "Hi" } },
      },
      jobs: {
        my_job: {
          triggers: [{ signal: "s1" }],
          execution: { agents: ["other"] },
        },
      },
      signals: {
        s1: { provider: "http", description: "S1", config: { path: "/s1" } },
      },
    });
    expect(result.status).toBe("warning");
    const warn = result.warnings.find((w) => w.code === "orphan_agent");
    expect(warn).toBeDefined();
    expect(warn!.path).toBe("agents.orphan");
  });

  it("produces no orphan_agent warning when every agent is referenced by a job", () => {
    const result = validateWorkspace({
      version: "1.0",
      workspace: { name: "Test" },
      agents: {
        triager: { type: "llm", description: "Triager", config: { provider: "anthropic", model: "claude-sonnet-4-5", prompt: "Hi" } },
      },
      jobs: {
        my_job: {
          triggers: [{ signal: "s1" }],
          fsm: {
            id: "fsm1",
            initial: "step1",
            states: {
              step1: {
                entry: [{ type: "agent", agentId: "triager", outputTo: "out" }],
              },
            },
          },
        },
      },
      signals: {
        s1: { provider: "http", description: "S1", config: { path: "/s1" } },
      },
    });
    expect(result.warnings.find((w) => w.code === "orphan_agent")).toBeUndefined();
  });

  it("warns cron_parse_failed for invalid schedule", () => {
    const result = validateWorkspace({
      version: "1.0",
      workspace: { name: "Test" },
      signals: {
        bad: {
          provider: "schedule",
          description: "Bad",
          config: { schedule: "not a cron", timezone: "UTC" },
        },
      },
    });
    expect(result.status).toBe("warning");
    const warn = result.warnings.find((w) => w.code === "cron_parse_failed");
    expect(warn).toBeDefined();
    expect(warn!.path).toBe("signals.bad.config.schedule");
  });

  it("warns http_path_collision when two HTTP signals share a path", () => {
    const result = validateWorkspace({
      version: "1.0",
      workspace: { name: "Test" },
      signals: {
        a: { provider: "http", description: "A", config: { path: "/same" } },
        b: { provider: "http", description: "B", config: { path: "/same" } },
      },
    });
    expect(result.status).toBe("warning");
    const warn = result.warnings.find((w) => w.code === "http_path_collision");
    expect(warn).toBeDefined();
    expect(warn!.message).toContain("/same");
  });

  it("validates Meeting-Scheduler workspace as clean", async () => {
    const yaml = await readFile("/Users/ericskram/Desktop/Meeting-Scheduler/workspace.yml", "utf-8");
    const parsed: unknown = parse(yaml);
    const result = validateWorkspace(parsed);
    expect(result.status).toBe("ok");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});
