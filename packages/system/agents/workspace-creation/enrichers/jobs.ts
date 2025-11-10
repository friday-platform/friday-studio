import { type JobSpecification, JobSpecificationSchema } from "@atlas/config";
import { ANTHROPIC_CACHE_BREAKPOINT, anthropic } from "@atlas/core";
import type { WorkspacePlan } from "@atlas/core/artifacts";
import { logger } from "@atlas/logger";
import { generateObject } from "ai";
import { z } from "zod";

const JobEnricherSchema = z.object({ job: JobSpecificationSchema });

const systemPrompt = `<role>
You create job execution specifications from structured plans.
</role>

<context>
Jobs connect signals to agents in Atlas workspaces. Each job:
- Is triggered by a signal
- Executes a series of agent steps
- Defines how data flows between agents
- Specifies execution strategy (sequential/parallel)
</context>

<instructions>
1. Convert job plan into JobSpecification:
   - name: Use the job ID as the name (lowercase, underscores allowed)
   - description: Business purpose from job description
   - triggers: Array with signal reference
   - execution: Strategy and agent pipeline

2. Configure execution strategy based on behavior:
   - sequential: Agents run one after another
   - parallel: Agents run simultaneously

3. Define agent context flow:
   - First agent gets signal data: { signal: true }
   - Sequential: Each agent gets previous output: { steps: "previous" }
   - Parallel: Final synthesizer gets all outputs: { steps: "all" }

4. Common patterns:
   - Pipeline: sequential with all steps using steps: "previous"
   - Fan-out/fan-in: parallel execution, synthesizer with steps: "all"
</instructions>

<examples>
Sequential pipeline (3 steps):
{
  name: "process_notes",
  description: "Process notes and notify team",
  triggers: [{ signal: "new-note-detected" }],
  execution: {
    strategy: "sequential",
    agents: [
      { id: "note-reader", context: { signal: true } },
      { id: "note-analyzer", context: { steps: "previous" } },
      { id: "slack-notifier", context: { steps: "previous" } }
    ]
  }
}

Parallel analysis:
{
  name: "multi_aspect_analysis",
  description: "Analyze data from multiple perspectives",
  triggers: [{ signal: "data-ready" }],
  execution: {
    strategy: "parallel",
    agents: [
      { id: "sentiment-analyzer", context: { signal: true } },
      { id: "topic-classifier", context: { signal: true } }
    ]
  }
}
</examples>`;

export async function enrichJob(
  job: WorkspacePlan["jobs"][number],
  abortSignal?: AbortSignal,
): Promise<{ id: string; spec: JobSpecification }> {
  const result = await generateObject({
    model: anthropic("claude-sonnet-4-5"),
    schema: JobEnricherSchema,
    messages: [
      { role: "system", content: systemPrompt, providerOptions: ANTHROPIC_CACHE_BREAKPOINT },
      {
        role: "user",
        content: `Generate job specification:

Job ID: ${job.id}
Name: ${job.name}
Trigger Signal: ${job.triggerSignalId}
Behavior: ${job.behavior}

Steps:
${job.steps.map((s, i) => `${i + 1}. Agent: ${s.agentId} - ${s.description}`).join("\n")}

Generate a complete JobSpecification with:
- name: Use "${job.id.replace(/-/g, "_")}" as the job name
- description: What this job accomplishes
- triggers: [{ signal: "${job.triggerSignalId}" }]
- execution: Strategy (sequential/parallel) and agents array with context flow`,
      },
    ],
    temperature: 0.3,
    maxRetries: 3,
    maxOutputTokens: 4000,
    abortSignal,
  });

  logger.debug("AI SDK generateObject completed", {
    agent: "job-enricher",
    step: "enrich-job-specification",
    usage: result.usage,
  });

  return { id: job.id, spec: result.object.job };
}
