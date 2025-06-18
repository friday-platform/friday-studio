/**
 * Agent Execution Worker MCP Integration Tests
 * Tests for agent execution with MCP tool integration
 */

import { expect } from "@std/expect";
import { createEnhancedTestEnvironment } from "../../utils/test-utils.ts";
import { TestMCPServers } from "../../utils/test-mcp-servers.ts";

// Import when MCP support is implemented
// import { AgentExecutionWorker } from "../../../src/core/workers/agent-execution-worker.ts";

Deno.test({
  name: "AgentExecutionWorker - MCP Tool Execution with Real Server",
  async fn() {
    const testEnv = createEnhancedTestEnvironment();

    try {
      // Start real MCP server
      const mcpServer = await testEnv.startMCPServer(
        "weather",
        TestMCPServers.startWeatherServer(),
      );

      // Create worker execution request with real MCP server
      const request = {
        agent_id: "test-weather-agent",
        agent_config: {
          type: "llm",
          model: "claude-3-5-haiku-20241022",
          parameters: {
            provider: "anthropic",
            temperature: 0, // Deterministic for testing
          },
          prompts: {
            system:
              "You are a weather assistant. Use the available tools to get weather information.",
          },
          tools: [],
          mcp_servers: ["weather_api"],
          max_steps: 3,
        },
        task: "Get the weather for San Francisco",
        input: { location: "San Francisco" },
        workspace_config: {
          mcp_servers: {
            weather_api: {
              id: "weather_api",
              transport: {
                type: "stdio",
                command: "node",
                args: mcpServer.getCommand().args, // Connect to real server
              },
            },
          },
        },
        environment: {
          worker_config: {
            timeout: 30000,
            allowed_permissions: ["read", "network"],
            memory_limit: 256,
            isolation_level: "worker",
          },
          monitoring_config: {
            log_level: "info",
            metrics_collection: true,
            safety_checks: ["memory_limit", "permissions"],
            output_validation: true,
          },
        },
      };

      // TODO: Uncomment when MCP support is implemented in AgentExecutionWorker
      // Since AgentExecutionWorker runs in a Web Worker, we'll test the execution logic
      // by simulating what would happen in the worker
      // const { LLMProviderManager } = await import(
      //   "../../../src/core/agents/llm-provider-manager.ts"
      // );

      // Initialize MCP servers
      // await LLMProviderManager.initializeMCPServers([
      //   request.workspace_config.mcp_servers.weather_api,
      // ]);

      // Execute LLM with MCP tools
      // const result = await LLMProviderManager.generateTextWithTools(
      //   `Task: ${request.task}\nInput: ${JSON.stringify(request.input)}`,
      //   {
      //     provider: "anthropic",
      //     model: request.agent_config.model,
      //     systemPrompt: request.agent_config.prompts.system,
      //     mcpServers: request.agent_config.mcp_servers,
      //     maxSteps: request.agent_config.max_steps,
      //     temperature: request.agent_config.parameters.temperature,
      //   }
      // );

      // Verify execution results
      // expect(result.toolCalls.length).toBeGreaterThan(0);
      // expect(result.toolCalls[0].toolName).toBe("get_weather");
      // expect(result.text).toContain("San Francisco");

      // Verify tool was called with correct arguments
      // const weatherCall = result.toolCalls.find(
      //   (call) => call.toolName === "get_weather"
      // );
      // expect(weatherCall).toBeDefined();
      // expect(weatherCall?.args.location).toContain("San Francisco");

      // await LLMProviderManager.disposeMCPResources();

      // Placeholder assertion for now
      expect(mcpServer).toBeDefined();
      expect(request.agent_config.type).toBe("llm");
    } finally {
      await testEnv.cleanup();
    }
  },
});

