import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TestCommunicatorWiringRepository, TestStorageAdapter } from "../adapters/test-storage.ts";
import { ProviderRegistry } from "../providers/registry.ts";
import { defineApiKeyProvider } from "../providers/types.ts";
import { createCommunicatorRoutes } from "./communicator.ts";

describe("Communicator Routes", () => {
  let storage: TestStorageAdapter;
  let wiringRepo: TestCommunicatorWiringRepository;
  let registry: ProviderRegistry;
  let app: Hono;
  const userId = "user-1";

  beforeEach(() => {
    storage = new TestStorageAdapter();
    wiringRepo = new TestCommunicatorWiringRepository();
    registry = new ProviderRegistry();

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("userId" as never, userId);
      c.set("externalBaseUrl" as never, "https://link.example.com");
      await next();
    });
    app.route("/internal/v1/communicator", createCommunicatorRoutes(wiringRepo, storage, registry));
  });

  describe("POST /internal/v1/communicator/wire", () => {
    it("inserts a wiring row and returns { ok: true }", async () => {
      const res = await app.request("/internal/v1/communicator/wire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: "ws-tg",
          provider: "telegram",
          credential_id: "cred-tg",
          connection_id: "cred-tg",
          callback_base_url: "https://tunnel.example.com",
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ ok: true });

      const wiring = await wiringRepo.findByWorkspaceAndProvider(userId, "ws-tg", "telegram");
      expect(wiring).toEqual({ credentialId: "cred-tg", identifier: "cred-tg" });
    });

    it("upserts on conflict — second wire replaces the credential id", async () => {
      const post = (credentialId: string) =>
        app.request("/internal/v1/communicator/wire", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_id: "ws-tg",
            provider: "telegram",
            credential_id: credentialId,
            connection_id: credentialId,
            callback_base_url: "https://tunnel.example.com",
          }),
        });

      const first = await post("cred-old");
      expect(first.status).toBe(200);
      const second = await post("cred-new");
      expect(second.status).toBe(200);

      const wiring = await wiringRepo.findByWorkspaceAndProvider(userId, "ws-tg", "telegram");
      expect(wiring).toEqual({ credentialId: "cred-new", identifier: "cred-new" });
    });

    it("returns 400 when a required field is missing", async () => {
      const res = await app.request("/internal/v1/communicator/wire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: "ws-tg",
          provider: "telegram",
          credential_id: "cred-tg",
          // connection_id intentionally omitted
          callback_base_url: "https://tunnel.example.com",
        }),
      });

      expect(res.status).toBe(400);
    });

    it("succeeds when provider has no registerWebhook (backward compat)", async () => {
      registry.register(
        defineApiKeyProvider({
          id: "no-hook",
          displayName: "No Hook",
          description: "test",
          secretSchema: z.object({ api_key: z.string() }),
          setupInstructions: "",
        }),
      );
      const cred = await storage.save(
        { type: "apikey", provider: "no-hook", label: "k", secret: { api_key: "x" } },
        userId,
      );

      const res = await app.request("/internal/v1/communicator/wire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: "ws-1",
          provider: "no-hook",
          credential_id: cred.id,
          connection_id: cred.id,
          callback_base_url: "https://tunnel.example.com",
        }),
      });

      expect(res.status).toBe(200);
    });

    it("rolls back the wiring when registerWebhook throws and returns 500", async () => {
      const registerWebhook = vi.fn(() => Promise.reject(new Error("upstream platform refused")));
      registry.register(
        defineApiKeyProvider({
          id: "throwing",
          displayName: "Throwing",
          description: "test",
          secretSchema: z.object({ api_key: z.string() }),
          setupInstructions: "",
          registerWebhook,
        }),
      );
      const cred = await storage.save(
        { type: "apikey", provider: "throwing", label: "k", secret: { api_key: "x" } },
        userId,
      );

      const res = await app.request("/internal/v1/communicator/wire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: "ws-fail",
          provider: "throwing",
          credential_id: cred.id,
          connection_id: cred.id,
          callback_base_url: "https://tunnel.example.com",
        }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("upstream platform refused");
      expect(registerWebhook).toHaveBeenCalledTimes(1);

      const wiring = await wiringRepo.findByWorkspaceAndProvider(userId, "ws-fail", "throwing");
      expect(wiring).toEqual(null);
    });

    it("invokes registerWebhook with credential secret + connection metadata", async () => {
      const registerWebhook = vi.fn(async () => {});
      registry.register(
        defineApiKeyProvider({
          id: "hooky",
          displayName: "Hooky",
          description: "test",
          secretSchema: z.object({ api_key: z.string() }),
          setupInstructions: "",
          registerWebhook,
        }),
      );
      const cred = await storage.save(
        { type: "apikey", provider: "hooky", label: "k", secret: { api_key: "abc" } },
        userId,
      );

      const res = await app.request("/internal/v1/communicator/wire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: "ws-h",
          provider: "hooky",
          credential_id: cred.id,
          connection_id: "conn-1",
          callback_base_url: "https://tunnel.example.com",
        }),
      });

      expect(res.status).toBe(200);
      expect(registerWebhook).toHaveBeenCalledWith({
        secret: { api_key: "abc" },
        callbackBaseUrl: "https://tunnel.example.com",
        connectionId: "conn-1",
      });
    });
  });

  describe("POST /internal/v1/communicator/disconnect", () => {
    it("removes the wiring even when unregisterWebhook throws (best-effort)", async () => {
      const unregisterWebhook = vi.fn(() => Promise.reject(new Error("platform unreachable")));
      registry.register(
        defineApiKeyProvider({
          id: "throwing-disc",
          displayName: "ThrowingDisc",
          description: "test",
          secretSchema: z.object({ api_key: z.string() }),
          setupInstructions: "",
          unregisterWebhook,
        }),
      );
      const cred = await storage.save(
        { type: "apikey", provider: "throwing-disc", label: "k", secret: { api_key: "x" } },
        userId,
      );
      await wiringRepo.insert(userId, cred.id, "ws-d", "throwing-disc", "conn-d");

      const res = await app.request("/internal/v1/communicator/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: "ws-d", provider: "throwing-disc" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { credential_id: string | null };
      expect(body.credential_id).toEqual(cred.id);
      expect(unregisterWebhook).toHaveBeenCalledTimes(1);

      const wiring = await wiringRepo.findByWorkspaceAndProvider(userId, "ws-d", "throwing-disc");
      expect(wiring).toEqual(null);
    });
  });

  describe("GET /internal/v1/communicator/wiring", () => {
    it("returns 200 { wiring: null } when no wiring exists for the workspace", async () => {
      const res = await app.request(
        "/internal/v1/communicator/wiring?workspace_id=ws-unwired&provider=slack",
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ wiring: null });
    });

    it("returns 200 with wiring details when the workspace is wired", async () => {
      await wiringRepo.insert(userId, "cred-abc", "ws-wired", "slack", "conn-xyz");

      const res = await app.request(
        "/internal/v1/communicator/wiring?workspace_id=ws-wired&provider=slack",
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ wiring: { credential_id: "cred-abc", connection_id: "conn-xyz" } });
    });

    it("returns 200 { workspace_ids: [...] } in list mode when no params are given", async () => {
      await wiringRepo.insert(userId, "cred-1", "ws-a", "slack", "conn-1");
      await wiringRepo.insert(userId, "cred-2", "ws-b", "slack", "conn-2");

      const res = await app.request("/internal/v1/communicator/wiring");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { workspace_ids: string[] };
      expect(body.workspace_ids.sort()).toEqual(["ws-a", "ws-b"]);
    });
  });
});
