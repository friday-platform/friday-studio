import { repairJson } from "@atlas/agent-sdk";
import { getDefaultProviderOpts, type PlatformModels } from "@atlas/llm";
import { generateObject } from "ai";
import { z } from "zod";
import { topologicalSort } from "../topological-sort.ts";
import type { Agent, JobWithDAG, Signal } from "../types.ts";

// ---------------------------------------------------------------------------
// DAG validation
// ---------------------------------------------------------------------------

/**
 * Validate a job's DAG structure. Throws on invalid graphs.
 */
function validateJobDAG(job: {
  id: string;
  steps: Array<{ id: string; depends_on: string[] }>;
}): void {
  const result = topologicalSort(job.steps);
  if (!result.success) {
    const messages = result.error.map((e) => e.message);
    throw new Error(`Job "${job.id}": ${messages.join("; ")}`);
  }
}

// ---------------------------------------------------------------------------
// Phase 2: DAG step generation
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You create job orchestrations by connecting signals to agent execution flows as a dependency graph (DAG).

## Job Design Guidelines

- Jobs coordinate one or more agents through steps arranged as a dependency graph
- Each step has a unique ID and lists the step IDs it depends on
- Steps with empty depends_on are root steps (run first)
- Steps that depend on the same upstream steps can run in parallel
- Fan-in: a step that depends on multiple upstream steps waits for all of them
- Same agent can appear multiple times in a job or across jobs
- Steps describe WHAT each step accomplishes in the workflow context
- Prefer fewer jobs: one job per signal is often sufficient
- Step IDs should be kebab-case and descriptive (e.g., "analyze-data", "send-report")

## Output format

Generate jobs with DAG steps that connect the available signals and agents to fulfill the workspace requirements.`;

/**
 * Generate jobs with DAG steps from a user prompt and Phase 1 output.
 * Uses `generateObject` with enum-constrained agent/signal references,
 * then validates the DAG post-hoc.
 */
export async function generateDAGSteps(
  prompt: string,
  signals: Signal[],
  agents: Agent[],
  deps: { platformModels: PlatformModels },
): Promise<JobWithDAG[]> {
  // Task mode has no signals — use a synthetic trigger so the enum is never empty
  const signalIds = signals.length > 0 ? signals.map((s) => s.id) : ["adhoc-trigger"];
  const agentIds = agents.map((a) => a.id);

  // Build dynamic schema with enum constraints
  const jobSchema = z.object({
    jobs: z.array(
      z.object({
        id: z.string().describe("Kebab-case job identifier"),
        name: z.string().describe("Human-readable job name"),
        title: z.string().describe("Short 2-4 word title for UI display"),
        triggerSignalId: z
          .enum(signalIds as [string, ...string[]])
          .describe("Signal ID that triggers this job"),
        steps: z.array(
          z.object({
            id: z.string().describe("Unique kebab-case step ID within this job"),
            agentId: z.enum(agentIds as [string, ...string[]]).describe("Agent ID to execute"),
            description: z.string().describe("What this step accomplishes"),
            depends_on: z
              .array(z.string())
              .describe("Step IDs this step depends on. Empty array = root step"),
          }),
        ),
      }),
    ),
  });

  const result = await generateObject({
    model: deps.platformModels.get("planner"),
    schema: jobSchema,
    experimental_repairText: repairJson,
    maxRetries: 3,
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
        providerOptions: getDefaultProviderOpts("anthropic"),
      },
      {
        role: "user",
        content: `Create jobs connecting these components:

Signals:
${signals.map((s) => `- ${s.id} (${s.name}): ${s.description}`).join("\n")}

Agents:
${agents.map((a) => `- ${a.id} (${a.name}): ${a.description}`).join("\n")}

Requirements: ${prompt}`,
      },
    ],
    maxOutputTokens: 10_240,
  });

  // Post-hoc DAG validation
  for (const job of result.object.jobs) {
    validateJobDAG(job);
  }

  // Map to JobWithDAG (empty contracts/mappings — filled by Phase 3)
  return result.object.jobs.map((job) => ({ ...job, documentContracts: [], prepareMappings: [] }));
}
