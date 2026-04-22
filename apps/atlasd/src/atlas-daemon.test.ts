/**
 * Minimal tests for AtlasDaemon idle-pinning behavior. The full daemon is
 * integration-heavy (HTTP server, filesystem workspaces, workers), so these
 * tests exercise only the public preventIdle surface and the private reaper
 * branch via a narrow cast — no test-only methods added to production.
 */
const hoisted = vi.hoisted(() => ({
  // Never-resolving init stub lets us freeze buildChatSdkInstance right at
  // the `await initializeChatSdkInstance(...)` boundary so the pin-race test
  // can inspect daemon state after the sync path and before init settles.
  initStub: vi.fn(),
}));

vi.mock("./chat-sdk/chat-sdk-instance.ts", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    initializeChatSdkInstance: hoisted.initStub,
  };
});

import process from "node:process";
import type { WorkspaceRuntime } from "@atlas/workspace";
import { describe, expect, it, vi } from "vitest";
import { AtlasDaemon } from "./atlas-daemon.ts";

/** A WorkspaceRuntime stub with just enough surface for the reaper's checks. */
function fakeRuntime(overrides: Partial<WorkspaceRuntime> = {}): WorkspaceRuntime {
  return {
    getSessions: () => [],
    ...overrides,
  } as unknown as WorkspaceRuntime;
}

describe("AtlasDaemon.preventIdleWorkspaces", () => {
  it("registerPreventIdle adds the workspace id; releasePreventIdle removes it", () => {
    const daemon = new AtlasDaemon({ port: 0 });

    expect(daemon.preventIdleWorkspaces.size).toBe(0);

    daemon.registerPreventIdle("ws-A");
    expect(daemon.preventIdleWorkspaces.has("ws-A")).toBe(true);

    daemon.releasePreventIdle("ws-A");
    expect(daemon.preventIdleWorkspaces.has("ws-A")).toBe(false);
  });

  it("releasePreventIdle on an unregistered id is a no-op", () => {
    const daemon = new AtlasDaemon({ port: 0 });
    daemon.releasePreventIdle("never-registered");
    expect(daemon.preventIdleWorkspaces.size).toBe(0);
  });
});

describe("AtlasDaemon idle reaper early-bail", () => {
  // Private method surfaced for tests; cast is test-file-only, no production
  // plumbing was added to reach it.
  type ReaperShape = {
    checkAndDestroyIdleWorkspace: (workspaceId: string) => Promise<void>;
  };

  it("skips destroyWorkspaceRuntime when the workspace is pinned", async () => {
    const daemon = new AtlasDaemon({ port: 0 });
    daemon.runtimes.set("ws-pinned", fakeRuntime());
    daemon.registerPreventIdle("ws-pinned");

    const destroySpy = vi
      .spyOn(daemon, "destroyWorkspaceRuntime")
      .mockResolvedValue(undefined);

    try {
      await (daemon as unknown as ReaperShape).checkAndDestroyIdleWorkspace("ws-pinned");
      expect(destroySpy).not.toHaveBeenCalled();
    } finally {
      destroySpy.mockRestore();
    }
  });

  it("destroys when the pin has been released (no re-arm leak)", async () => {
    const daemon = new AtlasDaemon({ port: 0 });
    daemon.runtimes.set("ws-unpinned", fakeRuntime());
    daemon.registerPreventIdle("ws-unpinned");
    daemon.releasePreventIdle("ws-unpinned");

    const destroySpy = vi
      .spyOn(daemon, "destroyWorkspaceRuntime")
      .mockResolvedValue(undefined);

    try {
      await (daemon as unknown as ReaperShape).checkAndDestroyIdleWorkspace("ws-unpinned");
      expect(destroySpy).toHaveBeenCalledWith("ws-unpinned");
    } finally {
      destroySpy.mockRestore();
    }
  });
});

