/**
 * Test Utilities for Actor Integration Tests
 *
 * Provides comprehensive testing infrastructure for Atlas actor system including:
 * - Test configuration builders
 * - Mock providers for predictable testing
 * - Actor lifecycle helpers
 * - Assertion utilities for async behavior
 * - Worker communication test helpers
 */

import type {
  JobSpecification,
  MergedConfig,
  WorkspaceAgentConfig,
  WorkspaceConfig,
} from "@atlas/config";
import type {
  ActorInitParams,
  AgentExecutePayload,
  AgentResult,
  SessionInfo,
  SessionResult,
  WorkspaceSupervisorConfig,
} from "@atlas/core";
// Removed import - will implement inline deferred pattern
import type { IWorkspaceSignal } from "../../../types/core.ts";
import type { WorkspaceSupervisorActor } from "../workspace-supervisor-actor.ts";

// ==============================================================================
// TEST CONFIGURATION BUILDERS
// ==============================================================================

/**
 * Creates a minimal test workspace configuration with agents included
 */
export function createTestWorkspaceConfig(options: {
  signals?: Record<string, WorkspaceConfig["signals"][string]>;
  jobs?: Record<string, JobSpecification>;
  agents?: Record<string, WorkspaceAgentConfig>;
  tools?: WorkspaceConfig["tools"];
}): WorkspaceSupervisorConfig {
  return {
    workspaceId: crypto.randomUUID(),
    workspace: {
      name: "Test Workspace",
      description: "Integration test workspace",
    },
    signals: options.signals || {
      "test-signal": {
        description: "Test signal for integration tests",
        provider: "http",
        config: {
          path: "/test",
        },
      },
    },
    jobs: options.jobs || {
      "test-job": {
        name: "test-job",
        description: "Test job for integration tests",
        execution: {
          strategy: "sequential",
          agents: ["test-agent"],
        },
        triggers: [
          {
            signal: "test-signal",
          },
        ],
      },
    },
    tools: options.tools || {
      mcp: {
        client_config: {
          timeout: "10s", // Shorter timeout for tests
        },
        servers: {
          filesystem: createTestMCPServer("filesystem"),
          memory: createTestMCPServer("memory"),
        },
      },
    },
  };
}

/**
 * Creates a test agent configuration with real providers
 */
export function createTestAgentConfig(
  id: string,
  type: "llm" | "system" | "remote" = "system",
  options: {
    prompt?: string;
    tools?: string[];
    systemCommand?: string;
    remoteUrl?: string;
  } = {},
): WorkspaceAgentConfig {
  switch (type) {
    case "llm":
      const llmConfig = createTestLLMConfig();
      return {
        description: `Test LLM agent ${id}`,
        type: "llm",
        config: {
          provider: llmConfig.provider,
          model: llmConfig.model,
          prompt: options.prompt ||
            "You are a helpful test assistant. Be concise in your responses.",
          tools: options.tools || ["filesystem"],
          temperature: llmConfig.temperature,
          max_tokens: llmConfig.max_tokens,
        },
      };
    case "system":
      return {
        description: `Test system agent ${id}`,
        type: "system",
        agent: options.systemCommand || "echo",
        config: {
          args: ["test output from", id],
        },
      };
    case "remote":
      return {
        description: `Test remote agent ${id}`,
        type: "remote",
        config: {
          protocol: "acp" as const,
          endpoint: options.remoteUrl || "http://localhost:9999/test-agent",
          agent_name: `test-agent-${id}`,
          default_mode: "sync" as const,
          health_check_interval: "30s",
          max_retries: 3,
          timeout: "10s", // Shorter timeout for tests
        },
      };
  }
}

/**
 * Creates a test signal
 */
export function createTestSignal(
  signalId = "test-signal",
  payload: Record<string, unknown> = {},
): IWorkspaceSignal {
  // Create a minimal test signal - using cast to bypass complex interface requirements
  return {
    id: signalId,
    provider: {
      id: "test-provider",
      name: "Test Provider",
    },
    trigger: async () => {},
    configure: () => {},
    // Add minimal payload access for tests
    context: payload,
    metadata: {
      source: "test",
    },
  } as unknown as IWorkspaceSignal;
}

