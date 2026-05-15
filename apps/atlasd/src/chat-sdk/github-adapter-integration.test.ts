/**
 * Integration tests for the GitHub chat-adapter wiring. Patina (Wave 3) covered
 * the route boundary; these tests close the three gaps the route mock left:
 *
 * 1. `buildChatSdkAdapters` constructs a real `@chat-adapter/github` adapter
 *    when given github credentials.
 * 2. The adapter performs real HMAC-SHA256 verification against
 *    `webhookSecret` — valid signatures pass, tampered ones return 401.
 * 3. `resolveGithubFromLink` (via `resolvePlatformCredentials`) maps Link's
 *    snake_case secret to the camelCase `PlatformCredentials` shape, including
 *    `app_id: number → appId: string` coercion and `installation_id` drop.
 *
 * Mocks only at the network boundary — `vi.stubGlobal('fetch', ...)` intercepts
 * Link calls. Adapter, factory, and resolver are exercised real.
 */

import { createHmac } from "node:crypto";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamRegistry } from "../stream-registry.ts";
import { buildChatSdkAdapters, type PlatformCredentials } from "./adapter-factory.ts";
import { resolvePlatformCredentials } from "./chat-sdk-instance.ts";

/** Synthetic GitHub App credentials. The PEM is never parsed in the inbound
 * webhook path — adapter only uses it for outbound JWT minting (post / edit /
 * react), which these tests don't exercise. `webhook_secret` is the only field
 * HMAC verification touches. */
const githubCreds: PlatformCredentials = {
  kind: "github",
  appId: "12345",
  privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  webhookSecret: "test-webhook-secret",
  botUserSlug: "friday-bot",
  botUserId: 99999,
};

/** Minimal github signal so `findChatProviders` surfaces the kind. */
const githubSignals = { "github-chat": { provider: "github", config: {} } };

/** GitHub's `ping` event is the cheapest payload to round-trip: the adapter
 * verifies the signature, sees `X-GitHub-Event: ping`, returns 200 without
 * touching `installation` / `repository` / chat state. */
const pingPayload = JSON.stringify({ zen: "Practicality beats purity.", hook_id: 123 });

