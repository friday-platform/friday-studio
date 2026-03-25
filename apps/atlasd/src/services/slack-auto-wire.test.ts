import type { WorkspaceConfig } from "@atlas/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackAutoWireDeps } from "./slack-auto-wire.ts";
import { slackSignalMutation, tryAutoWireSlackApp } from "./slack-auto-wire.ts";

const WORKSPACE_ID = "ws-new-123";
const WORKSPACE_NAME = "My Workspace";
const WORKSPACE_DESC = "A test workspace";
const CRED_ID = "cred_slack_1";
const APP_ID = "A0123SLACK";

function makeDeps(overrides?: Partial<SlackAutoWireDeps>): SlackAutoWireDeps {
  return {
    findUnwired: vi.fn<SlackAutoWireDeps["findUnwired"]>().mockResolvedValue(null),
    wireToWorkspace: vi.fn<SlackAutoWireDeps["wireToWorkspace"]>().mockResolvedValue(APP_ID),
    ...overrides,
  };
}

describe("tryAutoWireSlackApp", () => {
  let deps: SlackAutoWireDeps;

  beforeEach(() => {
    deps = makeDeps({
      findUnwired: vi
        .fn<SlackAutoWireDeps["findUnwired"]>()
        .mockResolvedValue({ credentialId: CRED_ID, appId: APP_ID }),
    });
  });

  it("wires unwired credential and returns credential_id + app_id", async () => {
    const result = await tryAutoWireSlackApp(deps, WORKSPACE_ID, WORKSPACE_NAME, WORKSPACE_DESC);

    expect(result).toEqual({ credentialId: CRED_ID, appId: APP_ID });
    expect(deps.wireToWorkspace).toHaveBeenCalledWith(
      CRED_ID,
      WORKSPACE_ID,
      WORKSPACE_NAME,
      WORKSPACE_DESC,
    );
  });

  it("returns null when no unwired credential exists", async () => {
    deps = makeDeps({
      findUnwired: vi.fn<SlackAutoWireDeps["findUnwired"]>().mockResolvedValue(null),
    });

    const result = await tryAutoWireSlackApp(deps, WORKSPACE_ID, WORKSPACE_NAME);

    expect(result).toBeNull();
    expect(deps.wireToWorkspace).not.toHaveBeenCalled();
  });

  it("propagates findUnwired errors", async () => {
    deps = makeDeps({
      findUnwired: vi
        .fn<SlackAutoWireDeps["findUnwired"]>()
        .mockRejectedValue(new Error("Link unwired endpoint returned 500")),
    });

    await expect(tryAutoWireSlackApp(deps, WORKSPACE_ID, WORKSPACE_NAME)).rejects.toThrow(
      "Link unwired endpoint returned 500",
    );
  });

  it("propagates wire endpoint errors", async () => {
    deps.wireToWorkspace = vi
      .fn<SlackAutoWireDeps["wireToWorkspace"]>()
      .mockRejectedValue(new Error("Link wire endpoint returned 500"));

    await expect(tryAutoWireSlackApp(deps, WORKSPACE_ID, WORKSPACE_NAME)).rejects.toThrow(
      "Link wire endpoint returned 500",
    );
  });
});

describe("slackSignalMutation", () => {
  const baseConfig: WorkspaceConfig = {
    version: "1.0",
    workspace: { id: "test-ws", name: "Test" },
  };

  it("creates a slack signal when none exists", () => {
    const mutate = slackSignalMutation("A_NEW");
    const result = mutate(baseConfig);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.signals?.slack).toEqual({
        description: "Slack messages",
        provider: "slack",
        config: { app_id: "A_NEW" },
      });
    }
  });

  it("returns config unchanged when existing app_id matches", () => {
    const config: WorkspaceConfig = {
      ...baseConfig,
      signals: {
        slack: { description: "Slack messages", provider: "slack", config: { app_id: "A_SAME" } },
      },
    };
    const mutate = slackSignalMutation("A_SAME");
    const result = mutate(config);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(config);
    }
  });

  it("updates stale app_id when existing signal has a different app_id", () => {
    const config: WorkspaceConfig = {
      ...baseConfig,
      signals: {
        slack: { description: "Slack messages", provider: "slack", config: { app_id: "A_OLD" } },
      },
    };
    const mutate = slackSignalMutation("A_NEW");
    const result = mutate(config);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.signals?.slack).toEqual({
        description: "Slack messages",
        provider: "slack",
        config: { app_id: "A_NEW" },
      });
      // Should not be the same reference — config was updated
      expect(result.value).not.toBe(config);
    }
  });
});
