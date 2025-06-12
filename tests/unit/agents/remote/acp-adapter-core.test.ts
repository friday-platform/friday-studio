/**
 * Core functionality tests for ACP adapter behavior
 * Tests business logic without external dependencies
 */

import { assertEquals, assertRejects, assertExists } from "jsr:@std/assert";

// Test the core adapter logic by mocking the base adapter
interface MockACPAdapterConfig {
  endpoint: string;
  acp: {
    agent_name: string;
    default_mode: "sync" | "async" | "stream";
    timeout_ms: number;
  };
  auth?: {
    type: "bearer" | "api_key";
    token?: string;
    token_env?: string;
  };
}

interface MockRemoteExecutionRequest {
  agentName: string;
  input: string | unknown[];
  mode: "sync" | "async" | "stream";
  sessionId?: string;
  timeout?: number;
  context?: Record<string, unknown>;
}

interface MockRemoteExecutionResult {
  executionId: string;
  output: Array<{ content_type: string; content: string }>;
  status: "completed" | "failed" | "cancelled";
  error?: string;
  metadata: {
    execution_time_ms: number;
    session_id?: string;
  };
}

// Mock ACP client that simulates the real behavior
class MockACPClient {
  private shouldFail = false;
  private executionDelay = 0;
  private agentRegistry = new Map<string, { name: string; description: string }>();

  constructor() {
    // Add default test agents
    this.agentRegistry.set("test-agent", {
      name: "test-agent",
      description: "Test agent for unit testing"
    });
    this.agentRegistry.set("chat-agent", {
      name: "chat-agent", 
      description: "Chat agent for conversations"
    });
  }

  setExecutionFailure(shouldFail: boolean) {
    this.shouldFail = shouldFail;
  }

  setExecutionDelay(delayMs: number) {
    this.executionDelay = delayMs;
  }

  async ping(): Promise<void> {
    if (this.shouldFail) {
      throw new Error("Health check failed - service unavailable");
    }
    await this.delay(10);
  }

  async agents(): Promise<Array<{ name: string; description: string }>> {
    await this.delay(20);
    return Array.from(this.agentRegistry.values());
  }

  async agent(name: string): Promise<{ name: string; description: string }> {
    await this.delay(10);
    const agent = this.agentRegistry.get(name);
    if (!agent) {
      const error = new Error(`Agent '${name}' not found`) as any;
      error.code = "not_found";
      throw error;
    }
    return agent;
  }

