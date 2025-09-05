import { anthropic } from "@ai-sdk/anthropic";
import { JobSpecificationSchema } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { toKebabCase } from "@std/text";
import { generateObject, tool } from "ai";
import { z } from "zod/v4";
import type { WorkspaceBuilder } from "../builder.ts";

const systemPrompt = `
  <role>
    You create jobs that connect signals to agents.
  </role>
  <context>
    Jobs connect triggers to executors in Atlas workspaces. Each job defines when to run, what agents to use, and how data flows between agents.
  </context>
  <instructions>

  <CRITICAL>Agent and Signal names must match EXACTLY</CRITICAL>

  1. Map each signal to appropriate job(s):
     - One signal can trigger multiple jobs (different workflows)
     - Jobs can have multiple triggers (OR logic)
     - Ensure every signal triggers at least one job

  2. For each job, generate:
    - name: MCP-compliant name (lowercase, underscores)
    - description: Business purpose in plain language
    - triggers: Array with signal references
    - execution: Strategy and agent pipeline

  3. Configure execution strategy:
    - sequential: Agents run one after another
    - parallel: Agents run simultaneously (for multi-aspect analysis)


  4. Define agent context flow:
    - id: first-agent
      # No context needed for first agent
    - id: second-agent
      context:
        signal: true  # Include original trigger data
        steps: "previous"  # Get first-agent's output
    - id: final-agent
      context:
        steps: "all"  # Get all previous outputs


    <common_patterns>
      Pipeline: sequential execution with steps: "previous"
      Fan-out/fan-in: parallel execution, synthesizer with steps: "all"
    </common_patterns>
  </instructions>`;

export function getGenerateJobsTool(
  builder: WorkspaceBuilder,
  logger: Logger,
  abortSignal?: AbortSignal,
) {
  return tool({
    description: "Generate job specifications",
    inputSchema: z.object({ requirements: z.string() }),
    execute: async ({ requirements }) => {
      logger.debug("Generating jobs...");
      const { object } = await generateObject({
        model: anthropic("claude-3-5-haiku-latest"),
        system: systemPrompt,
        schema: z.object({
          jobs: JobSpecificationSchema.extend({
            id: z.string().meta({ description: "Job ID" }),
          }).array(),
        }),
        prompt: `Create an array of jobs to meet the following requirements: ${requirements}

        Available signals: ${builder.getSignalIds().join(", ")}
        Available agents: ${builder.getAgentIds().join(", ")}
        `,
        temperature: 0.3,
        maxRetries: 3,
        abortSignal,
      });

      const jobs = object.jobs.map(({ id, ...spec }) => ({ id: toKebabCase(id), spec }));
      builder.addJobs(jobs);
      return { count: jobs.length, jobIds: jobs.map((j) => j.id) };
    },
  });
}
