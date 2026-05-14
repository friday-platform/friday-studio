#!/usr/bin/env -S deno run --allow-all --unstable-worker-options --unstable-kv --unstable-raw-imports --env-file

/**
 * Browser QA for Activity/sidebar HITL pending-count behavior.
 *
 * The daemon and Activity API are covered by the first-principles suite;
 * this scenario proves the playground consumes the same SSE feed in the
 * sidebar: a pending elicitation appears without a page reload, the
 * workspace-scoped badge is shown on workspace Activity, and answering
 * from the UI decrements the count.
 *
 * Requires the `agent-browser` CLI in PATH.
 */

import { dirname, join } from "jsr:@std/path@1";
import { ElicitationStorage, initElicitationStorage } from "@atlas/core";
import { connect } from "nats";
import {
  type DaemonHandle,
  HARNESS_PATHS,
  qaProviderReplacements,
  qaWorkspaceTmpRoot,
  registerWorkspace,
  startDaemon,
  stopDaemon,
} from "../harness.ts";

const WORKTREE_ROOT = new URL("../../../..", import.meta.url).pathname;
const FAKE_INBOX_MCP = join(HARNESS_PATHS.fixturesDir, "stub-mcp/fake-inbox-server.ts");
const REFS_FIXTURE = join(HARNESS_PATHS.fixturesDir, "first-principles-refs");

interface ScenarioResult {
  id: string;
  pass: boolean;
  notes: string[];
  metrics: Record<string, unknown>;
}

function pickPort(): number {
  return 49152 + Math.floor(Math.random() * (65535 - 49152));
}

