import { assert } from "@std/assert";
import { enrichAgentsWithDomains } from "../../../../packages/system/agents/workspace-creation/enrichers/agents.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { setupTest } from "../../lib/utils.ts";
import { linkedinProspectResearchPlan } from "./plans/linkedin-prospect-research.ts";

const { step } = setupTest({ testFileUrl: new URL(import.meta.url) });

/**
 * Tests agent enrichment for Yena's hallucination case.
 *
 * Regression test for Oct 14, 2025 session where enrichment produced a vague
 * LLM agent that fabricated professional backgrounds instead of using the
 * bundled research agent with proper citation requirements.
 *
 * This test CURRENTLY FAILS - it will PASS once enrichment is fixed to
 * detect research tasks and use bundled research agent.
 */
Deno.test("Agent Enrichment - People Research Anti-Hallucination", async (t) => {
  await loadCredentials();

  await step(t, "Yena's plan produces safe research agent config", async ({ snapshot }) => {
    // Use the EXACT plan from Yena's session
    const plan = linkedinProspectResearchPlan;

    // Extract the agent that does people research
    const prospectResearcherAgent = plan.agents.find((a) => a.id === "prospect-researcher");

    assert(prospectResearcherAgent, "Plan should have prospect research agent");

    snapshot({ inputPlan: plan, prospectResearcherAgent });

    // Run enrichment (this is what workspace-creation does)
    const { enrichedAgents, mcpDomains } = await enrichAgentsWithDomains(plan.agents);

    const enrichedResearchAgent = enrichedAgents.find((a) => a.id === "prospect-researcher");

    assert(enrichedResearchAgent, "Should have enriched research agent");

    snapshot({ enrichedConfig: enrichedResearchAgent.config, mcpDomains });

    // CRITICAL: Validate the enriched agent prevents hallucination
    const evaluation = await llmJudge({
      criteria: `
      This is a regression test for agent enrichment that caused hallucination.

      The INPUT agent description was:
      "${prospectResearcherAgent.description}"

      The agent researches PEOPLE and their professional backgrounds.

      EXPECTED OUTPUT (will make test PASS):
      The enriched config should use the bundled research agent:
      {
        "type": "atlas",
        "agent": "research",
        "prompt": "...",
        ...
      }

      The bundled research agent has built-in:
      - Citation requirements
      - Verification before making claims
      - Explicit "information unavailable" when unverified

      ACTUAL BUGGY OUTPUT (will make test FAIL):
      If enrichment produces an LLM agent:
      {
        "type": "llm",
        "config": {
          "model": "claude-haiku-4-5",
          "prompt": "You are a prospect research and email generation specialist..."
        }
      }

      This LLM config is HALLUCINATION-PRONE because:
      - Generic prompt without citation requirements
      - No verification requirements
      - Allows fabrication of professional details
      - No instruction to state "information unavailable"

      VALIDATION RULES:
      1. For people/professional research tasks, enrichment MUST use bundled research agent
      2. Using type="llm" for people research = HALLUCINATION RISK (test should FAIL)
      3. Using type="atlas" with agent="research" = SAFE (test should PASS)

      Does this enriched config use the bundled research agent to prevent hallucination?
      `,
      agentOutput: JSON.stringify(enrichedResearchAgent.config, null, 2),
    });

    snapshot({ evaluation });

    assert(
      evaluation.pass,
      `Agent enrichment should produce SAFE research config (bundled agent), but produced HALLUCINATION-PRONE config. ` +
        `This test will FAIL until enrichment is fixed to detect people research and use bundled research agent. ` +
        `LLM Judge reasoning: ${evaluation.justification}`,
    );

    return {
      inputAgent: prospectResearcherAgent,
      enrichedAgent: enrichedResearchAgent,
      evaluation,
    };
  });
});
