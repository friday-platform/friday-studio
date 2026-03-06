/**
 * Integration tests for the fastpath wiring in createDoTaskTool (index.ts).
 *
 * Exercises the orchestration code: fastpath gate, credential resolution,
 * MCP tools lifecycle, full-pipeline fallback, and timing instrumentation.
 *
 * Mocks are at system boundaries: LLM calls, executor, MCP tools, credential
 * resolution, and artifact storage.
 */
import type { Agent, CredentialBinding } from "@atlas/workspace-builder";
import { PipelineError } from "@atlas/workspace-builder";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must come before module imports
// ---------------------------------------------------------------------------

const mockGeneratePlan = vi.hoisted(() => vi.fn());
const mockClassifyAgents = vi.hoisted(() => vi.fn());
const mockMCPRegistryList = vi.hoisted(() => vi.fn());
const mockResolveCredentials = vi.hoisted(() => vi.fn());
const mockCheckEnvironmentReadiness = vi.hoisted(() => vi.fn());
const mockBuildBlueprint = vi.hoisted(() => vi.fn());
const mockBuildFSMFromPlan = vi.hoisted(() => vi.fn());
const mockExecuteTaskViaFSMDirect = vi.hoisted(() => vi.fn());
const mockGenerateFriendlyDescriptions = vi.hoisted(() => vi.fn());
const mockSmallLLM = vi.hoisted(() => vi.fn());
const mockParseResult = vi.hoisted(() => vi.fn());
vi.mock("@atlas/workspace-builder", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@atlas/workspace-builder")>();
  return {
    ...orig,
    generatePlan: mockGeneratePlan,
    classifyAgents: mockClassifyAgents,
    resolveCredentials: mockResolveCredentials,
    checkEnvironmentReadiness: mockCheckEnvironmentReadiness,
    buildBlueprint: mockBuildBlueprint,
    buildFSMFromPlan: mockBuildFSMFromPlan,
  };
});

vi.mock("./ephemeral-executor.ts", () => ({
  executeTaskViaFSMDirect: mockExecuteTaskViaFSMDirect,
}));

vi.mock("./friendly-descriptions.ts", () => ({
  generateFriendlyDescriptions: mockGenerateFriendlyDescriptions,
}));

vi.mock("@atlas/llm", () => ({ smallLLM: mockSmallLLM }));

vi.mock("@atlas/client/v2", () => ({
  client: { artifactsStorage: { index: { $post: vi.fn() } } },
  parseResult: mockParseResult,
}));

vi.mock("@atlas/core/mcp-registry/registry-consolidated", () => ({
  mcpServersRegistry: { servers: {} },
}));

vi.mock("@atlas/core/mcp-registry/storage", () => ({
  getMCPRegistryAdapter: vi.fn(() => ({ list: mockMCPRegistryList })),
}));

const mockLoggerInstance = vi.hoisted(() => {
  const instance: Record<string, unknown> = {};
  instance.trace = vi.fn();
  instance.debug = vi.fn();
  instance.info = vi.fn();
  instance.warn = vi.fn();
  instance.error = vi.fn();
  instance.fatal = vi.fn();
  instance.child = vi.fn(() => instance);
  return instance;
});

vi.mock("@atlas/logger", () => ({
  logger: mockLoggerInstance,
  createLogger: vi.fn(() => mockLoggerInstance),
  AtlasLogger: { configure: vi.fn() },
}));

vi.mock("@atlas/utils", () => ({
  truncateUnicode: vi.fn((s: string, len: number) => s.slice(0, len)),
}));

import { createDoTaskTool } from "./index.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "test-agent",
    name: "Test Agent",
    description: "A test agent",
    capabilities: ["testing"],
    bundledId: "research",
    ...overrides,
  };
}

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

const mockWriter = { write: vi.fn(), merge: vi.fn(), onError: vi.fn() };

const baseSession = {
  sessionId: "sess-1",
  workspaceId: "ws-1",
  streamId: "stream-1",
  userId: "user-1",
  daemonUrl: "http://localhost:8080",
};

function makePlanResult(agents: Agent[], dynamicServers: unknown[] = []) {
  return { workspace: { name: "Test", purpose: "Test" }, signals: [], agents, dynamicServers };
}

function makeClassifyResult(
  overrides: {
    clarifications?: Array<{
      agentId: string;
      agentName: string;
      capability: string;
      issue: { type: string };
    }>;
    configRequirements?: Array<{
      agentId: string;
      integration: { type: string };
      requiredConfig: unknown[];
    }>;
  } = {},
) {
  return {
    agents: [],
    clarifications: overrides.clarifications ?? [],
    configRequirements: overrides.configRequirements ?? [],
  };
}

