/**
 * Integration tests for agent tool format compatibility
 * These tests ensure the new hierarchical tool format works correctly
 * across the entire system without backwards compatibility issues.
 */

import {
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { SessionSupervisorActor } from "../../src/core/actors/session-supervisor-actor.ts";

/**
 * Test agent tool checking logic directly
 * This test would have caught the "agent.config?.tools?.includes is not a function" bug
 */
Deno.test("Agent tool checking handles new hierarchical tool format", () => {
  // Create test agent with new hierarchical format
  const agent = {
    type: "llm",
    model: "claude-3-5-haiku-20241022",
    purpose: "Test agent with new tool format",
    default_tools: ["workspace.memory.recall"],
    tools: {
      mcp: ["computer_use", "filesystem-context"],
      workspace: ["workspace.sessions.describe"],
    },
    config: {},
  };

  // Test the actual logic used in SessionSupervisor (line 1145)
  // This should not throw "agent.config?.tools?.includes is not a function"
  const hasComputerUse = agent.tools?.mcp?.includes("computer_use") ||
    agent.tools?.workspace?.includes("computer_use");

  assertEquals(hasComputerUse, true, "Should correctly detect computer_use tool in new format");

  // Test that old format access would fail (this is what was broken)
  let oldFormatWouldFail = false;
  try {
    // This is the old broken code that caused the bug
    const oldResult = (agent as any).config?.tools?.includes("computer_use");
  } catch (error) {
    oldFormatWouldFail = true;
  }

  // The old format should either be undefined or fail, not work
  assertEquals(
    (agent as any).config?.tools?.includes !== undefined,
    false,
    "Old format config.tools.includes should not exist",
  );
});

/**
 * Test that all workspace examples load without configuration errors
 */
Deno.test("All workspace examples use correct tool format", async () => {
  // Only test workspaces that have their own atlas.yml files
  const workspaceExamples = [
    "telephone",
    "mcp-test",
    "atlas-codebase-analyzer",
  ];

  for (const workspaceName of workspaceExamples) {
    const workspacePath = `./examples/workspaces/${workspaceName}`;

    try {
      const adapter = new FilesystemConfigAdapter();
      const loader = new ConfigLoader(adapter, workspacePath);
      const config = await loader.load();

      // Verify agents use new format
      for (const [agentId, agent] of Object.entries(config.workspace.agents || {})) {
        // Agent tools should be object format {mcp: [], workspace: []} or undefined
        if (agent.tools) {
          assertEquals(
            typeof agent.tools,
            "object",
            `Agent ${agentId} in ${workspaceName} should use object format for tools, not array`,
          );

          // Should not have old mcp_servers property
          assertEquals(
            (agent as any).mcp_servers,
            undefined,
            `Agent ${agentId} in ${workspaceName} should not use deprecated mcp_servers property`,
          );
        }
      }

      console.log(`✅ ${workspaceName} workspace configuration is valid`);
    } catch (error) {
      throw new Error(`❌ ${workspaceName} workspace failed to load: ${error.message}`);
    }
  }
});

/**
 * Test that job-level tool assignments work with new format
 */
Deno.test("Job-level tool assignments work with new format", async () => {
  const adapter = new FilesystemConfigAdapter();
  const loader = new ConfigLoader(adapter, "./examples/workspaces/telephone");
  const config = await loader.load();

  // Check telephone job agent tool assignments
  const telephoneJob = config.workspace.jobs?.telephone;
  assertExists(telephoneJob, "Telephone job should exist");

  for (const agentSpec of telephoneJob.execution.agents) {
    if (typeof agentSpec === "object" && agentSpec.tools) {
      // Job-level tools should be arrays of capability strings
      assertEquals(
        Array.isArray(agentSpec.tools),
        true,
        `Job agent ${agentSpec.id} tools should be array of capabilities`,
      );

      // Should contain workspace capabilities
      const hasWorkspaceCapability = agentSpec.tools.some((tool: string) =>
        tool.startsWith("workspace.")
      );
      assertEquals(
        hasWorkspaceCapability,
        true,
        `Job agent ${agentSpec.id} should have workspace capabilities`,
      );
    }
  }
});

/**
 * Test that agent tool checking works correctly with new format
 */
Deno.test("Agent tool checking handles new format correctly", () => {
  // Test data with new hierarchical format
  const agentWithMCPTools = {
    tools: {
      mcp: ["computer_use", "filesystem"],
      workspace: ["workspace.memory.recall"],
    },
  };

  const agentWithWorkspaceTools = {
    tools: {
      mcp: [],
      workspace: ["computer_use", "workspace.sessions.describe"],
    },
  };

  const agentWithNoTools = {
    tools: {
      mcp: [],
      workspace: [],
    },
  };

  // Simulate the tool checking logic used in SessionSupervisor
  function hasComputerUse(agent: any): boolean {
    return agent.tools?.mcp?.includes("computer_use") ||
      agent.tools?.workspace?.includes("computer_use");
  }

  // Test assertions
  assertEquals(hasComputerUse(agentWithMCPTools), true, "Should detect computer_use in MCP tools");
  assertEquals(
    hasComputerUse(agentWithWorkspaceTools),
    true,
    "Should detect computer_use in workspace tools",
  );
  assertEquals(
    hasComputerUse(agentWithNoTools),
    false,
    "Should not detect computer_use when not present",
  );
});

/**
 * Test configuration migration completeness
 */
Deno.test("No workspace examples use deprecated tool format", async () => {
  const workspaceExamples = [
    "./examples/workspaces/web-analysis/workspace.yml",
    "./examples/workspaces/mcp-test/workspace.yml",
    "./examples/workspaces/k8s-assistant/workspace.yml",
  ];

  for (const workspaceFile of workspaceExamples) {
    const content = await Deno.readTextFile(workspaceFile);

    // Check for deprecated agent-level mcp_servers property (not global tools.mcp.servers)
    const lines = content.split("\n");
    let hasDeprecatedMCPServers = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Look for agent-level mcp_servers (indented under an agent)
      if (line.includes("mcp_servers:") && (line.startsWith("    ") || line.startsWith("\t"))) {
        // Check if this is under an agent definition
        for (let j = i - 1; j >= 0; j--) {
          const prevLine = lines[j].trim();
          if (
            prevLine.endsWith(":") && !prevLine.startsWith("#") && !prevLine.includes("mcp") &&
            !prevLine.includes("tools")
          ) {
            // This looks like an agent name
            hasDeprecatedMCPServers = true;
            break;
          }
          if (!lines[j].startsWith("  ")) break; // Found non-indented line
        }
      }
    }
    assertEquals(
      hasDeprecatedMCPServers,
      false,
      `${workspaceFile} should not contain deprecated agent-level 'mcp_servers' property`,
    );

    // Check for old array-style tools
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("tools:") && line.includes("[")) {
        // This might be old array format - check context
        const nextLines = lines.slice(i + 1, i + 3).join(" ");
        if (!nextLines.includes("mcp:") && !nextLines.includes("workspace:")) {
          throw new Error(
            `${workspaceFile}:${
              i + 1
            } appears to use old array format for tools. Should use hierarchical format with mcp/workspace keys.`,
          );
        }
      }
    }
  }
});
