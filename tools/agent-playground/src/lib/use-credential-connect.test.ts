import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock oauth-popup module so we can control popup behavior
vi.mock("./oauth-popup.ts", () => ({
  getOAuthUrl: vi.fn((provider: string) => `https://example.com/oauth/${provider}`),
  getAppInstallUrl: vi.fn((provider: string) => `https://example.com/install/${provider}`),
  listenForOAuthCallback: vi.fn(() => vi.fn()),
  startOAuthFlow: vi.fn(),
  startAppInstallFlow: vi.fn(),
}));

const { useCredentialConnect } = await import("./use-credential-connect.svelte.ts");
const mockedPopup = await import("./oauth-popup.ts");

describe("useCredentialConnect", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("startOAuth opens popup and does not block", () => {
    const connect = useCredentialConnect("github");
    const mockPopup = { closed: false } as Window;
    vi.mocked(mockedPopup.startOAuthFlow).mockReturnValue(mockPopup);

    connect.startOAuth();

    expect(mockedPopup.startOAuthFlow).toHaveBeenCalledWith("github");
    expect(connect.popupBlocked).toBe(false);
  });

  it("startOAuth sets popupBlocked when window.open returns null", () => {
    const connect = useCredentialConnect("github");
    vi.mocked(mockedPopup.startOAuthFlow).mockReturnValue(null);

    connect.startOAuth();

    expect(connect.popupBlocked).toBe(true);
    expect(connect.blockedUrl).toBe("https://example.com/oauth/github");
  });

  it("blockedUrl matches getOAuthUrl output", () => {
    const connect = useCredentialConnect("linear");
    vi.mocked(mockedPopup.startOAuthFlow).mockReturnValue(null);

    connect.startOAuth();

    expect(connect.blockedUrl).toBe("https://example.com/oauth/linear");
  });

  it("startAppInstall sets popupBlocked and blockedUrl when blocked", () => {
    const connect = useCredentialConnect("slack-app");
    vi.mocked(mockedPopup.startAppInstallFlow).mockReturnValue(null);

    connect.startAppInstall();

    expect(connect.popupBlocked).toBe(true);
    expect(connect.blockedUrl).toBe("https://example.com/install/slack-app");
  });

  it("submitApiKey calls PUT with correct body and provider", async () => {
    const connect = useCredentialConnect("openai");
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ id: "cred-123" }), { status: 201 }),
    );

    await connect.submitApiKey("Work Account", { apiKey: "sk-123" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/daemon/api/link/v1/credentials/apikey",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openai",
          label: "Work Account",
          secret: { apiKey: "sk-123" },
        }),
      },
    );
  });

  it("submitApiKey flips submitting state during call", async () => {
    const connect = useCredentialConnect("openai");
    let resolved = false;
    // deno-lint-ignore require-await
    fetchSpy.mockImplementation(async () => {
      expect(connect.submitting).toBe(true);
      resolved = true;
      return new Response(JSON.stringify({ id: "cred-123" }), { status: 201 });
    });

    await connect.submitApiKey("Label", { apiKey: "x" });

    expect(resolved).toBe(true);
    expect(connect.submitting).toBe(false);
  });

  it("submitApiKey sets error on non-200 response", async () => {
    const connect = useCredentialConnect("openai");
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ message: "Invalid API key" }),
        { status: 400 },
      ),
    );

    await connect.submitApiKey("Label", { apiKey: "bad" });

    expect(connect.error).toBe("Invalid API key");
    expect(connect.submitting).toBe(false);
  });

  it("submitApiKey sets error on network failure", async () => {
    const connect = useCredentialConnect("openai");
    fetchSpy.mockRejectedValue(new Error("Network error"));

    await connect.submitApiKey("Label", { apiKey: "x" });

    expect(connect.error).toBe("Network error");
    expect(connect.submitting).toBe(false);
  });

  it("listenForCallback registers and returns cleanup", () => {
    const connect = useCredentialConnect("github");
    const cleanup = connect.listenForCallback(() => {});

    expect(mockedPopup.listenForOAuthCallback).toHaveBeenCalledWith(
      expect.any(Function),
      "github",
    );
    expect(typeof cleanup).toBe("function");
  });
});