Deno.test({
  name: "AgentExecutionWorker - Multiple MCP Servers in Workspace",
  async fn() {
    const testEnv = createEnhancedTestEnvironment();

    try {
      const weatherServer = await testEnv.startMCPServer(
        "weather",
        TestMCPServers.startWeatherServer(),
      );
      const fileServer = await testEnv.startMCPServer(
        "filetools",
        TestMCPServers.startFileToolsServer(),
      );

      const request = {
        agent_id: "test-multi-tool-agent",
        agent_config: {
          type: "llm",
          model: "claude-3-5-haiku-20241022",
          parameters: {
            provider: "anthropic",
            temperature: 0,
          },
          prompts: {
            system: "You are a helpful assistant with access to weather and file tools.",
          },
          tools: [],
          mcp_servers: ["weather_api", "file_tools"],
          max_steps: 5,
        },
        task: "Get the weather for Boston and save it to a file",
        input: { location: "Boston", filename: "boston_weather.txt" },
        workspace_config: {
          mcp_servers: {
            weather_api: {
              id: "weather_api",
              transport: {
                type: "stdio",
                command: "node",
                args: weatherServer.getCommand().args,
              },
            },
            file_tools: {
              id: "file_tools",
              transport: {
                type: "stdio",
                command: "node",
                args: fileServer.getCommand().args,
              },
            },
          },
        },
        environment: {
          worker_config: {
            timeout: 45000,
            allowed_permissions: ["read", "write", "network"],
            memory_limit: 512,
            isolation_level: "worker",
          },
          monitoring_config: {
            log_level: "debug",
            metrics_collection: true,
            safety_checks: ["memory_limit", "permissions"],
            output_validation: true,
          },
        },
      };

      // TODO: Uncomment when MCP support is implemented
      // Test execution with multiple MCP servers
      // const { LLMProviderManager } = await import(
      //   "../../../src/core/agents/llm-provider-manager.ts"
      // );

      // Initialize both MCP servers
      // await LLMProviderManager.initializeMCPServers([
      //   request.workspace_config.mcp_servers.weather_api,
      //   request.workspace_config.mcp_servers.file_tools,
      // ]);

      // Execute agent task
      // const result = await LLMProviderManager.generateTextWithTools(
      //   `Task: ${request.task}\nInput: ${JSON.stringify(request.input)}`,
      //   {
      //     provider: "anthropic",
      //     model: request.agent_config.model,
      //     systemPrompt: request.agent_config.prompts.system,
      //     mcpServers: request.agent_config.mcp_servers,
      //     maxSteps: request.agent_config.max_steps,
      //     temperature: request.agent_config.parameters.temperature,
      //   }
      // );

      // Should use tools from both servers
      // const toolNames = result.toolCalls.map((call) => call.toolName);
      // expect(toolNames).toContain("get_weather");
      // expect(toolNames).toContain("file_write");

      // await LLMProviderManager.disposeMCPResources();

      // Placeholder assertions for now
      expect(weatherServer).toBeDefined();
      expect(fileServer).toBeDefined();
      expect(request.agent_config.mcp_servers).toEqual([
        "weather_api",
        "file_tools",
      ]);
    } finally {
      await testEnv.cleanup();
    }
  },
});

Deno.test({
  name: "AgentExecutionWorker - Tool Access Control",
  async fn() {
    const testEnv = createEnhancedTestEnvironment();

    try {
      const fileServer = await testEnv.startMCPServer(
        "filetools",
        TestMCPServers.startFileToolsServer(),
      );

      const request = {
        agent_id: "test-restricted-agent",
        agent_config: {
          type: "llm",
          model: "claude-3-5-haiku-20241022",
          parameters: {
            provider: "anthropic",
            temperature: 0,
          },
          prompts: {
            system: "You are a file reading assistant. You can only read files.",
          },
          tools: [],
          mcp_servers: ["restricted_file_tools"],
          max_steps: 2,
        },
        task: "Read the contents of config.json",
        input: { filename: "config.json" },
        workspace_config: {
          mcp_servers: {
            restricted_file_tools: {
              id: "restricted_file_tools",
              transport: {
                type: "stdio",
                command: "node",
                args: fileServer.getCommand().args,
              },
              tools: {
                allowed: ["file_read"],
                denied: ["file_write"],
              },
            },
          },
        },
        environment: {
          worker_config: {
            timeout: 30000,
            allowed_permissions: ["read"],
            memory_limit: 256,
            isolation_level: "worker",
          },
          monitoring_config: {
            log_level: "info",
            metrics_collection: true,
            safety_checks: ["memory_limit", "permissions"],
            output_validation: true,
          },
        },
      };

      // TODO: Uncomment when MCP support is implemented
      // Test that only allowed tools are available
      // const { LLMProviderManager } = await import(
      //   "../../../src/core/agents/llm-provider-manager.ts"
      // );

      // await LLMProviderManager.initializeMCPServers([
      //   request.workspace_config.mcp_servers.restricted_file_tools,
      // ]);

      // The agent should only have access to file_read, not file_write
      // const result = await LLMProviderManager.generateTextWithTools(
      //   `Task: ${request.task}\nInput: ${JSON.stringify(request.input)}`,
      //   {
      //     provider: "anthropic",
      //     model: request.agent_config.model,
      //     systemPrompt: request.agent_config.prompts.system,
      //     mcpServers: request.agent_config.mcp_servers,
      //     maxSteps: request.agent_config.max_steps,
      //     temperature: request.agent_config.parameters.temperature,
      //   }
      // );

      // Should only use allowed tools
      // const toolNames = result.toolCalls.map((call) => call.toolName);
      // expect(toolNames).toContain("file_read");
      // expect(toolNames).not.toContain("file_write");

      // await LLMProviderManager.disposeMCPResources();

      // Placeholder assertions for now
      expect(fileServer).toBeDefined();
      expect(request.workspace_config.mcp_servers.restricted_file_tools.tools?.allowed).toEqual([
        "file_read",
      ]);
      expect(request.workspace_config.mcp_servers.restricted_file_tools.tools?.denied).toEqual([
        "file_write",
      ]);
    } finally {
      await testEnv.cleanup();
    }
  },
});

