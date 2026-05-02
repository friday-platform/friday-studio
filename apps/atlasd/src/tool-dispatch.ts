/**
 * NATS-mediated tool dispatch substrate (G3.10).
 *
 * Subjects: `tools.<tool-id>.call` carry tool-call requests; the broker's
 * request/reply shape (auto-routed reply inbox) carries the response.
 *
 * The agent runtime publishes a tool call; a tool worker subscribed to the
 * subject executes (in-process today, in a sandboxed container later) and
 * replies. Workers register with `registerToolWorker(nc, toolId, handler)`;
 * callers dispatch with `callTool(nc, toolId, args, opts)`.
 *
 * The substrate is intentionally minimal — the auth/credential-injection,
 * resource-limit, and sandbox-runtime concerns described in G3.10 are
 * layered on top of this in subsequent commits.
 */

import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { type NatsConnection, headers as natsHeaders, type Subscription } from "nats";
import { z } from "zod";

const SCHEMA_VERSION = "1";
const enc = new TextEncoder();
const dec = new TextDecoder();

const SAFE_TOOL_ID_RE = /[^A-Za-z0-9_-]/g;
const sanitizeToolId = (s: string) => s.replace(SAFE_TOOL_ID_RE, "_");

export function toolCallSubject(toolId: string): string {
  return `tools.${sanitizeToolId(toolId)}.call`;
}

export const ToolCallRequestSchema = z.object({
  toolId: z.string().min(1),
  args: z.unknown(),
  /** Workspace + session of the agent making the call (for credential scoping). */
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
  /** Agent that initiated the call — included for audit + credential scope. */
  callerAgentId: z.string().min(1),
  /** Reference resolved by the worker against Link or another credential broker. */
  credentialsRef: z.string().optional(),
  /** ISO 8601; populated by callTool. */
  publishedAt: z.string().datetime(),
  /** Optional opaque trace id propagated from the cascade. */
  traceId: z.string().optional(),
});
export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;

export const ToolCallSuccessSchema = z.object({
  ok: z.literal(true),
  result: z.unknown(),
  durationMs: z.number(),
});

export const ToolCallErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
  durationMs: z.number(),
});

export const ToolCallReplySchema = z.discriminatedUnion("ok", [
  ToolCallSuccessSchema,
  ToolCallErrorSchema,
]);
export type ToolCallReply = z.infer<typeof ToolCallReplySchema>;

export type ToolHandler = (req: ToolCallRequest) => Promise<unknown>;

export interface CallToolOptions {
  workspaceId: string;
  sessionId: string;
  callerAgentId: string;
  credentialsRef?: string;
  traceId?: string;
  /** Wait at most this long for the worker reply. Defaults to 30s. */
  timeoutMs?: number;
  /**
   * When aborted, the caller stops waiting for the worker reply. The worker's
   * in-flight execution is NOT cancelled (NATS request/reply has no abort
   * channel today); this just unblocks the caller so the cancel surfaces
   * upstream. Worker-side cancellation would need a separate `tools.<id>.cancel`
   * subject — flagged as follow-up.
   */
  abortSignal?: AbortSignal;
}

/**
 * Publish a tool-call request and await the worker's reply.
 *
 * Throws if no worker handles the subject within the timeout, or if the
 * reply is malformed. Returns a structured success/error envelope so the
 * caller can distinguish "tool ran and returned an error" (envelope.ok=false)
 * from "couldn't reach a tool worker" (this throws).
 */
export async function callTool(
  nc: NatsConnection,
  toolId: string,
  args: unknown,
  opts: CallToolOptions,
): Promise<ToolCallReply> {
  const request: ToolCallRequest = {
    toolId,
    args,
    workspaceId: opts.workspaceId,
    sessionId: opts.sessionId,
    callerAgentId: opts.callerAgentId,
    credentialsRef: opts.credentialsRef,
    publishedAt: new Date().toISOString(),
    traceId: opts.traceId,
  };

  const h = natsHeaders();
  h.set("Friday-Schema-Version", SCHEMA_VERSION);
  if (opts.traceId) h.set("Friday-Trace-Id", opts.traceId);

  const requestPromise = nc.request(toolCallSubject(toolId), enc.encode(JSON.stringify(request)), {
    timeout: opts.timeoutMs ?? 30_000,
    headers: h,
  });

  const reply = await (opts.abortSignal
    ? Promise.race([
        requestPromise,
        new Promise<never>((_, reject) => {
          if (opts.abortSignal!.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          opts.abortSignal!.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
      ])
    : requestPromise);

  return ToolCallReplySchema.parse(JSON.parse(dec.decode(reply.data)));
}

export interface ToolWorker {
  toolId: string;
  stop(): Promise<void>;
}

/**
 * Register a tool worker subscribed to the call subject. Each request the
 * subject receives is decoded, passed to `handler`, and the result is
 * replied to the broker's auto-issued reply inbox. Worker errors are
 * caught and surfaced as a structured error envelope so the caller's
 * `callTool` always resolves (or times out) cleanly.
 */
export function registerToolWorker(
  nc: NatsConnection,
  toolId: string,
  handler: ToolHandler,
): ToolWorker {
  const subject = toolCallSubject(toolId);
  const sub: Subscription = nc.subscribe(subject, { queue: `tool-workers.${toolId}` });

  const loop = (async () => {
    for await (const msg of sub) {
      const replyTo = msg.reply;
      if (!replyTo) {
        logger.warn("Tool call missing reply subject", { toolId, subject: msg.subject });
        continue;
      }

      const startedAt = Date.now();
      let parsed: ToolCallRequest;
      try {
        parsed = ToolCallRequestSchema.parse(JSON.parse(dec.decode(msg.data)));
      } catch (err) {
        const errReply = ToolCallReplySchema.parse({
          ok: false,
          error: { code: "INVALID_REQUEST", message: stringifyError(err) },
          durationMs: Date.now() - startedAt,
        });
        nc.publish(replyTo, enc.encode(JSON.stringify(errReply)));
        continue;
      }

      try {
        const result = await handler(parsed);
        const okReply = ToolCallReplySchema.parse({
          ok: true,
          result,
          durationMs: Date.now() - startedAt,
        });
        nc.publish(replyTo, enc.encode(JSON.stringify(okReply)));
      } catch (err) {
        const message = stringifyError(err);
        const code =
          err instanceof Error && "code" in err && typeof err.code === "string"
            ? err.code
            : "TOOL_ERROR";
        const errReply = ToolCallReplySchema.parse({
          ok: false,
          error: { code, message },
          durationMs: Date.now() - startedAt,
        });
        nc.publish(replyTo, enc.encode(JSON.stringify(errReply)));
      }
    }
  })();
  loop.catch((err: unknown) => {
    logger.error("Tool worker loop crashed", { toolId, error: stringifyError(err) });
  });

  return {
    toolId,
    async stop() {
      sub.unsubscribe();
      try {
        await loop;
      } catch {
        // Already logged
      }
    },
  };
}