function makeExecResult(overrides: Partial<{ success: boolean; results: unknown[] }> = {}) {
  return {
    success: true,
    results: [
      {
        step: 0,
        agent: "research",
        success: true,
        output: { ok: true, data: { response: "Done" } },
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub options satisfying ToolCallOptions for direct execute calls in tests. */
const stubCallOptions = { toolCallId: "test-call", messages: [] };

/**
 * Extract the execute function from the tool returned by createDoTaskTool.
 *
 * Wraps the raw tool.execute to:
 * 1. Assert execute is defined (AI SDK marks it optional)
 * 2. Pass stub ToolCallOptions (2nd arg required by AI SDK v5)
 * 3. Narrow return type from DoTaskResult | AsyncIterable to DoTaskResult
 */
function getExecute(abortSignal?: AbortSignal) {
  const tool = createDoTaskTool(
    mockWriter as unknown as Parameters<typeof createDoTaskTool>[0],
    baseSession,
    mockLogger as unknown as Parameters<typeof createDoTaskTool>[2],
    abortSignal,
  );
  if (!tool.execute) throw new Error("tool.execute is undefined");
  const executeFn = tool.execute;
  return async (input: { intent: string }) => {
    const raw = await executeFn(input, stubCallOptions);
    // do_task always returns DoTaskResult, never an async iterable
    if (!("success" in raw)) throw new Error("Unexpected async iterable from do_task");
    return raw;
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default: storeTaskArtifact succeeds, dynamic registry returns empty
  mockSmallLLM.mockResolvedValue("Task completed");
  mockMCPRegistryList.mockResolvedValue([]);
  mockParseResult.mockResolvedValue({ ok: true, data: { artifact: { id: "art-1" } } });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDoTaskTool fastpath wiring", () => {
  it("fastpath-eligible input skips buildBlueprint entirely", async () => {
    const agent = makeAgent({ bundledId: "research" });
    mockGeneratePlan.mockResolvedValue(makePlanResult([agent]));
    mockClassifyAgents.mockResolvedValue(makeClassifyResult());
    mockExecuteTaskViaFSMDirect.mockResolvedValue(makeExecResult());

    const execute = getExecute();
    const result = await execute({ intent: "find info" });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(mockBuildBlueprint).not.toHaveBeenCalled();
    expect(mockExecuteTaskViaFSMDirect).toHaveBeenCalledOnce();

    // Verify the composed FSM shape and executor context
    const [fsmArg, , ctxArg] = mockExecuteTaskViaFSMDirect.mock.calls[0] as [
      { id: string; states: Record<string, unknown> },
      unknown,
      { documentContracts?: Array<{ documentId: string }>; dagSteps?: unknown[] },
    ];

    // FSM shape: task-fastpath-* id with 3 states (idle, step, completed)
    expect(fsmArg.id).toMatch(/^task-fastpath-/);
    expect(Object.keys(fsmArg.states)).toHaveLength(3);

    // Document contracts wired (prevents silent result loss)
    expect(ctxArg.documentContracts).toHaveLength(1);
    expect(ctxArg.documentContracts?.[0]?.documentId).toBe("result");

    // DAG steps wired (drives progress events)
    expect(ctxArg.dagSteps).toHaveLength(1);
  });

  it("LLM-agent fastpath produces llm action type with MCP tools", async () => {
    const agent = makeAgent({
      bundledId: undefined,
      name: "Gmail Helper",
      mcpServers: [{ serverId: "google-gmail", name: "Gmail" }],
    });
    mockGeneratePlan.mockResolvedValue(makePlanResult([agent]));
    mockClassifyAgents.mockResolvedValue(
      makeClassifyResult({
        configRequirements: [
          {
            agentId: "test-agent",
            integration: { type: "mcp" },
            requiredConfig: [{ key: "GMAIL_TOKEN", source: "link", provider: "google" }],
          },
        ],
      }),
    );
    mockResolveCredentials.mockResolvedValue({
      bindings: [{ agentId: "test-agent", field: "GMAIL_TOKEN", value: "tok-gmail" }],
      unresolved: [],
    });
    mockCheckEnvironmentReadiness.mockReturnValue({ ready: true, checks: [] });
    mockExecuteTaskViaFSMDirect.mockResolvedValue(makeExecResult());

    const execute = getExecute();
    const result = await execute({ intent: "check my email" });

    expect(result.success).toBe(true);
    expect(mockBuildBlueprint).not.toHaveBeenCalled();
    expect(mockExecuteTaskViaFSMDirect).toHaveBeenCalledOnce();

    // Verify FSM has llm action (not agent action)
    const [fsmArg, stepsArg] = mockExecuteTaskViaFSMDirect.mock.calls[0] as [
      { id: string; states: Record<string, { entry?: Array<{ type: string; tools?: string[] }> }> },
      Array<{ executionType: string }>,
    ];

    expect(fsmArg.id).toMatch(/^task-fastpath-/);
    expect(Object.keys(fsmArg.states)).toHaveLength(3);

    // Find the step state (not idle, not completed)
    const stepState = Object.entries(fsmArg.states).find(
      ([key]) => key !== "idle" && key !== "completed",
    );
    const entry = stepState?.[1].entry;
    expect(entry?.[0]?.type).toBe("llm");
    expect(entry?.[0]?.tools).toEqual(["google-gmail"]);

    // Step has executionType "llm" (not "agent")
    expect(stepsArg[0]?.executionType).toBe("llm");
  });

  it("fastpath with unresolved credentials returns { success: false } without calling executor", async () => {
    const agent = makeAgent({
      bundledId: "research",
      mcpServers: [{ serverId: "google-gmail", name: "Gmail" }],
    });
    mockGeneratePlan.mockResolvedValue(makePlanResult([agent]));
    mockClassifyAgents.mockResolvedValue(
      makeClassifyResult({
        configRequirements: [
          {
            agentId: "test-agent",
            integration: { type: "mcp" },
            requiredConfig: [{ key: "GOOGLE_TOKEN", source: "link", provider: "google" }],
          },
        ],
      }),
    );
    mockResolveCredentials.mockResolvedValue({
      bindings: [],
      unresolved: [
        {
          agentId: "test-agent",
          field: "GOOGLE_TOKEN",
          provider: "google",
          reason: "No credentials found",
        },
      ],
    });

    const execute = getExecute();
    const result = await execute({ intent: "check email" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("google");
    expect(result.error).toContain("GOOGLE_TOKEN");
    expect(mockExecuteTaskViaFSMDirect).not.toHaveBeenCalled();
    expect(mockBuildBlueprint).not.toHaveBeenCalled();
  });

  it("fastpath-ineligible input calls buildBlueprint with precomputed option", async () => {
    const agents = [
      makeAgent({ id: "a1", name: "Agent A", bundledId: "research" }),
      makeAgent({ id: "a2", name: "Agent B", bundledId: "email" }),
    ];
    const planResult = makePlanResult(agents);
    const classifyResult = makeClassifyResult();

    mockGeneratePlan.mockResolvedValue(planResult);
    mockClassifyAgents.mockResolvedValue(classifyResult);
    mockBuildBlueprint.mockResolvedValue({
      blueprint: {
        agents,
        jobs: [
          {
            id: "job-1",
            steps: [
              {
                id: "step-1",
                agentId: "a1",
                executionRef: "research",
                description: "Research",
                depends_on: [],
                executionType: "bundled",
              },
            ],
            documentContracts: [],
          },
        ],
      },
      clarifications: [],
      credentials: { bindings: [] as CredentialBinding[], unresolved: [] },
    });
    mockGenerateFriendlyDescriptions.mockResolvedValue(["Researching..."]);
    mockBuildFSMFromPlan.mockReturnValue({
      success: true,
      value: {
        fsm: {
          id: "test-fsm",
          initial: "idle",
          states: { idle: {}, completed: { type: "final" } },
        },
        warnings: [],
      },
    });
    mockExecuteTaskViaFSMDirect.mockResolvedValue(makeExecResult());

    const execute = getExecute();
    const result = await execute({ intent: "research and email" });

    // buildBlueprint was called (not fastpath)
    expect(mockBuildBlueprint).toHaveBeenCalledOnce();

    // Verify precomputed option was passed
    const bpCall = mockBuildBlueprint.mock.calls[0] as unknown[];
    expect(bpCall[0]).toBe("research and email");
    expect(bpCall[1]).toMatchObject({
      precomputed: {
        plan: planResult,
        classified: {
          clarifications: classifyResult.clarifications,
          configRequirements: classifyResult.configRequirements,
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("executor receives mcpServerConfigs when execution throws", async () => {
    const agent = makeAgent({ bundledId: "research" });
    mockGeneratePlan.mockResolvedValue(makePlanResult([agent]));
    mockClassifyAgents.mockResolvedValue(makeClassifyResult());
    mockExecuteTaskViaFSMDirect.mockRejectedValue(new Error("executor boom"));

    const execute = getExecute();
    const result = await execute({ intent: "fail task" });

    // The error is caught by the outer try/catch, so we get a failure result
    expect(result.success).toBe(false);
    // mcpServerConfigs passed to executor (FSM engine handles lifecycle)
    const ctxArg = mockExecuteTaskViaFSMDirect.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(ctxArg).toHaveProperty("mcpServerConfigs");
  });

  it("timing has fastpath: true on fastpath, fastpath: false on full pipeline", async () => {
    // --- Fastpath run ---
    const agent = makeAgent({ bundledId: "research" });
    mockGeneratePlan.mockResolvedValue(makePlanResult([agent]));
    mockClassifyAgents.mockResolvedValue(makeClassifyResult());
    mockExecuteTaskViaFSMDirect.mockResolvedValue(makeExecResult());

    const execute = getExecute();
    await execute({ intent: "fastpath task" });

    // logger.info("do_task completed", { fastpath: true, ... }) — uses the passed-in logger
    const infoCall = mockLogger.info.mock.calls.find(
      (c: unknown[]) => c[0] === "do_task completed",
    );
    expect(infoCall).toBeDefined();
    expect(infoCall?.[1]).toMatchObject({ fastpath: true });

    // --- Full pipeline run ---
    vi.clearAllMocks();
    mockSmallLLM.mockResolvedValue("Task completed");
    mockParseResult.mockResolvedValue({ ok: true, data: { artifact: { id: "art-2" } } });
    const agents2 = [
      makeAgent({ id: "a1", name: "Agent A", bundledId: "research" }),
      makeAgent({ id: "a2", name: "Agent B", bundledId: "email" }),
    ];
    mockGeneratePlan.mockResolvedValue(makePlanResult(agents2));
    mockClassifyAgents.mockResolvedValue(makeClassifyResult());
    mockBuildBlueprint.mockResolvedValue({
      blueprint: {
        agents: agents2,
        jobs: [
          {
            id: "job-1",
            steps: [
              {
                id: "step-1",
                agentId: "a1",
                executionRef: "research",
                description: "Research",
                depends_on: [],
                executionType: "bundled",
              },
            ],
            documentContracts: [],
          },
        ],
      },
      clarifications: [],
      credentials: { bindings: [] as CredentialBinding[], unresolved: [] },
    });
    mockGenerateFriendlyDescriptions.mockResolvedValue(["Researching..."]);
    mockBuildFSMFromPlan.mockReturnValue({
      success: true,
      value: {
        fsm: {
          id: "test-fsm",
          initial: "idle",
          states: { idle: {}, completed: { type: "final" } },
        },
        warnings: [],
      },
    });
    mockExecuteTaskViaFSMDirect.mockResolvedValue(makeExecResult());

    const execute2 = getExecute();
    await execute2({ intent: "multi-agent task" });

    const infoCall2 = mockLogger.info.mock.calls.find(
      (c: unknown[]) => c[0] === "do_task completed",
    );
    expect(infoCall2).toBeDefined();
    expect(infoCall2?.[1]).toMatchObject({ fastpath: false });
  });

  it("generatePlan raw error returns { success: false } with error message", async () => {
    mockGeneratePlan.mockRejectedValue(new Error("LLM unavailable"));

    const execute = getExecute();
    const result = await execute({ intent: "should fail planning" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("LLM unavailable");
    expect(mockExecuteTaskViaFSMDirect).not.toHaveBeenCalled();
    expect(mockBuildBlueprint).not.toHaveBeenCalled();
  });

  it("checkEnvironmentReadiness failure returns { success: false } without calling executor", async () => {
    const agent = makeAgent({
      bundledId: "research",
      mcpServers: [{ serverId: "some-service", name: "SomeService" }],
    });
    mockGeneratePlan.mockResolvedValue(makePlanResult([agent]));
    mockClassifyAgents.mockResolvedValue(
      makeClassifyResult({
        configRequirements: [
          {
            agentId: "test-agent",
            integration: { type: "mcp" },
            requiredConfig: [{ key: "API_KEY", source: "link", provider: "some-provider" }],
          },
        ],
      }),
    );
    // Credentials resolve successfully...
    mockResolveCredentials.mockResolvedValue({
      bindings: [{ agentId: "test-agent", field: "API_KEY", value: "tok-123" }],
      unresolved: [],
    });
    // ...but environment readiness fails
    mockCheckEnvironmentReadiness.mockReturnValue({
      ready: false,
      checks: [{ checks: [{ status: "missing", key: "API_KEY" }] }],
    });

    const execute = getExecute();
    const result = await execute({ intent: "should fail readiness" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("API_KEY");
    expect(mockExecuteTaskViaFSMDirect).not.toHaveBeenCalled();
    expect(mockBuildBlueprint).not.toHaveBeenCalled();
  });

  it("PipelineError from buildBlueprint returns phase name in error", async () => {
    const agents = [
      makeAgent({ id: "a1", name: "Agent A", bundledId: "research" }),
      makeAgent({ id: "a2", name: "Agent B", bundledId: "email" }),
    ];
    mockGeneratePlan.mockResolvedValue(makePlanResult(agents));
    mockClassifyAgents.mockResolvedValue(makeClassifyResult());
    mockBuildBlueprint.mockRejectedValue(
      new PipelineError("dag", new Error("DAG generation failed")),
    );

    const execute = getExecute();
    const result = await execute({ intent: "multi-agent should fail" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("dag");
    expect(result.error).toContain("DAG generation failed");
    expect(mockExecuteTaskViaFSMDirect).not.toHaveBeenCalled();
  });

  it("classifyAgents receives dynamic servers from plan result", async () => {
    const dynamicServer = {
      id: "custom-crm",
      name: "Custom CRM",
      description: "A dynamic CRM server",
      configTemplate: { transport: { type: "stdio", command: "npx", args: [] }, env: {} },
    };

    const agent = makeAgent({ bundledId: "research" });
    mockGeneratePlan.mockResolvedValue(makePlanResult([agent], [dynamicServer]));
    mockClassifyAgents.mockReturnValue(makeClassifyResult());
    mockExecuteTaskViaFSMDirect.mockResolvedValue(makeExecResult());

    const execute = getExecute();
    await execute({ intent: "use dynamic tool" });

    expect(mockClassifyAgents).toHaveBeenCalledOnce();
    const [, opts] = mockClassifyAgents.mock.calls[0] as [unknown, { dynamicServers: unknown[] }];
    expect(opts).toHaveProperty("dynamicServers");
    expect(opts.dynamicServers).toEqual([dynamicServer]);
  });

  it("fastpath passes dynamic servers as mcpServerConfigs to executor", async () => {
    const dynamicServer = {
      id: "custom-crm",
      name: "Custom CRM",
      securityRating: "unverified",
      source: "web",
      configTemplate: {
        transport: { type: "stdio", command: "npx", args: ["-y", "crm-mcp"] },
        env: { CRM_KEY: "placeholder" },
      },
    };

    const agent = makeAgent({
      bundledId: undefined,
      name: "CRM Agent",
      mcpServers: [{ serverId: "custom-crm", name: "CRM" }],
    });
    mockGeneratePlan.mockResolvedValue(makePlanResult([agent], [dynamicServer]));
    mockClassifyAgents.mockResolvedValue(makeClassifyResult());
    mockExecuteTaskViaFSMDirect.mockResolvedValue(makeExecResult());

    const execute = getExecute();
    await execute({ intent: "update CRM contact" });

    expect(mockExecuteTaskViaFSMDirect).toHaveBeenCalledOnce();

    // mcpServerConfigs passed to executor with dynamic server
    const ctxArg = mockExecuteTaskViaFSMDirect.mock.calls[0]?.[2] as Record<string, unknown>;
    const configMap = ctxArg.mcpServerConfigs as Record<string, unknown>;
    expect(configMap).toHaveProperty("custom-crm");
    expect(configMap["custom-crm"]).toMatchObject({
      transport: { type: "stdio", command: "npx", args: ["-y", "crm-mcp"] },
    });
  });

  it("pre-aborted signal returns cancelled without calling generatePlan", async () => {
    const controller = new AbortController();
    controller.abort();

    const execute = getExecute(controller.signal);
    const result = await execute({ intent: "should not run" });

    expect(result).toEqual({ success: false, error: "Task cancelled" });
    expect(mockGeneratePlan).not.toHaveBeenCalled();
    expect(mockExecuteTaskViaFSMDirect).not.toHaveBeenCalled();
  });
});
