import process from "node:process";
import { bundledAgentsRegistry } from "@atlas/bundled-agents/registry";
import { describe, expect, it } from "vitest";
import {
  buildFSMGenerationPrompt,
  enrichAgentsWithPipelineContext,
  flattenAgent,
} from "./agent-helpers.ts";
import type { ClassifiedAgent, Job, Signal, SimplifiedAgent } from "./types.ts";

describe("buildFSMGenerationPrompt", () => {
  it("includes trigger signal description (user intent) in the prompt", () => {
    const job: Job = {
      id: "test-job",
      name: "Weather Email Job",
      title: "Weather Email",
      triggerSignalId: "send-weather-forecast",
      behavior: "sequential",
      steps: [
        { agentId: "weather-agent", description: "Fetch weather data" },
        { agentId: "email", description: "Send weather email" },
      ],
    };

    const agents = [
      {
        id: "weather-agent",
        name: "Weather Agent",
        description: "Fetches weather data",
        config: {},
        executionType: "bundled" as const,
        bundledAgentId: "weather-fetcher",
      },
      {
        id: "email",
        name: "Email Agent",
        description: "Sends emails",
        config: {},
        executionType: "bundled" as const,
        bundledAgentId: "email",
      },
    ];

    const triggerSignal: Signal = {
      id: "send-weather-forecast",
      name: "Send Weather Forecast",

      title: "Sends weather forecast email",

      signalType: "schedule",

      description:
        "Send weather forecast email. Forecast: Saturday Jan 4 will be sunny with 72°F high. Sunday Jan 5 will be cloudy with 65°F high and 40% chance of rain. Send to user@example.com",
    };

    const prompt = buildFSMGenerationPrompt(job, agents, triggerSignal);

    // The fix: prompt should include User Intent with the description
    expect(prompt).toContain("User Intent:");
    expect(prompt).toContain(triggerSignal.description);
    expect(prompt).toContain("sunny with 72°F high");
    expect(prompt).toContain("user@example.com");

    // Should also include the critical instruction about extracting actual data
    expect(prompt).toContain("CRITICAL");
    expect(prompt).toContain("extract and use the ACTUAL data");
  });

  it("includes signal ID in the prompt", () => {
    const job: Job = {
      id: "test-job",
      name: "Test Job",
      title: "Test Job",
      triggerSignalId: "my-trigger-signal",
      behavior: "sequential",
      steps: [],
    };

    const triggerSignal: Signal = {
      id: "my-trigger-signal",
      name: "My Trigger Signal",

      title: "Triggers test",

      signalType: "http",

      description: "Test description",
    };

    const prompt = buildFSMGenerationPrompt(job, [], triggerSignal);

    expect(prompt).toContain("Trigger Signal: my-trigger-signal");
    expect(prompt).toContain("User Intent: Test description");
  });

  it("includes output schema and instruction when bundled agent has outputSchema", () => {
    const job: Job = {
      id: "research-job",
      name: "Research Job",
      title: "Research",
      triggerSignalId: "start-research",
      behavior: "sequential",
      steps: [{ agentId: "researcher", description: "Run research" }],
    };

    const agents: SimplifiedAgent[] = [
      {
        id: "researcher",
        name: "Research Agent",
        description: "Runs research",
        config: {},
        executionType: "bundled",
        bundledAgentId: "research",
        outputSchema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            data: {
              type: "object",
              properties: { summary: { type: "string" } },
              required: ["summary"],
            },
          },
          required: ["ok"],
        },
      },
    ];

    const triggerSignal: Signal = {
      id: "start-research",
      name: "Start Research",
      title: "Starts research",
      signalType: "http",
      description: "Start research task",
    };

    const prompt = buildFSMGenerationPrompt(job, agents, triggerSignal);

    expect(prompt).toContain("EXACTLY this shape");
    expect(prompt).toContain("do NOT invent fields");
  });

  it("does not include output schema block when agent has no outputSchema", () => {
    const job: Job = {
      id: "email-job",
      name: "Email Job",
      title: "Email",
      triggerSignalId: "send-email",
      behavior: "sequential",
      steps: [{ agentId: "email", description: "Send email" }],
    };

    const agents: SimplifiedAgent[] = [
      {
        id: "email",
        name: "Email Agent",
        description: "Sends emails",
        config: {},
        executionType: "bundled",
        bundledAgentId: "email",
      },
    ];

    const triggerSignal: Signal = {
      id: "send-email",
      name: "Send Email",
      title: "Sends email",
      signalType: "http",
      description: "Send email",
    };

    const prompt = buildFSMGenerationPrompt(job, agents, triggerSignal);

    expect(prompt).not.toContain("Output Schema");
    expect(prompt).not.toContain("EXACTLY this shape");
  });

  it("includes note about agent.description containing downstream requirements", () => {
    const job: Job = {
      id: "email-triage",
      name: "Email Triage Job",
      title: "Email Triage",
      triggerSignalId: "daily-email-check",
      behavior: "sequential",
      steps: [
        { agentId: "email-fetcher", description: "Fetch emails from inbox" },
        { agentId: "todo-extractor", description: "Extract TODOs from email content" },
      ],
    };

    const triggerSignal: Signal = {
      id: "daily-email-check",
      name: "Daily Email Check",

      title: "Triggers daily email check",

      signalType: "schedule",

      description: "Check emails daily",
    };

    const prompt = buildFSMGenerationPrompt(job, [], triggerSignal);

    // Should note that agent.description already contains downstream requirements
    expect(prompt).toContain("agent.description");
    expect(prompt).toContain("downstream");
  });

  it("instructs LLM to derive Result schemas from downstream Request schemas", () => {
    const job: Job = {
      id: "linear-automation",
      name: "Linear Ticket Automation",
      title: "Linear Ticket Automation",
      triggerSignalId: "manual-trigger",
      behavior: "sequential",
      steps: [
        { agentId: "linear-reader", description: "Fetch ticket details" },
        { agentId: "code-agent", description: "Implement changes" },
      ],
    };

    const triggerSignal: Signal = {
      id: "manual-trigger",
      name: "Manual Trigger",
      title: "Manual Trigger",
      signalType: "http",
      description: "Trigger automation",
    };

    const prompt = buildFSMGenerationPrompt(job, [], triggerSignal);

    // Critical instruction: use outputSchema when available, derive from downstream otherwise
    expect(prompt).toContain("Use the agent's outputSchema when available");
    expect(prompt).toContain("EXACTLY that shape");
    expect(prompt).toContain(
      "agents WITHOUT an outputSchema, derive the result schema from downstream needs",
    );
  });

  it("includes example showing Result schema derivation from downstream prepare function", () => {
    const job: Job = {
      id: "test-job",
      name: "Test Job",
      title: "Test Job",
      triggerSignalId: "test-trigger",
      behavior: "sequential",
      steps: [],
    };

    const triggerSignal: Signal = {
      id: "test-trigger",
      name: "Test Trigger",
      title: "Test Trigger",
      signalType: "http",
      description: "Test",
    };

    const prompt = buildFSMGenerationPrompt(job, [], triggerSignal);

    // Should include concrete example with ticket_id, ticket_title, ticket_description
    expect(prompt).toContain("ticket_id: ticketResult.data.ticket_id");
    expect(prompt).toContain("ticket_title: ticketResult.data.ticket_title");
    expect(prompt).toContain("ticket_description: ticketResult.data.ticket_description");

    // Should show the resulting schema with those fields
    expect(prompt).toContain("ticket_id: { type: 'string' }");
    expect(prompt).toContain("required: ['ticket_id', 'ticket_title', 'ticket_description']");
  });
});

