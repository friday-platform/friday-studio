#!/usr/bin/env -S deno run --allow-all --unstable-worker-options --unstable-kv --unstable-raw-imports --env-file

/**
 * OAuth refresh transient-error evals.
 *
 * Two groups, each pinning one user-visible goal:
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
 * End-to-end coverage (Link HTTP → storage write-count → refreshed
 * recovery) lives in `apps/link/tests/oauth.test.ts` "Delegated OAuth
 * refresh classifier integration". The `createMCPTools` catch path is
 * covered by `packages/mcp/src/create-mcp-tools.test.ts`.
 *
 * Pure imports — no daemon needed; `fetch` is mocked. Run via:
 *
 *   deno run -A tools/qa/live-daemon/scenarios/oauth-refresh-transient.ts
 *   deno run -A tools/qa/live-daemon/scenarios/oauth-refresh-transient.ts \
 *     --json-output /tmp/oauth-refresh-report.json
 */

import { ensureDir } from "jsr:@std/fs@1.0.13/ensure-dir";
import { dirname, join } from "jsr:@std/path@1";
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

  const results = [...classifier, ...disconnect];
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
