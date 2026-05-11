/**
 * Phase 1 QA scenarios — Link-side classifier behavior (no auth-refresh
 * elicitation yet; that's Phase 3).
 *
 * Each scenario follows a two-stage shape:
 *
 *   1. **Unit pre-check.** Run the corresponding vitest case from the
 *      impl tasks (#1-#7). This is a fast logic-regression seal — if
 *      the classifier or routing function is broken, the scenario
 *      surfaces it in seconds without paying for a browser session.
 *   2. **Live UI drive.** Boot the workspace, hit the actual UI path
 *      via the runner's shared mock/daemon/browser context, and assert
 *      the rendered DOM state matches what the QA plan describes.
 *
 * Failure messages are prefixed `[unit-precheck]` or `[ui]` so a
 * post-mortem reader can immediately tell whether the logic or the
 * UX-binding regressed.
 *
 * **Telemetry counter assertions are intentionally absent.** The QA plan
 * scopes counters under Phase 3 (#17 — not landed yet). Each scenario
 * carries a `TODO(task-17): assert counter delta…` comment in the spot
 * the assertion belongs, ready to be unwrapped when the meter ships.
 *
 * **Live-env prerequisites** (see README.md for fuller setup):
 *   - `ANTHROPIC_API_KEY` in `~/.atlas/.env` so the workspace's `type:
 *     llm` actions can run.
 *   - Friday Studio web-client on `localhost:5200` for chat scenarios.
 *   - The stub MCP servers from `tools/qa/fixtures/stub-mcp-google/`
 *     spun up on 8001/8002 by the runner.
 *
 * Phase 1 UI shape: the **existing** `data-integration-disconnected`
 * chip from `chat-message-list.svelte` — NOT the Phase 3 auth-refresh
 * elicitation chip. Scenarios assert on `data-testid="integration-chip"`
 * which now exists thanks to Stage 1 of #22.
 */
import { join } from "jsr:@std/path@1";
import {
  assertChipVisible,
  assertSessionStatus,
  type BrowserController,
  navigateToChat,
  sendMessage,
} from "../browser.ts";
import { readCredential, tamperCredential } from "../harness.ts";
import { mockControl, mockCounts } from "../mock.ts";
import { register, type ScenarioContext } from "../run-core.ts";

const WORKTREE_ROOT = new URL("../../../..", import.meta.url).pathname;
const WORKSPACE_FIXTURE_PATH = join(WORKTREE_ROOT, "tools/qa/fixtures/oauth-refresh-qa");
const WORKSPACE_ID = "oauth-refresh-qa";

// ──────────────────────────────────────────────────────────────────────────
// Helpers: unit pre-check, log tail, live-env probe
// ──────────────────────────────────────────────────────────────────────────

