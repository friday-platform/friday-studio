/**
 * Daemon-scoped singleton process registry for HTTP MCP servers with
 * a startup command on a fixed port.
 *
 * Problem this solves: workspace-mcp servers (gmail, calendar, etc.) bind
 * fixed ports (8001-8005). The previous per-agent spawn-then-SIGTERM
 * pattern in `connectHttp` lands new spawns inside the kernel TIME_WAIT
 * window of the previous server; uvicorn's bind() then fails silently
 * (no EADDRINUSE in stderr), so the existing fallback never recovers.
 *
 * This registry keeps a single child process alive per `serverId` for the
 * lifetime of the daemon. First caller spawns; subsequent callers reuse.
 * Children die only on `shutdown()` or on their own (OOM, manual kill).
 *
 * @module
 */

import type { ChildProcess, spawn as defaultSpawn } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { Logger } from "@atlas/logger";
import { MCPStartupError } from "./errors.ts";

export interface SharedProcessSpec {
  command: string;
  args: string[];
  /** Already-resolved env. Caller is responsible for credential resolution. */
  env: Record<string, string>;
  /** URL polled with GET to determine readiness. */
  readyUrl: string;
  readyTimeoutMs: number;
  readyIntervalMs: number;
}

export interface SharedProcessHandle {
  /** The PID-bearing child. Owned by the registry, not the caller. */
  child: ChildProcess;
}

/**
 * Filesystem hooks for pid-file lifecycle. The default implementation
 * writes "<pid> <start_unix>\n" files to the launcher's pidsDir
 * (`${FRIDAY_LAUNCHER_HOME}/pids/` or `~/.friday/local/pids/`) so the
 * launcher's existing SweepOrphans on next boot SIGTERMs orphaned
 * workspace-mcp processes from a previous daemon's hard crash.
 *
 * Tests pass a no-op to skip filesystem effects.
 */
export interface PidFileWriter {
  write(serverId: string, pid: number, startUnix: number): Promise<void>;
  remove(serverId: string): Promise<void>;
}

export interface ProcessRegistryDeps {
  spawn: typeof defaultSpawn;
  fetch: typeof fetch;
  /** Optional pid-file writer; defaults to filesystem-backed launcher pidsDir. */
  pidFile?: PidFileWriter;
}

function launcherPidsDir(): string {
  const explicit = process.env.FRIDAY_LAUNCHER_HOME;
  if (explicit) return join(explicit, "pids");
  const home = homedir();
  if (home) return join(home, ".friday", "local", "pids");
  // Last-resort fallback — matches launcher's friendlyHome() behaviour.
  return join(process.env.TMPDIR ?? "/tmp", ".friday", "local", "pids");
}

/**
 * Default PidFileWriter: writes / removes pid files in the launcher's
 * pidsDir using the launcher's "<pid> <start_unix>\n" format. All fs
 * errors are swallowed and logged — pid files are best-effort coverage,
 * the daemon must function even when the directory is unavailable.
 */
function defaultPidFileWriter(logger: Logger): PidFileWriter {
  const pidPath = (serverId: string) => join(launcherPidsDir(), `mcp-${serverId}.pid`);
  return {
    async write(serverId, pid, startUnix) {
      const dir = launcherPidsDir();
      const path = pidPath(serverId);
      try {
        await mkdir(dir, { recursive: true, mode: 0o750 });
        await writeFile(path, `${pid} ${startUnix}\n`, { mode: 0o644 });
        logger.debug(`MCP shared process: wrote pid file for "${serverId}"`, {
          operation: "mcp_shared_process_pidfile_write",
          serverId,
          pid,
          path,
        });
      } catch (error) {
        logger.warn(`MCP shared process: pid file write failed for "${serverId}"`, {
          operation: "mcp_shared_process_pidfile_write",
          serverId,
          path,
          error,
        });
      }
    },
    async remove(serverId) {
      const path = pidPath(serverId);
      try {
        await unlink(path);
      } catch (error) {
        // ENOENT is expected after a clean exit; only log unexpected errors.
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "ENOENT") {
          logger.warn(`MCP shared process: pid file remove failed for "${serverId}"`, {
            operation: "mcp_shared_process_pidfile_remove",
            serverId,
            path,
            error,
          });
        }
      }
    },
  };
}

interface InternalEntry {
  readonly promise: Promise<SharedProcessHandle>;
  /** Set once the spawn promise resolves. Used by `shutdown` to SIGTERM. */
  child?: ChildProcess;
  /** Set once the spawn promise resolves. Used by `shutdown` to clean up pid files. */
  pidFile?: PidFileWriter;
}

/**
 * Wait for `child` to fully exit. If already exited, resolves immediately.
 * Used by `shutdown` to await SIGTERM cleanup before SIGKILLing survivors.
 */
function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}

class ProcessRegistry {
  private readonly entries = new Map<string, InternalEntry>();
  private disposed = false;

