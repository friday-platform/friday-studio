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

  it("PATCHes the application with the constructed interactions endpoint URL and bot auth", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "app-123", name: "Test Bot" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    if (!discordProvider.registerWebhook) throw new Error("registerWebhook should be defined");
    await discordProvider.registerWebhook({
      secret: { bot_token: "TOK.EN", public_key: "abc", application_id: "app-123" },
      callbackBaseUrl: "https://tunnel.example.com",
      connectionId: "app-123",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://discord.com/api/v10/applications/app-123");
    expect(init?.method).toBe("PATCH");
    expect(init?.headers?.Authorization).toBe("Bot TOK.EN");
    expect(JSON.parse(init?.body ?? "{}")).toEqual({
      interactions_endpoint_url: "https://tunnel.example.com/platform/discord/app-123",
    });
  });

  it("throws with Discord's message on non-2xx with a JSON error body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "401: Unauthorized", code: 0 }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    if (!discordProvider.registerWebhook) throw new Error("registerWebhook should be defined");
    await expect(
      discordProvider.registerWebhook({
        secret: { bot_token: "TOK.EN", public_key: "abc", application_id: "app-123" },
        callbackBaseUrl: "https://tunnel.example.com",
        connectionId: "app-123",
      }),
    ).rejects.toThrow("Discord set interactions endpoint failed: 401: Unauthorized");
  });

  it("throws with HTTP code when the error body is not JSON", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Service Unavailable", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    if (!discordProvider.registerWebhook) throw new Error("registerWebhook should be defined");
    await expect(
      discordProvider.registerWebhook({
        secret: { bot_token: "TOK.EN", public_key: "abc", application_id: "app-123" },
        callbackBaseUrl: "https://tunnel.example.com",
        connectionId: "app-123",
      }),
    ).rejects.toThrow(/Discord set interactions endpoint failed: HTTP 503/);
  });

  it("rejects when the secret is missing required fields", async () => {
    if (!discordProvider.registerWebhook) throw new Error("registerWebhook should be defined");
    await expect(
      discordProvider.registerWebhook({
        secret: { bot_token: "TOK.EN" },
        callbackBaseUrl: "https://tunnel.example.com",
        connectionId: "app-123",
      }),
    ).rejects.toThrow();
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

  it("PATCHes the application with interactions_endpoint_url: null", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "app-123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    if (!discordProvider.unregisterWebhook) throw new Error("unregisterWebhook should be defined");
    await discordProvider.unregisterWebhook({
      secret: { bot_token: "TOK.EN", public_key: "abc", application_id: "app-123" },
      callbackBaseUrl: "",
      connectionId: "app-123",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://discord.com/api/v10/applications/app-123");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body ?? "{}")).toEqual({ interactions_endpoint_url: null });
  });
});