/** Compute the HMAC-SHA256 hex digest GitHub sends in `X-Hub-Signature-256`. */
function signBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("GitHub chat-adapter integration: webhook HMAC verification", () => {
  it("accepts a webhook with a valid HMAC-SHA256 signature", async () => {
    const adapters = buildChatSdkAdapters({
      workspaceId: "ws-1",
      signals: githubSignals,
      credentials: githubCreds,
      streamRegistry: new StreamRegistry(),
    });

    const githubAdapter = adapters.github;
    expect(githubAdapter).toBeDefined();
    if (!githubAdapter) return;

    const request = new Request("http://localhost/signals/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "ping",
        "X-GitHub-Delivery": "delivery-1",
        "X-Hub-Signature-256": signBody(pingPayload, githubCreds.webhookSecret),
      },
      body: pingPayload,
    });

    const response = await githubAdapter.handleWebhook(request);
    expect(response.status).toBe(200);
  });

  it("rejects a webhook with a tampered HMAC signature (401)", async () => {
    const adapters = buildChatSdkAdapters({
      workspaceId: "ws-1",
      signals: githubSignals,
      credentials: githubCreds,
      streamRegistry: new StreamRegistry(),
    });

    const githubAdapter = adapters.github;
    expect(githubAdapter).toBeDefined();
    if (!githubAdapter) return;

    // Sign with the wrong secret — the digest is well-formed but won't match
    // the adapter's `timingSafeEqual` check.
    const tamperedSignature = signBody(pingPayload, "WRONG-SECRET");
    const request = new Request("http://localhost/signals/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "ping",
        "X-GitHub-Delivery": "delivery-2",
        "X-Hub-Signature-256": tamperedSignature,
      },
      body: pingPayload,
    });

    const response = await githubAdapter.handleWebhook(request);
    expect(response.status).toBe(401);
  });

  /**
   * Closes the gap left by the `ping`-only tests: `ping` short-circuits in
   * `handleWebhook` right after `verifySignature` (adapter index.js:391-394),
   * so neither JSON parsing, installation extraction, nor the per-event
   * handler chains (`encodeThreadId` + `parse{Issue,Review}Comment`) are
   * exercised.
   *
   * Each row fires a signed payload through the real adapter; to reach the
   * thread-construction path the adapter needs `chat` wired (line 448
   * early-returns otherwise). We attach a minimal stub via `initialize()`
   * and assert `processMessage` was called with the expected threadId.
   *
   * Regression guard: if the payload Zod schema tightens or a parser
   * starts requiring a new field, the test fails loudly — either the
   * outer 200 flips (JSON/parse error) or `processMessage` won't be invoked.
   *
   * threadId formats (per `@chat-adapter/github` encodeThreadId):
   * - issue: `github:{owner}/{repo}:issue:{issueNumber}`
   * - PR-level: `github:{owner}/{repo}:{prNumber}`
   * - review comment: `github:{owner}/{repo}:{prNumber}:rc:{reviewCommentId}`
   *
   * `issue_comment` and `pull_request_review_comment` go through distinct
   * handlers with distinct threadId shapes — both are workspace routing keys
   * in chat-sdk, so a regression in either silently fans every comment into
   * a fresh thread.
   */
  it.each<{
    name: string;
    event: string;
    payload: Record<string, unknown>;
    expectedThreadId: string;
  }>([
    {
      name: "issue_comment.created → issue threadId",
      event: "issue_comment",
      // No `pull_request` field on `issue` → adapter treats this as an issue
      // thread, producing the "issue:" threadId form.
      payload: {
        action: "created",
        installation: { id: 67890 },
        issue: { number: 42, html_url: "https://github.com/acme/widgets/issues/42" },
        repository: {
          id: 1,
          name: "widgets",
          full_name: "acme/widgets",
          owner: { login: "acme", id: 100, type: "Organization" },
        },
        comment: {
          id: 555,
          body: "hey @friday-bot can you take a look?",
          user: { id: 200, login: "alice", type: "User" },
          created_at: "2026-05-09T12:00:00Z",
          updated_at: "2026-05-09T12:00:00Z",
          html_url: "https://github.com/acme/widgets/issues/42#issuecomment-555",
        },
        sender: { id: 200, login: "alice", type: "User" },
      },
      expectedThreadId: "github:acme/widgets:issue:42",
    },
    {
      name: "pull_request_review_comment.created → review-comment threadId",
      event: "pull_request_review_comment",
      // `handleReviewComment` destructures `comment, pull_request, repository,
      // sender`; threadId encoding uses `comment.in_reply_to_id ?? comment.id`
      // as the reviewCommentId. With no `in_reply_to_id`, `comment.id` (777)
      // becomes the root of the review thread.
      payload: {
        action: "created",
        installation: { id: 67890 },
        pull_request: { number: 42, html_url: "https://github.com/acme/widgets/pull/42" },
        repository: {
          id: 1,
          name: "widgets",
          full_name: "acme/widgets",
          owner: { login: "acme", id: 100, type: "Organization" },
        },
        comment: {
          id: 777,
          body: "nit on this line @friday-bot",
          user: { id: 200, login: "alice", type: "User" },
          created_at: "2026-05-09T12:00:00Z",
          updated_at: "2026-05-09T12:00:00Z",
          html_url: "https://github.com/acme/widgets/pull/42#discussion_r777",
          path: "src/widget.ts",
          line: 12,
        },
        sender: { id: 200, login: "alice", type: "User" },
      },
      expectedThreadId: "github:acme/widgets:42:rc:777",
    },
  ])("routes a signed $name", async ({ event, payload, expectedThreadId }) => {
    const adapters = buildChatSdkAdapters({
      workspaceId: "ws-1",
      signals: githubSignals,
      credentials: githubCreds,
      streamRegistry: new StreamRegistry(),
    });

    const githubAdapter = adapters.github;
    expect(githubAdapter).toBeDefined();
    if (!githubAdapter) return;

    // Minimal Chat surface — `processMessage` is fire-and-forget in the
    // adapter (the handlers don't await it), and `getState` is only touched
    // by `storeInstallationId` in multi-tenant mode. Both are spies so we
    // can assert the handler actually reached its chat dispatch.
    const processMessage = vi.fn();
    const chatStub = {
      processMessage,
      getState: () => ({
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockResolvedValue(undefined),
      }),
    };
    await githubAdapter.initialize?.(chatStub as never);

    const body = JSON.stringify(payload);
    const request = new Request("http://localhost/signals/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": event,
        "X-GitHub-Delivery": `delivery-${event}-1`,
        "X-Hub-Signature-256": signBody(body, githubCreds.webhookSecret),
      },
      body,
    });

    const response = await githubAdapter.handleWebhook(request);
    expect(response.status).toBe(200);

    expect(processMessage).toHaveBeenCalledOnce();
    const [adapterArg, threadIdArg] = processMessage.mock.calls[0] ?? [];
    expect(adapterArg).toBe(githubAdapter);
    expect(threadIdArg).toBe(expectedThreadId);
  });

  // Regression guard for the bot self-reply filter: the adapter drops events
  // whose `comment.user.id` matches `botUserId`. Without it, the bot's own
  // replies trigger inbound webhooks and infinite-loop. Signature is valid so
  // we exercise the post-HMAC filter, not the 401 path.
  it("drops a signed webhook when comment.user.id matches botUserId (self-reply guard)", async () => {
    const adapters = buildChatSdkAdapters({
      workspaceId: "ws-1",
      signals: githubSignals,
      credentials: githubCreds,
      streamRegistry: new StreamRegistry(),
    });

    const githubAdapter = adapters.github;
    expect(githubAdapter).toBeDefined();
    if (!githubAdapter) return;

    const processMessage = vi.fn();
    const chatStub = {
      processMessage,
      getState: () => ({
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockResolvedValue(undefined),
      }),
    };
    await githubAdapter.initialize?.(chatStub as never);

    const payload: Record<string, unknown> = {
      action: "created",
      installation: { id: 67890 },
      issue: { number: 42, html_url: "https://github.com/acme/widgets/issues/42" },
      repository: {
        id: 1,
        name: "widgets",
        full_name: "acme/widgets",
        owner: { login: "acme", id: 100, type: "Organization" },
      },
      comment: {
        id: 555,
        body: "looking into this now",
        // The bot is the sender — `comment.user.id === botUserId (99999)`.
        user: { id: githubCreds.botUserId, login: "friday-bot[bot]", type: "Bot" },
        created_at: "2026-05-09T12:00:00Z",
        updated_at: "2026-05-09T12:00:00Z",
        html_url: "https://github.com/acme/widgets/issues/42#issuecomment-555",
      },
      sender: { id: githubCreds.botUserId, login: "friday-bot[bot]", type: "Bot" },
    };
    const body = JSON.stringify(payload);
    const request = new Request("http://localhost/signals/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issue_comment",
        "X-GitHub-Delivery": "delivery-self-reply",
        "X-Hub-Signature-256": signBody(body, githubCreds.webhookSecret),
      },
      body,
    });

    const response = await githubAdapter.handleWebhook(request);
    // Adapter ack: signature valid, event accepted, but self-reply filter
    // short-circuits before chat dispatch.
    expect(response.status).toBe(200);
    expect(processMessage).not.toHaveBeenCalled();
  });
});

