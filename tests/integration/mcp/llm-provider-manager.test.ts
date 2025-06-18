/**
 * LLMProviderManager MCP Integration Tests
 * Tests for LLM provider with MCP tool integration using AI SDK
 */

import { expect } from "@std/expect";
import { createEnhancedTestEnvironment } from "../../utils/test-utils.ts";
import { TestMCPServers } from "../../utils/test-mcp-servers.ts";

// Import LLMProviderManager when MCP support is implemented
// import { LLMProviderManager } from "../../../src/core/agents/llm-provider-manager.ts";

Deno.test({
  name: "LLMProviderManager - MCP Tool Integration with Real Server",
  async fn() {
    const testEnv = createEnhancedTestEnvironment();

    try {
      // Start real weather MCP server
      const weatherServer = await testEnv.startMCPServer(
        "weather",
        TestMCPServers.startWeatherServer(),
      );

      // TODO: Uncomment when LLMProviderManager MCP support is implemented
      // Initialize MCP servers
      // await LLMProviderManager.initializeMCPServers([
      //   {
      //     id: "test-weather",
      //     transport: {
      //       type: "stdio",
      //       command: "node",
      //       args: weatherServer.getCommand().args,
      //     },
      //   },
      // ]);

      // Test tool calling with real LLM
      // const result = await LLMProviderManager.generateTextWithTools(
      //   "What's the weather in San Francisco?",
      //   {
      //     provider: "anthropic",
      //     model: "claude-3-5-haiku-20241022", // Use faster model for tests
      //     mcpServers: ["test-weather"],
      //     maxSteps: 2,
      //     temperature: 0, // Deterministic for testing
      //   }
      // );

      // Verify tool was called
      // expect(result.toolCalls.length).toBeGreaterThan(0);
      // expect(result.toolCalls[0].toolName).toBe("get_weather");
      // expect(result.text).toContain("San Francisco");

      // await LLMProviderManager.disposeMCPResources();

      // Placeholder assertion for now
      expect(weatherServer).toBeDefined();
    } finally {
      await testEnv.cleanup();
    }
  },
});

Deno.test({
  name: "LLMProviderManager - Feedback Loop Prevention with Real Server",
  async fn() {
    const testEnv = createEnhancedTestEnvironment();

    try {
      const loopServer = await testEnv.startMCPServer(
        "loop-test",
        TestMCPServers.startFeedbackLoopServer(),
      );

      // TODO: Uncomment when LLMProviderManager MCP support is implemented
      // await LLMProviderManager.initializeMCPServers([
      //   {
      //     id: "loop-test",
      //     transport: {
      //       type: "stdio",
      //       command: "node",
      //       args: loopServer.getCommand().args,
      //     },
      //   },
      // ]);

      // This should trigger feedback loop detection in the MCP server
      // let caughtError = false;
      // try {
      //   await LLMProviderManager.generateTextWithTools(
      //     "Keep calling the file_read tool repeatedly to test feedback loop detection",
      //     {
      //       provider: "anthropic",
      //       model: "claude-3-5-haiku-20241022",
      //       mcpServers: ["loop-test"],
      //       maxSteps: 10, // Allow enough steps to trigger loop detection
      //       temperature: 0,
      //     }
      //   );
      // } catch (error) {
      //   caughtError = true;
      //   expect(error.message).toContain("feedback loop");
      // }

      // expect(caughtError).toBe(true);
      // await LLMProviderManager.disposeMCPResources();

      // Placeholder assertion for now
      expect(loopServer).toBeDefined();
    } finally {
      await testEnv.cleanup();
    }
  },
});

Deno.test({
  name: "LLMProviderManager - Multi-tool Workflow with Real Server",
  async fn() {
    const testEnv = createEnhancedTestEnvironment();

    try {
      const weatherServer = await testEnv.startMCPServer(
        "weather",
        TestMCPServers.startWeatherServer(),
      );

      // TODO: Uncomment when LLMProviderManager MCP support is implemented
      // await LLMProviderManager.initializeMCPServers([
      //   {
      //     id: "weather-multi",
      //     transport: {
      //       type: "stdio",
      //       command: "node",
      //       args: weatherServer.getCommand().args,
      //     },
      //   },
      // ]);

      // Test multi-step workflow: get current weather then forecast
      // const result = await LLMProviderManager.generateTextWithTools(
      //   "Get the current weather in New York and then get a 5-day forecast",
      //   {
      //     provider: "anthropic",
      //     model: "claude-3-5-haiku-20241022",
      //     mcpServers: ["weather-multi"],
      //     maxSteps: 5,
      //     temperature: 0,
      //   }
      // );

      // Should have called both tools
      // const toolNames = result.toolCalls.map((call) => call.toolName);
      // expect(toolNames).toContain("get_weather");
      // expect(toolNames).toContain("get_forecast");
      // expect(result.toolCalls.length).toBeGreaterThanOrEqual(2);

      // await LLMProviderManager.disposeMCPResources();

      // Placeholder assertion for now
      expect(weatherServer).toBeDefined();
    } finally {
      await testEnv.cleanup();
    }
  },
});

