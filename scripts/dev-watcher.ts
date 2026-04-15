/**
 * Session-aware daemon watcher — replacement for Deno's native `--watch`.
 *
 * Problem: Deno `--watch` restarts the daemon as soon as any source file is
 * modified. FAST sessions write files mid-run (coder agents), which kills the
 * daemon while a session is still executing. In-flight sessions are in-memory
 * only and never reach a terminal state, so status-watcher can't observe them
 * and the backlog entry stays pending forever.
 *
 * Solution: this supervisor watches source files, but before restarting the
 * daemon it polls /api/sessions until no sessions are in the `active` status.
 * Sessions run to completion, get persisted, and status-watcher can advance
 * the backlog.
 *
 * Uses console.* directly — `scripts/` CLI tooling is exempt from the
 * @atlas/logger rule per CLAUDE.md.
 */

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const REPO_ROOT = process.cwd();

/** Directories whose changes should trigger a daemon restart. */
const WATCH_TARGETS: readonly string[] = [
  "apps/atlasd",
  "packages",
  "workspaces/fast-loop/workspace.yml",
  "workspaces/fast-improvements-source/workspace.yml",
  "workspaces/agent-author/workspace.yml",
  "agents",
  "deno.json",
];

/** Path substrings that should never trigger a restart even inside watched dirs. */
const EXCLUDE_SUBSTRINGS: readonly string[] = [
  "/node_modules/",
  "/.git/",
  "/.svelte-kit/",
  "/dist/",
  "/build/",
  "/.atlas/",
  "/tools/agent-playground/",
  "/.deno/",
  "/coverage/",
  "/__fixtures__/",
];

/**
 * Regex patterns that mark a path as transient — editor/test-runner scratch files
 * that shouldn't trigger a daemon restart. Deno's test runner and several IDEs
 * write tmp files inside watched directories.
 */
const EXCLUDE_REGEXES: readonly RegExp[] = [
  /\.tmp\./,
  /\.tmp-/,
  /\.temp\./,
  /\.swp$/,
  /\.swo$/,
  /~$/,
  /\.DS_Store$/,
  /\.#/, // emacs lock files
];

/**
 * Only react to source-file extensions. A change to anything else (markdown,
 * binary, etc.) is ignored even if it lives inside a watched directory.
 */
const INCLUDE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".svelte",
  ".yml",
  ".yaml",
  ".py",
  ".json",
];

const DEBOUNCE_MS = 500;
const SESSIONS_URL = "http://localhost:8080/api/sessions?limit=100";
const IDLE_POLL_MS = 2000;
const MAX_WAIT_MS = 30 * 60 * 1000; // 30 min — FAST sessions can legitimately run 20+ min
const SHUTDOWN_GRACE_MS = 10_000;

function log(msg: string): void {
  // biome-ignore lint/suspicious/noConsole: supervisor CLI, exempt from @atlas/logger rule
  console.log(`[dev-watcher] ${msg}`);
}

function warn(msg: string): void {
  // biome-ignore lint/suspicious/noConsole: supervisor CLI, exempt from @atlas/logger rule
  console.warn(`[dev-watcher] ${msg}`);
}

function shouldIgnore(eventPath: string): boolean {
  if (EXCLUDE_SUBSTRINGS.some((sub) => eventPath.includes(sub))) return true;
  if (EXCLUDE_REGEXES.some((rx) => rx.test(eventPath))) return true;
  // Only watch allow-listed extensions — everything else is noise
  const ext = path.extname(eventPath).toLowerCase();
  if (ext.length > 0 && !INCLUDE_EXTENSIONS.includes(ext)) return true;
  return false;
}

function resolveWatchPaths(): string[] {
  const resolved: string[] = [];
  for (const target of WATCH_TARGETS) {
    const full = path.resolve(REPO_ROOT, target);
    try {
      Deno.statSync(full);
      resolved.push(full);
    } catch {
      warn(`watch target missing, skipping: ${target}`);
    }
  }
  return resolved;
}

