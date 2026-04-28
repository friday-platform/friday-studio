/**
 * Job-as-tool generator for workspace chat.
 *
 * Converts workspace jobs into AI SDK tools that the workspace-chat agent can invoke.
 * Jobs with `inputs` schemas get typed parameters; jobs without get a generic `{ prompt }` fallback.
 *
 * Job tools call the daemon's signal trigger endpoint (JSON mode), blocking until completion.
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import { client, DetailedError, parseResult } from "@atlas/client/v2";
import type { JobSpecification, WorkspaceSignalConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { jsonSchema, tool } from "ai";
import { z } from "zod";

/**
 * The signal-trigger route returns `{ error: string }` on 4xx/5xx. Hono's
 * RPC client wraps that in DetailedError where `detail.data` holds the
 * parsed body. Surface the structured `error` field to the chat agent so
 * it can see the actual failure reason (`Signal '...' session failed:
 * LLM step failed: {...}`) instead of just the HTTP status.
 */
const SignalErrorBodySchema = z.object({ error: z.string() });

function describeJobFailure(err: unknown): { message: string; statusCode?: number } {
  if (err instanceof DetailedError) {
    const detail: unknown = err.detail;
    if (detail !== null && typeof detail === "object" && "data" in detail) {
      const parsed = SignalErrorBodySchema.safeParse(detail.data);
      if (parsed.success) {
        const statusCode = typeof err.statusCode === "number" ? err.statusCode : undefined;
        return { message: parsed.data.error, statusCode };
      }
    }
    const statusCode = typeof err.statusCode === "number" ? err.statusCode : undefined;
    return { message: err.message, statusCode };
  }
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}

/** Default input schema for jobs without an `inputs` definition */
const DEFAULT_INPUT_SCHEMA = {
  type: "object" as const,
  properties: { prompt: { type: "string" as const, description: "What you want this job to do" } },
  required: ["prompt"],
};

/**
 * Create AI SDK tools from workspace job definitions.
 *
 * Each job becomes a tool that triggers the job's signal via the daemon's
 * signal endpoint (JSON mode) and blocks until completion.
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
        logger.info("Job tool executing via signal trigger", {
          jobName,
          workspaceId,
          signalId: triggerSignal,
        });

        const result = await parseResult(
          client.workspace[":workspaceId"].signals[":signalId"].$post({
            param: { workspaceId, signalId: triggerSignal },
            json: { payload: input },
          }),
        );

        if (!result.ok) {
          const failure = describeJobFailure(result.error);
          logger.error("Job tool execution failed", {
            jobName,
            workspaceId,
            error: failure.message,
            statusCode: failure.statusCode,
          });
          return { success: false, statusCode: failure.statusCode, error: failure.message };
        }

        const { sessionId, status, output } = result.data;

        if (status === "completed") {
          logger.info("Job tool completed", {
            jobName,
            sessionId,
            status,
            outputDocCount: Array.isArray(output) ? output.length : 0,
          });
          // Surface the FSM's output documents verbatim. Workspace-chat's
          // LLM needs to see what the agent actually produced — without
          // `output` the model has a success flag and nothing to render,
          // so "what did I save?" returns an empty answer even when the
          // underlying pipeline succeeded.
          return { success: true, sessionId, status, output: output ?? [] };
        }

        logger.error("Job tool execution unexpected status", { jobName, sessionId, status });
        return {
          success: false,
          sessionId,
          status,
          error: `Job '${jobName}' returned status: ${status}`,
        };
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
