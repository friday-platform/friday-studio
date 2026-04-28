import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackSecretSchema, slackProvider } from "./slack.ts";

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

describe("slackProvider.secretSchema", () => {
  it("parses a valid {bot_token, signing_secret, app_id}", () => {
    const parsed = SlackSecretSchema.parse({
      bot_token: "xoxb-123",
      signing_secret: "sec",
      app_id: "A0ABC",
    });
    expect(parsed).toEqual({ bot_token: "xoxb-123", signing_secret: "sec", app_id: "A0ABC" });
  });

  it("rejects missing fields", () => {
    expect(() =>
      SlackSecretSchema.parse({ bot_token: "xoxb-123", signing_secret: "sec" }),
    ).toThrow();
  });

  it("rejects empty strings", () => {
    expect(() =>
      SlackSecretSchema.parse({ bot_token: "", signing_secret: "sec", app_id: "A0ABC" }),
    ).toThrow();
  });
});

describe("slackProvider.registerWebhook", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn<(url: string, init?: FetchInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts auth.test with bearer auth and resolves on { ok: true }", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, team_id: "T123", team: "acme" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    if (!slackProvider.registerWebhook) throw new Error("registerWebhook should be defined");
    await slackProvider.registerWebhook({
      secret: { bot_token: "xoxb-123", signing_secret: "sec", app_id: "A0ABC" },
      callbackBaseUrl: "https://tunnel.example.com",
      connectionId: "A0ABC",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://slack.com/api/auth.test");
    expect(init?.method).toBe("POST");
    expect(init?.headers?.Authorization).toBe("Bearer xoxb-123");
    expect(init?.body).toBeUndefined();
  });

  it("throws with Slack's error code on { ok: false }", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    if (!slackProvider.registerWebhook) throw new Error("registerWebhook should be defined");
    await expect(
      slackProvider.registerWebhook({
        secret: { bot_token: "xoxb-bad", signing_secret: "sec", app_id: "A0ABC" },
        callbackBaseUrl: "https://tunnel.example.com",
        connectionId: "A0ABC",
      }),
    ).rejects.toThrow("Slack auth.test failed: invalid_auth");
  });

  it("throws on non-2xx HTTP status with HTTP code in the message", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Service Unavailable", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    if (!slackProvider.registerWebhook) throw new Error("registerWebhook should be defined");
    await expect(
      slackProvider.registerWebhook({
        secret: { bot_token: "xoxb-123", signing_secret: "sec", app_id: "A0ABC" },
        callbackBaseUrl: "https://tunnel.example.com",
        connectionId: "A0ABC",
      }),
    ).rejects.toThrow(/Slack auth.test failed: HTTP 503/);
  });

  it("rejects when the stored secret is missing required fields", async () => {
    if (!slackProvider.registerWebhook) throw new Error("registerWebhook should be defined");
    await expect(
      slackProvider.registerWebhook({
        secret: { bot_token: "xoxb-123" },
        callbackBaseUrl: "https://tunnel.example.com",
        connectionId: "A0ABC",
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("slackProvider.unregisterWebhook", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn<(url: string, init?: FetchInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a no-op (does not call fetch)", async () => {
    if (!slackProvider.unregisterWebhook) throw new Error("unregisterWebhook should be defined");
    await slackProvider.unregisterWebhook({
      secret: { bot_token: "xoxb-123", signing_secret: "sec", app_id: "A0ABC" },
      callbackBaseUrl: "",
      connectionId: "A0ABC",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
