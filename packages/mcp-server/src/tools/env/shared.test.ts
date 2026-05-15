import { describe, expect, it } from "vitest";
import { envRouteBase, isSecretKey, MASKED_VALUE, maskEnvMap, maskForKey } from "./shared.ts";

describe("isSecretKey", () => {
  it("flags keys that look credential-bearing", () => {
    for (const key of [
      "GITHUB_TOKEN",
      "API_KEY",
      "OPENAI_API_KEY",
      "DB_PASSWORD",
      "CLIENT_SECRET",
      "AWS_CREDENTIAL",
      "secret_thing",
    ]) {
      expect(isSecretKey(key)).toBe(true);
    }
  });

  it("does not flag plain non-secret keys", () => {
    for (const key of ["BITBUCKET_URL", "LOG_LEVEL", "WORKSPACE_NAME", "TIMEOUT_MS", "REGION"]) {
      expect(isSecretKey(key)).toBe(false);
    }
  });
});

describe("maskForKey", () => {
  it("masks a secret-looking key's value", () => {
    expect(maskForKey("API_KEY", "sk-ant-real")).toBe(MASKED_VALUE);
  });

  it("passes a non-secret key's value through", () => {
    expect(maskForKey("LOG_LEVEL", "debug")).toBe("debug");
  });
});

describe("maskEnvMap", () => {
  it("masks only the secret-looking keys and reports them", () => {
    const { env, maskedKeys } = maskEnvMap({
      LOG_LEVEL: "debug",
      GITHUB_TOKEN: "ghp-real-token",
      REGION: "us-east-1",
      DB_PASSWORD: "hunter2",
    });
    expect(env).toEqual({
      LOG_LEVEL: "debug",
      GITHUB_TOKEN: MASKED_VALUE,
      REGION: "us-east-1",
      DB_PASSWORD: MASKED_VALUE,
    });
    expect(maskedKeys.sort()).toEqual(["DB_PASSWORD", "GITHUB_TOKEN"]);
  });

  it("returns an empty maskedKeys list when nothing is secret-looking", () => {
    const { maskedKeys } = maskEnvMap({ LOG_LEVEL: "debug", REGION: "us-east-1" });
    expect(maskedKeys).toEqual([]);
  });
});

describe("envRouteBase", () => {
  it("builds the global config route base", () => {
    const r = envRouteBase("http://d", "global", undefined);
    expect(r).toEqual({ ok: true, base: "http://d/api/config/env" });
  });

  it("builds the workspace route base", () => {
    const r = envRouteBase("http://d", "workspace", "ws_123");
    expect(r).toEqual({ ok: true, base: "http://d/api/workspaces/ws_123/env" });
  });

  it("requires a workspaceId for workspace scope", () => {
    const r = envRouteBase("http://d", "workspace", undefined);
    expect(r.ok).toBe(false);
  });
});
