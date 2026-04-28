import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discordProvider } from "./discord.ts";

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

describe("discordProvider.registerWebhook", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn<(url: string, init?: FetchInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a no-op that does not call fetch (events flow via Discord Gateway)", async () => {
    if (!discordProvider.registerWebhook) throw new Error("registerWebhook should be defined");
    await discordProvider.registerWebhook({
      secret: { bot_token: "TOK.EN", public_key: "abc", application_id: "app-123" },
      callbackBaseUrl: "https://tunnel.example.com",
      connectionId: "app-123",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("discordProvider.unregisterWebhook", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn<(url: string, init?: FetchInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a no-op that does not call fetch", async () => {
    if (!discordProvider.unregisterWebhook) throw new Error("unregisterWebhook should be defined");
    await discordProvider.unregisterWebhook({
      secret: { bot_token: "TOK.EN", public_key: "abc", application_id: "app-123" },
      callbackBaseUrl: "",
      connectionId: "app-123",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("discordProvider.secretSchema", () => {
  it("rejects when required fields are missing", () => {
    const result = discordProvider.secretSchema.safeParse({ bot_token: "TOK.EN" });
    expect(result.success).toBe(false);
  });

  it("accepts a complete secret", () => {
    const result = discordProvider.secretSchema.safeParse({
      bot_token: "TOK.EN",
      public_key: "abc",
      application_id: "app-123",
    });
    expect(result.success).toBe(true);
  });
});
