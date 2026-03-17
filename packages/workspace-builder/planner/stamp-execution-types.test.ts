import { describe, expect, it } from "vitest";
import type { Agent, DAGStep, JobWithDAG } from "../types.ts";
import { stampExecutionTypes } from "./stamp-execution-types.ts";

/** Minimal agent factory. */
function makeAgent(overrides: Partial<Agent> & Pick<Agent, "id" | "capabilities">): Agent {
  return {
    name: overrides.name ?? "Test Agent",
    description: overrides.description ?? "test",
    ...overrides,
  };
}

/** Minimal step factory. */
function makeStep(overrides: Partial<DAGStep> & Pick<DAGStep, "agentId">): DAGStep {
  return {
    id: overrides.id ?? "step-1",
    description: overrides.description ?? "do something",
    depends_on: overrides.depends_on ?? [],
    ...overrides,
  };
}

/** Minimal job factory wrapping steps. */
function makeJob(steps: DAGStep[], overrides?: Partial<JobWithDAG>): JobWithDAG {
  return {
    id: overrides?.id ?? "job-1",
    name: overrides?.name ?? "Test Job",
    title: overrides?.title ?? "Test",
    triggerSignalId: overrides?.triggerSignalId ?? "sig-1",
    steps,
    documentContracts: overrides?.documentContracts ?? [],
    prepareMappings: overrides?.prepareMappings ?? [],
  };
}

describe("stampExecutionTypes", () => {
  it("preserves agentId and sets executionRef for bundled agents", () => {
    const agents = [
      makeAgent({ id: "planner-note-agent", capabilities: ["email"], bundledId: "email" }),
    ];
    const jobs = [makeJob([makeStep({ agentId: "planner-note-agent" })])];

    const [result] = stampExecutionTypes(jobs, agents);
    if (!result) throw new Error("expected result");
    const step = result.steps[0];
    if (!step) throw new Error("expected step");

    expect(step.agentId).toBe("planner-note-agent");
    expect(step.executionRef).toBe("planner-note-agent");
    expect(step.executionType).toBe("bundled");
  });

  it("sets executionRef to agentId and populates tools for LLM agents with MCP servers", () => {
    const agents = [
      makeAgent({
        id: "gh-bot",
        capabilities: ["github"],
        mcpServers: [{ serverId: "github", name: "GitHub" }],
      }),
    ];
    const jobs = [makeJob([makeStep({ agentId: "gh-bot" })])];

    const [result] = stampExecutionTypes(jobs, agents);
    if (!result) throw new Error("expected result");
    const step = result.steps[0];
    if (!step) throw new Error("expected step");

    expect(step.agentId).toBe("gh-bot");
    expect(step.executionRef).toBe("gh-bot");
    expect(step.executionType).toBe("llm");
    expect(step.tools).toEqual(["github"]);
  });

  it("falls through as LLM with executionRef = agentId for unmatched agents", () => {
    const agents: Agent[] = [];
    const jobs = [makeJob([makeStep({ agentId: "unknown-agent" })])];

    const [result] = stampExecutionTypes(jobs, agents);
    if (!result) throw new Error("expected result");
    const step = result.steps[0];
    if (!step) throw new Error("expected step");

    expect(step.agentId).toBe("unknown-agent");
    expect(step.executionRef).toBe("unknown-agent");
    expect(step.executionType).toBe("llm");
    expect(step.tools).toBeUndefined();
  });

  it("stamps steps across multiple jobs independently", () => {
    const agents = [
      makeAgent({ id: "planner-email", capabilities: ["email"], bundledId: "email" }),
      makeAgent({
        id: "gh-bot",
        capabilities: ["github"],
        mcpServers: [{ serverId: "github", name: "GitHub" }],
      }),
    ];
    const jobs = [
      makeJob([makeStep({ id: "s1", agentId: "planner-email" })], { id: "job-a" }),
      makeJob([makeStep({ id: "s2", agentId: "gh-bot" })], { id: "job-b" }),
    ];

    const result = stampExecutionTypes(jobs, agents);

    expect(result[0]?.steps[0]).toMatchObject({
      agentId: "planner-email",
      executionRef: "planner-email",
      executionType: "bundled",
    });
    expect(result[1]?.steps[0]).toMatchObject({
      agentId: "gh-bot",
      executionRef: "gh-bot",
      executionType: "llm",
      tools: ["github"],
    });
  });
});