const isCI = !!process.env.CI;

describe.skipIf(isCI)("enrichAgentsWithPipelineContext", () => {
  it("adds downstream context to first agent (TEM-3625 fix)", async () => {
    // This test verifies the fix for Ken's email triage bug where
    // step 0 fetched emails with format="metadata" instead of format="full"
    // because it didn't know step 1 needed full content to extract TODOs.

    const agents: SimplifiedAgent[] = [
      {
        id: "gmail-priority-monitor",
        name: "Gmail Priority Monitor",
        description: "Scan Gmail inbox for emails from priority senders using fuzzy matching",
        config: {},
        executionType: "llm",
        mcpTools: ["google-gmail"],
      },
      {
        id: "todo-extractor",
        name: "Todo Extractor",
        description: "Analyze email content to identify and extract work-related action items",
        config: {},
        executionType: "llm",
        mcpTools: [],
      },
    ];

    const jobSteps = [
      { agentId: "gmail-priority-monitor", description: "Fetch emails from priority senders" },
      { agentId: "todo-extractor", description: "Extract TODOs from email content" },
    ];

    const enriched = await enrichAgentsWithPipelineContext(agents, jobSteps);

    // First agent should have downstream data requirements (LLM-inferred)
    const gmailAgent = enriched.find((a) => a.id === "gmail-priority-monitor");
    if (!gmailAgent) throw new Error("Expected gmail agent");
    expect(gmailAgent.description).toContain("DOWNSTREAM DATA REQUIREMENTS");
    // The LLM should infer something about needing email content for TODO extraction

    // Last agent should NOT have downstream context (no downstream steps)
    const todoAgent = enriched.find((a) => a.id === "todo-extractor");
    if (!todoAgent) throw new Error("Expected todo agent");
    expect(todoAgent.description).toEqual(
      "Analyze email content to identify and extract work-related action items",
    );
  });

  it("preserves agent properties while enriching description", async () => {
    const agents: SimplifiedAgent[] = [
      {
        id: "agent-1",
        name: "Agent One",
        description: "Does something",
        config: { key: "value" },
        executionType: "llm",
        mcpTools: ["tool1", "tool2"],
      },
    ];

    const jobSteps = [
      { agentId: "agent-1", description: "Step 1" },
      { agentId: "agent-2", description: "Step 2" },
    ];

    const enriched = await enrichAgentsWithPipelineContext(agents, jobSteps);

    expect(enriched[0]).toMatchObject({
      id: "agent-1",
      name: "Agent One",
      config: { key: "value" },
      executionType: "llm",
      mcpTools: ["tool1", "tool2"],
    });
  });

  it("uses step description (not agent description) as base for enrichment", async () => {
    // This tests the critical mapping: bundled agents should receive the STEP's
    // task instructions (e.g., "Clone repo, use sub-agents...") not the AGENT's
    // capability summary (e.g., "Implements code changes").
    const agents: SimplifiedAgent[] = [
      {
        id: "code-agent",
        name: "Code Agent",
        description: "General capability: implements code changes", // agent.description
        config: {},
        executionType: "bundled",
        bundledAgentId: "claude-code",
      },
    ];

    const jobSteps = [
      { agentId: "code-agent", description: "Clone repo, implement feature X" }, // step.description
      { agentId: "reviewer", description: "Review the changes" },
    ];

    const enriched = await enrichAgentsWithPipelineContext(agents, jobSteps);

    const codeAgent = enriched.find((a) => a.id === "code-agent");
    if (!codeAgent) throw new Error("codeAgent should be defined");

    // Should start with STEP description, not agent description
    expect(codeAgent.description).toMatch(/^Clone repo, implement feature X/);
    expect(codeAgent.description).not.toMatch(/^General capability/);
    expect(codeAgent.description).toContain("DOWNSTREAM DATA REQUIREMENTS");
  });

  it("handles agent not in job steps gracefully", async () => {
    const agents: SimplifiedAgent[] = [
      {
        id: "unrelated-agent",
        name: "Unrelated Agent",
        description: "Not in this job",
        config: {},
        executionType: "bundled",
        bundledAgentId: "some-agent",
      },
    ];

    const jobSteps = [{ agentId: "other-agent", description: "Some step" }];

    const enriched = await enrichAgentsWithPipelineContext(agents, jobSteps);

    // Agent should be returned unchanged
    expect(enriched[0]).toMatchObject({ id: "unrelated-agent", description: "Not in this job" });
  });
});

