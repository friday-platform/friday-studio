/** createAgent() function tests */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { createAgent } from "../src/create-agent.ts";
import type { AgentContext } from "../src/types.ts";
import { createLogger } from "@atlas/logger";
import { assertObjectMatch } from "@std/assert/object-match";

Deno.test("createAgent - creates agent with valid configuration", () => {
  const agent = createAgent({
    id: "test-agent",
    displayName: "Test Agent",
    version: "1.0.0",
    description: "Test agent for unit tests",
    expertise: {
      domains: ["testing"],
      capabilities: ["run tests", "validate code"],
      examples: ["run unit tests", "check code coverage"],
    },
    handler: (prompt, _context) => {
      return Promise.resolve({ prompt, processed: true });
    },
  });

  assertEquals(agent.metadata.id, "test-agent");
  assertEquals(agent.metadata.displayName, "Test Agent");
  assertEquals(agent.metadata.version, "1.0.0");
  assertEquals(agent.metadata.description, "Test agent for unit tests");
  assertEquals(agent.metadata.expertise.domains, ["testing"]);
});

Deno.test("createAgent - validates agent ID format", () => {
  assertThrows(
    () => {
      createAgent({
        id: "TestAgent", // Invalid: uppercase
        displayName: "Test Agent",
        version: "1.0.0",
        description: "Invalid ID test",
        expertise: {
          domains: ["testing"],
          capabilities: ["test"],
          examples: ["test"],
        },
        handler: () => Promise.resolve({}),
      });
    },
    Error,
    "Invalid agent ID",
  );

  // Underscores are actually allowed in agent IDs
  const agentWithUnderscore = createAgent({
    id: "test_agent", // Valid: underscore is allowed
    displayName: "Test Agent",
    version: "1.0.0",
    description: "Valid name test",
    expertise: {
      domains: ["testing"],
      capabilities: ["test"],
      examples: ["test"],
    },
    handler: () => Promise.resolve({}),
  });
  assertEquals(agentWithUnderscore.metadata.id, "test_agent");

  // Test actual invalid ID (starts with number)
  assertThrows(
    () => {
      createAgent({
        id: "123-agent", // Invalid: starts with number
        displayName: "Test Agent",
        version: "1.0.0",
        description: "Invalid ID test",
        expertise: {
          domains: ["testing"],
          capabilities: ["test"],
          examples: ["test"],
        },
        handler: () => Promise.resolve({}),
      });
    },
    Error,
    "Invalid agent ID",
  );
});

Deno.test("createAgent - validates version format", () => {
  assertThrows(
    () => {
      createAgent({
        id: "test-agent",
        displayName: "Test Agent",
        version: "1.0", // Invalid: not semver
        description: "Invalid version test",
        expertise: {
          domains: ["testing"],
          capabilities: ["test"],
          examples: ["test"],
        },
        handler: () => Promise.resolve({}),
      });
    },
    Error,
    "Invalid version",
  );
});

Deno.test("createAgent - requires at least one domain", () => {
  assertThrows(
    () => {
      createAgent({
        id: "test-agent",
        displayName: "Test Agent",
        version: "1.0.0",
        description: "No domains test",
        expertise: {
          domains: [], // Invalid: empty
          capabilities: ["test"],
          examples: ["test"],
        },
        handler: () => Promise.resolve({}),
      });
    },
    Error,
    "at least one domain",
  );
});

Deno.test("createAgent - requires at least one capability", () => {
  assertThrows(
    () => {
      createAgent({
        id: "test-agent",
        displayName: "Test Agent",
        version: "1.0.0",
        description: "No capabilities test",
        expertise: {
          domains: ["testing"],
          capabilities: [], // Invalid: empty
          examples: ["test"],
        },
        handler: () => Promise.resolve({}),
      });
    },
    Error,
    "at least one capability",
  );
});

Deno.test("createAgent - validates environment configuration", () => {
  const agent = createAgent({
    id: "test-agent",
    displayName: "Test Agent",
    version: "1.0.0",
    description: "Environment config test",
    expertise: {
      domains: ["testing"],
      capabilities: ["test"],
      examples: ["test"],
    },
    environment: {
      required: [
        {
          name: "API_KEY",
          description: "API key for testing",
          validation: "^[A-Z0-9]+$",
        },
      ],
      optional: [
        {
          name: "DEBUG",
          default: "false",
        },
      ],
    },
    handler: async () => {},
  });

  const envConfig = agent.environmentConfig;
  assertEquals(envConfig?.required?.[0]?.name, "API_KEY");
  assertEquals(envConfig?.optional?.[0]?.default, "false");
});

