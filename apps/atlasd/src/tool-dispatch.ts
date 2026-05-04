/**
 * NATS-mediated tool dispatch substrate.
 *
 * Subjects: `tools.<tool-id>.call` carry tool-call requests; the broker's
 * request/reply shape (auto-routed reply inbox) carries the response.
 *
 * The agent runtime publishes a tool call; a tool worker subscribed to the
 * subject executes (in-process today, in a sandboxed container later) and
 * replies. Workers register with `registerToolWorker(nc, toolId, handler)`;
 * callers dispatch with `callTool(nc, toolId, args, opts)`.
 *
 * The substrate is intentionally minimal — auth/credential injection,
 * resource limits, and sandbox-runtime concerns layer on top.
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

export function toolCancelSubject(toolId: string, requestId: string): string {
  return `tools.${sanitizeToolId(toolId)}.cancel.${requestId}`;
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
  /**
   * Caller-generated id (UUID) used for cancellation. The worker subscribes
   * to `tools.<toolId>.cancel.<requestId>`; publishing on that subject aborts
   * the in-flight handler on the worker side.
   */
  requestId: z.string().min(1),
});
export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;

// Reply discriminated union — the success/error halves are private; no
// caller composes them independently. Keep the union itself exported.
const ToolCallSuccessSchema = z.object({
  ok: z.literal(true),
  result: z.unknown(),
  durationMs: z.number(),
});

const ToolCallErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
  durationMs: z.number(),
});

export const ToolCallReplySchema = z.discriminatedUnion("ok", [
  ToolCallSuccessSchema,
  ToolCallErrorSchema,
]);
export type ToolCallReply = z.infer<typeof ToolCallReplySchema>;

export type ToolHandler = (
  req: ToolCallRequest,
  ctx: { abortSignal: AbortSignal },
) => Promise<unknown>;

export interface CallToolOptions {
  workspaceId: string;
  sessionId: string;
  callerAgentId: string;
  credentialsRef?: string;
  traceId?: string;
  /** Wait at most this long for the worker reply. Defaults to 30s. */
  timeoutMs?: number;
  /**
   * When aborted, the caller publishes a cancel envelope on
   * `tools.<toolId>.cancel.<requestId>` and stops waiting for the reply.
   * The worker observes the cancel and aborts its in-flight handler
   * (subprocess kill / fetch abort / etc).
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
  const requestId = crypto.randomUUID();
  const request: ToolCallRequest = {
    toolId,
    args,
    workspaceId: opts.workspaceId,
    sessionId: opts.sessionId,
    callerAgentId: opts.callerAgentId,
    credentialsRef: opts.credentialsRef,
    publishedAt: new Date().toISOString(),
    traceId: opts.traceId,
    requestId,
  };

  const h = natsHeaders();
  h.set("Friday-Schema-Version", SCHEMA_VERSION);
  if (opts.traceId) h.set("Friday-Trace-Id", opts.traceId);

  const requestPromise = nc.request(toolCallSubject(toolId), enc.encode(JSON.stringify(request)), {
    timeout: opts.timeoutMs ?? 30_000,
    headers: h,
  });

  // On abort, publish a cancel envelope so the worker can stop its in-flight
  // handler, then reject the await. Fire-and-forget — the worker's reply
  // (success or aborted-error) will arrive via requestPromise either way.
  let abortHandler: (() => void) | undefined;
  const abortPromise: Promise<never> | null = opts.abortSignal
    ? new Promise<never>((_, reject) => {
        const fire = () => {
          try {
            nc.publish(toolCancelSubject(toolId, requestId), enc.encode("{}"));
          } catch (err) {
            logger.warn("Failed to publish tool cancel", {
              toolId,
              requestId,
              error: stringifyError(err),
            });
          }
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (opts.abortSignal!.aborted) {
          fire();
          return;
        }
        abortHandler = fire;
        opts.abortSignal!.addEventListener("abort", abortHandler, { once: true });
      })
    : null;

  try {
    const reply = await (abortPromise
      ? Promise.race([requestPromise, abortPromise])
      : requestPromise);
    return ToolCallReplySchema.parse(JSON.parse(dec.decode(reply.data)));
  } finally {
    if (abortHandler) opts.abortSignal?.removeEventListener("abort", abortHandler);
  }
}

export interface ToolWorker {
  toolId: string;
  /**
   * Resolves once the queue-group subscription is registered server-side.
   * `nc.subscribe` returns before the SUB protocol message is flushed —
   * publishers calling `callTool` immediately can otherwise see all messages
   * routed to whichever worker registered first. Await this when you need
   * deterministic queue-group distribution (tests; fast-startup orchestrators
   * spawning N workers + dispatching).
   */
  ready: Promise<void>;
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

  // In-flight request controllers, keyed by requestId. The cancel-subject
  // listener flips a controller's signal; the handler observes and aborts.
  const inflight = new Map<string, AbortController>();

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

      const controller = new AbortController();
      inflight.set(parsed.requestId, controller);
      // Subscribe per-request to the matching cancel subject. Auto-unsubscribes
      // after one message; the controller is also cleaned up in the finally.
      const cancelSub = nc.subscribe(toolCancelSubject(toolId, parsed.requestId), { max: 1 });
      const cancelLoop = (async () => {
        for await (const _ of cancelSub) {
          controller.abort(new DOMException("Tool call cancelled by caller", "AbortError"));
          break;
        }
      })();
      cancelLoop.catch(() => {
        // Subscription closed cleanly when we unsubscribe in finally — ignore.
      });
      // Subscribe() returns before the server registers the SUB; without
      // a flush, a cancel published immediately could be missed (max:1
      // sub with no queue means undelivered messages are dropped).
      await nc.flush();

      try {
        const result = await handler(parsed, { abortSignal: controller.signal });
        const okReply = ToolCallReplySchema.parse({
          ok: true,
          result,
          durationMs: Date.now() - startedAt,
        });
        nc.publish(replyTo, enc.encode(JSON.stringify(okReply)));
      } catch (err) {
        const message = stringifyError(err);
        const code = controller.signal.aborted
          ? "ABORTED"
          : err instanceof Error && "code" in err && typeof err.code === "string"
            ? err.code
            : "TOOL_ERROR";
        const errReply = ToolCallReplySchema.parse({
          ok: false,
          error: { code, message },
          durationMs: Date.now() - startedAt,
        });
        nc.publish(replyTo, enc.encode(JSON.stringify(errReply)));
      } finally {
        inflight.delete(parsed.requestId);
        cancelSub.unsubscribe();
      }
    }
  })();
  loop.catch((err: unknown) => {
    logger.error("Tool worker loop crashed", { toolId, error: stringifyError(err) });
  });

  return {
    toolId,
    ready: nc.flush(),
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