describe("resolveGithubFromLink: snake_case → camelCase secret mapping", () => {
  const originalLinkUrl = process.env.LINK_SERVICE_URL;
  const originalLinkDev = process.env.LINK_DEV_MODE;

  beforeEach(() => {
    process.env.LINK_SERVICE_URL = "http://link.test";
    process.env.LINK_DEV_MODE = "true";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalLinkUrl === undefined) delete process.env.LINK_SERVICE_URL;
    else process.env.LINK_SERVICE_URL = originalLinkUrl;
    if (originalLinkDev === undefined) delete process.env.LINK_DEV_MODE;
    else process.env.LINK_DEV_MODE = originalLinkDev;
  });

  it("maps Link's snake_case secret to camelCase PlatformCredentials, stringifies app_id, drops installation_id", async () => {
    // Stub Link: wiring lookup → credential lookup → secret payload matches
    // what the github-app provider stores via `health()`-returned metadata
    // (merged by `apps/link/src/routes/credentials.ts`): numeric app_id, bare
    // bot_user_slug (no `[bot]` suffix — see github-app.ts:179), numeric
    // bot_user_id.
    const linkSecret = {
      app_id: 12345,
      private_key: "-----BEGIN PRIVATE KEY-----\nstubbed-pem\n-----END PRIVATE KEY-----",
      webhook_secret: "link-webhook-secret",
      installation_id: 67890,
      bot_user_slug: "friday-bot",
      bot_user_id: 555,
    };
    const fetchStub = vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/internal/v1/communicator/wiring")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ wiring: { credential_id: "cred-gh", connection_id: "67890" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (url.includes("/internal/v1/credentials/cred-gh")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              credential: {
                id: "cred-gh",
                type: "apikey",
                provider: "github",
                userIdentifier: "user-1",
                label: "github",
                secret: linkSecret,
                metadata: {},
              },
              status: "ready",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("not stubbed", { status: 500 }));
    });
    vi.stubGlobal("fetch", fetchStub);

    const result = await resolvePlatformCredentials("ws-1", "user-1", {
      "github-chat": { provider: "github", config: {} },
    });

    expect(result).toHaveLength(1);
    const resolved = result[0];
    expect(resolved?.credentialId).toBe("cred-gh");
    expect(resolved?.credentials).toEqual({
      kind: "github",
      appId: "12345",
      privateKey: linkSecret.private_key,
      webhookSecret: "link-webhook-secret",
      botUserSlug: "friday-bot",
      botUserId: 555,
    });
    // Multi-tenant mode pin: installation_id from the secret is intentionally
    // not surfaced to the adapter — the inbound webhook payload's
    // `installation.id` is the routing key. A regression that forwarded it
    // would put the adapter in single-tenant mode and break multi-installation
    // setups.
    expect(resolved?.credentials).not.toHaveProperty("installationId");
    // app_id arrives as number (12345); Link stores it that way per provider
    // schema. A regression to Number-preserved would mismatch the chat-sdk
    // adapter's `appId: string` config type.
    if (resolved?.credentials.kind === "github") {
      expect(typeof resolved.credentials.appId).toBe("string");
    }
  });
});
