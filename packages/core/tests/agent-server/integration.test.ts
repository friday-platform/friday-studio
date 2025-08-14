/**
 * Integration tests for the full agent SDK to MCP server pipeline.
 * Tests agent creation, registration, and execution through the complete system.
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  type AgentMetadata,
  type AgentRegistry,
  type AtlasAgent,
  createAgent,
} from "@atlas/agent-sdk";
import { TestAtlasAgentsMCPServer } from "./test-server.ts";
import { createLogger } from "@atlas/logger";
import type { Logger } from "@atlas/logger";
import type { MCPServerConfig } from "@atlas/config";
import { MCPManager } from "@atlas/mcp";
import { GlobalMCPServerPool } from "../../src/mcp-server-pool.ts";

Deno.env.set("DENO_TESTING", "true");

// Mock MCP server pool that prevents real connections and timers in tests
class MockMCPServerPool extends GlobalMCPServerPool {
  constructor(logger: Logger) {
    super(logger);
    // Override cleanup timer to prevent it from running
    const timer = Reflect.get(this, "cleanupTimer");
    if (timer) {
      clearInterval(timer);
      Reflect.set(this, "cleanupTimer", undefined);
    }
  }

  override getMCPManager(_serverConfigsMap: Record<string, MCPServerConfig>): Promise<MCPManager> {
    // Return empty manager without creating real connections
    return Promise.resolve(new MCPManager());
  }

  override async dispose(): Promise<void> {
    // No-op for tests - don't dispose anything
  }
}

// In-memory agent registry that doesn't persist to disk
class MockAgentRegistry implements AgentRegistry {
  private agents = new Map<string, AtlasAgent>();

  listAgents(): Promise<AgentMetadata[]> {
    return Promise.resolve(Array.from(this.agents.values()).map((agent) => agent.metadata));
  }

  getAgent(id: string): Promise<AtlasAgent | undefined> {
    return Promise.resolve(this.agents.get(id));
  }

  registerAgent(agent: AtlasAgent): Promise<void> {
    const id = agent.metadata.id;
    this.agents.set(id, agent);
    return Promise.resolve();
  }

  searchAgents(query: string): Promise<AgentMetadata[]> {
    return Promise.resolve(
      Array.from(this.agents.values())
        .filter((agent) =>
          agent.metadata.id.includes(query) ||
          agent.metadata.description.includes(query)
        )
        .map((agent) => agent.metadata),
    );
  }

  getAgentsByDomain(domain: string): Promise<AgentMetadata[]> {
    return Promise.resolve(
      Array.from(this.agents.values())
        .filter((agent) => agent.metadata.expertise.domains.includes(domain))
        .map((agent) => agent.metadata),
    );
  }
}

Deno.test({
  name: "SDK and Server Integration",
  fn: async (t) => {
    const registry = new MockAgentRegistry();
    const logger = createLogger();
    const mockMCPServerPool = new MockMCPServerPool(logger);

    // Create MCP server
    const server = new TestAtlasAgentsMCPServer({
      agentRegistry: registry,
      logger: logger,
      port: 0, // Use any available port for testing
      daemonUrl: "http://localhost:8080",
      mcpServerPool: mockMCPServerPool,
      disableTimeouts: true, // Disable timeouts for testing
    });

    try {
      await t.step("Create agent with SDK and register with server", async () => {
        // Create a simple test agent using the SDK
        const testAgent = createAgent({
          id: "test-agent",
          version: "1.0.0",
          description: "Test agent for integration testing",
          expertise: {
            domains: ["testing", "integration"],
            capabilities: ["echo messages", "count words"],
            examples: ["echo hello world", "count words in this sentence"],
          },
          handler: (() => {
            // Create a closure to maintain state for each agent instance
            const sessionStates = new Map<string, { totalWords: number }>();

            return (prompt, context) => {
              // Simple echo handler
              if (prompt.toLowerCase().startsWith("echo")) {
                const message = prompt.substring(5).trim();
                return Promise.resolve({
                  response: `Echo: ${message}`,
                  sessionData: context.session,
                });
              }

              if (prompt.toLowerCase().startsWith("count")) {
                const text = prompt.substring(6).trim();
                const words = text.split(/\s+/).length;

                // Use closure-based state management
                const sessionKey = context.session.sessionId;
                if (!sessionStates.has(sessionKey)) {
                  sessionStates.set(sessionKey, { totalWords: 0 });
                }
                const state = sessionStates.get(sessionKey)!;
                state.totalWords += words;

                return Promise.resolve({
                  response: `Word count: ${words}`,
                  totalSoFar: state.totalWords,
                });
              }

              return Promise.resolve({ response: "Unknown command" });
            };
          })(),
        });

        // Register agent with server
        await server.registerAgent(testAgent);

        // Verify agent is registered
        const agents = await server.listAgents();
        assertEquals(agents.length, 1);
        assertEquals(agents[0]?.id, "test-agent");
      });

      await t.step("Execute agent through server", async () => {
        const sessionData = {
          sessionId: "test-session-1",
          workspaceId: "test-workspace",
          userId: "test-user",
        };

        // Execute echo command
        const result1 = await server.executeAgent(
          "test-agent",
          "echo Hello, World!",
          sessionData,
        );

        assertExists(result1);
        assertEquals(result1, {
          type: "completed",
          result: {
            response: "Echo: Hello, World!",
            sessionData: sessionData,
          },
        });
      });

      await t.step("Test session state persistence", async () => {
        const sessionData = {
          sessionId: "test-session-2",
          workspaceId: "test-workspace",
          userId: "test-user",
        };

        // First count
        const result1 = await server.executeAgent(
          "test-agent",
          "count this is a test",
          sessionData,
        );
        assertEquals(result1, {
          type: "completed",
          result: {
            response: "Word count: 4",
            totalSoFar: 4,
          },
        });

        // Second count - should accumulate
        const result2 = await server.executeAgent(
          "test-agent",
          "count more words here",
          sessionData,
        );
        assertEquals(result2, {
          type: "completed",
          result: {
            response: "Word count: 3",
            totalSoFar: 7,
          },
        });
      });

      await t.step("Test agent expertise discovery", async () => {
        const expertise = await server.getAgentExpertise("test-agent");
        assertExists(expertise);
        assertEquals(expertise.domains, ["testing", "integration"]);
        assertEquals(expertise.capabilities.length, 2);
      });

      await t.step("Create agent with MCP servers and environment config", async () => {
        const githubAgent = createAgent({
          id: "github-mock",
          version: "1.0.0",
          description: "Mock GitHub agent for testing",
          expertise: {
            domains: ["github", "vcs"],
            capabilities: ["scan repositories", "create issues"],
            examples: ["scan my repo for security issues"],
          },
          environment: {
            required: [{
              name: "GITHUB_TOKEN",
              description: "GitHub API token",
              validation: "^ghp_",
            }],
            optional: [{
              name: "GITHUB_ORG",
              description: "Default GitHub organization",
              default: "my-org",
            }],
          },
          mcp: {
            github: {
              transport: {
                type: "stdio",
                command: "npx",
                args: ["-y", "@modelcontextprotocol/server-github"],
              },
              auth: {
                type: "bearer",
                token_env: "GITHUB_TOKEN",
              },
            },
          },
          handler: (prompt, context) => {
            // Mock handler that would normally use MCP tools
            return Promise.resolve({
              response: `Would scan GitHub based on: ${prompt}`,
              mcpServers: Object.keys(context.mcp),
            });
          },
        });

        await server.registerAgent(githubAgent);

        const agent = await server.getAgent("github-mock");
        assertExists(agent);
        assertExists(agent.environmentConfig);
        assertExists(agent.mcpConfig);
        assertEquals(agent.environmentConfig.required?.length, 1);
        assertEquals(Object.keys(agent.mcpConfig).length, 1);
      });
    } finally {
      // Clean up
      // Add small delay to ensure all actors have transitioned
      await new Promise((resolve) => setTimeout(resolve, 50));
      await server.stop();
      // Dispose mock resources
      mockMCPServerPool.dispose();
    }
  },
});

Deno.test({
  name: "Agent error handling",
  fn: async (t) => {
    const registry = new MockAgentRegistry();
    const logger = createLogger();
    const mockMCPServerPool = new MockMCPServerPool(logger);

    const server = new TestAtlasAgentsMCPServer({
      agentRegistry: registry,
      logger: logger,
      port: 0,
      daemonUrl: "http://localhost:8080",
      mcpServerPool: mockMCPServerPool,
      disableTimeouts: true, // Disable timeouts for testing
    });

    try {
      await t.step("Handle agent execution errors", async () => {
        const errorAgent = createAgent({
          id: "error-agent",
          version: "1.0.0",
          description: "Agent that throws errors",
          expertise: {
            domains: ["testing"],
            capabilities: ["throw errors"],
            examples: ["cause an error"],
          },
          handler: () => {
            return Promise.reject(new Error("Intentional test error"));
          },
        });

        await server.registerAgent(errorAgent);

        try {
          await server.executeAgent(
            "error-agent",
            "cause an error",
            {
              sessionId: "test",
              workspaceId: "test",
              userId: "test-user",
            },
          );
          throw new Error("Should have thrown");
        } catch (error) {
          assertExists(error);
          if (error instanceof Error) {
            assertEquals(
              error.message,
              "Intentional test error",
            );
          }
        }
      });

      await t.step("Handle non-existent agent", async () => {
        try {
          await server.executeAgent(
            "non-existent",
            "test",
            {
              sessionId: "test",
              workspaceId: "test",
              userId: "test-user",
            },
          );
          throw new Error("Should have thrown");
        } catch (error) {
          assertExists(error);
          if (error instanceof Error) {
            assertEquals(error.message, "Agent not found: non-existent");
          }
        }
      });
    } finally {
      // Clean up
      // Add small delay to ensure all actors have transitioned
      await new Promise((resolve) => setTimeout(resolve, 50));
      await server.stop();
      // Dispose mock resources
      mockMCPServerPool.dispose();
    }
  },
});

// TODO: Update this test when the new state persistence is implemented
// Deno.test("Session state persistence with external store", async (t) => {
//   const stateStore = new InMemoryStateStore();

//   // Create a custom session manager with external store
//   const sessionManager = new AgentSessionManager({
//     stateStore,
//     disableTimeouts: true,
//   });

//   await t.step("Persist and restore session state", async () => {
//     const sessionKey = "test-session";
//     const agentId = "test-agent";

//     // Create initial state
//     const state1 = sessionManager.getOrCreateSessionState(sessionKey, agentId);
//     state1.count = 1;
//     state1.message = "Hello";

//     // Simulate session being cleared from memory
//     await sessionManager.clearSession(`${sessionKey}_${agentId}`);

//     // Get state again - should load from store (eventually)
//     sessionManager.getOrCreateSessionState(sessionKey, agentId);

//     // Note: Since loading is async, the state might not be immediately restored
//     // In a real implementation, we'd wait for the async load to complete
//     // For now, we'll just verify the store was populated

//     const storedStates = await stateStore.list();
//     assertEquals(storedStates.length >= 0, true); // Store should have entries
//   });

//   await t.step("Test state store operations", async () => {
//     const key = "test-key";
//     const state = {
//       memory: { foo: "bar", count: 42 },
//       pendingPrompts: [["prompt1", {
//         id: "prompt1",
//         agentId: "test",
//         prompt: "test prompt",
//         context: {},
//         timestamp: Date.now(),
//       }] as [string, PendingPrompt]],
//       lastActivity: Date.now(),
//     };

//     // Test set and get
//     await stateStore.set(key, state);
//     const retrieved = await stateStore.get(key);

//     assertExists(retrieved);
//     assertEquals(retrieved.memory.foo, "bar");
//     assertEquals(retrieved.memory.count, 42);
//     assertEquals(retrieved.pendingPrompts.length, 1);

//     // Test list with pattern
//     await stateStore.set("other-key", state);
//     const testKeys = await stateStore.list("test-*");
//     assertEquals(testKeys.length, 1);
//     assertEquals(testKeys[0], "test-key");

//     // Test delete
//     await stateStore.delete(key);
//     const deleted = await stateStore.get(key);
//     assertEquals(deleted, null);
//   });

//   // Clean up
//   await sessionManager.cleanup();
// });
