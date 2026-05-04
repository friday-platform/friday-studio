import { execFile } from "node:child_process";
import { readdir, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Matches `atlas-web-${randomUUID()}` from packages/bundled-agents/src/web/index.ts.
// The prefix is Friday's exclusive namespace — user-launched agent-browser
// sessions use flat names (e.g. "amazon", "default") that cannot collide.
const SESSION_FILE_RE =
  /^(atlas-web-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pid$/;

const SESSION_FILE_EXTS = ["pid", "sock", "engine", "stream", "version"] as const;

const CLOSE_TIMEOUT_MS = 5_000;
const SIGTERM_GRACE_MS = 500;

export interface SweepLogger {
  info: (msg: string, ctx?: Record<string, unknown>) => void;
  warn: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface SweepResult {
  scanned: number;
  closed: number;
  killed: number;
  staleFilesOnly: number;
  errors: { session: string; error: string }[];
}

export interface SweepDeps {
  /** Directory where agent-browser writes per-session pid/sock files. */
  dir?: string;
  /** Returns true if pid is currently alive. */
  isPidAlive?: (pid: number) => boolean;
  /** Asks the agent-browser daemon to exit gracefully via the CLI. */
  closeSession?: (session: string) => Promise<void>;
  /** Kills a daemon by PID, escalating to SIGKILL if SIGTERM doesn't take. */
  killByPid?: (pid: number) => Promise<boolean>;
}

/**
 * Sweep orphaned `agent-browser` daemons left by a previous atlasd that
 * died without running the bundled web agent's stopSession cleanup
 * (SIGKILL, crash, OOM, host reboot). Scoped to the `atlas-web-<uuid>`
 * namespace owned exclusively by the bundled web agent.
 *
 * Safe to call only at daemon startup, before any web-agent invocation —
 * any matching session in the directory is necessarily orphaned.
 */
export async function sweepOrphanedAgentBrowserSessions(
  logger: SweepLogger,
  deps: SweepDeps = {},
): Promise<SweepResult> {
  const dir = deps.dir ?? join(homedir(), ".agent-browser");
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const closeSession = deps.closeSession ?? defaultCloseSession;
  const killByPid = deps.killByPid ?? ((pid: number) => defaultKillByPid(pid, isPidAlive));

  const result: SweepResult = { scanned: 0, closed: 0, killed: 0, staleFilesOnly: 0, errors: [] };

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return result;
  }

  const sessions: string[] = [];
  for (const entry of entries) {
    const match = SESSION_FILE_RE.exec(entry);
    if (match?.[1]) sessions.push(match[1]);
  }
  result.scanned = sessions.length;
  if (sessions.length === 0) return result;

  // Sessions are independent — each owns its own socket/pid set. Run in
  // parallel so shutdown-time invocations stay within the 30s budget even
  // with many leftover sessions.
  const perSession = sessions.map(async (session) => {
    const pid = await readPid(dir, session);
    const alive = pid !== null && isPidAlive(pid);

    if (alive && pid !== null) {
      try {
        await closeSession(session);
        result.closed++;
      } catch {
        try {
          const killed = await killByPid(pid);
          if (killed) {
            result.killed++;
          } else {
            result.errors.push({ session, error: `failed to terminate pid ${pid}` });
          }
        } catch (err) {
          result.errors.push({ session, error: String(err) });
        }
      }
    } else {
      result.staleFilesOnly++;
    }

    await removeSessionFiles(dir, session);
  });
  await Promise.all(perSession);

  logger.info("Swept orphaned agent-browser sessions", { ...result });
  return result;
}

async function readPid(dir: string, session: string): Promise<number | null> {
  try {
    const raw = await readFile(join(dir, `${session}.pid`), "utf8");
    const pid = parseInt(raw.trim(), 10);
    return Number.isFinite(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function defaultCloseSession(session: string): Promise<void> {
  await execFileAsync("agent-browser", ["--session", session, "close"], {
    timeout: CLOSE_TIMEOUT_MS,
  });
}

async function defaultKillByPid(
  pid: number,
  isPidAlive: (pid: number) => boolean,
): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isPidAlive(pid);
  }
  await new Promise((r) => setTimeout(r, SIGTERM_GRACE_MS));
  if (!isPidAlive(pid)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already dead between checks
  }
  return !isPidAlive(pid);
}

async function removeSessionFiles(dir: string, session: string): Promise<void> {
  await Promise.all(
    SESSION_FILE_EXTS.map((ext) => unlink(join(dir, `${session}.${ext}`)).catch(() => {})),
  );
}
