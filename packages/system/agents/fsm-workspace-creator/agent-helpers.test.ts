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
});

describe("enrichAgentsWithPipelineContext", () => {
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
    if (!gmailAgent) throw new Error("gmailAgent should be defined");
    expect(gmailAgent.description).toContain("DOWNSTREAM DATA REQUIREMENTS");
    // The LLM should infer something about needing email content for TODO extraction

    // Last agent should NOT have downstream context (no downstream steps)
    const todoAgent = enriched.find((a) => a.id === "todo-extractor");
    if (!todoAgent) throw new Error("todoAgent should be defined");
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
