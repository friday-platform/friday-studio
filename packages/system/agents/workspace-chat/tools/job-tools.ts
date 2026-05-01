/**
 * Job-as-tool generator for workspace chat.
 *
 * Converts workspace jobs into AI SDK tools that the workspace-chat agent can invoke.
 * Jobs with `inputs` schemas get typed parameters; jobs without get a generic `{ prompt }` fallback.
 *
 * When a `writer` is provided, job tools stream via SSE and forward inner session
 * chunks as `nested-chunk` envelopes so the chat UI renders nested tool-call cards
 * live under the job tool card. When no writer is provided, they fall back to the
 * legacy JSON-blocking mode.
 */

import type { AtlasTools, AtlasUIMessage, AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { client, DetailedError, parseResult } from "@atlas/client/v2";
import type { JobSpecification, WorkspaceSignalConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { parseSSEStream } from "@atlas/utils/sse";
import { jsonSchema, tool, type UIMessageStreamWriter } from "ai";
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
 * signal endpoint and blocks until completion.
 * The `handle-chat` job is excluded to prevent self-referential invocation.
 *
 * `parentStreamId` is the chat's streamId — when passed, it's forwarded as
 * the inner job session's streamId so downstream side-effects (notably the
 * broadcast hook) can correlate the inner session with its originating chat
 * thread and skip the source platform as a broadcast target. The daemon
 * hook recovers the source from the streamId prefix (`discord:` / `slack:`
 * / etc.), so we don't need to forward it as a separate field.
 *
 * When `writer` is provided, the tool streams via SSE and forwards inner
 * session chunks as `data-nested-chunk` envelopes so nested tool calls
 * render live under the job card. `abortSignal` is wired to the fetch so
 * the HTTP connection closes on user Stop (the background session keeps
 * running — abort propagation to the workspace runtime is a future improvement).
 */
export function createJobTools(
  workspaceId: string,
  jobs: Record<string, JobSpecification>,
  signals: Record<string, WorkspaceSignalConfig>,
  logger: Logger,
  parentStreamId?: string,
  writer?: UIMessageStreamWriter<AtlasUIMessage>,
  abortSignal?: AbortSignal,
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
      execute: (input: Record<string, unknown>, { toolCallId }) => {
        logger.info("Job tool executing via signal trigger", {
          jobName,
          workspaceId,
          signalId: triggerSignal,
          mode: writer ? "sse" : "json",
        });

        if (writer) {
          return executeJobViaSSE({
            workspaceId,
            signalId: triggerSignal,
            input,
            streamId: parentStreamId,
            toolCallId,
            writer,
            abortSignal,
            logger,
            jobName,
          });
        }

        return executeJobViaJSON({
          workspaceId,
          signalId: triggerSignal,
          input,
          streamId: parentStreamId,
          logger,
          jobName,
        });
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

// ── JSON fallback (legacy, used when no writer is available) ───────────────

interface ExecuteJobViaJSONDeps {
  workspaceId: string;
  signalId: string;
  input: Record<string, unknown>;
  streamId: string | undefined;
  logger: Logger;
  jobName: string;
}

async function executeJobViaJSON(
  deps: ExecuteJobViaJSONDeps,
): Promise<{
  success: boolean;
  sessionId?: string;
  status?: string;
  output?: unknown[];
  error?: string;
  statusCode?: number;
}> {
  const { workspaceId, signalId, input, streamId, logger, jobName } = deps;

  const result = await parseResult(
    client.workspace[":workspaceId"].signals[":signalId"].$post({
      param: { workspaceId, signalId },
      json: streamId ? { payload: input, streamId } : { payload: input },
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
    return { success: true, sessionId, status, output: output ?? [] };
  }

  logger.error("Job tool execution unexpected status", { jobName, sessionId, status });
  return {
    success: false,
    sessionId,
    status,
    error: `Job '${jobName}' returned status: ${status}`,
  };
}

// ── SSE streaming (forward inner session chunks as nested-chunk envelopes) ─

interface ExecuteJobViaSSEDeps {
  workspaceId: string;
  signalId: string;
  input: Record<string, unknown>;
  streamId: string | undefined;
  toolCallId: string;
  writer: UIMessageStreamWriter<AtlasUIMessage>;
  abortSignal: AbortSignal | undefined;
  logger: Logger;
  jobName: string;
}

async function executeJobViaSSE(
  deps: ExecuteJobViaSSEDeps,
): Promise<{
  success: boolean;
  sessionId?: string;
  status?: string;
  output?: unknown[];
  error?: string;
  statusCode?: number;
}> {
  const {
    workspaceId,
    signalId,
    input,
    streamId,
    toolCallId,
    writer,
    abortSignal,
    logger,
    jobName,
  } = deps;

  const url = `${getAtlasDaemonUrl()}/api/workspaces/${encodeURIComponent(workspaceId)}/signals/${encodeURIComponent(signalId)}`;
  const body: Record<string, unknown> = { payload: input };
  if (streamId !== undefined) {
    body.streamId = streamId;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: abortSignal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Job tool SSE fetch failed", { jobName, workspaceId, signalId, error: message });
    return { success: false, error: message };
  }

  if (!response.ok) {
    let errorText = `HTTP ${response.status}`;
    try {
      const errorJson: unknown = await response.json();
      if (
        errorJson !== null &&
        typeof errorJson === "object" &&
        "error" in errorJson &&
        typeof errorJson.error === "string"
      ) {
        errorText = errorJson.error;
      }
    } catch {
      // ignore — fall back to status text
    }
    logger.error("Job tool SSE trigger failed", {
      jobName,
      workspaceId,
      signalId,
      status: response.status,
      error: errorText,
    });
    return { success: false, statusCode: response.status, error: errorText };
  }

  if (!response.body) {
    logger.error("Job tool SSE response has no body", { jobName, workspaceId, signalId });
    return { success: false, error: "SSE response has no body" };
  }

  for await (const message of parseSSEStream(response.body)) {
    if (message.data === "[DONE]") {
      break;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data);
    } catch {
      continue;
    }

    if (parsed === null || typeof parsed !== "object" || !("type" in parsed)) {
      continue;
    }

    const type = (parsed as Record<string, unknown>).type;

    if (type === "job-complete") {
      const data = (parsed as Record<string, unknown>).data;
      if (data !== null && typeof data === "object") {
        const d = data as Record<string, unknown>;
        const sessionId = typeof d.sessionId === "string" ? d.sessionId : undefined;
        const status = typeof d.status === "string" ? d.status : "completed";
        const output = Array.isArray(d.output) ? d.output : [];
        logger.info("Job tool completed (SSE)", {
          jobName,
          sessionId,
          status,
          outputDocCount: output.length,
        });
        return { success: true, sessionId, status, output };
      }
      return { success: true };
    }

    if (type === "job-error") {
      const data = (parsed as Record<string, unknown>).data;
      const errorMessage: string =
        data !== null &&
        typeof data === "object" &&
        "error" in data &&
        typeof (data as Record<string, unknown>).error === "string"
          ? ((data as Record<string, unknown>).error as string)
          : "Job tool SSE stream error";
      logger.error("Job tool SSE stream error", {
        jobName,
        workspaceId,
        signalId,
        error: errorMessage,
      });
      return { success: false, error: errorMessage };
    }

    // Forward everything else as nested-chunk so the chat UI reducer can
    // reconstruct inner tool-call children under this job tool card.
    writer.write({
      type: "data-nested-chunk",
      data: { parentToolCallId: toolCallId, chunk: parsed as AtlasUIMessageChunk },
    });
  }

  logger.warn("Job tool SSE stream ended without job-complete", { jobName, workspaceId, signalId });
  return { success: false, error: "Job stream ended without completion signal" };
}
