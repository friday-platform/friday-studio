/**
 * ProcessAgentExecutor — spawns Python agent subprocesses and routes capability
 * calls via NATS. Replaces CodeAgentExecutor (WASM dynamic-import model).
 *
 * Execution model:
 *   1. Register session context in CapabilityHandlerRegistry
 *   2. Subscribe to sessions.{sessionId}.events to forward stream events
 *   3. Spawn: python3 agentPath (inherits env + NATS_URL + ATLAS_SESSION_ID)
 *   4. nc.request agents.{sessionId}.execute → get result
 *   5. Cleanup: unregister, kill process, unsubscribe stream sub
 */

import { spawn } from "node:child_process";
import type { AgentExecutionSuccess, AgentResult, AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { logger as rootLogger } from "@atlas/logger";
import type { CodeAgentExecutorOptions } from "@atlas/workspace/code-agent-executor";
import { serializeAgentContext } from "@atlas/workspace/code-agent-executor";
import type { NatsConnection } from "nats";
import { StringCodec } from "nats";
import type { CapabilityHandlerRegistry } from "./capability-handlers.ts";

const sc = StringCodec();
const DEFAULT_TIMEOUT_MS = 180_000;

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

    // 1. Register session capabilities
    this.capabilityRegistry.register(sessionId, {
      streamEmitter: options.streamEmitter,
      mcpToolCall: options.mcpToolCall,
      mcpListTools: options.mcpListTools,
      agentLlmConfig: options.agentLlmConfig,
      logger: options.logger,
      abortSignal: undefined,
    });

    // 2. Subscribe to stream events from the agent (bridging to streamEmitter until Phase 5)
    const streamSub = this.nc.subscribe(`sessions.${sessionId}.events`);
    const streamForward = (async () => {
      for await (const msg of streamSub) {
        try {
          const chunk = JSON.parse(sc.decode(msg.data)) as AtlasUIMessageChunk;
          options.streamEmitter?.emit({
            type: chunk.type,
            data: (chunk as Record<string, unknown>).data as Record<string, unknown>,
          });
        } catch {
          // Skip malformed events
        }
      }
    })();

    // 3. Spawn agent subprocess
    const proc = spawn("python3", [agentPath], {
      env: { ...options.env, NATS_URL: "nats://localhost:4222", ATLAS_SESSION_ID: sessionId },
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
      // 4. Send execute request — agent subscribes, handles, responds, exits
      const response = await this.nc.request(
        `agents.${sessionId}.execute`,
        sc.encode(JSON.stringify({ prompt, context: JSON.parse(serializeAgentContext(options)) })),
        { timeout: timeoutMs },
      );

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
      // 5. Cleanup
      this.capabilityRegistry.unregister(sessionId);
      streamSub.unsubscribe();
      await streamForward.catch(() => {}); // drain loop

      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 2_000);
        proc.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }
}