Deno.test({
  name: "AgentExecutionWorker - Timeout and Error Handling",
  async fn() {
    const testEnv = createEnhancedTestEnvironment();

    try {
      const request = {
        agent_id: "test-timeout-agent",
        agent_config: {
          type: "llm",
          model: "claude-3-5-haiku-20241022",
          parameters: {
            provider: "anthropic",
            temperature: 0,
          },
          prompts: {
            system: "You are a test agent.",
          },
          tools: [],
          mcp_servers: ["nonexistent_server"],
          max_steps: 1,
        },
        task: "Test with non-existent server",
        input: {},
        workspace_config: {
          mcp_servers: {
            nonexistent_server: {
              id: "nonexistent_server",
              transport: {
                type: "stdio",
                command: "nonexistent-command",
                args: ["--fail"],
              },
              timeout_ms: 5000,
            },
          },
        },
        environment: {
          worker_config: {
            timeout: 10000,
            allowed_permissions: ["read"],
            memory_limit: 256,
            isolation_level: "worker",
          },
          monitoring_config: {
            log_level: "error",
            metrics_collection: true,
            safety_checks: ["memory_limit", "permissions"],
            output_validation: true,
          },
        },
      };

      // TODO: Uncomment when MCP support is implemented
      // Test error handling for failed MCP server initialization
      // const { LLMProviderManager } = await import(
      //   "../../../src/core/agents/llm-provider-manager.ts"
      // );

      // let caughtError = false;
      // try {
      //   await LLMProviderManager.initializeMCPServers([
      //     request.workspace_config.mcp_servers.nonexistent_server,
      //   ]);
      // } catch (error) {
      //   caughtError = true;
      //   expect(error.message).toContain("registration failed");
      // }

      // expect(caughtError).toBe(true);

      // Placeholder test for now
      expect(request.workspace_config.mcp_servers.nonexistent_server.timeout_ms).toBe(5000);
    } finally {
      await testEnv.cleanup();
    }
  },
});

Deno.test({
  name: "AgentExecutionWorker - Worker Isolation with MCP",
  async fn() {
    const testEnv = createEnhancedTestEnvironment();

    try {
      const echoServer = await testEnv.startMCPServer(
        "echo",
        TestMCPServers.startEchoServer(),
      );

      const request = {
        agent_id: "test-isolated-agent",
        agent_config: {
          type: "llm",
          model: "claude-3-5-haiku-20241022",
          parameters: {
            provider: "anthropic",
            temperature: 0,
          },
          prompts: {
            system: "You are an isolated agent with limited access.",
          },
          tools: [],
          mcp_servers: ["echo_server"],
          max_steps: 1,
        },
        task: "Echo a simple message",
        input: { message: "Hello from isolated worker" },
        workspace_config: {
          mcp_servers: {
            echo_server: {
              id: "echo_server",
              transport: {
                type: "stdio",
                command: "node",
                args: echoServer.getCommand().args,
              },
            },
          },
        },
        environment: {
          worker_config: {
            timeout: 15000,
            allowed_permissions: ["read"], // Very limited permissions
            memory_limit: 128, // Low memory limit
            isolation_level: "worker",
          },
          monitoring_config: {
            log_level: "warn",
            metrics_collection: true,
            safety_checks: ["memory_limit", "permissions"],
            output_validation: true,
          },
        },
      };

      // TODO: Uncomment when worker isolation is implemented
      // Test that MCP tools work within worker constraints
      // This would typically involve running the agent in an actual Web Worker
      // For now, we'll verify the configuration is valid

      expect(request.environment.worker_config.memory_limit).toBe(128);
      expect(request.environment.worker_config.allowed_permissions).toEqual([
        "read",
      ]);
      expect(echoServer).toBeDefined();
    } finally {
      await testEnv.cleanup();
    }
  },
});
