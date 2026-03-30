import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TestSlackAppWorkspaceRepository,
  TestStorageAdapter,
  TestWebhookSecretRepository,
} from "../adapters/test-storage.ts";
import { PENDING_TOKEN } from "./manifest.ts";
import { SlackAppService } from "./service.ts";

describe("SlackAppService", () => {
  let storage: TestStorageAdapter;
  let webhookSecrets: TestWebhookSecretRepository;
  let workspaceRepo: TestSlackAppWorkspaceRepository;
  let service: SlackAppService;
  const userId = "user-1";
  let slackUserCredId: string;

  /** Seed a slack-app credential directly (replaces removed service.createApp). */
  async function seedSlackApp(opts?: { label?: string; accessToken?: string }) {
    const { id } = await storage.save(
      {
        type: "oauth",
        provider: "slack-app",
        label: opts?.label ?? "",
        secret: {
          platform: "slack",
          externalId: "A012ABCD0A0",
          access_token: opts?.accessToken ?? PENDING_TOKEN,
          slack: {
            clientId: "1234567890.1234567890",
            clientSecret: "secret-abc",
            slackUserCredentialId: slackUserCredId,
          },
        },
      },
      userId,
    );
    await webhookSecrets.insert("A012ABCD0A0", userId, "signing-xyz");
    return id;
  }

  beforeEach(async () => {
    storage = new TestStorageAdapter();
    webhookSecrets = new TestWebhookSecretRepository();
    workspaceRepo = new TestSlackAppWorkspaceRepository();
    service = new SlackAppService(storage, webhookSecrets, workspaceRepo);

    const { id } = await storage.save(
      {
        type: "oauth",
        provider: "slack-user",
        label: "Test Team",
        secret: {
          platform: "slack-user",
          access_token: "xoxp-test-token",
          team_id: "T024BE7LD",
          team_name: "Test Team",
          user_id: "U01234",
        },
      },
      userId,
    );
    slackUserCredId = id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("updateEventSubscriptions", () => {
    let slackAppCredentialId: string;

    beforeEach(async () => {
      slackAppCredentialId = await seedSlackApp({ accessToken: "xoxb-bot-token" });
    });

    it("enables event subscriptions and returns webhook URL", async () => {
      const exportManifest = {
        ok: true,
        manifest: {
          display_information: { name: "test" },
          settings: { org_deploy_enabled: false },
        },
      };
      const updateOk = { ok: true };

      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(JSON.stringify(exportManifest)))
          .mockResolvedValueOnce(new Response(JSON.stringify(updateOk))),
      );

      const result = await service.updateEventSubscriptions(
        slackAppCredentialId,
        userId,
        true,
        "https://gateway.example.com",
      );

      expect(result).toEqual({
        status: "enabled",
        webhookUrl: "https://gateway.example.com/webhook/slack/user-1/A012ABCD0A0",
      });

      const updateCall = vi.mocked(fetch).mock.calls[1];
      expect(updateCall).toBeDefined();
      expect(updateCall?.[0]).toBe("https://slack.com/api/apps.manifest.update");
      const body = JSON.parse(updateCall?.[1]?.body as string) as {
        manifest: { settings: { event_subscriptions: unknown } };
      };
      expect(body.manifest.settings.event_subscriptions).toMatchObject({
        request_url: "https://gateway.example.com/webhook/slack/user-1/A012ABCD0A0",
        bot_events: ["message.im", "app_mention"],
      });
    });

    it("disables event subscriptions", async () => {
      const exportManifest = {
        ok: true,
        manifest: {
          settings: { event_subscriptions: { request_url: "https://old.url", bot_events: [] } },
        },
      };
      const updateOk = { ok: true };

      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(JSON.stringify(exportManifest)))
          .mockResolvedValueOnce(new Response(JSON.stringify(updateOk))),
      );

      const result = await service.updateEventSubscriptions(slackAppCredentialId, userId, false);

      expect(result).toEqual({ status: "disabled" });

      const updateCall = vi.mocked(fetch).mock.calls[1];
      expect(updateCall).toBeDefined();
      const body = JSON.parse(updateCall?.[1]?.body as string) as {
        manifest: { settings: Record<string, unknown> };
      };
      expect(body.manifest.settings).not.toHaveProperty("event_subscriptions");
    });

    it("returns pending for pending credential", async () => {
      const pendingId = await seedSlackApp({ label: "ws-pending" });

      const result = await service.updateEventSubscriptions(
        pendingId,
        userId,
        true,
        "https://gw.example.com",
      );
      expect(result).toEqual({ status: "pending" });
    });

    it("throws SLACK_API_ERROR when manifest update returns ok: false", async () => {
      const exportManifest = {
        ok: true,
        manifest: {
          display_information: { name: "test" },
          settings: { org_deploy_enabled: false },
        },
      };
      const updateFail = { ok: false, error: "request_url_not_verified" };

      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(JSON.stringify(exportManifest)))
          .mockResolvedValueOnce(new Response(JSON.stringify(updateFail))),
      );

      await expect(
        service.updateEventSubscriptions(
          slackAppCredentialId,
          userId,
          true,
          "https://gw.example.com",
        ),
      ).rejects.toMatchObject({
        code: "SLACK_API_ERROR",
        message: expect.stringContaining("request_url_not_verified"),
      });
    });

    it("throws CREDENTIAL_NOT_FOUND for nonexistent credential", async () => {
      await expect(
        service.updateEventSubscriptions("nonexistent", userId, true, "https://gw.example.com"),
      ).rejects.toMatchObject({ code: "CREDENTIAL_NOT_FOUND" });
    });
  });

  describe("wireToWorkspace", () => {
    let slackAppCredentialId: string;

    beforeEach(async () => {
      slackAppCredentialId = await seedSlackApp();
    });

    it("exports current manifest then updates only display fields", async () => {
      const exportManifest = {
        ok: true,
        manifest: {
          display_information: { name: "Friday ab12" },
          features: { bot_user: { display_name: "friday_ab12", always_online: true } },
          oauth_config: {
            redirect_urls: ["https://link.example.com/v1/callback/slack-app"],
            scopes: { bot: ["chat:write"] },
          },
          settings: { org_deploy_enabled: false },
        },
      };
      const updateOk = { ok: true };

      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(JSON.stringify(exportManifest)))
          .mockResolvedValueOnce(new Response(JSON.stringify(updateOk))),
      );

      await service.wireToWorkspace(
        slackAppCredentialId,
        userId,
        "ws-123",
        "My Workspace",
        "A test workspace",
      );

      expect(workspaceRepo.getWorkspace(slackAppCredentialId)).toBe("ws-123");

      const exportCall = vi.mocked(fetch).mock.calls[0];
      expect(exportCall?.[0]).toBe("https://slack.com/api/apps.manifest.export");

      // Manifest update must preserve existing fields (redirect_urls) while updating display
      const updateCall = vi.mocked(fetch).mock.calls[1];
      expect(updateCall?.[0]).toBe("https://slack.com/api/apps.manifest.update");
      const body = JSON.parse(updateCall?.[1]?.body as string) as {
        app_id: string;
        manifest: {
          display_information: { name: string; description: string };
          features: { bot_user: { display_name: string; always_online: boolean } };
          oauth_config: { redirect_urls: string[] };
        };
      };
      expect(body.app_id).toBe("A012ABCD0A0");
      expect(body.manifest.display_information.name).toBe("My Workspace");
      expect(body.manifest.display_information.description).toBe("A test workspace");
      expect(body.manifest.features.bot_user.display_name).toBe("my_workspace");
      expect(body.manifest.features.bot_user.always_online).toBe(true);
      // Critical: redirect_urls preserved from exported manifest
      expect(body.manifest.oauth_config.redirect_urls).toEqual([
        "https://link.example.com/v1/callback/slack-app",
      ]);
    });

    it("works on pending credential", async () => {
      const exportResp = {
        ok: true,
        manifest: {
          display_information: { name: "old" },
          features: { bot_user: { display_name: "old" } },
        },
      };
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(JSON.stringify(exportResp)))
          .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }))),
      );

      await service.wireToWorkspace(slackAppCredentialId, userId, "ws-pending", "Pending WS");

      expect(workspaceRepo.getWorkspace(slackAppCredentialId)).toBe("ws-pending");
    });

    it("works on completed credential", async () => {
      const cred = await storage.get(slackAppCredentialId, userId);
      if (cred) {
        await storage.update(
          slackAppCredentialId,
          { ...cred, secret: { ...cred.secret, access_token: "xoxb-bot-token" } },
          userId,
        );
      }

      const exportResp = {
        ok: true,
        manifest: {
          display_information: { name: "old" },
          features: { bot_user: { display_name: "old" } },
        },
      };
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(JSON.stringify(exportResp)))
          .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }))),
      );

      await service.wireToWorkspace(slackAppCredentialId, userId, "ws-done", "Done WS");

      expect(workspaceRepo.getWorkspace(slackAppCredentialId)).toBe("ws-done");
    });

    it("throws SLACK_API_ERROR when manifest update returns ok: false", async () => {
      const exportResp = {
        ok: true,
        manifest: {
          display_information: { name: "old" },
          features: { bot_user: { display_name: "old" } },
        },
      };
      const updateFail = { ok: false, error: "invalid_manifest" };

      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(JSON.stringify(exportResp)))
          .mockResolvedValueOnce(new Response(JSON.stringify(updateFail))),
      );

      await expect(
        service.wireToWorkspace(slackAppCredentialId, userId, "ws-1", "WS"),
      ).rejects.toMatchObject({
        code: "SLACK_API_ERROR",
        message: expect.stringContaining("invalid_manifest"),
      });
    });

    it("throws CREDENTIAL_NOT_FOUND for nonexistent credential", async () => {
      await expect(
        service.wireToWorkspace("nonexistent", userId, "ws-1", "WS"),
      ).rejects.toMatchObject({ code: "CREDENTIAL_NOT_FOUND" });
    });
  });

  describe("deleteApp", () => {
    let slackAppCredentialId: string;

    beforeEach(async () => {
      slackAppCredentialId = await seedSlackApp();
      await workspaceRepo.insert(slackAppCredentialId, "ws-to-delete");
    });

    it("deletes app via Slack API and removes credential, webhook secret, and workspace mapping", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true }))),
      );

      await service.deleteApp(slackAppCredentialId, userId);

      const cred = await storage.get(slackAppCredentialId, userId);
      expect(cred).toBeNull();
      expect(webhookSecrets.getSecret("A012ABCD0A0")).toBeUndefined();
      expect(workspaceRepo.getWorkspace(slackAppCredentialId)).toBeUndefined();

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall).toBeDefined();
      expect(fetchCall?.[0]).toBe("https://slack.com/api/apps.manifest.delete");
      const body = JSON.parse(fetchCall?.[1]?.body as string) as Record<string, unknown>;
      expect(body.app_id).toBe("A012ABCD0A0");
    });

    it("returns silently for nonexistent credential (idempotent)", async () => {
      await expect(service.deleteApp("nonexistent", userId)).resolves.toBeUndefined();
    });

    it("continues with local deletion when Slack API fails", async () => {
      vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("network down")));

      await service.deleteApp(slackAppCredentialId, userId);

      const cred = await storage.get(slackAppCredentialId, userId);
      expect(cred).toBeNull();
    });

    it("continues when slack user credential is deleted", async () => {
      await storage.delete(slackUserCredId, userId);

      await service.deleteApp(slackAppCredentialId, userId);

      const cred = await storage.get(slackAppCredentialId, userId);
      expect(cred).toBeNull();
    });
  });

  describe("deleteAppByAppId", () => {
    let slackAppCredentialId: string;

    beforeEach(async () => {
      slackAppCredentialId = await seedSlackApp();
    });

    it("resolves app_id to credential and deletes it", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true }))),
      );

      await service.deleteAppByAppId("A012ABCD0A0", userId);

      const cred = await storage.get(slackAppCredentialId, userId);
      expect(cred).toBeNull();
    });

    it("no-ops when no credential found for app_id", async () => {
      await expect(service.deleteAppByAppId("A_NONEXISTENT", userId)).resolves.toBeUndefined();
    });
  });
});
