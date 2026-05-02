/**
 * ProcessAgentExecutor — spawns user agent subprocesses and routes capability
 * calls via NATS.
 *
 * Execution model:
 *   1. Register session context in CapabilityHandlerRegistry
 *   2. Subscribe to agents.{sessionId}.stream to forward stream events
 *      (private subprocess→host channel; SDK >= 0.1.5 publishes here so
 *      chunks never reach the durable sessions.*.events JetStream bus)
 *   3. Subscribe to agents.{sessionId}.ready (before spawn to avoid race)
 *   4. Spawn: runtime agentPath (inherits full env + NATS_URL + FRIDAY_SESSION_ID)
 *   5. Wait for agents.{sessionId}.ready — agent publishes this after subscribing
 *   6. nc.request agents.{sessionId}.execute → get result
 *   7. Cleanup: unregister, kill process, unsubscribe subs
 */

import { spawn } from "node:child_process";
import process from "node:process";
import type { AgentExecutionSuccess, AgentResult, AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { logger as rootLogger } from "@atlas/logger";
import type { CodeAgentExecutorOptions } from "@atlas/workspace/agent-executor-utils";
import { serializeAgentContext } from "@atlas/workspace/agent-executor-utils";
import type { NatsConnection } from "nats";
import { StringCodec } from "nats";

import { buildAgentSpawnArgs } from "./agent-spawn.ts";
import type { CapabilityHandlerRegistry } from "./capability-handlers.ts";

const sc = StringCodec();
const DEFAULT_TIMEOUT_MS = 180_000;
const READY_TIMEOUT_MS = 30_000;

export class ProcessAgentExecutor {
  constructor(
    private nc: NatsConnection,
    private capabilityRegistry: CapabilityHandlerRegistry,
  ) {}

  async execute(
    agentPath: string,
    prompt: string,
    options: CodeAgentExecutorOptions,
  ): Promise<AgentResult> {
    const sessionId = options.sessionContext.id;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startTime = performance.now();

    // 1. Register session capabilities. The session's abortSignal flows through
    //    so capability handlers (mcpToolCall, llm.generate, http.fetch) can race
    //    their work against cancellation instead of running to completion after
    //    the user hit cancel.
    this.capabilityRegistry.register(sessionId, {
      streamEmitter: options.streamEmitter,
      mcpToolCall: options.mcpToolCall,
      mcpListTools: options.mcpListTools,
      agentLlmConfig: options.agentLlmConfig,
      logger: options.logger,
      abortSignal: options.abortSignal,
    });

    // 2. Subscribe to stream events from the agent on the private subprocess→host
    //    subject. Was sessions.{id}.events; that subject is bound to the SESSIONS
    //    JetStream stream, so SDK chunks corrupted the durable lifecycle replay
    //    that drives the session-detail page. agents.{id}.stream is core NATS,
    //    not bound to any JetStream filter — chunks reach the host's
    //    streamEmitter pipeline (and from there .ephemeral / chat-UI) without
    //    polluting the durable bus. Coordinated with friday-agent-sdk >= 0.1.5.
    const streamSub = this.nc.subscribe(`agents.${sessionId}.stream`);
    const streamForward = (async () => {
      for await (const msg of streamSub) {
        try {
          const chunk = JSON.parse(sc.decode(msg.data)) as AtlasUIMessageChunk;
          options.streamEmitter?.emit(chunk);
        } catch {
          // Skip malformed events
        }
      }
    })();

    // 3. Subscribe to ready signal BEFORE spawning — agent publishes this once it has
    //    subscribed to the execute subject. Must be set up first to avoid the race where
    //    the agent starts and publishes ready before we listen.
    const readySub = this.nc.subscribe(`agents.${sessionId}.ready`);
    const readyPromise = (async () => {
      for await (const _ of readySub) {
        return;
      }
    })();

    // 4. Spawn agent subprocess (polyglot: infer runtime from file extension)
    const [cmd, args] = buildAgentSpawnArgs(agentPath);
    const proc = spawn(cmd, args, {
      env: {
        ...process.env,
        ...options.env,
        NATS_URL: "nats://localhost:4222",
        FRIDAY_SESSION_ID: sessionId,
      },
      stdio: "pipe",
    });

    const stderrLines: string[] = [];
    proc.stderr?.on("data", (chunk: Uint8Array) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      stderrLines.push(...lines);
      for (const line of lines) {
        options.logger.debug("agent stderr", { line });
      }
    });

    try {
      // 5. Wait for the agent to signal it's ready (subscribed and ready to receive execute).
      //    This replaces the 503-retry loop, which breaks when any wildcard NATS subscriber
      //    (e.g. `nats sub ">"`) is present — wildcard subs prevent 503 from firing.
      await Promise.race([
        readyPromise,
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Agent did not signal ready within ${READY_TIMEOUT_MS}ms`)),
            READY_TIMEOUT_MS,
          ),
        ),
      ]);

      // 6. Agent is subscribed — send the execute request. Race against the
      //    session abortSignal so a cancel surfaces immediately instead of
      //    waiting for the full request timeout. On abort the subprocess gets
      //    SIGTERM in finally; the upstream caller sees an AbortError.
      const payload = sc.encode(
        JSON.stringify({ prompt, context: JSON.parse(serializeAgentContext(options)) }),
      );
      const requestPromise = this.nc.request(`agents.${sessionId}.execute`, payload, {
        timeout: timeoutMs,
      });
      const response = await (options.abortSignal
        ? Promise.race([
            requestPromise,
            new Promise<never>((_, reject) => {
              if (options.abortSignal!.aborted) {
                reject(new DOMException("Aborted", "AbortError"));
                return;
              }
              options.abortSignal!.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            }),
          ])
        : requestPromise);

      const result = JSON.parse(sc.decode(response.data)) as { tag: string; val: string };
      const durationMs = performance.now() - startTime;

      if (result.tag === "ok") {
        let data: unknown = result.val;
        let artifactRefs: unknown[] | undefined;
        let outlineRefs: unknown[] | undefined;
        let reasoning: string | undefined;

        try {
          const parsed = JSON.parse(result.val) as Record<string, unknown>;
          if (parsed !== null && typeof parsed === "object" && "data" in parsed) {
            data = parsed.data;
            artifactRefs = parsed.artifactRefs as unknown[] | undefined;
            outlineRefs = parsed.outlineRefs as unknown[] | undefined;
            reasoning = parsed.reasoning as string | undefined;
          }
        } catch {
          // Not JSON — use raw string as data
        }

        return {
          agentId: sessionId,
          timestamp: new Date().toISOString(),
          input: prompt,
          ok: true,
          data,
          artifactRefs: artifactRefs as AgentExecutionSuccess["artifactRefs"],
          outlineRefs: outlineRefs as AgentExecutionSuccess["outlineRefs"],
          reasoning,
          durationMs,
        };
      } else {
        return {
          agentId: sessionId,
          timestamp: new Date().toISOString(),
          input: prompt,
          ok: false,
          error: { reason: result.val ?? "Agent returned an error" },
          durationMs,
        };
      }
    } catch (error) {
      const durationMs = performance.now() - startTime;
      const stderr = stderrLines.join("\n");
      const reason = error instanceof Error ? error.message : String(error);
      rootLogger.error("ProcessAgentExecutor: agent failed", {
        sessionId,
        agentPath,
        error: reason,
        stderr,
      });
      return {
        agentId: sessionId,
        timestamp: new Date().toISOString(),
        input: prompt,
        ok: false,
        error: { reason: `Agent execution failed: ${reason}${stderr ? `\n${stderr}` : ""}` },
        durationMs,
      };
    } finally {
      // 7. Cleanup
      this.capabilityRegistry.unregister(sessionId);
      readySub.unsubscribe();
      streamSub.unsubscribe();
      await streamForward.catch(() => {}); // drain loop

      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          // Subprocess didn't exit within 2s — escalate to SIGKILL so a hung
          // user agent (deadlock, infinite loop, etc.) doesn't keep the
          // executor blocked.
          if (proc.exitCode === null && proc.signalCode === null) {
            proc.kill("SIGKILL");
          }
          resolve();
        }, 2_000);
        proc.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }
}
