/**
 * Daemon-as-fixture primitives for live daemon QA.
 *
 * Spawns a fresh atlasd against an isolated FRIDAY_HOME, registers a
 * workspace, fires a signal, parses the SSE stream, walks session events
 * for token-usage aggregation, and tears down. No state leaks between
 * runs.
 *
 * Read by:
 *   tools/qa/live-daemon/scenarios/*.ts — live daemon QA scenarios
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
  /** NATS URL dedicated to this harness daemon. */
  natsUrl: string;
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

async function waitForTcp(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const conn = await Deno.connect({ hostname: "127.0.0.1", port });
      conn.close();
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`TCP port ${port} did not open within ${timeoutMs}ms`);
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
  const natsPort = pickPort();
  // realPath resolves the macOS /var → /private/var symlink. The daemon
  // realpath-resolves workspace paths before the home-dir isolation check
  // compares them against FRIDAY_HOME; without this the temp dir comes
  // back as /var/... while workspaces resolve to /private/var/..., and
  // every harness-registered workspace is masked as cross-home (404).
  const fridayHome = await Deno.realPath(
    opts.fridayHome ?? (await Deno.makeTempDir({ prefix: "friday-qa-" })),
  );
  const natsUrl = `nats://127.0.0.1:${natsPort}`;

  const natsStoreDir = join(fridayHome, "jetstream");
  const natsProc = new Deno.Command("nats-server", {
    args: [
      "--addr",
      "127.0.0.1",
      "--port",
      String(natsPort),
      "--jetstream",
      "--store_dir",
      natsStoreDir,
    ],
    stdout: opts.inherit ? "inherit" : "piped",
    stderr: opts.inherit ? "inherit" : "piped",
    stdin: "null",
  }).spawn();
  if (!opts.inherit) {
    drainToLog(natsProc.stdout, join(fridayHome, "harness-nats.stdout.log"));
    drainToLog(natsProc.stderr, join(fridayHome, "harness-nats.stderr.log"));
  }
  await waitForTcp(natsPort);

  // Construct env: clone process.env, override FRIDAY_HOME, force
  // FRIDAY_ENV=dev so credential fetch is skipped, set OTEL flags
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
    FRIDAY_ENV: "dev",
    FRIDAYD_URL: `http://127.0.0.1:${port}`,
    FRIDAY_PORT_FRIDAY: String(port),
    FRIDAY_NATS_URL: natsUrl,
    OTEL_DENO: "false",
    // Drop any incoming OTEL endpoint config so the daemon doesn't try
    // to ship spans during the test run.
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_HEADERS: "",
    // Force plaintext: ensureCredentialsLoaded() pulls ~/.atlas/.env into
    // Deno.env for the Anthropic key, and TLS cert/key/ca ride along in that
    // same file. Left set, the spawned daemon auto-upgrades to https://
    // (start.tsx) while the harness probes http:// — health never matches.
    // The test daemon is a throwaway on a random port; it has no use for TLS.
    FRIDAY_TLS_CERT: "",
    FRIDAY_TLS_KEY: "",
    FRIDAY_TLS_CA: "",
    ...(opts.env ?? {}),
  };

  // Spawn the daemon directly rather than via `deno task atlas`. The
  // `atlas` task in deno.json inlines `FRIDAY_HOME=$HOME/.atlas`, which
  // overrides the per-run temp FRIDAY_HOME set above — the daemon then
  // runs against the real ~/.atlas home and the home-dir isolation guard
  // masks every harness-registered workspace as cross-home (404). Running
  // the task's underlying command lets the harness FRIDAY_HOME stick.
  // Mirrors the `atlas` task in deno.json — keep the flags in sync.
  const cmd = new Deno.Command("deno", {
    args: [
      "run",
      "-q",
      "--allow-all",
      "--unstable-worker-options",
      "--unstable-kv",
      "--unstable-raw-imports",
      "--env-file",
      "apps/atlas-cli/src/otel-bootstrap.ts",
      "daemon",
      "start",
      "--port",
      String(port),
      "--hostname",
      "127.0.0.1",
    ],
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
          try {
            natsProc.kill("SIGTERM");
          } catch {
            // already dead
          }
          const natsStatus = await Promise.race([natsProc.status, delay(3_000).then(() => null)]);
          if (!natsStatus) {
            try {
              natsProc.kill("SIGKILL");
              await natsProc.status;
            } catch {
              // already dead
            }
          }
        };
        currentDaemonFridayHome = fridayHome;
        const stopAndClear = async () => {
          try {
            await stop();
          } finally {
            if (currentDaemonFridayHome === fridayHome) currentDaemonFridayHome = undefined;
          }
        };
        return { port, baseUrl, fridayHome, natsUrl, process: proc, stop: stopAndClear };
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
  try {
    natsProc.kill("SIGTERM");
  } catch {
    // ignore
  }
  await natsProc.status;
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

/**
 * Create a unique scratch dir for a workspace fixture *under* the daemon's
 * FRIDAY_HOME. Post-#296 the workspace manager masks any registry entry
 * whose path falls outside the active home (`isUnderHome` in
 * packages/workspace/src/manager.ts) — a fixture in a sibling tmp dir
 * registers but is then invisible to find()/chat/signals (404). Lives
 * under `<home>/qa-fixtures/` rather than `<home>/workspaces/` so the
 * daemon's own workspace bootstrap never scans it. Torn down with the
 * home dir by stopDaemon().
 */
export async function makeFixtureDir(fridayHome: string, prefix: string): Promise<string> {
  const fixturesRoot = join(fridayHome, "qa-fixtures");
  await Deno.mkdir(fixturesRoot, { recursive: true });
  return await Deno.makeTempDir({ dir: fixturesRoot, prefix });
}

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
// Session events walk + usage aggregation
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
}

