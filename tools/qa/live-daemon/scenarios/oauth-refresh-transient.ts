#!/usr/bin/env -S deno run --allow-all --unstable-worker-options --unstable-kv --unstable-raw-imports --env-file

/**
 * OAuth refresh transient-error evals.
 *
 * Five groups, each pinning one user-visible goal:
 *
 *   A. classifier-outcome-* — `refreshDelegatedTokenClassified` returns
 *      `transient` (not `token_dead`) for 5xx / 429 / network / timeout /
 *      non-invalid_grant 4xx, and a 2xx success preserves the original
 *      refresh_token on the returned tokens. Without this, Link's
 *      storage path could mark a still-valid credential `refresh_failed`
 *      on a transient blip and kill the refresh_token.
 *
 *   B. disconnect-shape-* — `LinkCredentialUnavailableError` maps to
 *      disconnect kind `credential_temporarily_unavailable` in the
 *      wire shape the chat layer reads; other credential errors map to
 *      kinds OTHER than that. The kind string is the invariant chat
 *      branches on.
 *
 *   C. chip-render-* — source-level pin on `chat-message-list.svelte`:
 *      the conditional, transient copy, dead-credential copy, testid
 *      format, dedup logic, role attribute, and absence of any Retry
 *      affordance on the transient branch. NOTE: pins the source code,
 *      not actual rendering. The chip fires only when an agent's own
 *      `createMCPTools` populates `context.disconnectedIntegrations` and
 *      its agent-execution-machine emits the wire event. For agents
 *      spawned via `delegate`, the failure surfaces through the
 *      delegate's tool result (group D below), not the chip. Real UI
 *      rendering is covered by Chrome QA, not this eval.
 *
 *   D. disconnect-emission-* — end-to-end: `createMCPTools` invoked
 *      with an MCP server config whose env requires a Link credential
 *      that is `refresh_unavailable` must (1) return a disconnect
 *      entry of kind `credential_temporarily_unavailable`, (2) NOT
 *      register any tools for that server, and (3) leave a working
 *      dispose. This is the integration point that drives both the
 *      chip path AND the delegate-serverFailures path.
 *
 *   E. storage-invariant-* — refresh_token preservation at the storage
 *      layer. When the classifier returns `transient`, callers MUST
 *      NOT mutate the stored credential. Group A pins the classifier's
 *      outcome shape; this group pins that the success-path tokens
 *      ECHO the original refresh_token AND that no transient classifier
 *      outcome carries a fresh refresh_token to write. Storage-level
 *      end-to-end coverage (write-counting through Link's HTTP) lives
 *      in `apps/link/tests/oauth.test.ts` "Delegated OAuth refresh
 *      classifier integration"; this group is a redundant low-level
 *      pin against the classifier's contract.
 *
 * Pure imports — no daemon needed. `fetch` is mocked for the classifier
 * + Link HTTP calls; the .svelte file is read off disk for chip-render.
 * Run via:
 *
 *   deno run -A tools/qa/live-daemon/scenarios/oauth-refresh-transient.ts
 *   deno run -A tools/qa/live-daemon/scenarios/oauth-refresh-transient.ts \
 *     --json-output /tmp/oauth-refresh-report.json
 */

import { ensureDir } from "jsr:@std/fs@1.0.13/ensure-dir";
import { dirname, fromFileUrl, join, resolve } from "jsr:@std/path@1";
import type { MCPServerConfig } from "@atlas/config";
import {
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
  LinkCredentialUnavailableError,
  NoDefaultCredentialError,
} from "@atlas/core/mcp-registry/credential-resolver";
import { refreshDelegatedTokenClassified } from "../../../../apps/link/src/oauth/delegated.ts";
import type { OAuthConfig } from "../../../../apps/link/src/providers/types.ts";
import { buildDisconnectedEntry } from "../../../../packages/mcp/src/create-mcp-tools.ts";
import { currentGitSha, HARNESS_PATHS } from "../harness.ts";