  async runSync(agentName: string, input: string): Promise<{
    run_id: string;
    status: string;
    output: Array<{ parts: Array<{ content_type: string; content: string }> }>;
    error?: { message: string };
  }> {
    await this.delay(this.executionDelay);
    
    if (this.shouldFail) {
      throw new Error("Execution failed - agent unavailable");
    }

    const runId = `run_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    return {
      run_id: runId,
      status: "completed",
      output: [{
        parts: [{
          content_type: "text/plain",
          content: `Response from ${agentName}: ${input}`
        }]
      }]
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Simplified ACPAdapter class for testing core functionality
class TestACPAdapter {
  private client: MockACPClient;
  private config: MockACPAdapterConfig;

  constructor(config: MockACPAdapterConfig, client: MockACPClient) {
    this.config = config;
    this.client = client;
  }

  getProtocolName(): string {
    return "acp";
  }

  async executeAgent(request: MockRemoteExecutionRequest): Promise<MockRemoteExecutionResult> {
    const startTime = performance.now();

    try {
      // Validate request
      this.validateRequest(request);

      // Execute based on mode
      let result;
      switch (request.mode) {
        case "sync":
          result = await this.client.runSync(request.agentName, this.convertInput(request.input));
          break;
        case "async":
          // For testing, treat async like sync but with longer delay
          result = await this.client.runSync(request.agentName, this.convertInput(request.input));
          break;
        default:
          throw new Error("Use executeAgentStream for streaming mode");
      }

      const executionTime = performance.now() - startTime;

      return {
        executionId: result.run_id,
        output: this.convertOutput(result.output),
        status: this.convertStatus(result.status),
        error: result.error?.message,
        metadata: {
          execution_time_ms: Math.round(executionTime),
          session_id: request.sessionId,
        },
      };
    } catch (error) {
      const executionTime = performance.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Remote execution failed for agent '${request.agentName}': ${errorMessage}`);
    }
  }

  async healthCheck(): Promise<{ status: string; latency_ms?: number; error?: string }> {
    try {
      const startTime = performance.now();
      await this.client.ping();
      const latency = Math.round(performance.now() - startTime);
      return { status: "healthy", latency_ms: latency };
    } catch (error) {
      return { 
        status: "unhealthy", 
        error: error instanceof Error ? error.message : String(error) 
      };
    }
  }

  async discoverAgents(): Promise<Array<{ name: string; description: string }>> {
    return await this.client.agents();
  }

  async getAgentDetails(agentName: string): Promise<{ name: string; description: string }> {
    return await this.client.agent(agentName);
  }

  private validateRequest(request: MockRemoteExecutionRequest): void {
    if (!request.agentName) {
      throw new Error("Agent name is required");
    }
    if (!request.input) {
      throw new Error("Input is required");
    }
    if (!["sync", "async", "stream"].includes(request.mode)) {
      throw new Error("Invalid execution mode");
    }
  }

  private convertInput(input: string | unknown[]): string {
    if (typeof input === "string") {
      return input;
    }
    return JSON.stringify(input);
  }

  private convertOutput(output: unknown[]): Array<{ content_type: string; content: string }> {
    return output.flatMap((message: any) => {
      return (message.parts || []).map((part: any) => ({
        content_type: part.content_type || "text/plain",
        content: String(part.content),
      }));
    });
  }

  private convertStatus(status: string): "completed" | "failed" | "cancelled" {
    switch (status) {
      case "completed": return "completed";
      case "failed": return "failed";
      case "cancelled": return "cancelled";
      default: return "completed";
    }
  }
}

// Helper functions
function createTestConfig(overrides: Partial<MockACPAdapterConfig> = {}): MockACPAdapterConfig {
  return {
    endpoint: "https://test-acp-server.example.com",
    acp: {
      agent_name: "test-agent",
      default_mode: "sync",
      timeout_ms: 5000,
    },
    auth: {
      type: "bearer",
      token: "test-token-12345"
    },
    ...overrides,
  };
}

function createTestRequest(overrides: Partial<MockRemoteExecutionRequest> = {}): MockRemoteExecutionRequest {
  return {
    agentName: "test-agent",
    input: "Hello, test agent!",
    mode: "sync",
    sessionId: "test-session-123",
    timeout: 5000,
    context: {
      test: true,
      timestamp: new Date().toISOString(),
    },
    ...overrides,
  };
}