// ==============================================================================
// REAL PROVIDER HELPERS
// ==============================================================================

/**
 * Creates a test-friendly LLM configuration
 * Uses real providers but with test-appropriate settings
 */
export function createTestLLMConfig(options: {
  provider?: "anthropic" | "openai" | "google";
  model?: string;
  temperature?: number;
  maxTokens?: number;
} = {}): {
  provider: "anthropic" | "openai" | "google";
  model: string;
  temperature: number;
  max_tokens: number;
} {
  return {
    provider: options.provider || "anthropic",
    model: options.model || "claude-3-haiku-20240307", // Use faster, cheaper model for tests
    temperature: options.temperature ?? 0.0, // Deterministic for tests
    max_tokens: options.maxTokens ?? 1000, // Limit tokens for cost
  };
}

/**
 * Creates a real MCP server configuration for testing
 */
export function createTestMCPServer(name: string): {
  transport: {
    type: "stdio";
    command: string;
    args?: string[];
  };
} {
  // Use actual MCP servers that exist in the test environment
  const serverConfigs: Record<string, { command: string; args?: string[] }> = {
    filesystem: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/atlas-test"],
    },
    memory: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
    },
    math: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-math"],
    },
  };

  const config = serverConfigs[name] || {
    command: "echo",
    args: [`No MCP server configured for ${name}`],
  };

  return {
    transport: {
      type: "stdio",
      ...config,
    },
  };
}

// ==============================================================================
// ACTOR LIFECYCLE HELPERS
// ==============================================================================

/**
 * Creates and initializes an actor with proper lifecycle management
 */
export async function createTestActor<
  T extends {
    initialize(params: ActorInitParams): void | Promise<void>;
    shutdown(): void | Promise<void>;
  },
>(
  ActorClass: new (...args: any[]) => T,
  ...args: any[]
): Promise<T> {
  const actor = new ActorClass(...args);
  await actor.initialize({
    actorId: crypto.randomUUID(),
    parentId: "test-parent",
  });
  return actor;
}

/**
 * Cleans up an actor after testing
 */
export async function cleanupActor(actor: { shutdown(): void | Promise<void> }): Promise<void> {
  try {
    const result = actor.shutdown();
    if (result instanceof Promise) {
      await result;
    }
  } catch (error) {
    console.error("Error shutting down actor:", error);
  }
}

// ==============================================================================
// ASYNC BEHAVIOR ASSERTIONS
// ==============================================================================

/**
 * Waits for a condition to become true with timeout
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: {
    timeout?: number;
    interval?: number;
    message?: string;
  } = {},
): Promise<void> {
  const { timeout = 5000, interval = 100, message = "Condition not met" } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`${message} (timeout after ${timeout}ms)`);
}

/**
 * Waits for a session to complete in a workspace supervisor
 */
export async function waitForSessionCompletion(
  supervisor: WorkspaceSupervisorActor,
  sessionId: string,
  timeout = 10000,
): Promise<SessionInfo> {
  await waitFor(
    () => {
      const session = supervisor.getSession(sessionId);
      return session?.status === "completed" || session?.status === "failed";
    },
    { timeout, message: `Session ${sessionId} did not complete` },
  );

  const session = supervisor.getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }
  return session;
}

/**
 * Captures actor events for verification
 */
export class EventCapture<T> {
  private events: T[] = [];
  private waiters: Array<{
    predicate: (event: T) => boolean;
    resolve: (event: T) => void;
    reject: (error: Error) => void;
  }> = [];

