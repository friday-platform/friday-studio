import type { MergedConfig } from "@atlas/config";
import type { WorkspaceEntry, WorkspaceManager } from "@atlas/workspace";
import type { Chat } from "chat";
import { describe, expect, it, vi } from "vitest";
import type { AtlasDaemon } from "../../src/atlas-daemon.ts";
import type { ChatSdkInstance } from "../../src/chat-sdk/chat-sdk-instance.ts";
import { createPlatformSignalRoutes } from "./platform.ts";

/** Raw Slack event_callback payload (what the Gateway forwards). */
const rawSlackEvent = {
  token: "tok-123",
  team_id: "T024BE7LD",
  api_app_id: "A012ABCD0A0",
  event: {
    type: "message",
    text: "hello",
    user: "U01234",
    channel: "C123",
    ts: "1234567890.123456",
  },
  type: "event_callback",
  event_id: "Ev01ABC",
  event_time: 1234567890,
};

const slackHeaders = {
  "Content-Type": "application/json",
  "X-Slack-Request-Timestamp": "1234567890",
  "X-Slack-Signature": "v0=abc123",
};

/** Build a minimal MergedConfig with a slack signal. */
function makeConfig(appId: string): MergedConfig {
  return {
    atlas: null,
    workspace: {
      version: "1.0",
      workspace: { name: "test" },
      signals: {
        slack: {
          provider: "slack" as const,
          description: "Incoming Slack messages",
          config: { app_id: appId },
        },
      },
    },
  };
}

/** Build a MergedConfig with no slack signal. */
function makeNonSlackConfig(): MergedConfig {
  return {
    atlas: null,
    workspace: {
      version: "1.0",
      workspace: { name: "test" },
      signals: {
        http: {
          provider: "http" as const,
          description: "HTTP webhook",
          config: { path: "/webhook" },
        },
      },
    },
  };
}

/**
 * Create a mock Chat SDK instance. Pass `webhookKey` + `handler` to expose a
 * platform webhook; omit both for "adapter not configured" scenarios.
 */
function makeChatSdkInstance(
  webhookKey?: "slack" | "discord" | "telegram" | "whatsapp" | "teams",
  handler?: (request: Request) => Promise<Response>,
): ChatSdkInstance {
  const webhooks: Record<string, unknown> = { atlas: vi.fn() };
  if (webhookKey && handler) {
    webhooks[webhookKey] = handler;
  }

  return {
    chat: { webhooks } as unknown as Chat,
    teardown: vi.fn().mockResolvedValue(undefined),
  };
}

/** Build a mock daemon for routing tests. */
function makeDaemon(
  workspaces: { id: string; config: MergedConfig | null }[],
  chatSdkResolver?: (workspaceId: string) => Promise<ChatSdkInstance>,
) {
  const configMap = new Map(workspaces.map((w) => [w.id, w.config]));
  const getWorkspaceConfig = vi.fn<WorkspaceManager["getWorkspaceConfig"]>((
    id: string,
  ) => Promise.resolve(configMap.get(id) ?? null));
  const list = vi.fn<WorkspaceManager["list"]>(() =>
    Promise.resolve(workspaces.map((w) => ({ id: w.id }) as WorkspaceEntry))
  );

  const getOrCreateChatSdkInstance = chatSdkResolver
    ? vi.fn<(id: string) => Promise<ChatSdkInstance>>().mockImplementation(
      chatSdkResolver,
    )
    : vi
      .fn<(id: string) => Promise<ChatSdkInstance>>()
      .mockRejectedValue(new Error("No Chat SDK instance"));

  const daemon = {
    getWorkspaceManager: () => ({ getWorkspaceConfig, list }),
    getOrCreateChatSdkInstance,
  } as unknown as AtlasDaemon;

  return { daemon, getWorkspaceConfig, getOrCreateChatSdkInstance };
}

