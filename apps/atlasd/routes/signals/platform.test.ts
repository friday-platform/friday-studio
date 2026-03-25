import type { MergedConfig } from "@atlas/config";
import type { WorkspaceEntry, WorkspaceManager } from "@atlas/workspace";
import { describe, expect, it, vi } from "vitest";
import type { AtlasDaemon } from "../../src/atlas-daemon.ts";
import { createPlatformSignalRoutes } from "./platform.ts";

/** Build a minimal MergedConfig with a slack signal configured. */
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

/** Minimal mock daemon for routing tests. */
function makeDaemon(workspaces: { id: string; config: MergedConfig | null }[]) {
  const triggerWorkspaceSignal = vi
    .fn<AtlasDaemon["triggerWorkspaceSignal"]>()
    .mockResolvedValue({ sessionId: "s-1" });
  const configMap = new Map(workspaces.map((w) => [w.id, w.config]));
  const getWorkspaceConfig = vi.fn<WorkspaceManager["getWorkspaceConfig"]>((id: string) =>
    Promise.resolve(configMap.get(id) ?? null),
  );
  const list = vi.fn<WorkspaceManager["list"]>(() =>
    Promise.resolve(workspaces.map((w) => ({ id: w.id }) as WorkspaceEntry)),
  );

  const daemon = {
    getWorkspaceManager: () => ({ getWorkspaceConfig, list }),
    triggerWorkspaceSignal,
  } as unknown as AtlasDaemon;

  return { daemon, getWorkspaceConfig, triggerWorkspaceSignal };
}

const basePayload = {
  text: "hello",
  _slack: {
    channel_id: "C123",
    team_id: "T024BE7LD",
    channel_type: "im" as const,
    user_id: "U01234",
    timestamp: "1234567890.123456",
    app_id: "A012ABCD0A0",
  },
};

describe("POST /slack", () => {
  it("returns 202 when app_id matches a workspace", async () => {
    const { daemon } = makeDaemon([{ id: "ws-abc", config: makeConfig("A012ABCD0A0") }]);

    const app = createPlatformSignalRoutes(daemon);
    const res = await app.request("/slack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(basePayload),
    });

    expect(res.status).toBe(202);
  });

  it("returns 404 when no workspace matches the app_id", async () => {
    const { daemon } = makeDaemon([]);

    const app = createPlatformSignalRoutes(daemon);
    const res = await app.request("/slack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(basePayload),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("No workspace configured for this app_id");
  });

  it("returns 404 when workspace exists but has no matching slack signal", async () => {
    const config: MergedConfig = {
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

    const { daemon } = makeDaemon([{ id: "ws-abc", config }]);

    const app = createPlatformSignalRoutes(daemon);
    const res = await app.request("/slack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(basePayload),
    });

    expect(res.status).toBe(404);
  });

  it("returns 404 when app_id does not match any workspace config", async () => {
    const { daemon } = makeDaemon([{ id: "ws-abc", config: makeConfig("A_DIFFERENT_APP") }]);

    const app = createPlatformSignalRoutes(daemon);
    const res = await app.request("/slack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(basePayload),
    });

    expect(res.status).toBe(404);
  });

  it("returns 400 when payload is missing required _slack fields", async () => {
    const { daemon } = makeDaemon([]);

    const app = createPlatformSignalRoutes(daemon);
    const res = await app.request("/slack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello", _slack: { channel_id: "C123" } }),
    });

    expect(res.status).toBe(400);
  });

  it("finds the correct workspace by scanning app_id across all workspaces", async () => {
    const { daemon, getWorkspaceConfig } = makeDaemon([
      { id: "ws-other", config: makeConfig("A_OTHER_APP") },
      { id: "ws-target", config: makeConfig("A012ABCD0A0") },
    ]);

    const app = createPlatformSignalRoutes(daemon);
    const res = await app.request("/slack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(basePayload),
    });

    expect(res.status).toBe(202);
    expect(getWorkspaceConfig).toHaveBeenCalledWith("ws-target");
  });

  it("dispatches with the actual signal key, not hardcoded 'slack'", async () => {
    const config: MergedConfig = {
      atlas: null,
      workspace: {
        version: "1.0",
        workspace: { name: "test" },
        signals: {
          "slack-bot-mention": {
            provider: "slack" as const,
            description: "Bot mentions",
            config: { app_id: "A012ABCD0A0" },
          },
        },
      },
    };

    const { daemon, triggerWorkspaceSignal } = makeDaemon([{ id: "ws-abc", config }]);

    const app = createPlatformSignalRoutes(daemon);
    const res = await app.request("/slack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(basePayload),
    });

    expect(res.status).toBe(202);
    // Wait for the async processSlackSignal to complete
    await vi.waitFor(() => {
      expect(triggerWorkspaceSignal).toHaveBeenCalled();
    });
    expect(triggerWorkspaceSignal).toHaveBeenCalledWith(
      "ws-abc",
      "slack-bot-mention",
      expect.objectContaining({ text: "hello" }),
    );
  });

  it("passes text and _slack metadata to workspace signal", async () => {
    const { daemon, triggerWorkspaceSignal } = makeDaemon([
      { id: "ws-abc", config: makeConfig("A012ABCD0A0") },
    ]);

    const app = createPlatformSignalRoutes(daemon);
    const res = await app.request("/slack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(basePayload),
    });

    expect(res.status).toBe(202);
    await vi.waitFor(() => {
      expect(triggerWorkspaceSignal).toHaveBeenCalled();
    });
    const call = triggerWorkspaceSignal.mock.calls[0];
    if (!call) throw new Error("Expected triggerWorkspaceSignal to be called");
    const payload = call[2];
    expect(payload).toEqual({ text: "hello", _slack: basePayload._slack });
  });
});