  /**
   * Get-or-spawn a long-lived child for `serverId`. Resolves once the
   * child's `readyUrl` becomes reachable.
   *
   * Concurrent calls for the same `serverId` share the same spawn — the
   * second caller awaits the same readiness promise; only one spawn happens.
   *
   * On spawn failure or early exit, the cache entry is removed so a retry
   * can spawn fresh.
   */
  acquire(
    serverId: string,
    spec: SharedProcessSpec,
    deps: ProcessRegistryDeps,
    logger: Logger,
  ): Promise<SharedProcessHandle> {
    if (this.disposed) {
      return Promise.reject(
        new MCPStartupError(
          "spawn",
          serverId,
          spec.command,
          new Error("process registry has been shut down"),
        ),
      );
    }

    const cached = this.entries.get(serverId);
    if (cached) {
      logger.debug(`MCP shared process: reusing existing child for "${serverId}"`, {
        operation: "mcp_shared_process_reuse",
        serverId,
      });
      return cached.promise;
    }

    const pidFile = deps.pidFile ?? defaultPidFileWriter(logger);

    const entry: InternalEntry = {
      promise: this.spawnAndWaitReady(serverId, spec, deps, logger).then(async (handle) => {
        entry.child = handle.child;
        entry.pidFile = pidFile;
        if (typeof handle.child.pid === "number") {
          try {
            await pidFile.write(serverId, handle.child.pid, Math.floor(Date.now() / 1000));
          } catch (error) {
            // Pid files are best-effort coverage for the launcher's
            // SweepOrphans on next boot. Don't block acquire on fs errors.
            logger.warn(`MCP shared process: pid file write rejected for "${serverId}"`, {
              operation: "mcp_shared_process_pidfile_write",
              serverId,
              error,
            });
          }
        }
        this.attachLifetimeListener(serverId, entry, handle.child, pidFile, logger);
        return handle;
      }),
    };
    this.entries.set(serverId, entry);

    // On rejection, evict so a retry can spawn fresh.
    entry.promise.catch(() => {
      if (this.entries.get(serverId) === entry) {
        this.entries.delete(serverId);
      }
    });

    return entry.promise;
  }

  /**
   * Kill all registered children. Idempotent. After shutdown, `acquire`
   * rejects.
   */
  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    const children: ChildProcess[] = [];
    const pidFileCleanups: Array<Promise<void>> = [];
    for (const [serverId, entry] of this.entries.entries()) {
      if (entry.child && entry.child.exitCode === null && entry.child.signalCode === null) {
        children.push(entry.child);
      }
      // Remove the pid file regardless of child state — best-effort. The
      // exit listener also removes on its own, but doing it here covers the
      // race where SIGKILL fires before the listener flushes.
      if (entry.pidFile) {
        pidFileCleanups.push(entry.pidFile.remove(serverId));
      }
    }
    this.entries.clear();

    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already dead — ignore.
      }
    }

    // Grace window: wait up to 2s for clean exit, then SIGKILL stragglers.
    await Promise.race([
      Promise.all(children.map(waitForExit)),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);

    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already dead — ignore.
        }
      }
    }

    // Awaiting pid-file cleanup at the end — avoids blocking the SIGTERM
    // ordering above. Errors are logged inside the writer, not rethrown.
    await Promise.allSettled(pidFileCleanups);
  }

  /**
   * Test-only helper: clears all registered entries WITHOUT killing children.
   * Tests must mock `spawn` so there are no real children to leak.
   */
  _resetForTesting(): void {
    this.entries.clear();
    this.disposed = false;
  }

  private async spawnAndWaitReady(
    serverId: string,
    spec: SharedProcessSpec,
    deps: ProcessRegistryDeps,
    logger: Logger,
  ): Promise<SharedProcessHandle> {
    const { command, args, env, readyUrl, readyTimeoutMs, readyIntervalMs } = spec;

    let child: ChildProcess;
    try {
      child = deps.spawn(command, args, {
        env,
        detached: false,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (err) {
      throw new MCPStartupError("spawn", serverId, command, err);
    }

    // Capture stderr for error messages only — never pattern-matched. uvicorn
    // fails silently on bind errors so the buffer is unreliable for control
    // flow.
    let stderrAccumulator = "";
    child.stderr?.on("data", (data: Uint8Array) => {
      stderrAccumulator += new TextDecoder().decode(data);
    });

    let childExited = false;
    let exitCode: number | null = null;
    child.on("exit", (code) => {
      childExited = true;
      exitCode = code;
    });

    logger.debug(`MCP shared process: spawning child for "${serverId}"`, {
      operation: "mcp_shared_process_spawn",
      serverId,
      command,
      args,
      pid: child.pid,
    });

    const startTime = Date.now();
    while (Date.now() - startTime < readyTimeoutMs) {
      if (childExited) {
        throw new MCPStartupError(
          "spawn",
          serverId,
          command,
          new Error(stderrAccumulator || `Process exited with code ${exitCode}`),
        );
      }

      try {
        await deps.fetch(readyUrl, { method: "GET" });
        logger.info(`MCP shared process: child ready for "${serverId}"`, {
          operation: "mcp_shared_process_ready",
          serverId,
          pid: child.pid,
          elapsedMs: Date.now() - startTime,
        });
        return { child };
      } catch {
        // Not ready yet — continue polling.
      }

      await new Promise((resolve) => setTimeout(resolve, readyIntervalMs));
    }

    // Timeout — terminate the child and throw.
    if (!child.killed && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already dead.
      }
    }
    throw new MCPStartupError("timeout", serverId, command);
  }

  /**
   * Listen for mid-life child death so the next `acquire` spawns fresh
   * instead of returning a cached handle to a dead process.
   */
  private attachLifetimeListener(
    serverId: string,
    entry: InternalEntry,
    child: ChildProcess,
    pidFile: PidFileWriter,
    logger: Logger,
  ): void {
    child.on("exit", (code, signal) => {
      logger.warn(`MCP shared process: child for "${serverId}" exited`, {
        operation: "mcp_shared_process_exit",
        serverId,
        exitCode: code,
        signal,
      });
      if (this.entries.get(serverId) === entry) {
        this.entries.delete(serverId);
      }
      void pidFile.remove(serverId);
    });
  }
}

/** Module-level singleton for the daemon process. */
export const sharedMCPProcesses: ProcessRegistry = new ProcessRegistry();

export type { ProcessRegistry };
