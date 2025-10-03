import { researchAgent } from "@atlas/bundled-agents";
import { assert } from "@std/assert";
import { AgentContextAdapter } from "../../lib/context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { setupTest } from "../../lib/utils.ts";

const { step } = setupTest({ testFileUrl: new URL(import.meta.url) });

Deno.test("Research agent", async (t) => {
  await loadCredentials();
  const adapter = new AgentContextAdapter();
  adapter.enableTelemetry();

  await step(t, "Startup research", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const prompt =
      "Find recent news from Wrocław, Poland from the last 23 hours. Look for local news, events, developments, and stories specifically related to Wrocław city. Include headlines, brief summaries, and source links.";

    const startTime = performance.now();
    const result = await researchAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    // Capture execution snapshot
    snapshot({
      result,
      metrics: { ...metrics, timing: { executionTimeMs } },
      streamEvents,
      executionSummary: {
        toolsExecuted: metrics?.tools.length || 0,
        totalTokens: metrics?.tokens.total || 0,
        promptTokens: metrics?.tokens.prompt || 0,
        completionTokens: metrics?.tokens.completion || 0,
      },
    });

    assert(result.ok, "Should return a research result");
    return { result, metrics, executionTimeMs };
  });

  // Test: Research gravel bikes with specific requirements
  await step(t, "Gravel bike options", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const prompt =
      "What are new options for gravel bikes which fit larger than 2-inch tires? Prefer titanium frames, but open to carbon as well.";

    const startTime = performance.now();
    const result = await researchAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    // Capture execution snapshot
    snapshot({
      result,
      metrics: { ...metrics, timing: { executionTimeMs } },
      streamEvents,
      executionSummary: {
        toolsExecuted: metrics?.tools.length || 0,
        totalTokens: metrics?.tokens.total || 0,
        promptTokens: metrics?.tokens.prompt || 0,
        completionTokens: metrics?.tokens.completion || 0,
      },
    });

    assert(result.ok, "Should return a research result");
    const evaluation = await llmJudge({
      criteria: `
      1. A list of specific bike makes/models
      2. Explicit mentions of wheel size, tire clearance, and frame material
      3. Include citations with links
      `,
      agentOutput: result.data.summary,
    });
    assert(evaluation.pass, `LLM judge failed: ${evaluation.justification}`);

    return { result, metrics, executionTimeMs };
  });

  // Test: Research multiple people for scheduled meetings
  await step(t, "Startup research", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const prompt = `
      Research the people I'm meeting with today and their companies.
      'Today's Meetings (September 18, 2025):
        "meetings": [
          {
            "title": "Meeting with Parker Conrad @ Rippling",
            "startTime": "2025-09-18T10:00:00 PDT",
            "endTime": "2025-09-18T11:00:00 PDT",
            "duration": "1 hour",
            "isPortfolioCompany": true,
            "portfolioCompany": "Rippling",
            "contactPerson": "Parker Conrad"
          },
          {
            "title": "Meeting with Amjad Masad @ Replit",
            "startTime": "2025-09-18T12:15:00 PDT",
            "endTime": "2025-09-18T13:15:00 PDT",
            "duration": "1 hour",
            "isPortfolioCompany": true,
            "portfolioCompany": "Replit",
            "contactPerson": "Amjad Masad"
          },
          {
            "title": "Meeting with Feross Aboukhadijeh @ Socket",
            "startTime": "2025-09-18T14:15:00 PDT",
            "endTime": "2025-09-18T15:30:00 PDT",
            "duration": "1 hour 15 minutes",
            "isPortfolioCompany": true,
            "portfolioCompany": "Socket",
            "contactPerson": "Feross Aboukhadijeh"
          }
        ]
        '
    `;

    const startTime = performance.now();
    const result = await researchAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    // Capture execution snapshot
    snapshot({
      result,
      metrics: { ...metrics, timing: { executionTimeMs } },
      streamEvents,
      executionSummary: {
        toolsExecuted: metrics?.tools.length || 0,
        totalTokens: metrics?.tokens.total || 0,
        promptTokens: metrics?.tokens.prompt || 0,
        completionTokens: metrics?.tokens.completion || 0,
      },
    });

    assert(result.ok, "Should return a research result");
    const evaluation = await llmJudge({
      criteria: `
        1. Research Parker Conrad, Amjad Masad, and Feross Aboukhadijeh
        2. Include background and company info for each person
        3. Include citations for facts
      `,
      agentOutput: result.data.summary,
    });
    assert(evaluation.pass, `LLM judge failed: ${evaluation.justification}`);
    return { result, metrics, executionTimeMs };
  });

  // Test: Research gravel bikes with specific requirements
  await step(t, "Gravel bike options", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const prompt =
      "What are new options for gravel bikes which fit larger than 2-inch tires? Prefer titanium frames, but open to carbon as well.";

    const startTime = performance.now();
    const result = await researchAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    // Capture execution snapshot
    snapshot({
      result,
      metrics: { ...metrics, timing: { executionTimeMs } },
      streamEvents,
      executionSummary: {
        toolsExecuted: metrics?.tools.length || 0,
        totalTokens: metrics?.tokens.total || 0,
        promptTokens: metrics?.tokens.prompt || 0,
        completionTokens: metrics?.tokens.completion || 0,
      },
    });

    assert(result.ok, "Should return a research result");
    const evaluation = await llmJudge({
      criteria: `
      1. A list of specific bike makes/models
      2. Explicit mentions of wheel size, tire clearance, and frame material
      3. Include citations with links
      `,
      agentOutput: result.data.summary,
    });
    assert(evaluation.pass, `LLM judge failed: ${evaluation.justification}`);

    return { result, metrics, executionTimeMs };
  });

  // Test: Handle false premise questions
  await step(t, "Blatant un-truths", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const prompt = "When was Tim Cook appointed the new CEO of OpenAI?";

    const startTime = performance.now();
    const result = await researchAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    // Capture execution snapshot
    snapshot({
      result,
      metrics: { ...metrics, timing: { executionTimeMs } },
      streamEvents,
      executionSummary: {
        toolsExecuted: metrics?.tools.length || 0,
        totalTokens: metrics?.tokens.total || 0,
        promptTokens: metrics?.tokens.prompt || 0,
        completionTokens: metrics?.tokens.completion || 0,
      },
    });

    assert(result.ok, "Should return a research result");
    const evaluation = await llmJudge({
      criteria: "The agent should determine that Tim Cook is *not* the CEO of OpenAI.",
      agentOutput: result.data.summary,
    });
    assert(evaluation.pass, `LLM judge failed: ${evaluation.justification}`);

    return { result, metrics, executionTimeMs };
  });

  // Test: Handle impossible scenarios
  await step(t, "Impossible research", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const prompt = "Who are the people I'm meeting with today and what are their companies?";

    const startTime = performance.now();
    const result = await researchAgent.execute(prompt, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    // Capture execution snapshot
    snapshot({
      result,
      metrics: { ...metrics, timing: { executionTimeMs } },
      streamEvents,
      executionSummary: {
        toolsExecuted: metrics?.tools.length || 0,
        totalTokens: metrics?.tokens.total || 0,
        promptTokens: metrics?.tokens.prompt || 0,
        completionTokens: metrics?.tokens.completion || 0,
      },
    });

    assert(!result.ok, "Should return an error");
    const evaluation = await llmJudge({
      criteria: "The agent should explain that it doesn't have access to the information",
      agentOutput: result.error.reason,
    });
    assert(evaluation.pass, `LLM judge failed: ${evaluation.justification}`);

    return { result, metrics, executionTimeMs };
  });
});
