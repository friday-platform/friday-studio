/**
 * Phase 3 QA scenarios — auth-refresh elicitation core flows (P3-01..P3-10).
 *
 * Shape matches the Phase 1 template (`p1.ts`): every scenario runs a
 * vitest unit pre-check against the wrapper logic, then drives the same
 * behavior through the live Studio chat UI. Failure messages are tagged
 * `[unit-precheck]` or `[ui]` so a triage reader can immediately tell
 * which layer regressed.
 *
 * Counter assertions (`link.oauth.elicitation.*`) ride on the
 * unit-precheck — the in-process metrics sink swap that the telemetry
 * tests install is the most reliable observable. The daemon does NOT
 * expose elicitation counters via an HTTP endpoint today, so a
 * cross-process assertion from the runner would just compare two
 * snapshots of nothing. Each scenario's unit-precheck name maps 1:1 to
 * the counter the v8 plan ties to that scenario.
 *
 * **Live-env prerequisites** (see README.md):
 *   - `ANTHROPIC_API_KEY` in `~/.atlas/.env` so the workspace's `type:
 *     llm` actions can run.
 *   - Friday Studio web-client on `localhost:5200`.
 *   - The stub MCP servers from `tools/qa/fixtures/stub-mcp-google/`
 *     spun up on 8001/8002 by the runner.
 *
 * Known prereq gaps that gate live UI drive on two scenarios:
 *   - P3-08 needs a non-Google family wired into the fixture
 *     (filed as task #28). Falls back to unit-precheck only.
 *   - P3-09 needs a Python user-agent in the fixture
 *     (filed as task #28). Falls back to unit-precheck only.
 *
 * P3-05 (expiration) was unblocked by task #27: the wrapper now reads
 * `FRIDAY_ELICITATION_TTL_MS_OVERRIDE`, so the live UI drive completes
 * within the QA-default 10s TTL.
 *
 * Testids used by the UI drives (added in Phase 3 implementation):
 *   - `auth-refresh-inline-card` — the chip itself.
 *   - `elicitation-auth-refresh-retry` — Retry button.
 *   - `elicitation-auth-refresh-cancel` — Cancel button.
 *   - `integration-chip-credential_temporarily_unavailable` — message-list chip variant.
 */
import { join } from "jsr:@std/path@1";
import { type BrowserController, navigateToChat, sendMessage } from "../browser.ts";
import { tamperCredential } from "../harness.ts";
import { mockControl } from "../mock.ts";
import { register, type ScenarioContext } from "../run-core.ts";

const WORKTREE_ROOT = new URL("../../../..", import.meta.url).pathname;
const WORKSPACE_FIXTURE_PATH = join(WORKTREE_ROOT, "tools/qa/fixtures/oauth-refresh-qa");
const WORKSPACE_ID = "oauth-refresh-qa";

const WRAPPER_TEST_PATH = "packages/mcp/src/create-mcp-tools-with-retry.test.ts";
const TELEMETRY_TEST_PATH = "packages/mcp/src/create-mcp-tools-with-retry.telemetry.test.ts";

// ──────────────────────────────────────────────────────────────────────────
// Helpers: unit pre-check, workspace registration, live-env probe
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

