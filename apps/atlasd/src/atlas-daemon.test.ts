/**
 * Tests for AtlasDaemon.maybeStartDiscordGateway + shutdown wiring. The full
 * daemon is integration-heavy, so these tests poke only the daemon-scoped
 * Discord Gateway service plumbing via narrow spies — no real WebSockets.
 */

import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@atlas/core/users/storage", () => ({
  UserStorage: { getCachedLocalUserId: () => "test-local-user" },
  initUserStorage: () => undefined,
  ensureUsersKVBucket: () => Promise.resolve(undefined),
}));

import { AtlasDaemon } from "./atlas-daemon.ts";
import { DiscordGatewayService } from "./discord-gateway-service.ts";

type WorkspaceManagerStub = {
  list: (...args: unknown[]) => Promise<{ id: string }[]>;
  getWorkspaceConfig: (
    id: string,
  ) => Promise<{
    workspace: { signals: Record<string, { provider: string; config?: Record<string, unknown> }> };
  } | null>;
};

function stubWorkspaceManager(
  daemon: AtlasDaemon,
  workspaces: {
    id: string;
    signals?: Record<string, { provider: string; config?: Record<string, unknown> }>;
  }[],
): void {
  const manager: WorkspaceManagerStub = {
    list: () => Promise.resolve(workspaces.map((w) => ({ id: w.id }))),
    getWorkspaceConfig: (id: string) => {
      const match = workspaces.find((w) => w.id === id);
      if (!match?.signals) return Promise.resolve(null);
      return Promise.resolve({ workspace: { signals: match.signals } });
    },
  };
  (daemon as unknown as { workspaceManager: WorkspaceManagerStub }).workspaceManager = manager;
}

const discordEnvKeys = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_PUBLIC_KEY",
  "DISCORD_APPLICATION_ID",
] as const;

function saveDiscordEnv(): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const key of discordEnvKeys) saved[key] = process.env[key];
  return () => {
    for (const key of discordEnvKeys) {
      const original = saved[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  };
}

describe("AtlasDaemon.maybeStartDiscordGateway", () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = saveDiscordEnv();
    for (const key of discordEnvKeys) delete process.env[key];
  });
  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  // Private method surfaced for tests; cast is test-file-only.
  type GatewayShape = {
    maybeStartDiscordGateway: () => Promise<void>;
    discordGatewayService: DiscordGatewayService | null;
  };

  function stubPort(daemon: AtlasDaemon): void {
    Object.defineProperty(daemon, "port", { get: () => 12345, configurable: true });
  }

  it("does NOT start the service when env vars are missing and no workspace has discord creds", async () => {
    const daemon = new AtlasDaemon({ port: 0 });
    stubWorkspaceManager(daemon, []);
    const startSpy = vi.spyOn(DiscordGatewayService.prototype, "start").mockResolvedValue();

    await (daemon as unknown as GatewayShape).maybeStartDiscordGateway();

    expect(startSpy).not.toHaveBeenCalled();
    expect((daemon as unknown as GatewayShape).discordGatewayService).toBeNull();
  });

  it("falls back to env vars when no workspace resolves discord creds", async () => {
    process.env.DISCORD_BOT_TOKEN = "env-bot";
    process.env.DISCORD_PUBLIC_KEY = "env-pub";
    process.env.DISCORD_APPLICATION_ID = "env-app";

    const daemon = new AtlasDaemon({ port: 0 });
    stubPort(daemon);
    stubWorkspaceManager(daemon, []);
    const startSpy = vi.spyOn(DiscordGatewayService.prototype, "start").mockResolvedValue();

    await (daemon as unknown as GatewayShape).maybeStartDiscordGateway();

    expect(startSpy).toHaveBeenCalledOnce();
    expect((daemon as unknown as GatewayShape).discordGatewayService).toBeInstanceOf(
      DiscordGatewayService,
    );
  });

  it("uses workspace signal config creds when a workspace declares them inline", async () => {
    const daemon = new AtlasDaemon({ port: 0 });
    stubPort(daemon);
    stubWorkspaceManager(daemon, [
      {
        id: "ws-cfg",
        signals: {
          "discord-chat": {
            provider: "discord",
            config: { bot_token: "cfg-bot", public_key: "cfg-pub", application_id: "cfg-app" },
          },
        },
      },
    ]);

    const startSpy = vi.spyOn(DiscordGatewayService.prototype, "start").mockResolvedValue();

    await (daemon as unknown as GatewayShape).maybeStartDiscordGateway();

    expect(startSpy).toHaveBeenCalledOnce();
    const service = (daemon as unknown as GatewayShape).discordGatewayService;
    expect(service).toBeInstanceOf(DiscordGatewayService);
    const deps = (service as unknown as { deps: { credentials: Record<string, string> } }).deps;
    expect(deps.credentials).toEqual({
      botToken: "cfg-bot",
      publicKey: "cfg-pub",
      applicationId: "cfg-app",
    });
  });

  it("warns and uses the first workspace's creds when two workspaces declare different bot tokens", async () => {
    const daemon = new AtlasDaemon({ port: 0 });
    stubPort(daemon);
    stubWorkspaceManager(daemon, [
      {
        id: "ws-a",
        signals: {
          "discord-chat": {
            provider: "discord",
            config: { bot_token: "bot-a", public_key: "pub", application_id: "app" },
          },
        },
      },
      {
        id: "ws-b",
        signals: {
          "discord-chat": {
            provider: "discord",
            config: { bot_token: "bot-b", public_key: "pub", application_id: "app" },
          },
        },
      },
    ]);

    const startSpy = vi.spyOn(DiscordGatewayService.prototype, "start").mockResolvedValue();

    await (daemon as unknown as GatewayShape).maybeStartDiscordGateway();

    expect(startSpy).toHaveBeenCalledOnce();
    const service = (daemon as unknown as GatewayShape).discordGatewayService;
    const deps = (service as unknown as { deps: { credentials: Record<string, string> } }).deps;
    // First workspace wins; operators see the warn log but the bot still starts.
    expect(deps.credentials.botToken).toBe("bot-a");
  });
});