  capture(event: T): void {
    this.events.push(event);

    // Resolve any waiting promises
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const waiter = this.waiters[i];
      if (waiter.predicate(event)) {
        waiter.resolve(event);
        this.waiters.splice(i, 1);
      }
    }
  }

  getEvents(): T[] {
    return [...this.events];
  }

  async waitForEvent(predicate: (event: T) => boolean, timeout = 5000): Promise<T> {
    // Check existing events first
    const existing = this.events.find(predicate);
    if (existing) {
      return existing;
    }

    // Wait for future event
    return new Promise<T>((resolve, reject) => {
      // Set up timeout
      const timeoutId = setTimeout(() => {
        // Remove from waiters
        const index = this.waiters.findIndex((w) => w.resolve === resolve);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new Error("Event timeout"));
      }, timeout);

      // Add to waiters
      this.waiters.push({
        predicate,
        resolve: (event: T) => {
          clearTimeout(timeoutId);
          resolve(event);
        },
        reject,
      });
    });
  }

  clear(): void {
    this.events = [];
    // Reject any pending waiters
    for (const waiter of this.waiters) {
      waiter.reject(new Error("EventCapture cleared"));
    }
    this.waiters = [];
  }
}

// ==============================================================================
// WORKER COMMUNICATION HELPERS
// ==============================================================================

/**
 * Creates a test worker with message capture
 */
export class TestWorker extends Worker {
  private messageCapture = new EventCapture<MessageEvent>();
  private errorCapture = new EventCapture<ErrorEvent>();

  constructor(specifier: string | URL, options?: WorkerOptions) {
    super(specifier, options);

    this.addEventListener("message", (event) => {
      this.messageCapture.capture(event);
    });

    this.addEventListener("error", (event) => {
      this.errorCapture.capture(event);
    });
  }

  async waitForMessage(predicate: (data: any) => boolean, timeout = 5000): Promise<any> {
    const event = await this.messageCapture.waitForEvent(
      (e) => predicate(e.data),
      timeout,
    );
    return event.data;
  }

  async waitForError(timeout = 5000): Promise<ErrorEvent> {
    return this.errorCapture.waitForEvent(() => true, timeout);
  }

  getMessages(): any[] {
    return this.messageCapture.getEvents().map((e) => e.data);
  }
}

/**
 * Creates a mock BroadcastChannel for testing
 */
export class MockBroadcastChannel implements BroadcastChannel {
  name: string;
  private listeners = new Set<(event: MessageEvent) => void>();
  private static channels = new Map<string, Set<MockBroadcastChannel>>();

  constructor(name: string) {
    this.name = name;

    // Register this channel
    if (!MockBroadcastChannel.channels.has(name)) {
      MockBroadcastChannel.channels.set(name, new Set());
    }
    MockBroadcastChannel.channels.get(name)!.add(this);
  }

  postMessage(message: any): void {
    // Broadcast to all other channels with same name
    const channels = MockBroadcastChannel.channels.get(this.name);
    if (channels) {
      for (const channel of channels) {
        if (channel !== this) {
          const event = new MessageEvent("message", { data: message });
          for (const listener of channel.listeners) {
            queueMicrotask(() => listener(event));
          }
        }
      }
    }
  }

  addEventListener(type: "message", listener: (event: MessageEvent) => void): void {
    if (type === "message") {
      this.listeners.add(listener);
    }
  }

  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void {
    if (type === "message") {
      this.listeners.delete(listener);
    }
  }

  close(): void {
    const channels = MockBroadcastChannel.channels.get(this.name);
    if (channels) {
      channels.delete(this);
      if (channels.size === 0) {
        MockBroadcastChannel.channels.delete(this.name);
      }
    }
    this.listeners.clear();
  }

  // Required for interface but not used in tests
  onmessage: ((this: BroadcastChannel, ev: MessageEvent) => any) | null = null;
  onmessageerror: ((this: BroadcastChannel, ev: MessageEvent) => any) | null = null;
  dispatchEvent(event: Event): boolean {
    return true;
  }
}

// ==============================================================================
// RESULT VERIFICATION HELPERS
// ==============================================================================

/**
 * Asserts agent results match expected values
 */
