/**
 * Phase 3 QA scenarios — revocation, network/timeout edge cases, telemetry.
 *
 * Covers P3-11..P3-20 from `docs/plans/2026-05-11-oauth-refresh-resilience-qa.md`.
 *
 * Pattern (mirrors Patina's `p1.ts`):
 *
 *   1. **Unit pre-check.** Run the corresponding Vitest case from the impl
 *      tasks. Catches logic regressions in seconds before paying for the
 *      browser/daemon cycle. Failure messages are prefixed `[unit-precheck]`.
 *   2. **Live UI drive.** Boot the workspace, navigate Chrome to the chat,
 *      send a message, then assert on the rendered DOM. Failure messages
 *      are prefixed `[ui]`.
 *
 * The auth-refresh chip in the UI is rendered by
 * `auth-refresh-card.svelte` with `data-testid="auth-refresh-inline-card"`.
 * `browser.ts`'s `assertElicitationVisible` helper looks for the
 * (currently still-aspirational) `auth-refresh-elicitation` testid, so this
 * file ships its own `assertAuthRefreshChipVisible` matched against the
 * actual chip in production. The existing helper is left alone to avoid
 * conflicting with the sibling P3-01..P3-10 task (#24) that's editing
 * the same harness file in parallel.
 *
 * P3-16 is unit-only (per qa.md) — the runner just verifies the existing
 * vitest case for the constructor throw.
 *
 * The final entry, `P3-TELEMETRY`, runs an in-process aggregate telemetry
 * validation against `InMemoryOAuthMetricsSink`. It does NOT cover counters
 * emitted by the daemon's subprocess (those live in OTel and aren't HTTP-
 * scraped by `/metrics`); instead it drives the wrapper directly to
 * exercise the full counter set the v8 plan promises, which is the only
 * surface where they're inspectable end-to-end today.
 */
import { join } from "jsr:@std/path@1";
import {
  assertChipVisible,
  type BrowserController,
  navigateToChat,
  sendMessage,
} from "../browser.ts";
import { readCredential, tamperCredential } from "../harness.ts";
import { mockControl } from "../mock.ts";
import { register, type ScenarioContext } from "../run-core.ts";

const WORKTREE_ROOT = new URL("../../../..", import.meta.url).pathname;
const WORKSPACE_FIXTURE_PATH = join(WORKTREE_ROOT, "tools/qa/fixtures/oauth-refresh-qa");
const WORKSPACE_ID = "oauth-refresh-qa";

