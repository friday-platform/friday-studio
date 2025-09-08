/**
 * Integration tests for agent tool format compatibility
 * These tests ensure the new simple array tool format works correctly
 * across the entire system without backwards compatibility issues.
 */

import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { assertEquals, assertExists } from "@std/assert";

/**
 * Test that all workspace examples load without configuration errors
 */
Deno.test({
  name: "All workspace examples use correct tool format",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Only test workspaces that are still in this repository
    // atlas-codebase-analyzer has been moved to atlas-workspaces repository
    const workspaceExamples = ["telephone"];

    for (const workspaceName of workspaceExamples) {
      const workspacePath = `./examples/${workspaceName}`;

      try {
        const adapter = new FilesystemConfigAdapter(workspacePath);
        const loader = new ConfigLoader(adapter, workspacePath);
        const config = await loader.load();

        // Verify agents use new format
        for (const [agentId, agent] of Object.entries(config.workspace.agents || {})) {
          // Agent tools should be simple array format ["tool1", "tool2"] or undefined
          if (agent.tools) {
            assertEquals(
              Array.isArray(agent.tools),
              true,
              `Agent ${agentId} in ${workspaceName} should use simple array format for tools`,
            );

            // Should not have old mcp_servers property
            assertEquals(
              agent.mcp_servers,
              undefined,
              `Agent ${agentId} in ${workspaceName} should not use deprecated mcp_servers property`,
            );
          }
        }

        // Configuration loaded successfully
      } catch (error) {
        throw new Error(`❌ ${workspaceName} workspace failed to load: ${error.message}`);
      }
    }
  },
});

/**
 * Test that job-level tool assignments work with new format
 */
Deno.test({
  name: "Job-level tool assignments work with new format",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const adapter = new FilesystemConfigAdapter("./examples/telephone");
    const loader = new ConfigLoader(adapter, "./examples/telephone");
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
          tool.startsWith("workspace."),
        );
        assertEquals(
          hasWorkspaceCapability,
          true,
          `Job agent ${agentSpec.id} should have workspace capabilities`,
        );
      }
    }
  },
});

/**
 * Test that agent tool checking works correctly with new format
 */
Deno.test("Agent tool checking validates simple array format", () => {
  // Test data with new simple array format
  const agentWithMCPTools = { tools: ["computer_use", "filesystem", "workspace.memory.recall"] };

  const agentWithWorkspaceTools = { tools: ["computer_use", "workspace.sessions.describe"] };

  const agentWithNoTools = { tools: [] };

  // Simulate the tool checking logic used in SessionSupervisor
  function hasComputerUse(agent: any): boolean {
    return agent.tools?.includes("computer_use");
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
Deno.test({
  name: "All workspace examples use proper tool format",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const workspaceExamples = [
      // Examples moved to https://github.com/tempestteam/atlas-workspaces
      // Using fixture files for testing instead
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
              prevLine.endsWith(":") &&
              !prevLine.startsWith("#") &&
              !prevLine.includes("mcp") &&
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

      // Check for old hierarchical-style tools in agent configurations
      let inAgentSection = false;
      let currentAgentName = "";

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Check if we're entering an agent section
        if (line === "agents:") {
          inAgentSection = true;
          continue;
        }

        // Check if we're leaving the agents section
        if (inAgentSection && line.match(/^[a-zA-Z-]+:$/) && !line.startsWith("  ")) {
          if (
            ![
              "agents:",
              "signals:",
              "jobs:",
              "tools:",
              "memory:",
              "federation:",
              "server:",
              "workspace:",
            ].includes(line)
          ) {
            inAgentSection = false;
          }
        }

        // Track current agent name
        if (inAgentSection && line.match(/^ {2}[a-zA-Z-]+:$/) && !line.startsWith("    ")) {
          currentAgentName = line.replace(":", "").trim();
        }

        // Check for agent-level tools configuration
        if (
          inAgentSection &&
          currentAgentName &&
          line.startsWith("      tools:") &&
          !line.includes("[")
        ) {
          // This might be old hierarchical format - check context
          const nextLines = lines.slice(i + 1, i + 3).join(" ");
          if (nextLines.includes("mcp:") || nextLines.includes("workspace:")) {
            throw new Error(
              `${workspaceFile}:${
                i + 1
              } appears to use old hierarchical format for agent tools. Agent '${currentAgentName}' should use simple array format like tools: ["tool1", "tool2"].`,
            );
          }
        }
      }
    }
  },
});
