/**
 * CapabilityHandlerRegistry — daemon-side NATS capability back-channel.
 *
 * Registers four long-lived wildcard subscribers at startup. Session context
 * is looked up by session ID (subject segment [1]) so we avoid per-session
 * subscription churn.
 */

import type { AgentLLMConfig } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { logger as rootLogger } from "@atlas/logger";
import {
  type CodeAgentStreamEmitter,
  createHttpFetchHandler,
  createLlmGenerateHandler,
} from "@atlas/workspace/code-agent-executor";
import type { NatsConnection, Subscription } from "nats";
import { StringCodec } from "nats";

const sc = StringCodec();

export interface CapabilityContext {
  streamEmitter?: CodeAgentStreamEmitter;
  mcpToolCall: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  mcpListTools: () => Promise<Array<{ name: string; description: string; inputSchema: unknown }>>;
  agentLlmConfig?: AgentLLMConfig;
  logger: Logger;
  abortSignal?: AbortSignal;
}

export class CapabilityHandlerRegistry {
  private sessions = new Map<string, CapabilityContext>();
  private subs: Subscription[] = [];

  register(sessionId: string, ctx: CapabilityContext): void {
    this.sessions.set(sessionId, ctx);
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  start(nc: NatsConnection): void {
    this.subs.push(
      nc.subscribe("caps.*.llm.generate", { callback: (err, msg) => this.handleLlm(err, msg, nc) }),
      nc.subscribe("caps.*.http.fetch", { callback: (err, msg) => this.handleHttp(err, msg, nc) }),
      nc.subscribe("caps.*.tools.call", {
        callback: (err, msg) => this.handleToolCall(err, msg, nc),
      }),
      nc.subscribe("caps.*.tools.list", {
        callback: (err, msg) => this.handleToolList(err, msg, nc),
      }),
    );
    rootLogger.info("Capability handlers registered", {
      subjects: [
        "caps.*.llm.generate",
        "caps.*.http.fetch",
        "caps.*.tools.call",
        "caps.*.tools.list",
      ],
    });
  }

  stop(): void {
    for (const sub of this.subs) sub.unsubscribe();
    this.subs = [];
  }

  private sessionFromSubject(subject: string): CapabilityContext | undefined {
    const sessionId = subject.split(".")[1];
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  private respond(nc: NatsConnection, msg: { reply?: string }, payload: string): void {
    if (msg.reply) {
      nc.publish(msg.reply, sc.encode(payload));
    }
  }

  private handleLlm = (
    err: Error | null,
    msg: { subject: string; data: Uint8Array; reply?: string },
    nc: NatsConnection,
  ): void => {
    if (err) return;
    const ctx = this.sessionFromSubject(msg.subject);
    if (!ctx) {
      this.respond(nc, msg, JSON.stringify({ error: "unknown session" }));
      return;
    }

    const handler = createLlmGenerateHandler({
      agentLlmConfig: ctx.agentLlmConfig,
      streamEmitter: ctx.streamEmitter,
      abortSignal: ctx.abortSignal,
      logger: ctx.logger,
    });

    handler(sc.decode(msg.data))
      .then((result) => this.respond(nc, msg, result))
      .catch((e) =>
        this.respond(
          nc,
          msg,
          JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
        ),
      );
  };

  private handleHttp = (
    err: Error | null,
    msg: { subject: string; data: Uint8Array; reply?: string },
    nc: NatsConnection,
  ): void => {
    if (err) return;
    const ctx = this.sessionFromSubject(msg.subject);
    if (!ctx) {
      this.respond(nc, msg, JSON.stringify({ error: "unknown session" }));
      return;
    }

    const handler = createHttpFetchHandler({ logger: ctx.logger });

    handler(sc.decode(msg.data))
      .then((result) => this.respond(nc, msg, result))
      .catch((e) =>
        this.respond(
          nc,
          msg,
          JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
        ),
      );
  };

  private handleToolCall = (
    err: Error | null,
    msg: { subject: string; data: Uint8Array; reply?: string },
    nc: NatsConnection,
  ): void => {
    if (err) return;
    const ctx = this.sessionFromSubject(msg.subject);
    if (!ctx) {
      this.respond(nc, msg, JSON.stringify({ error: "unknown session" }));
      return;
    }

    let parsed: { name: string; args: Record<string, unknown> };
    try {
      parsed = JSON.parse(sc.decode(msg.data)) as typeof parsed;
    } catch {
      this.respond(nc, msg, JSON.stringify({ error: "invalid tool call payload" }));
      return;
    }

    ctx
      .mcpToolCall(parsed.name, parsed.args)
      .then((result) => this.respond(nc, msg, JSON.stringify(result)))
      .catch((e) =>
        this.respond(
          nc,
          msg,
          JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
        ),
      );
  };

  private handleToolList = (
    err: Error | null,
    msg: { subject: string; data: Uint8Array; reply?: string },
    nc: NatsConnection,
  ): void => {
    if (err) return;
    const ctx = this.sessionFromSubject(msg.subject);
    if (!ctx) {
      this.respond(nc, msg, JSON.stringify({ error: "unknown session" }));
      return;
    }

    ctx
      .mcpListTools()
      .then((tools) => this.respond(nc, msg, JSON.stringify({ tools })))
      .catch((e) =>
        this.respond(
          nc,
          msg,
          JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
        ),
      );
  };
}