/**
 * Walk raw session events for usage aggregation + validator behavior
 * counts. The SessionView reducer also surfaces `usage` onto `AgentBlock`,
 * but we keep consuming the raw
 * event stream here to retain access to other fields the projection
 * collapses (e.g. per-step verdict shapes).
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
    }
  }

  return { events, totalUsage, toolCallCount };
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

/**
 * Narrowed projection of `GET /api/sessions/:id` (the SessionView). Only
 * the fields the harness asserts on are typed; unknown extras pass
 * through. Older AgentBlock entries may not have `usage`; the harness
 * asserts that current projections populate it from `step:complete.usage`
 * end-to-end.
 */
export interface SessionViewAgentBlock {
  agentName?: string;
  status?: string;
  usage?: StepUsage;
}

export interface SessionViewProjection {
  sessionId?: string;
  status?: string;
  agentBlocks?: SessionViewAgentBlock[];
}

/**
 * Fetch the SessionView projection (`GET /api/sessions/:id`). Returns the
 * raw JSON body narrowed to the fields the harness uses. Throws on any
 * non-2xx response other than 404, which yields an empty projection so
 * callers can decide whether the absence is fatal in their context.
 */
export async function fetchSessionView(
  d: DaemonHandle,
  sessionId: string,
): Promise<SessionViewProjection> {
  const resp = await fetch(`${d.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`);
  if (resp.status === 404) {
    return {};
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GET /api/sessions/${sessionId} failed: ${resp.status} ${text}`);
  }
  return (await resp.json()) as SessionViewProjection;
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
 * `pattern` (substring or regex). Used for assertions that can't be
 * reconstructed from session events alone.
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
  resultsDir: join(WORKTREE_ROOT, "tools/qa/results"),
};

export function qaProviderReplacements(): Record<string, string> {
  return {
    __FRIDAY_QA_PROVIDER__: Deno.env.get("FRIDAY_QA_PROVIDER") ?? "anthropic",
    __FRIDAY_QA_MODEL__: Deno.env.get("FRIDAY_QA_MODEL") ?? "claude-sonnet-4-6",
  };
}

// Tracks the active daemon's FRIDAY_HOME so fixture YAMLs land under it —
// isUnderHome silently masks any registered workspace outside FRIDAY_HOME.
let currentDaemonFridayHome: string | undefined;
export function qaWorkspaceTmpRoot(): string | undefined {
  return currentDaemonFridayHome;
}