describe("flattenAgent", () => {
  it("flattens bundled agent correctly", () => {
    const classified: ClassifiedAgent = {
      id: "test-agent",
      name: "Test Agent",
      description: "A test agent",
      config: { key: "value" },
      type: { kind: "bundled", bundledId: "actual-bundled-id", name: "Actual Bundled" },
    };

    expect(flattenAgent(classified)).toMatchObject({
      id: "test-agent",
      name: "Test Agent",
      executionType: "bundled",
      bundledAgentId: "actual-bundled-id",
    });
    expect(flattenAgent(classified).mcpTools).toBeUndefined();
  });

  it("populates outputSchema from bundled agent registry", () => {
    const classified: ClassifiedAgent = {
      id: "research-agent",
      name: "Research Agent",
      description: "Runs research",
      config: {},
      type: { kind: "bundled", bundledId: "research", name: "Research" },
    };

    const result = flattenAgent(classified);

    expect(result.outputSchema).toEqual(bundledAgentsRegistry["research"]?.outputJsonSchema);
  });

  it("does not populate outputSchema for bundled agents without one", () => {
    expect(bundledAgentsRegistry["nonexistent-agent"]).toBeUndefined();

    const classified: ClassifiedAgent = {
      id: "unknown-agent",
      name: "Unknown Agent",
      description: "An agent not in the registry",
      config: {},
      type: { kind: "bundled", bundledId: "nonexistent-agent", name: "Unknown" },
    };

    const result = flattenAgent(classified);

    expect(result.outputSchema).toBeUndefined();
  });

  it("flattens LLM agent correctly", () => {
    const classified: ClassifiedAgent = {
      id: "llm-agent",
      name: "LLM Agent",
      description: "An LLM agent",
      config: {},
      type: { kind: "llm", mcpTools: ["tool1", "tool2"] },
    };

    expect(flattenAgent(classified)).toMatchObject({
      executionType: "llm",
      mcpTools: ["tool1", "tool2"],
    });
    expect(flattenAgent(classified).bundledAgentId).toBeUndefined();
  });
});