export function assertAgentResult(
  actual: AgentResult,
  expected: Partial<AgentResult>,
): void {
  if (expected.agentId !== undefined) {
    if (actual.agentId !== expected.agentId) {
      throw new Error(`Agent ID mismatch: expected ${expected.agentId}, got ${actual.agentId}`);
    }
  }

  if (expected.output !== undefined) {
    const actualStr = JSON.stringify(actual.output);
    const expectedStr = JSON.stringify(expected.output);
    if (actualStr !== expectedStr) {
      throw new Error(`Output mismatch: expected ${expectedStr}, got ${actualStr}`);
    }
  }

  if (expected.duration !== undefined) {
    if (Math.abs(actual.duration - expected.duration) > 100) {
      throw new Error(
        `Duration mismatch: expected ~${expected.duration}ms, got ${actual.duration}ms`,
      );
    }
  }
}

/**
 * Asserts session results match expected values
 */
export function assertSessionResult(
  actual: SessionResult,
  expected: Partial<SessionResult>,
): void {
  if (expected.status !== undefined && actual.status !== expected.status) {
    throw new Error(`Status mismatch: expected ${expected.status}, got ${actual.status}`);
  }

  if (expected.result !== undefined) {
    const actualStr = JSON.stringify(actual.result);
    const expectedStr = JSON.stringify(expected.result);
    if (actualStr !== expectedStr) {
      throw new Error(`Result mismatch: expected ${expectedStr}, got ${actualStr}`);
    }
  }
}

// ==============================================================================
// REAL INTEGRATION TEST HELPERS
// ==============================================================================

/**
 * Creates a test workspace with real agents and MCP servers
 */
export async function createRealTestWorkspace(options: {
  agentTypes?: Array<"llm" | "system">;
  mcpServers?: string[];
  jobStrategy?: "sequential" | "parallel";
} = {}): Promise<MergedConfig> {
  const agentTypes = options.agentTypes || ["system"];
  const mcpServers = options.mcpServers || ["filesystem"];

  // Create agents
  const agents: Record<string, WorkspaceAgentConfig> = {};
  agentTypes.forEach((type, index) => {
    const agentId = `agent-${index + 1}`;
    agents[agentId] = createTestAgentConfig(agentId, type, {
      tools: type === "llm" ? mcpServers : undefined,
    });
  });

  // Create MCP server configs
  const servers: Record<string, any> = {};
  mcpServers.forEach((server) => {
    servers[server] = createTestMCPServer(server);
  });

  const workspaceConfig: WorkspaceConfig = {
    version: "1.0",
    workspace: {
      name: "Real Test Workspace",
      description: "Integration test with real providers",
    },
    signals: {
      "test-signal": {
        description: "Test signal",
        provider: "http",
        config: { path: "/test" },
      },
    },
    jobs: {
      "test-job": {
        name: "test-job",
        description: "Test job with real agents",
        execution: {
          strategy: options.jobStrategy || "sequential",
          agents: Object.keys(agents),
        },
        triggers: [{ signal: "test-signal" }],
      },
    },
    agents,
    tools: {
      mcp: {
        client_config: { timeout: "10s" },
        servers,
      },
    },
  };

  // Create merged config as it would be in runtime
  const mergedConfig: MergedConfig = {
    workspace: workspaceConfig,
    atlas: {
      version: "1.0",
      workspace: workspaceConfig.workspace,
      memory: {
        default: {
          enabled: true,
          storage: "filesystem",
          cognitive_loop: false,
          retention: {
            max_age_days: 1, // Short for tests
            cleanup_interval_hours: 1,
            max_entries: 100,
          },
        },
        agent: {
          enabled: true,
          scope: "workspace",
          include_in_context: true,
          context_limits: {
            relevant_memories: 10,
            past_successes: 5,
            past_failures: 5,
          },
          memory_types: {
            working: { enabled: true },
          },
        },
        session: {
          enabled: true,
          scope: "session",
          include_in_context: true,
          context_limits: {
            relevant_memories: 5,
            past_successes: 3,
            past_failures: 2,
          },
          memory_types: {
            episodic: { enabled: true },
          },
        },
        workspace: {
          enabled: true,
          scope: "workspace",
          include_in_context: false,
          context_limits: {
            relevant_memories: 20,
            past_successes: 10,
            past_failures: 10,
          },
          memory_types: {
            semantic: { enabled: true },
          },
        },
      },
      supervisors: {
        workspace: {
          model: "claude-3-haiku-20240307",
          supervision: { level: "standard", cache_enabled: false },
          prompts: {
            system: "You are a test workspace supervisor. Be concise.",
            analysis: "Analyze this signal for testing: {{signal}}",
          },
        },
        session: {
          model: "claude-3-haiku-20240307",
          supervision: { level: "standard", cache_enabled: false },
          prompts: {
            system: "You are a test session supervisor. Be concise.",
            planning: "Create a simple test plan for: {{task}}",
          },
        },
        agent: {
          model: "claude-3-haiku-20240307",
          supervision: { level: "minimal", cache_enabled: false },
          prompts: {
            system: "You are a test agent supervisor. Be concise.",
            analysis: "Assess this agent task for testing.",
          },
        },
      },
    },
  };

  return mergedConfig;
}

