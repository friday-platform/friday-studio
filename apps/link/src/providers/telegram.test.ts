import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramProvider } from "./telegram.ts";

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

describe("telegramProvider.registerWebhook", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn<(url: string, init?: FetchInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts setWebhook with the constructed URL and secret_token, then logs success", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    if (!telegramProvider.registerWebhook) throw new Error("registerWebhook should be defined");
    await telegramProvider.registerWebhook({
      secret: { bot_token: "123:ABC", webhook_secret: "s3cret" },
      callbackBaseUrl: "https://tunnel.example.com",
      connectionId: "ABC",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/setWebhook");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body ?? "{}")).toEqual({
      url: "https://tunnel.example.com/platform/telegram/ABC",
      secret_token: "s3cret",
    });
  });

  it("throws with Telegram's description on { ok: false }", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: "Bad Request: invalid url" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    if (!telegramProvider.registerWebhook) throw new Error("registerWebhook should be defined");
    await expect(
      telegramProvider.registerWebhook({
        secret: { bot_token: "123:ABC", webhook_secret: "s3cret" },
        callbackBaseUrl: "https://tunnel.example.com",
        connectionId: "ABC",
      }),
    ).rejects.toThrow("Telegram setWebhook failed: Bad Request: invalid url");
  });

  it("throws on non-2xx HTTP status with HTTP code in the message", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Service Unavailable", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    if (!telegramProvider.registerWebhook) throw new Error("registerWebhook should be defined");
    await expect(
      telegramProvider.registerWebhook({
        secret: { bot_token: "123:ABC", webhook_secret: "s3cret" },
        callbackBaseUrl: "https://tunnel.example.com",
        connectionId: "ABC",
      }),
    ).rejects.toThrow(/Telegram setWebhook failed: HTTP 503/);
  });

  it("rejects when the stored secret is missing webhook_secret", async () => {
    if (!telegramProvider.registerWebhook) throw new Error("registerWebhook should be defined");
    await expect(
      telegramProvider.registerWebhook({
        secret: { bot_token: "123:ABC" },
        callbackBaseUrl: "https://tunnel.example.com",
        connectionId: "ABC",
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("telegramProvider.unregisterWebhook", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn<(url: string, init?: FetchInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts deleteWebhook for the bot_token", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    if (!telegramProvider.unregisterWebhook) throw new Error("unregisterWebhook should be defined");
    await telegramProvider.unregisterWebhook({
      secret: { bot_token: "123:ABC" },
      callbackBaseUrl: "",
      connectionId: "ABC",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/deleteWebhook");
    expect(init?.method).toBe("POST");
  });
});