function spawnDaemon(extraArgs: readonly string[]): ChildProcess {
  const denoArgs = [
    "run",
    "-q",
    "--allow-all",
    "--unstable-worker-options",
    "--unstable-kv",
    "--unstable-raw-imports",
    "--env-file",
    "apps/atlas-cli/src/otel-bootstrap.ts",
    ...extraArgs,
  ];
  log(`spawning daemon: deno ${denoArgs.join(" ")}`);
  const child = spawn("deno", denoArgs, { stdio: "inherit", env: process.env, cwd: REPO_ROOT });
  child.on("exit", (code, signal) => {
    log(`daemon child exited (code=${code ?? "?"}, signal=${signal ?? "?"})`);
  });
  child.on("error", (err) => {
    warn(`daemon child error: ${err.message}`);
  });
  return child;
}

async function activeSessionCount(): Promise<number> {
  try {
    const resp = await fetch(SESSIONS_URL, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return 0;
    const parsed: unknown = await resp.json();
    if (typeof parsed !== "object" || parsed === null || !("sessions" in parsed)) {
      return 0;
    }
    const sessions = (parsed as { sessions: unknown }).sessions;
    if (!Array.isArray(sessions)) return 0;
    let count = 0;
    for (const s of sessions) {
      if (
        typeof s === "object" &&
        s !== null &&
        "status" in s &&
        (s as { status: unknown }).status === "active"
      ) {
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForIdle(): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS;
  let lastLoggedAt = 0;
  while (Date.now() < deadline) {
    const count = await activeSessionCount();
    if (count === 0) return;
    const now = Date.now();
    if (now - lastLoggedAt > 30_000) {
      log(`waiting for ${count} active session(s) to finish before restarting...`);
      lastLoggedAt = now;
    }
    await sleep(IDLE_POLL_MS);
  }
  warn("max wait exceeded (10 min) — forcing restart anyway");
}

async function killDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return;
    await sleep(200);
  }
  warn("daemon did not exit gracefully, sending SIGKILL");
  child.kill("SIGKILL");
}

async function main(): Promise<void> {
  const extraArgs = Deno.args.length > 0 ? Deno.args : ["daemon", "start"];
  let daemon = spawnDaemon(extraArgs);
  let restartInProgress = false;
  let pendingRestart: NodeJS.Timeout | null = null;

  const shutdown = async (signal: string): Promise<void> => {
    log(`received ${signal}, shutting down daemon child`);
    if (pendingRestart !== null) clearTimeout(pendingRestart);
    await killDaemon(daemon);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const triggerRestart = async (changedPath: string): Promise<void> => {
    if (restartInProgress) return;
    restartInProgress = true;
    try {
      log(`file change: ${path.relative(REPO_ROOT, changedPath)} — waiting for idle`);
      await waitForIdle();
      log("daemon idle — restarting");
      await killDaemon(daemon);
      daemon = spawnDaemon(extraArgs);
    } finally {
      restartInProgress = false;
    }
  };

  const watchPaths = resolveWatchPaths();
  if (watchPaths.length === 0) {
    warn("no watch paths resolved, daemon will run without auto-reload");
    return;
  }
  log(`watching ${watchPaths.length} target(s): ${WATCH_TARGETS.join(", ")}`);

  const watcher = Deno.watchFs(watchPaths, { recursive: true });
  for await (const event of watcher) {
    if (event.kind !== "modify" && event.kind !== "create" && event.kind !== "remove") {
      continue;
    }
    const firstPath = event.paths[0];
    if (firstPath === undefined || firstPath.length === 0) continue;
    if (shouldIgnore(firstPath)) continue;

    if (pendingRestart !== null) clearTimeout(pendingRestart);
    pendingRestart = setTimeout(() => {
      pendingRestart = null;
      void triggerRestart(firstPath);
    }, DEBOUNCE_MS);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  warn(`fatal: ${message}`);
  process.exit(1);
});
