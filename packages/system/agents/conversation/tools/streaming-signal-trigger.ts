/**
 * workspace_signal_trigger Tool - Streaming signal trigger for conversation agent
 *
 * Calls the daemon's signal trigger endpoint with SSE mode and forwards
 * real-time FSM events to the conversation UI.
 */
import { AtlasDataEventSchemas, type AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { validateSignalPayload, WorkspaceSignalConfigSchema } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { parseSSEStream, stringifyError } from "@atlas/utils";
import type { UIMessageStreamWriter } from "ai";
import { jsonSchema, tool } from "ai";
import { z } from "zod";

/**
 * AI SDK base chunk types that are safe to forward from inner workspace streams.
 * Excludes stream lifecycle events (start, finish, abort) which would interfere
 * with the outer conversation stream.
 */
const BASE_CHUNK_TYPES = new Set([
  "text-start",
  "text-delta",
  "text-end",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "error",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-available",
  "tool-input-error",
  "tool-output-available",
  "tool-output-error",
  "source-url",
  "source-document",
  "file",
  "start-step",
  "finish-step",
  "message-metadata",
] as const);

/**
 * Data event type prefixes that must NOT be forwarded from inner workspace streams.
 * Session events would close the outer stream prematurely; FSM events are
 * internal lifecycle detail not meant for the conversation UI.
 */
const BLOCKED_DATA_PREFIXES = ["data-fsm-", "data-session-"] as const;

/**
 * Allowed data-* chunk types, derived from AtlasDataEventSchemas keys.
 * Built once at module load — new schemas automatically become forwardable
 * unless they match a blocked prefix.
 */
const ALLOWED_DATA_TYPES: ReadonlySet<string> = new Set(
  Object.keys(AtlasDataEventSchemas)
    .map((key) => `data-${key}`)
    .filter((type) => !BLOCKED_DATA_PREFIXES.some((prefix) => type.startsWith(prefix))),
);

/**
 * Type guard that validates a parsed SSE envelope as a forwardable AtlasUIMessageChunk.
 * Returns true only for known-safe chunk types; unknown or internal types are dropped.
 */
function isForwardableChunk(json: unknown): json is AtlasUIMessageChunk {
  if (typeof json !== "object" || json === null || !("type" in json)) return false;
  // After the `in` check, TS narrows to `Record<"type", unknown>`
  const { type } = json;
  if (typeof type !== "string") return false;
  return BASE_CHUNK_TYPES.has(type) || ALLOWED_DATA_TYPES.has(type);
}

const SignalTriggerResultSchema = z.object({
  success: z.boolean(),
  sessionId: z.string(),
  status: z.string(),
  error: z.string().optional(),
});

type SignalTriggerResult = z.infer<typeof SignalTriggerResultSchema>;

const JobErrorDataSchema = z.object({ error: z.string().optional() });

const ErrorResponseSchema = z.object({ error: z.string().optional() });

/**
 * Creates the workspace_signal_trigger tool with writer closure for streaming progress.
 *
 * Streams FSM events from the daemon's SSE endpoint to the conversation UI
 * in real-time and waits for completion to return actual success/failure status.
 */
export function createStreamingSignalTriggerTool(
  writer: UIMessageStreamWriter,
  session: {
    sessionId: string;
    workspaceId: string;
    streamId: string;
    daemonUrl: string;
    userId?: string;
    datetime?: {
      timezone: string;
      timestamp: string;
      localDate: string;
      localTime: string;
      timezoneOffset: string;
    };
  },
  logger: Logger,
  abortSignal?: AbortSignal,
) {
  return tool({
    description:
      "Trigger a workspace signal with real-time progress streaming. " +
      "Use this to run workspace jobs and see live progress updates.",
    inputSchema: jsonSchema<{
      workspaceId: string;
      signalId: string;
      payload?: Record<string, unknown>;
    }>({
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "The workspace ID to trigger the signal in" },
        signalId: { type: "string", description: "The signal ID to trigger" },
        payload: {
          type: "object",
          description: "Optional payload data to pass to the signal",
          additionalProperties: true,
        },
      },
      required: ["workspaceId", "signalId"],
    }),
    execute: async ({ workspaceId, signalId, payload }): Promise<SignalTriggerResult> => {
      if (abortSignal?.aborted) {
        return {
          success: false,
          sessionId: "",
          status: "cancelled",
          error: "Signal trigger cancelled",
        };
      }

      logger.info("workspace_signal_trigger starting", {
        workspaceId,
        signalId,
        hasPayload: !!payload,
        streamId: session.streamId,
      });

      // Pre-flight validation: fetch workspace config and validate payload against
      // signal schema before opening the SSE stream. The daemon validates server-side
      // too, but failing fast here gives clearer error messages than a cryptic
      // mid-stream failure. Soft — proceeds anyway if config fetch fails.
      try {
        const wsResponse = await fetch(
          `${session.daemonUrl}/api/workspaces/${encodeURIComponent(workspaceId)}`,
        );
        if (wsResponse.ok) {
          const wsData: unknown = await wsResponse.json();
          const wsResult = z
            .object({
              config: z
                .object({ signals: z.record(z.string(), z.unknown()).optional() })
                .optional(),
            })
            .safeParse(wsData);

          if (wsResult.success) {
            const rawSignalConfig = wsResult.data.config?.signals?.[signalId];
            const signalParsed = WorkspaceSignalConfigSchema.safeParse(rawSignalConfig);
            if (signalParsed.success) {
              const validation = validateSignalPayload(signalParsed.data, payload);
              if (!validation.success) {
                logger.error("Signal payload validation failed", {
                  workspaceId,
                  signalId,
                  error: validation.error,
                });
                return {
                  success: false,
                  sessionId: "",
                  status: "error",
                  error: `Payload validation failed: ${validation.error}`,
                };
              }
              logger.debug("Signal payload validated", { workspaceId, signalId });
            }
          }
        }
      } catch (validationError) {
        logger.warn("Could not validate signal payload (proceeding anyway)", {
          workspaceId,
          signalId,
          error: stringifyError(validationError),
        });
      }

      // Enrich payload with datetime for timezone-aware operations
      const enrichedPayload = session.datetime
        ? { ...payload, datetime: session.datetime }
        : payload;

      writer.write({
        type: "data-tool-progress",
        data: { toolName: "workspace_signal_trigger", content: `Running space ${workspaceId}` },
      });

      const url = `${session.daemonUrl}/api/workspaces/${encodeURIComponent(
        workspaceId,
      )}/signals/${encodeURIComponent(signalId)}`;

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({ payload: enrichedPayload, streamId: session.streamId }),
          signal: abortSignal,
        });

        if (!response.ok) {
          const errorBody: unknown = await response
            .json()
            .catch(() => ({ error: response.statusText }));
          const parsed = ErrorResponseSchema.safeParse(errorBody);
          const errorMsg = (parsed.success ? parsed.data.error : undefined) ?? response.statusText;
          logger.error("workspace_signal_trigger HTTP error", {
            workspaceId,
            signalId,
            status: response.status,
            error: errorMsg,
          });
          return { success: false, sessionId: "", status: "error", error: errorMsg };
        }

        if (!response.body) {
          return {
            success: false,
            sessionId: "",
            status: "error",
            error: "No response body from signal trigger endpoint",
          };
        }

        // Read SSE stream using shared parser
        let result: SignalTriggerResult = { success: false, sessionId: "", status: "unknown" };

        for await (const message of parseSSEStream(response.body)) {
          if (message.data === "[DONE]") continue;

          try {
            const json: unknown = JSON.parse(message.data);
            const envelope = z
              .object({ type: z.string(), data: z.unknown().optional() })
              .safeParse(json);
            if (!envelope.success) continue;

            if (envelope.data.type === "job-complete") {
              const d = SignalTriggerResultSchema.safeParse(envelope.data.data);
              if (d.success) {
                result = d.data;
              }
              logger.info("workspace_signal_trigger completed", {
                workspaceId,
                signalId,
                sessionId: result.sessionId,
                status: result.status,
              });
            } else if (envelope.data.type === "job-error") {
              const d = JobErrorDataSchema.safeParse(envelope.data.data);
              const errorMsg = (d.success ? d.data.error : undefined) ?? "Unknown error";
              logger.error("workspace_signal_trigger error event", {
                workspaceId,
                signalId,
                error: errorMsg,
              });
              result = { success: false, sessionId: "", status: "error", error: errorMsg };
            } else if (isForwardableChunk(json)) {
              // Forward validated, client-safe stream events to conversation UI.
              // Only known chunk types pass the allowlist — unknown or internal
              // events (FSM lifecycle, session management) are silently dropped.
              writer.write(json);
            }
          } catch {
            logger.debug("Unparseable SSE data in signal trigger stream", { data: message.data });
          }
        }

        return result;
      } catch (error) {
        const message = stringifyError(error);
        logger.error("workspace_signal_trigger failed", { workspaceId, signalId, error: message });
        return { success: false, sessionId: "", status: "error", error: message };
      }
    },
  });
}