/**
 * Verifies that required environment variables are set for real tests
 */
export function verifyTestEnvironment(): void {
  const required = ["ANTHROPIC_API_KEY"];
  const missing = required.filter((key) => !Deno.env.get(key));

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables for integration tests: ${missing.join(", ")}\n` +
        `Please set these in your .env file or environment.`,
    );
  }
}

/**
 * Creates a temporary test directory for file operations
 */
export async function createTestDirectory(): Promise<string> {
  const tempDir = await Deno.makeTempDir({ prefix: "atlas_test_" });
  return tempDir;
}

/**
 * Cleans up test directory
 */
export async function cleanupTestDirectory(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    console.error(`Failed to cleanup test directory ${path}:`, error);
  }
}

// ==============================================================================
// PERFORMANCE TESTING HELPERS
// ==============================================================================

/**
 * Measures execution time and memory usage
 */
export async function measurePerformance<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<{ result: T; duration: number; memoryDelta: number }> {
  const startMemory = Deno.memoryUsage().heapUsed;
  const startTime = performance.now();

  const result = await fn();

  const duration = performance.now() - startTime;
  const endMemory = Deno.memoryUsage().heapUsed;
  const memoryDelta = endMemory - startMemory;

  console.log(
    `[PERF] ${name}: ${duration.toFixed(2)}ms, memory: ${(memoryDelta / 1024 / 1024).toFixed(2)}MB`,
  );

  return { result, duration, memoryDelta };
}

/**
 * Runs multiple iterations and reports statistics
 */
export async function benchmarkActor<T>(
  name: string,
  setup: () => Promise<void>,
  fn: () => Promise<T>,
  teardown: () => Promise<void>,
  iterations = 10,
): Promise<{ avg: number; min: number; max: number; stdDev: number }> {
  const durations: number[] = [];

  for (let i = 0; i < iterations; i++) {
    await setup();
    const { duration } = await measurePerformance(`${name} #${i + 1}`, fn);
    durations.push(duration);
    await teardown();
  }

  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  const min = Math.min(...durations);
  const max = Math.max(...durations);
  const variance = durations.reduce((sum, d) => sum + Math.pow(d - avg, 2), 0) / durations.length;
  const stdDev = Math.sqrt(variance);

  console.log(`[BENCHMARK] ${name}:`);
  console.log(`  Avg: ${avg.toFixed(2)}ms`);
  console.log(`  Min: ${min.toFixed(2)}ms`);
  console.log(`  Max: ${max.toFixed(2)}ms`);
  console.log(`  StdDev: ${stdDev.toFixed(2)}ms`);

  return { avg, min, max, stdDev };
}