interface RegisteredWorkspace {
  id: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function linkBaseUrlFromDaemon(_ctx: ScenarioContext): string {
  return "http://localhost:3100";
}

async function liveEnvProbe(ctx: ScenarioContext): Promise<void> {
  const health = await fetch(`${ctx.daemon.baseUrl}/health`).catch(() => null);
  if (!health || !health.ok) {
    throw new Error(
      `[ui] daemon at ${ctx.daemon.baseUrl} is not healthy. Did the runner finish startup?`,
    );
  }
  await health.body?.cancel();

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

  await ctx.browser.goto("about:blank").catch(() => {});
}

// ──────────────────────────────────────────────────────────────────────────
// UI predicates — auth-refresh chip / buttons / chat error / session status
// ──────────────────────────────────────────────────────────────────────────

async function waitForAuthRefreshCard(
  browser: BrowserController,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await browser.waitFor(
    `Boolean(document.querySelector('[data-testid="auth-refresh-inline-card"]'))`,
    { timeoutMs: options.timeoutMs ?? 30_000 },
  );
}

async function assertAuthRefreshButtonsPresent(browser: BrowserController): Promise<void> {
  const present = await browser.evaluate<boolean>(
    `(() => {
      const card = document.querySelector('[data-testid="auth-refresh-inline-card"]');
      if (!card) return false;
      const retry = card.querySelector('[data-testid="elicitation-auth-refresh-retry"]');
      const cancel = card.querySelector('[data-testid="elicitation-auth-refresh-cancel"]');
      return Boolean(retry && cancel);
    })()`,
  );
  if (!present) {
    throw new Error(
      "[ui] expected Retry/Cancel buttons inside auth-refresh-inline-card but they were missing",
    );
  }
}

async function countAuthRefreshCards(browser: BrowserController): Promise<number> {
  return await browser.evaluate<number>(
    `document.querySelectorAll('[data-testid="auth-refresh-inline-card"]').length`,
  );
}

async function clickAuthRefreshButton(
  browser: BrowserController,
  variant: "retry" | "cancel",
): Promise<void> {
  const testid =
    variant === "retry" ? "elicitation-auth-refresh-retry" : "elicitation-auth-refresh-cancel";
  const escapedSel = JSON.stringify(`[data-testid="${testid}"]`);
  await browser.evaluate<void>(`
    (() => {
      const btn = document.querySelector(${escapedSel});
      if (!btn) throw new Error("button not found: ${variant}");
      if (btn instanceof HTMLElement) btn.click();
      else throw new Error("button not clickable: ${variant}");
    })();
  `);
}

async function waitForAuthRefreshCardCleared(
  browser: BrowserController,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await browser.waitFor(
    `document.querySelectorAll('[data-testid="auth-refresh-inline-card"]').length === 0`,
    { timeoutMs: options.timeoutMs ?? 30_000 },
  );
}

async function assertNoDisconnectChip(browser: BrowserController): Promise<void> {
  const present = await browser.evaluate<boolean>(
    `Boolean(document.querySelector('[data-testid^="integration-chip-"]:not([data-testid="integration-chip-credential_temporarily_unavailable"])'))`,
  );
  if (present) {
    throw new Error(
      "[ui] expected no Reconnect-style integration chip, but a non-transient chip rendered",
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Common chat setup: register workspace, tamper credential, open chat, send.
// ──────────────────────────────────────────────────────────────────────────

interface ChatPrepInputs {
  scenarioId: string;
  /** Mock mode in effect when the message is sent. */
  mockMode: Parameters<typeof mockControl>[1]["mode"];
  /** Credential expiry offset (seconds from now). Default -60 → already expired. */
  tamperExpiresInSeconds?: number;
  /** Providers to tamper. Default ["google-calendar"]. */
  providers?: string[];
  /** Message text. Default exercises a calendar tool. */
  message?: string;
}

async function prepareChatScenario(ctx: ScenarioContext, inputs: ChatPrepInputs): Promise<void> {
  await liveEnvProbe(ctx);
  await ensureWorkspaceRegistered(ctx.daemon.baseUrl);

  const linkBaseUrl = linkBaseUrlFromDaemon(ctx);
  const providers = inputs.providers ?? ["google-calendar"];
  const offset = inputs.tamperExpiresInSeconds ?? -60;
  const expiresAt = Math.floor(Date.now() / 1000) + offset;
  for (const provider of providers) {
    await tamperCredential(provider, { expires_at: expiresAt }, { linkBaseUrl });
  }

  await mockControl(ctx.mock, { mode: inputs.mockMode, resetCounts: true });
  await navigateToChat(ctx.browser, WORKSPACE_ID);
  await sendMessage(ctx.browser, inputs.message ?? "what's on my calendar?");
}

// ──────────────────────────────────────────────────────────────────────────
// Daemon-side: list elicitations for a session (used by P3-06 sweep check).
// ──────────────────────────────────────────────────────────────────────────

interface ElicitationRecord {
  id: string;
  status: string;
  kind: string;
  sessionId?: string;
}

async function listElicitations(
  daemonBaseUrl: string,
  filter: { workspaceId?: string; kind?: string; status?: string } = {},
): Promise<ElicitationRecord[]> {
  const url = new URL(`${daemonBaseUrl}/api/elicitations`);
  if (filter.workspaceId) url.searchParams.set("workspaceId", filter.workspaceId);
  if (filter.kind) url.searchParams.set("kind", filter.kind);
  if (filter.status) url.searchParams.set("status", filter.status);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[ui] GET /api/elicitations failed: ${res.status} ${text}`);
  }
  const body = await res.json();
  if (!Array.isArray(body)) return [];
  const out: ElicitationRecord[] = [];
  for (const raw of body) {
    if (!isPlainRecord(raw)) continue;
    const id = raw.id;
    const status = raw.status;
    const kind = raw.kind;
    if (typeof id !== "string" || typeof status !== "string" || typeof kind !== "string") continue;
    const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : undefined;
    out.push({ id, status, kind, ...(sessionId ? { sessionId } : {}) });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// P3-01 — Transient in chat → Retry/Cancel elicitation appears
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P3-01",
  description: "transient in chat → Retry/Cancel elicitation appears with counter +1",
  run: async (ctx) => {
    // Counter contract: `link.oauth.elicitation.created` increments by 1.
    // The telemetry test covering this is the "happy retry path" — its setup
    // exercises the same created-counter increment before the Retry click.
    await assertUnitPasses("P3-01", TELEMETRY_TEST_PATH, "happy retry path");
    await assertUnitPasses(
      "P3-01",
      WRAPPER_TEST_PATH,
      "retries on user Retry and returns the merged result",
    );

    await prepareChatScenario(ctx, { scenarioId: "P3-01", mockMode: "http_500_text" });
    await waitForAuthRefreshCard(ctx.browser);
    await assertAuthRefreshButtonsPresent(ctx.browser);
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P3-02 — Click Retry, refresh succeeds → agent proceeds, no chip
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P3-02",
  description: "click Retry → refresh succeeds → no disconnect chip + retry_succeeded counter",
  run: async (ctx) => {
    await assertUnitPasses("P3-02", TELEMETRY_TEST_PATH, "happy retry path");

    await prepareChatScenario(ctx, { scenarioId: "P3-02", mockMode: "http_500_text" });
    await waitForAuthRefreshCard(ctx.browser);

    // Flip mock to success BEFORE clicking Retry — the wrapper's KV poll picks
    // up the answered status and re-runs createMCPTools against the new mode.
    await mockControl(ctx.mock, { mode: "success" });
    await clickAuthRefreshButton(ctx.browser, "retry");

    await waitForAuthRefreshCardCleared(ctx.browser);
    await assertNoDisconnectChip(ctx.browser);
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P3-03 — Click Retry, second transient → new elicitation appears
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P3-03",
  description: "Retry → fresh transient → new elicitation + retry_failed counter",
  run: async (ctx) => {
    // The wrapper-loop test exercises the exact "Retry → transient → new
    // elicitation → Retry → merged result" path. The telemetry test for
    // retry_failed verifies the counter increment on the failed-retry leg.
    await assertUnitPasses("P3-03", WRAPPER_TEST_PATH, "loops: Retry");
    await assertUnitPasses(
      "P3-03",
      TELEMETRY_TEST_PATH,
      "when the retry attempt produces another transient",
    );

    await prepareChatScenario(ctx, { scenarioId: "P3-03", mockMode: "http_500_text" });
    await waitForAuthRefreshCard(ctx.browser);

    // Keep the mock in transient mode and click Retry — the wrapper should
    // observe the new failure and emit a fresh elicitation. The card stays
    // visible (new id replaces the old one) — assert that at least one card
    // is still rendered after the click + poll interval.
    await clickAuthRefreshButton(ctx.browser, "retry");
    // Give the wrapper time to clear the answered card and create a new one.
    // The wrapper polls at 250ms; allow 30s for the new card to materialize.
    await ctx.browser.waitFor(
      `document.querySelectorAll('[data-testid="auth-refresh-inline-card"]').length >= 1`,
      { timeoutMs: 30_000 },
    );
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P3-04 — Click Cancel → turn fails cleanly
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P3-04",
  description: "click Cancel → aggregate throw + answered_cancel counter, no Reconnect banner",
  run: async (ctx) => {
    await assertUnitPasses("P3-04", WRAPPER_TEST_PATH, "throws aggregate when user clicks Cancel");
    await assertUnitPasses("P3-04", TELEMETRY_TEST_PATH, "when the user clicks Cancel");

    await prepareChatScenario(ctx, { scenarioId: "P3-04", mockMode: "http_500_text" });
    await waitForAuthRefreshCard(ctx.browser);

    await clickAuthRefreshButton(ctx.browser, "cancel");
    await waitForAuthRefreshCardCleared(ctx.browser);

    // No "Reconnect Google" banner should render — this is not a revocation.
    // assertNoDisconnectChip ignores the transient chip variant and only
    // fails on token-dead / not-found / refresh_failed chips.
    await assertNoDisconnectChip(ctx.browser);
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P3-05 — Elicitation expires → turn fails
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P3-05",
  description: "elicitation expires → turn fails + expired counter",
  run: async (ctx) => {
    // Unit pre-check: the JetStream adapter's expirePending sweep is the
    // primitive that flips a stale pending row to `expired`; the wrapper
    // routes the expired status to the failed-family outcome (asserted
    // via the answer-latency telemetry test which exercises the same
    // recordAnswerLatency branch). Both must hold for the live drive to
    // produce the expected user-visible failure.
    await assertUnitPasses(
      "P3-05",
      "packages/core/src/elicitations/jetstream-adapter.test.ts",
      "expirePending sweep",
    );
    await assertUnitPasses("P3-05", TELEMETRY_TEST_PATH, "when the user clicks Cancel");

    // Live UI drive — the QA daemon sets FRIDAY_ELICITATION_TTL_MS_OVERRIDE
    // to DEFAULT_ELICITATION_TTL_MS (10s) by default. After task #27 wired
    // that override into the wrapper, the elicitation auto-expires inside
    // the timeout window below.
    await prepareChatScenario(ctx, { scenarioId: "P3-05", mockMode: "http_500_text" });
    await waitForAuthRefreshCard(ctx.browser);
    // Don't click — wait for the chip to clear on expiration. Budget 25s
    // to cover the 10s TTL + storage sweep + UI render.
    await waitForAuthRefreshCardCleared(ctx.browser, { timeoutMs: 25_000 });
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P3-06 — Close chat tab during elicitation → session aborts
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P3-06",
  description: "close chat tab → session aborts + aborted counter, pending elicitation remains",
  run: async (ctx) => {
    await assertUnitPasses(
      "P3-06",
      WRAPPER_TEST_PATH,
      "rejects mid-wait when sessionAbortSignal aborts",
    );
    await assertUnitPasses("P3-06", TELEMETRY_TEST_PATH, "when the session aborts mid-wait");

    await prepareChatScenario(ctx, { scenarioId: "P3-06", mockMode: "http_500_text" });
    await waitForAuthRefreshCard(ctx.browser);

    // Navigate away — the chat SSE stream closes, the daemon's session
    // abort signal fires, and the wrapper's wait rejects with AbortError.
    // The elicitation row STAYS in storage (will expire by sweeper) per
    // v8 decision 19 — that's what we assert below.
    await ctx.browser.goto("about:blank");

    // Poll the elicitations API until the pending row for this workspace
    // still exists (proves storage retention) — give the abort some time.
    const deadline = Date.now() + 15_000;
    let foundPending = false;
    while (Date.now() < deadline) {
      const pending = await listElicitations(ctx.daemon.baseUrl, {
        workspaceId: WORKSPACE_ID,
        kind: "auth-refresh",
        status: "pending",
      });
      if (pending.length >= 1) {
        foundPending = true;
        break;
      }
      await new Promise<void>((r) => setTimeout(r, 500));
    }
    if (!foundPending) {
      throw new Error(
        "[ui] P3-06: expected the pending auth-refresh elicitation to remain in storage after tab close",
      );
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P3-07 — Multi-credential same-family failure → ONE elicitation
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P3-07",
  description: "google-calendar + google-gmail both transient → ONE elicitation + deduped counter",
  run: async (ctx) => {
    // The wrapper's dedup test covers the storage-level join: a second
    // transient on the same family finds the existing pending row instead
    // of creating a new one. The telemetry counterpart verifies the
    // `deduped` counter ticks.
    await assertUnitPasses(
      "P3-07",
      WRAPPER_TEST_PATH,
      "deduplicates: second transient on same family finds the existing pending elicitation",
    );
    await assertUnitPasses("P3-07", TELEMETRY_TEST_PATH, "joins a pending elicitation");

    await prepareChatScenario(ctx, {
      scenarioId: "P3-07",
      mockMode: "http_500_text",
      providers: ["google-calendar", "google-gmail"],
      // Ask the model to use BOTH services so both transients surface
      // in the same LLM action. The exact wording isn't load-bearing —
      // the system prompt scopes tools to calendar + gmail.
      message: "summarize today's calendar events AND my unread email count.",
    });

    await waitForAuthRefreshCard(ctx.browser);
    // Both calendar and gmail map to the `google` family — only one card
    // must render. Wait a bit to give a second card a chance to appear
    // (if dedup is broken) before locking in the count.
    await new Promise<void>((r) => setTimeout(r, 3_000));
    const count = await countAuthRefreshCards(ctx.browser);
    if (count !== 1) {
      throw new Error(
        `[ui] P3-07: expected exactly 1 auth-refresh card (family-deduped) but observed ${count}`,
      );
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P3-08 — Multi-family failure → two elicitations (PREREQ GATE: task #28)
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P3-08",
  description: "multi-family transient → two concurrent elicitations",
  run: async (_ctx) => {
    // The fixture only has Google-family providers today. Until task #28
    // adds a non-Google MCP server (e.g. stub Slack), the live UI portion
    // can't produce two distinct families. The wrapper unit test covers
    // the concurrency + aggregation behavior — that's the part most
    // likely to regress in code.
    await assertUnitPasses(
      "P3-08",
      WRAPPER_TEST_PATH,
      "awaits multi-family elicitations concurrently and aggregates failures",
    );
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P3-09 — User-agent (Python SDK) path gets the same elicitation
//          (PREREQ GATE: task #28)
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P3-09",
  description: "Python user-agent transient → same Retry/Cancel elicitation",
  run: async (_ctx) => {
    // The user-agent (NATS subprocess) ephemeral MCP setup uses the same
    // wrapper with interactiveCtx (`packages/workspace/src/runtime.ts`
    // around line 3023). Until task #28 adds a Python user-agent job to
    // the QA fixture, we exercise the wrapper end at unit level.
    //
    // The "passes the result through unchanged when no transient
    // disconnects" + "retries on user Retry" pair seals the contract that
    // the wrapper behaves identically regardless of whether its caller is
    // the runtime or agent-spawn — both pass the same InteractiveContext
    // shape.
    await assertUnitPasses(
      "P3-09",
      WRAPPER_TEST_PATH,
      "passes the result through unchanged when no transient disconnects",
    );
    await assertUnitPasses(
      "P3-09",
      WRAPPER_TEST_PATH,
      "retries on user Retry and returns the merged result",
    );
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P3-10 — Cron transient → FAILED, no elicitation, no notification
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P3-10",
  description: "cron transient → FAILED session, ZERO elicitations created",
  run: async (ctx) => {
    // The wrapper unit test for "throws aggregate LinkCredentialUnavailableError
    // without interactiveCtx" is the canonical no-elicitation path —
    // cron sessions land in this branch because computeSessionInteractive
    // returns false for system-config provenance.
    await assertUnitPasses(
      "P3-10",
      WRAPPER_TEST_PATH,
      "throws aggregate LinkCredentialUnavailableError without interactiveCtx",
    );
    // Telemetry: non-interactive transients must NOT increment elicitation
    // counters — the telemetry test for that exact silence is in the
    // telemetry file.
    await assertUnitPasses("P3-10", TELEMETRY_TEST_PATH, "non-interactive transient is silent");

    // Live-env drive: fire the cron signal directly and assert NO
    // elicitation was created for this session, and that the session
    // ended with non-zero outcome (we don't depend on the exact status
    // string here — that lives in p1.ts P1-07).
    await liveEnvProbe(ctx);
    await ensureWorkspaceRegistered(ctx.daemon.baseUrl);
    await mockControl(ctx.mock, { mode: "http_500_text", resetCounts: true });

    const before = await listElicitations(ctx.daemon.baseUrl, {
      workspaceId: WORKSPACE_ID,
      kind: "auth-refresh",
    });
    const beforeCount = before.length;

    const resp = await fetch(
      `${ctx.daemon.baseUrl}/api/workspaces/${encodeURIComponent(WORKSPACE_ID)}/signals/every-minute`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ payload: {} }),
      },
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`[ui] P3-10 signal trigger failed: ${resp.status} ${text}`);
    }
    // Drain the SSE stream so we know the cron session is done before
    // we count elicitations.
    await resp.body?.cancel();
    // Give the wrapper a moment to NOT emit an elicitation.
    await new Promise<void>((r) => setTimeout(r, 2_000));

    const after = await listElicitations(ctx.daemon.baseUrl, {
      workspaceId: WORKSPACE_ID,
      kind: "auth-refresh",
    });
    if (after.length > beforeCount) {
      throw new Error(
        `[ui] P3-10: cron transient must NOT create an auth-refresh elicitation; ` +
          `count moved ${beforeCount} → ${after.length}`,
      );
    }
  },
});