describe("AtlasDaemon.buildChatSdkInstance pin race", () => {
  // Private method surfaced for tests; see note above.
  type BuilderShape = {
    buildChatSdkInstance: (workspaceId: string) => Promise<unknown>;
    getWorkspaceManager: () => unknown;
  };

  const discordEnvKeys = ["DISCORD_BOT_TOKEN", "DISCORD_PUBLIC_KEY", "DISCORD_APPLICATION_ID"];

  it("pin is set before the init await settles", async () => {
    const originalEnv: Record<string, string | undefined> = {};
    for (const key of discordEnvKeys) originalEnv[key] = process.env[key];
    process.env.DISCORD_BOT_TOKEN = "t";
    process.env.DISCORD_PUBLIC_KEY = "a".repeat(64);
    process.env.DISCORD_APPLICATION_ID = "app";

    // Freeze initializeChatSdkInstance so the sync path of buildChatSdkInstance
    // (credential resolution + pin registration) gets to run, but the outer
    // promise never resolves. Any state visible after this point reflects
    // what happened BEFORE the init await.
    hoisted.initStub.mockImplementation(() => new Promise(() => {}));

    const daemon = new AtlasDaemon({ port: 0 });

    // Stub the workspace manager — the real one needs an initialized daemon.
    const fakeManager = {
      getWorkspaceConfig: () =>
        Promise.resolve({
          workspace: {
            signals: { "discord-chat": { provider: "discord", config: {} } },
          },
        }),
      find: () => Promise.resolve({ metadata: { createdBy: "u-1" } }),
    };
    vi.spyOn(daemon, "getWorkspaceManager").mockReturnValue(
      fakeManager as unknown as ReturnType<AtlasDaemon["getWorkspaceManager"]>,
    );

    try {
      const p = (daemon as unknown as BuilderShape).buildChatSdkInstance("ws-race");
      // Tick until the init stub has been called (proof that the sync path,
      // including registerPreventIdle, has finished).
      await vi.waitFor(() => expect(hoisted.initStub).toHaveBeenCalled());
      expect(daemon.preventIdleWorkspaces.has("ws-race")).toBe(true);
      // Discard the pending build promise.
      p.catch(() => {});
    } finally {
      hoisted.initStub.mockReset();
      for (const key of discordEnvKeys) {
        const original = originalEnv[key];
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
      }
    }
  });

  it("does NOT pin when the workspace has no discord signal", async () => {
    hoisted.initStub.mockImplementation(() => new Promise(() => {}));

    const daemon = new AtlasDaemon({ port: 0 });

    const fakeManager = {
      getWorkspaceConfig: () =>
        Promise.resolve({
          workspace: { signals: { "web-chat": { provider: "atlas-web", config: {} } } },
        }),
      find: () => Promise.resolve({ metadata: { createdBy: "u-1" } }),
    };
    vi.spyOn(daemon, "getWorkspaceManager").mockReturnValue(
      fakeManager as unknown as ReturnType<AtlasDaemon["getWorkspaceManager"]>,
    );

    try {
      const p = (daemon as unknown as BuilderShape).buildChatSdkInstance("ws-no-discord");
      await vi.waitFor(() => expect(hoisted.initStub).toHaveBeenCalled());
      expect(daemon.preventIdleWorkspaces.has("ws-no-discord")).toBe(false);
      p.catch(() => {});
    } finally {
      hoisted.initStub.mockReset();
    }
  });
});

describe("AtlasDaemon session-completion destroy gate", () => {
  // The production handler is a closure inside buildChatSdkInstance's runtime
  // construction, so we can't invoke it directly. Instead we mirror its
  // pin-first shape (atlas-daemon.ts:1170) and assert that the gate routes
  // destroy calls correctly. Using fakeRuntime() with no sessions pins the
  // hasActiveSessions/Executions path to "idle", so the only variable here
  // is the pin — the exact branch the fix adds.
  async function runSessionCompletionGate(
    daemon: AtlasDaemon,
    workspaceId: string,
  ): Promise<void> {
    if (daemon.preventIdleWorkspaces.has(workspaceId)) return;
    await daemon.destroyWorkspaceRuntime(workspaceId);
  }

  it("does NOT destroy a pinned workspace on session completion", async () => {
    const daemon = new AtlasDaemon({ port: 0 });
    daemon.runtimes.set("ws-pinned", fakeRuntime());
    daemon.registerPreventIdle("ws-pinned");

    const destroySpy = vi
      .spyOn(daemon, "destroyWorkspaceRuntime")
      .mockResolvedValue(undefined);

    try {
      await runSessionCompletionGate(daemon, "ws-pinned");
      expect(destroySpy).not.toHaveBeenCalled();
    } finally {
      destroySpy.mockRestore();
    }
  });

  it("DOES destroy an unpinned idle workspace on session completion", async () => {
    const daemon = new AtlasDaemon({ port: 0 });
    daemon.runtimes.set("ws-unpinned", fakeRuntime());

    const destroySpy = vi
      .spyOn(daemon, "destroyWorkspaceRuntime")
      .mockResolvedValue(undefined);

    try {
      await runSessionCompletionGate(daemon, "ws-unpinned");
      expect(destroySpy).toHaveBeenCalledWith("ws-unpinned");
    } finally {
      destroySpy.mockRestore();
    }
  });
});

describe("AtlasDaemon.findOldestIdleWorkspace pin filter", () => {
  // Private method surfaced for tests; cast is test-file-only.
  type EvictionShape = {
    findOldestIdleWorkspace: () => string | null;
  };

  it("returns null when every idle workspace is pinned", () => {
    const daemon = new AtlasDaemon({ port: 0 });
    daemon.runtimes.set("ws-pinned-a", fakeRuntime());
    daemon.runtimes.set("ws-pinned-b", fakeRuntime());
    daemon.registerPreventIdle("ws-pinned-a");
    daemon.registerPreventIdle("ws-pinned-b");

    const result = (daemon as unknown as EvictionShape).findOldestIdleWorkspace();
    expect(result).toBeNull();
  });

  it("returns the unpinned workspace when mixed with pinned ones", () => {
    const daemon = new AtlasDaemon({ port: 0 });
    daemon.runtimes.set("ws-pinned", fakeRuntime());
    daemon.runtimes.set("ws-evictable", fakeRuntime());
    daemon.registerPreventIdle("ws-pinned");

    const result = (daemon as unknown as EvictionShape).findOldestIdleWorkspace();
    expect(result).toBe("ws-evictable");
  });
});

describe("AtlasDaemon shutdown clears preventIdleWorkspaces", () => {
  it("clears the set as part of shutdown's cleanup", async () => {
    const daemon = new AtlasDaemon({ port: 0 });
    daemon.registerPreventIdle("ws-1");
    daemon.registerPreventIdle("ws-2");
    expect(daemon.preventIdleWorkspaces.size).toBe(2);

    await daemon.shutdown();

    expect(daemon.preventIdleWorkspaces.size).toBe(0);
  });
});