interface DenoTestResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function runVitestFilter(testPath: string, nameFilter: string): Promise<DenoTestResult> {
  const cmd = new Deno.Command("deno", {
    args: ["task", "test", testPath, "-t", nameFilter],
    cwd: WORKTREE_ROOT,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    ok: code === 0,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

async function assertUnitPasses(
  scenarioId: string,
  testPath: string,
  nameFilter: string,
): Promise<void> {
  const result = await runVitestFilter(testPath, nameFilter);
  if (!result.ok) {
    throw new Error(
      `[unit-precheck] ${scenarioId}: vitest "${nameFilter}" in ${testPath} failed.\n` +
        `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
}

/**
 * Best-effort tail of the daemon's global.log. Returns the number of
 * lines matching `pattern`. Used by P1-04 to assert the platform-bug
 * loud-log line surfaced. Inlined here for now; if any other scenario
 * needs log inspection, promote to `harness.ts`.
 *
 * TODO(follow-up): move into harness.ts once a second caller appears.
 */
async function countDaemonLogMatches(fridayHome: string, pattern: RegExp): Promise<number> {
  const path = join(fridayHome, "logs", "global.log");
  let content: string;
  try {
    content = await Deno.readTextFile(path);
  } catch {
    return 0;
  }
  const matches = content.match(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`));
  return matches ? matches.length : 0;
}

interface RegisteredWorkspace {
  id: string;
}

/**
 * Register the OAuth-refresh-qa workspace if it isn't already. Idempotent —
 * scenarios share the workspace; the first scenario to register pays the
 * cost, the rest hit the daemon's already-registered path.
 *
 * `registerWorkspace` types its first arg as the full `DaemonHandle` but
 * only reads `baseUrl` at runtime. We hit the daemon's HTTP route directly
 * to skip the typing dance.
 */
async function ensureWorkspaceRegistered(daemonBaseUrl: string): Promise<RegisteredWorkspace> {
  const res = await fetch(`${daemonBaseUrl}/api/workspaces/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: WORKSPACE_FIXTURE_PATH, name: "OAuth Refresh QA" }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[ui] POST /api/workspaces/add failed: ${res.status} ${text}`);
  }
  const body = await res.json();
  const id = isPlainRecord(body) && typeof body.id === "string" ? body.id : null;
  if (id === null) {
    throw new Error(`[ui] /api/workspaces/add returned no id: ${JSON.stringify(body)}`);
  }
  return { id };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function liveEnvProbe(ctx: ScenarioContext): Promise<void> {
  // Daemon health (always required).
  const health = await fetch(`${ctx.daemon.baseUrl}/health`).catch(() => null);
  if (!health || !health.ok) {
    throw new Error(
      `[ui] daemon at ${ctx.daemon.baseUrl} is not healthy. Did the runner finish startup?`,
    );
  }
  await health.body?.cancel();

  // Link service (required for any scenario that touches a credential —
  // i.e. all chat-driven scenarios and the cron/webhook signal scenarios).
  // Atlasd proxies to Link via LINK_SERVICE_URL; it does NOT spawn Link.
  const linkBase = linkBaseUrlFromDaemon(ctx);
  const linkHealth = await fetch(`${linkBase}/health`).catch(() => null);
  if (!linkHealth || !linkHealth.ok) {
    throw new Error(
      `[ui] Link service at ${linkBase} is unreachable. Start it in a separate shell:\n` +
        `    cd apps/link && LINK_DEV_MODE=true deno task start\n` +
        `(see tools/qa/oauth-resilience/README.md for full prereqs)`,
    );
  }
  await linkHealth.body?.cancel();

  // Studio web-client probe (best-effort — non-chat scenarios tolerate
  // the web-client being absent because they assert via SSE).
  await ctx.browser.goto("about:blank").catch(() => {});
}

// ──────────────────────────────────────────────────────────────────────────
// Scenario implementations
// ──────────────────────────────────────────────────────────────────────────

interface ChatScenarioInputs {
  scenarioId: string;
  mockMode: Parameters<typeof mockControl>[1]["mode"];
  tamperExpiresInSeconds?: number;
  message: string;
  expectChip: boolean;
  /** When set, assert the credential's secret was preserved across the call. */
  assertCredentialPreserved: { provider: string } | null;
}

async function runChatScenario(ctx: ScenarioContext, inputs: ChatScenarioInputs): Promise<void> {
  await liveEnvProbe(ctx);
  await ensureWorkspaceRegistered(ctx.daemon.baseUrl);

  // Optional credential tamper — used for the < 60s vs ≥ 60s threshold
  // scenarios (P1-05, P1-06) and the expired-token scenarios.
  let credentialBefore: Awaited<ReturnType<typeof readCredential>> | null = null;
  if (inputs.assertCredentialPreserved !== null) {
    credentialBefore = await readCredential(inputs.assertCredentialPreserved.provider, {
      linkBaseUrl: linkBaseUrlFromDaemon(ctx),
    });
  }
  if (inputs.tamperExpiresInSeconds !== undefined) {
    const expiresAt = Math.floor(Date.now() / 1000) + inputs.tamperExpiresInSeconds;
    await tamperCredential(
      inputs.assertCredentialPreserved?.provider ?? "google-calendar",
      { expires_at: expiresAt },
      { linkBaseUrl: linkBaseUrlFromDaemon(ctx) },
    );
  }

  await mockControl(ctx.mock, { mode: inputs.mockMode, resetCounts: true });
  await navigateToChat(ctx.browser, WORKSPACE_ID);
  await sendMessage(ctx.browser, inputs.message);

  if (inputs.expectChip) {
    await assertChipVisible(ctx.browser, /disconnect|reconnect/i, { timeoutMs: 30_000 });
  } else {
    // Silent path — make sure NO chip rendered after a reasonable wait.
    await new Promise<void>((r) => setTimeout(r, 2_000));
    await assertNoChip(ctx.browser);
  }

  if (inputs.assertCredentialPreserved !== null && credentialBefore !== null) {
    const after = await readCredential(inputs.assertCredentialPreserved.provider, {
      linkBaseUrl: linkBaseUrlFromDaemon(ctx),
    });
    if (after.secret.refresh_token !== credentialBefore.secret.refresh_token) {
      throw new Error(
        `[ui] ${inputs.scenarioId}: credential refresh_token changed (${String(
          credentialBefore.secret.refresh_token,
        )} → ${String(after.secret.refresh_token)}) — Phase 1 must preserve it.`,
      );
    }
  }
}

async function assertNoChip(browser: BrowserController): Promise<void> {
  const present = await browser.evaluate<boolean>(
    `Boolean(document.querySelector('[data-testid^="integration-chip"], [data-integration-disconnected]'))`,
  );
  if (present) {
    throw new Error("[ui] expected no integration chip, but one rendered");
  }
}

function linkBaseUrlFromDaemon(_ctx: ScenarioContext): string {
  // The QA daemon co-locates Link on port 3100 by default. If a scenario
  // ever needs to point at a non-default port, override here.
  return "http://localhost:3100";
}

interface SignalScenarioInputs {
  scenarioId: string;
  mockMode: Parameters<typeof mockControl>[1]["mode"];
  signalId: "every-minute" | "refresh-webhook";
  expectStatus: "FAILED" | "SKIPPED";
}

async function runSignalScenario(
  ctx: ScenarioContext,
  inputs: SignalScenarioInputs,
): Promise<void> {
  await liveEnvProbe(ctx);
  const ws = await ensureWorkspaceRegistered(ctx.daemon.baseUrl);
  await mockControl(ctx.mock, { mode: inputs.mockMode, resetCounts: true });

  const outcome = await triggerSignalDirect(ctx.daemon.baseUrl, ws.id, inputs.signalId);

  if (outcome.status.toUpperCase() !== inputs.expectStatus) {
    throw new Error(
      `[ui] ${inputs.scenarioId}: expected session ${inputs.expectStatus} but got ` +
        `"${outcome.status.toUpperCase()}" (error=${outcome.errorMessage ?? "<none>"})`,
    );
  }

  // Drive the Sessions-page badge too if Studio is up — that's the
  // user-visible surface. If the page isn't available (404 / connection
  // refused), fall back to the HTTP assertion above and continue.
  await assertSessionStatus(ctx.browser, inputs.expectStatus, {
    sessionId: outcome.sessionId ?? undefined,
    timeoutMs: 15_000,
  }).catch(() => {
    // Best-effort — the SSE jobComplete.status already proved the routing.
  });
}

interface SignalOutcome {
  status: string;
  sessionId: string | null;
  errorMessage: string | null;
}

/**
 * Drive the daemon's signal-trigger SSE endpoint directly. Smaller than
 * pulling in `triggerSignalSSE` from the live-daemon harness (which wants
 * a full `DaemonHandle` shape we'd have to fabricate), but follows the same
 * stream-parsing pattern.
 */
async function triggerSignalDirect(
  daemonBaseUrl: string,
  workspaceId: string,
  signalId: string,
): Promise<SignalOutcome> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  let resp: Response;
  try {
    resp = await fetch(
      `${daemonBaseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/signals/${encodeURIComponent(signalId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ payload: {} }),
        signal: ctrl.signal,
      },
    );
  } catch (err) {
    clearTimeout(timer);
    throw new Error(
      `[ui] signal trigger fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!resp.ok) {
    clearTimeout(timer);
    const text = await resp.text();
    throw new Error(`[ui] signal trigger ${resp.status}: ${text}`);
  }
  if (!resp.body) {
    clearTimeout(timer);
    throw new Error("[ui] signal trigger response had no body");
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let status = "";
  let sessionId: string | null = null;
  let errorMessage: string | null = null;
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
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const raw = dataLine.slice(5).trim();
        if (raw === "[DONE]") {
          buffer = "";
          break;
        }
        const parsed = safeParse(raw);
        if (!parsed) continue;
        if (parsed.type === "job-complete" && isPlainRecord(parsed.data)) {
          const s = parsed.data.status;
          if (typeof s === "string") status = s;
          const sid = parsed.data.sessionId;
          if (typeof sid === "string") sessionId = sid;
        } else if (parsed.type === "job-error" && isPlainRecord(parsed.data)) {
          const e = parsed.data.error;
          errorMessage = typeof e === "string" ? e : JSON.stringify(parsed.data);
        } else if (parsed.type === "data-session-start" && isPlainRecord(parsed.data)) {
          const sid = parsed.data.sessionId;
          if (typeof sid === "string") sessionId = sid;
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
  return { status, sessionId, errorMessage };
}

interface SSEFrame {
  type: string;
  data: unknown;
}

function safeParse(raw: string): SSEFrame | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainRecord(parsed)) return null;
    const t = parsed.type;
    if (typeof t !== "string") return null;
    return { type: t, data: parsed.data };
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// P1-01 — invalid_grant produces Reconnect banner (regression)
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P1-01",
  description: "invalid_grant produces Reconnect banner (regression)",
  run: async (ctx) => {
    await assertUnitPasses("P1-01", "apps/link/tests/oauth.test.ts", "HTTP 4xx invalid_grant");
    await assertUnitPasses(
      "P1-01",
      "packages/workspace/src/runtime.test.ts",
      "LinkCredentialNotFoundError",
    );
    await runChatScenario(ctx, {
      scenarioId: "P1-01",
      mockMode: "invalid_grant",
      tamperExpiresInSeconds: -60,
      message: "what's on my calendar?",
      expectChip: true,
      assertCredentialPreserved: { provider: "google-calendar" },
    });
    // TODO(task-17): assert counter delta refresh.outcome{kind=token_dead} ≥ 1
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P1-02 — transient 500 does NOT brick the credential
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P1-02",
  description: "transient 500 does NOT brick the credential",
  run: async (ctx) => {
    await assertUnitPasses(
      "P1-02",
      "apps/link/tests/oauth.test.ts",
      "transient Cloud Function failure surfaces refresh_unavailable",
    );
    await runChatScenario(ctx, {
      scenarioId: "P1-02",
      mockMode: "http_500_text",
      tamperExpiresInSeconds: -60,
      message: "what's on my calendar?",
      expectChip: true,
      assertCredentialPreserved: { provider: "google-calendar" },
    });
    // Switch mock to success and re-send — second call must succeed.
    await mockControl(ctx.mock, { mode: "success" });
    await sendMessage(ctx.browser, "try again — what's on my calendar?");
    // No new chip expected this time.
    await new Promise<void>((r) => setTimeout(r, 2_000));
    await assertNoChip(ctx.browser);
    // TODO(task-17): assert counter delta refresh.outcome{kind=transient} ≥ 1
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P1-03 — retry inside refreshDelegatedToken saves a blip
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P1-03",
  description: "retry inside refreshDelegatedToken saves a blip",
  run: async (ctx) => {
    await assertUnitPasses(
      "P1-03",
      "apps/link/src/oauth/delegated.test.ts",
      "one-retry behavior: first attempt 500, second 200",
    );
    await mockControl(ctx.mock, { mode: "flaky", resetCounts: true });
    await runChatScenario(ctx, {
      scenarioId: "P1-03",
      mockMode: "flaky",
      tamperExpiresInSeconds: -60,
      message: "what's on my calendar?",
      expectChip: false, // retry succeeded, agent proceeds normally
      assertCredentialPreserved: { provider: "google-calendar" },
    });
    const counts = await mockCounts(ctx.mock);
    if (counts.flakyCallCount < 2) {
      throw new Error(
        `[ui] P1-03: expected ≥2 refresh calls (flaky mode) but mock saw ${counts.flakyCallCount}`,
      );
    }
    // TODO(task-17): assert counter delta retry_saved ≥ 1
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P1-04 — platform_bug surfaces loud log, no user reconnect
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P1-04",
  description: "platform_bug surfaces loud log, no user reconnect",
  run: async (ctx) => {
    await assertUnitPasses(
      "P1-04",
      "apps/link/src/oauth/delegated.test.ts",
      "kind=transient platform_bug on 4xx with other error code",
    );
    await runChatScenario(ctx, {
      scenarioId: "P1-04",
      mockMode: "invalid_client",
      tamperExpiresInSeconds: -60,
      message: "what's on my calendar?",
      expectChip: true, // Phase 1 behavior: surfaces existing chip
      assertCredentialPreserved: { provider: "google-calendar" },
    });
    const loudLines = await countDaemonLogMatches(
      ctx.daemon.fridayHome,
      /oauth_refresh_platform_bug.*invalid_client/,
    );
    if (loudLines < 1) {
      throw new Error(
        `[ui] P1-04: expected ≥1 loud log line matching oauth_refresh_platform_bug+invalid_client, ` +
          `but found ${loudLines} in ${ctx.daemon.fridayHome}/logs/global.log`,
      );
    }
    // TODO(task-17): assert counter delta refresh.outcome{kind=transient,reason=platform_bug} ≥ 1
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P1-05 — proactive refresh with ≥ 60s life is silent
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P1-05",
  description: "proactive refresh with ≥ 60s access_token life is silent",
  run: async (ctx) => {
    await assertUnitPasses(
      "P1-05",
      "apps/link/tests/oauth.test.ts",
      "Plain-text HTTP 500 with access_token ≥ 60s → ready",
    );
    // 240s of life: refresh attempt fires (< 5min buffer) but the still-valid
    // access_token lets us fall back silently with no chip.
    await runChatScenario(ctx, {
      scenarioId: "P1-05",
      mockMode: "http_500_text",
      tamperExpiresInSeconds: 240,
      message: "what's on my calendar?",
      expectChip: false,
      assertCredentialPreserved: { provider: "google-calendar" },
    });
    // TODO(task-17): assert counter delta silent_fallback ≥ 1
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P1-06 — proactive refresh with < 60s life escalates
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P1-06",
  description: "proactive refresh with < 60s access_token life escalates",
  run: async (ctx) => {
    await assertUnitPasses(
      "P1-06",
      "apps/link/tests/oauth.test.ts",
      "Plain-text HTTP 500 with access_token < 60s",
    );
    await runChatScenario(ctx, {
      scenarioId: "P1-06",
      mockMode: "http_500_text",
      tamperExpiresInSeconds: 30,
      message: "what's on my calendar?",
      expectChip: true,
      assertCredentialPreserved: { provider: "google-calendar" },
    });
    // TODO(task-17): assert counter delta refresh.outcome{kind=transient} ≥ 1 (no silent_fallback)
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P1-07 — cron transient → session FAILED (was SKIPPED)
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P1-07",
  description: "cron transient → session FAILED (was SKIPPED) via LinkCredentialUnavailableError",
  run: async (ctx) => {
    // Unit pre-check: the classifier routes the new error class to "failed".
    await assertUnitPasses(
      "P1-07",
      "packages/workspace/src/runtime.test.ts",
      "LinkCredentialUnavailableError",
    );
    await runSignalScenario(ctx, {
      scenarioId: "P1-07",
      mockMode: "http_500_text",
      signalId: "every-minute",
      expectStatus: "FAILED",
    });
    // TODO(task-17): assert counter delta session.failed{cause=credential_temporarily_unavailable} ≥ 1
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P1-08 — cron invalid_grant → session SKIPPED (regression)
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P1-08",
  description:
    "cron invalid_grant → session SKIPPED (regression — classifier preserves prior behavior)",
  run: async (ctx) => {
    await assertUnitPasses(
      "P1-08",
      "packages/workspace/src/runtime.test.ts",
      "LinkCredentialNotFoundError",
    );
    await runSignalScenario(ctx, {
      scenarioId: "P1-08",
      mockMode: "invalid_grant",
      signalId: "every-minute",
      expectStatus: "SKIPPED",
    });
    // TODO(task-17): assert counter delta session.skipped{cause=credential_*} ≥ 1
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P1-09 — prewarm transient → phase "transient" distinct from "auth"
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P1-09",
  description:
    "prewarm transient → phase 'transient' distinct from 'auth' (via classifyProbeError)",
  run: async () => {
    // The mcp-tool-cache phase classifier maps the new error class to
    // phase "transient" specifically; that's the QA plan's observable.
    // Phase 1 doesn't change the playground rendering itself (no new
    // UI label has shipped yet) — the assertion is at the cache API level.
    // TODO(follow-up): once Phase 3 (#16) ships a "transient" chip in
    // the playground prewarm error display, add a browser assertion here.
    await assertUnitPasses(
      "P1-09",
      "apps/atlasd/routes/mcp-tool-cache.test.ts",
      "returns phase 'transient' for LinkCredentialUnavailableError",
    );
    await assertUnitPasses(
      "P1-09",
      "apps/atlasd/routes/mcp-tool-cache.test.ts",
      "kind-aware probe → classifier yields phase 'transient'",
    );
    // TODO(task-17): assert counter delta probe.outcome{phase=transient} ≥ 1
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P1-10 — prewarm invalid_grant → phase "auth" (regression)
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P1-10",
  description:
    "prewarm invalid_grant → phase 'auth' (regression — classifier preserves prior behavior)",
  run: async () => {
    await assertUnitPasses(
      "P1-10",
      "apps/atlasd/routes/mcp-tool-cache.test.ts",
      "returns phase 'auth' for LinkCredentialNotFoundError",
    );
    await assertUnitPasses(
      "P1-10",
      "apps/atlasd/routes/mcp-tool-cache.test.ts",
      "other disconnected kinds → classifier yields phase 'auth'",
    );
    // TODO(task-17): assert counter delta probe.outcome{phase=auth} ≥ 1
  },
});
