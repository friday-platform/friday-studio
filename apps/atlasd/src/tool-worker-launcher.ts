/**
 * Tool worker launcher.
 *
 * Spawns one or more tool workers into a configurable sandbox runtime. The
 * worker process itself is identical across runtimes — the launcher's job
 * is to wrap `scripts/run-tool-worker.sh` with the right runtime-specific
 * spawn invocation:
 *
 *   - "subprocess" (default, local): plain child_process.spawn. No isolation.
 *     Right for solo dev / single-user installs where the user trusts the
 *     code they're running.
 *   - "microvm": placeholder for a minimal.dev / Firecracker-style runner.
 *     The script path is forwarded to the runtime's `exec` interface; the
 *     runtime is responsible for filesystem mount, network policy, and
 *     resource limits. Implementation TBD — declared here so callers can
 *     opt in by config without changing call sites.
 *   - "k8s": placeholder for `kubectl run` / a Job manifest. Suitable for
 *     cloud / multi-tenant deployments where workers need network and
 *     compute isolation enforced by the cluster.
 *
 * The "subprocess" path is the one that ships today; the others throw with
 * a clear "configure FRIDAY_TOOL_WORKER_RUNTIME" message until their adapters
 * land. This keeps the call sites stable so the daemon can move from
 * subprocess → microvm → k8s by changing configuration, not code.
 */

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { logger } from "@atlas/logger";

export type ToolWorkerRuntime = "subprocess" | "microvm" | "k8s";

export interface ToolWorkerSpec {
  /** Runtime to spawn into. Defaults to env or "subprocess". */
  runtime?: ToolWorkerRuntime;
  /** NATS URL the worker connects to. Forwarded as FRIDAY_NATS_URL. */
  natsUrl?: string;
  /** Comma-separated tool allowlist. Forwarded as FRIDAY_WORKER_TOOLS. */
  toolsAllowlist?: string;
  /**
   * Override the worker entrypoint command. Forwarded as FRIDAY_WORKER_CMD;
   * when set, the launch script execs it verbatim instead of running our
   * bundled deno-based tool-worker-entry. Use this for MCP-server bridges
   * (`uv run ...`, `npx ...`) or precompiled worker binaries.
   */
  workerCmd?: string;
  /** Extra env to layer onto the worker process. */
  env?: Record<string, string>;
  /** Override the launch script path. Defaults to scripts/run-tool-worker.sh. */
  scriptPath?: string;
}

export interface ToolWorkerHandle {
  runtime: ToolWorkerRuntime;
  /** PID of the spawned worker (subprocess only). Undefined for remote runtimes. */
  pid?: number;
  /**
   * Stop the worker. SIGTERM for subprocess; runtime-specific delete for
   * microvm/k8s. Idempotent — safe to call multiple times.
   */
  stop(): Promise<void>;
}

const DEFAULT_RUNTIME: ToolWorkerRuntime =
  (process.env.FRIDAY_TOOL_WORKER_RUNTIME as ToolWorkerRuntime | undefined) ?? "subprocess";

function resolveScriptPath(spec: ToolWorkerSpec): string {
  if (spec.scriptPath) return spec.scriptPath;
  // Walk up from this file's directory to the repo root, then into scripts/.
  // (apps/atlasd/src/tool-worker-launcher.ts → ../../../scripts/run-tool-worker.sh)
  const here = new URL(".", import.meta.url).pathname;
  return path.resolve(here, "../../../scripts/run-tool-worker.sh");
}

function buildEnv(spec: ToolWorkerSpec): Record<string, string> {
  const env: Record<string, string> = {};
  // Inherit only the strings we care about — don't blanket-pass parent env
  // into a sandbox we want to keep clean. The caller can opt extra in via
  // spec.env.
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TZ", "LANG", "LC_ALL"]) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  if (spec.natsUrl) env.FRIDAY_NATS_URL = spec.natsUrl;
  if (spec.toolsAllowlist) env.FRIDAY_WORKER_TOOLS = spec.toolsAllowlist;
  if (spec.workerCmd) env.FRIDAY_WORKER_CMD = spec.workerCmd;
  if (spec.env) Object.assign(env, spec.env);
  return env;
}

/**
 * Spawn a worker as a plain child process. No isolation. Stdout/stderr
 * stream into the daemon's logger so worker logs land in the same place
 * as everything else.
 */
function spawnSubprocess(spec: ToolWorkerSpec): ToolWorkerHandle {
  const script = resolveScriptPath(spec);
  const env = buildEnv(spec);
  const proc: ChildProcess = spawn(script, [], { env, stdio: ["ignore", "pipe", "pipe"] });

  proc.stdout?.on("data", (chunk: Uint8Array) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      logger.info("tool-worker stdout", { line, pid: proc.pid });
    }
  });
  proc.stderr?.on("data", (chunk: Uint8Array) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      logger.warn("tool-worker stderr", { line, pid: proc.pid });
    }
  });
  proc.on("exit", (code, signal) => {
    logger.info("tool-worker exited", { code, signal, pid: proc.pid });
  });

  let stopped = false;
  return {
    runtime: "subprocess",
    pid: proc.pid,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          // Hung worker → SIGKILL escalation, same pattern as ProcessAgentExecutor.
          if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
          resolve();
        }, 2_000);
        proc.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}

function spawnMicrovm(_spec: ToolWorkerSpec): ToolWorkerHandle {
  throw new Error(
    "FRIDAY_TOOL_WORKER_RUNTIME=microvm is not implemented. " +
      "Wire spawnMicrovm to the local minimal.dev / Firecracker runtime " +
      "and have it `exec` scripts/run-tool-worker.sh inside the VM.",
  );
}

function spawnK8s(_spec: ToolWorkerSpec): ToolWorkerHandle {
  throw new Error(
    "FRIDAY_TOOL_WORKER_RUNTIME=k8s is not implemented. " +
      "Wire spawnK8s to a Job/Pod creator that mounts scripts/run-tool-worker.sh " +
      "as the entrypoint and forwards FRIDAY_NATS_URL / FRIDAY_WORKER_TOOLS env.",
  );
}

/**
 * Spawn a tool worker. Returns a handle the caller can use to stop it.
 * Throws if the chosen runtime adapter isn't implemented.
 */
export function launchToolWorker(spec: ToolWorkerSpec = {}): ToolWorkerHandle {
  const runtime = spec.runtime ?? DEFAULT_RUNTIME;
  switch (runtime) {
    case "subprocess":
      return spawnSubprocess(spec);
    case "microvm":
      return spawnMicrovm(spec);
    case "k8s":
      return spawnK8s(spec);
    default: {
      const exhaustive: never = runtime;
      throw new Error(`Unknown tool worker runtime: ${exhaustive}`);
    }
  }
}
