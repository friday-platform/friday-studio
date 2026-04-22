/**
 * Tests for createMessageHandler — the shared per-message pipeline that
 * subscribes the thread, persists the user message, fires the "chat" signal,
 * and fans events into both StreamRegistry (web) and thread.post (platforms).
 *
 * Strategy: mock only at the external filesystem boundary (ChatStorage).
 * signalToStream, isClientSafeEvent, and StreamRegistry are real.
 */

const { mockAppendMessage } = vi.hoisted(() => ({
  mockAppendMessage: vi.fn<() => Promise<{ ok: boolean; error?: string }>>(),
}));

vi.mock("@atlas/core/chat/storage", () => ({
  ChatStorage: {
    appendMessage: mockAppendMessage,
    createChat: vi.fn().mockResolvedValue({ ok: true }),
    getChat: vi.fn().mockResolvedValue({ ok: true, data: null }),
    deleteChat: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

import process from "node:process";
import type { Logger } from "@atlas/logger";
import { DiscordAdapter } from "@chat-adapter/discord";
import type { Message, Thread, WebhookOptions } from "chat";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KERNEL_WORKSPACE_ID } from "../factory.ts";
import { StreamRegistry } from "../stream-registry.ts";
import {
  createMessageHandler,
  initializeChatSdkInstance,
  resolvePlatformCredentials,
  superviseDiscordGateway,
} from "./chat-sdk-instance.ts";

function makeMessage(overrides?: Partial<Message>): Message {
  return {
    id: "msg-1",
    text: "Hello Friday",
    threadId: "chat-123",
    author: { userId: "user-1", userName: "user-1", fullName: "User", isBot: false, isMe: false },
    raw: {},
    formatted: { type: "root", children: [] },
    metadata: { dateSent: new Date(), edited: false },
    attachments: [],
    ...overrides,
  } as Message;
}

function makeThread(id: string) {
  const posted: unknown[] = [];
  return {
    id,
    adapter: { name: "atlas" },
    subscribe: vi.fn().mockResolvedValue(undefined),
    post: vi.fn(async (stream: ReadableStream<unknown>) => {
      for await (const chunk of stream) {
        posted.push(chunk);
      }
      return { id: "sent-1", threadId: id, raw: {} };
    }),
    posted,
  } as unknown as Thread & { posted: unknown[] };
}

/** Synchronously emits chunks via onStreamEvent then resolves. */
function makeTriggerFn(chunks: unknown[]) {
  return vi.fn(
    (
      _signalName: string,
      _payload: Record<string, unknown>,
      _streamId: string,
      onStreamEvent: (chunk: unknown) => void,
    ) => {
      for (const chunk of chunks) {
        onStreamEvent(chunk);
      }
      return Promise.resolve({ sessionId: "sess-1" });
    },
  );
}

beforeEach(() => {
  mockAppendMessage.mockReset();
  mockAppendMessage.mockResolvedValue({ ok: true });
});

describe("createMessageHandler", () => {
  it("subscribes, persists message, propagates datetime, posts stream, finishes registry", async () => {
    const registry = new StreamRegistry();
    const chunks = [
      { type: "text-delta", delta: "Hello" },
      { type: "text-delta", delta: " world" },
    ];
    const triggerFn = makeTriggerFn(chunks);
    const handler = createMessageHandler("ws-test", triggerFn, registry);

    const datetime = {
      timezone: "America/New_York",
      timestamp: "2026-04-02T12:00:00Z",
      localDate: "2026-04-02",
      localTime: "08:00",
      timezoneOffset: "-04:00",
    };

    const thread = makeThread("chat-abc");
    registry.createStream("chat-abc");

    await handler(
      thread,
      makeMessage({ id: "m-1", text: "Hi", threadId: "chat-abc", raw: { datetime } }),
    );

    expect(thread.subscribe).toHaveBeenCalled();
    expect(mockAppendMessage).toHaveBeenCalledWith(
      "chat-abc",
      { id: "m-1", role: "user", parts: [{ type: "text", text: "Hi" }], metadata: {} },
      "ws-test",
    );
    expect(triggerFn).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        chatId: "chat-abc",
        userId: "user-1",
        streamId: "chat-abc",
        datetime,
      }),
      "chat-abc",
      expect.any(Function),
    );

    expect(thread.post).toHaveBeenCalledOnce();
    expect(thread.posted).toEqual(chunks);

    const buffer = registry.getStream("chat-abc");
    expect(buffer?.events).toEqual(chunks);
    expect(buffer?.active).toBe(false);
  });

  it("filters internal FSM events from StreamRegistry but forwards them to thread.post", async () => {
    const registry = new StreamRegistry();
    const chunks = [
      { type: "text-delta", delta: "hi" },
      { type: "data-fsm-action-execution", data: {} },
      { type: "data-session-start", data: {} },
      { type: "data-session-finish", data: {} },
    ];
    const triggerFn = makeTriggerFn(chunks);
    const handler = createMessageHandler("ws-test", triggerFn, registry);

    const thread = makeThread("chat-filter");
    registry.createStream("chat-filter");
    await handler(thread, makeMessage({ threadId: "chat-filter" }));

    // Only client-safe events reach StreamRegistry; thread.post sees them all.
    const types = registry
      .getStream("chat-filter")
      ?.events.map((e) => (e as { type: string }).type);
    expect(types).toEqual(["text-delta", "data-session-start"]);
    expect(thread.posted).toHaveLength(4);
  });

  it("persists pre-validated uiMessage from raw when present (multi-part web payload)", async () => {
    const registry = new StreamRegistry();
    const handler = createMessageHandler(
      "ws-test",
      makeTriggerFn([{ type: "text-delta", delta: "ok" }]),
      registry,
    );

    const thread = makeThread("chat-multipart");
    registry.createStream("chat-multipart");

    const preValidated = {
      id: "msg-with-files",
      role: "user" as const,
      parts: [
        { type: "text" as const, text: "analyze this" },
        {
          type: "data-artifact-attached" as const,
          data: { artifactIds: ["a-1"], filenames: ["sales.csv"], mimeTypes: ["text/csv"] },
        },
      ],
      metadata: {},
    };

    await handler(
      thread,
      makeMessage({
        id: "msg-synthetic-1",
        text: "analyze this",
        threadId: "chat-multipart",
        raw: { uiMessage: preValidated },
      }),
    );

    // The stashed uiMessage is persisted verbatim — NOT the text-only rebuild
    // that toAtlasUIMessage would produce. This preserves data-artifact-attached
    // for downstream consumers (expandArtifactAttachedParts, UI history).
    expect(mockAppendMessage).toHaveBeenCalledWith("chat-multipart", preValidated, "ws-test");
  });

  it("clears the pre-set source when thread.subscribe fails on a slack thread", async () => {
    const registry = new StreamRegistry();
    const stateAdapter = {
      setSource: vi.fn(),
      clearSource: vi.fn(),
    } as unknown as import("@atlas/core/chat/chat-sdk-state-adapter").ChatSdkStateAdapter;
    const handler = createMessageHandler(
      "ws-test",
      makeTriggerFn([{ type: "text-delta", delta: "x" }]),
      registry,
      stateAdapter,
    );

    const thread = makeThread("slack-thread-1");
    (thread as unknown as { adapter: { name: string } }).adapter = { name: "slack" };
    (thread as unknown as { subscribe: ReturnType<typeof vi.fn> }).subscribe = vi
      .fn()
      .mockRejectedValue(new Error("subscribe failed"));

    await expect(handler(thread, makeMessage({ threadId: "slack-thread-1" }))).rejects.toThrow(
      "subscribe failed",
    );

    // Source was pre-set BEFORE subscribe, then cleared in the catch — without
    // this, the threadSources map would leak one entry per failed slack subscribe.
    expect(stateAdapter.setSource).toHaveBeenCalledWith("slack-thread-1", "slack");
    expect(stateAdapter.clearSource).toHaveBeenCalledWith("slack-thread-1");
  });

  it("logs and continues on appendMessage failure, but propagates thread.post errors via finally", async () => {
    const registry = new StreamRegistry();
    const handler = createMessageHandler(
      "ws-test",
      makeTriggerFn([{ type: "text-delta", delta: "x" }]),
      registry,
    );

    // appendMessage failure must NOT abort the handler — signal still fires.
    mockAppendMessage.mockResolvedValueOnce({ ok: false, error: "disk full" });
    const thread = makeThread("chat-err");
    (thread as unknown as { post: ReturnType<typeof vi.fn> }).post = vi
      .fn()
      .mockRejectedValue(new Error("Slack API down"));
    registry.createStream("chat-err");

    await expect(handler(thread, makeMessage({ threadId: "chat-err" }))).rejects.toThrow(
      "Slack API down",
    );
    expect(mockAppendMessage).toHaveBeenCalled();
    // finally block ran even though post threw
    expect(registry.getStream("chat-err")?.active).toBe(false);
  });
});