describe("AtlasDaemon idle/session cleanup", () => {
  it("does not clean up stale platform MCP sessions while a request is in flight", async () => {
    const daemon = new AtlasDaemon({ port: 0 });
    const now = Date.now();
    const stale = now - 16 * 60 * 1000;
    const sessions = (
      daemon as unknown as { platformMcpSessions: Map<string, Record<string, unknown>> }
    ).platformMcpSessions;
    const activeClose = vi.fn().mockResolvedValue(undefined);
    const idleClose = vi.fn().mockResolvedValue(undefined);

    sessions.set("active-hitl", {
      server: {},
      transport: { close: activeClose },
      createdAt: stale,
      lastUsed: stale,
      activeRequests: 1,
    });
    sessions.set("idle-old", {
      server: {},
      transport: { close: idleClose },
      createdAt: stale,
      lastUsed: stale,
      activeRequests: 0,
    });

    await (
      daemon as unknown as { performPlatformSessionCleanup: () => Promise<void> }
    ).performPlatformSessionCleanup();

    expect(sessions.has("active-hitl")).toBe(true);
    expect(sessions.has("idle-old")).toBe(false);
    expect(activeClose).not.toHaveBeenCalled();
    expect(idleClose).toHaveBeenCalledOnce();
  });

  it("does not clean up stale agent MCP sessions while a request is in flight", async () => {
    const daemon = new AtlasDaemon({ port: 0 });
    const now = Date.now();
    const stale = now - 16 * 60 * 1000;
    const sessions = (daemon as unknown as { agentSessions: Map<string, Record<string, unknown>> })
      .agentSessions;
    const activeClose = vi.fn().mockResolvedValue(undefined);
    const activeStop = vi.fn().mockResolvedValue(undefined);
    const idleClose = vi.fn().mockResolvedValue(undefined);
    const idleStop = vi.fn().mockResolvedValue(undefined);

    sessions.set("active-agent", {
      server: { stop: activeStop },
      transport: { close: activeClose },
      createdAt: stale,
      lastUsed: stale,
      activeRequests: 1,
    });
    sessions.set("idle-agent", {
      server: { stop: idleStop },
      transport: { close: idleClose },
      createdAt: stale,
      lastUsed: stale,
      activeRequests: 0,
    });

    await (
      daemon as unknown as { performAgentSessionCleanup: () => Promise<void> }
    ).performAgentSessionCleanup();

    expect(sessions.has("active-agent")).toBe(true);
    expect(sessions.has("idle-agent")).toBe(false);
    expect(activeClose).not.toHaveBeenCalled();
    expect(activeStop).not.toHaveBeenCalled();
    expect(idleClose).toHaveBeenCalledOnce();
    expect(idleStop).toHaveBeenCalledOnce();
  });

  it("keeps agent MCP requests active until streaming response bodies close", async () => {
    const daemon = new AtlasDaemon({ port: 0 });
    const sessions = (daemon as unknown as { agentSessions: Map<string, Record<string, unknown>> })
      .agentSessions;
    sessions.set("streaming-agent", {
      server: { stop: vi.fn().mockResolvedValue(undefined) },
      transport: {},
      createdAt: Date.now(),
      lastUsed: Date.now(),
      activeRequests: 0,
    });

    const transport = {
      handleRequest: vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    };

    const response = await (
      daemon as unknown as {
        handleAgentMcpRequest: (
          sessionId: string,
          transportArg: { handleRequest: () => Promise<Response> },
          context: unknown,
        ) => Promise<Response | undefined>;
      }
    ).handleAgentMcpRequest("streaming-agent", transport, {});

    expect(sessions.get("streaming-agent")?.activeRequests).toBe(1);

    await response?.body?.cancel();

    expect(sessions.get("streaming-agent")?.activeRequests).toBe(0);
  });

  it("keeps platform MCP requests active until streaming response bodies close", async () => {
    const daemon = new AtlasDaemon({ port: 0 });
    const sessions = (
      daemon as unknown as { platformMcpSessions: Map<string, Record<string, unknown>> }
    ).platformMcpSessions;
    sessions.set("streaming-platform", {
      server: {},
      transport: {},
      createdAt: Date.now(),
      lastUsed: Date.now(),
      activeRequests: 0,
    });

    const transport = {
      handleRequest: vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    };

    const response = await (
      daemon as unknown as {
        handlePlatformMcpRequest: (
          sessionId: string,
          transportArg: { handleRequest: () => Promise<Response> },
          context: unknown,
        ) => Promise<Response | undefined>;
      }
    ).handlePlatformMcpRequest("streaming-platform", transport, {});

    expect(sessions.get("streaming-platform")?.activeRequests).toBe(1);

    await response?.body?.cancel();

    expect(sessions.get("streaming-platform")?.activeRequests).toBe(0);
  });

  it("releases MCP request tracking when streaming response bodies finish", async () => {
    const daemon = new AtlasDaemon({ port: 0 });
    const sessions = (daemon as unknown as { agentSessions: Map<string, Record<string, unknown>> })
      .agentSessions;
    sessions.set("closing-agent", {
      server: { stop: vi.fn().mockResolvedValue(undefined) },
      transport: {},
      createdAt: Date.now(),
      lastUsed: Date.now(),
      activeRequests: 0,
    });

    const transport = {
      handleRequest: vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    };

    const response = await (
      daemon as unknown as {
        handleAgentMcpRequest: (
          sessionId: string,
          transportArg: { handleRequest: () => Promise<Response> },
          context: unknown,
        ) => Promise<Response | undefined>;
      }
    ).handleAgentMcpRequest("closing-agent", transport, {});

    expect(sessions.get("closing-agent")?.activeRequests).toBe(1);

    await response?.arrayBuffer();

    expect(sessions.get("closing-agent")?.activeRequests).toBe(0);
  });

  it("releases MCP request tracking immediately for no-body responses", async () => {
    const daemon = new AtlasDaemon({ port: 0 });
    const sessions = (daemon as unknown as { agentSessions: Map<string, Record<string, unknown>> })
      .agentSessions;
    sessions.set("empty-response-agent", {
      server: { stop: vi.fn().mockResolvedValue(undefined) },
      transport: {},
      createdAt: Date.now(),
      lastUsed: Date.now(),
      activeRequests: 0,
    });

    const transport = {
      handleRequest: vi.fn().mockResolvedValue(new Response(null, { status: 202 })),
    };

    await (
      daemon as unknown as {
        handleAgentMcpRequest: (
          sessionId: string,
          transportArg: { handleRequest: () => Promise<Response> },
          context: unknown,
        ) => Promise<Response | undefined>;
      }
    ).handleAgentMcpRequest("empty-response-agent", transport, {});

    expect(sessions.get("empty-response-agent")?.activeRequests).toBe(0);
  });

  it("closes agent and platform MCP transports during explicit cleanup", async () => {
    const daemon = new AtlasDaemon({ port: 0 });
    const agentClose = vi.fn().mockResolvedValue(undefined);
    const agentStop = vi.fn().mockResolvedValue(undefined);
    const platformClose = vi.fn().mockResolvedValue(undefined);
    const agentSessions = (
      daemon as unknown as { agentSessions: Map<string, Record<string, unknown>> }
    ).agentSessions;
    const platformSessions = (
      daemon as unknown as { platformMcpSessions: Map<string, Record<string, unknown>> }
    ).platformMcpSessions;

    agentSessions.set("agent-session", {
      server: { stop: agentStop },
      transport: { close: agentClose, onclose: () => undefined },
      createdAt: Date.now(),
      lastUsed: Date.now(),
      activeRequests: 0,
    });
    platformSessions.set("platform-session", {
      server: {},
      transport: { close: platformClose, onclose: () => undefined },
      createdAt: Date.now(),
      lastUsed: Date.now(),
      activeRequests: 0,
    });

    await (
      daemon as unknown as { cleanupAgentSession: (sessionId: string) => Promise<void> }
    ).cleanupAgentSession("agent-session");
    await (
      daemon as unknown as { cleanupPlatformSession: (sessionId: string) => Promise<void> }
    ).cleanupPlatformSession("platform-session");

    expect(agentClose).toHaveBeenCalledOnce();
    expect(agentStop).toHaveBeenCalledOnce();
    expect(platformClose).toHaveBeenCalledOnce();
    expect(agentSessions.has("agent-session")).toBe(false);
    expect(platformSessions.has("platform-session")).toBe(false);
  });

  it("force-evicts LRU platform sessions when no idle candidates exist and we're over the limit", async () => {
    // Reproduces the production starvation: long-lived SSE/MCP streams keep
    // `activeRequests > 0` forever, so the old eviction path filtered them
    // ALL out and `toEvict.length` was always 0 — the warning fired every
    // 60s with no progress and the map grew unbounded.
    const daemon = new AtlasDaemon({ port: 0 });
    const sessions = (
      daemon as unknown as { platformMcpSessions: Map<string, Record<string, unknown>> }
    ).platformMcpSessions;
    const maxSessions = (daemon as unknown as { MAX_PLATFORM_SESSIONS: number })
      .MAX_PLATFORM_SESSIONS;

    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const now = Date.now();
    // Fill the map past the limit, all sessions in-flight (activeRequests > 0).
    for (let i = 0; i < maxSessions + 5; i++) {
      const close = vi.fn().mockResolvedValue(undefined);
      closes.push(close);
      sessions.set(`active-session-${i}`, {
        server: {},
        transport: { close, onclose: () => undefined },
        createdAt: now - (maxSessions + 5 - i) * 1000,
        lastUsed: now - (maxSessions + 5 - i) * 1000, // earliest is i=0
        activeRequests: 1,
      });
    }
    expect(sessions.size).toBe(maxSessions + 5);

    await (
      daemon as unknown as { performPlatformSessionCleanup: () => Promise<void> }
    ).performPlatformSessionCleanup();

    // Down to the limit exactly, evicted the 5 LRU (oldest lastUsed).
    expect(sessions.size).toBe(maxSessions);
    for (let i = 0; i < 5; i++) {
      expect(sessions.has(`active-session-${i}`)).toBe(false);
      expect(closes[i]).toHaveBeenCalledOnce();
    }
    for (let i = 5; i < maxSessions + 5; i++) {
      expect(sessions.has(`active-session-${i}`)).toBe(true);
    }
  });

  it("prefers idle platform sessions over active ones when evicting", async () => {
    const daemon = new AtlasDaemon({ port: 0 });
    const sessions = (
      daemon as unknown as { platformMcpSessions: Map<string, Record<string, unknown>> }
    ).platformMcpSessions;
    const maxSessions = (daemon as unknown as { MAX_PLATFORM_SESSIONS: number })
      .MAX_PLATFORM_SESSIONS;

    const now = Date.now();
    // 3 over the limit. The oldest 2 are *active*, but there are 2 *idle*
    // sessions in the middle — the idle ones should go first even though
    // they're newer, then we still need 1 more from the active LRU pool.
    const activeOldClose = vi.fn().mockResolvedValue(undefined);
    sessions.set("active-oldest", {
      server: {},
      transport: { close: activeOldClose, onclose: () => undefined },
      createdAt: now - 100_000,
      lastUsed: now - 100_000,
      activeRequests: 1,
    });
    const activeOlderClose = vi.fn().mockResolvedValue(undefined);
    sessions.set("active-older", {
      server: {},
      transport: { close: activeOlderClose, onclose: () => undefined },
      createdAt: now - 90_000,
      lastUsed: now - 90_000,
      activeRequests: 1,
    });
    const idle1Close = vi.fn().mockResolvedValue(undefined);
    sessions.set("idle-mid-1", {
      server: {},
      transport: { close: idle1Close, onclose: () => undefined },
      createdAt: now - 60_000,
      lastUsed: now - 60_000,
      activeRequests: 0,
    });
    const idle2Close = vi.fn().mockResolvedValue(undefined);
    sessions.set("idle-mid-2", {
      server: {},
      transport: { close: idle2Close, onclose: () => undefined },
      createdAt: now - 50_000,
      lastUsed: now - 50_000,
      activeRequests: 0,
    });

    // Fill the rest with active recent sessions (we don't want them evicted).
    for (let i = 0; i < maxSessions - 1; i++) {
      sessions.set(`active-recent-${i}`, {
        server: {},
        transport: { close: vi.fn().mockResolvedValue(undefined), onclose: () => undefined },
        createdAt: now - i,
        lastUsed: now - i,
        activeRequests: 1,
      });
    }
    expect(sessions.size).toBe(maxSessions + 3);

    await (
      daemon as unknown as { performPlatformSessionCleanup: () => Promise<void> }
    ).performPlatformSessionCleanup();

    expect(sessions.size).toBe(maxSessions);
    // Both idle ones evicted (preferred), plus the oldest active one as fallback.
    expect(sessions.has("idle-mid-1")).toBe(false);
    expect(sessions.has("idle-mid-2")).toBe(false);
    expect(sessions.has("active-oldest")).toBe(false);
    expect(sessions.has("active-older")).toBe(true);
    expect(idle1Close).toHaveBeenCalledOnce();
    expect(idle2Close).toHaveBeenCalledOnce();
    expect(activeOldClose).toHaveBeenCalledOnce();
    expect(activeOlderClose).not.toHaveBeenCalled();
  });

  it("force-evicts LRU agent sessions when no idle candidates exist", async () => {
    // Symmetric coverage for the agent path — same bug, same fix.
    const daemon = new AtlasDaemon({ port: 0 });
    const sessions = (daemon as unknown as { agentSessions: Map<string, Record<string, unknown>> })
      .agentSessions;
    const maxSessions = (daemon as unknown as { MAX_AGENT_SESSIONS: number }).MAX_AGENT_SESSIONS;

    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const now = Date.now();
    for (let i = 0; i < maxSessions + 3; i++) {
      const close = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      closes.push(close);
      stops.push(stop);
      sessions.set(`active-agent-${i}`, {
        server: { stop },
        transport: { close, onclose: () => undefined },
        createdAt: now - (maxSessions + 3 - i) * 1000,
        lastUsed: now - (maxSessions + 3 - i) * 1000,
        activeRequests: 1,
      });
    }
    expect(sessions.size).toBe(maxSessions + 3);

    await (
      daemon as unknown as { performAgentSessionCleanup: () => Promise<void> }
    ).performAgentSessionCleanup();

    expect(sessions.size).toBe(maxSessions);
    for (let i = 0; i < 3; i++) {
      expect(sessions.has(`active-agent-${i}`)).toBe(false);
      expect(closes[i]).toHaveBeenCalledOnce();
      expect(stops[i]).toHaveBeenCalledOnce();
    }
    for (let i = 3; i < maxSessions + 3; i++) {
      expect(sessions.has(`active-agent-${i}`)).toBe(true);
    }
  });

  it("does not evict anything when at or under the platform session limit", async () => {
    // Regression guard: the new force-evict path must NOT kick in unless
    // we're strictly over the limit.
    const daemon = new AtlasDaemon({ port: 0 });
    const sessions = (
      daemon as unknown as { platformMcpSessions: Map<string, Record<string, unknown>> }
    ).platformMcpSessions;
    const maxSessions = (daemon as unknown as { MAX_PLATFORM_SESSIONS: number })
      .MAX_PLATFORM_SESSIONS;

    const closes: Array<ReturnType<typeof vi.fn>> = [];
    for (let i = 0; i < maxSessions; i++) {
      const close = vi.fn().mockResolvedValue(undefined);
      closes.push(close);
      sessions.set(`session-${i}`, {
        server: {},
        transport: { close, onclose: () => undefined },
        createdAt: Date.now(),
        lastUsed: Date.now(),
        activeRequests: 1,
      });
    }
    expect(sessions.size).toBe(maxSessions);

    await (
      daemon as unknown as { performPlatformSessionCleanup: () => Promise<void> }
    ).performPlatformSessionCleanup();

    expect(sessions.size).toBe(maxSessions);
    for (const close of closes) {
      expect(close).not.toHaveBeenCalled();
    }
  });
});

describe("AtlasDaemon.shutdown stops the Discord Gateway service", () => {
  it("calls service.stop() during shutdown and clears the handle", async () => {
    const daemon = new AtlasDaemon({ port: 0 });
    const stop = vi.fn().mockResolvedValue(undefined);
    (daemon as unknown as { discordGatewayService: { stop: typeof stop } }).discordGatewayService =
      { stop };

    await daemon.shutdown();

    expect(stop).toHaveBeenCalledOnce();
    expect(
      (daemon as unknown as { discordGatewayService: DiscordGatewayService | null })
        .discordGatewayService,
    ).toBeNull();
  });
});