Deno.test("ACPAdapter Core Functionality", async (t) => {

  await t.step("should successfully execute sync request and return correct result", async () => {
    // Arrange
    const mockClient = new MockACPClient();
    const config = createTestConfig();
    const adapter = new TestACPAdapter(config, mockClient);
    const request = createTestRequest();

    // Act
    const result = await adapter.executeAgent(request);

    // Assert
    assertExists(result);
    assertEquals(result.status, "completed");
    assertExists(result.executionId);
    assertEquals(result.output.length, 1);
    assertEquals(result.output[0].content_type, "text/plain");
    assertEquals(result.output[0].content, "Response from test-agent: Hello, test agent!");
    assertEquals(typeof result.metadata.execution_time_ms, "number");
    assertEquals(result.metadata.session_id, "test-session-123");
  });

  await t.step("should handle execution failure with proper error conversion", async () => {
    // Arrange
    const mockClient = new MockACPClient();
    mockClient.setExecutionFailure(true);
    const config = createTestConfig();
    const adapter = new TestACPAdapter(config, mockClient);
    const request = createTestRequest();

    // Act & Assert
    await assertRejects(
      () => adapter.executeAgent(request),
      Error,
      "Remote execution failed for agent 'test-agent': Execution failed - agent unavailable"
    );
  });

  await t.step("should measure execution time accurately", async () => {
    // Arrange
    const mockClient = new MockACPClient();
    const expectedDelay = 100;
    mockClient.setExecutionDelay(expectedDelay);
    const config = createTestConfig();
    const adapter = new TestACPAdapter(config, mockClient);
    const request = createTestRequest();

    // Act
    const startTime = performance.now();
    const result = await adapter.executeAgent(request);
    const actualDuration = performance.now() - startTime;

    // Assert
    assertEquals(result.status, "completed");
    // Execution time should be close to actual duration (within 50ms tolerance)
    const timeDiff = Math.abs(result.metadata.execution_time_ms - actualDuration);
    assertEquals(timeDiff < 50, true, `Time difference too large: ${timeDiff}ms`);
    assertEquals(result.metadata.execution_time_ms >= expectedDelay, true);
  });

  await t.step("should handle different input types correctly", async () => {
    // Arrange
    const mockClient = new MockACPClient();
    const config = createTestConfig();
    const adapter = new TestACPAdapter(config, mockClient);

    // Test string input
    const stringRequest = createTestRequest({ input: "Simple string input" });
    const stringResult = await adapter.executeAgent(stringRequest);
    assertEquals(stringResult.status, "completed");
    assertEquals(stringResult.output[0].content, "Response from test-agent: Simple string input");

    // Test structured input (should be converted to JSON string)
    const structuredRequest = createTestRequest({ 
      input: [
        { content_type: "text/plain", content: "Structured input" },
        { content_type: "application/json", content: '{"key": "value"}' }
      ]
    });
    const structuredResult = await adapter.executeAgent(structuredRequest);
    assertEquals(structuredResult.status, "completed");
    // Should contain the stringified input
    assertEquals(structuredResult.output[0].content.includes("Structured input"), true);
  });

  await t.step("should validate request parameters", async () => {
    // Arrange
    const mockClient = new MockACPClient();
    const config = createTestConfig();
    const adapter = new TestACPAdapter(config, mockClient);

    // Test missing agent name
    await assertRejects(
      () => adapter.executeAgent({ ...createTestRequest(), agentName: "" }),
      Error,
      "Agent name is required"
    );

    // Test missing input
    await assertRejects(
      () => adapter.executeAgent({ ...createTestRequest(), input: "" }),
      Error,
      "Input is required"
    );

    // Test invalid mode
    await assertRejects(
      () => adapter.executeAgent({ ...createTestRequest(), mode: "invalid" as any }),
      Error,
      "Invalid execution mode"
    );
  });

  await t.step("should throw error for streaming mode in sync execution", async () => {
    // Arrange
    const mockClient = new MockACPClient();
    const config = createTestConfig();
    const adapter = new TestACPAdapter(config, mockClient);
    const streamRequest = createTestRequest({ mode: "stream" });

    // Act & Assert
    await assertRejects(
      () => adapter.executeAgent(streamRequest),
      Error,
      "Use executeAgentStream for streaming mode"
    );
  });

  await t.step("should handle async execution mode", async () => {
    // Arrange
    const mockClient = new MockACPClient();
    const config = createTestConfig();
    const adapter = new TestACPAdapter(config, mockClient);
    const asyncRequest = createTestRequest({ mode: "async" });

    // Act
    const result = await adapter.executeAgent(asyncRequest);

    // Assert
    assertEquals(result.status, "completed");
    assertExists(result.executionId);
    assertEquals(result.output.length, 1);
    assertEquals(result.output[0].content_type, "text/plain");
  });

  await t.step("should populate result metadata correctly", async () => {
    // Arrange
    const mockClient = new MockACPClient();
    const config = createTestConfig();
    const adapter = new TestACPAdapter(config, mockClient);
    const request = createTestRequest({
      sessionId: "metadata-test-session",
      context: { test_metadata: true }
    });

    // Act
    const result = await adapter.executeAgent(request);

    // Assert
    assertEquals(result.status, "completed");
    assertExists(result.metadata);
    assertEquals(typeof result.metadata.execution_time_ms, "number");
    assertEquals(result.metadata.execution_time_ms > 0, true);
    assertEquals(result.metadata.session_id, "metadata-test-session");
    
    // Should have an execution ID that looks like a valid identifier
    assertEquals(result.executionId.startsWith("run_"), true);
    assertEquals(result.executionId.length > 10, true);
  });
});