describe("createMessageHandler — kernel filtering", () => {
  beforeEach(() => {
    mockAppendMessage.mockReset();
    mockAppendMessage.mockResolvedValue({ ok: true });
  });

  it("filters KERNEL_WORKSPACE_ID from foregroundWorkspaceIds when exposeKernel is false", async () => {
    const registry = new StreamRegistry();
    const triggerFn = makeTriggerFn([{ type: "text-delta", delta: "ok" }]);
    const handler = createMessageHandler("ws-1", triggerFn, registry, undefined, {
      exposeKernel: false,
    });

    const thread = makeThread("chat-kernel-1");
    registry.createStream("chat-kernel-1");
    const preValidated = {
      id: "msg-k1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "hi" }],
      metadata: {},
    };
    await handler(
      thread,
      makeMessage({
        threadId: "chat-kernel-1",
        raw: {
          uiMessage: preValidated,
          foregroundWorkspaceIds: ["fg-1", KERNEL_WORKSPACE_ID, "fg-2"],
        },
      }),
    );

    expect(triggerFn).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ foregroundWorkspaceIds: ["fg-1", "fg-2"] }),
      "chat-kernel-1",
      expect.any(Function),
    );
  });

  it("passes KERNEL_WORKSPACE_ID through when exposeKernel is true", async () => {
    const registry = new StreamRegistry();
    const triggerFn = makeTriggerFn([{ type: "text-delta", delta: "ok" }]);
    const handler = createMessageHandler("ws-1", triggerFn, registry, undefined, {
      exposeKernel: true,
    });

    const thread = makeThread("chat-kernel-2");
    registry.createStream("chat-kernel-2");
    const preValidated = {
      id: "msg-k2",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "hi" }],
      metadata: {},
    };
    await handler(
      thread,
      makeMessage({
        threadId: "chat-kernel-2",
        raw: { uiMessage: preValidated, foregroundWorkspaceIds: ["fg-1", KERNEL_WORKSPACE_ID] },
      }),
    );

    expect(triggerFn).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ foregroundWorkspaceIds: ["fg-1", KERNEL_WORKSPACE_ID] }),
      "chat-kernel-2",
      expect.any(Function),
    );
  });

  it("passes undefined foregroundWorkspaceIds through as undefined", async () => {
    const registry = new StreamRegistry();
    const triggerFn = makeTriggerFn([{ type: "text-delta", delta: "ok" }]);
    const handler = createMessageHandler("ws-1", triggerFn, registry, undefined, {
      exposeKernel: false,
    });

    const thread = makeThread("chat-kernel-3");
    registry.createStream("chat-kernel-3");
    await handler(thread, makeMessage({ threadId: "chat-kernel-3" }));

    const payload = triggerFn.mock.calls[0]?.[1];
    expect(payload?.foregroundWorkspaceIds).toBeUndefined();
  });

  it("keeps empty foregroundWorkspaceIds array as empty", async () => {
    const registry = new StreamRegistry();
    const triggerFn = makeTriggerFn([{ type: "text-delta", delta: "ok" }]);
    const handler = createMessageHandler("ws-1", triggerFn, registry, undefined, {
      exposeKernel: false,
    });

    const thread = makeThread("chat-kernel-4");
    registry.createStream("chat-kernel-4");
    const preValidated = {
      id: "msg-k4",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "hi" }],
      metadata: {},
    };
    await handler(
      thread,
      makeMessage({
        threadId: "chat-kernel-4",
        raw: { uiMessage: preValidated, foregroundWorkspaceIds: [] },
      }),
    );

    expect(triggerFn).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ foregroundWorkspaceIds: [] }),
      "chat-kernel-4",
      expect.any(Function),
    );
  });
});

