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
  botUserSlug: "friday-bot[bot]",
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
    // what the github-app provider stores after autoFields() merge (numeric
    // app_id, populated bot_user_slug / bot_user_id).
    const linkSecret = {
      app_id: 12345,
      private_key: "-----BEGIN PRIVATE KEY-----\nstubbed-pem\n-----END PRIVATE KEY-----",
      webhook_secret: "link-webhook-secret",
      installation_id: 67890,
      bot_user_slug: "friday-bot[bot]",
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
      botUserSlug: "friday-bot[bot]",
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
