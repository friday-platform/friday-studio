/**
 * Standalone tool worker process.
 *
 * Connects to NATS (FRIDAY_NATS_URL or default localhost:4222) and registers
 * the known tool handlers. Stays running until SIGINT / SIGTERM.
 *
 * Useful even single-node:
 *   - Process isolation. A misbehaving tool (leak, runaway) can be killed and
 *     restarted without taking down the daemon.
 *   - Resource limits. ulimit / cgroup constraints applied to the worker
 *     process don't affect the daemon's other work.
 *   - Multi-worker scaling. Run N copies for parallelism on heavy tools;
 *     the SIGNALS workQueue + queue-grouped tools.<id>.call subjects
 *     load-balance automatically.
 *   - Sandbox preparation. Same entry runs unchanged inside a Docker /
 *     Firecracker / remote container when isolation matures.
 *
 * Run:
 *   deno run -A apps/atlasd/src/tool-worker-entry.ts
 *
 * Env:
 *   FRIDAY_NATS_URL — broker to connect to (default nats://localhost:4222)
 *   FRIDAY_WORKER_TOOLS — comma-separated allowlist (default: all known tools)
 */

import process from "node:process";
import { logger } from "@atlas/logger";
import {
  BashArgsSchema,
  executeBash,
  executeWebfetch,
  WebfetchArgsSchema,
} from "@atlas/mcp-server";
import { connect, type NatsConnection } from "nats";
import { registerToolWorker, type ToolHandler, type ToolWorker } from "./tool-dispatch.ts";

interface ToolHandlerSpec {
  toolId: string;
  handle: ToolHandler;
}

const handlers: ToolHandlerSpec[] = [
  {
    toolId: "bash",
    handle: (req, ctx) =>
      executeBash(BashArgsSchema.parse(req.args), { abortSignal: ctx.abortSignal }),
  },
  {
    toolId: "webfetch",
    handle: (req, ctx) =>
      executeWebfetch(WebfetchArgsSchema.parse(req.args), { abortSignal: ctx.abortSignal }),
  },
];

function selectHandlers(allowlist: string | undefined): ToolHandlerSpec[] {
  if (!allowlist) return handlers;
  const allowed = new Set(
    allowlist
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return handlers.filter((h) => allowed.has(h.toolId));
}

export async function startToolWorkerProcess(opts?: {
  natsUrl?: string;
  toolsAllowlist?: string;
}): Promise<{ nc: NatsConnection; workers: ToolWorker[]; stop: () => Promise<void> }> {
  const natsUrl = opts?.natsUrl ?? process.env.FRIDAY_NATS_URL ?? "nats://localhost:4222";
  const allowlist = opts?.toolsAllowlist ?? process.env.FRIDAY_WORKER_TOOLS;
  const selected = selectHandlers(allowlist);

  logger.info("Tool worker connecting", { natsUrl, tools: selected.map((s) => s.toolId) });
  const nc = await connect({ servers: natsUrl });
  const workers = selected.map((s) => registerToolWorker(nc, s.toolId, s.handle));
  // Wait for all SUB protocol messages to flush before signalling readiness —
  // otherwise a caller dispatching immediately after this resolves can race
  // the server-side subscription registration and see NatsError 503.
  await Promise.all(workers.map((w) => w.ready));
  logger.info("Tool worker registered", { tools: workers.map((w) => w.toolId) });

  return {
    nc,
    workers,
    async stop() {
      for (const worker of workers) {
        try {
          await worker.stop();
        } catch (err) {
          logger.warn("Failed to stop worker", { toolId: worker.toolId, error: String(err) });
        }
      }
      try {
        await nc.drain();
      } catch {
        // Already draining
      }
    },
  };
}

if (import.meta.main) {
  const { stop } = await startToolWorkerProcess();

  const handleSignal = async (sig: string) => {
    logger.info(`Tool worker received ${sig}, shutting down`);
    await stop();
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGINT", () => void handleSignal("SIGINT"));
  Deno.addSignalListener("SIGTERM", () => void handleSignal("SIGTERM"));

  await new Promise<void>(() => {});
}
