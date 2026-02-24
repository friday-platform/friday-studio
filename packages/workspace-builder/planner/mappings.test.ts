import { describe, expect, it, vi } from "vitest";
import type { Agent, ClassifiedDAGStep, JobWithDAG, Signal, WorkspaceBlueprint } from "../types.ts";
import { SIGNAL_DOCUMENT_ID } from "../types.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks — must come before module imports
// ---------------------------------------------------------------------------

const mockRegistry = vi.hoisted(() =>
  vi.fn((): Record<string, { inputJsonSchema?: Record<string, unknown> }> => ({})),
);
vi.mock("@atlas/bundled-agents/registry", () => ({
  get bundledAgentsRegistry() {
    return mockRegistry();
  },
}));

import {
  buildMappingPrompt,
  generatePrepareMappings,
  resolveConsumerInputSchema,
} from "./mappings.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(
  overrides: Partial<JobWithDAG["steps"][number]> & { id: string; agentId: string },
): JobWithDAG["steps"][number] {
  return {
    id: overrides.id,
    agentId: overrides.agentId,
    description: overrides.description ?? `Step ${overrides.id}`,
    depends_on: overrides.depends_on ?? [],
  };
}

function makeJob(steps: JobWithDAG["steps"], overrides?: Partial<JobWithDAG>): JobWithDAG {
  return {
    id: "test-job",
    name: "Test Job",
    title: "Test",
    triggerSignalId: "test-signal",
    steps,
    documentContracts: [],
    prepareMappings: [],
    ...overrides,
  };
}

function makeSignal(overrides: Partial<Signal> & { id: string }): Signal {
  return {
    id: overrides.id,
    name: overrides.name ?? "Test Signal",
    title: overrides.title ?? "Test signal",
    signalType: overrides.signalType ?? "http",
    description: overrides.description ?? `Signal ${overrides.id}`,
    payloadSchema: overrides.payloadSchema,
  };
}

function makeBlueprint(overrides: {
  signals?: Signal[];
  agents?: Agent[];
  jobs?: JobWithDAG[];
}): WorkspaceBlueprint {
  return {
    workspace: { name: "test-workspace", purpose: "Testing" },
    signals: overrides.signals ?? [],
    agents: overrides.agents ?? [],
    jobs: (overrides.jobs ?? []) as WorkspaceBlueprint["jobs"],
  };
}

function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    id: overrides.id,
    name: overrides.name ?? "Test Agent",
    description: overrides.description ?? `Agent ${overrides.id}`,
    capabilities: overrides.capabilities ?? [],
    configuration: overrides.configuration,
  };
}

