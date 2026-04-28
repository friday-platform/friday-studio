/**
 * Atlas TypeScript Agent SDK.
 *
 * Agents speak the same NATS protocol as the Python SDK:
 *   - Capability back-channel: `caps.{sessionId}.{capability}`
 *   - Execution request:       `agents.{sessionId}.execute` (request/reply)
 *   - Stream events:           `sessions.{sessionId}.events` (publish)
 *
 * Usage:
 *   ```ts
 *   import { agent, ok, err } from "@atlas/sdk-ts";
 *
 *   agent({ id: "my-agent", version: "1.0.0" }, async (prompt, ctx) => {
 *     const result = await ctx.llm.generate({ messages: [{ role: "user", content: prompt }] });
 *     return ok(result.text);
 *   });
 *   ```
 *
 * The agent auto-runs when `FRIDAY_SESSION_ID` is set in the environment
 * (production mode). In tests without the env var, `agent()` is a no-op
 * so handler logic can be exercised independently.
 *
 * @module
 */

import process from "node:process";
import { connect, StringCodec } from "nats";
import { buildContext } from "./context.ts";
import type { AgentHandler, AgentMeta, AgentResult, ErrResult, OkResult } from "./types.ts";

export type {
  AgentContext,
  AgentHandler,
  AgentMeta,
  AgentResult,
  AgentSkill,
  ErrResult,
  OkResult,
  SessionData,
  ToolDefinition,
} from "./types.ts";

const sc = StringCodec();

let _meta: AgentMeta | null = null;
let _handler: AgentHandler | null = null;

/**
 * Register an agent handler. Auto-runs when env vars are set:
 *   FRIDAY_VALIDATE_ID — validation handshake: publish metadata then exit
 *   FRIDAY_SESSION_ID  — normal execution: handle one request then exit
 */
export function agent(meta: AgentMeta, handler: AgentHandler): void {
  _meta = meta;
  _handler = handler;

  const validateId = process.env.FRIDAY_VALIDATE_ID;
  if (validateId) {
    void _validate(validateId).catch((err) => {
      process.stderr.write(
        `Agent validate failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
    return;
  }

  const sessionId = process.env.FRIDAY_SESSION_ID;
  if (sessionId) {
    void _run(sessionId).catch((err) => {
      process.stderr.write(
        `Agent run failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
  }
}

/**
 * Build an `ok` result. `data` is the agent's output (any serializable value).
 * Optional `extras` add structured metadata (reasoning, artifact/outline refs).
 */
export function ok(
  data: unknown,
  extras?: { reasoning?: string; artifactRefs?: unknown[]; outlineRefs?: unknown[] },
): OkResult {
  const inner: Record<string, unknown> = { data };
  if (extras?.reasoning !== undefined) inner.reasoning = extras.reasoning;
  if (extras?.artifactRefs !== undefined) inner.artifactRefs = extras.artifactRefs;
  if (extras?.outlineRefs !== undefined) inner.outlineRefs = extras.outlineRefs;
  return { tag: "ok", val: JSON.stringify(inner) };
}

/**
 * Build an `err` result with an error message.
 */
export function err(message: string): ErrResult {
  return { tag: "err", val: message };
}

async function _validate(validateId: string): Promise<void> {
  const natsUrl = process.env.NATS_URL ?? "nats://localhost:4222";
  const nc = await connect({ servers: natsUrl });
  const meta = _meta;
  if (!meta) throw new Error("No agent registered");
  try {
    nc.publish(`agents.validate.${validateId}`, sc.encode(JSON.stringify(meta)));
  } finally {
    await nc.drain();
  }
}

async function _run(sessionId: string): Promise<void> {
  const natsUrl = process.env.NATS_URL ?? "nats://localhost:4222";
  const nc = await connect({ servers: natsUrl });

  try {
    const sub = nc.subscribe(`agents.${sessionId}.execute`);

    // Single-shot: handle exactly one message then exit (spawn-per-call model)
    for await (const msg of sub) {
      let response: AgentResult;

      try {
        const raw: unknown = JSON.parse(sc.decode(msg.data));
        if (typeof raw !== "object" || raw === null || !("prompt" in raw) || !("context" in raw)) {
          response = err("Invalid execute payload: missing prompt or context");
        } else {
          const prompt = String((raw as { prompt: unknown }).prompt);
          const contextRaw = (raw as { context: Record<string, unknown> }).context;

          if (typeof contextRaw !== "object" || contextRaw === null) {
            response = err("Invalid execute payload: context must be an object");
          } else {
            const handler = _handler;
            if (!handler) {
              response = err("No agent handler registered");
            } else {
              const ctx = buildContext(contextRaw, nc, sessionId);
              response = await Promise.resolve(handler(prompt, ctx));
            }
          }
        }
      } catch (handlerErr) {
        response = err(handlerErr instanceof Error ? handlerErr.message : String(handlerErr));
      }

      if (msg.reply) {
        nc.publish(msg.reply, sc.encode(JSON.stringify(response)));
      }
      sub.unsubscribe();
      break;
    }
  } finally {
    await nc.drain();
  }
}

/** Exported for testing: exposes run loop without going through process.env check. */
export { _run as runForTesting };
