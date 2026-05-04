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

describe("AtlasDaemon.destroyWorkspaceRuntime", () => {
  it("evicts the cached chat SDK instance even when no runtime is live", async () => {
    // Regression guard: before the fix, destroyWorkspaceRuntime returned early
    // when this.runtimes.get(workspaceId) was undefined — meaning a workspace
    // whose runtime had idle-reaped but still had a cached ChatSdkInstance
    // (built by an inbound Slack/Teams event) kept serving with stale
    // credentials forever. The config-file watcher routes through this method
    // on every workspace.yml save, so editing bot_token / signing_secret had
    // no effect until a full daemon restart. The fix moves the eviction out
    // of the early-return branch.
    const daemon = new AtlasDaemon({ port: 0 });
    const teardown = vi.fn().mockResolvedValue(undefined);

    // Seed a cached chat SDK without a live runtime — matches post-idle-reap state
    (
      daemon as unknown as {
        chatSdkInstances: Map<string, Promise<{ teardown: () => Promise<void> }>>;
      }
    ).chatSdkInstances.set("ws-1", Promise.resolve({ teardown }));
    // Stub the manager so unregisterRuntime / updateWorkspaceStatus don't hit real code
    (
      daemon as unknown as {
        workspaceManager: {
          unregisterRuntime: (id: string) => Promise<void>;
          updateWorkspaceStatus: (id: string, status: string) => Promise<void>;
        };
      }
    ).workspaceManager = {
      unregisterRuntime: vi.fn().mockResolvedValue(undefined),
      updateWorkspaceStatus: vi.fn().mockResolvedValue(undefined),
    };

    await daemon.destroyWorkspaceRuntime("ws-1");

    expect(teardown).toHaveBeenCalledOnce();
    const remaining = (
      daemon as unknown as { chatSdkInstances: Map<string, unknown> }
    ).chatSdkInstances.get("ws-1");
    expect(remaining).toBeUndefined();
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