async function tcpOpen(port: number): Promise<boolean> {
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

async function waitForHttp(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      await resp.body?.cancel();
      if (resp.status < 500) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} did not become ready within ${timeoutMs}ms`);
}

async function drainToLog(stream: ReadableStream<Uint8Array>, path: string): Promise<void> {
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    const file = await Deno.open(path, { create: true, append: true, write: true });
    void stream.pipeTo(file.writable).catch(() => {});
  } catch {
    // best-effort diagnostics only
  }
}

async function runChecked(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number } = {},
): Promise<string> {
  const child = new Deno.Command(cmd, {
    args,
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  if (opts.stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(opts.stdin));
    await writer.close();
  }

  const statusPromise = child.output();
  const output = opts.timeoutMs
    ? await Promise.race([
        statusPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), opts.timeoutMs)),
      ])
    : await statusPromise;
  if (output === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
    throw new Error(`${cmd} ${args.join(" ")} timed out`);
  }

  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  if (!output.success) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed with ${output.code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  }
  return stdout.trim();
}

async function materializeFixture(): Promise<string> {
  const tmpDir = await Deno.makeTempDir({
    dir: qaWorkspaceTmpRoot(),
    prefix: "friday-activity-ui-",
  });
  const src = await Deno.readTextFile(join(REFS_FIXTURE, "workspace.yml"));
  let rendered = src.replaceAll("__FAKE_INBOX_MCP_PATH__", FAKE_INBOX_MCP);
  for (const [from, to] of Object.entries(qaProviderReplacements())) {
    rendered = rendered.replaceAll(from, to);
  }
  await Deno.writeTextFile(join(tmpDir, "workspace.yml"), rendered);
  return tmpDir;
}

async function startPlayground(
  daemon: DaemonHandle,
): Promise<{ port: number; process: Deno.ChildProcess; baseUrl: string }> {
  await runChecked("deno", ["task", "-f", "@atlas/agent-playground", "sync"], {
    cwd: WORKTREE_ROOT,
    timeoutMs: 120_000,
  });

  const port = pickPort();
  const logDir = join(daemon.fridayHome, "playground");
  const proc = new Deno.Command("npx", {
    args: ["vite", "dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    cwd: join(WORKTREE_ROOT, "tools/agent-playground"),
    env: {
      ...Deno.env.toObject(),
      EXTERNAL_DAEMON_URL: daemon.baseUrl,
      EXTERNAL_TUNNEL_URL: "http://127.0.0.1:9090",
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  await drainToLog(proc.stdout, join(logDir, "vite.stdout.log"));
  await drainToLog(proc.stderr, join(logDir, "vite.stderr.log"));

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHttp(`${baseUrl}/activity`, 90_000);
  return { port, process: proc, baseUrl };
}

async function stopProcess(proc: Deno.ChildProcess): Promise<void> {
  try {
    proc.kill("SIGTERM");
  } catch {
    return;
  }
  const status = await Promise.race([
    proc.status,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
  ]);
  if (!status) {
    try {
      proc.kill("SIGKILL");
      await proc.status;
    } catch {
      // already exited
    }
  }
}

function agentBrowser(session: string, args: string[], stdin?: string): Promise<string> {
  return runChecked("agent-browser", ["--session", session, ...args], {
    ...(stdin !== undefined ? { stdin } : {}),
    timeoutMs: 30_000,
  });
}

async function browserEval<T>(session: string, expression: string): Promise<T> {
  const stdout = await agentBrowser(session, ["eval", "--stdin"], expression);
  const parsed = JSON.parse(stdout) as unknown;
  return (typeof parsed === "string" ? JSON.parse(parsed) : parsed) as T;
}

async function waitForBrowser<T>(
  session: string,
  expression: string,
  predicate: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await browserEval<T>(session, expression);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`browser condition not met; last=${JSON.stringify(last)}`);
}

const badgeProbe = `JSON.stringify({
  global: document.querySelector('[data-testid="global-activity-pending-badge"]')?.textContent?.trim() ?? null,
  workspace: document.querySelector('[data-testid="workspace-activity-pending-badge"]')?.textContent?.trim() ?? null,
  counts: document.querySelector('.counts')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
  body: document.body.innerText.slice(0, 500),
})`;

const answerButtonProbe = `JSON.stringify(Array.from(document.querySelectorAll('button')).map((button) => ({
  text: button.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
  disabled: button.disabled,
})))`;

async function createPendingElicitation(natsUrl: string, workspaceId: string): Promise<string> {
  const nc = await connect({ servers: natsUrl, name: "activity-sidebar-ui-scenario" });
  try {
    initElicitationStorage(nc);
    const result = await ElicitationStorage.create({
      workspaceId,
      sessionId: "activity-sidebar-ui-session",
      actionId: "activity-sidebar-ui-action",
      kind: "confirm-action",
      question: "UI pending count test: approve the fake action?",
      options: [
        { label: "Approve", value: "approve" },
        { label: "Deny", value: "deny" },
      ],
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    if (!result.ok) throw new Error(result.error);
    return result.data.id;
  } finally {
    await nc.drain();
  }
}

async function runScenario(): Promise<ScenarioResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  if (await tcpOpen(8080)) {
    throw new Error(
      "Port 8080 is already in use. Stop the local daemon before running the browser UI scenario.",
    );
  }

  let daemon: DaemonHandle | null = null;
  let playground: Awaited<ReturnType<typeof startPlayground>> | null = null;
  const session = `friday-hitl-ui-${Date.now()}`;
  try {
    daemon = await startDaemon({ port: 8080, healthTimeoutMs: 90_000 });
    metrics.daemonUrl = daemon.baseUrl;
    const workspacePath = await materializeFixture();
    const workspace = await registerWorkspace(daemon, workspacePath, {
      name: "Activity Sidebar UI",
    });
    metrics.workspaceId = workspace.id;

    playground = await startPlayground(daemon);
    metrics.playgroundUrl = playground.baseUrl;

    await agentBrowser(session, ["open", `${playground.baseUrl}/activity`]);
    await agentBrowser(session, ["wait", "--text", "Activity"]);
    await waitForBrowser<Record<string, string | null>>(
      session,
      badgeProbe,
      (state) => state.counts?.includes("0 pending") === true,
      30_000,
    );
    notes.push("global Activity loaded with zero pending items before the SSE push");

    const elicitationId = await createPendingElicitation(daemon.natsUrl, workspace.id);
    metrics.elicitationId = elicitationId;

    const afterPush = await waitForBrowser<Record<string, string | null>>(
      session,
      badgeProbe,
      (state) => state.global === "1" && state.counts?.includes("1 pending") === true,
      30_000,
    );
    notes.push(`global sidebar badge updated via SSE: ${JSON.stringify(afterPush)}`);

    await agentBrowser(session, [
      "open",
      `${playground.baseUrl}/platform/${workspace.id}/activity`,
    ]);
    await agentBrowser(session, ["wait", "--text", "UI pending count test"]);
    const scoped = await waitForBrowser<Record<string, string | null>>(
      session,
      badgeProbe,
      (state) => state.global === "1" && state.workspace === "1",
      30_000,
    );
    notes.push(`workspace Activity badge rendered: ${JSON.stringify(scoped)}`);

    const buttons = await waitForBrowser<Array<{ text: string; disabled: boolean }>>(
      session,
      answerButtonProbe,
      (items) => items.some((item) => item.text === "Answer" && !item.disabled),
      30_000,
    );
    notes.push(`answer controls before click: ${JSON.stringify(buttons)}`);

    await browserEval<boolean>(
      session,
      `(() => {
        const button = Array.from(document.querySelectorAll('button'))
          .find((candidate) => candidate.textContent?.replace(/\\s+/g, ' ').trim() === 'Answer');
        if (!button) throw new Error('Answer button not found');
        button.click();
        return JSON.stringify(true);
      })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const answeredResp = await fetch(
      `${daemon.baseUrl}/api/elicitations/${encodeURIComponent(elicitationId)}`,
    );
    metrics.statusAfterAnswerClick = answeredResp.ok
      ? ((await answeredResp.json()) as { status?: string }).status
      : `${answeredResp.status} ${await answeredResp.text()}`;

    const afterAnswer = await waitForBrowser<Record<string, string | null>>(
      session,
      badgeProbe,
      (state) =>
        state.global === null &&
        state.workspace === null &&
        state.counts?.includes("0 pending") === true,
      30_000,
    );
    notes.push(`answer mutation decremented sidebar badges: ${JSON.stringify(afterAnswer)}`);

    return { id: "activity-sidebar-sse-ui", pass: true, notes, metrics };
  } catch (err) {
    notes.push(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return { id: "activity-sidebar-sse-ui", pass: false, notes, metrics };
  } finally {
    try {
      await agentBrowser(session, ["close"]);
    } catch {
      // browser may not have opened
    }
    if (playground) await stopProcess(playground.process);
    if (daemon) {
      await stopDaemon(daemon, { keepHome: Deno.args.includes("--keep-home") });
    }
  }
}

if (import.meta.main) {
  const result = await runScenario();
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) Deno.exit(1);
}
