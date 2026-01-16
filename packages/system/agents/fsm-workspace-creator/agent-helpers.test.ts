import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import {
  buildFSMGenerationPrompt,
  enrichAgentsWithPipelineContext,
  flattenAgent,
} from "./agent-helpers.ts";
import type { ClassifiedAgent, Job, Signal, SimplifiedAgent } from "./types.ts";

Deno.test("buildFSMGenerationPrompt", async (t) => {
  await t.step("includes trigger signal description (user intent) in the prompt", () => {
    const job: Job = {
      id: "test-job",
      name: "Weather Email Job",
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
      description:
        "Send weather forecast email. Forecast: Saturday Jan 4 will be sunny with 72°F high. Sunday Jan 5 will be cloudy with 65°F high and 40% chance of rain. Send to user@example.com",
    };

    const prompt = buildFSMGenerationPrompt(job, agents, triggerSignal);

    // The fix: prompt should include User Intent with the description
    assertStringIncludes(prompt, "User Intent:");
    assertStringIncludes(prompt, triggerSignal.description);
    assertStringIncludes(prompt, "sunny with 72°F high");
    assertStringIncludes(prompt, "user@example.com");

    // Should also include the critical instruction about extracting actual data
    assertStringIncludes(prompt, "CRITICAL");
    assertStringIncludes(prompt, "extract and use the ACTUAL data");
  });

  await t.step("includes signal ID in the prompt", () => {
    const job: Job = {
      id: "test-job",
      name: "Test Job",
      triggerSignalId: "my-trigger-signal",
      behavior: "sequential",
      steps: [],
    };

    const triggerSignal: Signal = {
      id: "my-trigger-signal",
      name: "My Trigger Signal",
      description: "Test description",
    };

    const prompt = buildFSMGenerationPrompt(job, [], triggerSignal);

    assertStringIncludes(prompt, "Trigger Signal: my-trigger-signal");
    assertStringIncludes(prompt, "User Intent: Test description");
  });

  await t.step("includes note about agent.description containing downstream requirements", () => {
    const job: Job = {
      id: "email-triage",
      name: "Email Triage Job",
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
      description: "Check emails daily",
    };

    const prompt = buildFSMGenerationPrompt(job, [], triggerSignal);

    // Should note that agent.description already contains downstream requirements
    assertStringIncludes(prompt, "agent.description");
    assertStringIncludes(prompt, "downstream");
  });
});

Deno.test("enrichAgentsWithPipelineContext", async (t) => {
  await t.step("adds downstream context to first agent (TEM-3625 fix)", async () => {
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
    const gmailAgent = enriched.find((a) => a.id === "gmail-priority-monitor")!;
    assertStringIncludes(gmailAgent.description, "DOWNSTREAM DATA REQUIREMENTS");
    // The LLM should infer something about needing email content for TODO extraction

    // Last agent should NOT have downstream context (no downstream steps)
    const todoAgent = enriched.find((a) => a.id === "todo-extractor")!;
    assertEquals(
      todoAgent.description,
      "Analyze email content to identify and extract work-related action items",
    );
  });

  await t.step("preserves agent properties while enriching description", async () => {
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

    // All properties should be preserved
    const first = enriched[0];
    assertExists(first);
    assertEquals(first.id, "agent-1");
    assertEquals(first.name, "Agent One");
    assertEquals(first.config, { key: "value" });
    assertEquals(first.executionType, "llm");
    assertEquals(first.mcpTools, ["tool1", "tool2"]);
  });

  await t.step("handles agent not in job steps gracefully", async () => {
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
    const first = enriched[0];
    assertExists(first);
    assertEquals(first.description, "Not in this job");
  });
});

Deno.test("flattenAgent", async (t) => {
  await t.step("flattens bundled agent correctly", () => {
    const classified: ClassifiedAgent = {
      id: "test-agent",
      name: "Test Agent",
      description: "A test agent",
      config: { key: "value" },
      type: { kind: "bundled", bundledId: "actual-bundled-id", name: "Actual Bundled" },
    };

    const simplified = flattenAgent(classified);

    assertEquals(simplified.id, "test-agent");
    assertEquals(simplified.name, "Test Agent");
    assertEquals(simplified.executionType, "bundled");
    assertEquals(simplified.bundledAgentId, "actual-bundled-id");
    assertEquals(simplified.mcpTools, undefined);
  });

  await t.step("flattens LLM agent correctly", () => {
    const classified: ClassifiedAgent = {
      id: "llm-agent",
      name: "LLM Agent",
      description: "An LLM agent",
      config: {},
      type: { kind: "llm", mcpTools: ["tool1", "tool2"] },
    };

    const simplified = flattenAgent(classified);

    assertEquals(simplified.executionType, "llm");
    assertEquals(simplified.bundledAgentId, undefined);
    assertEquals(simplified.mcpTools, ["tool1", "tool2"]);
  });
});
