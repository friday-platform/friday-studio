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
import type { Message, Thread } from "chat";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KERNEL_WORKSPACE_ID } from "../factory.ts";
import { StreamRegistry } from "../stream-registry.ts";
import {
  createMessageHandler,
  initializeChatSdkInstance,
  resolvePlatformCredentials,
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
      undefined,
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
      undefined,
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
      undefined,
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
      undefined,
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
      config: { app_id: "A123", bot_token: "xoxb-byo-token", signing_secret: "byo-signing-secret" },
    },
  };

  it("resolves telegram when only telegram signal is wired", async () => {
    const result = await resolvePlatformCredentials("ws-1", "user-1", tgSignal);
    expect(result).toHaveLength(1);
    expect(result[0]?.credentials.kind).toBe("telegram");
    expect(result[0]?.credentialId).toBe("telegram:111");
  });

  it("resolves whatsapp when only whatsapp signal is wired", async () => {
    const result = await resolvePlatformCredentials("ws-1", "user-1", waSignal);
    expect(result).toHaveLength(1);
    expect(result[0]?.credentials.kind).toBe("whatsapp");
  });

  it("resolves BOTH when telegram + whatsapp signals coexist", async () => {
    const result = await resolvePlatformCredentials("ws-1", "user-1", { ...tgSignal, ...waSignal });
    const kinds = result.map((r) => r.credentials.kind).sort();
    expect(kinds).toEqual(["telegram", "whatsapp"]);
  });

  it("resolves empty array when no signals and Slack lookup fails", async () => {
    const result = await resolvePlatformCredentials("ws-1", "user-1", {});
    expect(result).toEqual([]);
  });

  it("does NOT mutate signal config during resolution", async () => {
    // Guards against regressions to the old bot_token_suffix stash side-effect
    // that coupled credential resolution to route-lookup ordering.
    const signals = { ...tgSignal };
    const before = JSON.stringify(signals);
    await resolvePlatformCredentials("ws-1", "user-1", signals);
    expect(JSON.stringify(signals)).toBe(before);
  });

  it("falls back to env vars when signal config is empty", async () => {
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "222:env-secret";
    try {
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "telegram-chat": { provider: "telegram", config: {} },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentialId).toBe("telegram:222");
    } finally {
      if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    }
  });

  it("Link wiring wins over yml inline config for telegram", async () => {
    // Stub LINK_SERVICE_URL to a reachable host that the mocked fetch handles.
    process.env.LINK_SERVICE_URL = "http://link.test";
    const fetchStub = vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/internal/v1/communicator/wiring")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ wiring: { credential_id: "cred-link", connection_id: "tg-conn" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (url.includes("/internal/v1/credentials/cred-link")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              credential: {
                id: "cred-link",
                type: "apikey",
                provider: "telegram",
                userIdentifier: "user-1",
                label: "tg",
                secret: { bot_token: "777:link-token", webhook_secret: "ws-secret" },
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
    try {
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "telegram-chat": { provider: "telegram", config: { bot_token: "111:yml-token" } },
      });
      expect(result).toHaveLength(1);
      const cred = result[0];
      expect(cred?.credentials.kind).toBe("telegram");
      if (cred?.credentials.kind === "telegram") {
        expect(cred.credentials.botToken).toBe("777:link-token");
        expect(cred.credentials.secretToken).toBe("ws-secret");
      }
      expect(cred?.credentialId).toBe("cred-link");
    } finally {
      vi.unstubAllGlobals();
      process.env.LINK_SERVICE_URL = "http://127.0.0.1:1";
    }
  });

  it("resolves slack from BYO signal config", async () => {
    const result = await resolvePlatformCredentials("ws-1", "user-1", slackSignal);
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
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
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
    const result = await resolvePlatformCredentials("ws-1", "user-1", {
      "slack-chat": { provider: "slack", config: { app_id: "A1", bot_token: "xoxb-only-token" } },
    });
    // Link is unreachable in the test env, so resolver returns empty rather than
    // a half-populated slack credential.
    expect(result).toEqual([]);
  });

  it("slack signal coexists with telegram signal (no cross-provider shadow)", async () => {
    const result = await resolvePlatformCredentials("ws-1", "user-1", {
      ...tgSignal,
      ...slackSignal,
    });
    const kinds = result.map((r) => r.credentials.kind).sort();
    expect(kinds).toEqual(["slack", "telegram"]);
  });

  it("resolves all three when slack + telegram + whatsapp signals coexist", async () => {
    const result = await resolvePlatformCredentials("ws-1", "user-1", {
      ...tgSignal,
      ...waSignal,
      ...slackSignal,
    });
    const kinds = result.map((r) => r.credentials.kind).sort();
    expect(kinds).toEqual(["slack", "telegram", "whatsapp"]);
  });

  /**
   * Save env values for `keys`, apply `overrides`, and return a restore fn.
   * Keys not named in `overrides` are cleared (deleted) for the test duration
   * so env-fallback paths see a clean slate.
   */
  function withEnv<K extends string>(
    keys: readonly K[],
    overrides: Partial<Record<K, string | undefined>>,
  ): () => void {
    const saved: Record<string, string | undefined> = {};
    for (const key of keys) {
      saved[key] = process.env[key];
      if (key in overrides) {
        const next = overrides[key];
        if (next === undefined) delete process.env[key];
        else process.env[key] = next;
      } else {
        delete process.env[key];
      }
    }
    return () => {
      for (const key of keys) {
        const original = saved[key];
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
      }
    };
  }

  const discordSignal = { "discord-chat": { provider: "discord", config: {} } };
  const discordEnvKeys = [
    "DISCORD_BOT_TOKEN",
    "DISCORD_PUBLIC_KEY",
    "DISCORD_APPLICATION_ID",
  ] as const;

  it("resolves discord when all three env vars are present", async () => {
    const restore = withEnv(discordEnvKeys, {
      DISCORD_BOT_TOKEN: "bot-token-xyz",
      DISCORD_PUBLIC_KEY: "public-key-xyz",
      DISCORD_APPLICATION_ID: "app-123",
    });
    try {
      const result = await resolvePlatformCredentials("ws-1", "user-1", discordSignal);
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

  it("resolves discord entirely from signal config with env empty", async () => {
    const restore = withEnv(discordEnvKeys, {
      DISCORD_BOT_TOKEN: undefined,
      DISCORD_PUBLIC_KEY: undefined,
      DISCORD_APPLICATION_ID: undefined,
    });
    try {
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "discord-chat": {
          provider: "discord",
          config: { bot_token: "cfg-bot", public_key: "cfg-pub", application_id: "cfg-app" },
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentials).toEqual({
        kind: "discord",
        botToken: "cfg-bot",
        publicKey: "cfg-pub",
        applicationId: "cfg-app",
      });
      expect(result[0]?.credentialId).toBe("discord:cfg-app");
    } finally {
      restore();
    }
  });

  it("returns null when only bot_token is in config and env is empty (all-or-nothing)", async () => {
    const restore = withEnv(discordEnvKeys, {
      DISCORD_BOT_TOKEN: undefined,
      DISCORD_PUBLIC_KEY: undefined,
      DISCORD_APPLICATION_ID: undefined,
    });
    try {
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "discord-chat": { provider: "discord", config: { bot_token: "only-this" } },
      });
      expect(result).toEqual([]);
    } finally {
      restore();
    }
  });

  it("resolves discord from mixed config + env (per-field fallback)", async () => {
    const restore = withEnv(discordEnvKeys, {
      DISCORD_BOT_TOKEN: undefined,
      DISCORD_PUBLIC_KEY: "env-pub",
      DISCORD_APPLICATION_ID: undefined,
    });
    try {
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "discord-chat": {
          provider: "discord",
          config: { bot_token: "cfg-bot", application_id: "cfg-app" },
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentials).toEqual({
        kind: "discord",
        botToken: "cfg-bot",
        publicKey: "env-pub",
        applicationId: "cfg-app",
      });
    } finally {
      restore();
    }
  });

  it("config wins over env when both are set", async () => {
    const restore = withEnv(discordEnvKeys, {
      DISCORD_BOT_TOKEN: "env-bot",
      DISCORD_PUBLIC_KEY: "env-pub",
      DISCORD_APPLICATION_ID: "env-app",
    });
    try {
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "discord-chat": {
          provider: "discord",
          config: { bot_token: "cfg-bot", public_key: "cfg-pub", application_id: "cfg-app" },
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentials).toEqual({
        kind: "discord",
        botToken: "cfg-bot",
        publicKey: "cfg-pub",
        applicationId: "cfg-app",
      });
    } finally {
      restore();
    }
  });

  it.each([
    ["DISCORD_BOT_TOKEN" as const],
    ["DISCORD_PUBLIC_KEY" as const],
    ["DISCORD_APPLICATION_ID" as const],
  ])("returns null when %s is missing (no partial discord creds)", async (missingKey) => {
    const restore = withEnv(discordEnvKeys, {
      DISCORD_BOT_TOKEN: "bot-token-xyz",
      DISCORD_PUBLIC_KEY: "public-key-xyz",
      DISCORD_APPLICATION_ID: "app-123",
      [missingKey]: undefined,
    });
    try {
      const result = await resolvePlatformCredentials("ws-1", "user-1", discordSignal);
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
    const restore = withEnv(discordEnvKeys, {
      DISCORD_BOT_TOKEN: "bot-token-xyz",
      DISCORD_PUBLIC_KEY: "public-key-xyz",
      DISCORD_APPLICATION_ID: "app-123",
    });
    try {
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        ...tgSignal,
        ...discordSignal,
      });
      const kinds = result.map((r) => r.credentials.kind).sort();
      expect(kinds).toEqual(["discord", "telegram"]);
    } finally {
      restore();
    }
  });

  const teamsEnvKeys = [
    "TEAMS_APP_ID",
    "TEAMS_APP_PASSWORD",
    "TEAMS_APP_TENANT_ID",
    "TEAMS_APP_TYPE",
  ] as const;

  it("resolves teams from signal config (all four fields inline)", async () => {
    const restore = withEnv(teamsEnvKeys, {});
    try {
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "teams-chat": {
          provider: "teams",
          config: {
            app_id: "sig-app-id",
            app_password: "sig-password",
            app_tenant_id: "sig-tenant",
            app_type: "SingleTenant",
          },
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentials).toEqual({
        kind: "teams",
        appId: "sig-app-id",
        appPassword: "sig-password",
        appTenantId: "sig-tenant",
        appType: "SingleTenant",
      });
      expect(result[0]?.credentialId).toBe("teams:sig-app-id");
    } finally {
      restore();
    }
  });

  it("falls back to TEAMS_* env vars when signal config is empty", async () => {
    const restore = withEnv(teamsEnvKeys, {
      TEAMS_APP_ID: "env-app-id",
      TEAMS_APP_PASSWORD: "env-password",
      TEAMS_APP_TENANT_ID: "env-tenant",
    });
    try {
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "teams-chat": { provider: "teams", config: {} },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentials).toEqual({
        kind: "teams",
        appId: "env-app-id",
        appPassword: "env-password",
        appTenantId: "env-tenant",
      });
      expect(result[0]?.credentialId).toBe("teams:env-app-id");
    } finally {
      restore();
    }
  });

  it("returns null when app_id is missing (neither signal nor env)", async () => {
    const restore = withEnv(teamsEnvKeys, { TEAMS_APP_PASSWORD: "env-password" });
    try {
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "teams-chat": { provider: "teams", config: {} },
      });
      expect(result).toEqual([]);
    } finally {
      restore();
    }
  });

  it("returns null when app_password is missing (neither signal nor env)", async () => {
    const restore = withEnv(teamsEnvKeys, { TEAMS_APP_ID: "env-app-id" });
    try {
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "teams-chat": { provider: "teams", config: {} },
      });
      expect(result).toEqual([]);
    } finally {
      restore();
    }
  });

  it("returns null on SingleTenant with no tenant_id (signal + env both empty)", async () => {
    // Guards the fail-fast: a SingleTenant app without app_tenant_id passed to
    // the adapter would start up but every outbound call would 401 at Azure —
    // much noisier than refusing to construct the adapter at all.
    const restore = withEnv(teamsEnvKeys, {
      TEAMS_APP_ID: "env-app-id",
      TEAMS_APP_PASSWORD: "env-password",
    });
    try {
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "teams-chat": { provider: "teams", config: { app_type: "SingleTenant" } },
      });
      expect(result).toEqual([]);
    } finally {
      restore();
    }
  });

  it("resolves MultiTenant without tenant_id", async () => {
    const restore = withEnv(teamsEnvKeys, {
      TEAMS_APP_ID: "env-app-id",
      TEAMS_APP_PASSWORD: "env-password",
    });
    try {
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "teams-chat": { provider: "teams", config: { app_type: "MultiTenant" } },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentials).toEqual({
        kind: "teams",
        appId: "env-app-id",
        appPassword: "env-password",
        appType: "MultiTenant",
      });
    } finally {
      restore();
    }
  });

  it("honors TEAMS_APP_TYPE env fallback (SingleTenant via env only)", async () => {
    // Env-only SingleTenant bots: without this fallback, appType silently
    // defaulted to MultiTenant and JWT validation hit the wrong issuer.
    const restore = withEnv(teamsEnvKeys, {
      TEAMS_APP_ID: "env-app-id",
      TEAMS_APP_PASSWORD: "env-password",
      TEAMS_APP_TENANT_ID: "env-tenant",
      TEAMS_APP_TYPE: "SingleTenant",
    });
    try {
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "teams-chat": { provider: "teams", config: {} },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentials).toEqual({
        kind: "teams",
        appId: "env-app-id",
        appPassword: "env-password",
        appTenantId: "env-tenant",
        appType: "SingleTenant",
      });
    } finally {
      restore();
    }
  });

  it("signal app_type wins over TEAMS_APP_TYPE env", async () => {
    const restore = withEnv(teamsEnvKeys, {
      TEAMS_APP_ID: "env-app-id",
      TEAMS_APP_PASSWORD: "env-password",
      TEAMS_APP_TYPE: "MultiTenant",
    });
    try {
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "teams-chat": {
          provider: "teams",
          config: { app_type: "SingleTenant", app_tenant_id: "sig-tenant" },
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentials).toMatchObject({
        kind: "teams",
        appType: "SingleTenant",
        appTenantId: "sig-tenant",
      });
    } finally {
      restore();
    }
  });

  it("ignores invalid TEAMS_APP_TYPE env value", async () => {
    // Malformed env var should not poison the config. Falls through to
    // undefined (the MultiTenant default inside the adapter).
    const restore = withEnv(teamsEnvKeys, {
      TEAMS_APP_ID: "env-app-id",
      TEAMS_APP_PASSWORD: "env-password",
      TEAMS_APP_TYPE: "typo",
    });
    try {
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "teams-chat": { provider: "teams", config: {} },
      });
      expect(result).toHaveLength(1);
      const creds = result[0]?.credentials;
      expect(creds).toMatchObject({ kind: "teams", appId: "env-app-id" });
      expect(creds && "appType" in creds ? creds.appType : undefined).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("teams + slack signals coexist (no cross-provider shadow)", async () => {
    const restore = withEnv(teamsEnvKeys, {
      TEAMS_APP_ID: "env-app-id",
      TEAMS_APP_PASSWORD: "env-password",
    });
    try {
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        ...slackSignal,
        "teams-chat": { provider: "teams", config: {} },
      });
      const kinds = result.map((r) => r.credentials.kind).sort();
      expect(kinds).toEqual(["slack", "teams"]);
    } finally {
      restore();
    }
  });

  describe("communicators map", () => {
    it("resolves telegram when only declared in communicators (no signal)", async () => {
      const result = await resolvePlatformCredentials(
        "ws-1",
        "user-1",
        {},
        { ops: { kind: "telegram", bot_token: "555:top-token" } },
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.credentials.kind).toBe("telegram");
      expect(result[0]?.credentialId).toBe("telegram:555");
    });

    it("communicators wins when both communicators and signal declare the same kind", async () => {
      const result = await resolvePlatformCredentials(
        "ws-1",
        "user-1",
        { "telegram-chat": { provider: "telegram", config: { bot_token: "111:signal" } } },
        { ops: { kind: "telegram", bot_token: "999:top" } },
      );
      expect(result).toHaveLength(1);
      // Top-level config drives credentials — signal-side bot_token is ignored.
      expect(result[0]?.credentialId).toBe("telegram:999");
    });

    it("falls back to signal when kind is absent from communicators", async () => {
      const result = await resolvePlatformCredentials(
        "ws-1",
        "user-1",
        { "telegram-chat": { provider: "telegram", config: { bot_token: "111:signal" } } },
        {
          ops: {
            kind: "whatsapp",
            access_token: "tok",
            app_secret: "sec",
            phone_number_id: "1",
            verify_token: "v",
          },
        },
      );
      const kinds = result.map((r) => r.credentials.kind).sort();
      expect(kinds).toEqual(["telegram", "whatsapp"]);
      const telegram = result.find((r) => r.credentials.kind === "telegram");
      expect(telegram?.credentialId).toBe("telegram:111");
    });

    it("resolves multiple kinds from a single communicators map", async () => {
      const result = await resolvePlatformCredentials(
        "ws-1",
        "user-1",
        {},
        {
          ops_telegram: { kind: "telegram", bot_token: "111:tg" },
          ops_slack: { kind: "slack", bot_token: "xoxb-top", signing_secret: "ss", app_id: "A1" },
        },
      );
      const kinds = result.map((r) => r.credentials.kind).sort();
      expect(kinds).toEqual(["slack", "telegram"]);
    });

    it("resolves slack from communicators map (skips Link fallback when inline succeeds)", async () => {
      const result = await resolvePlatformCredentials(
        "ws-1",
        "user-1",
        {},
        {
          ops: {
            kind: "slack",
            bot_token: "xoxb-top",
            signing_secret: "top-secret",
            app_id: "A-TOP",
          },
        },
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.credentials).toEqual({
        kind: "slack",
        botToken: "xoxb-top",
        signingSecret: "top-secret",
        appId: "A-TOP",
      });
    });

    it("returns empty when communicators is undefined and signals empty", async () => {
      const result = await resolvePlatformCredentials("ws-1", "user-1", {}, undefined);
      expect(result).toEqual([]);
    });

    it("merges per-field: communicators inline + env fallback", async () => {
      const restore = withEnv(discordEnvKeys, {
        DISCORD_BOT_TOKEN: "env-bot",
        DISCORD_PUBLIC_KEY: "env-pub",
        DISCORD_APPLICATION_ID: "env-app",
      });
      try {
        const result = await resolvePlatformCredentials(
          "ws-1",
          "user-1",
          {},
          { ops: { kind: "discord", application_id: "top-app" } },
        );
        expect(result).toHaveLength(1);
        // bot_token + public_key from env, application_id from communicators.
        expect(result[0]?.credentials).toEqual({
          kind: "discord",
          botToken: "env-bot",
          publicKey: "env-pub",
          applicationId: "top-app",
        });
      } finally {
        restore();
      }
    });

    it("does not consult Link when slack is declared in neither communicators nor signals", async () => {
      // Signals empty, communicators absent → no slack declaration at all.
      // Resolver must skip Link entirely; otherwise the unreachable LINK_SERVICE_URL
      // would cause the fetch path to run (debug-logged, but unnecessary).
      const result = await resolvePlatformCredentials("ws-1", "user-1", {}, undefined);
      expect(result).toEqual([]);
    });
  });

  /**
   * Link-first credential resolution for the apikey communicators (Discord,
   * Teams, WhatsApp). Mirrors Jinju's Telegram tests: success case proves Link
   * wins over yml inline; wiring-not-found and fetch-error cases prove fallback
   * to legacy yml/env paths still works.
   */
  describe("link-first apikey communicators", () => {
    /**
     * Stub `fetch` so `findCommunicatorWiring` returns the given wiring tuple
     * and `fetchLinkCredential` returns a credential with the given secret.
     * Returns the spy so callers can assert call counts. Setting `fetchThrows`
     * to true makes the credential fetch throw (simulating Link 5xx).
     */
    function stubLinkFetches(opts: {
      provider: string;
      wiring: { credential_id: string; connection_id: string | null } | null;
      secret?: Record<string, unknown>;
      fetchThrows?: boolean;
    }): ReturnType<typeof vi.fn> {
      process.env.LINK_SERVICE_URL = "http://link.test";
      const fetchStub = vi.fn((input: string | URL | Request): Promise<Response> => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/internal/v1/communicator/wiring")) {
          if (!url.includes(`provider=${opts.provider}`)) {
            return Promise.resolve(
              new Response(JSON.stringify({ wiring: null }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }
          return Promise.resolve(
            new Response(JSON.stringify({ wiring: opts.wiring }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if (opts.wiring && url.includes(`/internal/v1/credentials/${opts.wiring.credential_id}`)) {
          if (opts.fetchThrows) {
            return Promise.reject(new Error("Link credential fetch failed"));
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                credential: {
                  id: opts.wiring.credential_id,
                  type: "apikey",
                  provider: opts.provider,
                  userIdentifier: "user-1",
                  label: opts.provider,
                  secret: opts.secret ?? {},
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
      return fetchStub;
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      process.env.LINK_SERVICE_URL = "http://127.0.0.1:1";
    });

    // ─── Discord ────────────────────────────────────────────────────────────
    it("Link wiring wins over yml inline config for discord", async () => {
      stubLinkFetches({
        provider: "discord",
        wiring: { credential_id: "cred-disc", connection_id: "app-link" },
        secret: { bot_token: "link-bot", public_key: "link-pub", application_id: "app-link" },
      });
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "discord-chat": {
          provider: "discord",
          config: { bot_token: "yml-bot", public_key: "yml-pub", application_id: "yml-app" },
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentials).toEqual({
        kind: "discord",
        botToken: "link-bot",
        publicKey: "link-pub",
        applicationId: "app-link",
      });
      expect(result[0]?.credentialId).toBe("cred-disc");
    });

    it("discord: wiring-not-found falls through to yml inline config", async () => {
      stubLinkFetches({ provider: "discord", wiring: null });
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "discord-chat": {
          provider: "discord",
          config: { bot_token: "yml-bot", public_key: "yml-pub", application_id: "yml-app" },
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentials).toEqual({
        kind: "discord",
        botToken: "yml-bot",
        publicKey: "yml-pub",
        applicationId: "yml-app",
      });
      expect(result[0]?.credentialId).toBe("discord:yml-app");
    });

    it("discord: Link credential fetch error falls through to yml inline config", async () => {
      stubLinkFetches({
        provider: "discord",
        wiring: { credential_id: "cred-disc", connection_id: "app-link" },
        fetchThrows: true,
      });
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "discord-chat": {
          provider: "discord",
          config: { bot_token: "yml-bot", public_key: "yml-pub", application_id: "yml-app" },
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentialId).toBe("discord:yml-app");
    });

    // ─── Teams ──────────────────────────────────────────────────────────────
    it("Link wiring wins over yml inline config for teams", async () => {
      stubLinkFetches({
        provider: "teams",
        wiring: { credential_id: "cred-teams", connection_id: "app-link" },
        secret: {
          app_id: "link-app",
          app_password: "link-pw",
          app_tenant_id: "link-tenant",
          app_type: "SingleTenant",
        },
      });
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "teams-chat": {
          provider: "teams",
          config: {
            app_id: "yml-app",
            app_password: "yml-pw",
            app_tenant_id: "yml-tenant",
            app_type: "MultiTenant",
          },
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentials).toEqual({
        kind: "teams",
        appId: "link-app",
        appPassword: "link-pw",
        appTenantId: "link-tenant",
        appType: "SingleTenant",
      });
      expect(result[0]?.credentialId).toBe("cred-teams");
    });

    it("teams: wiring-not-found falls through to yml inline config", async () => {
      stubLinkFetches({ provider: "teams", wiring: null });
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "teams-chat": {
          provider: "teams",
          config: {
            app_id: "yml-app",
            app_password: "yml-pw",
            app_tenant_id: "yml-tenant",
            app_type: "SingleTenant",
          },
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentials).toEqual({
        kind: "teams",
        appId: "yml-app",
        appPassword: "yml-pw",
        appTenantId: "yml-tenant",
        appType: "SingleTenant",
      });
      expect(result[0]?.credentialId).toBe("teams:yml-app");
    });

    it("teams: Link credential fetch error falls through to yml inline config", async () => {
      stubLinkFetches({
        provider: "teams",
        wiring: { credential_id: "cred-teams", connection_id: "app-link" },
        fetchThrows: true,
      });
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "teams-chat": {
          provider: "teams",
          config: {
            app_id: "yml-app",
            app_password: "yml-pw",
            app_tenant_id: "yml-tenant",
            app_type: "MultiTenant",
          },
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentialId).toBe("teams:yml-app");
    });

    // ─── WhatsApp ───────────────────────────────────────────────────────────
    it("Link wiring wins over yml inline config for whatsapp", async () => {
      stubLinkFetches({
        provider: "whatsapp",
        wiring: { credential_id: "cred-wa", connection_id: "111" },
        secret: {
          access_token: "link-tok",
          app_secret: "link-sec",
          phone_number_id: "111",
          verify_token: "link-verify",
        },
      });
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "whatsapp-chat": {
          provider: "whatsapp",
          config: {
            access_token: "yml-tok",
            app_secret: "yml-sec",
            phone_number_id: "999",
            verify_token: "yml-verify",
          },
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentials).toEqual({
        kind: "whatsapp",
        accessToken: "link-tok",
        appSecret: "link-sec",
        phoneNumberId: "111",
        verifyToken: "link-verify",
      });
      expect(result[0]?.credentialId).toBe("cred-wa");
    });

    it("whatsapp: wiring-not-found falls through to yml inline config", async () => {
      stubLinkFetches({ provider: "whatsapp", wiring: null });
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "whatsapp-chat": {
          provider: "whatsapp",
          config: {
            access_token: "yml-tok",
            app_secret: "yml-sec",
            phone_number_id: "999",
            verify_token: "yml-verify",
          },
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentials).toEqual({
        kind: "whatsapp",
        accessToken: "yml-tok",
        appSecret: "yml-sec",
        phoneNumberId: "999",
        verifyToken: "yml-verify",
      });
      expect(result[0]?.credentialId).toBe("whatsapp:999");
    });

    it("whatsapp: Link credential fetch error falls through to yml inline config", async () => {
      stubLinkFetches({
        provider: "whatsapp",
        wiring: { credential_id: "cred-wa", connection_id: "111" },
        fetchThrows: true,
      });
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "whatsapp-chat": {
          provider: "whatsapp",
          config: {
            access_token: "yml-tok",
            app_secret: "yml-sec",
            phone_number_id: "999",
            verify_token: "yml-verify",
          },
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentialId).toBe("whatsapp:999");
    });

    // ─── Slack ──────────────────────────────────────────────────────────────
    it("Link wiring wins over yml inline config for slack", async () => {
      stubLinkFetches({
        provider: "slack",
        wiring: { credential_id: "cred-slack", connection_id: "ALINK" },
        secret: { bot_token: "xoxb-link-token", signing_secret: "link-signing", app_id: "ALINK" },
      });
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "slack-chat": {
          provider: "slack",
          config: { bot_token: "xoxb-yml-token", signing_secret: "yml-signing", app_id: "AYML" },
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentials).toEqual({
        kind: "slack",
        botToken: "xoxb-link-token",
        signingSecret: "link-signing",
        appId: "ALINK",
      });
      expect(result[0]?.credentialId).toBe("cred-slack");
    });

    it("slack: wiring-not-found falls through to yml inline config", async () => {
      stubLinkFetches({ provider: "slack", wiring: null });
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "slack-chat": {
          provider: "slack",
          config: { bot_token: "xoxb-yml-token", signing_secret: "yml-signing", app_id: "AYML" },
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentials).toEqual({
        kind: "slack",
        botToken: "xoxb-yml-token",
        signingSecret: "yml-signing",
        appId: "AYML",
      });
      expect(result[0]?.credentialId).toBe("slack:AYML");
    });

    it("slack: Link credential fetch error falls through to yml inline config", async () => {
      stubLinkFetches({
        provider: "slack",
        wiring: { credential_id: "cred-slack", connection_id: "ALINK" },
        fetchThrows: true,
      });
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "slack-chat": {
          provider: "slack",
          config: { bot_token: "xoxb-yml-token", signing_secret: "yml-signing", app_id: "AYML" },
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentialId).toBe("slack:AYML");
    });

    it("slack: invalid Link secret falls through to yml inline config", async () => {
      stubLinkFetches({
        provider: "slack",
        wiring: { credential_id: "cred-slack", connection_id: "ALINK" },
        // Missing signing_secret — fails SlackLinkSecretSchema, should fall through.
        secret: { bot_token: "xoxb-link-token", app_id: "ALINK" },
      });
      const result = await resolvePlatformCredentials("ws-1", "user-1", {
        "slack-chat": {
          provider: "slack",
          config: { bot_token: "xoxb-yml-token", signing_secret: "yml-signing", app_id: "AYML" },
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.credentialId).toBe("slack:AYML");
    });
  });
});

describe("initializeChatSdkInstance — notifier wiring", () => {
  const triggerFn = vi.fn(() => Promise.resolve({ sessionId: "sess-1" }));

  it("exposes a notifier whose list() excludes the AtlasWebAdapter stub", async () => {
    const instance = await initializeChatSdkInstance(
      {
        workspaceId: "ws-notif-1",
        userId: "user-1",
        signals: { "telegram-chat": { provider: "telegram", config: {} } },
        streamRegistry: new StreamRegistry(),
        triggerFn,
      },
      { kind: "telegram", botToken: "111:test", secretToken: "wh", appId: "111" },
    );

    try {
      // Adapter map contains both atlas (always) and telegram (from creds).
      // Notifier filters atlas via outboundDeliverable: false marker.
      expect(instance.notifier.list()).toEqual([{ name: "telegram", kind: "telegram" }]);
    } finally {
      await instance.teardown();
    }
  });

  it("notifier and chat dispatch through the SAME adapter instance for the same kind", async () => {
    const instance = await initializeChatSdkInstance(
      {
        workspaceId: "ws-notif-2",
        userId: "user-1",
        signals: { "telegram-chat": { provider: "telegram", config: {} } },
        streamRegistry: new StreamRegistry(),
        triggerFn,
      },
      { kind: "telegram", botToken: "111:test", secretToken: "wh", appId: "111" },
    );

    try {
      // Grab the adapter instance Chat holds, install a spy on postMessage,
      // then prove the notifier reaches the SAME instance by calling post().
      // If initializeChatSdkInstance built two separate adapter maps, the spy
      // would not be hit.
      const chatAdapter = instance.chat.getAdapter("telegram");
      const spy = vi
        .spyOn(chatAdapter, "postMessage")
        .mockResolvedValue({ id: "tg-msg-1", threadId: "telegram:c:t", raw: { ok: true } });

      const result = await instance.notifier.post({
        communicator: "telegram",
        destination: "telegram:c:t",
        message: "hi",
      });

      expect(spy).toHaveBeenCalledWith("telegram:c:t", "hi");
      expect(result).toEqual({
        messageId: "tg-msg-1",
        threadId: "telegram:c:t",
        raw: { ok: true },
      });
    } finally {
      await instance.teardown();
    }
  });
});
