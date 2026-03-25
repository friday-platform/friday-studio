import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TestSlackAppWorkspaceRepository,
  TestStorageAdapter,
  TestWebhookSecretRepository,
} from "../adapters/test-storage.ts";
import { createInternalSlackAppRoutes, createSlackAppRoutes } from "./routes.ts";
import { SlackAppService } from "./service.ts";

describe("Slack App Routes", () => {
  let storage: TestStorageAdapter;
  let workspaceRepo: TestSlackAppWorkspaceRepository;
  let service: SlackAppService;
  let app: Hono;
  const userId = "user-1";

  /** Seed a complete slack-app credential (post-OAuth). */
  async function seedCompleteSlackApp() {
    const slackUserCred = await storage.save(
      {
        type: "oauth",
        provider: "slack-user",
        label: "Team",
        secret: {
          platform: "slack-user",
          access_token: "xoxp-test",
          team_id: "T1",
          team_name: "Team",
          user_id: "U1",
        },
      },
      userId,
    );

    const slackAppCred = await storage.save(
      {
        type: "oauth",
        provider: "slack-app",
        label: "ws-123",
        secret: {
          platform: "slack",
          externalId: "A012ABCD0A0",
          access_token: "xoxb-bot-token",
          slack: {
            clientId: "123.456",
            clientSecret: "cs",
            slackUserCredentialId: slackUserCred.id,
          },
        },
      },
      userId,
    );

    return { slackUserCredId: slackUserCred.id, slackAppCredId: slackAppCred.id };
  }

  beforeEach(() => {
    storage = new TestStorageAdapter();
    workspaceRepo = new TestSlackAppWorkspaceRepository();
    service = new SlackAppService(storage, new TestWebhookSecretRepository(), workspaceRepo);

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("userId" as never, userId);
      c.set("externalBaseUrl" as never, "https://link.example.com");
      await next();
    });
    app.route("/v1/slack-apps", createSlackAppRoutes(service));
    app.route("/internal/v1/slack-apps", createInternalSlackAppRoutes(service));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("DELETE /v1/slack-apps/:credential_id", () => {
    it("deletes app and returns 204", async () => {
      const { slackAppCredId } = await seedCompleteSlackApp();

      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true }))),
      );

      const res = await app.request(`/v1/slack-apps/${slackAppCredId}`, { method: "DELETE" });

      expect(res.status).toBe(204);

      const cred = await storage.get(slackAppCredId, userId);
      expect(cred).toBeNull();
    });

    it("returns 204 for nonexistent credential (idempotent)", async () => {
      const res = await app.request("/v1/slack-apps/nonexistent", { method: "DELETE" });

      expect(res.status).toBe(204);
    });

    it("returns 204 even when Slack API fails (best-effort)", async () => {
      const { slackAppCredId } = await seedCompleteSlackApp();

      vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("network down")));

      const res = await app.request(`/v1/slack-apps/${slackAppCredId}`, { method: "DELETE" });

      expect(res.status).toBe(204);
    });
  });

  describe("GET /internal/v1/slack-apps/by-workspace/:workspace_id", () => {
    it("returns credential and app ID for a wired workspace", async () => {
      const { slackAppCredId } = await seedCompleteSlackApp();
      await workspaceRepo.insert(slackAppCredId, "ws-789");

      const res = await app.request("/internal/v1/slack-apps/by-workspace/ws-789");

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.credential_id).toBe(slackAppCredId);
      expect(body.app_id).toBe("A012ABCD0A0");
    });

    it("returns 404 when no credential is wired to the workspace", async () => {
      const res = await app.request("/internal/v1/slack-apps/by-workspace/nonexistent");

      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("NOT_FOUND");
    });
  });

  describe("GET /internal/v1/slack-apps/unwired", () => {
    it("returns an unwired credential", async () => {
      const { slackAppCredId } = await seedCompleteSlackApp();
      // No workspace mapping inserted — credential is unwired

      const res = await app.request("/internal/v1/slack-apps/unwired");

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.credential_id).toBe(slackAppCredId);
      expect(body.app_id).toBe("A012ABCD0A0");
    });

    it("returns 404 when all credentials are wired", async () => {
      const { slackAppCredId } = await seedCompleteSlackApp();
      await workspaceRepo.insert(slackAppCredId, "ws-789");

      const res = await app.request("/internal/v1/slack-apps/unwired");

      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("NOT_FOUND");
    });
  });

  describe("POST /internal/v1/slack-apps/:credential_id/wire", () => {
    /** Seed a slack-app credential not yet wired to any workspace. */
    async function seedUnwiredSlackApp() {
      const slackUserCred = await storage.save(
        {
          type: "oauth",
          provider: "slack-user",
          label: "Team",
          secret: {
            platform: "slack-user",
            access_token: "xoxp-test",
            team_id: "T1",
            team_name: "Team",
            user_id: "U1",
          },
        },
        userId,
      );

      const slackAppCred = await storage.save(
        {
          type: "oauth",
          provider: "slack-app",
          label: "",
          secret: {
            platform: "slack",
            externalId: "A012ABCD0A0",
            access_token: "xoxb-bot-token",
            slack: {
              clientId: "123.456",
              clientSecret: "cs",
              slackUserCredentialId: slackUserCred.id,
            },
          },
        },
        userId,
      );

      return { slackAppCredId: slackAppCred.id };
    }

    it("wires credential and returns 200", async () => {
      const { slackAppCredId } = await seedUnwiredSlackApp();

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

      const res = await app.request(`/internal/v1/slack-apps/${slackAppCredId}/wire`, {
        method: "POST",
        body: JSON.stringify({
          workspace_id: "ws-456",
          workspace_name: "My Workspace",
          workspace_description: "A cool workspace",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.app_id).toBe("A012ABCD0A0");

      expect(workspaceRepo.getWorkspace(slackAppCredId)).toBe("ws-456");
    });

    it("returns 404 for nonexistent credential", async () => {
      const res = await app.request("/internal/v1/slack-apps/nonexistent/wire", {
        method: "POST",
        body: JSON.stringify({ workspace_id: "ws-1", workspace_name: "WS" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
    });
  });
});
