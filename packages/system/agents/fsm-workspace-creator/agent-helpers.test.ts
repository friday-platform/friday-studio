import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildFSMGenerationPrompt, flattenAgent } from "./agent-helpers.ts";
import type { ClassifiedAgent, Job, Signal } from "./types.ts";

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