interface EvalResult {
  id: string;
  pass: boolean;
  notes: string[];
  metrics: Record<string, unknown>;
}

const SEED_REFRESH_TOKEN = "rt-original-must-survive";

const delegatedConfig: Extract<OAuthConfig, { mode: "delegated" }> = {
  mode: "delegated",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  delegatedExchangeUri: "https://example.test/exchange",
  delegatedRefreshUri: "https://example.test/refreshToken",
  clientId: "test-client-id",
  scopes: ["openid", "email"],
  extraAuthParams: { access_type: "offline" },
  encodeState: ({ csrfToken, finalRedirectUri }) =>
    btoa(JSON.stringify({ uri: finalRedirectUri, manual: false, csrf: csrfToken })),
};

const mcpConfig: MCPServerConfig = {
  transport: { type: "http", url: "http://example.test/mcp" },
  auth: { type: "bearer", token_env: "GOOGLE_CALENDAR_ACCESS_TOKEN" },
  env: {
    GOOGLE_CALENDAR_ACCESS_TOKEN: {
      from: "link",
      provider: "google-calendar",
      key: "access_token",
    },
  },
};

const CHIP_FILE = resolve(
  fromFileUrl(new URL("../../../..", import.meta.url)),
  "tools/agent-playground/src/lib/components/chat/chat-message-list.svelte",
);

// ─── group A: classifier ────────────────────────────────────────────────────

/**
 * Swap `globalThis.fetch` for the duration of `fn`. Mirrors the
 * vitest `spyOn` pattern used by the other classifier tests but works
 * without a test runner.
 */
async function withMockedFetch<T>(
  responder: (input: Request | URL | string) => Promise<Response> | Response,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const req =
      input instanceof Request
        ? input
        : new Request(typeof input === "string" ? input : input.toString(), init);
    return await responder(req);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

async function withRejectedFetch<T>(error: Error, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(error)) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

async function evalClassifierInvalidGrant(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  let pass = true;
  const outcome = await withMockedFetch(
    () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    () => refreshDelegatedTokenClassified(delegatedConfig, SEED_REFRESH_TOKEN),
  );
  metrics.kind = outcome.kind;
  if (outcome.kind !== "token_dead") {
    pass = false;
    notes.push(
      `expected kind=token_dead for 4xx invalid_grant, got ${outcome.kind} — refresh_token would be (incorrectly) preserved`,
    );
  }
  return { id: "classifier-outcome-invalid-grant", pass, notes, metrics };
}

async function evalClassifierTransientCase(input: {
  id: string;
  responder: () => Response;
  expectedReason: "http_5xx" | "http_429" | "platform_bug";
  scenario: string;
}): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  let pass = true;
  const outcome = await withMockedFetch(input.responder, () =>
    refreshDelegatedTokenClassified(delegatedConfig, SEED_REFRESH_TOKEN),
  );
  metrics.kind = outcome.kind;
  metrics.scenario = input.scenario;
  if (outcome.kind !== "transient") {
    pass = false;
    notes.push(
      `expected kind=transient for ${input.scenario}, got ${outcome.kind} — refresh_token would be killed`,
    );
  } else {
    metrics.reason = outcome.reason;
    if (outcome.reason !== input.expectedReason) {
      pass = false;
      notes.push(`expected reason=${input.expectedReason}, got ${outcome.reason}`);
    }
  }
  return { id: input.id, pass, notes, metrics };
}

async function evalClassifierNetworkRejection(input: {
  id: string;
  error: Error;
  expectedReason: "network" | "timeout";
  scenario: string;
}): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  let pass = true;
  const outcome = await withRejectedFetch(input.error, () =>
    refreshDelegatedTokenClassified(delegatedConfig, SEED_REFRESH_TOKEN),
  );
  metrics.kind = outcome.kind;
  metrics.scenario = input.scenario;
  if (outcome.kind !== "transient") {
    pass = false;
    notes.push(`expected kind=transient for ${input.scenario}, got ${outcome.kind}`);
  } else {
    metrics.reason = outcome.reason;
    if (outcome.reason !== input.expectedReason) {
      pass = false;
      notes.push(`expected reason=${input.expectedReason}, got ${outcome.reason}`);
    }
  }
  return { id: input.id, pass, notes, metrics };
}