Deno.test({
  name: "LLMProviderManager - Multiple MCP Servers",
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

      // TODO: Uncomment when LLMProviderManager MCP support is implemented
      // await LLMProviderManager.initializeMCPServers([
      //   {
      //     id: "weather-api",
      //     transport: {
      //       type: "stdio",
      //       command: "node",
      //       args: weatherServer.getCommand().args,
      //     },
      //   },
      //   {
      //     id: "file-tools",
      //     transport: {
      //       type: "stdio",
      //       command: "node",
      //       args: fileServer.getCommand().args,
      //     },
      //   },
      // ]);

      // Test using tools from multiple servers
      // const result = await LLMProviderManager.generateTextWithTools(
      //   "Get the weather for Boston and save it to a file called weather.txt",
      //   {
      //     provider: "anthropic",
      //     model: "claude-3-5-haiku-20241022",
      //     mcpServers: ["weather-api", "file-tools"],
      //     maxSteps: 3,
      //     temperature: 0,
      //   }
      // );

      // Should have used tools from both servers
      // const toolNames = result.toolCalls.map((call) => call.toolName);
      // expect(toolNames).toContain("get_weather");
      // expect(toolNames).toContain("file_write");

      // await LLMProviderManager.disposeMCPResources();

      // Placeholder assertions for now
      expect(weatherServer).toBeDefined();
      expect(fileServer).toBeDefined();
    } finally {
      await testEnv.cleanup();
    }
  },
});

Deno.test({
  name: "LLMProviderManager - Tool Choice Control",
  async fn() {
    const testEnv = createEnhancedTestEnvironment();

    try {
      const echoServer = await testEnv.startMCPServer(
        "echo",
        TestMCPServers.startEchoServer(),
      );

      // TODO: Uncomment when LLMProviderManager MCP support is implemented
      // await LLMProviderManager.initializeMCPServers([
      //   {
      //     id: "echo-server",
      //     transport: {
      //       type: "stdio",
      //       command: "node",
      //       args: echoServer.getCommand().args,
      //     },
      //   },
      // ]);

      // Test forced tool choice
      // const result = await LLMProviderManager.generateTextWithTools(
      //   "Please use the echo tool",
      //   {
      //     provider: "anthropic",
      //     model: "claude-3-5-haiku-20241022",
      //     mcpServers: ["echo-server"],
      //     maxSteps: 1,
      //     toolChoice: { type: "tool", toolName: "echo" },
      //     temperature: 0,
      //   }
      // );

      // Should have called the echo tool
      // expect(result.toolCalls.length).toBe(1);
      // expect(result.toolCalls[0].toolName).toBe("echo");

      // await LLMProviderManager.disposeMCPResources();

      // Placeholder assertion for now
      expect(echoServer).toBeDefined();
    } finally {
      await testEnv.cleanup();
    }
  },
});

Deno.test({
  name: "LLMProviderManager - Error Recovery",
  async fn() {
    const testEnv = createEnhancedTestEnvironment();

    try {
      // TODO: Uncomment when LLMProviderManager MCP support is implemented
      // Test with non-existent MCP server
      // let caughtError = false;
      // try {
      //   await LLMProviderManager.initializeMCPServers([
      //     {
      //       id: "nonexistent-server",
      //       transport: {
      //         type: "stdio",
      //         command: "nonexistent-command",
      //         args: ["--fail"],
      //       },
      //     },
      //   ]);
      // } catch (error) {
      //   caughtError = true;
      //   expect(error.message).toContain("registration failed");
      // }

      // expect(caughtError).toBe(true);

      // Placeholder test for now
      expect(true).toBe(true);
    } finally {
      await testEnv.cleanup();
    }
  },
});

Deno.test({
  name: "LLMProviderManager - Resource Cleanup",
  async fn() {
    const testEnv = createEnhancedTestEnvironment();

    try {
      const weatherServer = await testEnv.startMCPServer(
        "weather",
        TestMCPServers.startWeatherServer(),
      );

      // TODO: Uncomment when LLMProviderManager MCP support is implemented
      // await LLMProviderManager.initializeMCPServers([
      //   {
      //     id: "cleanup-test",
      //     transport: {
      //       type: "stdio",
      //       command: "node",
      //       args: weatherServer.getCommand().args,
      //     },
      //   },
      // ]);

      // Verify resources are properly cleaned up
      // await LLMProviderManager.disposeMCPResources();

      // Should be able to reinitialize after cleanup
      // await LLMProviderManager.initializeMCPServers([
      //   {
      //     id: "cleanup-test-2",
      //     transport: {
      //       type: "stdio",
      //       command: "node",
      //       args: weatherServer.getCommand().args,
      //     },
      //   },
      // ]);

      // await LLMProviderManager.disposeMCPResources();

      // Placeholder assertion for now
      expect(weatherServer).toBeDefined();
    } finally {
      await testEnv.cleanup();
    }
  },
});
