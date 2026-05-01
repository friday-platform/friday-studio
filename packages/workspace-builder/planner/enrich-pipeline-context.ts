/**
 * Pipeline Context Enrichment
 *
 * Enriches agent descriptions with downstream data requirements so that
 * upstream agents know what downstream consumers need. Prevents the class
 * of bug where an agent fetches metadata instead of full content because
 * it has no visibility into what later steps require (e.g. TEM-3625).
 *
 * Reference: packages/system/agents/fsm-workspace-creator/agent-helpers.ts:35-126
 */

import type { PlatformModels } from "@atlas/llm";
import { createLogger } from "@atlas/logger";
import { buildDeclarationGuidance } from "@atlas/resources/guidance";
import type { ResourceDeclaration } from "@atlas/schemas/workspace";
import { generateText } from "ai";
import type { Agent, JobWithDAG } from "../types.ts";

const logger = createLogger({ component: "proto-pipeline-context" });

const FALLBACK_TEXT = "Produce complete, detailed output for downstream processing.";

const SYSTEM_PROMPT = `You analyze data pipelines. Given a step and its downstream consumers, write 1-2 sentences telling the agent what to focus on in its output.

Guide behavior, not structure. Say what content matters, not what fields to produce. Do NOT list field names or types.

Good: "Include full message bodies and sender details, not just headers."
Good: "Produce a narrative summary with key metrics, not raw data tables."
Bad: "sender_email (string), subject (string), body_text (string)"
Bad: "- Email sender address\\n- Subject line\\n- Message body content"`;

/**
 * Infer what data downstream steps need from the current step.
 * Makes a single LLM call per step via `platformModels.get("planner")`.
 *
 * @param currentStep - The step whose output requirements we're inferring
 * @param downstreamSteps - Steps that consume this step's output
 * @param platformModels - Platform model resolver
 * @returns 1-2 sentences of behavioral guidance, or fallback text on failure
 */
async function inferDownstreamDataNeeds(
  currentStep: { description: string },
  downstreamSteps: Array<{ description: string }>,
  platformModels: PlatformModels,
): Promise<string> {
  const downstreamList = downstreamSteps.map((s, i) => `${i + 1}. ${s.description}`).join("\n");

  try {
    const result = await generateText({
      model: platformModels.get("planner"),
      system: SYSTEM_PROMPT,
      prompt: `Current step: ${currentStep.description}

Downstream steps that will consume this step's output:
${downstreamList}

What specific data must the current step produce for downstream steps to work?`,
      temperature: 0.2,
      maxRetries: 3,
    });

    return result.text.trim() || FALLBACK_TEXT;
  } catch (error) {
    logger.warn("Failed to infer downstream data needs, using fallback", { error });
    return FALLBACK_TEXT;
  }
}

/** Enrichment result for a single agent, used for debug output. */
export interface PipelineContextEntry {
  agentId: string;
  originalDescription: string;
  enrichedDescription: string;
  downstreamSteps: string[];
}

/** Inference function type — injectable for testing. */
type InferFn = (
  currentStep: { description: string },
  downstreamSteps: Array<{ description: string }>,
  platformModels: PlatformModels,
) => Promise<string>;

/**
 * Enrich agent descriptions with downstream data requirements and resource context.
 *
 * For each job, finds steps with downstream consumers and appends a
 * `DOWNSTREAM DATA REQUIREMENTS:` section to the corresponding agent's
 * description. Terminal steps (no downstream consumers) are left unchanged.
 *
 * When resources are declared, appends a `WORKSPACE RESOURCES:` section
 * to all agents with per-resource behavioral guidance.
 *
 * An agent appearing in multiple steps across jobs accumulates requirements
 * from all appearances.
 *
 * @param agents - Agents to enrich (mutated in place for description field)
 * @param jobs - Jobs containing DAG steps with dependency edges
 * @param options.infer - Override the inference function (for testing)
 * @param options.resources - Declared workspace resources for context enrichment
 * @returns The mutated agents array and enrichment entries for debug output
 */
export async function enrichAgentsWithPipelineContext(
  agents: Agent[],
  jobs: JobWithDAG[],
  deps: { platformModels: PlatformModels },
  options?: { infer?: InferFn; resources?: ResourceDeclaration[] },
): Promise<{ agents: Agent[]; entries: PipelineContextEntry[] }> {
  const infer = options?.infer ?? inferDownstreamDataNeeds;
  const { platformModels } = deps;

  // Accumulate downstream requirements per agent across all jobs
  const requirementsByAgent = new Map<
    string,
    { downstreamSteps: string[]; requirements: string[] }
  >();

  for (const job of jobs) {
    for (const step of job.steps) {
      // Find downstream steps — steps that list this step in their depends_on
      const downstreamSteps = job.steps.filter((s) => s.depends_on.includes(step.id));

      if (downstreamSteps.length === 0) continue;

      logger.info("Inferring downstream needs", {
        jobId: job.id,
        stepId: step.id,
        agentId: step.agentId,
        downstreamCount: downstreamSteps.length,
      });

      const requirements = await infer(
        { description: step.description },
        downstreamSteps.map((s) => ({ description: s.description })),
        platformModels,
      );

      const existing = requirementsByAgent.get(step.agentId) ?? {
        downstreamSteps: [],
        requirements: [],
      };
      existing.downstreamSteps.push(...downstreamSteps.map((s) => s.id));
      existing.requirements.push(requirements);
      requirementsByAgent.set(step.agentId, existing);
    }
  }

  // Apply accumulated requirements to agent descriptions
  const entries: PipelineContextEntry[] = [];

  for (const agent of agents) {
    const accumulated = requirementsByAgent.get(agent.id);
    if (!accumulated) continue;

    const originalDescription = agent.description;
    const combined = accumulated.requirements.join("\n\n");
    agent.description = `${agent.description}\n\nDOWNSTREAM DATA REQUIREMENTS:\n${combined}`;

    entries.push({
      agentId: agent.id,
      originalDescription,
      enrichedDescription: agent.description,
      downstreamSteps: accumulated.downstreamSteps,
    });
  }

  // Append resource context to all agents when resources are declared
  const resources = options?.resources;
  if (resources && resources.length > 0) {
    const guidance = buildDeclarationGuidance(resources);
    if (guidance) {
      for (const agent of agents) {
        agent.description = `${agent.description}\n\n${guidance}`;
      }
    }
  }

  return { agents, entries };
}
