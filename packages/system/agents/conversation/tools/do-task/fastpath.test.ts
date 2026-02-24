import type { Agent, AgentClarification, DAGStep } from "@atlas/workspace-builder";
import { stateName } from "@atlas/workspace-builder";
import { describe, expect, test } from "vitest";
import {
  buildFastpathContract,
  buildFastpathDAGStep,
  buildFastpathFSM,
  buildFastpathStep,
  isFastpathEligible,
} from "./fastpath.ts";
import type { DatetimeContext } from "./types.ts";

/**
 * Minimal Agent fixture factory. Only populates fields the gate inspects.
 */
function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "test-agent",
    name: "Test Agent",
    description: "A test agent",
    capabilities: ["testing"],
    ...overrides,
  };
}

const noClarifications: AgentClarification[] = [];

describe("isFastpathEligible", () => {
  const cases = [
    {
      name: "single bundled agent",
      plan: { agents: [makeAgent({ bundledId: "research" })] },
      classifyResult: { clarifications: noClarifications },
      expected: true,
    },
    {
      name: "single LLM agent with MCP servers",
      plan: { agents: [makeAgent({ mcpServers: [{ serverId: "google-gmail", name: "Gmail" }] })] },
      classifyResult: { clarifications: noClarifications },
      expected: true,
    },
    {
      name: "multi-agent plan",
      plan: {
        agents: [
          makeAgent({ id: "a1", bundledId: "research" }),
          makeAgent({ id: "a2", bundledId: "email" }),
        ],
      },
      classifyResult: { clarifications: noClarifications },
      expected: false,
    },
    {
      name: "plan with clarifications",
      plan: { agents: [makeAgent({ bundledId: "research" })] },
      classifyResult: {
        clarifications: [
          {
            agentId: "test-agent",
            agentName: "Test Agent",
            capability: "something",
            issue: { type: "unknown-capability" as const, capabilityId: "something" },
          },
        ],
      },
      expected: false,
    },
    {
      name: "single agent with neither bundledId nor mcpServers",
      plan: { agents: [makeAgent()] },
      classifyResult: { clarifications: noClarifications },
      expected: false,
    },
    {
      name: "single agent with empty mcpServers array",
      plan: { agents: [makeAgent({ mcpServers: [] })] },
      classifyResult: { clarifications: noClarifications },
      expected: false,
    },
    {
      name: "single agent with empty capabilities (built-in tools only)",
      plan: { agents: [makeAgent({ capabilities: [] })] },
      classifyResult: { clarifications: noClarifications },
      expected: true,
    },
  ];

  test.each(cases)("$name → $expected", ({ plan, classifyResult, expected }) => {
    expect(isFastpathEligible(plan, classifyResult)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// buildFastpathDAGStep
// ---------------------------------------------------------------------------

describe("buildFastpathDAGStep", () => {
  test("bundled agent uses agent.id for agentId (planner identity)", () => {
    const agent = makeAgent({ name: "Research", bundledId: "research" });
    const result = buildFastpathDAGStep(agent, "find me some info");

    expect(result).toEqual({
      id: "Research-step",
      agentId: "test-agent",
      description: "find me some info",
      depends_on: [],
    });
  });

  test("LLM agent uses agent.id for agentId (planner identity)", () => {
    const agent = makeAgent({
      id: "gmail-helper",
      name: "Gmail Helper",
      mcpServers: [{ serverId: "google-gmail", name: "Gmail" }],
    });
    const result = buildFastpathDAGStep(agent, "check my email");

    expect(result).toEqual({
      id: "Gmail-Helper-step",
      agentId: "gmail-helper",
      description: "check my email",
      depends_on: [],
    });
  });
});

// ---------------------------------------------------------------------------
// buildFastpathStep
// ---------------------------------------------------------------------------

describe("buildFastpathStep", () => {
  test("bundled agent: agentId is planner identity, executionRef is bundledId", () => {
    const agent = makeAgent({
      name: "Research",
      bundledId: "research",
      description: "A research agent",
      capabilities: ["web-search"],
    });
    const result = buildFastpathStep(agent, "find me some info");

    expect(result).toMatchObject({
      agentId: "test-agent",
      executionRef: "research",
      description: "find me some info",
      executionType: "agent",
      capabilities: ["web-search"],
      friendlyDescription: "A research agent",
    });
  });

  test("LLM agent: agentId is planner identity, executionRef falls back to agent.id", () => {
    const agent = makeAgent({
      id: "gmail-helper",
      name: "Gmail Helper",
      description: "Manages email",
      capabilities: ["email"],
      mcpServers: [{ serverId: "google-gmail", name: "Gmail" }],
    });
    const result = buildFastpathStep(agent, "check my email");

    expect(result).toMatchObject({
      agentId: "gmail-helper",
      executionRef: "gmail-helper",
      description: "check my email",
      executionType: "llm",
      capabilities: ["email"],
      friendlyDescription: "Manages email",
    });
  });
});

// ---------------------------------------------------------------------------
// buildFastpathContract
// ---------------------------------------------------------------------------

describe("buildFastpathContract", () => {
  test("produces contract with matching producerStepId and documentId 'result'", () => {
    const dagStep: DAGStep = {
      id: "Research-step",
      agentId: "test-agent",
      description: "find info",
      depends_on: [],
    };
    const result = buildFastpathContract(dagStep);

    expect(result).toMatchObject({
      producerStepId: "Research-step",
      documentId: "result",
      documentType: "result",
    });
    expect(result.schema).toEqual({ type: "object" });
  });
});

// ---------------------------------------------------------------------------
// buildFastpathFSM
// ---------------------------------------------------------------------------

describe("buildFastpathFSM", () => {
  test("bundled agent FSM has 3 states with agent action", () => {
    const agent = makeAgent({ name: "Research", bundledId: "research" });
    const dagStep: DAGStep = {
      id: "Research-step",
      agentId: "test-agent",
      description: "find info",
      depends_on: [],
    };
    const fsm = buildFastpathFSM(agent, dagStep, "find me some info");
    const stepState = stateName(dagStep.id);

    expect(fsm.id).toMatch(/^task-fastpath-/);
    expect(fsm.initial).toBe("idle");
    expect(Object.keys(fsm.states)).toHaveLength(3);
    expect(fsm.states).toHaveProperty("idle");
    expect(fsm.states).toHaveProperty(stepState);
    expect(fsm.states).toHaveProperty("completed");

    // idle transitions to step state
    expect(fsm.states.idle?.on?.["adhoc-trigger"]).toMatchObject({ target: stepState });

    // step state has agent action with outputTo: "result"
    const entry = fsm.states[stepState]?.entry;
    expect(entry).toHaveLength(2);
    expect(entry?.[0]).toMatchObject({
      type: "agent",
      agentId: "research",
      outputTo: "result",
      prompt: "find me some info",
    });
    expect(entry?.[1]).toMatchObject({ type: "emit", event: "ADVANCE" });

    // step transitions to completed
    expect(fsm.states[stepState]?.on?.ADVANCE).toMatchObject({ target: "completed" });

    // completed is final
    expect(fsm.states.completed?.type).toBe("final");
  });

  test("LLM agent FSM has 3 states with llm action and MCP tools", () => {
    const agent = makeAgent({
      id: "gmail-helper",
      name: "Gmail Helper",
      mcpServers: [
        { serverId: "google-gmail", name: "Gmail" },
        { serverId: "google-calendar", name: "Calendar" },
      ],
    });
    const dagStep: DAGStep = {
      id: "Gmail-Helper-step",
      agentId: "gmail-helper",
      description: "check email",
      depends_on: [],
    };
    const fsm = buildFastpathFSM(agent, dagStep, "check my email");
    const stepState = stateName(dagStep.id);

    expect(Object.keys(fsm.states)).toHaveLength(3);

    // step state has llm action with provider, model, tools, and outputTo
    const entry = fsm.states[stepState]?.entry;
    expect(entry).toHaveLength(2);
    expect(entry?.[0]).toMatchObject({
      type: "llm",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      prompt: "Task: check my email",
      tools: ["google-gmail", "google-calendar"],
      outputTo: "result",
    });
    expect(entry?.[1]).toMatchObject({ type: "emit", event: "ADVANCE" });
  });

  const datetime: DatetimeContext = {
    timezone: "America/New_York",
    timestamp: "2026-02-19T12:00:00Z",
    localDate: "2026-02-19",
    localTime: "07:00:00",
    timezoneOffset: "-05:00",
  };

  test("bundled agent prompt is raw intent — no datetime injection", () => {
    const agent = makeAgent({ name: "Research", bundledId: "research" });
    const dagStep = buildFastpathDAGStep(agent, "find me some info");
    const fsm = buildFastpathFSM(agent, dagStep, "find me some info", datetime);
    const stepState = stateName(dagStep.id);
    const entry = fsm.states[stepState]?.entry;

    // Executor handles datetime + "Task:" framing for bundled agents
    expect(entry?.[0]).toHaveProperty("prompt", "find me some info");
  });

  test("LLM agent prompt includes datetime context", () => {
    const agent = makeAgent({
      name: "Gmail Helper",
      mcpServers: [{ serverId: "google-gmail", name: "Gmail" }],
    });
    const dagStep = buildFastpathDAGStep(agent, "check my email");
    const fsm = buildFastpathFSM(agent, dagStep, "check my email", datetime);
    const stepState = stateName(dagStep.id);
    const entry = fsm.states[stepState]?.entry;

    expect(entry?.[0]).toMatchObject({
      type: "llm",
      prompt: expect.stringContaining("## Context Facts"),
    });
    expect(entry?.[0]).toMatchObject({ prompt: expect.stringContaining("Task: check my email") });
  });

  test("empty-capabilities agent produces LLM action with empty tools", () => {
    const agent = makeAgent({ name: "General", capabilities: [] });
    const dagStep = buildFastpathDAGStep(agent, "do something simple");
    const fsm = buildFastpathFSM(agent, dagStep, "do something simple");
    const stepState = stateName(dagStep.id);

    expect(Object.keys(fsm.states)).toHaveLength(3);

    const entry = fsm.states[stepState]?.entry;
    expect(entry).toHaveLength(2);
    expect(entry?.[0]).toMatchObject({
      type: "llm",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      prompt: "Task: do something simple",
      tools: [],
      outputTo: "result",
    });
    expect(entry?.[1]).toMatchObject({ type: "emit", event: "ADVANCE" });
  });

  test("outputTo is always 'result' for both agent types", () => {
    const bundledAgent = makeAgent({ name: "Research", bundledId: "research" });
    const bundledDag: DAGStep = {
      id: "Research-step",
      agentId: "test-agent",
      description: "find info",
      depends_on: [],
    };
    const bundledFSM = buildFastpathFSM(bundledAgent, bundledDag, "find info");
    const bundledEntry = bundledFSM.states[stateName(bundledDag.id)]?.entry;
    expect(bundledEntry?.[0]).toHaveProperty("outputTo", "result");

    const llmAgent = makeAgent({
      id: "gmail-agent",
      name: "Gmail",
      mcpServers: [{ serverId: "google-gmail", name: "Gmail" }],
    });
    const llmDag: DAGStep = {
      id: "Gmail-step",
      agentId: "gmail-agent",
      description: "check email",
      depends_on: [],
    };
    const llmFSM = buildFastpathFSM(llmAgent, llmDag, "check email");
    const llmEntry = llmFSM.states[stateName(llmDag.id)]?.entry;
    expect(llmEntry?.[0]).toHaveProperty("outputTo", "result");
  });
});
