import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTunnelUrl } from "./communicator-wiring.ts";

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
