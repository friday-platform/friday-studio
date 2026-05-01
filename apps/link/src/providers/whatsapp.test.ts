import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsappSecretSchema, whatsappProvider } from "./whatsapp.ts";

describe("whatsappProvider.secretSchema", () => {
  it("accepts the three user-typed fields", () => {
    const result = WhatsappSecretSchema.safeParse({
      access_token: "EAA...",
      app_secret: "shhh",
      phone_number_id: "1234567890",
    });
    expect(result.success).toBe(true);
  });

  it("rejects when required fields are missing", () => {
    const result = WhatsappSecretSchema.safeParse({ access_token: "EAA..." });
    expect(result.success).toBe(false);
  });
});

describe("whatsappProvider.autoFields", () => {
  it("generates a 64-char hex verify_token", () => {
    if (!whatsappProvider.autoFields) throw new Error("autoFields should be defined");
    const fields = whatsappProvider.autoFields();
    expect(fields).toHaveProperty("verify_token");
    expect(typeof fields.verify_token).toBe("string");
    expect(fields.verify_token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different verify_token on each call", () => {
    if (!whatsappProvider.autoFields) throw new Error("autoFields should be defined");
    const a = whatsappProvider.autoFields().verify_token;
    const b = whatsappProvider.autoFields().verify_token;
    expect(a).not.toBe(b);
  });
});

describe("whatsappProvider.registerWebhook", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn<(url: string) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a no-op (Meta subscription requires fields not in schema) and does not call fetch", async () => {
    if (!whatsappProvider.registerWebhook) throw new Error("registerWebhook should be defined");
    await expect(
      whatsappProvider.registerWebhook({
        secret: {
          access_token: "EAA...",
          app_secret: "shhh",
          phone_number_id: "1234567890",
          verify_token: "deadbeef",
        },
        callbackBaseUrl: "https://tunnel.example.com",
        connectionId: "1234567890",
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("whatsappProvider.unregisterWebhook", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn<(url: string) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a no-op and does not call fetch", async () => {
    if (!whatsappProvider.unregisterWebhook) throw new Error("unregisterWebhook should be defined");
    await expect(
      whatsappProvider.unregisterWebhook({
        secret: {
          access_token: "EAA...",
          app_secret: "shhh",
          phone_number_id: "1234567890",
          verify_token: "deadbeef",
        },
        callbackBaseUrl: "",
        connectionId: "1234567890",
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
