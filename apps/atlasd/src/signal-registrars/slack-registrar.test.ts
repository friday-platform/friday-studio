import type { MergedConfig } from "@atlas/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SlackEventManager, SlackRegistrarDeps } from "./slack-registrar.ts";
import { SlackSignalRegistrar } from "./slack-registrar.ts";

function makeConfig(signals?: Record<string, unknown>): MergedConfig {
  return { atlas: null, workspace: { signals } as MergedConfig["workspace"] };
}

function slackSignal(appId: string) {
  return { provider: "slack", config: { app_id: appId } };
}

function makeDeps(overrides?: Partial<SlackRegistrarDeps>): SlackRegistrarDeps {
  return {
    eventManager: {
      enableEvents: vi.fn<SlackEventManager["enableEvents"]>().mockResolvedValue({ enabled: true }),
      disableEvents: vi.fn<SlackEventManager["disableEvents"]>().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

const WORKSPACE_ID = "ws-test";
const CRED_ID = "cred_slack_1";
const APP_ID = "A0123SLACK";

function mockByWorkspaceEndpoint(credentialId: string, appId: string): void {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ credential_id: credentialId, app_id: appId }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
  );
}

function mockByWorkspace404(): void {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(new Response("Not Found", { status: 404 }))),
  );
}

describe("SlackSignalRegistrar", () => {
  let deps: SlackRegistrarDeps;
  let registrar: SlackSignalRegistrar;

  beforeEach(() => {
    mockByWorkspaceEndpoint(CRED_ID, APP_ID);
    deps = makeDeps();
    registrar = new SlackSignalRegistrar(deps);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("registerWorkspace", () => {
    it("enables events when slack signal present with credential wired to workspace", async () => {
      const config = makeConfig({ slack: slackSignal(APP_ID) });

      await registrar.registerWorkspace(WORKSPACE_ID, "/path", config);

      expect(deps.eventManager.enableEvents).toHaveBeenCalledWith(CRED_ID);
    });

    it("skips when no slack signal in config", async () => {
      const config = makeConfig({ http: { provider: "http", config: {} } });

      await registrar.registerWorkspace(WORKSPACE_ID, "/path", config);

      expect(deps.eventManager.enableEvents).not.toHaveBeenCalled();
    });

    it("skips when no signals at all", async () => {
      const config = makeConfig();

      await registrar.registerWorkspace(WORKSPACE_ID, "/path", config);

      expect(deps.eventManager.enableEvents).not.toHaveBeenCalled();
    });

    it("calls enableEvents but does not cache when credential is pending", async () => {
      deps = makeDeps({
        eventManager: {
          enableEvents: vi
            .fn<SlackEventManager["enableEvents"]>()
            .mockResolvedValue({ enabled: false, reason: "pending" }),
          disableEvents: vi.fn<SlackEventManager["disableEvents"]>().mockResolvedValue(undefined),
        },
      });
      registrar = new SlackSignalRegistrar(deps);
      const config = makeConfig({ slack: slackSignal(APP_ID) });

      await registrar.registerWorkspace(WORKSPACE_ID, "/path", config);

      expect(deps.eventManager.enableEvents).toHaveBeenCalledWith(CRED_ID);
    });

    it("skips when no credential wired to workspace (404)", async () => {
      mockByWorkspace404();
      const config = makeConfig({ slack: slackSignal(APP_ID) });

      await registrar.registerWorkspace(WORKSPACE_ID, "/path", config);

      expect(deps.eventManager.enableEvents).not.toHaveBeenCalled();
    });

    it("does not throw when enableEvents rejects (error is logged)", async () => {
      deps = makeDeps({
        eventManager: {
          enableEvents: vi
            .fn<SlackEventManager["enableEvents"]>()
            .mockRejectedValue(new Error("Link events endpoint returned 502")),
          disableEvents: vi.fn<SlackEventManager["disableEvents"]>().mockResolvedValue(undefined),
        },
      });
      registrar = new SlackSignalRegistrar(deps);
      const config = makeConfig({ slack: slackSignal(APP_ID) });

      await expect(
        registrar.registerWorkspace(WORKSPACE_ID, "/path", config),
      ).resolves.toBeUndefined();
    });

    it("skips enableEvents when already enabled for same app_id (restart idempotency)", async () => {
      const config = makeConfig({ slack: slackSignal(APP_ID) });

      await registrar.registerWorkspace(WORKSPACE_ID, "/path", config);
      await registrar.registerWorkspace(WORKSPACE_ID, "/path", config);

      expect(deps.eventManager.enableEvents).toHaveBeenCalledTimes(1);
    });
  });

  describe("unregisterWorkspace", () => {
    it("disables events on unregister", async () => {
      const config = makeConfig({ slack: slackSignal(APP_ID) });
      await registrar.registerWorkspace(WORKSPACE_ID, "/path", config);

      await registrar.unregisterWorkspace(WORKSPACE_ID);

      expect(deps.eventManager.disableEvents).toHaveBeenCalledWith(CRED_ID);
    });

    it("no-ops when workspace was never registered", async () => {
      await registrar.unregisterWorkspace("unknown-workspace");

      expect(deps.eventManager.disableEvents).not.toHaveBeenCalled();
    });

    it("allows re-enabling after unregister", async () => {
      const config = makeConfig({ slack: slackSignal(APP_ID) });
      await registrar.registerWorkspace(WORKSPACE_ID, "/path", config);
      await registrar.unregisterWorkspace(WORKSPACE_ID);

      await registrar.registerWorkspace(WORKSPACE_ID, "/path", config);

      expect(deps.eventManager.enableEvents).toHaveBeenCalledTimes(2);
    });
  });

  describe("shutdown", () => {
    it("clears state so re-registration works after restart", async () => {
      const config = makeConfig({ slack: slackSignal(APP_ID) });
      await registrar.registerWorkspace(WORKSPACE_ID, "/path", config);

      await registrar.shutdown();

      // After shutdown, re-registering should call enableEvents again
      await registrar.registerWorkspace(WORKSPACE_ID, "/path", config);
      expect(deps.eventManager.enableEvents).toHaveBeenCalledTimes(2);
    });
  });
});