Deno.test("createAgent - validates environment regex patterns", () => {
  assertThrows(
    () => {
      createAgent({
        id: "test-agent",
        displayName: "Test Agent",
        version: "1.0.0",
        description: "Invalid regex test",
        expertise: {
          domains: ["testing"],
          capabilities: ["test"],
          examples: ["test"],
        },
        environment: {
          required: [
            {
              name: "API_KEY",
              description: "API key",
              validation: "[invalid regex", // Invalid regex
            },
          ],
        },
        handler: () => Promise.resolve({}),
      });
    },
    Error,
    "Invalid validation regex",
  );
});

Deno.test("createAgent - executes handler with context", async () => {
  const agent = createAgent({
    id: "test-agent",
    displayName: "Test Agent",
    version: "1.0.0",
    description: "Handler execution test",
    expertise: {
      domains: ["testing"],
      capabilities: ["execute tests"],
      examples: ["run test suite"],
    },
    handler: (prompt, context) => {
      return Promise.resolve({
        prompt,
        hasContext: !!context,
        hasStream: !!context.stream,
      });
    },
  });

  // Create mock context
  const mockContext: AgentContext = {
    tools: {},
    logger: createLogger(),
    env: {},
    session: {
      sessionId: "test-session",
      workspaceId: "test-workspace",
      userId: "test-user",
    },
    stream: {
      emit: (_event) => {/* mock stream */},
      end: () => {/* mock stream */},
      error: (_error) => {/* mock stream */},
    },
  };

  const result = await agent.execute("test prompt", mockContext);

  assert(typeof result === "object" && result !== null);
  assertObjectMatch(result, {
    prompt: "test prompt",
    hasContext: true,
    hasStream: true,
  });
});

Deno.test("createAgent - LLM-agnostic handler pattern", async () => {
  // Example of an agent that brings its own LLM
  const agent = createAgent({
    id: "llm-agnostic-agent",
    displayName: "LLM Agnostic Agent",
    version: "1.0.0",
    description: "Agent that brings its own LLM",
    expertise: {
      domains: ["testing"],
      capabilities: ["process with custom LLM"],
      examples: ["analyze this data"],
    },
    handler: (prompt, context) => {
      // Agent would import its own LLM library here
      // For testing, we'll simulate the pattern

      // Simulate using own LLM library
      const mockLLMResponse = {
        text: `Processed: ${prompt}`,
      };

      // Stream events if needed
      context.stream?.emit({ type: "text", content: mockLLMResponse.text });

      return Promise.resolve({
        response: mockLLMResponse.text,
        toolsUsed: [],
      });
    },
  });

  const mockContext: AgentContext = {
    tools: {},
    logger: createLogger(),
    env: {},
    session: {
      sessionId: "test-session",
      workspaceId: "test-workspace",
      userId: "test-user",
    },
    stream: {
      emit: (_event) => {/* mock stream */},
      end: () => {/* mock stream */},
      error: (_error) => {/* mock stream */},
    },
  };

  const result = await agent.execute("analyze this", mockContext);

  assert(typeof result === "object" && result !== null);
  assertObjectMatch(result, {
    response: "Processed: analyze this",
    toolsUsed: [],
  });
});

Deno.test("createAgent - agent stores MCP and LLM config", () => {
  const agent = createAgent({
    id: "test-agent",
    displayName: "Test Agent",
    version: "1.0.0",
    description: "Config storage test",
    expertise: {
      domains: ["testing"],
      capabilities: ["test"],
      examples: ["test"],
    },
    mcp: {
      testServer: {
        transport: {
          type: "stdio",
          command: "test-server",
          args: ["--test"],
        },
      },
    },
    llm: {
      model: "test-model",
      temperature: 0.5,
      max_tokens: 1000,
    },
    handler: async () => {},
  });

  const mcpConfig = agent.mcpConfig;
  assertEquals(mcpConfig?.testServer?.transport.type, "stdio");
  if (mcpConfig?.testServer?.transport.type === "stdio") {
    assertEquals(mcpConfig.testServer.transport.command, "test-server");
  }

  const llmConfig = agent.llmConfig;
  assertEquals(llmConfig?.model, "test-model");
  assertEquals(llmConfig?.temperature, 0.5);
  assertEquals(llmConfig?.max_tokens, 1000);
});
