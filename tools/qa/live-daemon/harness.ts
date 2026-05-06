/**
 * Daemon-as-fixture primitives for the melodic-strolling-seal QA harness.
 *
 * Spawns a fresh atlasd against an isolated FRIDAY_HOME, registers a
 * workspace, fires a signal, parses the SSE stream, walks session events
 * for token-usage aggregation, and tears down. No state leaks between
 * runs.
 *
 * Read by:
 *   tools/qa/live-daemon/scenarios/*.ts — per-phase + baseline scenarios
 *
 * No external deps beyond Deno + std.
 */

import { delay } from "jsr:@std/async@1.0.15/delay";
import { load as loadDotenv } from "jsr:@std/dotenv@^0.225.5";
import { join } from "jsr:@std/path@1";

/**
 * Load credentials from `~/.atlas/.env` into Deno.env if not already set.
 * The daemon does this itself at startup, but the harness wants a known
 * ANTHROPIC_API_KEY ahead of spawn so it can fail fast if missing.
 *
 * No-op if FRIDAY_LOAD_CREDS=false. Best-effort — doesn't throw if the
 * file is absent.
 */
export async function ensureCredentialsLoaded(): Promise<void> {
  if (Deno.env.get("FRIDAY_LOAD_CREDS") === "false") return;
  const home = Deno.env.get("HOME");
  if (!home) return;
  const path = `${home}/.atlas/.env`;
  try {
    await Deno.stat(path);
  } catch {
    return; // file missing — caller will surface a clearer error later
  }
  try {
    await loadDotenv({ envPath: path, export: true });
  } catch {
    // best-effort
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DaemonHandle {
  port: number;
  baseUrl: string;
  fridayHome: string;
  process: Deno.ChildProcess;
  stop: () => Promise<void>;
}

export interface RegisterWorkspaceResult {
  id: string;
  name: string;
  path: string;
  status: string;
  created: boolean;
}

/** A single SSE event observed during signal trigger streaming. */
export interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
  raw: string;
}

/** The compact-shape result the workspace-chat job-tool consumes. */
export interface JobCompleteData {
  success: boolean;
  sessionId: string;
  status: string;
  artifactIds?: string[];
  summary?: string;
  output?: unknown;
}

export interface SignalTriggerResult {
  events: SSEEvent[];
  jobComplete: JobCompleteData | null;
  jobError: { error: string } | null;
  sessionId: string | null;
  durationMs: number;
}

export interface SessionEventsResult {
  events: Array<Record<string, unknown>>;
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  validatorRunCount: number;
  validatorSkipCount: number;
  toolCallCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Daemon spawn + teardown
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick a random high port. We use 49152-65535 (IANA dynamic range) and
 * trust the kernel to actually bind it; the daemon's listen will fail if
 * we collided. Cheap retry on failure.
 */
function pickPort(): number {
  return 49152 + Math.floor(Math.random() * (65535 - 49152));
}

const WORKTREE_ROOT = (() => {
  // tools/qa/live-daemon/harness.ts → ../../../ → worktree root
  const here = new URL(".", import.meta.url).pathname;
  return new URL("../../..", `file://${here}`).pathname;
})();

export interface StartDaemonOptions {
  /** Override FRIDAY_HOME. If omitted, a unique tmp dir under /tmp/friday-qa-<id> is created. */
  fridayHome?: string;
  /** Override port. If omitted, a random port in [49152, 65535] is picked. */
  port?: number;
  /** Forward stdout/stderr to the parent (defaults to false — captured for diagnostics). */
  inherit?: boolean;
  /** Max time to wait for /health to return 200. Default 60_000 (60s). */
  healthTimeoutMs?: number;
  /** Extra env vars to set on the child. */
  env?: Record<string, string>;
}

export async function startDaemon(opts: StartDaemonOptions = {}): Promise<DaemonHandle> {
  await ensureCredentialsLoaded();
  const port = opts.port ?? pickPort();
  const fridayHome = opts.fridayHome ?? (await Deno.makeTempDir({ prefix: "friday-qa-" }));

  // Construct env: clone process.env, override FRIDAY_HOME, set
  // FRIDAY_LOCAL_ONLY so credential fetch is skipped, set OTEL flags
  // present so the CLI doesn't re-exec itself.
  //
  // Critical: `FRIDAYD_URL` MUST point at the daemon's actual listen
  // port. The atlas-platform MCP server config (and several other
  // self-loopback callers, e.g. workspace-chat fetchWorkspaceDetails)
  // resolves the daemon URL via getAtlasDaemonUrl(), which falls back
  // to `127.0.0.1:8080`. Without this override, MCP tool resolution
  // (fs_*, memory, artifacts, …) fails with Connection refused on a
  // randomly-ported daemon, and LLM actions silently call `complete`
  // with empty data because no tools were actually callable.
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    FRIDAY_HOME: fridayHome,
    FRIDAY_LOCAL_ONLY: "true",
    FRIDAYD_URL: `http://127.0.0.1:${port}`,
    FRIDAY_PORT_FRIDAY: String(port),
    OTEL_DENO: "false",
    // Drop any incoming OTEL endpoint config so the daemon doesn't try
    // to ship spans during the test run.
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_HEADERS: "",
    ...(opts.env ?? {}),
  };

  // Spawn `deno task atlas daemon start --port <p> --hostname 127.0.0.1`
  // from the worktree root so module resolution lines up with the
  // workspace deno.json.
  const cmd = new Deno.Command("deno", {
    args: ["task", "atlas", "daemon", "start", "--port", String(port), "--hostname", "127.0.0.1"],
    env,
    cwd: WORKTREE_ROOT,
    stdout: opts.inherit ? "inherit" : "piped",
    stderr: opts.inherit ? "inherit" : "piped",
    stdin: "null",
  });

  const proc = cmd.spawn();

  // If we're not inheriting, drain stdout/stderr to a log file under
  // the fridayHome so diagnostics are available without backpressure
  // blocking the child.
  if (!opts.inherit) {
    drainToLog(proc.stdout, join(fridayHome, "harness-daemon.stdout.log"));
    drainToLog(proc.stderr, join(fridayHome, "harness-daemon.stderr.log"));
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  const healthDeadline = Date.now() + (opts.healthTimeoutMs ?? 60_000);

  while (Date.now() < healthDeadline) {
    try {
      const resp = await fetch(`${baseUrl}/health`);
      if (resp.ok) {
        await resp.body?.cancel();
        const stop = async () => {
          try {
            proc.kill("SIGTERM");
          } catch {
            // already dead
          }
          // Give the daemon up to 8s to flush JetStream and shut down cleanly.
          const status = await Promise.race([proc.status, delay(8_000).then(() => null)]);
          if (!status) {
            try {
              proc.kill("SIGKILL");
              await proc.status;
            } catch {
              // already dead
            }
          }
        };
        return { port, baseUrl, fridayHome, process: proc, stop };
      }
      await resp.body?.cancel();
    } catch {
      // daemon not up yet
    }
    await delay(500);
  }

  // Health timed out; tear down and surface a useful error.
  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }
  await proc.status;
  throw new Error(
    `Daemon at ${baseUrl} did not become healthy within ${
      opts.healthTimeoutMs ?? 60_000
    }ms (FRIDAY_HOME=${fridayHome}). Check ${join(fridayHome, "harness-daemon.stderr.log")}.`,
  );
}

async function drainToLog(stream: ReadableStream<Uint8Array> | null, path: string) {
  if (!stream) return;
  try {
    const file = await Deno.open(path, { create: true, write: true, truncate: true });
    await stream.pipeTo(file.writable).catch(() => {});
  } catch {
    // best-effort — diagnostics file may not be openable in unusual conditions
  }
}

/** Tear down a daemon and remove its FRIDAY_HOME. */
export async function stopDaemon(
  d: DaemonHandle,
  opts: { keepHome?: boolean } = {},
): Promise<void> {
  await d.stop();
  if (!opts.keepHome) {
    try {
      await Deno.remove(d.fridayHome, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace registration
// ─────────────────────────────────────────────────────────────────────────────

export async function registerWorkspace(
  d: DaemonHandle,
  workspacePath: string,
  opts: { name?: string; description?: string } = {},
): Promise<RegisterWorkspaceResult> {
  const resp = await fetch(`${d.baseUrl}/api/workspaces/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: workspacePath,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.description ? { description: opts.description } : {}),
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`POST /api/workspaces/add failed: ${resp.status} ${text}`);
  }
  return (await resp.json()) as RegisterWorkspaceResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal trigger (SSE)
// ─────────────────────────────────────────────────────────────────────────────

export interface TriggerSignalOptions {
  /** Signal payload. Wrapped in `{ payload: ... }` per the route contract. */
  payload?: Record<string, unknown>;
  /** Hard timeout on the SSE stream. Default 600_000 (10 min). */
  timeoutMs?: number;
  /** Callback invoked for each SSE event as it arrives. */
  onEvent?: (event: SSEEvent) => void;
}

/**
 * Fire a signal on a workspace and consume the SSE stream until [DONE].
 * Returns the parsed events plus the parsed `job-complete` / `job-error`
 * payload if seen.
 */
export async function triggerSignalSSE(
  d: DaemonHandle,
  workspaceId: string,
  signalId: string,
  opts: TriggerSignalOptions = {},
): Promise<SignalTriggerResult> {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 600_000);

  let resp: Response;
  try {
    resp = await fetch(
      `${d.baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/signals/${encodeURIComponent(signalId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ payload: opts.payload ?? {} }),
        signal: ctrl.signal,
      },
    );
  } catch (err) {
    clearTimeout(timer);
    throw new Error(
      `Signal trigger fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!resp.ok) {
    clearTimeout(timer);
    const text = await resp.text();
    throw new Error(`Signal trigger ${resp.status}: ${text}`);
  }

  const events: SSEEvent[] = [];
  let jobComplete: JobCompleteData | null = null;
  let jobError: { error: string } | null = null;
  let sessionId: string | null = null;

  if (!resp.body) {
    clearTimeout(timer);
    throw new Error("Signal trigger response had no body");
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split on \n\n (SSE event delimiter) — events come as one or more
      // `data:` lines terminated by a blank line.
      while (true) {
        const idx = buffer.indexOf("\n\n");
        if (idx === -1) break;
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        // Single-line `data: ...` events are what the daemon emits.
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const raw = dataLine.slice(5).trim();
        if (raw === "[DONE]") {
          buffer = "";
          break;
        }
        let parsed: { type?: string; data?: Record<string, unknown> };
        try {
          parsed = JSON.parse(raw) as { type?: string; data?: Record<string, unknown> };
        } catch {
          continue;
        }
        if (!parsed.type) continue;
        const evt: SSEEvent = { type: parsed.type, data: parsed.data ?? {}, raw };
        events.push(evt);
        opts.onEvent?.(evt);

        if (evt.type === "data-session-start" && typeof evt.data.sessionId === "string") {
          sessionId = evt.data.sessionId;
        } else if (evt.type === "job-complete") {
          jobComplete = evt.data as unknown as JobCompleteData;
          if (typeof jobComplete.sessionId === "string") sessionId = jobComplete.sessionId;
        } else if (evt.type === "job-error") {
          jobError = evt.data as unknown as { error: string };
        }
      }
    }
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  return { events, jobComplete, jobError, sessionId, durationMs: Date.now() - startedAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session events walk + usage aggregation (Phase 11)
// ─────────────────────────────────────────────────────────────────────────────

interface StepUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
}

interface MaybeStepCompleteEvent {
  type?: string;
  usage?: StepUsage;
  toolCalls?: unknown[];
  validationVerdict?: { skipped?: boolean; ok?: boolean };
}

/**
 * Walk raw session events for usage aggregation + validator behavior
 * counts. The SessionView reducer drops `usage` from `step:complete`
 * (only `toolCalls`/`output`/`reasoning` survive into AgentBlock), so we
 * have to consume the raw event stream.
 *
 * `GET /api/sessions/:id/stream` opens an SSE feed backed by the
 * `sessions.<id>.events` JetStream subject with `deliverAll() +
 * orderedConsumer()` — replays from sequence 0 every time. Calling
 * after `job-complete` returns the full event log.
 *
 * Auto-terminates on `session:complete` (handler closes the stream)
 * with a 30s safety timeout for finalize lag.
 */
export async function fetchSessionEvents(
  d: DaemonHandle,
  sessionId: string,
  opts: { timeoutMs?: number } = {},
): Promise<SessionEventsResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);

  let resp: Response;
  try {
    resp = await fetch(`${d.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/stream`, {
      headers: { Accept: "text/event-stream" },
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(
      `Session stream fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!resp.ok) {
    clearTimeout(timer);
    if (resp.status === 404) {
      // Stream not registered — session may have been off-loaded; fall
      // back to the JSON SessionView (no usage data, but the call
      // doesn't fail loudly).
      return {
        events: [],
        totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        validatorRunCount: 0,
        validatorSkipCount: 0,
        toolCallCount: 0,
      };
    }
    const text = await resp.text();
    throw new Error(`GET /api/sessions/${sessionId}/stream failed: ${resp.status} ${text}`);
  }

  const events: Array<Record<string, unknown>> = [];

  if (resp.body) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const idx = buffer.indexOf("\n\n");
          if (idx === -1) break;
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = chunk
            .split("\n")
            .find((l) => l.startsWith("data:") && !l.startsWith("data: ephemeral"));
          if (!dataLine) continue;
          const raw = dataLine.slice(5).trim();
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
              events.push(parsed as Record<string, unknown>);
              if ((parsed as { type?: string }).type === "session:complete") {
                buffer = "";
                break;
              }
            }
          } catch {
            // ignore parse errors on individual frames
          }
        }
      }
    } finally {
      clearTimeout(timer);
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  } else {
    clearTimeout(timer);
  }

  const totalUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let validatorRunCount = 0;
  let validatorSkipCount = 0;
  let toolCallCount = 0;

  for (const ev of events as MaybeStepCompleteEvent[]) {
    if (ev.type === "step:complete") {
      const u = ev.usage;
      if (u) {
        totalUsage.inputTokens += u.inputTokens ?? 0;
        totalUsage.outputTokens += u.outputTokens ?? 0;
        totalUsage.cacheReadTokens += u.cacheReadTokens ?? 0;
        totalUsage.cacheWriteTokens += u.cacheWriteTokens ?? 0;
      }
      if (Array.isArray(ev.toolCalls)) toolCallCount += ev.toolCalls.length;
    } else if (ev.type === "step:validation") {
      // Phase 4: tool-passthrough actions skip the validator. The
      // validator emits `step:validation` with `validationVerdict.skipped:
      // true` (or `verdict: "skipped"`) for skip cases; otherwise the
      // judge ran. Match both shapes for forward compatibility.
      const v = (ev as unknown as Record<string, unknown>).validationVerdict as
        | Record<string, unknown>
        | undefined;
      const verdict = (ev as unknown as Record<string, unknown>).verdict;
      const skipped = v?.skipped === true || verdict === "skipped";
      if (skipped) validatorSkipCount += 1;
      else validatorRunCount += 1;
    }
  }

  return { events, totalUsage, validatorRunCount, validatorSkipCount, toolCallCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Misc helpers
// ─────────────────────────────────────────────────────────────────────────────

export async function currentGitSha(): Promise<string> {
  try {
    const cmd = new Deno.Command("git", {
      args: ["rev-parse", "--short", "HEAD"],
      cwd: WORKTREE_ROOT,
      stdout: "piped",
    });
    const { stdout } = await cmd.output();
    return new TextDecoder().decode(stdout).trim();
  } catch {
    return "unknown";
  }
}

export async function listArtifactsForSession(
  d: DaemonHandle,
  workspaceId: string,
  sessionId: string,
): Promise<Array<Record<string, unknown>>> {
  const url = new URL(`${d.baseUrl}/api/artifacts`);
  url.searchParams.set("workspaceId", workspaceId);
  url.searchParams.set("sessionId", sessionId);
  const resp = await fetch(url.toString());
  if (!resp.ok) {
    return [];
  }
  const body = (await resp.json()) as { artifacts?: Array<Record<string, unknown>> };
  return body.artifacts ?? [];
}

/**
 * Tail the daemon's global.log under FRIDAY_HOME and count lines matching
 * `pattern` (substring or regex). Some signals — most notably Phase 4's
 * validator-skip — only surface in the debug log because the synthetic
 * pass verdict carries no on-the-wire marker (`syntheticPassVerdict` in
 * `packages/hallucination/src/fsm-validator.ts:96`). The harness uses
 * this for assertions that can't be reconstructed from session events.
 */
export async function countLogMatches(d: DaemonHandle, pattern: string | RegExp): Promise<number> {
  const path = join(d.fridayHome, "logs", "global.log");
  let content: string;
  try {
    content = await Deno.readTextFile(path);
  } catch {
    return 0;
  }
  if (typeof pattern === "string") {
    let count = 0;
    let idx = 0;
    while (true) {
      const next = content.indexOf(pattern, idx);
      if (next === -1) break;
      count += 1;
      idx = next + pattern.length;
    }
    return count;
  }
  const matches = content.match(new RegExp(pattern, "g"));
  return matches ? matches.length : 0;
}

export const HARNESS_PATHS = {
  worktreeRoot: WORKTREE_ROOT,
  fixturesDir: join(WORKTREE_ROOT, "tools/qa/fixtures"),
  inboxCorpusDir: join(WORKTREE_ROOT, "tools/qa/fixtures/inbox-corpus"),
  inboxCorpusWorkspaceDir: join(WORKTREE_ROOT, "tools/qa/fixtures/inbox-corpus-qa"),
  resultsDir: join(WORKTREE_ROOT, "tools/qa/results"),
};