/** Helper to send a POST /slack request with raw Slack payload. */
function postSlack(
  app: ReturnType<typeof createPlatformSignalRoutes>,
  body: unknown = rawSlackEvent,
  headers: Record<string, string> = slackHeaders,
) {
  return app.request("/slack", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /slack", () => {
  it("scans workspaces by api_app_id, delegates to the right SlackAdapter, and forwards raw body + Slack headers", async () => {
    let capturedRequest: Request | undefined;
    let capturedBody: string | undefined;
    const slackHandler = vi
      .fn<(req: Request) => Promise<Response>>()
      .mockImplementation(async (req) => {
        capturedRequest = req;
        capturedBody = await req.text();
        return new Response("ok", { status: 200 });
      });

    const { daemon, getOrCreateChatSdkInstance } = makeDaemon(
      [
        { id: "ws-other", config: makeConfig("A_OTHER_APP") },
        { id: "ws-target", config: makeConfig("A012ABCD0A0") },
      ],
      () => Promise.resolve(makeChatSdkInstance("slack", slackHandler)),
    );

    const app = createPlatformSignalRoutes(daemon);
    const res = await postSlack(app);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(getOrCreateChatSdkInstance).toHaveBeenCalledWith("ws-target");
    expect(slackHandler).toHaveBeenCalledOnce();
    expect(capturedBody).toBe(JSON.stringify(rawSlackEvent));
    expect(capturedRequest?.headers.get("x-slack-request-timestamp")).toBe(
      "1234567890",
    );
    expect(capturedRequest?.headers.get("x-slack-signature")).toBe("v0=abc123");
    expect(capturedRequest?.headers.get("content-type")).toBe(
      "application/json",
    );
  });

  it.each([
    {
      name: "no workspace matches the api_app_id",
      workspaces: [] as { id: string; config: MergedConfig | null }[],
    },
    {
      name: "workspace has no matching slack signal",
      workspaces: [{ id: "ws-abc", config: makeNonSlackConfig() }],
    },
  ])("returns 404 when $name", async ({ workspaces }) => {
    const { daemon } = makeDaemon(workspaces);
    const app = createPlatformSignalRoutes(daemon);
    const res = await postSlack(app);

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("No workspace configured for this app_id");
  });

  it("returns 400 when payload is missing api_app_id", async () => {
    const { daemon } = makeDaemon([]);
    const app = createPlatformSignalRoutes(daemon);
    const res = await postSlack(app, { type: "event_callback", event: {} });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Missing api_app_id in payload");
  });

  it("echoes challenge on url_verification without needing a workspace or adapter", async () => {
    // Slack's initial Event Subscriptions handshake. No api_app_id, no
    // signature, so the route answers before touching workspace lookup or
    // the Chat SDK. Matches signal-gateway's slack_perapp.go behavior.
    const { daemon } = makeDaemon([]);
    const app = createPlatformSignalRoutes(daemon);
    const res = await postSlack(app, {
      token: "verify-token",
      challenge: "challenge-xyz-123",
      type: "url_verification",
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("challenge-xyz-123");
    expect(res.headers.get("content-type")?.toLowerCase()).toContain(
      "text/plain",
    );
  });

  it("returns 400 on invalid JSON body", async () => {
    const { daemon } = makeDaemon([]);
    const app = createPlatformSignalRoutes(daemon);
    const res = await app.request("/slack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json at all",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Invalid JSON body");
  });

  it("returns 404 when workspace has no slack adapter in Chat SDK", async () => {
    const { daemon } = makeDaemon(
      [{ id: "ws-abc", config: makeConfig("A012ABCD0A0") }],
      () => Promise.resolve(makeChatSdkInstance()), // no webhook handler
    );

    const app = createPlatformSignalRoutes(daemon);
    const res = await postSlack(app);

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("No Slack adapter configured for this workspace");
  });

  it("returns 500 when Chat SDK instance creation fails", async () => {
    const { daemon } = makeDaemon([{
      id: "ws-abc",
      config: makeConfig("A012ABCD0A0"),
    }], () => Promise.reject(new Error("credential resolution failed")));

    const app = createPlatformSignalRoutes(daemon);
    const res = await postSlack(app);

    expect(res.status).toBe(500);
  });
});

// ─── Discord forwarded Gateway events (POST) ──────────────────────────

function makeDiscordConfig(): MergedConfig {
  return {
    atlas: null,
    workspace: {
      version: "1.0",
      workspace: { name: "test" },
      signals: {
        "discord-chat": {
          provider: "discord" as const,
          description: "Discord inbound",
          config: {},
        },
      },
    },
  };
}

const forwardedGatewayBody = {
  type: "GATEWAY_MESSAGE_CREATE",
  timestamp: 1730_000_000_000,
  data: {
    id: "msg-id",
    content: "hello",
    author: { id: "user-1", bot: false, username: "alice" },
    channel_id: "channel-1",
  },
};

const forwardedHeaders = {
  "Content-Type": "application/json",
  "x-discord-gateway-token": "bot-token",
};

function postDiscord(
  app: ReturnType<typeof createPlatformSignalRoutes>,
  body: unknown = forwardedGatewayBody,
  headers: Record<string, string> = forwardedHeaders,
) {
  return app.request("/discord", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /discord", () => {
  it("routes to the single discord workspace and preserves the forwarded token header + body", async () => {
    let capturedRequest: Request | undefined;
    let capturedBody: string | undefined;
    const discordHandler = vi
      .fn<(req: Request) => Promise<Response>>()
      .mockImplementation(async (req) => {
        capturedRequest = req;
        capturedBody = await req.text();
        return new Response("ok", { status: 200 });
      });

    const { daemon, getOrCreateChatSdkInstance } = makeDaemon(
      [{ id: "ws-discord", config: makeDiscordConfig() }],
      () => Promise.resolve(makeChatSdkInstance("discord", discordHandler)),
    );

    const app = createPlatformSignalRoutes(daemon);
    const res = await postDiscord(app);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(getOrCreateChatSdkInstance).toHaveBeenCalledWith("ws-discord");
    expect(discordHandler).toHaveBeenCalledOnce();
    expect(capturedBody).toBe(JSON.stringify(forwardedGatewayBody));
    expect(capturedRequest?.headers.get("x-discord-gateway-token")).toBe(
      "bot-token",
    );
    expect(capturedRequest?.headers.get("content-type")).toBe(
      "application/json",
    );
  });

  it("returns 404 when no workspace has a discord signal", async () => {
    const { daemon } = makeDaemon([{
      id: "ws-other",
      config: makeNonSlackConfig(),
    }]);
    const app = createPlatformSignalRoutes(daemon);
    const res = await postDiscord(app);

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("No workspace configured for Discord");
  });

  it("returns 404 when the discord workspace has no discord adapter in Chat SDK", async () => {
    const { daemon } = makeDaemon(
      [{ id: "ws-discord", config: makeDiscordConfig() }],
      () => Promise.resolve(makeChatSdkInstance()),
    );
    const app = createPlatformSignalRoutes(daemon);
    const res = await postDiscord(app);

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("No Discord adapter configured for this workspace");
  });

  it("returns 500 when Chat SDK instance creation fails", async () => {
    const { daemon } = makeDaemon([{
      id: "ws-discord",
      config: makeDiscordConfig(),
    }], () => Promise.reject(new Error("credential resolution failed")));
    const app = createPlatformSignalRoutes(daemon);
    const res = await postDiscord(app);

    expect(res.status).toBe(500);
  });

  it("logs and picks the first candidate when multiple workspaces have a discord signal", async () => {
    const discordHandler = vi
      .fn<(req: Request) => Promise<Response>>()
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const { daemon, getOrCreateChatSdkInstance } = makeDaemon(
      [
        { id: "ws-a", config: makeDiscordConfig() },
        { id: "ws-b", config: makeDiscordConfig() },
      ],
      () => Promise.resolve(makeChatSdkInstance("discord", discordHandler)),
    );

    const app = createPlatformSignalRoutes(daemon);
    const res = await postDiscord(app);

    expect(res.status).toBe(200);
    // First match wins (single-workspace short-circuit; documented limitation).
    expect(getOrCreateChatSdkInstance).toHaveBeenCalledWith("ws-a");
  });
});

// ─── WhatsApp verify handshake (GET) ──────────────────────────────────

function makeWhatsappConfig(
  overrides: { verify_token?: string } = {},
): MergedConfig {
  return {
    atlas: null,
    workspace: {
      version: "1.0",
      workspace: { name: "test" },
      signals: {
        "whatsapp-chat": {
          provider: "whatsapp" as const,
          description: "WhatsApp inbound",
          config: overrides,
        },
      },
    },
  };
}

function getWhatsappVerify(
  app: ReturnType<typeof createPlatformSignalRoutes>,
  query: string,
) {
  return app.request(`/whatsapp?${query}`, { method: "GET" });
}

describe("GET /whatsapp (verify handshake)", () => {
  it("matches explicit verify_token in signal.config → routes to that workspace", async () => {
    const handler = vi
      .fn<(req: Request) => Promise<Response>>()
      .mockResolvedValue(new Response("challenge-123", { status: 200 }));
    const { daemon, getOrCreateChatSdkInstance } = makeDaemon(
      [
        {
          id: "ws-other",
          config: makeWhatsappConfig({ verify_token: "other-token" }),
        },
        {
          id: "ws-target",
          config: makeWhatsappConfig({ verify_token: "expected-token" }),
        },
      ],
      () => Promise.resolve(makeChatSdkInstance("whatsapp", handler)),
    );
    const app = createPlatformSignalRoutes(daemon);

    const res = await getWhatsappVerify(
      app,
      "hub.mode=subscribe&hub.verify_token=expected-token&hub.challenge=challenge-123",
    );

    expect(res.status).toBe(200);
    expect(getOrCreateChatSdkInstance).toHaveBeenCalledWith("ws-target");
  });

  it("falls back to the sole whatsapp workspace when no explicit match (env-based config)", async () => {
    const handler = vi
      .fn<(req: Request) => Promise<Response>>()
      .mockResolvedValue(new Response("fallback-challenge", { status: 200 }));
    const { daemon, getOrCreateChatSdkInstance } = makeDaemon(
      // Single workspace with config: {} — secret comes from env var
      [{ id: "ws-solo", config: makeWhatsappConfig() }],
      () => Promise.resolve(makeChatSdkInstance("whatsapp", handler)),
    );
    const app = createPlatformSignalRoutes(daemon);

    const res = await getWhatsappVerify(
      app,
      "hub.mode=subscribe&hub.verify_token=from-env&hub.challenge=fallback-challenge",
    );

    expect(res.status).toBe(200);
    expect(getOrCreateChatSdkInstance).toHaveBeenCalledWith("ws-solo");
  });

  it("returns 403 when no workspace has a whatsapp signal at all", async () => {
    const { daemon } = makeDaemon(
      [{ id: "ws-nope", config: makeNonSlackConfig() }], // only http signal
    );
    const app = createPlatformSignalRoutes(daemon);

    const res = await getWhatsappVerify(
      app,
      "hub.mode=subscribe&hub.verify_token=anything&hub.challenge=x",
    );

    expect(res.status).toBe(403);
  });

  it("returns 400 when hub.verify_token query param is missing", async () => {
    const { daemon } = makeDaemon([{
      id: "ws-solo",
      config: makeWhatsappConfig(),
    }]);
    const app = createPlatformSignalRoutes(daemon);

    const res = await getWhatsappVerify(
      app,
      "hub.mode=subscribe&hub.challenge=x",
    );

    expect(res.status).toBe(400);
  });
});

// ─── Microsoft Teams activity routing (POST) ──────────────────────────

function makeTeamsConfig(appId: string): MergedConfig {
  return {
    atlas: null,
    workspace: {
      version: "1.0",
      workspace: { name: "test" },
      signals: {
        "teams-chat": {
          provider: "teams" as const,
          description: "Teams inbound",
          config: { app_id: appId },
        },
      },
    },
  };
}

/** A teams signal with no app_id in workspace.yml — reads TEAMS_APP_ID from env.
 * Env-only setups are the only legitimate wildcard fallback target when the
 * incoming activity's app_id doesn't exact-match any pinned workspace. */
function makeTeamsEnvOnlyConfig(): MergedConfig {
  return {
    atlas: null,
    workspace: {
      version: "1.0",
      workspace: { name: "test" },
      signals: {
        "teams-chat": {
          provider: "teams" as const,
          description: "Teams inbound",
          config: {},
        },
      },
    },
  };
}

const teamsHeaders = {
  "Content-Type": "application/json",
  Authorization: "Bearer eyJ.jwt.stub",
};

function teamsActivity(appId: string) {
  // Azure Bot formats recipient.id as "28:<botAppId>" on inbound activities.
  return {
    type: "message",
    text: "hello",
    from: { id: "29:user-1", name: "Alice" },
    recipient: { id: `28:${appId}`, name: "Friday" },
    conversation: { id: "a:convo-1" },
    serviceUrl: "https://smba.trafficmanager.net/teams/",
  };
}

function postTeams(
  app: ReturnType<typeof createPlatformSignalRoutes>,
  body: unknown,
  headers: Record<string, string> = teamsHeaders,
) {
  return app.request("/teams", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /teams", () => {
  it("routes by recipient.id app_id match and forwards the cloned raw request", async () => {
    let capturedRequest: Request | undefined;
    let capturedBody: string | undefined;
    const teamsHandler = vi
      .fn<(req: Request) => Promise<Response>>()
      .mockImplementation(async (req) => {
        capturedRequest = req;
        capturedBody = await req.text();
        return new Response("ok", { status: 200 });
      });

    const { daemon, getOrCreateChatSdkInstance } = makeDaemon(
      [
        { id: "ws-other", config: makeTeamsConfig("other-app-id") },
        { id: "ws-target", config: makeTeamsConfig("target-app-id") },
      ],
      () => Promise.resolve(makeChatSdkInstance("teams", teamsHandler)),
    );

    const app = createPlatformSignalRoutes(daemon);
    const body = teamsActivity("target-app-id");
    const res = await postTeams(app, body);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(getOrCreateChatSdkInstance).toHaveBeenCalledWith("ws-target");
    expect(teamsHandler).toHaveBeenCalledOnce();
    expect(capturedBody).toBe(JSON.stringify(body));
    // Authorization header must reach the adapter so it can validate the Bot
    // Framework JWT — otherwise every activity is rejected.
    expect(capturedRequest?.headers.get("authorization")).toBe(
      "Bearer eyJ.jwt.stub",
    );
  });

  it("falls back to the env-only workspace when no app_id match exists", async () => {
    const handler = vi
      .fn<(req: Request) => Promise<Response>>()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const { daemon, getOrCreateChatSdkInstance } = makeDaemon(
      [{ id: "ws-solo", config: makeTeamsEnvOnlyConfig() }],
      () => Promise.resolve(makeChatSdkInstance("teams", handler)),
    );

    const app = createPlatformSignalRoutes(daemon);
    // recipient.id carries any app_id; the workspace's config omits app_id
    // entirely, so it reads TEAMS_APP_ID from env and acts as a wildcard.
    const res = await postTeams(app, teamsActivity("some-other-app-id"));

    expect(res.status).toBe(200);
    expect(getOrCreateChatSdkInstance).toHaveBeenCalledWith("ws-solo");
  });

  it("returns 404 when app_id is pinned but doesn't match (typo case, no env-only fallback)", async () => {
    // The old behavior silently delivered to the single pinned workspace even
    // when app_id didn't match — masking operator typos. Fail closed instead.
    const { daemon, getOrCreateChatSdkInstance } = makeDaemon(
      [{ id: "ws-solo", config: makeTeamsConfig("configured-app-id") }],
      () => Promise.resolve(makeChatSdkInstance()),
    );

    const app = createPlatformSignalRoutes(daemon);
    const res = await postTeams(app, teamsActivity("some-other-app-id"));

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("No workspace configured for this app_id");
    expect(getOrCreateChatSdkInstance).not.toHaveBeenCalled();
  });

  it("returns 400 on non-JSON body", async () => {
    const { daemon } = makeDaemon([]);
    const app = createPlatformSignalRoutes(daemon);
    const res = await app.request("/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json at all",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Invalid JSON body");
  });

  it("returns 400 when recipient is absent", async () => {
    const { daemon } = makeDaemon([{
      id: "ws-solo",
      config: makeTeamsConfig("any"),
    }]);
    const app = createPlatformSignalRoutes(daemon);
    const res = await postTeams(app, { type: "message", text: "no recipient" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Missing recipient.id in payload");
  });

  it("returns 404 when no workspace has a teams signal", async () => {
    const { daemon } = makeDaemon([{
      id: "ws-other",
      config: makeNonSlackConfig(),
    }]);
    const app = createPlatformSignalRoutes(daemon);
    const res = await postTeams(app, teamsActivity("target-app-id"));

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("No workspace configured for this app_id");
  });

  it("returns 404 when the teams workspace has no teams adapter in Chat SDK", async () => {
    const { daemon } = makeDaemon(
      [{ id: "ws-solo", config: makeTeamsConfig("target-app-id") }],
      () => Promise.resolve(makeChatSdkInstance()),
    );
    const app = createPlatformSignalRoutes(daemon);
    const res = await postTeams(app, teamsActivity("target-app-id"));

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("No Teams adapter configured for this workspace");
  });

  it("returns 500 when Chat SDK instance creation fails", async () => {
    const { daemon } = makeDaemon(
      [{ id: "ws-solo", config: makeTeamsConfig("target-app-id") }],
      () => Promise.reject(new Error("credential resolution failed")),
    );
    const app = createPlatformSignalRoutes(daemon);
    const res = await postTeams(app, teamsActivity("target-app-id"));

    expect(res.status).toBe(500);
  });

  it("returns 500 when chat.webhooks.teams throws", async () => {
    // Covers the production failure mode: expired Azure client secret →
    // Bot Framework JWT rejection → adapter.handleWebhook throws. The route's
    // try/catch keeps the daemon alive and emits teams_webhook_handler_failed.
    const rejectingHandler = vi
      .fn<(req: Request) => Promise<Response>>()
      .mockRejectedValue(new Error("Bot Framework JWT validation failed"));
    const { daemon } = makeDaemon(
      [{ id: "ws-solo", config: makeTeamsConfig("target-app-id") }],
      () => Promise.resolve(makeChatSdkInstance("teams", rejectingHandler)),
    );
    const app = createPlatformSignalRoutes(daemon);
    const res = await postTeams(app, teamsActivity("target-app-id"));

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal error");
    expect(rejectingHandler).toHaveBeenCalledOnce();
  });

  it("routes to the first workspace when two pin the same app_id (collision)", async () => {
    // Shared-tenant setups may legitimately share a bot across workspaces. The
    // route picks the first match from workspace iteration order — pin the
    // contract so a regression to "last wins" or "random" is caught.
    const handler = vi
      .fn<(req: Request) => Promise<Response>>()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const { daemon, getOrCreateChatSdkInstance } = makeDaemon(
      [
        { id: "ws-first", config: makeTeamsConfig("shared-app-id") },
        { id: "ws-second", config: makeTeamsConfig("shared-app-id") },
      ],
      () => Promise.resolve(makeChatSdkInstance("teams", handler)),
    );

    const app = createPlatformSignalRoutes(daemon);
    const res = await postTeams(app, teamsActivity("shared-app-id"));

    expect(res.status).toBe(200);
    expect(getOrCreateChatSdkInstance).toHaveBeenCalledWith("ws-first");
    expect(getOrCreateChatSdkInstance).not.toHaveBeenCalledWith("ws-second");
  });

  it("returns 404 when multiple teams workspaces pin app_id and none match", async () => {
    const { daemon, getOrCreateChatSdkInstance } = makeDaemon(
      [
        { id: "ws-alpha", config: makeTeamsConfig("alpha-app-id") },
        { id: "ws-beta", config: makeTeamsConfig("beta-app-id") },
      ],
      () => Promise.resolve(makeChatSdkInstance()),
    );

    const app = createPlatformSignalRoutes(daemon);
    // Activity carries an app_id neither workspace declares. Both workspaces
    // pin app_id in their config, so neither is a valid env-only fallback
    // target — fail closed with 404 instead of silently delivering to the
    // first one (the old behavior hid operator typos).
    const res = await postTeams(app, teamsActivity("unknown-app-id"));

    expect(res.status).toBe(404);
    expect(getOrCreateChatSdkInstance).not.toHaveBeenCalled();
  });

  it("picks the first env-only candidate when multiple env-only workspaces exist", async () => {
    const handler = vi
      .fn<(req: Request) => Promise<Response>>()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const { daemon, getOrCreateChatSdkInstance } = makeDaemon(
      [
        { id: "ws-alpha", config: makeTeamsEnvOnlyConfig() },
        { id: "ws-beta", config: makeTeamsEnvOnlyConfig() },
      ],
      () => Promise.resolve(makeChatSdkInstance("teams", handler)),
    );

    const app = createPlatformSignalRoutes(daemon);
    // Two env-only teams workspaces is an ambiguous config; we pick the first
    // and log a warn so the operator can grep for it.
    const res = await postTeams(app, teamsActivity("whatever-app-id"));

    expect(res.status).toBe(200);
    expect(getOrCreateChatSdkInstance).toHaveBeenCalledWith("ws-alpha");
  });
});
