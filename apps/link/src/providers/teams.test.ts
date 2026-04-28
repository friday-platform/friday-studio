import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamsSecretSchema, teamsProvider } from "./teams.ts";

describe("teamsProvider.secretSchema", () => {
  it("accepts a fully populated secret", () => {
    const result = TeamsSecretSchema.safeParse({
      app_id: "00000000-0000-0000-0000-000000000000",
      app_password: "secret",
      app_tenant_id: "tenant-1",
      app_type: "MultiTenant",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown app_type", () => {
    const result = TeamsSecretSchema.safeParse({
      app_id: "00000000-0000-0000-0000-000000000000",
      app_password: "secret",
      app_tenant_id: "tenant-1",
      app_type: "InvalidType",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when required fields are missing", () => {
    const result = TeamsSecretSchema.safeParse({ app_id: "x" });
    expect(result.success).toBe(false);
  });
});

describe("teamsProvider.registerWebhook", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn<(url: string) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a no-op (Azure ARM auth not yet implemented) and does not call fetch", async () => {
    if (!teamsProvider.registerWebhook) throw new Error("registerWebhook should be defined");
    await expect(
      teamsProvider.registerWebhook({
        secret: {
          app_id: "00000000-0000-0000-0000-000000000000",
          app_password: "secret",
          app_tenant_id: "tenant-1",
          app_type: "MultiTenant",
        },
        callbackBaseUrl: "https://tunnel.example.com",
        connectionId: "00000000-0000-0000-0000-000000000000",
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("teamsProvider.unregisterWebhook", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn<(url: string) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a no-op and does not call fetch", async () => {
    if (!teamsProvider.unregisterWebhook) throw new Error("unregisterWebhook should be defined");
    await expect(
      teamsProvider.unregisterWebhook({
        secret: {
          app_id: "00000000-0000-0000-0000-000000000000",
          app_password: "secret",
          app_tenant_id: "tenant-1",
          app_type: "MultiTenant",
        },
        callbackBaseUrl: "",
        connectionId: "00000000-0000-0000-0000-000000000000",
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