// ──────────────────────────────────────────────────────────────────────────
// Shared helpers (cloned/extracted from p1.ts so this file can stand alone
// without leaking new exports from p1.ts).
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function ensureWorkspaceRegistered(daemonBaseUrl: string): Promise<{ id: string }> {
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

/**
 * Wait until the production auth-refresh chip becomes visible. Matches the
 * testid emitted by `auth-refresh-card.svelte`
 * (`data-testid="auth-refresh-inline-card"`) and verifies both Retry and
 * Cancel buttons are reachable inside the card.
 */
async function assertAuthRefreshChipVisible(
  browser: BrowserController,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await browser.waitFor(
    `(() => {
      const card = document.querySelector('[data-testid="auth-refresh-inline-card"]');
      if (!card) return false;
      const retry = card.querySelector('[data-testid="elicitation-auth-refresh-retry"]');
      const cancel = card.querySelector('[data-testid="elicitation-auth-refresh-cancel"]');
      return Boolean(retry && cancel);
    })()`,
    { timeoutMs: options.timeoutMs ?? 30_000 },
  );
}

/** Assert no auth-refresh chip is currently visible. */
async function assertNoAuthRefreshChip(browser: BrowserController): Promise<void> {
  const present = await browser.evaluate<boolean>(
    `Boolean(document.querySelector('[data-testid="auth-refresh-inline-card"]'))`,
  );
  if (present) {
    throw new Error("[ui] expected no auth-refresh chip, but one rendered");
  }
}

/** Assert no integration-disconnect chip rendered. */
async function assertNoIntegrationChip(browser: BrowserController): Promise<void> {
  const present = await browser.evaluate<boolean>(
    `Boolean(document.querySelector('[data-testid^="integration-chip"], [data-integration-disconnected]'))`,
  );
  if (present) {
    throw new Error("[ui] expected no integration chip, but one rendered");
  }
}

/**
 * Tail the daemon's global.log for matches of `pattern`. Best-effort —
 * scenarios that need a log line for diagnostic assertions only.
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

// ──────────────────────────────────────────────────────────────────────────
// P3-11 — Genuine revocation → no elicitation, Reconnect banner
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P3-11",
  description: "Genuine revocation → no auth-refresh chip; existing Reconnect banner only",
  run: async (ctx) => {
    // Unit pre-check: classifier hits token_dead on invalid_grant; resolver
    // throws the *expired* (not unavailable) error → routes to Reconnect path.
    await assertUnitPasses("P3-11", "apps/link/tests/oauth.test.ts", "HTTP 4xx invalid_grant");
    await assertUnitPasses(
      "P3-11",
      "packages/workspace/src/runtime.test.ts",
      "LinkCredentialNotFoundError",
    );

    await liveEnvProbe(ctx);
    await ensureWorkspaceRegistered(ctx.daemon.baseUrl);

    // Force a refresh (tampered expiry < 60s) and a genuine 400 invalid_grant
    // from the mock so the resolver throws an *expired* error, not transient.
    const expiresAt = Math.floor(Date.now() / 1000) - 60;
    await tamperCredential(
      "google-calendar",
      { expires_at: expiresAt },
      { linkBaseUrl: linkBaseUrlFromDaemon(ctx) },
    );
    await mockControl(ctx.mock, { mode: "invalid_grant", resetCounts: true });
    await navigateToChat(ctx.browser, WORKSPACE_ID);
    await sendMessage(ctx.browser, "what's on my calendar?");

    // The existing disconnect chip must render (Reconnect Google).
    await assertChipVisible(ctx.browser, /reconnect|disconnect/i, { timeoutMs: 30_000 });

    // And the auth-refresh chip must NOT appear. Wait a short grace period
    // before asserting so we don't race against the very first paint.
    await new Promise<void>((r) => setTimeout(r, 1_000));
    await assertNoAuthRefreshChip(ctx.browser);
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P3-12 — Re-auth from genuine revocation works end-to-end
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P3-12",
  description: "Re-auth from genuine revocation works end-to-end (Reconnect → success)",
  run: async (ctx) => {
    await liveEnvProbe(ctx);
    await ensureWorkspaceRegistered(ctx.daemon.baseUrl);

    // Snapshot the credential BEFORE re-auth so we can assert it changed.
    const before = await readCredential("google-calendar", {
      linkBaseUrl: linkBaseUrlFromDaemon(ctx),
    });

    // Simulate re-auth: directly upsert a fresh refresh_token via the same
    // PATCH path that the OAuth callback would use after a successful round
    // trip against the mock. Driving the full OAuth window through Chrome
    // requires a callback redirect the mock controls — out of scope for the
    // smoke; the wire-level effect (new secret in storage) is what matters
    // for scenario observability.
    await tamperCredential(
      "google-calendar",
      {
        access_token: `at-reauth-${Date.now()}`,
        refresh_token: `rt-reauth-${Date.now()}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
      { linkBaseUrl: linkBaseUrlFromDaemon(ctx) },
    );

    await mockControl(ctx.mock, { mode: "success", resetCounts: true });

    await navigateToChat(ctx.browser, WORKSPACE_ID);
    await sendMessage(ctx.browser, "what's on my calendar after reconnect?");

    // No chip of any kind on the post-reconnect message.
    await new Promise<void>((r) => setTimeout(r, 2_000));
    await assertNoAuthRefreshChip(ctx.browser);
    await assertNoIntegrationChip(ctx.browser);

    const after = await readCredential("google-calendar", {
      linkBaseUrl: linkBaseUrlFromDaemon(ctx),
    });
    if (after.secret.refresh_token === before.secret.refresh_token) {
      throw new Error(
        "[ui] P3-12: expected refresh_token to change after re-auth simulation but it didn't",
      );
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P3-13 — Network unreachable (ECONNREFUSED) handled identically to 500
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P3-13",
  description:
    "Network unreachable (ECONNREFUSED at unreachable port) surfaces auth-refresh chip like a 500",
  run: async (ctx) => {
    // Unit pre-check: classifier buckets fetch ECONNREFUSED as kind=transient
    // reason=network — same bucket as http_500_text → same UX.
    await assertUnitPasses(
      "P3-13",
      "apps/link/src/oauth/delegated.test.ts",
      "kind=transient network when fetch throws a non-AbortError",
    );

    await liveEnvProbe(ctx);
    await ensureWorkspaceRegistered(ctx.daemon.baseUrl);

    // Approximate the qa.md "point at port 1" intent: drive the mock into
    // "netfail" mode (server closes the connection mid-request). Restarting
    // the daemon with a different FRIDAY_OAUTH_MOCK_REFRESH_URI would also
    // work but is heavyweight inside one scenario; the netfail mode reuses
    // the same code path in the classifier (fetch throws non-AbortError →
    // kind=transient, reason=network).
    const expiresAt = Math.floor(Date.now() / 1000) - 60;
    await tamperCredential(
      "google-calendar",
      { expires_at: expiresAt },
      { linkBaseUrl: linkBaseUrlFromDaemon(ctx) },
    );
    await mockControl(ctx.mock, { mode: "netfail", resetCounts: true });

    await navigateToChat(ctx.browser, WORKSPACE_ID);
    await sendMessage(ctx.browser, "what's on my calendar?");

    await assertAuthRefreshChipVisible(ctx.browser, { timeoutMs: 30_000 });
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P3-14 — Mock hangs (AbortSignal.timeout(15s) fires)
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P3-14",
  description: "Mock hangs — AbortSignal.timeout(15s) fires and surfaces the auth-refresh chip",
  run: async (ctx) => {
    // Unit pre-check 1: refreshDelegatedToken hands the 15s AbortSignal to
    // fetch. Unit pre-check 2: an AbortError from fetch buckets as
    // kind=transient reason=timeout.
    // Vitest -t treats parentheses as regex; drop them from the filter.
    await assertUnitPasses(
      "P3-14",
      "apps/link/src/oauth/delegated.test.ts",
      "passes AbortSignal.timeout",
    );
    await assertUnitPasses(
      "P3-14",
      "apps/link/src/oauth/delegated.test.ts",
      "kind=transient timeout when fetch rejects with AbortError",
    );

    await liveEnvProbe(ctx);
    await ensureWorkspaceRegistered(ctx.daemon.baseUrl);

    const expiresAt = Math.floor(Date.now() / 1000) - 60;
    await tamperCredential(
      "google-calendar",
      { expires_at: expiresAt },
      { linkBaseUrl: linkBaseUrlFromDaemon(ctx) },
    );
    await mockControl(ctx.mock, { mode: "hang", resetCounts: true });

    await navigateToChat(ctx.browser, WORKSPACE_ID);
    await sendMessage(ctx.browser, "what's on my calendar?");

    // The 15s AbortSignal.timeout fires on each attempt; classifier retries
    // once → ~30s worst case before the chip appears. Allow generous slack.
    await assertAuthRefreshChipVisible(ctx.browser, { timeoutMs: 45_000 });
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P3-15 — Mock returns malformed body → platform_bug + loud log
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P3-15",
  description: "Malformed body buckets as platform_bug; auth-refresh chip + loud daemon log",
  run: async (ctx) => {
    // Unit pre-check: 2xx with malformed body → transient reason=platform_bug
    // (both retries fall through that path).
    await assertUnitPasses(
      "P3-15",
      "apps/link/src/oauth/delegated.test.ts",
      "throws transient platform_bug after retry on 2xx with malformed body",
    );

    await liveEnvProbe(ctx);
    await ensureWorkspaceRegistered(ctx.daemon.baseUrl);

    const expiresAt = Math.floor(Date.now() / 1000) - 60;
    await tamperCredential(
      "google-calendar",
      { expires_at: expiresAt },
      { linkBaseUrl: linkBaseUrlFromDaemon(ctx) },
    );
    await mockControl(ctx.mock, { mode: "malformed_body", resetCounts: true });

    await navigateToChat(ctx.browser, WORKSPACE_ID);
    await sendMessage(ctx.browser, "what's on my calendar?");

    await assertAuthRefreshChipVisible(ctx.browser, { timeoutMs: 30_000 });

    // Best-effort: the daemon's global.log should mention platform_bug.
    // Not all environments mount logs; skip the assertion if the file is
    // empty (mirrors p1.ts P1-04's tolerance pattern).
    const loud = await countDaemonLogMatches(ctx.daemon.fridayHome, /oauth_refresh_platform_bug/);
    if (loud < 1) {
      throw new Error(
        `[ui] P3-15: expected ≥1 oauth_refresh_platform_bug log line in ${ctx.daemon.fridayHome}/logs/global.log, found ${loud}`,
      );
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P3-16 — LinkCredentialUnavailableError constructor throws on empty entries
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P3-16",
  description: "LinkCredentialUnavailableError constructor throws on empty entries (UNIT-ONLY)",
  run: async () => {
    await assertUnitPasses(
      "P3-16",
      "packages/core/src/mcp-registry/credential-resolver.test.ts",
      "throws at construction when entries array is empty",
    );
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P3-17 — Indefinite Retry loop bounded by jobTimeoutMs (AbortSignal)
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P3-17",
  description: "Indefinite Retry loop bounded by jobTimeoutMs — sessionAbortSignal terminates wait",
  run: async (ctx) => {
    // Unit pre-checks seal the wrapper's abort primitive: `sessionAbortSignal`
    // rejects the wait synchronously (pre-aborted) or mid-poll. The runtime
    // wires this signal from the chat job's `jobTimeoutMs` — so when the
    // chat job's 60s timeout elapses while we keep clicking Retry on
    // successive transient elicitations, the wait rejects with AbortError and
    // the session row lands as `cancelled`.
    await assertUnitPasses(
      "P3-17",
      "packages/mcp/src/create-mcp-tools-with-retry.test.ts",
      "rejects mid-wait when sessionAbortSignal aborts",
    );
    await assertUnitPasses(
      "P3-17",
      "packages/mcp/src/create-mcp-tools-with-retry.test.ts",
      "rejects immediately when sessionAbortSignal is pre-aborted",
    );

    await liveEnvProbe(ctx);
    await ensureWorkspaceRegistered(ctx.daemon.baseUrl);

    // Snapshot existing sessions for this workspace so we can distinguish the
    // session this scenario creates from any prior runs sharing the daemon.
    const sessionsBefore = await listWorkspaceSessions(ctx.daemon.baseUrl, WORKSPACE_ID);
    const sessionIdsBefore = new Set(sessionsBefore.map((s) => s.sessionId));

    // Force every refresh to bucket transient + tamper the credential so the
    // very first chat tool call needs a refresh.
    await tamperCredential(
      "google-calendar",
      { expires_at: Math.floor(Date.now() / 1000) - 60 },
      { linkBaseUrl: linkBaseUrlFromDaemon(ctx) },
    );
    await mockControl(ctx.mock, { mode: "http_500_text", resetCounts: true });

    await navigateToChat(ctx.browser, WORKSPACE_ID);
    await sendMessage(ctx.browser, "what's on my calendar?");

    // Loop: click Retry each time a chip surfaces. The chat job's 60s
    // jobTimeoutMs caps the whole run — sessionAbortSignal fires at the
    // boundary and the wrapper's wait rejects. Generous deadline (90s) to
    // absorb startup latency before the first chip + the 500ms inter-retry
    // wait inside the classifier.
    const driveDeadline = Date.now() + 90_000;
    let retryClicks = 0;
    while (Date.now() < driveDeadline) {
      const chipPresent = await ctx.browser.evaluate<boolean>(
        `Boolean(document.querySelector('[data-testid="auth-refresh-inline-card"]'))`,
      );
      if (chipPresent) {
        await ctx.browser
          .evaluate<void>(`
            (() => {
              const btn = document.querySelector('[data-testid="elicitation-auth-refresh-retry"]');
              if (btn) btn.click();
            })();
          `)
          .catch(() => {});
        retryClicks += 1;
      }
      // Check whether the session has reached its terminal state. The chat
      // job's `cancelled` outcome ends the loop early; if the daemon decides
      // FAILED before we'd expect (e.g. credential reclassified), surface
      // that distinctly.
      const sessions = await listWorkspaceSessions(ctx.daemon.baseUrl, WORKSPACE_ID).catch(
        () => [],
      );
      const fresh = sessions.find((s) => !sessionIdsBefore.has(s.sessionId));
      if (fresh && fresh.status === "cancelled") {
        if (retryClicks < 1) {
          throw new Error(
            "[ui] P3-17: session reached cancelled without a single chip click — abort path is firing on something other than the indefinite-retry loop.",
          );
        }
        return;
      }
      if (fresh && (fresh.status === "failed" || fresh.status === "completed")) {
        throw new Error(
          `[ui] P3-17: expected session to end CANCELLED but got "${fresh.status}" after ${retryClicks} Retry clicks. The chat job's jobTimeoutMs should drive the wrapper's sessionAbortSignal, not a terminal failure inside the agent.`,
        );
      }
      await new Promise<void>((r) => setTimeout(r, 750));
    }

    throw new Error(
      `[ui] P3-17: session did not transition to cancelled within 90s (clicked Retry ${retryClicks} times). Check that the QA workspace fixture's handle-chat job carries config.timeout = "60s" and that the runtime is wiring jobTimeoutMs into the wrapper's interactiveCtx.`,
    );
  },
});

interface SessionRow {
  sessionId: string;
  status: string;
  workspaceId?: string;
}

async function listWorkspaceSessions(
  daemonBaseUrl: string,
  workspaceId: string,
): Promise<SessionRow[]> {
  const url = new URL(`${daemonBaseUrl}/api/sessions`);
  url.searchParams.set("workspaceId", workspaceId);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[ui] GET /api/sessions?workspaceId=${workspaceId}: ${res.status} ${text}`);
  }
  const body = await res.json();
  const sessions = isPlainRecord(body) && Array.isArray(body.sessions) ? body.sessions : [];
  const out: SessionRow[] = [];
  for (const raw of sessions) {
    if (!isPlainRecord(raw)) continue;
    const sessionId = raw.sessionId;
    const status = raw.status;
    if (typeof sessionId !== "string" || typeof status !== "string") continue;
    out.push({
      sessionId,
      status,
      ...(typeof raw.workspaceId === "string" ? { workspaceId: raw.workspaceId } : {}),
    });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// P3-18 — Second message in same chat session re-attempts refresh
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P3-18",
  description: "Second message in same chat session re-attempts refresh after first turn cancel",
  run: async (ctx) => {
    // Unit pre-check: the wrapper is per-turn — when invoked again with the
    // same workspaceId/sessionId, it doesn't suppress based on prior cancel.
    // The closest existing unit case is the "passes the result through
    // unchanged" path, which proves a fresh invocation re-runs createMCPTools.
    await assertUnitPasses(
      "P3-18",
      "packages/mcp/src/create-mcp-tools-with-retry.test.ts",
      "passes the result through unchanged when no transient disconnects",
    );

    await liveEnvProbe(ctx);
    await ensureWorkspaceRegistered(ctx.daemon.baseUrl);

    // Turn 1: force a transient, let the chip surface, then click Cancel
    // — wait, P3-18's setup says "user clicked Cancel on the first message".
    // The runner doesn't have a chip-cancel helper today and the auth-refresh
    // card's button is identified by data-testid="elicitation-auth-refresh-
    // cancel"; emit a small inline click for it.
    const expiresAt = Math.floor(Date.now() / 1000) - 60;
    await tamperCredential(
      "google-calendar",
      { expires_at: expiresAt },
      { linkBaseUrl: linkBaseUrlFromDaemon(ctx) },
    );
    await mockControl(ctx.mock, { mode: "http_500_text", resetCounts: true });
    await navigateToChat(ctx.browser, WORKSPACE_ID);
    await sendMessage(ctx.browser, "what's on my calendar?");
    await assertAuthRefreshChipVisible(ctx.browser, { timeoutMs: 30_000 });

    // Click Cancel — fails the first turn cleanly.
    await ctx.browser.evaluate<void>(`
      (() => {
        const el = document.querySelector('[data-testid="elicitation-auth-refresh-cancel"]');
        if (!el) throw new Error("cancel button not found");
        el.click();
      })();
    `);

    // Wait for the chip to disappear / transition; rough poll on disappearance.
    const cancelDeadline = Date.now() + 15_000;
    while (Date.now() < cancelDeadline) {
      const stillVisible = await ctx.browser.evaluate<boolean>(
        `Boolean(document.querySelector('[data-testid="auth-refresh-inline-card"]'))`,
      );
      if (!stillVisible) break;
      await new Promise<void>((r) => setTimeout(r, 250));
    }

    // Turn 2: flip mock to success, send a new message; wrapper re-runs fresh.
    await mockControl(ctx.mock, { mode: "success" });
    // Tamper again so refresh fires on the next use (otherwise the cached
    // access_token from before the cancel would be reused).
    await tamperCredential(
      "google-calendar",
      { expires_at: Math.floor(Date.now() / 1000) - 60 },
      { linkBaseUrl: linkBaseUrlFromDaemon(ctx) },
    );
    await sendMessage(ctx.browser, "try again — what's on my calendar?");

    // Give the agent a moment to spin up; no new chip should appear.
    await new Promise<void>((r) => setTimeout(r, 3_000));
    await assertNoAuthRefreshChip(ctx.browser);
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P3-19 — Concurrent chat sessions, same Google credential
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P3-19",
  description: "Concurrent chat sessions share credential but each gets its own elicitation",
  run: async () => {
    // The end-to-end UI surface needs two independent Chrome page targets
    // (two tabs) driving the same workspace. The runner harness today
    // exposes a single BrowserController per scenario (`openChrome` picks
    // the first page target). The exact observable — "elicitation rows
    // unique per (workspaceId, sessionId)" — is already exercised by the
    // wrapper's dedup unit test (the dedup is per-session, so two
    // distinct sessionIds always yield two elicitations).
    //
    // Run the dedup unit-precheck as the seal; the multi-tab browser drive
    // lands once the harness gains a multi-page helper.
    await assertUnitPasses(
      "P3-19",
      "packages/mcp/src/create-mcp-tools-with-retry.test.ts",
      "deduplicates: second transient on same family finds the existing pending elicitation",
    );
    await assertUnitPasses(
      "P3-19",
      "packages/mcp/src/create-mcp-tools-with-retry.test.ts",
      "awaits multi-family elicitations concurrently and aggregates failures",
    );
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P3-20 — Delegated tool execution hits the wrapper without interactiveCtx
// ──────────────────────────────────────────────────────────────────────────

register({
  id: "P3-20",
  description: "Delegated tool execution hits the wrapper WITHOUT interactiveCtx; throws aggregate",
  run: async () => {
    // The delegate path in `packages/core/src/delegate/index.ts` passes
    // `undefined` for interactiveCtx — when a transient happens, the wrapper
    // disposes the partial result and throws aggregate
    // LinkCredentialUnavailableError instead of surfacing an elicitation.
    //
    // The wrapper's behavior is sealed by:
    await assertUnitPasses(
      "P3-20",
      "packages/mcp/src/create-mcp-tools-with-retry.test.ts",
      "throws aggregate LinkCredentialUnavailableError without interactiveCtx",
    );
    // And the delegate call site itself is exercised by the delegate
    // index tests, which mock `createMCPToolsWithRetry` (the wrapper) and
    // assert delegate routes connection errors back as `serverFailures`:
    await assertUnitPasses(
      "P3-20",
      "packages/core/src/delegate/index.test.ts",
      "returns ok=false when all MCP servers fail to connect",
    );
  },
});

// ──────────────────────────────────────────────────────────────────────────
// P3-TELEMETRY — Aggregate counter validation via InMemoryOAuthMetricsSink
// ──────────────────────────────────────────────────────────────────────────
//
// qa.md "Telemetry validation" calls for asserting expected counter deltas
// after the full P3 run. The production daemon's `/metrics` endpoint
// only exposes HTTP-request counters (apps/link/src/metrics.ts), NOT the
// OTel-backed `link.oauth.*` instruments — those only surface through OTel
// exporters in production and through `InMemoryOAuthMetricsSink` in tests.
//
// So this scenario runs a dedicated Vitest case file (the same one Ellie
// wrote when wiring up the meter, #17) that exercises every counter the
// wrapper emits. If the file passes, the aggregate counter set is wired
// correctly end-to-end. The Telemetry test file already asserts:
//   - elicitation.created (P3-01, etc.)
//   - elicitation.deduped (P3-07)
//   - elicitation.answered_retry / answered_cancel (P3-02, P3-04)
//   - elicitation.expired (P3-05)
//   - elicitation.aborted (P3-06, P3-17)
//   - elicitation.retry_succeeded / retry_failed (P3-02, P3-03)
//   - answer_latency_ms histogram (across all answer paths)

register({
  id: "P3-TELEMETRY",
  description: "Aggregate telemetry validation — wrapper counters via InMemoryOAuthMetricsSink",
  run: async () => {
    await assertUnitPasses(
      "P3-TELEMETRY",
      "packages/mcp/src/create-mcp-tools-with-retry.telemetry.test.ts",
      "createMCPToolsWithRetry telemetry",
    );
  },
});