function makeClassifiedStep(
  overrides: Partial<ClassifiedDAGStep> & { id: string; agentId: string },
): ClassifiedDAGStep {
  return {
    description: overrides.description ?? `Step ${overrides.id}`,
    depends_on: overrides.depends_on ?? [],
    executionType: overrides.executionType ?? "llm",
    executionRef: overrides.executionRef ?? overrides.agentId,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildMappingPrompt — new accumulating tool workflow
// ---------------------------------------------------------------------------

describe("buildMappingPrompt", () => {
  const upstream = makeStep({ id: "fetch", agentId: "fetcher", description: "Fetch data" });
  const consumer = makeStep({
    id: "analyze",
    agentId: "analyzer",
    description: "Analyze data",
    depends_on: ["fetch"],
  });
  const job = makeJob([upstream, consumer]);
  const agents = [
    makeAgent({ id: "fetcher" }),
    makeAgent({ id: "analyzer", name: "Analyzer Agent", description: "Analyzes things" }),
  ];

  it("references addSourceMapping, addConstant, and finalize tools", () => {
    const prompt = buildMappingPrompt(consumer, upstream, job, agents);

    expect(prompt).toContain("addSourceMapping");
    expect(prompt).toContain("addConstant");
    expect(prompt).toContain("finalize");
  });

  it("references addTransformMapping tool", () => {
    const prompt = buildMappingPrompt(consumer, upstream, job, agents);

    expect(prompt).toContain("addTransformMapping");
  });

  it("does not reference removed tools: complete, validateFieldPath", () => {
    const prompt = buildMappingPrompt(consumer, upstream, job, agents);

    expect(prompt).not.toContain("validateFieldPath");
    expect(prompt).not.toContain("`complete`");
  });

  it("includes workflow: lookupSchema then add mappings then finalize", () => {
    const prompt = buildMappingPrompt(consumer, upstream, job, agents);

    expect(prompt).toContain("lookupOutputSchema");
    // Workflow steps should mention lookup first, then add, then finalize
    const lookupIdx = prompt.indexOf("lookupOutputSchema");
    const addIdx = prompt.indexOf("addSourceMapping");
    const finalizeIdx = prompt.indexOf("finalize");
    expect(lookupIdx).toBeLessThan(addIdx);
    expect(addIdx).toBeLessThan(finalizeIdx);
  });

  it("includes schema fidelity rule about only accessing existing fields", () => {
    const prompt = buildMappingPrompt(consumer, upstream, job, agents);

    expect(prompt).toContain("Schema Fidelity Rule");
    expect(prompt).toContain("MUST only access properties that exist in the source schema");
    expect(prompt).toContain("Do NOT assume or invent fields");
  });

  it("includes transform guidance about agent responsibility boundary", () => {
    const prompt = buildMappingPrompt(consumer, upstream, job, agents);

    expect(prompt).toContain("structural wiring");
    expect(prompt).toContain("step description");
  });

  it("includes consumer agent context block", () => {
    const prompt = buildMappingPrompt(consumer, upstream, job, agents);

    expect(prompt).toContain("Analyzer Agent");
    expect(prompt).toContain("Analyzes things");
  });

  it("includes fan-in context when multiple upstream dependencies", () => {
    const fetchA = makeStep({ id: "fetch-a", agentId: "fetcher-a", description: "Fetch A" });
    const fetchB = makeStep({ id: "fetch-b", agentId: "fetcher-b", description: "Fetch B" });
    const fanInStep = makeStep({
      id: "merge",
      agentId: "merger",
      description: "Merge data",
      depends_on: ["fetch-a", "fetch-b"],
    });
    const fanInJob = makeJob([fetchA, fetchB, fanInStep]);
    const fanInAgents = [
      makeAgent({ id: "fetcher-a" }),
      makeAgent({ id: "fetcher-b" }),
      makeAgent({ id: "merger" }),
    ];

    const prompt = buildMappingPrompt(fanInStep, fetchA, fanInJob, fanInAgents);

    expect(prompt).toContain("fans-in");
    expect(prompt).toContain("fetch-a");
    expect(prompt).toContain("fetch-b");
    expect(prompt).toContain("ONLY");
  });

  it("includes agent configuration as constants requirement", () => {
    const configAgents = [
      makeAgent({ id: "fetcher" }),
      makeAgent({
        id: "analyzer",
        name: "Analyzer",
        configuration: { model: "gpt-4", temperature: 0.5 },
      }),
    ];

    const prompt = buildMappingPrompt(consumer, upstream, job, configAgents);

    expect(prompt).toContain("constant");
    expect(prompt).toContain("model");
  });
});

// ---------------------------------------------------------------------------
// generatePrepareMappings — signal → root step mappings
// ---------------------------------------------------------------------------

describe("generatePrepareMappings — signal mappings", () => {
  it("generates signal mapping for root step with payload schema", async () => {
    const rootStep = makeStep({ id: "process", agentId: "processor" });
    const job = makeJob([rootStep]);
    const signal = makeSignal({
      id: "test-signal",
      payloadSchema: {
        type: "object",
        properties: { name: { type: "string" }, count: { type: "integer" } },
        required: ["name", "count"],
      },
    });
    const blueprint = makeBlueprint({ signals: [signal], jobs: [job] });

    const result = await generatePrepareMappings(job, blueprint, new Map());

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      consumerStepId: "process",
      documentId: SIGNAL_DOCUMENT_ID,
      documentType: "trigger-signal",
      sources: [
        { from: "name", to: "name" },
        { from: "count", to: "count" },
      ],
      constants: [],
    });
  });

  it("skips signal mapping when signal has no payload schema", async () => {
    const rootStep = makeStep({ id: "process", agentId: "processor" });
    const job = makeJob([rootStep]);
    const signal = makeSignal({ id: "test-signal" });
    const blueprint = makeBlueprint({ signals: [signal], jobs: [job] });

    const result = await generatePrepareMappings(job, blueprint, new Map());

    expect(result).toHaveLength(0);
  });

  it("skips signal mapping when payload schema has no properties", async () => {
    const rootStep = makeStep({ id: "process", agentId: "processor" });
    const job = makeJob([rootStep]);
    const signal = makeSignal({ id: "test-signal", payloadSchema: { type: "object" } });
    const blueprint = makeBlueprint({ signals: [signal], jobs: [job] });

    const result = await generatePrepareMappings(job, blueprint, new Map());

    expect(result).toHaveLength(0);
  });

  it("generates signal mapping for each root step in multi-root job", async () => {
    const rootA = makeStep({ id: "fetch-a", agentId: "fetcher" });
    const rootB = makeStep({ id: "fetch-b", agentId: "fetcher" });
    const job = makeJob([rootA, rootB]);
    const signal = makeSignal({
      id: "test-signal",
      payloadSchema: { type: "object", properties: { query: { type: "string" } } },
    });
    const blueprint = makeBlueprint({ signals: [signal], jobs: [job] });

    const result = await generatePrepareMappings(job, blueprint, new Map());

    expect(result).toHaveLength(2);
    expect(result.map((m) => m.consumerStepId)).toEqual(["fetch-a", "fetch-b"]);
    expect(result.every((m) => m.documentId === SIGNAL_DOCUMENT_ID)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveConsumerInputSchema — registry lookup via executionRef
// ---------------------------------------------------------------------------

describe("resolveConsumerInputSchema", () => {
  it("looks up bundled agent input schema via executionRef, not agentId", () => {
    const inputSchema = {
      type: "object" as const,
      properties: { query: { type: "string" } },
      required: ["query"],
    };
    mockRegistry.mockReturnValue({ email: { inputJsonSchema: inputSchema } });

    // agentId is the planner ID ("send-notification"), executionRef is the bundled key ("email")
    const step = makeClassifiedStep({
      id: "notify",
      agentId: "send-notification",
      executionType: "bundled",
      executionRef: "email",
    });
    const job = makeJob([step] as JobWithDAG["steps"]);
    const blueprint = makeBlueprint({ jobs: [job] });

    const result = resolveConsumerInputSchema(blueprint, "notify");

    expect(result).toBeDefined();
    expect(result).toMatchObject({ properties: { query: { type: "string" } } });
  });

  it("returns undefined when step is an LLM agent (no registry entry)", () => {
    mockRegistry.mockReturnValue({});

    const step = makeClassifiedStep({
      id: "analyze",
      agentId: "data-cruncher",
      executionType: "llm",
      executionRef: "data-cruncher",
    });
    const job = makeJob([step] as JobWithDAG["steps"]);
    const blueprint = makeBlueprint({ jobs: [job] });

    const result = resolveConsumerInputSchema(blueprint, "analyze");

    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildMappingPrompt — bundled agent with divergent planner ID (bug #3 verification)
// ---------------------------------------------------------------------------

describe("buildMappingPrompt — bundled agent identity", () => {
  it("includes consumer agent description when agentId is a planner ID", () => {
    // Bug #3: Before the stamp fix, agentId was the bundled ID (e.g., "email")
    // which didn't match the agents array (keyed by planner ID). Now agentId
    // is preserved as the planner ID, so the lookup works.
    const upstream = makeStep({ id: "fetch", agentId: "fetcher", description: "Fetch data" });
    const consumer = makeStep({
      id: "notify",
      agentId: "send-notification",
      description: "Send email notification",
      depends_on: ["fetch"],
    });
    const job = makeJob([upstream, consumer]);
    const agents = [
      makeAgent({ id: "fetcher", name: "Data Fetcher", description: "Fetches data" }),
      makeAgent({
        id: "send-notification",
        name: "Email Notifier",
        description: "Sends email notifications to stakeholders",
      }),
    ];

    const prompt = buildMappingPrompt(consumer, upstream, job, agents);

    expect(prompt).toContain("Email Notifier");
    expect(prompt).toContain("Sends email notifications to stakeholders");
  });
});