describe("resolvePlatformCredentials", () => {
  // resolveSlackFromLink calls out to the Link service. We redirect it to
  // an unreachable port so the fetch fails and it returns null, matching the
  // no-slack-wired case without touching the fn under test.
  const originalLinkUrl = process.env.LINK_SERVICE_URL;
  const originalLinkDev = process.env.LINK_DEV_MODE;
  beforeEach(() => {
    process.env.LINK_SERVICE_URL = "http://127.0.0.1:1";
    process.env.LINK_DEV_MODE = "true";
  });
  afterAll(() => {
    if (originalLinkUrl === undefined) delete process.env.LINK_SERVICE_URL;
    else process.env.LINK_SERVICE_URL = originalLinkUrl;
    if (originalLinkDev === undefined) delete process.env.LINK_DEV_MODE;
    else process.env.LINK_DEV_MODE = originalLinkDev;
  });

  const tgSignal = {
    "telegram-chat": { provider: "telegram", config: { bot_token: "111:secret" } },
  };
  const waSignal = {
    "whatsapp-chat": {
      provider: "whatsapp",
      config: {
        access_token: "token",
        app_secret: "secret",
        phone_number_id: "999",
        verify_token: "verify",
      },
    },
  };
  const slackSignal = {
    "slack-chat": {
      provider: "slack",
      config: {
        app_id: "A123",
        bot_token: "xoxb-byo-token",
        signing_secret: "byo-signing-secret",
      },
    },
  };

  it("resolves telegram when only telegram signal is wired", async () => {
    const result = await resolvePlatformCredentials("ws-1", tgSignal);
    expect(result).toHaveLength(1);
    expect(result[0]?.credentials.kind).toBe("telegram");
    expect(result[0]?.credentialId).toBe("telegram:111");
  });

  it("resolves whatsapp when only whatsapp signal is wired", async () => {
    const result = await resolvePlatformCredentials("ws-1", waSignal);
    expect(result).toHaveLength(1);
    expect(result[0]?.credentials.kind).toBe("whatsapp");
  });

  it("resolves BOTH when telegram + whatsapp signals coexist", async () => {
    const result = await resolvePlatformCredentials("ws-1", { ...tgSignal, ...waSignal });
    const kinds = result.map((r) => r.credentials.kind).sort();
    expect(kinds).toEqual(["telegram", "whatsapp"]);
  });

  it("resolves empty array when no signals and Slack lookup fails", async () => {
    const result = await resolvePlatformCredentials("ws-1", undefined);
    expect(result).toEqual([]);
  });

  it("does NOT mutate signal config during resolution", async () => {
    // Guards against regressions to the old bot_token_suffix stash side-effect
    // that coupled credential resolution to route-lookup ordering.
    const signals = { ...tgSignal };
    const before = JSON.stringify(signals);
    await resolvePlatformCredentials("ws-1", signals);
    expect(JSON.stringify(signals)).toBe(before);
  });

  it("falls back to env vars when signal config is empty", async () => {
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "222:env-secret";
    try {
      const result = await resolvePlatformCredentials("ws-1", {
        "telegram-chat": { provider: "telegram", config: {} },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentialId).toBe("telegram:222");
    } finally {
      if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    }
  });

  it("resolves slack from BYO signal config", async () => {
    const result = await resolvePlatformCredentials("ws-1", slackSignal);
    expect(result).toHaveLength(1);
    expect(result[0]?.credentials).toEqual({
      kind: "slack",
      botToken: "xoxb-byo-token",
      signingSecret: "byo-signing-secret",
      appId: "A123",
    });
    expect(result[0]?.credentialId).toBe("slack:A123");
  });

  it("falls back to SLACK_* env vars when slack signal config is empty", async () => {
    const originalToken = process.env.SLACK_BOT_TOKEN;
    const originalSecret = process.env.SLACK_SIGNING_SECRET;
    const originalAppId = process.env.SLACK_APP_ID;
    process.env.SLACK_BOT_TOKEN = "xoxb-env-token";
    process.env.SLACK_SIGNING_SECRET = "env-signing";
    process.env.SLACK_APP_ID = "AENV";
    try {
      const result = await resolvePlatformCredentials("ws-1", {
        "slack-chat": { provider: "slack", config: {} },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentials.kind).toBe("slack");
      expect(result[0]?.credentialId).toBe("slack:AENV");
    } finally {
      if (originalToken === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = originalToken;
      if (originalSecret === undefined) delete process.env.SLACK_SIGNING_SECRET;
      else process.env.SLACK_SIGNING_SECRET = originalSecret;
      if (originalAppId === undefined) delete process.env.SLACK_APP_ID;
      else process.env.SLACK_APP_ID = originalAppId;
    }
  });

  it("returns null when slack signal missing signing_secret (no silent partial creds)", async () => {
    const result = await resolvePlatformCredentials("ws-1", {
      "slack-chat": {
        provider: "slack",
        config: { app_id: "A1", bot_token: "xoxb-only-token" },
      },
    });
    // Link is unreachable in the test env, so resolver returns empty rather than
    // a half-populated slack credential.
    expect(result).toEqual([]);
  });

  it("slack signal coexists with telegram signal (no cross-provider shadow)", async () => {
    const result = await resolvePlatformCredentials("ws-1", { ...tgSignal, ...slackSignal });
    const kinds = result.map((r) => r.credentials.kind).sort();
    expect(kinds).toEqual(["slack", "telegram"]);
  });

  it("resolves all three when slack + telegram + whatsapp signals coexist", async () => {
    const result = await resolvePlatformCredentials("ws-1", {
      ...tgSignal,
      ...waSignal,
      ...slackSignal,
    });
    const kinds = result.map((r) => r.credentials.kind).sort();
    expect(kinds).toEqual(["slack", "telegram", "whatsapp"]);
  });

  const discordSignal = {
    "discord-chat": { provider: "discord", config: { application_id: "A-discord" } },
  };
  const discordEnvKeys = ["DISCORD_BOT_TOKEN", "DISCORD_PUBLIC_KEY", "DISCORD_APPLICATION_ID"];

  function withDiscordEnv(
    overrides: Partial<Record<(typeof discordEnvKeys)[number], string | undefined>>,
  ): () => void {
    const saved: Record<string, string | undefined> = {};
    for (const key of discordEnvKeys) {
      saved[key] = process.env[key];
      const next = key in overrides ? overrides[key as keyof typeof overrides] : "default";
      if (next === undefined) delete process.env[key];
      else process.env[key] = next;
    }
    return () => {
      for (const key of discordEnvKeys) {
        const original = saved[key];
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
      }
    };
  }

  it("resolves discord when all three env vars are present", async () => {
    const restore = withDiscordEnv({
      DISCORD_BOT_TOKEN: "bot-token-xyz",
      DISCORD_PUBLIC_KEY: "public-key-xyz",
      DISCORD_APPLICATION_ID: "app-123",
    });
    try {
      const result = await resolvePlatformCredentials("ws-1", discordSignal);
      expect(result).toHaveLength(1);
      expect(result[0]?.credentials).toEqual({
        kind: "discord",
        botToken: "bot-token-xyz",
        publicKey: "public-key-xyz",
        applicationId: "app-123",
      });
      expect(result[0]?.credentialId).toBe("discord:app-123");
    } finally {
      restore();
    }
  });

  it.each([
    ["DISCORD_BOT_TOKEN" as const],
    ["DISCORD_PUBLIC_KEY" as const],
    ["DISCORD_APPLICATION_ID" as const],
  ])("returns null when %s is missing (no partial discord creds)", async (missingKey) => {
    const restore = withDiscordEnv({
      DISCORD_BOT_TOKEN: "bot-token-xyz",
      DISCORD_PUBLIC_KEY: "public-key-xyz",
      DISCORD_APPLICATION_ID: "app-123",
      [missingKey]: undefined,
    });
    try {
      const result = await resolvePlatformCredentials("ws-1", discordSignal);
      // No Discord creds, and Link is unreachable in the test env → empty array.
      // Guards against a partial creds object reaching createDiscordAdapter,
      // whose constructor throws ValidationError synchronously and would crash
      // the daemon on workspace init.
      expect(result).toEqual([]);
    } finally {
      restore();
    }
  });

  it("discord signal coexists with telegram signal (no cross-provider shadow)", async () => {
    const restore = withDiscordEnv({
      DISCORD_BOT_TOKEN: "bot-token-xyz",
      DISCORD_PUBLIC_KEY: "public-key-xyz",
      DISCORD_APPLICATION_ID: "app-123",
    });
    try {
      const result = await resolvePlatformCredentials("ws-1", { ...tgSignal, ...discordSignal });
      const kinds = result.map((r) => r.credentials.kind).sort();
      expect(kinds).toEqual(["discord", "telegram"]);
    } finally {
      restore();
    }
  });

  it("slack signal short-circuits the Link service lookup", async () => {
    // If Link were consulted, a reachable (but 404-returning) LINK_SERVICE_URL
    // would log chat_sdk_no_credential_for_workspace. We can't easily assert
    // on that here, so instead assert the resolver succeeds purely from signal
    // data — no network required. The unreachable LINK URL in beforeEach would
    // surface as a thrown error on `!res.ok` if it were actually called.
    const result = await resolvePlatformCredentials("ws-1", slackSignal);
    expect(result).toHaveLength(1);
    expect(result[0]?.credentials.kind).toBe("slack");
  });
});

function makeSilentLogger(): Logger {
  const noop = vi.fn();
  const logger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
}

type GatewayStub = ReturnType<typeof vi.fn<DiscordAdapter["startGatewayListener"]>>;

function makeFakeDiscordAdapter(startGatewayListener: GatewayStub): DiscordAdapter {
  const proto = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
  Object.defineProperty(proto, "startGatewayListener", {
    value: startGatewayListener,
    writable: true,
    configurable: true,
  });
  return proto;
}

describe("superviseDiscordGateway", () => {
  it("respawns after a clean listener exit", async () => {
    let calls = 0;
    // Two runs: first resolves quickly (duration elapsed), second blocks
    // until aborted — proves the supervisor re-invoked startGatewayListener
    // after the first listener settled cleanly.
    const start = vi.fn(
      // deno-lint-ignore require-await
      async (
        options: WebhookOptions,
        _duration?: number,
        abortSignal?: AbortSignal,
      ): Promise<Response> => {
        if (!options.waitUntil) throw new Error("test requires waitUntil");
        const n = ++calls;
        if (n === 1) {
          options.waitUntil(Promise.resolve());
        } else {
          options.waitUntil(
            new Promise<void>((resolve) => {
              abortSignal?.addEventListener("abort", () => resolve(), { once: true });
            }),
          );
        }
        return new Response();
      },
    );
    const adapter = makeFakeDiscordAdapter(start);

    const supervisor = superviseDiscordGateway(adapter, makeSilentLogger());
    // Let the microtask queue drain enough for the second iteration to start.
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    await supervisor.stop();
  });

  it("stops on auth error without retrying", async () => {
    // deno-lint-ignore require-await
    const start = vi.fn(async (): Promise<Response> => {
      throw new Error("An invalid token was provided.");
    });
    const adapter = makeFakeDiscordAdapter(start);

    const logger = makeSilentLogger();
    const errorSpy = vi.spyOn(logger, "error");
    const supervisor = superviseDiscordGateway(adapter, logger);
    await supervisor.stop();

    // Exactly one attempt; no 30s retry wait was triggered.
    expect(start).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "discord_gateway_auth_failed",
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it("treats structured DiscordAPIError (code=TokenInvalid, status=401) as auth error", async () => {
    // Mimic the shape discord.js / @discordjs/rest throws — message text
    // alone won't always include "invalid token", so the supervisor also
    // inspects `.code` / `.status` to recognize auth failures and avoid
    // retrying with a bad token.
    // deno-lint-ignore require-await
    const start = vi.fn(async (): Promise<Response> => {
      const err: Error & { code?: string; status?: number } = new Error(
        "Discord API error",
      );
      err.code = "TokenInvalid";
      err.status = 401;
      throw err;
    });
    const adapter = makeFakeDiscordAdapter(start);

    const supervisor = superviseDiscordGateway(adapter, makeSilentLogger());
    await supervisor.stop();

    expect(start).toHaveBeenCalledTimes(1);
  });

  it("stop() aborts mid-run and waits for the in-flight listener to settle", async () => {
    let settled = false;
    const start = vi.fn(
      // deno-lint-ignore require-await
      async (
        options: WebhookOptions,
        _duration?: number,
        abortSignal?: AbortSignal,
      ): Promise<Response> => {
        if (!options.waitUntil) throw new Error("test requires waitUntil");
        options.waitUntil(
          new Promise<void>((resolve) => {
            abortSignal?.addEventListener(
              "abort",
              () => {
                // Simulate adapter teardown work after the abort — stop()
                // must wait for this to finish, not return on .abort().
                setTimeout(() => {
                  settled = true;
                  resolve();
                }, 20);
              },
              { once: true },
            );
          }),
        );
        return new Response();
      },
    );
    const adapter = makeFakeDiscordAdapter(start);
    const supervisor = superviseDiscordGateway(adapter, makeSilentLogger());
    // Ensure startGatewayListener has been invoked before we stop.
    await vi.waitFor(() => expect(start).toHaveBeenCalled());

    await supervisor.stop();
    expect(settled).toBe(true);
  });

  it("does not respawn the listener when abort fires during the 30s retry backoff", async () => {
    // Non-auth throw → supervisor enters cancellableSleep. If that sleep
    // ignored the abort signal, stop() would have to wait ~30s AND a second
    // listener would spawn after. Assert: exactly one call and fast stop.
    // deno-lint-ignore require-await
    const start = vi.fn(async (): Promise<Response> => {
      throw new Error("transient websocket failure");
    });
    const adapter = makeFakeDiscordAdapter(start);
    const supervisor = superviseDiscordGateway(adapter, makeSilentLogger());

    // Wait for the (rejected) first call to complete and the supervisor to
    // enter its backoff sleep.
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    const stopStart = Date.now();
    await supervisor.stop();
    const stopElapsed = Date.now() - stopStart;

    // Cancellable sleep should release immediately on abort; we give plenty
    // of headroom for slow CI. A non-cancellable setTimeout would block ~30s.
    expect(stopElapsed).toBeLessThan(1000);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("initializeChatSdkInstance — Discord Gateway wiring", () => {
  const discordEnvKeys = ["DISCORD_BOT_TOKEN", "DISCORD_PUBLIC_KEY", "DISCORD_APPLICATION_ID"];
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of discordEnvKeys) {
      originalEnv[key] = process.env[key];
    }
  });
  afterAll(() => {
    for (const key of discordEnvKeys) {
      const original = originalEnv[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  function makeInstanceConfig() {
    return {
      workspaceId: "ws-discord-gw",
      userId: "u-1",
      streamRegistry: new StreamRegistry(),
      triggerFn: makeTriggerFn([]),
    };
  }

  it("does NOT start the supervisor when no Discord adapter is present", async () => {
    const startSpy = vi.spyOn(DiscordAdapter.prototype, "startGatewayListener");
    try {
      const instance = await initializeChatSdkInstance(makeInstanceConfig());
      await instance.teardown();
      expect(startSpy).not.toHaveBeenCalled();
    } finally {
      startSpy.mockRestore();
    }
  });

  it("awaits chat.initialize() BEFORE the first startGatewayListener call", async () => {
    process.env.DISCORD_BOT_TOKEN = "t";
    process.env.DISCORD_PUBLIC_KEY = "a".repeat(64);
    process.env.DISCORD_APPLICATION_ID = "app";

    // Stub startGatewayListener to hold open until abort — we only care about
    // the call-order invariant here, not about running multiple iterations.
    const startSpy = vi
      .spyOn(DiscordAdapter.prototype, "startGatewayListener")
      // deno-lint-ignore require-await
      .mockImplementation(async function (
        this: DiscordAdapter,
        options: WebhookOptions,
        _duration?: number,
        abortSignal?: AbortSignal,
      ): Promise<Response> {
        // Assert: by the time the adapter sees a call, chat.initialize() must
        // have run. The adapter's internal `chat` property is set by
        // `adapter.initialize(chat)` inside `Chat.ensureInitialized`. If the
        // caller skipped `chat.initialize()`, this field would still be null
        // and the real adapter would short-circuit with HTTP 500.
        expect((this as unknown as { chat: unknown }).chat).not.toBeNull();
        options.waitUntil?.(
          new Promise<void>((resolve) => {
            abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          }),
        );
        return new Response();
      });

    try {
      const instance = await initializeChatSdkInstance(
        {
          ...makeInstanceConfig(),
          signals: { "discord-chat": { provider: "discord", config: {} } },
        },
        {
          kind: "discord",
          botToken: "t",
          publicKey: "a".repeat(64),
          applicationId: "app",
        },
      );
      await vi.waitFor(() => expect(startSpy).toHaveBeenCalled());
      await instance.teardown();
    } finally {
      startSpy.mockRestore();
    }
  });
});

describe("initializeChatSdkInstance — releasePreventIdle wiring", () => {
  it("invokes releasePreventIdle on teardown with the workspace id", async () => {
    const release = vi.fn<(id: string) => void>();
    const instance = await initializeChatSdkInstance({
      workspaceId: "ws-release-happy",
      userId: "u-1",
      streamRegistry: new StreamRegistry(),
      triggerFn: makeTriggerFn([]),
      releasePreventIdle: release,
    });

    await instance.teardown();

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("ws-release-happy");
  });

  it("still invokes releasePreventIdle when chat.shutdown() throws", async () => {
    const release = vi.fn<(id: string) => void>();
    const instance = await initializeChatSdkInstance({
      workspaceId: "ws-release-shutdown-throws",
      userId: "u-1",
      streamRegistry: new StreamRegistry(),
      triggerFn: makeTriggerFn([]),
      releasePreventIdle: release,
    });

    // Force chat.shutdown to throw AFTER the inner catch would normally
    // swallow it. Replacing the method with one that throws synchronously
    // proves the outer finally still fires. The existing inner catch logs
    // and swallows, but we also verify defense-in-depth here: if a future
    // change removes the inner catch, the pin must still be released.
    const shutdownSpy = vi
      .spyOn(instance.chat, "shutdown")
      // deno-lint-ignore require-await
      .mockImplementation(async () => {
        throw new Error("boom from chat.shutdown");
      });

    try {
      await instance.teardown();
    } finally {
      shutdownSpy.mockRestore();
    }

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("ws-release-shutdown-throws");
  });
});
