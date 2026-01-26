import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubAppInstallProvider } from "./github-app.ts";

describe("createGitHubAppInstallProvider", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it("returns undefined when env vars are missing", () => {
    delete process.env.GITHUB_APP_ID_FILE;
    delete process.env.GITHUB_APP_CLIENT_ID_FILE;
    delete process.env.GITHUB_APP_CLIENT_SECRET_FILE;
    delete process.env.GITHUB_APP_PRIVATE_KEY_FILE;
    delete process.env.GITHUB_APP_INSTALLATION_URL;
    expect(createGitHubAppInstallProvider()).toBeUndefined();
  });

  it("returns undefined when secret files cannot be read", () => {
    process.env.GITHUB_APP_ID_FILE = "/nonexistent/path";
    process.env.GITHUB_APP_CLIENT_ID_FILE = "/nonexistent/path";
    process.env.GITHUB_APP_CLIENT_SECRET_FILE = "/nonexistent/path";
    process.env.GITHUB_APP_PRIVATE_KEY_FILE = "/nonexistent/path";
    process.env.GITHUB_APP_INSTALLATION_URL = "https://example.com";
    expect(createGitHubAppInstallProvider()).toBeUndefined();
  });
});
