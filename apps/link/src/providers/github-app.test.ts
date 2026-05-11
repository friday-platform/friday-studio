import * as jose from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GithubAppSecretSchema, githubAppProvider } from "./github-app.ts";

type FetchInit = { method?: string; headers?: Record<string, string> };

let validPrivateKeyPkcs8Pem: string;

beforeAll(async () => {
  // Generate a real RSA keypair so signAppJwt() exercises the actual signing
  // path. PKCS8 (BEGIN PRIVATE KEY) is what jose.exportPKCS8 emits — covers
  // the modern format. The PKCS1 fallback path in signAppJwt is exercised
  // implicitly when an operator pastes a downloaded GitHub App PEM.
  const pair = await jose.generateKeyPair("RS256", { extractable: true });
  validPrivateKeyPkcs8Pem = await jose.exportPKCS8(pair.privateKey);
});

describe("githubAppProvider.secretSchema", () => {
  it("parses a valid {app_id, private_key, webhook_secret, installation_id}", () => {
    const parsed = GithubAppSecretSchema.parse({
      app_id: 12345,
      private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      webhook_secret: "shhh",
      installation_id: 67890,
    });
    expect(parsed.app_id).toBe(12345);
    expect(parsed.installation_id).toBe(67890);
  });

  it("accepts PKCS1 PEM headers (BEGIN RSA PRIVATE KEY)", () => {
    const result = GithubAppSecretSchema.safeParse({
      app_id: 1,
      private_key: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
      webhook_secret: "x",
      installation_id: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects malformed PEM (no BEGIN header)", () => {
    const result = GithubAppSecretSchema.safeParse({
      app_id: 1,
      private_key: "not-a-pem",
      webhook_secret: "x",
      installation_id: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative app_id", () => {
    const result = GithubAppSecretSchema.safeParse({
      app_id: -1,
      private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      webhook_secret: "x",
      installation_id: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer app_id", () => {
    const result = GithubAppSecretSchema.safeParse({
      app_id: 1.5,
      private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      webhook_secret: "x",
      installation_id: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing fields", () => {
    const result = GithubAppSecretSchema.safeParse({
      app_id: 1,
      private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      webhook_secret: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty webhook_secret", () => {
    const result = GithubAppSecretSchema.safeParse({
      app_id: 1,
      private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      webhook_secret: "",
      installation_id: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe("githubAppProvider.health", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn<(url: string, init?: FetchInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockJsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("captures bot_user_slug and bot_user_id on ok health", async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse(200, { slug: "friday-bot" }));
    fetchMock.mockResolvedValueOnce(mockJsonResponse(200, { id: 99001 }));
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(200, { id: 12345678, login: "friday-bot[bot]" }),
    );

    if (!githubAppProvider.health) throw new Error("health should be defined");
    const result = await githubAppProvider.health({
      app_id: 100,
      private_key: validPrivateKeyPkcs8Pem,
      webhook_secret: "secret",
      installation_id: 99001,
    });

    expect(result).toEqual({
      healthy: true,
      metadata: { bot_user_slug: "friday-bot", bot_user_id: 12345678 },
    });

    // Verify the 3-call sequence
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [appUrl, appInit] = fetchMock.mock.calls[0] ?? [];
    const [installUrl] = fetchMock.mock.calls[1] ?? [];
    const [userUrl, userInit] = fetchMock.mock.calls[2] ?? [];

    expect(appUrl).toBe("https://api.github.com/app");
    expect(installUrl).toBe("https://api.github.com/app/installations/99001");
    expect(userUrl).toBe("https://api.github.com/users/friday-bot%5Bbot%5D");

    // App-JWT bearer auth on first call
    const auth = appInit?.headers?.Authorization;
    expect(auth).toMatch(/^Bearer eyJ/);

    // /users/{login} is a public endpoint that rejects App JWTs with 401, so
    // the bot-user fetch must be unauthenticated. Regression guard for B-4.
    expect(userInit?.headers?.Authorization).toBeUndefined();
  });

  it("returns healthy:false on bad keypair (401 from /app)", async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse(401, { message: "Bad credentials" }));

    if (!githubAppProvider.health) throw new Error("health should be defined");
    const result = await githubAppProvider.health({
      app_id: 100,
      private_key: validPrivateKeyPkcs8Pem,
      webhook_secret: "secret",
      installation_id: 99001,
    });

    expect(result.healthy).toBe(false);
    if (result.healthy) throw new Error("expected unhealthy");
    expect(result.error).toMatch(/GitHub \/app returned 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns healthy:false on wrong installation (404 from /app/installations/{id})", async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse(200, { slug: "friday-bot" }));
    fetchMock.mockResolvedValueOnce(mockJsonResponse(404, { message: "Not Found" }));

    if (!githubAppProvider.health) throw new Error("health should be defined");
    const result = await githubAppProvider.health({
      app_id: 100,
      private_key: validPrivateKeyPkcs8Pem,
      webhook_secret: "secret",
      installation_id: 88888,
    });

    expect(result.healthy).toBe(false);
    if (result.healthy) throw new Error("expected unhealthy");
    expect(result.error).toMatch(/installations\/88888 returned 404/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns healthy:false on bot user 404", async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse(200, { slug: "friday-bot" }));
    fetchMock.mockResolvedValueOnce(mockJsonResponse(200, { id: 99001 }));
    fetchMock.mockResolvedValueOnce(mockJsonResponse(404, { message: "Not Found" }));

    if (!githubAppProvider.health) throw new Error("health should be defined");
    const result = await githubAppProvider.health({
      app_id: 100,
      private_key: validPrivateKeyPkcs8Pem,
      webhook_secret: "secret",
      installation_id: 99001,
    });

    expect(result.healthy).toBe(false);
    if (result.healthy) throw new Error("expected unhealthy");
    expect(result.error).toMatch(/users\/friday-bot\[bot\] returned 404/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns healthy:false when private_key is unimportable (signing fails)", async () => {
    if (!githubAppProvider.health) throw new Error("health should be defined");
    const result = await githubAppProvider.health({
      app_id: 100,
      private_key: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----",
      webhook_secret: "secret",
      installation_id: 99001,
    });

    expect(result.healthy).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
