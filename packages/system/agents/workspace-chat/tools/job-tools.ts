/**
 * Job-as-tool generator for workspace chat.
 *
 * Converts workspace jobs into AI SDK tools that the workspace-chat agent can invoke.
 * Jobs with `inputs` schemas get typed parameters; jobs without get a generic `{ prompt }` fallback.
 *
 * Job tools call the daemon's synchronous execute endpoint, blocking until completion.
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type { JobSpecification, WorkspaceSignalConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { jsonSchema, tool } from "ai";

/** Default input schema for jobs without an `inputs` definition */
const DEFAULT_INPUT_SCHEMA = {
  type: "object" as const,
  properties: { prompt: { type: "string" as const, description: "What you want this job to do" } },
  required: ["prompt"],
};

/**
 * Create AI SDK tools from workspace job definitions.
 *
 * Each job becomes a tool that executes via the daemon's synchronous job
 * execution endpoint and blocks until completion.
 * The `handle-chat` job is excluded to prevent self-referential invocation.
 */
export function createJobTools(
  workspaceId: string,
  jobs: Record<string, JobSpecification>,
  signals: Record<string, WorkspaceSignalConfig>,
  logger: Logger,
): AtlasTools {
  const tools: AtlasTools = {};

  for (const [jobName, jobSpec] of Object.entries(jobs)) {
    // Skip handle-chat — that's the workspace-chat agent itself
    if (jobName === "handle-chat") continue;

    // Find the trigger signal for this job
    const triggerSignal = jobSpec.triggers?.[0]?.signal;
    if (!triggerSignal) {
      logger.debug("Skipping job without trigger signal", { jobName });
      continue;
    }

    // Prefer job.inputs (canonical job contract), fall back to the trigger signal's schema
    // because the workspace planner currently puts input schemas on signals, not jobs.
    const inputSchemaObj = jobSpec.inputs ?? signals[triggerSignal]?.schema ?? DEFAULT_INPUT_SCHEMA;
    const description = jobSpec.description ?? `Execute the ${jobName} job`;

    tools[jobName] = tool({
      description,
      inputSchema: jsonSchema(inputSchemaObj),
      execute: async (input: Record<string, unknown>) => {
        logger.info("Job tool executing", { jobName, workspaceId });

        const result = await parseResult(
          client.workspace[":workspaceId"].jobs[":jobName"].execute.$post({
            param: { workspaceId, jobName },
            json: { payload: input },
          }),
        );

        if (!result.ok) {
          logger.error("Job tool execution failed", { jobName, workspaceId, error: result.error });
          return { success: false, error: `Failed to execute job: ${result.error}` };
        }

        const { sessionId, status, error } = result.data;

        if (status === "completed") {
          logger.info("Job tool completed", { jobName, sessionId, status });
          return { success: true, sessionId, status };
        }

        logger.error("Job tool execution failed", { jobName, sessionId, status, error });
        return { success: false, sessionId, status, error: error ?? `Job '${jobName}' ${status}` };
      },
    });

    logger.debug("Registered job tool", {
      jobName,
      signal: triggerSignal,
      hasInputs: !!jobSpec.inputs,
    });
  }

  return tools;
}
