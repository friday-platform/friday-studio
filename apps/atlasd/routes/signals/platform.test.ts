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

/** Create a mock Chat SDK instance with a slack webhook handler. */
function makeChatSdkInstance(
  slackHandler?: (request: Request) => Promise<Response>,
): ChatSdkInstance {
  const webhooks: Record<string, unknown> = { atlas: vi.fn() };
  if (slackHandler) {
    webhooks.slack = slackHandler;
  }

  return { chat: { webhooks } as unknown as Chat, teardown: vi.fn().mockResolvedValue(undefined) };
}

/** Build a mock daemon for routing tests. */
function makeDaemon(
  workspaces: { id: string; config: MergedConfig | null }[],
  chatSdkResolver?: (workspaceId: string) => Promise<ChatSdkInstance>,
) {
  const configMap = new Map(workspaces.map((w) => [w.id, w.config]));
  const getWorkspaceConfig = vi.fn<WorkspaceManager["getWorkspaceConfig"]>((id: string) =>
    Promise.resolve(configMap.get(id) ?? null),
  );
  const list = vi.fn<WorkspaceManager["list"]>(() =>
    Promise.resolve(workspaces.map((w) => ({ id: w.id }) as WorkspaceEntry)),
  );

  const getOrCreateChatSdkInstance = chatSdkResolver
    ? vi.fn<(id: string) => Promise<ChatSdkInstance>>().mockImplementation(chatSdkResolver)
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
  return app.request("/slack", { method: "POST", headers, body: JSON.stringify(body) });
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
      () => Promise.resolve(makeChatSdkInstance(slackHandler)),
    );

    const app = createPlatformSignalRoutes(daemon);
    const res = await postSlack(app);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(getOrCreateChatSdkInstance).toHaveBeenCalledWith("ws-target");
    expect(slackHandler).toHaveBeenCalledOnce();
    expect(capturedBody).toBe(JSON.stringify(rawSlackEvent));
    expect(capturedRequest?.headers.get("x-slack-request-timestamp")).toBe("1234567890");
    expect(capturedRequest?.headers.get("x-slack-signature")).toBe("v0=abc123");
    expect(capturedRequest?.headers.get("content-type")).toBe("application/json");
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

  it("returns 404 when workspace has no slack adapter in Chat SDK", async () => {
    const { daemon } = makeDaemon(
      [{ id: "ws-abc", config: makeConfig("A012ABCD0A0") }],
      () => Promise.resolve(makeChatSdkInstance()), // no slack handler
    );

    const app = createPlatformSignalRoutes(daemon);
    const res = await postSlack(app);

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("No Slack adapter configured for this workspace");
  });

  it("returns 500 when Chat SDK instance creation fails", async () => {
    const { daemon } = makeDaemon([{ id: "ws-abc", config: makeConfig("A012ABCD0A0") }], () =>
      Promise.reject(new Error("credential resolution failed")),
    );

    const app = createPlatformSignalRoutes(daemon);
    const res = await postSlack(app);

    expect(res.status).toBe(500);
  });
});
