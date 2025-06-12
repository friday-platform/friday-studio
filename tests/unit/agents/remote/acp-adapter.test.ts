/**
 * Unit tests for ACPAdapter sync execution functionality
 * Tests the core ACP protocol integration and execution flows
 */

import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert";
import {
  ACPAdapter,
  ACPAdapterConfig,
} from "../../../../src/core/agents/remote/adapters/acp-adapter.ts";
import type { RemoteExecutionRequest } from "../../../../src/core/agents/remote/types.ts";

// Mock ACP SDK types and client for testing
interface MockRun {
  run_id: string;
  status: "completed" | "failed" | "cancelled" | "running";
  output: MockMessage[];
  error?: { message: string };
}

interface MockMessage {
  parts: MockPart[];
}

interface MockPart {
  content_type: string;
  content: string;
}

interface MockAgent {
  name: string;
  description?: string;
  metadata?: {
    capabilities?: Array<{ name: string } | string>;
  };
}

// Mock ACP Client implementation for testing
class MockACPClient {
  private agentList: MockAgent[] = [];
  private runs: Map<string, MockRun> = new Map();
  private shouldFailHealthCheck = false;
  private shouldFailExecution = false;
  private executionDelay = 0;

  constructor() {
    // Add default test agent
    this.agentList.push({
      name: "test-agent",
      description: "Test agent for unit testing",
      metadata: {
        capabilities: ["chat", "analysis"],
      },
    });
  }

  // Test configuration methods
  setHealthCheckFailure(shouldFail: boolean) {
    this.shouldFailHealthCheck = shouldFail;
  }

  setExecutionFailure(shouldFail: boolean) {
    this.shouldFailExecution = shouldFail;
  }

  setExecutionDelay(delayMs: number) {
    this.executionDelay = delayMs;
  }

  addAgent(agent: MockAgent) {
    this.agentList.push(agent);
  }

  // ACP Client interface implementation
  async ping(): Promise<void> {
    if (this.shouldFailHealthCheck) {
      throw new Error("Health check failed");
    }
    await this.delay(10); // Simulate network latency
  }

  async agents(): Promise<MockAgent[]> {
    await this.delay(50);
    return [...this.agentList];
  }

  async agent(name: string): Promise<MockAgent> {
    await this.delay(20);
    const agent = this.agentList.find((a) => a.name === name);
    if (!agent) {
      const error = new Error(`Agent '${name}' not found`) as any;
      error.code = "not_found";
      throw error;
    }
    return agent;
  }