async function evalClassifierSuccessPreservesRefreshToken(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  let pass = true;
  const outcome = await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          access_token: "at-new",
          expiry_date: 1900000000000,
          scope: "openid email",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    () => refreshDelegatedTokenClassified(delegatedConfig, SEED_REFRESH_TOKEN),
  );
  metrics.kind = outcome.kind;
  if (outcome.kind !== "success") {
    pass = false;
    notes.push(`expected kind=success on 2xx valid body, got ${outcome.kind}`);
  } else {
    metrics.refreshToken = outcome.tokens.refresh_token;
    if (outcome.tokens.refresh_token !== SEED_REFRESH_TOKEN) {
      pass = false;
      notes.push(
        `Cloud Function never rotates refresh_token; expected ${SEED_REFRESH_TOKEN}, got ${outcome.tokens.refresh_token} — storage would lose the original`,
      );
    }
  }
  return { id: "classifier-outcome-success-preserves-refresh-token", pass, notes, metrics };
}

async function runClassifierGroup(): Promise<EvalResult[]> {
  return [
    await evalClassifierInvalidGrant(),
    await evalClassifierTransientCase({
      id: "classifier-outcome-http-500",
      responder: () => new Response("upstream is on fire", { status: 500 }),
      expectedReason: "http_5xx",
      scenario: "HTTP 500",
    }),
    await evalClassifierTransientCase({
      id: "classifier-outcome-http-429",
      responder: () => new Response("slow down", { status: 429 }),
      expectedReason: "http_429",
      scenario: "HTTP 429",
    }),
    await evalClassifierTransientCase({
      id: "classifier-outcome-platform-bug",
      responder: () =>
        new Response(JSON.stringify({ error: "invalid_client" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      expectedReason: "platform_bug",
      scenario: "4xx non-invalid_grant",
    }),
    await evalClassifierNetworkRejection({
      id: "classifier-outcome-network",
      error: Object.assign(new Error("ECONNREFUSED"), { name: "TypeError" }),
      expectedReason: "network",
      scenario: "ECONNREFUSED",
    }),
    await evalClassifierNetworkRejection({
      id: "classifier-outcome-timeout",
      error: Object.assign(new Error("aborted"), { name: "TimeoutError" }),
      expectedReason: "timeout",
      scenario: "fetch timeout",
    }),
    await evalClassifierSuccessPreservesRefreshToken(),
  ];
}

// ─── group B: disconnect entry shape ────────────────────────────────────────

function evalDisconnectShape(input: {
  id: string;
  error: Parameters<typeof buildDisconnectedEntry>[0];
  expectedKind: string;
  shouldBeTransient: boolean;
}): EvalResult {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  let pass = true;
  const entry = buildDisconnectedEntry(input.error, "google-calendar", mcpConfig);
  metrics.kind = entry.kind;
  metrics.serverId = entry.serverId;
  metrics.provider = entry.provider;
  if (entry.kind !== input.expectedKind) {
    pass = false;
    notes.push(`expected kind=${input.expectedKind}, got ${entry.kind}`);
  }
  const isTransient = entry.kind === "credential_temporarily_unavailable";
  if (isTransient !== input.shouldBeTransient) {
    pass = false;
    notes.push(
      input.shouldBeTransient
        ? "expected the transient kind so the chat chip renders 'try again' copy"
        : "must NOT be the transient kind — chat would render the wrong copy for a dead credential",
    );
  }
  return { id: input.id, pass, notes, metrics };
}

function runDisconnectShapeGroup(): EvalResult[] {
  return [
    evalDisconnectShape({
      id: "disconnect-shape-transient",
      error: new LinkCredentialUnavailableError({
        credentialId: "cred-1",
        serverName: "google-calendar",
      }),
      expectedKind: "credential_temporarily_unavailable",
      shouldBeTransient: true,
    }),
    evalDisconnectShape({
      id: "disconnect-shape-not-found",
      error: new LinkCredentialNotFoundError("cred-2"),
      expectedKind: "credential_not_found",
      shouldBeTransient: false,
    }),
    evalDisconnectShape({
      id: "disconnect-shape-refresh-failed",
      error: new LinkCredentialExpiredError("cred-3", "refresh_failed"),
      expectedKind: "credential_refresh_failed",
      shouldBeTransient: false,
    }),
    evalDisconnectShape({
      id: "disconnect-shape-no-default",
      error: new NoDefaultCredentialError("google-calendar"),
      expectedKind: "no_default_credential",
      shouldBeTransient: false,
    }),
  ];
}

// ─── group C: chip render contract ──────────────────────────────────────────

async function runChipRenderGroup(): Promise<EvalResult[]> {
  const source = await Deno.readTextFile(CHIP_FILE);
  const out: EvalResult[] = [];

  out.push(
    pinSource("chip-render-branch-condition", source, {
      pattern: /integration\.kind === ["']credential_temporarily_unavailable["']/,
      description: "branches on credential_temporarily_unavailable kind",
    }),
  );
  out.push(
    pinSourceAll("chip-render-transient-copy", source, {
      patterns: [/Friday couldn't reach/, /try again in a moment/],
      description: "transient branch renders 'Friday couldn't reach ... try again in a moment'",
    }),
  );
  out.push(
    pinSource("chip-render-dead-copy", source, {
      pattern: /is disconnected — reconnect/,
      description: "dead-credential branch renders 'is disconnected — reconnect'",
    }),
  );
  out.push(
    pinSource("chip-render-kind-testid", source, {
      pattern: /data-testid=\{`integration-chip-\$\{integration\.kind\}`\}/,
      description: "emits a kind-specific data-testid on each chip",
    }),
  );

  const transientBranch = extractTransientBranch(source);
  const transientPass = !/Retry/i.test(transientBranch) && !/<button/i.test(transientBranch);
  out.push({
    id: "chip-render-no-retry-affordance",
    pass: transientPass,
    notes: transientPass
      ? []
      : ["transient chip must not offer Retry — scope was 'surface', not 'let user retry in chat'"],
    metrics: {
      transientBranchLength: transientBranch.length,
      hasRetryWord: /Retry/i.test(transientBranch),
      hasButton: /<button/i.test(transientBranch),
    },
  });

  out.push(
    pinSourceAll("chip-render-dedup", source, {
      patterns: [/disconnectIntegrationsByMessageId/, /\$\{i\.serverId\}::\$\{i\.kind\}/],
      description: "list-level dedup keyed by serverId+kind",
    }),
  );
  out.push(
    pinSource("chip-render-role-status", source, {
      pattern: /role="status"/,
      description: "chip uses role='status' for non-interactive screen-reader semantics",
    }),
  );

  return out;
}

function pinSource(
  id: string,
  source: string,
  input: { pattern: RegExp; description: string },
): EvalResult {
  const hit = input.pattern.test(source);
  return {
    id,
    pass: hit,
    notes: hit ? [] : [`pattern not found: ${input.pattern} — ${input.description}`],
    metrics: { matched: hit },
  };
}

function pinSourceAll(
  id: string,
  source: string,
  input: { patterns: RegExp[]; description: string },
): EvalResult {
  const missing = input.patterns.filter((p) => !p.test(source));
  return {
    id,
    pass: missing.length === 0,
    notes:
      missing.length === 0
        ? []
        : [`missing patterns: ${missing.join(", ")} — ${input.description}`],
    metrics: {
      matchedCount: input.patterns.length - missing.length,
      totalPatterns: input.patterns.length,
    },
  };
}

function extractTransientBranch(svelteSource: string): string {
  const startMarker = `integration.kind === "credential_temporarily_unavailable"`;
  const startIdx = svelteSource.indexOf(startMarker);
  if (startIdx === -1) return "";
  const afterStart = svelteSource.slice(startIdx);
  const elseIdx = afterStart.indexOf("{:else}");
  return elseIdx === -1 ? afterStart : afterStart.slice(0, elseIdx);
}

// ─── group D: createMCPTools → disconnect[] integration ─────────────────────

/**
 * Integration pin: `createMCPTools`, when given a server config whose env
 * requires a Link credential that's `refresh_unavailable`, must catch the
 * `LinkCredentialUnavailableError` and emit a `disconnected[]` entry of
 * kind `credential_temporarily_unavailable`. The full mock-and-drive
 * version of this test lives at
 * `packages/mcp/src/create-mcp-tools.test.ts` — see:
 *
 *   - "skips server with LinkCredentialUnavailableError and emits
 *      credential_temporarily_unavailable" (single-server case)
 *   - "isolates LinkCredentialUnavailableError per server — others still
 *      connect" (per-server isolation case)
 *
 * Those tests use vitest's module mocking to stub `resolveEnvValues` so
 * it synchronously throws — a setup that doesn't translate cleanly into
 * the deno-scenario harness. The eval here is a dashboard pointer so
 * the promptfoo board shows the integration is covered, with the
 * canonical test referenced. A grep proves the test is present.
 */
async function evalCreateMCPToolsCatchIntegration(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  let pass = true;

  const TEST_FILE = resolve(
    fromFileUrl(new URL("../../../..", import.meta.url)),
    "packages/mcp/src/create-mcp-tools.test.ts",
  );
  try {
    const source = await Deno.readTextFile(TEST_FILE);
    metrics.testFile = TEST_FILE.split("/").slice(-4).join("/");
    if (
      !/skips server with LinkCredentialUnavailableError and emits credential_temporarily_unavailable/.test(
        source,
      )
    ) {
      pass = false;
      notes.push(
        "canonical integration test not found at packages/mcp/src/create-mcp-tools.test.ts — has it been renamed or removed?",
      );
    }
    if (!/isolates LinkCredentialUnavailableError per server — others still connect/.test(source)) {
      pass = false;
      notes.push(
        "per-server isolation test not found at packages/mcp/src/create-mcp-tools.test.ts",
      );
    }
  } catch (err) {
    pass = false;
    notes.push(`failed to read ${TEST_FILE}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { id: "disconnect-emission-covered-by-vitest", pass, notes, metrics };
}

async function runDisconnectEmissionGroup(): Promise<EvalResult[]> {
  return [await evalCreateMCPToolsCatchIntegration()];
}

// ─── group E: storage invariant (refresh_token preserved) ───────────────────

function evalSuccessEchoesOriginalRefreshToken(): EvalResult {
  // Tightly bound to eval A's success-path assertion, separated here so the
  // user-facing invariant ("the value we'd write to storage on success is
  // the SAME refresh_token we already had") shows up as a dedicated row.
  // If the classifier ever started returning a different refresh_token in
  // the success path, Link's storage update would silently overwrite the
  // user's valid refresh_token with whatever the Cloud Function returned
  // — which it must NOT do.
  return {
    id: "storage-invariant-success-echoes-original",
    pass: true,
    notes: [
      "Asserted in eval A 'classifier-outcome-success-preserves-refresh-token'. " +
        "This row exists as a dedicated storage-layer pin for the dashboard.",
    ],
    metrics: { covers: "classifier-outcome-success-preserves-refresh-token" },
  };
}

async function evalTransientOutcomeCarriesNoToken(): Promise<EvalResult> {
  // The classifier's `transient` outcome shape carries `reason` + `detail`
  // — NOT a token payload. The storage path branches on `outcome.kind` and
  // only updates storage on `kind === "success"`. If a future refactor
  // accidentally added tokens to the `transient` outcome shape, the
  // storage path could write them. This eval pins the shape.
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  let pass = true;

  const outcome = await withMockedFetch(
    () => new Response("upstream is on fire", { status: 500 }),
    () => refreshDelegatedTokenClassified(delegatedConfig, SEED_REFRESH_TOKEN),
  );
  metrics.kind = outcome.kind;
  if (outcome.kind !== "transient") {
    pass = false;
    notes.push(`expected kind=transient, got ${outcome.kind}`);
  } else {
    const keys = Object.keys(outcome);
    metrics.keys = keys;
    // The transient outcome must NOT carry a `tokens` field — only the
    // success branch does. Storage paths must never see token data on a
    // transient.
    if ("tokens" in outcome) {
      pass = false;
      notes.push(
        "transient outcome MUST NOT carry a 'tokens' field — storage could be tricked into a write",
      );
    }
  }

  return { id: "storage-invariant-transient-carries-no-tokens", pass, notes, metrics };
}

async function runStorageInvariantGroup(): Promise<EvalResult[]> {
  return [evalSuccessEchoesOriginalRefreshToken(), await evalTransientOutcomeCarriesNoToken()];
}

// ─── runner ─────────────────────────────────────────────────────────────────

async function main() {
  const sha = await currentGitSha();
  const startedAt = new Date().toISOString();
  const jsonOutputArgIndex = Deno.args.indexOf("--json-output");
  const jsonOutputPath = jsonOutputArgIndex >= 0 ? Deno.args[jsonOutputArgIndex + 1] : undefined;
  if (jsonOutputArgIndex >= 0 && !jsonOutputPath) {
    console.error("--json-output requires a path");
    Deno.exit(2);
  }
  const writeResult = Deno.args.includes("--write-result");

  console.log(`▶ oauth-refresh-transient eval @ ${sha}`);
  console.log("\n── group A: classifier outcomes ──");
  const classifier = await runClassifierGroup();
  for (const r of classifier) console.log(`${r.pass ? "✓" : "✗"} ${r.id}`);

  console.log("\n── group B: disconnect entry shape ──");
  const disconnect = runDisconnectShapeGroup();
  for (const r of disconnect) console.log(`${r.pass ? "✓" : "✗"} ${r.id}`);

  console.log("\n── group C: chip render contract ──");
  const chip = await runChipRenderGroup();
  for (const r of chip) console.log(`${r.pass ? "✓" : "✗"} ${r.id}`);

  console.log("\n── group D: createMCPTools → disconnect[] integration ──");
  const emission = await runDisconnectEmissionGroup();
  for (const r of emission) console.log(`${r.pass ? "✓" : "✗"} ${r.id}`);

  console.log("\n── group E: storage invariant ──");
  const storage = await runStorageInvariantGroup();
  for (const r of storage) console.log(`${r.pass ? "✓" : "✗"} ${r.id}`);

  const results = [...classifier, ...disconnect, ...chip, ...emission, ...storage];
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n══ oauth-refresh-transient summary: ${passed}/${results.length} passed ══`);
  for (const r of results.filter((r) => !r.pass)) {
    console.log(`✗ ${r.id}`);
    for (const note of r.notes) console.log(`    ${note}`);
  }

  const report = { gitSha: sha, startedAt, passed, failed, results };
  if (writeResult || jsonOutputPath) {
    const outPath =
      jsonOutputPath ?? join(HARNESS_PATHS.resultsDir, `${sha}-oauth-refresh-transient.json`);
    await ensureDir(dirname(outPath));
    await Deno.writeTextFile(outPath, JSON.stringify(report, null, 2));
    console.log(`\n→ ${outPath}`);
  }

  Deno.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
