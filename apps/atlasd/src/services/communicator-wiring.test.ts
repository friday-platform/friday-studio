import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveConnectionId, resolveTunnelUrl } from "./communicator-wiring.ts";

const mockFetchLinkCredential = vi.hoisted(() =>
  vi.fn<
    (
      credentialId: string,
      logger: unknown,
    ) => Promise<{ id: string; provider: string; type: string; secret: Record<string, unknown> }>
  >(),
);

vi.mock("@atlas/core/mcp-registry/credential-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@atlas/core/mcp-registry/credential-resolver")>()),
  fetchLinkCredential: mockFetchLinkCredential,
}));

describe("resolveTunnelUrl", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn<(url: string) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the public tunnel URL from /status", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ url: "https://abc-tunnel.cloudflare.example.com", secret: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const url = await resolveTunnelUrl();
    expect(url).toBe("https://abc-tunnel.cloudflare.example.com");
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:9090/status");
  });

  it("throws a clear error when the tunnel is unreachable (network error)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(resolveTunnelUrl()).rejects.toThrow(/Public tunnel not available/);
  });

  it("throws when /status responds with a non-2xx status", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 503 }));

    await expect(resolveTunnelUrl()).rejects.toThrow(/Public tunnel not available.*503/);
  });

  it("throws when /status returns null url (tunnel reachable but not provisioned)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ url: null, secret: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(resolveTunnelUrl()).rejects.toThrow(/no public URL provisioned yet/);
  });
});

describe("deriveConnectionId", () => {
  beforeEach(() => {
    mockFetchLinkCredential.mockReset();
  });

  it("telegram → returns the post-colon segment of bot_token", async () => {
    mockFetchLinkCredential.mockResolvedValueOnce({
      id: "cred-1",
      provider: "telegram",
      type: "apikey",
      secret: { bot_token: "1234567:AbCdEf-GhIjK", webhook_secret: "wh-secret" },
    });

    const result = await deriveConnectionId("telegram", "cred-1");
    expect(result).toBe("AbCdEf-GhIjK");
  });

  it("telegram → throws when bot_token has no colon", async () => {
    mockFetchLinkCredential.mockResolvedValueOnce({
      id: "cred-1",
      provider: "telegram",
      type: "apikey",
      secret: { bot_token: "no-colon-here", webhook_secret: "wh-secret" },
    });

    await expect(deriveConnectionId("telegram", "cred-1")).rejects.toThrow(
      /Invalid telegram bot_token format/,
    );
  });

  it("discord → returns application_id", async () => {
    mockFetchLinkCredential.mockResolvedValueOnce({
      id: "cred-d",
      provider: "discord",
      type: "apikey",
      secret: { bot_token: "TOK", public_key: "pk", application_id: "app-987" },
    });

    const result = await deriveConnectionId("discord", "cred-d");
    expect(result).toBe("app-987");
  });

  it("discord → throws when application_id is missing", async () => {
    mockFetchLinkCredential.mockResolvedValueOnce({
      id: "cred-d",
      provider: "discord",
      type: "apikey",
      secret: { bot_token: "TOK", public_key: "pk" },
    });

    await expect(deriveConnectionId("discord", "cred-d")).rejects.toThrow();
  });

  it("teams → returns app_id", async () => {
    mockFetchLinkCredential.mockResolvedValueOnce({
      id: "cred-t",
      provider: "teams",
      type: "apikey",
      secret: {
        app_id: "00000000-0000-0000-0000-000000000000",
        app_password: "p",
        app_tenant_id: "t",
        app_type: "MultiTenant",
      },
    });

    const result = await deriveConnectionId("teams", "cred-t");
    expect(result).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("whatsapp → returns phone_number_id", async () => {
    mockFetchLinkCredential.mockResolvedValueOnce({
      id: "cred-w",
      provider: "whatsapp",
      type: "apikey",
      secret: {
        access_token: "EAA...",
        app_secret: "shhh",
        phone_number_id: "1234567890",
        verify_token: "v",
      },
    });

    const result = await deriveConnectionId("whatsapp", "cred-w");
    expect(result).toBe("1234567890");
  });
});