Deno.test("ACPAdapter Agent Discovery", async (t) => {

  await t.step("should discover available agents", async () => {
    // Arrange
    const mockClient = new MockACPClient();
    const config = createTestConfig();
    const adapter = new TestACPAdapter(config, mockClient);

    // Act
    const agents = await adapter.discoverAgents();

    // Assert
    assertExists(agents);
    assertEquals(agents.length >= 2, true); // Should have test-agent and chat-agent
    assertEquals(agents.some(a => a.name === "test-agent"), true);
    assertEquals(agents.some(a => a.name === "chat-agent"), true);
  });

  await t.step("should get agent details for existing agent", async () => {
    // Arrange
    const mockClient = new MockACPClient();
    const config = createTestConfig();
    const adapter = new TestACPAdapter(config, mockClient);

    // Act
    const agentDetails = await adapter.getAgentDetails("test-agent");

    // Assert
    assertExists(agentDetails);
    assertEquals(agentDetails.name, "test-agent");
    assertEquals(agentDetails.description, "Test agent for unit testing");
  });

  await t.step("should throw error for non-existent agent", async () => {
    // Arrange
    const mockClient = new MockACPClient();
    const config = createTestConfig();
    const adapter = new TestACPAdapter(config, mockClient);

    // Act & Assert
    await assertRejects(
      () => adapter.getAgentDetails("non-existent-agent"),
      Error,
      "Agent 'non-existent-agent' not found"
    );
  });
});

Deno.test("ACPAdapter Health Monitoring", async (t) => {

  await t.step("should return healthy status when service is available", async () => {
    // Arrange
    const mockClient = new MockACPClient();
    const config = createTestConfig();
    const adapter = new TestACPAdapter(config, mockClient);

    // Act
    const health = await adapter.healthCheck();

    // Assert
    assertEquals(health.status, "healthy");
    assertEquals(typeof health.latency_ms, "number");
    assertEquals(health.latency_ms! > 0, true);
  });

  await t.step("should return unhealthy status when service fails", async () => {
    // Arrange
    const mockClient = new MockACPClient();
    mockClient.setExecutionFailure(true);
    const config = createTestConfig();
    const adapter = new TestACPAdapter(config, mockClient);

    // Act
    const health = await adapter.healthCheck();

    // Assert
    assertEquals(health.status, "unhealthy");
    assertEquals(typeof health.error, "string");
    assertEquals(health.error!.includes("Health check failed"), true);
  });

  await t.step("should measure health check latency accurately", async () => {
    // Arrange
    const mockClient = new MockACPClient();
    const config = createTestConfig();
    const adapter = new TestACPAdapter(config, mockClient);

    // Act
    const startTime = performance.now();
    const health = await adapter.healthCheck();
    const actualDuration = performance.now() - startTime;

    // Assert
    assertEquals(health.status, "healthy");
    assertEquals(typeof health.latency_ms, "number");
    // Health check latency should be reasonably close to actual duration
    const timeDiff = Math.abs(health.latency_ms! - actualDuration);
    assertEquals(timeDiff < 20, true, `Health check timing inaccurate: ${timeDiff}ms difference`);
  });
});