  async runSync(agentName: string, input: string): Promise<MockRun> {
    await this.delay(this.executionDelay);

    if (this.shouldFailExecution) {
      throw new Error("Execution failed");
    }

    const runId = `run_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const run: MockRun = {
      run_id: runId,
      status: "completed",
      output: [{
        parts: [{
          content_type: "text/plain",
          content: `Response from ${agentName}: ${input}`,
        }],
      }],
    };

    this.runs.set(runId, run);
    return run;
  }

  async runAsync(agentName: string, input: string): Promise<MockRun> {
    const run = await this.runSync(agentName, input);
    // For async, return with running status initially
    run.status = "running";

    // Simulate async completion after delay
    setTimeout(() => {
      const storedRun = this.runs.get(run.run_id);
      if (storedRun) {
        storedRun.status = "completed";
      }
    }, 100);

    return run;
  }

  async runStatus(runId: string): Promise<MockRun> {
    await this.delay(10);
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Run '${runId}' not found`);
    }
    return { ...run };
  }

  async runCancel(runId: string): Promise<void> {
    await this.delay(10);
    const run = this.runs.get(runId);
    if (run) {
      run.status = "cancelled";
    }
  }

  async *runStream(agentName: string, input: string) {
    await this.delay(this.executionDelay);

    if (this.shouldFailExecution) {
      throw new Error("Streaming execution failed");
    }

    // Simulate streaming response
    const response = `Streaming response from ${agentName}: ${input}`;
    const words = response.split(" ");

    for (const word of words) {
      yield {
        type: "message.part",
        part: {
          content_type: "text/plain",
          content: word + " ",
        },
      };
      await this.delay(10);
    }

    yield {
      type: "run.completed",
      run: {
        run_id: `stream_${Date.now()}`,
        status: "completed",
        output: [{
          parts: [{
            content_type: "text/plain",
            content: response,
          }],
        }],
      },
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Mock the acp-sdk module
const mockClient = new MockACPClient();
const mockACPSDK = {
  Client: class {
    constructor(_config: any) {
      return mockClient;
    }
  },
  ACPError: class extends Error {
    constructor(message: string, public code: string) {
      super(message);
      this.name = "ACPError";
    }
  },
  HTTPError: class extends Error {
    constructor(message: string, public status?: number) {
      super(message);
      this.name = "HTTPError";
    }
  },
  FetchError: class extends Error {
    constructor(message: string) {
      super(message);
      this.name = "FetchError";
    }
  },
};

// Helper function to create test adapter configuration
function createTestConfig(overrides: Partial<ACPAdapterConfig> = {}): ACPAdapterConfig {
  return {
    endpoint: "https://test-acp-server.example.com",
    connection: {
      endpoint: "https://test-acp-server.example.com",
      timeout: 5000,
      retries: 2,
      keepAlive: true,
    },
    auth: {
      type: "bearer",
      token: "test-token-12345",
    },
    acp: {
      agent_name: "test-agent",
      default_mode: "sync",
      timeout_ms: 5000,
      max_retries: 2,
      health_check_interval: 60000,
    },
    circuit_breaker: {
      failure_threshold: 3,
      timeout_ms: 30000,
      half_open_max_calls: 2,
    },
    ...overrides,
  };
}

// Helper function to create test execution request
function createTestRequest(
  overrides: Partial<RemoteExecutionRequest> = {},
): RemoteExecutionRequest {
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

Deno.test("ACPAdapter Sync Execution Tests", async (t) => {
  await t.step("should successfully execute sync request and return correct result", async () => {
    // Arrange
    const config = createTestConfig();
    const adapter = new ACPAdapter(config);
    const request = createTestRequest();

    // Reset mock state
    mockClient.setExecutionFailure(false);
    mockClient.setExecutionDelay(100);

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
    const config = createTestConfig();
    const adapter = new ACPAdapter(config);
    const request = createTestRequest();

    // Configure mock to fail
    mockClient.setExecutionFailure(true);

    // Act & Assert
    await assertRejects(
      () => adapter.executeAgent(request),
      Error,
      "Remote execution failed for agent 'test-agent'",
    );

    // Reset mock state
    mockClient.setExecutionFailure(false);
  });

  await t.step("should measure execution time accurately", async () => {
    // Arrange
    const config = createTestConfig();
    const adapter = new ACPAdapter(config);
    const request = createTestRequest();
    const expectedDelay = 200;

    // Configure mock with specific delay
    mockClient.setExecutionDelay(expectedDelay);

    // Act
    const startTime = performance.now();
    const result = await adapter.executeAgent(request);
    const actualDuration = performance.now() - startTime;

    // Assert
    assertEquals(result.status, "completed");
    // Execution time should be close to actual duration (within 50ms tolerance)
    const timeDiff = Math.abs(result.metadata.execution_time_ms - actualDuration);
    assertEquals(timeDiff < 50, true, `Time difference too large: ${timeDiff}ms`);

    // Reset mock state
    mockClient.setExecutionDelay(0);
  });

  await t.step("should handle different input types correctly", async () => {
    // Arrange
    const config = createTestConfig();
    const adapter = new ACPAdapter(config);

    // Test string input
    const stringRequest = createTestRequest({ input: "Simple string input" });
    const stringResult = await adapter.executeAgent(stringRequest);
    assertEquals(stringResult.status, "completed");
    assertEquals(stringResult.output[0].content, "Response from test-agent: Simple string input");

    // Test structured input (should be converted to JSON string)
    const structuredRequest = createTestRequest({
      input: [
        { content_type: "text/plain", content: "Structured input" },
        { content_type: "application/json", content: '{"key": "value"}' },
      ],
    });
    const structuredResult = await adapter.executeAgent(structuredRequest);
    assertEquals(structuredResult.status, "completed");
    // Should contain JSON representation of the input array
    assertEquals(String(structuredResult.output[0].content).includes("Structured input"), true);
  });

  await t.step("should populate result metadata correctly", async () => {
    // Arrange
    const config = createTestConfig();
    const adapter = new ACPAdapter(config);
    const request = createTestRequest({
      sessionId: "metadata-test-session",
      context: { test_metadata: true },
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

  await t.step("should throw error for streaming mode in sync execution", async () => {
    // Arrange
    const config = createTestConfig();
    const adapter = new ACPAdapter(config);
    const streamRequest = createTestRequest({ mode: "stream" });

    // Act & Assert
    await assertRejects(
      () => adapter.executeAgent(streamRequest),
      Error,
      "Use executeAgentStream for streaming mode",
    );
  });

  await t.step("should handle async execution with polling", async () => {
    // Arrange
    const config = createTestConfig();
    const adapter = new ACPAdapter(config);
    const asyncRequest = createTestRequest({ mode: "async" });

    // Act
    const result = await adapter.executeAgent(asyncRequest);

    // Assert
    assertEquals(result.status, "completed");
    assertExists(result.executionId);
    assertEquals(result.output.length, 1);
    assertEquals(result.output[0].content_type, "text/plain");
    assertEquals(result.metadata.execution_time_ms > 100, true); // Should include polling time
  });

  await t.step("should handle empty or no output gracefully", async () => {
    // Arrange
    const config = createTestConfig();
    const adapter = new ACPAdapter(config);
    const request = createTestRequest();

    // Mock empty output
    const originalRunSync = mockClient.runSync;
    mockClient.runSync = async (agentName: string, input: string) => {
      const run = await originalRunSync.call(mockClient, agentName, input);
      run.output = []; // Empty output
      return run;
    };

    // Act
    const result = await adapter.executeAgent(request);

    // Assert
    assertEquals(result.status, "completed");
    assertEquals(result.output.length, 0);

    // Restore original method
    mockClient.runSync = originalRunSync;
  });

  await t.step("should include proper context in execution request", async () => {
    // Arrange
    const config = createTestConfig();
    const adapter = new ACPAdapter(config);
    const contextRequest = createTestRequest({
      context: {
        user_id: "test-user-123",
        workflow_id: "test-workflow-456",
        custom_data: { priority: "high" },
      },
    });

    // Act
    const result = await adapter.executeAgent(contextRequest);

    // Assert
    assertEquals(result.status, "completed");
    // Context should be preserved in session metadata
    assertEquals(result.metadata.session_id, contextRequest.sessionId);
  });
});

Deno.test("ACPAdapter Error Handling", async (t) => {
  await t.step("should handle network errors gracefully", async () => {
    // Arrange
    const config = createTestConfig();
    const adapter = new ACPAdapter(config);
    const request = createTestRequest();

    // Mock network failure
    mockClient.setExecutionFailure(true);

    // Act & Assert
    await assertRejects(
      () => adapter.executeAgent(request),
      Error,
      "Remote execution failed for agent 'test-agent': Execution failed",
    );

    // Reset mock state
    mockClient.setExecutionFailure(false);
  });

  await t.step("should convert different error types appropriately", async () => {
    // This test would need more sophisticated mocking to test different error types
    // For now, we test the basic error conversion path
    const config = createTestConfig();
    const adapter = new ACPAdapter(config);
    const request = createTestRequest();

    mockClient.setExecutionFailure(true);

    try {
      await adapter.executeAgent(request);
    } catch (error) {
      assertExists(error);
      assertEquals(error instanceof Error, true);
      assertEquals((error as Error).message.includes("Remote execution failed"), true);
    }

    mockClient.setExecutionFailure(false);
  });
});
