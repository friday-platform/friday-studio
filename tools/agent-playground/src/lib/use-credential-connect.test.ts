import { describe, expect, it, vi } from "vitest";

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
    const connect = useCredentialConnect("slack");
    vi.mocked(mockedPopup.startAppInstallFlow).mockReturnValue(null);

    connect.startAppInstall();

    expect(connect.popupBlocked).toBe(true);
    expect(connect.blockedUrl).toBe("https://example.com/install/slack");
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
