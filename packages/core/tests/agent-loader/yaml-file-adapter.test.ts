import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { YAMLFileAdapter } from "../../src/agent-loader/adapters/yaml-file-adapter.ts";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";

describe("YAMLFileAdapter", () => {
  const testDir = join(Deno.cwd(), "test-yaml-agents");
  const testDir2 = join(Deno.cwd(), "test-yaml-agents-2");
  let adapter: YAMLFileAdapter;

  beforeEach(async () => {
    // Create test directories
    await ensureDir(testDir);
    await ensureDir(testDir2);
  });

  afterEach(async () => {
    // Clean up test directories
    try {
      await Deno.remove(testDir, { recursive: true });
      await Deno.remove(testDir2, { recursive: true });
    } catch {
      // Ignore errors if directories don't exist
    }
  });

  describe("loadAgent", () => {
    it("should load a valid YAML agent file", async () => {
      // Create a valid test agent file
      const agentContent = `
agent:
  id: "test-agent"
  version: "1.0.0"
  description: "A test agent for unit tests"
  expertise:
    domains: ["testing"]
    capabilities: ["unit testing", "integration testing"]
    examples: ["run tests", "validate code"]

environment:
  required:
    - name: "TEST_API_KEY"
      description: "API key for testing"

llm:
  provider: "anthropic"
  model: "claude-3-haiku-20240307"
  prompt: "You are a testing expert."
`;

      await Deno.writeTextFile(join(testDir, "test-agent.agent.yml"), agentContent);

      adapter = new YAMLFileAdapter([testDir]);
      const result = await adapter.loadAgent("test-agent");

      assertEquals(result.type, "yaml");
      assertEquals(result.id, "test-agent");
      assertExists(result.content);
      assertEquals(result.metadata.sourceLocation, join(testDir, "test-agent.agent.yml"));
      assertExists(result.metadata.lastModified);

      // Verify content is what we wrote
      assertEquals(result.content, agentContent);
    });

    it("should throw error for non-existent agent", async () => {
      adapter = new YAMLFileAdapter([testDir]);

      await assertRejects(
        async () => await adapter.loadAgent("non-existent"),
        Error,
        "YAML agent not found: non-existent",
      );
    });

    it("should search multiple directories in order", async () => {
      // Create same agent in both directories with different content
      const agent1Content = `
agent:
  id: "duplicate-agent"
  version: "1.0.0"
  description: "First version"
  expertise:
    domains: ["testing"]
    capabilities: ["test"]
    examples: ["test"]

llm:
  provider: "anthropic"
  model: "claude-3-haiku-20240307"
  prompt: "You are the first version."
`;

      const agent2Content = `
agent:
  id: "duplicate-agent"
  version: "2.0.0"
  description: "Second version"
  expertise:
    domains: ["testing"]
    capabilities: ["test"]
    examples: ["test"]

llm:
  provider: "anthropic"
  model: "claude-3-haiku-20240307"
  prompt: "You are the second version."
`;

      await Deno.writeTextFile(join(testDir, "duplicate-agent.agent.yml"), agent1Content);
      await Deno.writeTextFile(join(testDir2, "duplicate-agent.agent.yml"), agent2Content);

      // Adapter should find the first one (testDir comes first)
      adapter = new YAMLFileAdapter([testDir, testDir2]);
      const result = await adapter.loadAgent("duplicate-agent");

      assertEquals(result.content?.includes("First version"), true);
      assertEquals(result.metadata.sourceLocation, join(testDir, "duplicate-agent.agent.yml"));
    });

    it("should handle read errors gracefully", async () => {
      // Create a file but make it unreadable
      const filePath = join(testDir, "unreadable.agent.yml");
      await Deno.writeTextFile(filePath, "content");
      await Deno.chmod(filePath, 0o000); // Remove all permissions

      adapter = new YAMLFileAdapter([testDir]);

      await assertRejects(
        async () => await adapter.loadAgent("unreadable"),
        Error,
        "Failed to read YAML agent file",
      );

      // Restore permissions for cleanup
      await Deno.chmod(filePath, 0o644);
    });
  });

  describe("listAgents", () => {
    it("should list all agents in configured directories", async () => {
      // Create multiple test agents
      const agent1 = `
agent:
  id: "agent-one"
  version: "1.0.0"
  description: "First test agent"
  expertise:
    domains: ["testing"]
    capabilities: ["test"]
    examples: ["test"]

llm:
  provider: "anthropic"
  model: "claude-3-haiku-20240307"
  prompt: "You are the first agent."
`;

      const agent2 = `
agent:
  id: "agent-two"
  version: "2.0.0"
  description: "Second test agent"
  expertise:
    domains: ["development"]
    capabilities: ["code"]
    examples: ["code"]

llm:
  provider: "anthropic"
  model: "claude-3-haiku-20240307"
  prompt: "You are the second agent."
`;

      await Deno.writeTextFile(join(testDir, "agent-one.agent.yml"), agent1);
      await Deno.writeTextFile(join(testDir2, "agent-two.agent.yml"), agent2);

      adapter = new YAMLFileAdapter([testDir, testDir2]);
      const agents = await adapter.listAgents();

      assertEquals(agents.length, 2);

      const agentOne = agents.find((a) => a.id === "agent-one");
      assertExists(agentOne);
      assertEquals(agentOne.id, "agent-one");
      assertEquals(agentOne.description, "First test agent");
      assertEquals(agentOne.version, "1.0.0");
      assertEquals(agentOne.type, "yaml");

      const agentTwo = agents.find((a) => a.id === "agent-two");
      assertExists(agentTwo);
      assertEquals(agentTwo.id, "agent-two");
      assertEquals(agentTwo.description, "Second test agent");
      assertEquals(agentTwo.version, "2.0.0");
    });

    it("should skip duplicate agents (first path wins)", async () => {
      const agentContent = `
agent:
  id: "duplicate"
  version: "1.0.0"
  description: "Duplicate agent"
  expertise:
    domains: ["testing"]
    capabilities: ["test"]
    examples: ["test"]

llm:
  provider: "anthropic"
  model: "claude-3-haiku-20240307"
  prompt: "You are a duplicate agent."
`;

      // Create same agent in both directories
      await Deno.writeTextFile(join(testDir, "duplicate.agent.yml"), agentContent);
      await Deno.writeTextFile(join(testDir2, "duplicate.agent.yml"), agentContent);

      adapter = new YAMLFileAdapter([testDir, testDir2]);
      const agents = await adapter.listAgents();

      // Should only have one agent
      assertEquals(agents.length, 1);
      assertExists(agents[0]);
      assertEquals(agents[0].id, "duplicate");
    });

    it("should handle invalid YAML files gracefully", async () => {
      // Create valid agent
      const validAgent = `
agent:
  id: "valid-agent"
  version: "1.0.0"
  description: "Valid agent"
  expertise:
    domains: ["testing"]
    capabilities: ["test"]
    examples: ["test"]

llm:
  provider: "anthropic"
  model: "claude-3-haiku-20240307"
  prompt: "You are a valid agent."
`;

      // Create invalid YAML
      const invalidYaml = `
This is not valid YAML {{{
  broken: syntax: here
`;

      // Create agent with missing required fields
      const incompleteAgent = `
agent:
  id: "incomplete"
  # Missing required fields like version, expertise, etc.
`;

      await Deno.writeTextFile(join(testDir, "valid-agent.agent.yml"), validAgent);
      await Deno.writeTextFile(join(testDir, "invalid.agent.yml"), invalidYaml);
      await Deno.writeTextFile(join(testDir, "incomplete.agent.yml"), incompleteAgent);

      adapter = new YAMLFileAdapter([testDir]);
      const agents = await adapter.listAgents();

      // Should only list the valid agent
      assertEquals(agents.length, 1);
      assertExists(agents[0]);
      assertEquals(agents[0].id, "valid-agent");
    });

    it("should handle non-existent directories gracefully", async () => {
      const nonExistentDir = join(Deno.cwd(), "non-existent-dir");
      adapter = new YAMLFileAdapter([nonExistentDir, testDir]);

      // Create one agent in the existing directory
      const agentContent = `
agent:
  id: "test"
  version: "1.0.0"
  description: "Test"
  expertise:
    domains: ["testing"]
    capabilities: ["test"]
    examples: ["test"]

llm:
  provider: "anthropic"
  model: "claude-3-haiku-20240307"
  prompt: "You are a test agent."
`;

      await Deno.writeTextFile(join(testDir, "test.agent.yml"), agentContent);

      const agents = await adapter.listAgents();

      // Should still find agents in the existing directory
      assertEquals(agents.length, 1);
      assertExists(agents[0]);
      assertEquals(agents[0].id, "test");
    });

    it("should support custom file patterns", async () => {
      // Create agents with different extensions
      const agentContent = `
agent:
  id: "custom-pattern"
  version: "1.0.0"
  description: "Custom pattern test"
  expertise:
    domains: ["testing"]
    capabilities: ["test"]
    examples: ["test"]

llm:
  provider: "anthropic"
  model: "claude-3-haiku-20240307"
  prompt: "You are a custom pattern test agent."
`;

      await Deno.writeTextFile(join(testDir, "test.agent.yml"), agentContent);
      await Deno.writeTextFile(join(testDir, "custom.agent.yaml"), agentContent);
      await Deno.writeTextFile(join(testDir, "other.txt"), "not an agent");

      // Test with custom pattern
      adapter = new YAMLFileAdapter([testDir], { filePattern: "*.agent.yaml" });
      const agents = await adapter.listAgents();

      // Should only find the .yaml file
      assertEquals(agents.length, 1);
      assertExists(agents[0]);
      assertEquals(agents[0].id, "custom.agent.yaml");
    });
  });

  describe("exists", () => {
    it("should return true for existing agents", async () => {
      const agentContent = `
agent:
  id: "exists-test"
  version: "1.0.0"
  description: "Test"
  expertise:
    domains: ["testing"]
    capabilities: ["test"]
    examples: ["test"]

llm:
  provider: "anthropic"
  model: "claude-3-haiku-20240307"
  prompt: "You are an existence test agent."
`;

      await Deno.writeTextFile(join(testDir, "exists-test.agent.yml"), agentContent);

      adapter = new YAMLFileAdapter([testDir]);
      const exists = await adapter.exists("exists-test");

      assertEquals(exists, true);
    });

    it("should return false for non-existent agents", async () => {
      adapter = new YAMLFileAdapter([testDir]);
      const exists = await adapter.exists("does-not-exist");

      assertEquals(exists, false);
    });

    it("should check all configured directories", async () => {
      const agentContent = `
agent:
  id: "in-second-dir"
  version: "1.0.0"
  description: "Test"
  expertise:
    domains: ["testing"]
    capabilities: ["test"]
    examples: ["test"]

llm:
  provider: "anthropic"
  model: "claude-3-haiku-20240307"
  prompt: "You are in the second directory."
`;

      // Put agent only in second directory
      await Deno.writeTextFile(join(testDir2, "in-second-dir.agent.yml"), agentContent);

      adapter = new YAMLFileAdapter([testDir, testDir2]);
      const exists = await adapter.exists("in-second-dir");

      assertEquals(exists, true);
    });
  });

  describe("edge cases", () => {
    it("should handle empty directories", async () => {
      adapter = new YAMLFileAdapter([testDir]);
      const agents = await adapter.listAgents();

      assertEquals(agents.length, 0);
    });

    it("should handle empty agent name", async () => {
      const agentContent = `
agent:
  id: ""
  version: "1.0.0"
  description: "Empty name test"
  expertise:
    domains: ["testing"]
    capabilities: ["test"]
    examples: ["test"]

llm:
  provider: "anthropic"
  model: "claude-3-haiku-20240307"
  prompt: "You have an empty name."
`;

      await Deno.writeTextFile(join(testDir, ".agent.yml"), agentContent);

      adapter = new YAMLFileAdapter([testDir]);
      const agents = await adapter.listAgents();

      // Agent with empty filename (before .agent.yml) should be skipped or handled
      assertEquals(agents.length, 0);
    });

    it("should handle very large agent files", async () => {
      // Create a large agent file with many repeated sections
      let largeContent = `
agent:
  id: "large-agent"
  version: "1.0.0"
  description: "A very large agent for testing"
  expertise:
    domains: ["testing"]
    capabilities: [`;

      // Add many capabilities
      for (let i = 0; i < 1000; i++) {
        largeContent += `"capability-${i}", `;
      }

      largeContent += `]
    examples: ["test"]

llm:
  provider: "anthropic"
  model: "claude-3-haiku-20240307"
  prompt: "You are a test agent with many capabilities."
`;

      await Deno.writeTextFile(join(testDir, "large-agent.agent.yml"), largeContent);

      adapter = new YAMLFileAdapter([testDir]);
      const result = await adapter.loadAgent("large-agent");

      assertEquals(result.id, "large-agent");
      assertExists(result.content);
    });
  });
});
